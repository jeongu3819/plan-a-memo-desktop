//! SyncEngine — memo-sync-v1 순서대로: Outbox(LINK·PUSH·UNLINK) → Changes(cursor) → 문서 Pull → ACK.
//!
//! 원칙
//! * 연결(sync_enabled)된 문서만, 그리고 **지금 로그인한 계정(account_key)** 의 연결만 다룬다.
//!   다른 계정의 Link·Outbox·Cursor 는 보내지도 지우지도 않는다.
//! * 로컬 쓰기와 Outbox 기록은 memo::repo::touch 가 한 transaction 에서 이미 해 두었다.
//! * Push 요청은 보내기 전에 Outbox 에 그대로 저장한다 — 응답을 잃으면 같은 request_id 로 다시 보낸다.
//! * 서버 변경은 cursor 이벤트로 '받아야 할 문서' 표시만 하고(cursor 와 같은 transaction), 문서는 따로 받는다.
//!   한 문서가 실패(충돌·이미지)해도 다른 문서는 계속 진행한다.
//! * ACK 는 로컬 DB 반영 + 이미지 파일 확인이 끝난 뒤에만 보낸다.
//! * 양쪽이 다르게 바뀌면 자동으로 고르지 않는다 — 서버 Conflict(출처 desktop/web)를 비교 화면으로.
//! * DB 잠금을 쥔 채로 네트워크(await)를 기다리지 않는다.

use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::contract::*;
use super::link::{self, insert_version, InflightPush, LinkRow, OutboxPayload};
use super::mapper;
use super::transport::*;
use crate::attachments;
use crate::auth::AuthProvider;
use crate::error::{AppError, AppResult};
use crate::memo::{repo, DocumentInfo, DocumentSnapshot, Location};
use crate::storage::Storage;
use crate::util::{new_id, now};

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: u32,
    pub pulled: u32,
    pub conflicts: u32,
    pub failed: u32,
    pub acked: u32,
    pub offline: bool,
    pub auth_required: bool,
    pub unavailable: bool,
    pub notices: Vec<String>,
    pub changed_documents: Vec<String>,
    pub finished_at: String,
}

impl SyncReport {
    pub fn changed(&self) -> bool {
        self.pushed + self.pulled + self.conflicts + self.failed > 0 || !self.changed_documents.is_empty() || !self.notices.is_empty()
    }
    fn notice(&mut self, text: &str) {
        if !self.notices.iter().any(|n| n == text) {
            self.notices.push(text.to_string());
        }
    }
    fn touched(&mut self, doc_id: &str) {
        if !self.changed_documents.iter().any(|d| d == doc_id) {
            self.changed_documents.push(doc_id.to_string());
        }
    }
}

pub const NOTICE_MOVED: &str = "메모가 다른 위치에서 이미 변경되었습니다. 최신 상태를 불러왔습니다.";
pub const NOTICE_UNLINKED: &str = "PLAN-A Work 에서 연결이 해제된 메모가 있습니다. 이 PC 의 내용은 그대로 있습니다.";
pub const NOTICE_OTHER_ACCOUNT: &str = "다른 PLAN-A Work 계정으로 연결된 메모입니다. 그 계정으로 로그인하면 이어서 맞춥니다.";
pub const NOTICE_PREVIOUS_DEVICE: &str =
    "해제된 이전 기기 등록으로 연결돼 있던 메모입니다. 이 PC 의 내용과 보내지 못한 변경은 그대로 있습니다. \
     다시 맞추려면 이 날짜/List 를 새로 연결해주세요(연결하면 PLAN-A Work 내용과 비교부터 합니다).";

/// 이 계정의 Sync 상태를 지금 서버 기기에 묶는다. 기기 id 가 바뀌었으면(이전 기기 폐기 후 새 등록) 이전 기기의
/// 연결·UNLINK 를 `<account_key>#device:<이전 id>` 로 옮겨 **보존만** 한다 — 새 credential 로 보내지 않고, 몰래 새 기기에
/// 다시 연결하지 않는다(memo-sync-v1: old links/cursors are never inherited). 옮긴 연결 수를 돌려준다.
pub fn retire_previous_device(conn: &mut Connection, ctx: &SyncContext) -> AppResult<usize> {
    let key = format!("device|{}", ctx.account_key);
    let previous = state_get(conn, &key)?;
    if previous.as_deref() == Some(ctx.server_device_id.as_str()) {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    let moved = match previous {
        None => 0, // 처음 — 지금 기기로 기록만
        Some(old) => {
            let retired = format!("{}{}{old}", ctx.account_key, link::PREVIOUS_DEVICE_MARK);
            let moved = tx.execute("UPDATE sync_links SET account_key = ?2 WHERE account_key = ?1", params![ctx.account_key, retired])?;
            tx.execute(
                "UPDATE sync_outbox SET account_key = ?2 WHERE op = 'UNLINK' AND account_key = ?1",
                params![ctx.account_key, retired],
            )?;
            tx.execute("DELETE FROM sync_state WHERE key LIKE ?1", [format!("weblink|{}|%", ctx.account_key)])?;
            moved
        }
    };
    state_set(&tx, &key, &ctx.server_device_id)?;
    tx.commit()?;
    Ok(moved)
}

#[derive(Debug)]
enum StepError {
    Transport(TransportError),
    App(AppError),
}

impl From<TransportError> for StepError {
    fn from(e: TransportError) -> Self {
        StepError::Transport(e)
    }
}
impl From<AppError> for StepError {
    fn from(e: AppError) -> Self {
        StepError::App(e)
    }
}
impl From<rusqlite::Error> for StepError {
    fn from(e: rusqlite::Error) -> Self {
        StepError::App(e.into())
    }
}

type Step<T> = Result<T, StepError>;

#[derive(Debug, Clone)]
struct OutboxEntry {
    id: i64,
    document_id: String,
    op: String,
    payload: Option<String>,
    attempts: i64,
    account_key: Option<String>,
}

pub struct SyncEngine {
    pub transport: Arc<dyn SyncTransport>,
    pub auth: Arc<dyn AuthProvider>,
}

/// 이 PC 의 로컬 기기 id(서버 기기 id 와 별개 — 서버 id 는 credential 에 있다).
pub fn ensure_device_id(conn: &Connection) -> AppResult<String> {
    if let Some(id) = state_get(conn, "device_id")? {
        return Ok(id);
    }
    let id = new_id();
    state_set(conn, "device_id", &id)?;
    Ok(id)
}

pub fn state_get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn state_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// cursor 는 서버 namespace·계정·기기마다 따로(다른 계정의 cursor 를 쓰지 않는다).
fn cursor_key(ctx: &SyncContext) -> String {
    format!("cursor|{}|{}", ctx.account_key, ctx.server_device_id)
}

fn has_local_changes(conn: &Connection, doc_id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [doc_id], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some())
}

fn settle_status(conn: &Connection, doc_id: &str) -> AppResult<()> {
    let status = if has_local_changes(conn, doc_id)? { "pending" } else { "synced" };
    conn.execute(
        "UPDATE documents SET sync_status = ?2, sync_error = NULL WHERE id = ?1 AND sync_enabled = 1
           AND NOT EXISTS(SELECT 1 FROM conflicts c WHERE c.document_id = documents.id AND c.status = 'open')",
        params![doc_id, status],
    )?;
    Ok(())
}

fn set_error(conn: &Connection, doc_id: &str, message: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE documents SET sync_status = 'error', sync_error = ?2 WHERE id = ?1 AND sync_enabled = 1 AND sync_status <> 'conflict'",
        params![doc_id, message],
    )?;
    Ok(())
}

fn backoff_seconds(attempts: i64) -> i64 {
    (5i64 << attempts.clamp(0, 7)).min(600)
}

fn link_of(conn: &Connection, doc_id: &str) -> AppResult<Option<LinkRow>> {
    link::link_row(conn, doc_id)
}

/// 서버 거절(413·422) → 사용자에게 보일 문장. 본문은 고치지 않는다 — 사용자가 고치면(또는 서버 정책이 바뀌면) 다시 보낸다.
/// `item` 은 서버가 알려 준 Push 항목 위치, `preview` 는 그 항목의 앞부분(이 PC 에서 만든 것 — 서버는 본문을 돌려주지 않는다).
pub fn rejected_message(status: u16, message: &str, code: Option<&str>, item: Option<usize>, preview: Option<&str>) -> String {
    let which = match (item, preview) {
        (Some(index), Some(text)) if !text.is_empty() => format!("{}번째 메모('{text}')", index + 1),
        (Some(index), _) => format!("{}번째 메모", index + 1),
        _ => "이 날짜/List 의 메모".into(),
    };
    let keep = "이 PC 의 내용은 그대로 보관되며, 고치면 자동으로 다시 보냅니다. 다른 날짜/List 는 계속 동기화됩니다.";
    match code {
        Some("local_path_not_allowed") => {
            return format!(
                "{which}의 링크·이미지에 PC 파일 경로(file:, C:\\…, \\\\서버\\…) 참조가 있어 PLAN-A Work 가 받지 않았습니다. \
                 그 링크를 https:// 주소로 바꾸거나 지워주세요. {keep}"
            )
        }
        Some("reference_not_allowed") => {
            return format!(
                "{which}에 PLAN-A Work 가 받지 않는 링크·이미지 주소(//로 시작하는 주소, data:, blob: 등)가 있습니다. \
                 링크는 https:// 로 시작하게 바꿔주세요. {keep}"
            )
        }
        _ => {}
    }
    if status == 413 {
        return format!(
            "메모 하나 또는 이 날짜/List 전체가 PLAN-A Work 크기 제한(메모당 HTML 1MiB·정리 후 256KiB, 날짜/List 2MB — 서버 설정에 따라 다름)을 \
             넘거나 이미지가 제한을 넘어 받지 않았습니다({message}). {keep}"
        );
    }
    format!("PLAN-A Work 가 이 내용을 받지 않았습니다({message}). {keep}")
}

/// Outbox 에 보관한 Push 본문에서 `index` 번째 항목의 앞부분(안내용).
fn pushed_item_preview(payload: Option<&str>, index: usize) -> Option<String> {
    let payload: OutboxPayload = serde_json::from_str(payload?).ok()?;
    let item = payload.inflight?.body.items.into_iter().nth(index)?;
    let text = crate::memo::text::search_text(&item.content);
    let short: String = text.chars().take(30).collect();
    Some(if text.chars().count() > 30 { format!("{short}…") } else { short })
}

pub const NOTICE_CLIENT_KEY: &str =
    "이 PC 의 새 메모 일부가 PLAN-A Work 의 다른 날짜/List 에 이미 있는 것으로 확인되었습니다. 다른 위치의 메모는 건드리지 않고, 최신 상태를 확인한 뒤 이 날짜/List 의 새 메모로 보냅니다.";

/// 이동 충돌(409 item_moved_or_not_owned · client_key_in_use) 뒤 재시도 간격 — 같은 오류가 반복되면 점점 늦추고 3번째부터 문서에 표시.
fn defer_after_moved(conn: &Connection, outbox_id: i64, doc_id: &str, attempts: i64, code: &str) -> AppResult<()> {
    let attempts = attempts + 1;
    let next = chrono::Utc::now() + chrono::Duration::seconds(backoff_seconds(attempts));
    conn.execute(
        "UPDATE sync_outbox SET attempts = ?2, next_attempt_at = ?3, last_error = ?4 WHERE id = ?1",
        params![outbox_id, attempts, next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), code],
    )?;
    if attempts >= 3 {
        set_error(
            conn,
            doc_id,
            "이 날짜/List 의 메모 일부가 PLAN-A Work 에서 다른 위치로 옮겨져 있어 계속 맞추지 못하고 있습니다. 이 PC 의 내용은 그대로이며, PLAN-A Work 에서 위치를 확인해주세요.",
        )?;
    }
    Ok(())
}

impl SyncEngine {
    pub fn new(transport: Arc<dyn SyncTransport>, auth: Arc<dyn AuthProvider>) -> Self {
        SyncEngine { transport, auth }
    }

    pub fn context(&self) -> Option<SyncContext> {
        self.auth.session_context().map(|s| SyncContext {
            access_token: s.access_token,
            account_key: s.account_key,
            server_device_id: s.server_device_id,
        })
    }

    /// 한 번 동기화. `force` 면 재시도 대기 시간을 무시한다(사용자가 지금 보내기를 누른 때).
    pub async fn run_once(&self, storage: &Storage, force: bool) -> AppResult<SyncReport> {
        let mut report = SyncReport::default();
        let active = storage.with_conn(|c| {
            Ok(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE sync_enabled = 1) OR EXISTS(SELECT 1 FROM sync_outbox)",
                [],
                |r| r.get::<_, bool>(0),
            )?)
        })?;
        let ctx = self.context();
        // 연결된 문서가 없으면 서버에 아무 요청도 하지 않는다 — 단, 로그인돼 있으면 Web 이 이 PC 로
        // 연결한 문서(linked 이벤트)를 받기 위해 변경 목록은 본다.
        if !active && ctx.is_none() {
            report.finished_at = now();
            return Ok(report);
        }
        let Some(ctx) = ctx else {
            storage.with_conn(|c| {
                c.execute(
                    "UPDATE documents SET sync_status = 'auth_required', sync_error = NULL
                      WHERE sync_enabled = 1 AND sync_status IN ('pending', 'synced', 'error')",
                    [],
                )?;
                Ok(())
            })?;
            report.auth_required = true;
            report.finished_at = now();
            return Ok(report);
        };
        // 같은 계정이지만 서버 기기가 바뀌었다(이전 기기 폐기 → 새 기기 등록) — 이전 기기의 연결·cursor 를 이어받지 않는다.
        if storage.with_conn(|c| retire_previous_device(c, &ctx))? > 0 {
            report.notice(NOTICE_PREVIOUS_DEVICE);
        }
        // 다른 계정(또는 계정 정보 없는 예전 개발용 연결)·이전 기기의 문서는 멈춤 표시만(Outbox·내용 보존, 보내지 않음).
        let foreign = storage.with_conn(|c| {
            c.execute(
                "UPDATE documents SET sync_status = 'auth_required', sync_error = ?2
                  WHERE sync_enabled = 1 AND sync_status <> 'conflict' AND id IN
                        (SELECT document_id FROM sync_links WHERE account_key LIKE ?1 || '#device:%')",
                params![ctx.account_key, NOTICE_PREVIOUS_DEVICE],
            )?;
            let foreign = c.execute(
                "UPDATE documents SET sync_status = 'auth_required', sync_error = ?2
                  WHERE sync_enabled = 1 AND sync_status <> 'conflict' AND id IN
                        (SELECT document_id FROM sync_links
                          WHERE account_key IS NULL OR (account_key <> ?1 AND account_key NOT LIKE ?1 || '#device:%'))",
                params![ctx.account_key, NOTICE_OTHER_ACCOUNT],
            )?;
            Ok(foreign)
        })?;
        if foreign > 0 {
            report.notice(NOTICE_OTHER_ACCOUNT);
        }
        // 다시 로그인했다 — 이 계정 문서의 '로그인 필요' 표시를 푼다.
        storage.with_conn(|c| {
            let ids: Vec<String> = c
                .prepare(
                    "SELECT d.id FROM documents d JOIN sync_links l ON l.document_id = d.id
                      WHERE d.sync_enabled = 1 AND d.sync_status = 'auth_required' AND l.account_key = ?1",
                )?
                .query_map([&ctx.account_key], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            for id in ids {
                settle_status(c, &id)?;
            }
            Ok(())
        })?;

        let mut attempted = std::collections::HashSet::new();
        let stop = self.outbox_phase(storage, &ctx, force, &mut attempted, &mut report).await?;
        if !stop {
            let stop = self.changes_phase(storage, &ctx, &mut report).await?;
            if !stop {
                let stop = self.refresh_phase(storage, &ctx, &mut report).await?;
                if !stop {
                    // 받는 중에 생긴 PUSH(첫 연결 비교 등)를 이어서 보낸다.
                    let stop = self.outbox_phase(storage, &ctx, force, &mut attempted, &mut report).await?;
                    if !stop {
                        self.ack_phase(storage, &ctx, &mut report).await?;
                    }
                }
            }
        }
        report.finished_at = now();
        Ok(report)
    }

    /// 전역으로 멈춰야 하는 오류인가(true = 이번 실행 중단).
    fn global_stop(&self, storage: &Storage, error: &TransportError, report: &mut SyncReport) -> AppResult<bool> {
        match error {
            TransportError::Offline => {
                report.offline = true;
                Ok(true)
            }
            TransportError::AuthRequired => {
                self.auth.mark_expired();
                storage.with_conn(|c| {
                    c.execute(
                        "UPDATE documents SET sync_status = 'auth_required', sync_error = NULL WHERE sync_enabled = 1 AND sync_status <> 'conflict'",
                        [],
                    )?;
                    Ok(())
                })?;
                report.auth_required = true;
                Ok(true)
            }
            TransportError::Unavailable => {
                report.unavailable = true;
                report.notice("PLAN-A Work 에서 Desktop 연결을 아직 사용할 수 없습니다. 이 PC 의 변경은 보관해 두었다가 나중에 보냅니다.");
                Ok(true)
            }
            TransportError::RateLimited => {
                report.offline = true;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// 서버가 이 link generation 을 끝냈다(Web 에서 해제·기기 해제·다시 연결로 대체).
    fn end_link(&self, storage: &Storage, doc_id: &str, report: &mut SyncReport) -> AppResult<()> {
        storage.with_conn(|c| {
            let tx = c.transaction()?;
            link::end_local_link(&tx, doc_id)?;
            tx.commit()?;
            Ok(())
        })?;
        report.notice(NOTICE_UNLINKED);
        report.touched(doc_id);
        Ok(())
    }

    // ── 1. Outbox ──────────────────────────────────────────────────────

    /// `attempted` — 이번 실행에서 이미 실패한 Outbox 항목(두 번째 패스에서 바로 다시 보내지 않는다 — 재시도 대기 유지).
    async fn outbox_phase(
        &self,
        storage: &Storage,
        ctx: &SyncContext,
        force: bool,
        attempted: &mut std::collections::HashSet<i64>,
        report: &mut SyncReport,
    ) -> AppResult<bool> {
        let entries: Vec<OutboxEntry> = storage.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT o.id, o.document_id, o.op, o.payload, o.attempts,
                        CASE WHEN o.op = 'UNLINK' THEN o.account_key ELSE l.account_key END
                   FROM sync_outbox o LEFT JOIN sync_links l ON l.document_id = o.document_id
                  WHERE (?1 = 1 OR o.next_attempt_at IS NULL OR o.next_attempt_at <= ?2)
                  ORDER BY CASE o.op WHEN 'UNLINK' THEN 0 WHEN 'LINK' THEN 1 ELSE 2 END, o.id",
            )?;
            let rows = stmt
                .query_map(params![force as i64, now()], |r| {
                    Ok(OutboxEntry {
                        id: r.get(0)?,
                        document_id: r.get(1)?,
                        op: r.get(2)?,
                        payload: r.get(3)?,
                        attempts: r.get(4)?,
                        account_key: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for entry in entries {
            if entry.account_key.as_deref() != Some(ctx.account_key.as_str()) || attempted.contains(&entry.id) {
                continue; // 다른 계정의 작업은 그 계정으로 로그인했을 때만
            }
            let outcome = match entry.op.as_str() {
                "LINK" => self.process_link(storage, ctx, &entry, report).await,
                "PUSH" => self.process_push(storage, ctx, &entry, report).await,
                "UNLINK" => self.process_unlink(storage, ctx, &entry).await,
                _ => Ok(()),
            };
            match outcome {
                Ok(()) => {}
                Err(StepError::Transport(error)) => {
                    if self.global_stop(storage, &error, report)? {
                        return Ok(true);
                    }
                    attempted.insert(entry.id);
                    self.step_failed(storage, &entry, &error, report)?;
                }
                Err(StepError::App(error)) => {
                    // 로컬에서 준비하지 못함(이미지 파일 없음·용량 초과 등) — 문서만 오류, 다른 문서는 계속.
                    attempted.insert(entry.id);
                    report.failed += 1;
                    log::warn!("sync prepare failed: op={} code={}", entry.op, error.code());
                    storage.with_conn(|c| {
                        let next = chrono::Utc::now() + chrono::Duration::seconds(backoff_seconds(entry.attempts + 1));
                        c.execute(
                            "UPDATE sync_outbox SET attempts = attempts + 1, next_attempt_at = ?2, last_error = ?3 WHERE id = ?1",
                            params![entry.id, next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), error.code()],
                        )?;
                        set_error(c, &entry.document_id, &error.to_string())
                    })?;
                }
            }
        }
        Ok(false)
    }

    fn step_failed(&self, storage: &Storage, entry: &OutboxEntry, error: &TransportError, report: &mut SyncReport) -> AppResult<()> {
        match error {
            TransportError::Conflict { code } if code == "link_inactive" => return self.end_link(storage, &entry.document_id, report),
            TransportError::NotFound if entry.op != "UNLINK" => {
                // 서버 문서·List 를 찾을 수 없다(다른 계정 소유이거나 정리됨) — 연결을 끝내고 로컬은 보존.
                return self.end_link(storage, &entry.document_id, report);
            }
            TransportError::Conflict { code } if code == "item_moved_or_not_owned" || code == "client_key_in_use" => {
                // 다른 위치로 이미 옮겨진 항목을 오래된 요청이 가져오려 했다 — 최신을 다시 받는다(바로 재전송하지 않는다).
                storage.with_conn(|c| {
                    let tx = c.transaction()?;
                    clear_inflight(&tx, entry.id)?;
                    tx.execute("DELETE FROM sync_item_map WHERE document_id = ?1 AND server_item_id IS NULL", [&entry.document_id])?;
                    tx.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&entry.document_id])?;
                    defer_after_moved(&tx, entry.id, &entry.document_id, entry.attempts, code)?;
                    tx.commit()?;
                    Ok(())
                })?;
                report.notice(if code == "client_key_in_use" { NOTICE_CLIENT_KEY } else { NOTICE_MOVED });
                report.touched(&entry.document_id);
                return Ok(());
            }
            TransportError::Conflict { code } if code == "request_id_reused" => {
                storage.with_conn(|c| clear_inflight(c, entry.id))?;
                return Ok(());
            }
            _ => {}
        }
        report.failed += 1;
        let (message, delay, permanent) = match error {
            TransportError::Rejected { status, message, code, item } => {
                // 방금 보낸 본문(Outbox 에 보관된 요청)에서 그 항목을 찾는다.
                let payload: Option<String> = storage
                    .with_conn(|c| Ok(c.query_row("SELECT payload FROM sync_outbox WHERE id = ?1", [entry.id], |r| r.get(0)).optional()?))
                    .ok()
                    .flatten()
                    .flatten();
                let preview = item.and_then(|i| pushed_item_preview(payload.as_deref(), i));
                (rejected_message(*status, message, code.as_deref(), *item, preview.as_deref()), 3600, true)
            }
            TransportError::Forbidden => ("PLAN-A Work 가 권한이 없다고 거절했습니다.".to_string(), 3600, true),
            other => (other.to_string(), backoff_seconds(entry.attempts + 1), false),
        };
        log::warn!(
            "sync step failed: op={} attempts={} kind={}",
            entry.op,
            entry.attempts + 1,
            if permanent { "rejected" } else { "retry" }
        );
        storage.with_conn(|c| {
            let attempts = entry.attempts + 1;
            let next = chrono::Utc::now() + chrono::Duration::seconds(delay);
            if permanent {
                clear_inflight(c, entry.id)?; // 서버가 기록하지 않은 요청 — 다음 편집 때 새로 만든다
            }
            c.execute(
                "UPDATE sync_outbox SET attempts = ?2, next_attempt_at = ?3, last_error = ?4 WHERE id = ?1",
                params![entry.id, attempts, next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), message],
            )?;
            if permanent || attempts >= 3 {
                set_error(c, &entry.document_id, &message)?;
            }
            Ok(())
        })
    }

    /// 첨부 업로드(Push 전에). 서버 이미지 정책: PNG·JPG·WEBP, 10MB.
    async fn upload_attachments(&self, storage: &Storage, ctx: &SyncContext, doc: &DocumentInfo) -> Step<()> {
        let ids = storage.with_conn(|c| mapper::attachments_to_upload(c, doc, &ctx.account_key))?;
        for id in ids {
            let (bytes, mime) = storage.with_conn(|c| attachments::read_bytes(c, &storage.paths, &id)).map_err(|_| {
                AppError::new("sync_attachment_missing", "메모의 이미지 파일을 찾을 수 없어 PLAN-A Work 로 보내지 못했습니다.")
            })?;
            let ext = IMAGE_TYPES.iter().find(|(m, _)| *m == mime).map(|(_, e)| *e).ok_or_else(|| {
                AppError::new("sync_image_unsupported", "PLAN-A Work 는 PNG·JPG·WEBP 이미지만 받습니다(GIF·BMP 는 보낼 수 없음).")
            })?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(AppError::new("sync_image_too_large", "PLAN-A Work 로 보낼 수 있는 이미지는 10MB 까지입니다.").into());
            }
            // 같은 첨부는 언제나 같은 request id — 응답을 잃고 다시 보내도 서버에 한 장만 생긴다.
            let uploaded = self.transport.upload(ctx, &id, &format!("{id}.{ext}"), &mime, bytes).await?;
            storage.with_conn(|c| mapper::remember_attachment(c, &id, &ctx.account_key, &uploaded.name, None))?;
        }
        Ok(())
    }

    /// 서버 문서가 참조하는 이미지를 내려받아 저장 폴더에 넣는다(SHA-256 확인).
    async fn download_attachments(&self, storage: &Storage, ctx: &SyncContext, manifest: &[WireAttachment]) -> Step<()> {
        // 같은 이름이 여러 번 오면 한 번만(SHA-256 이 있는 항목 우선).
        let mut unique: Vec<WireAttachment> = Vec::new();
        for entry in manifest {
            match unique.iter_mut().find(|u| u.name == entry.name) {
                Some(existing) if existing.sha256.is_none() => *existing = entry.clone(),
                Some(_) => {}
                None => unique.push(entry.clone()),
            }
        }
        let missing = storage.with_conn(|c| mapper::attachments_to_download(c, &storage.paths, &ctx.account_key, &unique))?;
        for entry in missing {
            let bytes = self.transport.download(ctx, &entry.name).await?;
            let hash = crate::util::sha256_hex(&bytes);
            if let Some(expected) = &entry.sha256 {
                if !expected.eq_ignore_ascii_case(&hash) {
                    return Err(TransportError::Server("이미지 확인값(SHA-256)이 맞지 않습니다".into()).into());
                }
            }
            storage.with_conn(|c| {
                let tx = c.transaction()?;
                let info = attachments::import_bytes(&tx, &storage.paths, &bytes, None, None)?;
                mapper::remember_attachment(&tx, &info.id, &ctx.account_key, &entry.name, Some(&hash))?;
                tx.commit()?;
                Ok(())
            })?;
        }
        Ok(())
    }

    async fn process_link(&self, storage: &Storage, ctx: &SyncContext, entry: &OutboxEntry, report: &mut SyncReport) -> Step<()> {
        let Some(doc) = storage.with_conn(|c| repo::doc_by_id(c, &entry.document_id))? else {
            storage.with_conn(|c| Ok(c.execute("DELETE FROM sync_outbox WHERE id = ?1", [entry.id])?))?;
            return Ok(());
        };
        if !doc.sync_enabled {
            storage.with_conn(|c| Ok(c.execute("DELETE FROM sync_outbox WHERE id = ?1", [entry.id])?))?;
            return Ok(());
        }
        let (unit_type, key) = mapper::unit_of(&doc);
        if unit_type == UnitType::NextList && key != "default" {
            let title = storage.with_conn(|c| repo::list_name(c, &key))?.unwrap_or_else(|| "Next".into());
            match self.transport.create_list(ctx, &NativeListCreate { id: key.clone(), title }).await {
                Ok(_) => {}
                // 이미 있는 List(이름이 바뀌었거나 Web 에서 만든 같은 id) — 연결로 진행한다. 남의 것이면 link 가 404.
                Err(TransportError::Conflict { .. }) => {}
                Err(e) => return Err(e.into()),
            }
        }
        let linked = self.transport.link(ctx, &LinkRequest { unit_type, key }).await?;
        storage.with_conn(|c| {
            let tx = c.transaction()?;
            // 같은 서버 문서를 가리키던 예전 로컬 연결 기록이 있으면 정리(서버 문서 id 는 UNIQUE).
            tx.execute(
                "UPDATE sync_links SET server_document_id = NULL WHERE server_document_id = ?1 AND document_id <> ?2",
                params![linked.document_id, doc.id],
            )?;
            tx.execute(
                "UPDATE sync_links SET server_document_id = ?2, link_id = ?3, account_key = ?4 WHERE document_id = ?1",
                params![doc.id, linked.document_id, linked.link_id, ctx.account_key],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        let pulled = self.transport.document(ctx, &linked.document_id).await?;
        self.download_attachments(storage, ctx, &pulled.document.attachments).await?;
        let first = self.first_link_compare(storage, ctx, &doc.id, doc.local_revision, &pulled, report)?;
        if first == Some(true) {
            self.ack_document(storage, ctx, &doc.id, report).await;
        }
        Ok(())
    }

    /// 처음 연결(또는 Web 이 연결)한 문서 — 서버 내용과 로컬 내용을 비교한다. 어느 쪽도 지우지 않는다.
    /// Some(true) = 맞춰졌다(ACK 대상), Some(false) = 로컬 내용을 보내야 한다(PUSH — 서버에 내용이 있으면 base 0 → 비교),
    /// None = 비교하는 사이 로컬이 또 바뀌었다(다음 실행에서 다시 비교).
    fn first_link_compare(
        &self,
        storage: &Storage,
        ctx: &SyncContext,
        doc_id: &str,
        expected_revision: i64,
        pulled: &PulledDocument,
        report: &mut SyncReport,
    ) -> Step<Option<bool>> {
        let server = &pulled.document;
        let in_sync = storage.with_conn(|c| {
            let tx = c.transaction()?;
            let doc = repo::doc_by_id(&tx, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
            if doc.local_revision != expected_revision {
                tx.execute(
                    "UPDATE sync_links SET link_id = ?2, server_document_id = ?3 WHERE document_id = ?1",
                    params![doc_id, pulled.link_id, server.id],
                )?;
                if !has_local_changes(&tx, doc_id)? {
                    repo::enqueue(&tx, doc_id, "LINK", doc.local_revision, None)?;
                }
                tx.commit()?;
                return Ok(None);
            }
            tx.execute(
                "UPDATE sync_links SET link_id = ?2, remote_pending = 0, server_document_id = ?3 WHERE document_id = ?1",
                params![doc_id, pulled.link_id, server.id],
            )?;
            let local_items = repo::items_of(&tx, doc_id)?;
            let server_items: Vec<&WireItem> = server.items.iter().collect();
            let local_empty = local_items.is_empty();
            // 서버에서 삭제(tombstone)된 문서는 '비어 있음' 으로 보지 않는다 — 이 PC 내용으로 몰래 되살리지 않고 비교한다
            // (Contract: delete/edit 는 일반 문서 비교, 자동 부활 없음).
            let server_empty = server_items.is_empty() && !server.deleted;
            let in_sync = if server_items.is_empty() && local_empty {
                true
            } else if local_empty {
                let form = mapper::to_local(&tx, &doc, &ctx.account_key, server.deleted, &server.items)?;
                mapper::apply_to_local(&tx, &doc, &ctx.account_key, &form, Some("remote_apply"))?;
                report.pulled += 1;
                true
            } else if server_empty {
                // 서버가 비어 있다 — 이 PC 내용을 그 version 위에 보낸다.
                tx.execute("UPDATE documents SET server_version = ?2 WHERE id = ?1", params![doc_id, server.version])?;
                false
            } else {
                let local_plan = mapper::build_push(&tx, &doc, &ctx.account_key);
                let same = match &local_plan {
                    Ok(plan) => mapper::digest_push(plan) == mapper::digest_wire(server.deleted, &server.items),
                    Err(_) => false,
                };
                if same {
                    mapper::adopt_positionally(&tx, &doc, &ctx.account_key, &server.items)?;
                    true
                } else {
                    // 양쪽 다 내용이 있다 — base_version=0 으로 보내 서버가 비교(Conflict)를 만들게 한다.
                    // 서버에 지금 있는 항목의 id 만 남긴다(없는 id 는 새 항목으로).
                    let ids: Vec<i64> = server.items.iter().filter_map(|i| i.id).collect();
                    let stale: Vec<String> = tx
                        .prepare("SELECT item_id, server_item_id FROM sync_item_map WHERE document_id = ?1 AND server_item_id IS NOT NULL")?
                        .query_map([doc_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                        .collect::<Result<Vec<_>, _>>()?
                        .into_iter()
                        .filter(|(_, id)| !ids.contains(id))
                        .map(|(item, _)| item)
                        .collect();
                    for item in stale {
                        tx.execute("DELETE FROM sync_item_map WHERE document_id = ?1 AND item_id = ?2", params![doc_id, item])?;
                    }
                    tx.execute("UPDATE documents SET server_version = 0 WHERE id = ?1", [doc_id])?;
                    false
                }
            };
            if in_sync {
                tx.execute(
                    "UPDATE documents SET server_version = ?2, synced_revision = local_revision WHERE id = ?1",
                    params![doc_id, server.version],
                )?;
                tx.execute(
                    "UPDATE sync_links SET server_digest = ?2 WHERE document_id = ?1",
                    params![doc_id, mapper::digest_wire(server.deleted, &server.items)],
                )?;
                // 비교하는 동안 로컬 편집이 없었다(revision 확인) — 연결 작업 끝.
                tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [doc_id])?;
                settle_status(&tx, doc_id)?;
            } else {
                tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op = 'LINK'", [doc_id])?;
                repo::enqueue(&tx, doc_id, "PUSH", doc.local_revision, None)?;
                tx.execute("UPDATE documents SET sync_status = 'pending', sync_error = NULL WHERE id = ?1", [doc_id])?;
            }
            tx.commit()?;
            Ok(Some(in_sync))
        })?;
        report.touched(doc_id);
        Ok(in_sync)
    }

    async fn process_push(&self, storage: &Storage, ctx: &SyncContext, entry: &OutboxEntry, report: &mut SyncReport) -> Step<()> {
        let prepared = storage.with_conn(|c| {
            let Some(doc) = repo::doc_by_id(c, &entry.document_id)? else {
                c.execute("DELETE FROM sync_outbox WHERE id = ?1", [entry.id])?;
                return Ok(None);
            };
            if !doc.sync_enabled {
                c.execute("DELETE FROM sync_outbox WHERE id = ?1", [entry.id])?;
                return Ok(None);
            }
            if doc.has_conflict {
                return Ok(None); // 사용자가 고를 때까지 보내지 않는다
            }
            let link = link_of(c, &doc.id)?;
            let server_digest = link.as_ref().and_then(|l| l.server_digest.clone());
            match (link, doc.server_version) {
                (Some(LinkRow { server_document_id: Some(server_id), link_id: Some(link_id), .. }), Some(_)) => {
                    Ok(Some((doc, server_id, link_id, server_digest)))
                }
                _ => {
                    // 아직 첫 연결 비교를 마치지 않았다 — LINK 로 다시(서버·로컬 어느 쪽도 덮지 않는 비교부터).
                    let has_link_op: bool =
                        c.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE document_id = ?1 AND op = 'LINK')", [&doc.id], |r| {
                            r.get(0)
                        })?;
                    if has_link_op {
                        c.execute("DELETE FROM sync_outbox WHERE id = ?1", [entry.id])?;
                    } else {
                        c.execute("UPDATE sync_outbox SET op = 'LINK', payload = NULL WHERE id = ?1", [entry.id])?;
                    }
                    Ok(None)
                }
            }
        })?;
        let Some((doc, server_id, link_id, server_digest)) = prepared else { return Ok(()) };
        let payload: OutboxPayload = entry.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();

        let inflight = match payload.inflight.filter(|i| i.server_document_id == server_id && i.body.link_id == link_id) {
            Some(inflight) => inflight, // 응답을 못 받은 요청 — 같은 request_id·본문 그대로
            None => {
                self.upload_attachments(storage, ctx, &doc).await?;
                let built = storage.with_conn(|c| {
                    let tx = c.transaction()?;
                    let doc = repo::doc_by_id(&tx, &doc.id)?.ok_or_else(|| AppError::not_found("문서"))?;
                    let plan = mapper::build_push(&tx, &doc, &ctx.account_key)?;
                    let base = doc.server_version.unwrap_or(0);
                    if base > 0 && server_digest.as_deref() == Some(mapper::digest_push(&plan).as_str()) {
                        // 서버와 내용이 같다(정렬 숫자만 바뀜 등) — 보낼 것이 없다.
                        tx.execute(
                            "DELETE FROM sync_outbox WHERE id = ?1 AND local_revision <= ?2",
                            params![entry.id, doc.local_revision],
                        )?;
                        tx.execute("UPDATE documents SET synced_revision = local_revision WHERE id = ?1", [&doc.id])?;
                        settle_status(&tx, &doc.id)?;
                        tx.commit()?;
                        return Ok(None);
                    }
                    let inflight = InflightPush {
                        server_document_id: server_id.clone(),
                        local_revision: doc.local_revision,
                        body: PushRequest {
                            base_version: base,
                            local_version: doc.local_revision,
                            request_id: new_id(),
                            link_id: link_id.clone(),
                            deleted: plan.deleted,
                            items: plan.items,
                        },
                    };
                    let stored = OutboxPayload { inflight: Some(inflight.clone()), ..Default::default() };
                    tx.execute("UPDATE sync_outbox SET payload = ?2 WHERE id = ?1", params![entry.id, serde_json::to_string(&stored)?])?;
                    tx.commit()?;
                    Ok(Some(inflight))
                })?;
                match built {
                    Some(inflight) => inflight,
                    None => return Ok(()),
                }
            }
        };

        let pushed = match self.transport.push(ctx, &server_id, &inflight.body).await {
            Err(TransportError::Conflict { code }) if code == "item_moved_or_not_owned" || code == "client_key_in_use" => {
                // 오래된 요청이 이미 다른 날짜/List 로 옮겨진 항목을 가져오려 했다(서버가 거절 — v1 규칙).
                // 최신 서버 문서로 매핑을 고치고(없는 id 는 새 항목으로) 다시 보낸다. 다른 위치의 항목은 건드리지 않는다.
                let fresh = self.transport.document(ctx, &server_id).await?;
                storage.with_conn(|c| {
                    let tx = c.transaction()?;
                    clear_inflight(&tx, entry.id)?;
                    let ids: Vec<i64> = fresh.document.items.iter().filter_map(|i| i.id).collect();
                    let rows: Vec<(String, Option<i64>)> = tx
                        .prepare("SELECT item_id, server_item_id FROM sync_item_map WHERE document_id = ?1")?
                        .query_map([&doc.id], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<Result<_, _>>()?;
                    for (item, server_item) in rows {
                        if server_item.map(|id| !ids.contains(&id)).unwrap_or(true) {
                            tx.execute("DELETE FROM sync_item_map WHERE document_id = ?1 AND item_id = ?2", params![doc.id, item])?;
                        }
                    }
                    tx.commit()?;
                    Ok(())
                })?;
                // 이번 실행에서는 다시 보내지 않는다 — step_failed 가 안내·재시도 간격(반복되면 문서에 표시)을 맡는다.
                return Err(TransportError::Conflict { code }.into());
            }
            other => other?,
        };
        match pushed {
            PushResponse::Accepted { document } => {
                let deleted = inflight.body.deleted;
                storage.with_conn(|c| {
                    let tx = c.transaction()?;
                    mapper::adopt_server_ids(&tx, &doc.id, &ctx.account_key, &document.items)?;
                    tx.execute(
                        "UPDATE documents SET server_version = ?2, synced_revision = MAX(synced_revision, ?3) WHERE id = ?1",
                        params![doc.id, document.version, inflight.local_revision],
                    )?;
                    tx.execute(
                        "UPDATE sync_links SET server_digest = ?2 WHERE document_id = ?1",
                        params![doc.id, mapper::digest_wire(document.deleted, &document.items)],
                    )?;
                    clear_inflight(&tx, entry.id)?;
                    // 보내는 사이 새 편집이 없었으면 Outbox 정리(있으면 다음에 새 base 로).
                    tx.execute(
                        "DELETE FROM sync_outbox WHERE document_id = ?1 AND op = 'PUSH' AND local_revision <= ?2",
                        params![doc.id, inflight.local_revision],
                    )?;
                    tx.execute(
                        "UPDATE sync_outbox SET attempts = 0, next_attempt_at = NULL WHERE document_id = ?1 AND op = 'PUSH'",
                        [&doc.id],
                    )?;
                    settle_status(&tx, &doc.id)?;
                    tx.commit()?;
                    Ok(())
                })?;
                report.pushed += 1;
                // ACK — 로컬에 이미 있는 내용(우리가 보낸 것)과 이미지 파일을 확인한 뒤.
                self.ack_document(storage, ctx, &doc.id, report).await;
                if deleted {
                    // 삭제된 List — '삭제됨' 을 전달했으니 연결을 끝낸다(서버 사본·History 는 남는다).
                    storage.with_conn(|c| {
                        let tx = c.transaction()?;
                        link::disable_link(&tx, &doc.id)?;
                        tx.commit()?;
                        Ok(())
                    })?;
                }
            }
            PushResponse::Conflict { conflict_id, version } => {
                storage.with_conn(|c| clear_inflight(c, entry.id))?;
                report.touched(&doc.id);
                if self.refresh_conflict(storage, ctx, &doc.id, &server_id, Some(&conflict_id), report).await? {
                    report.conflicts += 1;
                }
                let _ = version;
            }
        }
        Ok(())
    }

    async fn process_unlink(&self, storage: &Storage, ctx: &SyncContext, entry: &OutboxEntry) -> Step<()> {
        let payload: OutboxPayload = entry.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
        if let Some(link_id) = &payload.link_id {
            match self.transport.unlink(ctx, link_id).await {
                Ok(()) | Err(TransportError::NotFound) => {}
                Err(TransportError::Conflict { code }) if code == "link_inactive" => {}
                Err(e) => return Err(e.into()),
            }
        }
        storage.with_conn(|c| Ok(c.execute("DELETE FROM sync_outbox WHERE id = ?1", [entry.id])?))?;
        Ok(())
    }

    // ── 2. Changes(cursor) ─────────────────────────────────────────────

    async fn changes_phase(&self, storage: &Storage, ctx: &SyncContext, report: &mut SyncReport) -> AppResult<bool> {
        let key = cursor_key(ctx);
        let mut cursor = storage.with_conn(|c| state_get(c, &key))?;
        let mut reset_once = false;
        for _ in 0..50 {
            let page = match self.transport.changes(ctx, cursor.as_deref()).await {
                Ok(page) => page,
                Err(TransportError::Conflict { code }) if code == "cursor_namespace_mismatch" && !reset_once => {
                    // 다른 기기·환경의 cursor — 버리고 연결된 문서를 전부 다시 확인한다.
                    reset_once = true;
                    cursor = None;
                    storage.with_conn(|c| {
                        c.execute("DELETE FROM sync_state WHERE key = ?1", [&key])?;
                        c.execute("UPDATE sync_links SET remote_pending = 1 WHERE account_key = ?1", [&ctx.account_key])?;
                        Ok(())
                    })?;
                    continue;
                }
                Err(error) => {
                    if self.global_stop(storage, &error, report)? {
                        return Ok(true);
                    }
                    report.failed += 1;
                    log::warn!("sync changes failed: {error}");
                    return Ok(false);
                }
            };
            let mut ended_docs: Vec<String> = Vec::new();
            storage.with_conn(|c| {
                let tx = c.transaction()?;
                for event in &page.events {
                    if let Some(ended) = record_event(&tx, ctx, event)? {
                        ended_docs.push(ended);
                    }
                }
                // 이벤트(받아야 할 문서 표시)와 cursor 를 함께 commit — 중간에 꺼져도 다시 받으면 된다.
                state_set(&tx, &key, &page.cursor)?;
                tx.commit()?;
                Ok(())
            })?;
            for doc in &ended_docs {
                report.notice(NOTICE_UNLINKED);
                report.touched(doc);
            }
            cursor = Some(page.cursor.clone());
            if !page.has_more {
                break;
            }
        }
        Ok(false)
    }

    // ── 3. 표시된 문서 받기 ─────────────────────────────────────────────

    async fn refresh_phase(&self, storage: &Storage, ctx: &SyncContext, report: &mut SyncReport) -> AppResult<bool> {
        // Web 이 이 PC 로 연결한 문서(로컬에 아직 연결이 없음)
        let web_links: Vec<(String, String)> = storage.with_conn(|c| {
            Ok(c.prepare("SELECT key, value FROM sync_state WHERE key LIKE ?1")?
                .query_map([format!("weblink|{}|%", ctx.account_key)], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?)
        })?;
        for (state_key, server_doc) in web_links {
            match self.adopt_web_link(storage, ctx, &server_doc, report).await {
                Ok(()) => {
                    storage.with_conn(|c| Ok(c.execute("DELETE FROM sync_state WHERE key = ?1", [&state_key])?))?;
                }
                Err(StepError::Transport(error)) => {
                    if self.global_stop(storage, &error, report)? {
                        return Ok(true);
                    }
                    if matches!(error, TransportError::NotFound) || error.is_conflict("link_inactive") {
                        storage.with_conn(|c| Ok(c.execute("DELETE FROM sync_state WHERE key = ?1", [&state_key])?))?;
                    } else {
                        report.failed += 1;
                    }
                }
                Err(StepError::App(error)) => {
                    report.failed += 1;
                    log::warn!("web link adopt failed: {}", error.code());
                }
            }
        }
        // 받지 못한 문서는 '동기화됨' 으로 두지 않는다(이미지 저장 실패 등) — 다음 실행에서 다시 받는다.
        let refresh_failed = |storage: &Storage, doc_id: &str, message: &str| {
            storage
                .with_conn(|c| set_error(c, doc_id, &format!("PLAN-A Work 변경을 아직 받지 못했습니다 — {message} 잠시 뒤 다시 받습니다.")))
        };

        let pending: Vec<(String, String)> = storage.with_conn(|c| {
            Ok(c.prepare(
                "SELECT l.document_id, l.server_document_id FROM sync_links l JOIN documents d ON d.id = l.document_id
                  WHERE l.remote_pending = 1 AND l.account_key = ?1 AND d.sync_enabled = 1 AND l.server_document_id IS NOT NULL",
            )?
            .query_map([&ctx.account_key], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?)
        })?;
        for (doc_id, server_id) in pending {
            match self.refresh_document(storage, ctx, &doc_id, &server_id, report).await {
                Ok(()) => {}
                Err(StepError::Transport(error)) => {
                    if self.global_stop(storage, &error, report)? {
                        return Ok(true);
                    }
                    if error.is_conflict("link_inactive") || matches!(error, TransportError::NotFound) {
                        self.end_link(storage, &doc_id, report)?;
                    } else {
                        // 이 문서만 다음에 다시(remote_pending 유지) — 다른 문서는 계속.
                        report.failed += 1;
                        log::warn!("sync refresh failed: {error}");
                        refresh_failed(storage, &doc_id, &error.to_string())?;
                        report.touched(&doc_id);
                    }
                }
                Err(StepError::App(error)) => {
                    report.failed += 1;
                    log::warn!("sync apply failed: {}", error.code());
                    refresh_failed(storage, &doc_id, &error.to_string())?;
                    report.touched(&doc_id);
                }
            }
        }
        Ok(false)
    }

    async fn adopt_web_link(&self, storage: &Storage, ctx: &SyncContext, server_doc: &str, report: &mut SyncReport) -> Step<()> {
        let pulled = self.transport.document(ctx, server_doc).await?;
        let server = &pulled.document;
        // 로컬 문서(없으면 만든다 — 사용자가 Web 에서 이 PC 를 골라 연결했다).
        if server.unit_type == UnitType::NextList && server.key != "default" && !crate::util::is_uuid(&server.key) {
            return Err(AppError::validation("List id 형식이 올바르지 않습니다.").into());
        }
        let doc_id = storage.with_conn(|c| {
            let tx = c.transaction()?;
            let location = match server.unit_type {
                UnitType::Day => Location::Day { date: server.key.clone() },
                UnitType::NextList if server.key == "default" => Location::Next { list_id: None },
                UnitType::NextList => {
                    let exists: Option<Option<String>> =
                        tx.query_row("SELECT deleted_at FROM next_lists WHERE id = ?1", [&server.key], |r| r.get(0)).optional()?;
                    match exists {
                        Some(None) => {}
                        Some(Some(_)) => {
                            tx.execute("UPDATE next_lists SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1", params![server.key, now()])?;
                            tx.execute("UPDATE documents SET deleted_at = NULL WHERE next_list_id = ?1", [&server.key])?;
                        }
                        None => {
                            let title = server.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Next".into());
                            let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM next_lists", [], |r| r.get(0))?;
                            tx.execute(
                                "INSERT INTO next_lists (id, name, is_default, sort_order, created_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4, ?4)",
                                params![server.key, title.chars().take(100).collect::<String>(), order, now()],
                            )?;
                        }
                    }
                    Location::Next { list_id: Some(server.key.clone()) }
                }
            };
            let doc = repo::ensure_doc(&tx, &location)?;
            let existing = link::link_row(&tx, &doc.id)?;
            if doc.sync_enabled && existing.as_ref().and_then(|l| l.account_key.as_deref()) != Some(ctx.account_key.as_str()) {
                // 이 PC 에서 다른 계정으로 연결된 문서 — 건드리지 않는다.
                tx.commit()?;
                return Ok(None);
            }
            if !doc.sync_enabled {
                tx.execute(
                    "INSERT INTO sync_links (document_id, server_document_id, account_id, account_key, link_id, linked_at, acked_version, remote_pending)
                     VALUES (?1, ?2, ?3, ?3, ?4, ?5, 0, 0)
                     ON CONFLICT(document_id) DO UPDATE SET server_document_id = excluded.server_document_id, account_key = excluded.account_key,
                         account_id = excluded.account_id, link_id = excluded.link_id, linked_at = excluded.linked_at, acked_version = 0, remote_pending = 0",
                    params![doc.id, server.id, ctx.account_key, pulled.link_id, now()],
                )?;
                tx.execute(
                    "UPDATE documents SET sync_enabled = 1, sync_status = 'pending', sync_error = NULL, server_version = NULL, synced_revision = 0 WHERE id = ?1",
                    [&doc.id],
                )?;
            }
            tx.commit()?;
            Ok(Some((doc.id, doc.local_revision)))
        })?;
        let Some((doc_id, revision)) = doc_id else { return Ok(()) };
        self.download_attachments(storage, ctx, &server.attachments).await?;
        report.notice("PLAN-A Work 에서 이 PC 와 연결한 메모를 받았습니다.");
        if self.first_link_compare(storage, ctx, &doc_id, revision, &pulled, report)? == Some(true) {
            self.ack_document(storage, ctx, &doc_id, report).await;
        }
        Ok(())
    }

    async fn refresh_document(
        &self,
        storage: &Storage,
        ctx: &SyncContext,
        doc_id: &str,
        server_id: &str,
        report: &mut SyncReport,
    ) -> Step<()> {
        let pulled = self.transport.document(ctx, server_id).await?;
        let server = &pulled.document;
        storage.with_conn(|c| {
            c.execute("UPDATE sync_links SET link_id = ?2 WHERE document_id = ?1", params![doc_id, pulled.link_id])?;
            Ok(())
        })?;
        if pulled.status == "conflict" {
            if self.refresh_conflict(storage, ctx, doc_id, server_id, None, report).await? {
                report.conflicts += 1;
            }
            storage.with_conn(|c| Ok(c.execute("UPDATE sync_links SET remote_pending = 0 WHERE document_id = ?1", [doc_id])?))?;
            return Ok(());
        }
        self.download_attachments(storage, ctx, &server.attachments).await?;
        let applied = storage.with_conn(|c| {
            let tx = c.transaction()?;
            let doc = repo::doc_by_id(&tx, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
            // 서버에 열린 Conflict 가 없는데 로컬은 비교 중 — Web 등 다른 곳에서 해결됐다.
            let open: Option<String> =
                tx.query_row("SELECT id FROM conflicts WHERE document_id = ?1 AND status = 'open'", [doc_id], |r| r.get(0)).optional()?;
            if let Some(conflict_id) = open {
                let local = repo::build_snapshot(&tx, &doc, true)?;
                insert_version(&tx, doc_id, "conflict_local", doc.local_revision, &local)?;
                tx.execute(
                    "UPDATE conflicts SET status = 'resolved_elsewhere', resolved_at = ?2, updated_at = ?2 WHERE id = ?1",
                    params![conflict_id, now()],
                )?;
                tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [doc_id])?;
                tx.execute("UPDATE documents SET synced_revision = local_revision WHERE id = ?1", [doc_id])?;
                report.notice("다른 곳(PLAN-A Work)에서 비교가 해결되어 그 결과를 받았습니다. 이 PC 의 이전 내용은 History 에 있습니다.");
            }
            let doc = repo::doc_by_id(&tx, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
            let known = doc.server_version.unwrap_or(0);
            let dirty = doc.local_revision > doc.synced_revision || has_local_changes(&tx, doc_id)?;
            let applied = if server.version <= known {
                false
            } else if dirty {
                // 보내지 않은 편집이 있다 — 덮어쓰지 않는다. 원래 base 로 보내 서버가 비교를 만들게 한다.
                if !has_local_changes(&tx, doc_id)? {
                    repo::enqueue(&tx, doc_id, "PUSH", doc.local_revision, None)?;
                }
                false
            } else {
                let form = mapper::to_local(&tx, &doc, &ctx.account_key, server.deleted, &server.items)?;
                mapper::apply_to_local(
                    &tx,
                    &doc,
                    &ctx.account_key,
                    &form,
                    Some(if server.deleted { "remote_deleted" } else { "remote_apply" }),
                )?;
                tx.execute(
                    "UPDATE documents SET server_version = ?2, local_revision = local_revision + 1, synced_revision = local_revision + 1,
                            updated_at = ?3 WHERE id = ?1",
                    params![doc_id, server.version, now()],
                )?;
                tx.execute(
                    "UPDATE sync_links SET server_digest = ?2 WHERE document_id = ?1",
                    params![doc_id, mapper::digest_wire(server.deleted, &server.items)],
                )?;
                settle_status(&tx, doc_id)?;
                true
            };
            tx.execute("UPDATE sync_links SET remote_pending = 0 WHERE document_id = ?1", [doc_id])?;
            tx.commit()?;
            Ok(applied)
        })?;
        if applied {
            report.pulled += 1;
            report.touched(doc_id);
            if server.deleted {
                report.notice("PLAN-A Work 에서 삭제된 메모가 있습니다. 이전 내용은 History 에서 복원할 수 있습니다.");
            }
            self.ack_document(storage, ctx, doc_id, report).await;
        }
        Ok(())
    }

    /// 서버의 열린 Conflict 를 로컬 비교 화면 데이터로. true = 새로 열었다.
    async fn refresh_conflict(
        &self,
        storage: &Storage,
        ctx: &SyncContext,
        doc_id: &str,
        server_id: &str,
        prefer: Option<&str>,
        report: &mut SyncReport,
    ) -> Step<bool> {
        let view = self.transport.conflicts(ctx, server_id).await?;
        let chosen = prefer.and_then(|id| view.conflicts.iter().find(|c| c.id == id)).or_else(|| view.conflicts.first()).cloned();
        let Some(chosen) = chosen else {
            // 그 사이 해결됨 — 문서를 다시 받는다.
            storage.with_conn(|c| Ok(c.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [doc_id])?))?;
            return Ok(false);
        };
        // PLAN-A Work 쪽으로 보여 줄 내용: 제안이 Web 에서 왔으면 그 제안, Desktop 제안이면 서버 현재 내용.
        let (remote_deleted, remote_items) = if chosen.source == "web" {
            (chosen.proposal.deleted, chosen.proposal.items.clone())
        } else {
            (view.server.deleted, view.server.items.clone())
        };
        let mut manifest = mapper::manifest_from_items(&remote_items);
        manifest.extend(view.server.attachments.iter().cloned());
        self.download_attachments(storage, ctx, &manifest).await?;
        let opened = storage.with_conn(|c| {
            let tx = c.transaction()?;
            let doc = repo::doc_by_id(&tx, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
            let remote = display_snapshot(&tx, &doc, &ctx.account_key, remote_deleted, &remote_items)?;
            let local = repo::build_snapshot(&tx, &doc, true)?;
            let ts = now();
            let open: Option<String> =
                tx.query_row("SELECT id FROM conflicts WHERE document_id = ?1 AND status = 'open'", [doc_id], |r| r.get(0)).optional()?;
            let opened = match open {
                Some(id) => {
                    tx.execute(
                        "UPDATE conflicts SET remote_snapshot_json = ?2, remote_version = ?3, local_snapshot_json = ?4, local_revision = ?5,
                                server_conflict_id = ?6, source = ?7, account_key = ?8, updated_at = ?9 WHERE id = ?1",
                        params![
                            id,
                            serde_json::to_string(&remote)?,
                            view.server.version,
                            serde_json::to_string(&local)?,
                            doc.local_revision,
                            chosen.id,
                            chosen.source,
                            ctx.account_key,
                            ts
                        ],
                    )?;
                    false
                }
                None => {
                    tx.execute(
                        "INSERT INTO conflicts (id, document_id, local_snapshot_json, remote_snapshot_json, local_revision, remote_version,
                                                server_conflict_id, source, account_key, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                        params![
                            new_id(),
                            doc_id,
                            serde_json::to_string(&local)?,
                            serde_json::to_string(&remote)?,
                            doc.local_revision,
                            view.server.version,
                            chosen.id,
                            chosen.source,
                            ctx.account_key,
                            ts
                        ],
                    )?;
                    true
                }
            };
            tx.execute("UPDATE documents SET sync_status = 'conflict', sync_error = NULL WHERE id = ?1", [doc_id])?;
            tx.commit()?;
            Ok(opened)
        })?;
        report.touched(doc_id);
        Ok(opened)
    }

    // ── 4. ACK ────────────────────────────────────────────────────────

    async fn ack_phase(&self, storage: &Storage, ctx: &SyncContext, report: &mut SyncReport) -> AppResult<()> {
        let due: Vec<String> = storage.with_conn(|c| {
            Ok(c.prepare(
                "SELECT d.id FROM documents d JOIN sync_links l ON l.document_id = d.id
                  WHERE d.sync_enabled = 1 AND l.account_key = ?1 AND l.link_id IS NOT NULL AND l.remote_pending = 0
                    AND d.server_version IS NOT NULL AND d.server_version > l.acked_version",
            )?
            .query_map([&ctx.account_key], |r| r.get(0))?
            .collect::<Result<_, _>>()?)
        })?;
        for doc_id in due {
            self.ack_document(storage, ctx, &doc_id, report).await;
        }
        Ok(())
    }

    /// '이 PC 가 이 version 을 SQLite + 이미지 파일까지 저장했다' 를 서버에 알린다.
    /// 로컬에 보내지 않은 편집·열린 비교가 있거나, 이미지 파일이 하나라도 없으면 보내지 않는다.
    async fn ack_document(&self, storage: &Storage, ctx: &SyncContext, doc_id: &str, report: &mut SyncReport) {
        let prepared = storage.with_conn(|c| {
            let Some(doc) = repo::doc_by_id(c, doc_id)? else { return Ok(None) };
            let link = link_of(c, doc_id)?;
            let (Some(LinkRow { server_document_id: Some(server_id), link_id: Some(link_id), acked_version, .. }), Some(version)) =
                (link, doc.server_version)
            else {
                return Ok(None);
            };
            if version <= acked_version || version == 0 || doc.has_conflict || doc.local_revision > doc.synced_revision {
                return Ok(None);
            }
            let Some(names) = mapper::ack_manifest(c, &storage.paths, &doc, &ctx.account_key)? else { return Ok(None) };
            Ok(Some((server_id, AckRequest { version, link_id, attachments: names })))
        });
        let Ok(Some((server_id, body))) = prepared else { return };
        match self.transport.ack(ctx, &server_id, &body).await {
            Ok(_) => {
                let _ = storage.with_conn(|c| {
                    c.execute(
                        "UPDATE sync_links SET acked_version = MAX(acked_version, ?2) WHERE document_id = ?1",
                        params![doc_id, body.version],
                    )?;
                    Ok(())
                });
                report.acked += 1;
            }
            Err(TransportError::Conflict { code }) if code == "ack_version_stale" || code == "attachments_incomplete" => {
                // 서버가 더 새 version 이거나 이미지 목록이 다르다 — 다시 받는다.
                let _ = storage.with_conn(|c| Ok(c.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [doc_id])?));
            }
            Err(error) => log::info!("ack deferred: {error}"),
        }
    }
}

fn clear_inflight(conn: &Connection, outbox_id: i64) -> AppResult<()> {
    let payload: Option<Option<String>> =
        conn.query_row("SELECT payload FROM sync_outbox WHERE id = ?1", [outbox_id], |r| r.get(0)).optional()?;
    if let Some(Some(json)) = payload {
        if let Ok(mut value) = serde_json::from_str::<OutboxPayload>(&json) {
            value.inflight = None;
            conn.execute("UPDATE sync_outbox SET payload = ?2 WHERE id = ?1", params![outbox_id, serde_json::to_string(&value)?])?;
        }
    }
    Ok(())
}

/// changes 이벤트 하나를 로컬에 기록(받아야 할 문서 표시·연결 종료·Web 이 만든 연결).
/// Some(로컬 문서 id) = 서버가 이 연결을 끝냈다(알림용).
fn record_event(conn: &Connection, ctx: &SyncContext, event: &ChangeEvent) -> AppResult<Option<String>> {
    let local: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT document_id, link_id FROM sync_links WHERE server_document_id = ?1 AND account_key = ?2",
            params![event.document_id, ctx.account_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match (local, event.kind.as_str()) {
        (None, "linked") => {
            // Web 에서 이 PC 로 연결했다 — 문서 내용을 받아 로컬 문서를 연결한다(refresh 단계).
            state_set(conn, &format!("weblink|{}|{}", ctx.account_key, event.document_id), &event.document_id)?;
        }
        (None, "unlinked") => {
            conn.execute("DELETE FROM sync_state WHERE key = ?1", [format!("weblink|{}|{}", ctx.account_key, event.document_id)])?;
        }
        (None, _) => {} // 이 PC 에서 연결하지 않은 문서 — 받지 않는다.
        (Some((doc_id, link_id)), "unlinked") => {
            if link_id.as_deref() == Some(event.link_id.as_str()) {
                link::end_local_link(conn, &doc_id)?;
                conn.execute(
                    "UPDATE documents SET sync_error = ?2 WHERE id = ?1",
                    params![doc_id, "PLAN-A Work 에서 연결이 해제되었습니다. 이 PC 의 내용은 그대로 있습니다."],
                )?;
                return Ok(Some(doc_id));
            }
        }
        (Some((doc_id, link_id)), "linked") => {
            if link_id.as_deref() != Some(event.link_id.as_str()) {
                conn.execute(
                    "UPDATE sync_links SET link_id = ?2, remote_pending = 1 WHERE document_id = ?1",
                    params![doc_id, event.link_id],
                )?;
            } else {
                conn.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&doc_id])?;
            }
        }
        (Some((doc_id, link_id)), _) => {
            // 이전 generation 의 이벤트는 합쳐 버린다(새 연결을 몰래 만들지 않는다).
            if link_id.as_deref() == Some(event.link_id.as_str()) {
                let known: Option<i64> = conn.query_row("SELECT server_version FROM documents WHERE id = ?1", [&doc_id], |r| r.get(0))?;
                let open_conflict: bool =
                    conn.query_row("SELECT EXISTS(SELECT 1 FROM conflicts WHERE document_id = ?1 AND status = 'open')", [&doc_id], |r| {
                        r.get(0)
                    })?;
                if event.kind == "conflict" || open_conflict || event.version > known.unwrap_or(0) {
                    conn.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&doc_id])?;
                }
            }
        }
    }
    Ok(None)
}

/// 비교 화면용 Snapshot(로컬 형식). 매핑·로컬 데이터를 바꾸지 않는다.
fn display_snapshot(
    conn: &Connection,
    doc: &DocumentInfo,
    account_key: &str,
    deleted: bool,
    items: &[WireItem],
) -> AppResult<DocumentSnapshot> {
    let form = mapper::to_local(conn, doc, account_key, deleted, items)?;
    Ok(form.snapshot)
}

// ── Conflict 조회·해결 ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub id: String,
    pub document_id: String,
    pub location: Location,
    pub list_name: Option<String>,
    /// 지금 이 PC 의 내용(충돌 뒤에 더 고친 내용까지)
    pub local: DocumentSnapshot,
    /// PLAN-A Work 쪽 내용
    pub remote: DocumentSnapshot,
    pub remote_version: i64,
    /// 서버 제안의 출처 — desktop(이 PC 가 보낸 내용이 비교 대상) | web(오래된 Web 편집기가 늦게 저장)
    pub source: Option<String>,
    /// 처음 연결하는 문서에 양쪽 모두 내용이 있어 생긴 비교(base_version=0 제안)
    pub first_link: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub fn list_conflicts(conn: &Connection) -> AppResult<Vec<ConflictView>> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM conflicts WHERE status = 'open' ORDER BY created_at")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.iter().map(|id| get_conflict(conn, id)).collect()
}

pub fn get_conflict(conn: &Connection, id: &str) -> AppResult<ConflictView> {
    let row: (String, String, String, i64, Option<String>, String, String) = conn
        .query_row(
            "SELECT id, document_id, remote_snapshot_json, remote_version, source, created_at, updated_at FROM conflicts WHERE id = ?1 AND status = 'open'",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("충돌"))?;
    let doc = repo::doc_by_id(conn, &row.1)?.ok_or_else(|| AppError::not_found("문서"))?;
    let list_name = doc.next_list_id.as_deref().map(|l| repo::list_name(conn, l)).transpose()?.flatten();
    Ok(ConflictView {
        id: row.0,
        document_id: row.1,
        location: repo::location_of_doc(&doc),
        list_name,
        local: repo::build_snapshot(conn, &doc, true)?,
        remote: serde_json::from_str(&row.2)?,
        remote_version: row.3,
        // 첫 연결 비교는 서버 version 을 아직 받아들이지 않은 상태(0)에서 생긴다.
        first_link: doc.server_version == Some(0),
        source: row.4,
        created_at: row.5,
        updated_at: row.6,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictChoice {
    /// Desktop 내용을 최신으로
    Local,
    /// PLAN-A Work 내용을 최신으로
    Remote,
}

impl SyncEngine {
    /// 사용자가 고른 쪽으로 서버 Resolve API 를 부른다. **서버가 성공한 뒤에만** 로컬을 확정한다
    /// (버튼을 눌렀다고 먼저 상대 버전을 지우지 않는다). 그 사이 서버가 바뀌었으면(409 stale) 비교 화면을
    /// 최신으로 다시 채우고 `conflict_stale` 오류를 돌려준다 — 오래된 선택으로 새 Web 변경을 덮지 않는다.
    pub async fn resolve_conflict(&self, storage: &Storage, conflict_id: &str, choice: ConflictChoice) -> AppResult<Location> {
        let ctx = self.context().ok_or_else(|| AppError::new("auth_required", "PLAN-A Work 에 다시 로그인한 뒤 선택해주세요."))?;
        let (doc_id, server_conflict, base, server_id, account) = storage.with_conn(|c| {
            let row: (String, Option<String>, i64, Option<String>) = c
                .query_row(
                    "SELECT document_id, server_conflict_id, remote_version, account_key FROM conflicts WHERE id = ?1 AND status = 'open'",
                    [conflict_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| AppError::not_found("충돌"))?;
            let link = link_of(c, &row.0)?;
            Ok((row.0, row.1, row.2, link.and_then(|l| l.server_document_id), row.3))
        })?;
        if account.as_deref().is_some_and(|a| a != ctx.account_key) {
            return Err(AppError::new("account_mismatch", NOTICE_OTHER_ACCOUNT));
        }
        let (Some(server_conflict), Some(server_id)) = (server_conflict, server_id) else {
            return Err(AppError::new(
                "conflict_unavailable",
                "이 비교는 서버 정보가 없어 선택할 수 없습니다. 연결을 해제한 뒤 다시 연결해주세요.",
            ));
        };
        let side = match choice {
            ConflictChoice::Local => Side::Desktop,
            ConflictChoice::Remote => Side::Web,
        };
        let mut report = SyncReport::default();
        let result = self.transport.resolve(&ctx, &server_id, &server_conflict, &ResolveRequest { base_version: base, side }).await;
        let document = match result {
            Ok(document) => document,
            Err(TransportError::Conflict { code }) if code == "resolution_stale" => {
                let _ = self.refresh_conflict(storage, &ctx, &doc_id, &server_id, Some(&server_conflict), &mut report).await;
                return Err(AppError::new(
                    "conflict_stale",
                    "그 사이 PLAN-A Work 내용이 다시 바뀌었습니다. 최신 내용으로 비교 화면을 새로 고쳤으니 다시 선택해주세요.",
                ));
            }
            Err(TransportError::Conflict { code }) if code == "item_moved_or_not_owned" || code == "client_key_in_use" => {
                // 고른 내용 안의 메모가 그 사이 다른 날짜/List 로 옮겨졌다 — 서버는 그 메모를 가져오지 않는다(v1).
                // 양쪽 내용은 그대로, 비교 화면을 최신으로 다시 채우고 사용자가 다시 판단하게 한다.
                let _ = self.refresh_conflict(storage, &ctx, &doc_id, &server_id, Some(&server_conflict), &mut report).await;
                return Err(AppError::new(
                    "conflict_items_moved",
                    "고른 내용의 메모 일부가 그 사이 PLAN-A Work 에서 다른 날짜/List 로 옮겨져 그대로 적용할 수 없습니다. \
                     두 내용은 그대로 보관되어 있습니다. 옮겨진 위치를 확인한 뒤 다시 선택해주세요.",
                ));
            }
            Err(TransportError::NotFound) => {
                // 다른 곳에서 이미 해결 — 최신 문서를 받는다.
                storage.with_conn(|c| Ok(c.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&doc_id])?))?;
                let _ = self.run_once(storage, true).await;
                return Err(AppError::new(
                    "conflict_resolved_elsewhere",
                    "이 비교는 다른 곳에서 이미 해결되었습니다. 최신 내용을 불러왔습니다.",
                ));
            }
            Err(TransportError::Offline) => {
                return Err(AppError::new(
                    "offline",
                    "PLAN-A Work 에 연결할 수 없어 선택을 보내지 못했습니다. 두 내용은 그대로 보관되어 있습니다.",
                ))
            }
            Err(TransportError::AuthRequired) => {
                self.auth.mark_expired();
                return Err(AppError::new("auth_required", "PLAN-A Work 연결이 만료되었습니다. 다시 로그인한 뒤 선택해주세요."));
            }
            Err(error) => return Err(AppError::new("sync_failed", error.to_string())),
        };
        // 서버 확정 — 이제 로컬을 맞춘다(필요한 이미지 먼저).
        if choice == ConflictChoice::Remote {
            // Resolve 응답의 attachments 가 비어 와도 본문이 참조하는 이미지는 모두 받는다(빠진 채 확정하지 않는다).
            let mut manifest = document.attachments.clone();
            let referenced: Vec<WireAttachment> = mapper::manifest_from_items(&document.items)
                .into_iter()
                .filter(|m| !document.attachments.iter().any(|a| a.name == m.name))
                .collect();
            manifest.extend(referenced);
            self.download_attachments(storage, &ctx, &manifest).await.map_err(|e| match e {
                StepError::App(e) => e,
                StepError::Transport(t) => {
                    AppError::new("sync_failed", format!("PLAN-A Work 이미지를 받지 못했습니다({t}). 잠시 뒤 자동으로 다시 받습니다."))
                }
            })?;
        }
        let location = storage.with_conn(|c| {
            let tx = c.transaction()?;
            let doc = repo::doc_by_id(&tx, &doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
            let remote_json: String = tx.query_row("SELECT remote_snapshot_json FROM conflicts WHERE id = ?1", [conflict_id], |r| r.get(0))?;
            let ts = now();
            match choice {
                ConflictChoice::Local => {
                    let remote: DocumentSnapshot = serde_json::from_str(&remote_json)?;
                    insert_version(&tx, &doc.id, "conflict_remote", doc.local_revision, &remote)?;
                    tx.execute("UPDATE conflicts SET status = 'resolved_local', resolved_at = ?2, updated_at = ?2 WHERE id = ?1", params![conflict_id, ts])?;
                    mapper::adopt_server_ids(&tx, &doc.id, &ctx.account_key, &document.items)?;
                    tx.execute("UPDATE documents SET server_version = ?2 WHERE id = ?1", params![doc.id, document.version])?;
                    tx.execute(
                        "UPDATE sync_links SET server_digest = ?2 WHERE document_id = ?1",
                        params![doc.id, mapper::digest_wire(document.deleted, &document.items)],
                    )?;
                    // 이 PC 내용이 서버 결과와 다르면(비교 뒤에 더 고친 내용 등) 새 version 위에 이어 보낸다.
                    let plan = mapper::build_push(&tx, &doc, &ctx.account_key);
                    let same = plan.as_ref().map(|p| mapper::digest_push(p) == mapper::digest_wire(document.deleted, &document.items)).unwrap_or(false);
                    tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [&doc.id])?;
                    if same {
                        tx.execute("UPDATE documents SET synced_revision = local_revision WHERE id = ?1", [&doc.id])?;
                    } else {
                        repo::enqueue(&tx, &doc.id, "PUSH", doc.local_revision, None)?;
                    }
                }
                ConflictChoice::Remote => {
                    let local = repo::build_snapshot(&tx, &doc, true)?;
                    insert_version(&tx, &doc.id, "conflict_local", doc.local_revision, &local)?;
                    tx.execute("UPDATE conflicts SET status = 'resolved_remote', resolved_at = ?2, updated_at = ?2 WHERE id = ?1", params![conflict_id, ts])?;
                    let form = mapper::to_local(&tx, &doc, &ctx.account_key, document.deleted, &document.items)?;
                    mapper::apply_to_local(&tx, &doc, &ctx.account_key, &form, None)?;
                    tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [&doc.id])?;
                    tx.execute(
                        "UPDATE documents SET server_version = ?2, local_revision = local_revision + 1, synced_revision = local_revision + 1,
                                updated_at = ?3 WHERE id = ?1",
                        params![doc.id, document.version, ts],
                    )?;
                    tx.execute(
                        "UPDATE sync_links SET server_digest = ?2 WHERE document_id = ?1",
                        params![doc.id, mapper::digest_wire(document.deleted, &document.items)],
                    )?;
                }
            }
            settle_status(&tx, &doc.id)?;
            // 서버에 비교가 더 남아 있을 수 있다(예: Web 늦은 저장) — 다시 확인.
            tx.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&doc.id])?;
            let location = repo::location_of_doc(&doc);
            tx.commit()?;
            Ok(location)
        })?;
        let _ = self.run_once(storage, true).await;
        Ok(location)
    }
}

/// 로그아웃(서버가 이 기기를 폐기 → 모든 link 비활성) — 그 계정의 연결을 로컬에서도 끝낸다. 메모는 그대로.
pub fn end_account_links(conn: &mut Connection, account_key: &str) -> AppResult<usize> {
    let tx = conn.transaction()?;
    let ids: Vec<String> = tx
        // 이 계정의 연결 + 이 계정의 해제된 이전 기기 연결(<account_key>#device:…)
        .prepare("SELECT document_id FROM sync_links WHERE account_key = ?1 OR account_key LIKE ?1 || '#device:%'")?
        .query_map([account_key], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in &ids {
        link::end_local_link(&tx, id)?;
    }
    tx.execute("DELETE FROM sync_outbox WHERE op = 'UNLINK' AND (account_key = ?1 OR account_key LIKE ?1 || '#device:%')", [account_key])?;
    tx.execute("DELETE FROM sync_state WHERE key LIKE ?1", [format!("weblink|{account_key}|%")])?;
    tx.commit()?;
    Ok(ids.len())
}
