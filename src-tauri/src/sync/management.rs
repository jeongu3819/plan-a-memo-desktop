//! memo-sync-v2 — 연결된 DAY 의 공통 관리 상태(복사 이력 · 복사 안내 · 알림 설정 · 알림 발생 · 확인).
//!
//! ```text
//!   화면 → 명령 → 로컬 DB(복사본·알림 예약) + management_outbox  (한 transaction — 오프라인에서도 그대로 쓴다)
//!                                │
//!   SyncEngine.run_once ─ ① management_outbox(복사는 그 날짜 본문 Push 보다 먼저) ─ ② v1 Outbox/Changes/Pull
//!                       └ ③ 복사 결과를 그 날짜 문서에 맞춤(reconcile) ─ ④ v2 changes(별도 cursor) → 날짜 상태 → 로컬 반영
//! ```
//! 원칙
//! * 연결된 DAY + 지금 로그인한 계정 + 서버가 v2 를 지원할 때만 서버와 함께 쓴다. Local-only DAY 는 바뀌지 않는다
//!   (복사·알림 모두 이 PC 에서만 — 자동 연결·자동 업로드 없음).
//! * 서버 공통 id 만 쓴다 — 로컬 SQLite id 를 서버 id 로 쓰지 않고, 제목·본문이 같다고 같은 항목으로 보지 않는다.
//! * 응답을 잃으면 같은 request_id·같은 본문으로 다시 보낸다(서버 idempotency). 한 번 보낸 본문을 고치지 않는다.
//! * 양쪽이 다르게 바뀌면 자동으로 고르지 않는다(시각 기준 승자 없음) — 알림 설정은 서버값/내 설정 선택,
//!   복사본은 항목별 선택(carry_reviews) 또는 기존 날짜 전체 비교(v1 Conflict).

use std::collections::{HashMap, HashSet};

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::contract::*;
use super::contract_v2::*;
use super::engine::{state_get, state_set, SyncEngine, SyncReport};
use super::link;
use super::mapper;
use super::transport::*;
use crate::error::{AppError, AppResult};
use crate::memo::{repo, DocumentInfo, Location, MemoItem};
use crate::reminders;
use crate::storage::Storage;
use crate::util::{new_id, now};

/// 지금 이 PC 에 로그인한 계정(account_key) — 앱이 Sync 할 때마다 남긴다(작업 스케줄러가 실행한 알림 프로세스도 읽는다).
pub const ACTIVE_ACCOUNT_KEY: &str = "active_account";
/// 서버 v2 지원 여부를 다시 확인하는 간격.
const CAPABILITY_TTL_AVAILABLE_SECS: i64 = 6 * 3600;
const CAPABILITY_TTL_UNAVAILABLE_SECS: i64 = 10 * 60;
/// 복사 후보를 다시 묻는 최소 간격(화면이 열 때).
const CANDIDATE_TTL_SECS: i64 = 20;
/// 같은 명령의 다른 원인 실패를 이 횟수만큼 다시 만든 뒤에는 사용자에게 묻는다.
const MAX_REBUILDS: i64 = 3;

pub const NOTICE_RULE_CONFLICT: &str =
    "날짜 알림 설정이 PLAN-A Work 와 서로 다릅니다. 두 설정을 모두 보관해 두었으니 그 날짜의 알림 설정에서 사용할 설정을 골라주세요.";
pub const NOTICE_CARRY_REVIEW: &str =
    "지난 미완료 복사본이 PLAN-A Work 쪽 복사본과 달라 그대로 합치지 않았습니다. 그 날짜에서 남길 내용을 골라주세요.";

// ── 스키마 · 계정 · 서버 지원 여부 ────────────────────────────────────────

/// v4(memo_sync_v2) 테이블이 있는가 — 알림 프로세스가 아직 migration 전 DB 를 열 수도 있다.
pub fn has_schema(conn: &Connection) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shared_days'", [], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

pub fn active_account(conn: &Connection) -> AppResult<Option<String>> {
    state_get(conn, ACTIVE_ACCOUNT_KEY)
}

pub fn set_active_account(conn: &Connection, account_key: Option<&str>) -> AppResult<()> {
    match account_key {
        Some(key) => state_set(conn, ACTIVE_ACCOUNT_KEY, key),
        None => {
            conn.execute("DELETE FROM sync_state WHERE key = ?1", [ACTIVE_ACCOUNT_KEY])?;
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Available,
    Unavailable,
    Unknown,
}

fn capability_key(account_key: &str) -> String {
    format!("mgmt_cap|{account_key}")
}

fn capability_row(conn: &Connection, account_key: &str) -> AppResult<Option<(bool, String)>> {
    Ok(state_get(conn, &capability_key(account_key))?.and_then(|v| {
        let (flag, at) = v.split_once('|')?;
        Some((flag == "1", at.to_string()))
    }))
}

pub fn capability(conn: &Connection, account_key: &str) -> AppResult<Capability> {
    Ok(match capability_row(conn, account_key)? {
        Some((true, _)) => Capability::Available,
        Some((false, _)) => Capability::Unavailable,
        None => Capability::Unknown,
    })
}

pub fn set_capability(conn: &Connection, account_key: &str, available: bool) -> AppResult<()> {
    state_set(conn, &capability_key(account_key), &format!("{}|{}", if available { 1 } else { 0 }, now()))
}

fn capability_stale(conn: &Connection, account_key: &str) -> AppResult<bool> {
    let Some((available, at)) = capability_row(conn, account_key)? else { return Ok(true) };
    let ttl = if available { CAPABILITY_TTL_AVAILABLE_SECS } else { CAPABILITY_TTL_UNAVAILABLE_SECS };
    Ok(seconds_since(&at).map(|s| s >= ttl).unwrap_or(true))
}

fn seconds_since(at: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(at).ok().map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds())
}

/// 이 PC 의 IANA 시간대(서버 rule 의 timezone). 알 수 없으면 PLAN-A Work 기본값.
pub fn local_timezone() -> String {
    iana_time_zone::get_timezone().ok().filter(|tz| tz.contains('/') || tz == "UTC").unwrap_or_else(|| "Asia/Seoul".to_string())
}

// ── 날짜의 관리 범위 ────────────────────────────────────────────────────

/// 날짜 하나의 복사·알림을 누가 기준으로 관리하는가.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DayScope {
    /// 이 PC 에만 있는 날짜 — 지금처럼 이 PC 의 설정만
    Local,
    /// 연결된 날짜 · 지금 계정 · 서버 v2 지원 — 서버 공통 상태
    Shared { account_key: String, doc_id: String, link_id: Option<String> },
    /// 연결된 날짜인데 서버가 공통 관리를 아직 지원하지 않는다(v1 만) — 공통 관리 편집을 막는다(인계서 §6)
    Unavailable,
    /// 연결된 날짜 — 서버 지원 여부를 아직 확인하지 못했다(처음·오프라인)
    Checking,
    /// 다른 계정(또는 해제된 이전 기기 등록)으로 연결된 날짜
    OtherAccount,
}

impl DayScope {
    pub fn is_shared(&self) -> bool {
        matches!(self, DayScope::Shared { .. })
    }

    /// 공통 관리를 편집할 수 없는 이유(화면 안내). Local · Shared 는 None.
    pub fn blocked_reason(&self) -> Option<&'static str> {
        match self {
            DayScope::Local | DayScope::Shared { .. } => None,
            DayScope::Unavailable => Some(
                "PLAN-A Work 와 연결된 날짜입니다. 연결된 PLAN-A Work 서버가 복사·알림 공통 관리를 아직 지원하지 않아 이 날짜에서는 바꿀 수 없습니다(기존 알림은 그대로 유지됩니다).",
            ),
            DayScope::Checking => Some(
                "PLAN-A Work 와 연결된 날짜입니다. 복사·알림 공통 관리 지원 여부를 확인하는 중입니다. 잠시 뒤(인터넷 연결 후) 다시 시도해주세요.",
            ),
            DayScope::OtherAccount => Some("다른 PLAN-A Work 계정으로 연결된 날짜입니다. 그 계정으로 로그인하면 복사·알림을 바꿀 수 있습니다."),
        }
    }
}

pub fn day_scope(conn: &Connection, date: &str) -> AppResult<DayScope> {
    if !has_schema(conn) {
        return Ok(DayScope::Local);
    }
    let Some(doc) = repo::doc_for_location(conn, &Location::Day { date: date.to_string() })? else { return Ok(DayScope::Local) };
    if !doc.sync_enabled {
        return Ok(DayScope::Local);
    }
    let link = link::link_row(conn, &doc.id)?;
    let account = link.as_ref().and_then(|l| l.account_key.clone());
    let active = active_account(conn)?;
    match (account, active) {
        (Some(account), Some(active)) if account == active => Ok(match capability(conn, &account)? {
            Capability::Available => DayScope::Shared { account_key: account, doc_id: doc.id, link_id: link.and_then(|l| l.link_id) },
            Capability::Unavailable => DayScope::Unavailable,
            Capability::Unknown => DayScope::Checking,
        }),
        // 업데이트 직후 등 아직 지금 계정을 모른다 — 다른 계정으로 단정하지 않고 확인 중으로 둔다.
        (Some(_), None) => Ok(DayScope::Checking),
        _ => Ok(DayScope::OtherAccount),
    }
}

/// 연결된 날짜이고 그 계정의 서버 공통 상태(shared_days)가 있으면 그 계정.
fn shared_account_for(conn: &Connection, date: &str) -> AppResult<Option<String>> {
    match day_scope(conn, date)? {
        DayScope::Shared { account_key, .. } => {
            let known: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM shared_days WHERE account_key = ?1 AND memo_date = ?2)",
                params![account_key, date],
                |r| r.get(0),
            )?;
            Ok(known.then_some(account_key))
        }
        _ => Ok(None),
    }
}

// ── Outbox ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CarryPayload {
    pub source_item_id: String,
    pub source_date: String,
    pub copy_item_id: String,
    pub local_copy_key: String,
    /// 복사한 순간의 본문(로컬 형식) — 나중에 '이 PC 에서 고쳤는가' 를 판단한다
    pub original_html: String,
    pub section: String,
    #[serde(default)]
    pub rebuilds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RulePayload {
    /// 이 제안의 기준 서버 rule.version. None = 앞선 내 제안의 결과 version 을 이어 쓴다(연달아 바꿈)
    pub base_version: Option<i64>,
    pub timezone: String,
    pub local_time: String,
    pub days_before: Vec<i64>,
    #[serde(default)]
    pub rebuilds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AckPayload {
    pub occurrence_id: String,
    pub offset_days: i64,
    #[serde(default)]
    pub rebuilds: i64,
}

#[derive(Debug, Clone)]
pub struct OutboxOp {
    pub id: i64,
    pub account_key: String,
    pub memo_date: String,
    pub kind: String,
    pub request_id: String,
    pub route: Option<String>,
    pub body_json: Option<String>,
    pub payload_json: String,
    pub attempts: i64,
    pub sent_at: Option<String>,
}

const OP_COLUMNS: &str = "id, account_key, memo_date, kind, request_id, route, body_json, payload_json, attempts, sent_at";

fn op_from_row(r: &rusqlite::Row) -> rusqlite::Result<OutboxOp> {
    Ok(OutboxOp {
        id: r.get(0)?,
        account_key: r.get(1)?,
        memo_date: r.get(2)?,
        kind: r.get(3)?,
        request_id: r.get(4)?,
        route: r.get(5)?,
        body_json: r.get(6)?,
        payload_json: r.get(7)?,
        attempts: r.get(8)?,
        sent_at: r.get(9)?,
    })
}

fn insert_op(conn: &Connection, account_key: &str, date: &str, kind: &str, payload: &impl Serialize) -> AppResult<i64> {
    let ts = now();
    conn.execute(
        "INSERT INTO management_outbox (account_key, memo_date, kind, request_id, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![account_key, date, kind, new_id(), serde_json::to_string(payload)?, ts],
    )?;
    Ok(conn.last_insert_rowid())
}

fn op_by_id(conn: &Connection, id: i64) -> AppResult<Option<OutboxOp>> {
    Ok(conn.query_row(&format!("SELECT {OP_COLUMNS} FROM management_outbox WHERE id = ?1"), [id], op_from_row).optional()?)
}

fn finish_op(conn: &Connection, id: i64, status: &str, result: Option<&serde_json::Value>, error: Option<&str>) -> AppResult<()> {
    conn.execute(
        "UPDATE management_outbox SET status = ?2, result_json = COALESCE(?3, result_json), last_error = ?4, next_attempt_at = NULL,
                updated_at = ?5 WHERE id = ?1",
        params![id, status, result.map(|r| r.to_string()), error, now()],
    )?;
    Ok(())
}

/// 보낸 본문을 버리고(서버가 기록하지 않은 거절·다른 link generation) 새 request_id 로 다시 만들게 한다.
fn rebuild_op(conn: &Connection, id: i64, payload_json: &str, error: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE management_outbox SET body_json = NULL, route = NULL, sent_at = NULL, request_id = ?2, payload_json = ?3,
                attempts = attempts + 1, last_error = ?4, next_attempt_at = ?5, updated_at = ?6 WHERE id = ?1",
        params![id, new_id(), payload_json, error, later(5), now()],
    )?;
    Ok(())
}

fn backoff_op(conn: &Connection, op: &OutboxOp, error: &str) -> AppResult<()> {
    let delay = (5i64 << (op.attempts + 1).clamp(0, 7)).min(600);
    conn.execute(
        "UPDATE management_outbox SET attempts = attempts + 1, next_attempt_at = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?1",
        params![op.id, later(delay), error, now()],
    )?;
    Ok(())
}

fn later(seconds: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 그 날짜(계정)의 아직 보내지 않은 관리 명령을 멈춘다(연결 해제·기기 폐기·로그아웃) — 로컬 메모·복사본은 그대로.
pub fn drop_day_ops(conn: &Connection, account_key: &str, date: &str, reason: &str) -> AppResult<usize> {
    if !has_schema(conn) {
        return Ok(0);
    }
    let n = conn.execute(
        "UPDATE management_outbox SET status = 'dropped', last_error = ?3, updated_at = ?4
          WHERE account_key = ?1 AND memo_date = ?2 AND status IN ('pending', 'conflict')",
        params![account_key, date, reason, now()],
    )?;
    // 맞추지 못한 복사 결과도 더 기다리지 않는다(연결이 끝났다 — 이 PC 의 복사본은 일반 메모로 남는다).
    conn.execute(
        "UPDATE management_outbox SET reconciled = 1 WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'carry' AND reconciled = 0",
        params![account_key, date],
    )?;
    conn.execute(
        "UPDATE carry_reviews SET status = 'resolved_local', resolved_at = ?3 WHERE account_key = ?1 AND memo_date = ?2 AND status = 'open'",
        params![account_key, date, now()],
    )?;
    Ok(n)
}

/// 계정의 모든 관리 명령을 멈춘다(로그아웃 — 서버가 이 기기를 폐기한다).
pub fn drop_account_ops(conn: &Connection, account_key: &str, reason: &str) -> AppResult<usize> {
    if !has_schema(conn) {
        return Ok(0);
    }
    let dates: Vec<String> = conn
        .prepare("SELECT DISTINCT memo_date FROM management_outbox WHERE account_key = ?1 AND (status IN ('pending', 'conflict') OR reconciled = 0)")?
        .query_map([account_key], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut n = 0;
    for date in dates {
        n += drop_day_ops(conn, account_key, &date, reason)?;
    }
    Ok(n)
}

// ── 복사(Desktop 에서 먼저) ─────────────────────────────────────────────

/// 연결된 대상 날짜로 만든 임시 복사본 하나를 서버 공통 복사 명령으로 남긴다(복사본 생성과 같은 transaction).
/// 임시 key 를 그 복사본의 client_key 로도 기록한다 — 서버는 이 key 를 본문 Push 로 다시 만들지 않게 막는다(copy_mapping_required).
#[allow(clippy::too_many_arguments)]
pub fn enqueue_carry(
    conn: &Connection,
    account_key: &str,
    target_doc_id: &str,
    target_date: &str,
    source_date: &str,
    source_item_id: &str,
    copy: &MemoItem,
) -> AppResult<()> {
    let key = new_id().to_ascii_lowercase();
    conn.execute(
        "INSERT INTO sync_item_map (document_id, item_id, account_key, client_key) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(document_id, item_id) DO UPDATE SET account_key = excluded.account_key, client_key = excluded.client_key,
             server_item_id = NULL, item_version = NULL",
        params![target_doc_id, copy.id, account_key, key],
    )?;
    insert_op(
        conn,
        account_key,
        target_date,
        "carry",
        &CarryPayload {
            source_item_id: source_item_id.to_string(),
            source_date: source_date.to_string(),
            copy_item_id: copy.id.clone(),
            local_copy_key: key,
            original_html: copy.content_html.clone(),
            section: copy.section.clone(),
            rebuilds: 0,
        },
    )?;
    Ok(())
}

/// [이번에는 건너뛰기] — 연결된 날짜면 서버 공통 안내 상태로도 보낸다.
pub fn enqueue_dismiss(conn: &Connection, account_key: &str, date: &str) -> AppResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM management_outbox WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'dismiss' AND status = 'pending')",
        params![account_key, date],
        |r| r.get(0),
    )?;
    let dismissed: bool = conn
        .query_row("SELECT prompt_dismissed FROM shared_days WHERE account_key = ?1 AND memo_date = ?2", params![account_key, date], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .unwrap_or(0)
        == 1;
    if !exists && !dismissed {
        insert_op(conn, account_key, date, "dismiss", &serde_json::json!({}))?;
    }
    Ok(())
}

/// 이 날짜 문서의 본문 Push 를 미뤄야 하는가 — 보내지 않은 복사 명령 · 아직 맞추지 않은 복사 결과 · 사용자 선택 대기.
pub fn push_blocked(conn: &Connection, doc: &DocumentInfo) -> AppResult<bool> {
    let Some(date) = doc.memo_date.as_deref() else { return Ok(false) };
    if !has_schema(conn) {
        return Ok(false);
    }
    let Some(account) = link::link_row(conn, &doc.id)?.and_then(|l| l.account_key) else { return Ok(false) };
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM management_outbox WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'carry'
                         AND (status = 'pending' OR (status = 'done' AND reconciled = 0)))
             OR EXISTS(SELECT 1 FROM carry_reviews WHERE account_key = ?1 AND memo_date = ?2 AND status = 'open')",
        params![account, date],
        |r| r.get(0),
    )?)
}

#[derive(Debug, Clone)]
pub struct DoneCarry {
    pub op_id: i64,
    pub payload: CarryPayload,
    pub mapping: Option<CopyMapping>,
}

/// 문서를 받을 때 복사 명령과의 순서.
pub enum CarryGate {
    /// 기다릴 것 없음
    Clear,
    /// 아직 보내지 않은 복사 명령이 있다 — 받은 내용을 적용하지 않는다(복사가 먼저)
    Wait,
    /// 서버가 확정한 복사 결과를 이 문서에 맞춰야 한다
    Reconcile(Vec<DoneCarry>),
}

pub fn carry_gate(conn: &Connection, account_key: &str, date: &str) -> AppResult<CarryGate> {
    if !has_schema(conn) {
        return Ok(CarryGate::Clear);
    }
    let pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM management_outbox WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'carry' AND status = 'pending')",
        params![account_key, date],
        |r| r.get(0),
    )?;
    if pending {
        return Ok(CarryGate::Wait);
    }
    let rows: Vec<(i64, String, Option<String>)> = conn
        .prepare(
            "SELECT id, payload_json, result_json FROM management_outbox
              WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'carry' AND status = 'done' AND reconciled = 0 ORDER BY id",
        )?
        .query_map(params![account_key, date], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    if rows.is_empty() {
        return Ok(CarryGate::Clear);
    }
    let mut done = Vec::new();
    for (op_id, payload, result) in rows {
        let payload: CarryPayload = serde_json::from_str(&payload)?;
        let mapping = result
            .and_then(|r| serde_json::from_str::<CarryResponse>(&r).ok())
            .and_then(|r| r.mappings.into_iter().find(|m| m.local_copy_key == payload.local_copy_key));
        done.push(DoneCarry { op_id, payload, mapping });
    }
    Ok(CarryGate::Reconcile(done))
}

// ── 복사 결과 맞추기(reconcile) ───────────────────────────────────────────

/// 이미지 첨부 id 는 복사할 때 새로 만들어지므로(복제) 내용 비교는 첨부의 SHA-256 으로 한다.
fn canonical_html(conn: &Connection, html: &str) -> AppResult<String> {
    let mut out = html.to_string();
    for id in crate::memo::text::attachment_ids(html) {
        let hash: Option<String> = conn.query_row("SELECT content_hash FROM attachments WHERE id = ?1", [&id], |r| r.get(0)).optional()?;
        if let Some(hash) = hash {
            out = out.replace(&format!("attachment://{id}"), &format!("attachment-sha256://{hash}"));
        }
    }
    Ok(out)
}

fn local_form_html(conn: &Connection, account_key: &str, server_html: &str) -> Option<String> {
    mapper::to_local_html(conn, account_key, server_html).ok()
}

#[allow(clippy::too_many_arguments)]
fn open_review(
    conn: &Connection,
    account_key: &str,
    date: &str,
    kind: &str,
    item_id: &str,
    canonical: Option<i64>,
    other: Option<&str>,
    local_html: Option<&str>,
    server_html: Option<&str>,
) -> AppResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM carry_reviews WHERE account_key = ?1 AND memo_date = ?2 AND item_id = ?3 AND status = 'open')",
        params![account_key, date, item_id],
        |r| r.get(0),
    )?;
    if !exists {
        conn.execute(
            "INSERT INTO carry_reviews (id, account_key, memo_date, kind, item_id, canonical_item_id, other_item_id, local_html, server_html, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![new_id(), account_key, date, kind, item_id, canonical, other, local_html, server_html, now()],
        )?;
    }
    Ok(())
}

fn soft_delete_item(conn: &Connection, doc_id: &str, item_id: &str) -> AppResult<()> {
    conn.execute("UPDATE memo_items SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL", params![item_id, now()])?;
    conn.execute("DELETE FROM sync_item_map WHERE document_id = ?1 AND item_id = ?2", params![doc_id, item_id])?;
    Ok(())
}

fn unmap_item(conn: &Connection, doc_id: &str, item_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM sync_item_map WHERE document_id = ?1 AND item_id = ?2", params![doc_id, item_id])?;
    Ok(())
}

fn set_item_content(conn: &Connection, item_id: &str, html: &str, completed: bool) -> AppResult<()> {
    let ts = now();
    conn.execute(
        "UPDATE memo_items SET content_html = ?2, content_text = ?3, completed = ?4,
                completed_at = CASE WHEN ?4 = 1 THEN COALESCE(completed_at, ?5) ELSE NULL END, deleted_at = NULL, updated_at = ?5
          WHERE id = ?1",
        params![item_id, html, crate::memo::text::search_text(html), completed as i64, ts],
    )?;
    if let Some(item) = repo::item_by_id(conn, item_id, false)? {
        repo::link_attachments(conn, &item)?;
    }
    Ok(())
}

/// 결과 — true = 이 PC 의 문서를 바꿨다(화면 갱신).
#[derive(Debug, Default)]
pub struct ReconcileOutcome {
    pub changed: bool,
    pub reviews: usize,
}

/// 서버가 확정한 복사 결과(임시 복사본 → 서버 정식 복사본)를 받은 최신 서버 문서(`server`)와 이 PC 문서에 맞춘다.
/// 호출자: 문서를 받은 refresh 단계(같은 transaction). 이미지는 미리 받아 두었다.
///
/// 항목별(복사본마다):
/// * 고치지 않은 임시 복사본 → 서버 복사본 내용으로(같은 항목 — 중복 없음)
/// * 이 PC 에서만 고침 → 이 PC 내용 유지(서버 복사본의 수정으로 보낸다)
/// * 서버에서 지워짐·옮겨짐 + 고치지 않음 → 이 PC 에서도 뺀다(되살리지 않는다)
/// * 이미 같은 복사본이 이 PC 에 있음(Web 이 먼저 복사) + 고치지 않음 → 하나만 남긴다
/// * 양쪽이 다르게 바뀜 → 사용자에게 묻는다(carry_reviews) — 자동으로 고르지 않는다
///
/// 문서 전체:
/// * 서버의 다른 변경이 우리 복사뿐 → 서버 version 위에서 이어 보낸다(다른 사람 변경을 덮지 않음이 확인됨)
/// * 이 PC 의 다른 변경이 복사뿐 → 서버 내용을 받는다(복사본의 이 PC 수정은 유지)
/// * 그 밖(양쪽 모두 다른 변경) → 이 PC 내용 그대로, 원래 base 로 보내 기존 날짜 전체 비교(Conflict)
pub fn reconcile_carries(
    tx: &Connection,
    account_key: &str,
    doc: &DocumentInfo,
    server: &WireDocument,
    done: &[DoneCarry],
) -> AppResult<ReconcileOutcome> {
    let mut outcome = ReconcileOutcome::default();
    let date = doc.memo_date.clone().unwrap_or_default();
    let resolved: HashSet<String> = tx
        .prepare("SELECT item_id FROM carry_reviews WHERE account_key = ?1 AND memo_date = ?2 AND status <> 'open'")?
        .query_map(params![account_key, date], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let local: HashMap<String, MemoItem> = repo::items_of(tx, &doc.id)?.into_iter().map(|i| (i.id.clone(), i)).collect();
    let server_by_id: HashMap<i64, &WireItem> = server.items.iter().filter_map(|i| i.id.map(|id| (id, i))).collect();
    let provisional: HashSet<String> = done.iter().map(|d| d.payload.copy_item_id.clone()).collect();
    let mut copied_ids: HashSet<i64> = HashSet::new();
    // 항목별 결정(문서 단위 단계에서 쓴다): 이 PC 내용 유지 · 이 PC 삭제 유지 · 서버 변경 있음
    let mut keep_local: HashSet<String> = HashSet::new();
    let mut deleted_by_user: HashSet<i64> = HashSet::new();
    let mut history_recorded = false;
    let mut remember = |tx: &Connection| -> AppResult<()> {
        if !history_recorded {
            repo::record_version(tx, &doc.id, "carry_mapping")?;
            history_recorded = true;
        }
        Ok(())
    };

    for carry in done {
        let p = carry.payload.copy_item_id.as_str();
        let Some(mapping) = &carry.mapping else { continue };
        let x = mapping.copied_item_id;
        copied_ids.insert(x);
        let p_item = local.get(p);
        if resolved.contains(p) {
            if p_item.is_some() {
                keep_local.insert(p.to_string());
            }
            continue;
        }
        let s = if mapping.deleted || mapping.moved { None } else { server_by_id.get(&x).copied() };
        let other: Option<String> = tx
            .query_row(
                "SELECT m.item_id FROM sync_item_map m JOIN memo_items i ON i.id = m.item_id
                  WHERE m.document_id = ?1 AND m.account_key = ?2 AND m.server_item_id = ?3 AND m.item_id <> ?4
                    AND i.document_id = ?1 AND i.deleted_at IS NULL LIMIT 1",
                params![doc.id, account_key, x, p],
                |r| r.get(0),
            )
            .optional()?;
        let original = canonical_html(tx, &carry.payload.original_html)?;
        let p_edited = match p_item {
            Some(item) => item.completed || canonical_html(tx, &item.content_html)? != original,
            None => false,
        };
        let s_html = s.and_then(|s| local_form_html(tx, account_key, &s.content));
        let s_changed = match (s, &s_html) {
            (Some(s), Some(html)) => s.completed || canonical_html(tx, html)? != original,
            (Some(_), None) => true, // 이미지를 아직 맞추지 못함 — 바뀐 것으로 보고 묻는다(덮지 않는다)
            (None, _) => false,
        };
        if let Some(other) = other {
            // 이 PC 에 같은 정식 복사본이 이미 있다(Web·다른 기기가 먼저 복사해 받아 둠).
            match p_item {
                None => unmap_item(tx, &doc.id, p)?,
                Some(_) if !p_edited => {
                    remember(tx)?;
                    soft_delete_item(tx, &doc.id, p)?;
                    tx.execute("UPDATE item_copies SET new_item_id = ?2 WHERE new_item_id = ?1", params![p, other])?;
                    outcome.changed = true;
                }
                Some(item) => {
                    let other_html = local.get(&other).map(|o| o.content_html.clone());
                    open_review(
                        tx,
                        account_key,
                        &date,
                        "duplicate",
                        p,
                        Some(x),
                        Some(&other),
                        Some(&item.content_html),
                        other_html.as_deref(),
                    )?;
                    outcome.reviews += 1;
                }
            }
            continue;
        }
        match (p_item, s) {
            (None, Some(_)) if s_changed => {
                // 이 PC 에서 지운 복사본을 다른 곳에서 고쳤다.
                open_review(tx, account_key, &date, "both_changed", p, Some(x), None, None, s_html.as_deref())?;
                outcome.reviews += 1;
            }
            (None, Some(_)) => {
                deleted_by_user.insert(x);
                unmap_item(tx, &doc.id, p)?;
            }
            (None, None) => unmap_item(tx, &doc.id, p)?,
            (Some(_), Some(s)) if !p_edited => {
                if let Some(html) = &s_html {
                    remember(tx)?;
                    set_item_content(tx, p, html, s.kind == "checklist" && s.completed)?;
                    outcome.changed = true;
                }
            }
            (Some(_), Some(_)) if !s_changed => {
                keep_local.insert(p.to_string());
            }
            (Some(item), Some(_)) => {
                open_review(tx, account_key, &date, "both_changed", p, Some(x), None, Some(&item.content_html), s_html.as_deref())?;
                outcome.reviews += 1;
            }
            (Some(_), None) if !p_edited => {
                remember(tx)?;
                soft_delete_item(tx, &doc.id, p)?;
                outcome.changed = true;
            }
            (Some(item), None) => {
                open_review(tx, account_key, &date, "server_removed", p, Some(x), None, Some(&item.content_html), None)?;
                outcome.reviews += 1;
            }
        }
    }

    if outcome.changed {
        tx.execute("UPDATE documents SET local_revision = local_revision + 1, updated_at = ?2 WHERE id = ?1", params![doc.id, now()])?;
    }
    if outcome.reviews > 0 {
        // 사용자가 고를 때까지 문서 단위 단계는 하지 않는다(본문 Push 도 막힌다). 고르면 다시 받아서 이어 맞춘다.
        return Ok(outcome);
    }

    let doc = repo::doc_by_id(tx, &doc.id)?.ok_or_else(|| AppError::not_found("문서"))?;
    let base = link::link_row(tx, &doc.id)?.and_then(|l| l.server_digest);
    let mark_reconciled = |tx: &Connection| -> AppResult<()> {
        for carry in done {
            tx.execute("UPDATE management_outbox SET reconciled = 1, updated_at = ?2 WHERE id = ?1", params![carry.op_id, now()])?;
        }
        Ok(())
    };
    let (Some(base), Some(_)) = (base, doc.server_version) else {
        // 첫 연결 비교 전 — 첫 연결 비교(LINK)가 맞춘다.
        mark_reconciled(tx)?;
        return Ok(outcome);
    };
    let server_digest = mapper::digest_wire(server.deleted, &server.items);
    let server_minus: Vec<WireItem> = server.items.iter().filter(|i| !i.id.is_some_and(|id| copied_ids.contains(&id))).cloned().collect();
    let server_only_ours = mapper::digest_wire(server.deleted, &server_minus) == base;
    let local_minus = mapper::build_push_keyed(tx, &doc, account_key).ok().map(|plan| {
        let items: Vec<PushItem> = plan.items.into_iter().filter(|(id, _)| !provisional.contains(id)).map(|(_, i)| i).collect();
        mapper::digest_push(&mapper::PushPlan { deleted: plan.deleted, items })
    });
    let local_only_copies = local_minus.as_deref() == Some(base.as_str());

    if server_only_ours {
        // 서버의 새 version = 지난번에 맞춘 내용 + 우리 복사뿐 → 그 version 위에 이 PC 문서를 이어 보낸다.
        mapper::adopt_server_ids(tx, &doc.id, account_key, &server.items)?;
        tx.execute("UPDATE documents SET server_version = ?2 WHERE id = ?1", params![doc.id, server.version])?;
        tx.execute("UPDATE sync_links SET server_digest = ?2 WHERE document_id = ?1", params![doc.id, server_digest])?;
        settle_after_rebase(tx, &doc.id, account_key, &server_digest)?;
    } else if local_only_copies {
        // 이 PC 는 복사 말고 바꾼 것이 없다 → 서버 내용을 받는다(이 PC 에서 고친 복사본·지운 복사본은 그 결정을 유지).
        let wanted: Vec<WireItem> =
            server.items.iter().filter(|i| !i.id.is_some_and(|id| deleted_by_user.contains(&id))).cloned().collect();
        let mut form = mapper::to_local(tx, &doc, account_key, server.deleted, &wanted)?;
        let mut overridden = !deleted_by_user.is_empty();
        for item in form.snapshot.items.iter_mut() {
            if keep_local.contains(&item.item_key) {
                if let Some(current) = local.get(&item.item_key) {
                    item.content_html = current.content_html.clone();
                    item.completed = current.completed;
                    item.completed_at = current.completed_at.clone();
                    overridden = true;
                }
            }
        }
        mapper::apply_to_local(tx, &doc, account_key, &form, Some("remote_apply"))?;
        tx.execute(
            "UPDATE documents SET server_version = ?2, local_revision = local_revision + 1, updated_at = ?3 WHERE id = ?1",
            params![doc.id, server.version, now()],
        )?;
        tx.execute("UPDATE sync_links SET server_digest = ?2 WHERE document_id = ?1", params![doc.id, server_digest])?;
        if overridden {
            let doc = repo::doc_by_id(tx, &doc.id)?.ok_or_else(|| AppError::not_found("문서"))?;
            repo::enqueue(tx, &doc.id, "PUSH", doc.local_revision, None)?;
        } else {
            tx.execute("UPDATE documents SET synced_revision = local_revision WHERE id = ?1", [&doc.id])?;
            tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [&doc.id])?;
        }
        outcome.changed = true;
    } else {
        // 양쪽 모두 다른 변경이 있다 — 이 PC 내용 그대로, 원래 base 로 보내 기존 날짜 전체 비교에 맡긴다(덮어쓰지 않음).
        let has_push: bool =
            tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE document_id = ?1 AND op = 'PUSH')", [&doc.id], |r| r.get(0))?;
        if !has_push {
            repo::enqueue(tx, &doc.id, "PUSH", doc.local_revision, None)?;
        }
    }
    mark_reconciled(tx)?;
    Ok(outcome)
}

/// 서버 version 을 이어받은 뒤 — 내용이 같으면 동기화됨, 다르면 Push.
fn settle_after_rebase(tx: &Connection, doc_id: &str, account_key: &str, server_digest: &str) -> AppResult<()> {
    let doc = repo::doc_by_id(tx, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
    let same = mapper::build_push(tx, &doc, account_key).map(|plan| mapper::digest_push(&plan) == server_digest).unwrap_or(false);
    if same {
        tx.execute("UPDATE documents SET synced_revision = local_revision WHERE id = ?1", [doc_id])?;
        tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [doc_id])?;
    } else {
        // 보내는 사이에 쌓인 오래된 요청 본문(inflight)은 다시 쓰지 않는다 — 새 base 로 새 요청을 만든다.
        tx.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op = 'PUSH'", [doc_id])?;
        repo::enqueue(tx, doc_id, "PUSH", doc.local_revision, None)?;
    }
    Ok(())
}

// ── 복사본 선택(carry_reviews) ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryReviewView {
    pub id: String,
    pub date: String,
    pub kind: String,
    pub item_id: String,
    /// 이 PC 의 내용(None = 이 PC 에서 지움)
    pub local_html: Option<String>,
    /// PLAN-A Work 쪽 내용(None = 지워졌거나 다른 날짜로 옮겨짐)
    pub server_html: Option<String>,
}

pub fn reviews_for(conn: &Connection, date: &str) -> AppResult<Vec<CarryReviewView>> {
    if !has_schema(conn) {
        return Ok(Vec::new());
    }
    let Some(account) = active_account(conn)? else { return Ok(Vec::new()) };
    Ok(conn
        .prepare(
            "SELECT id, memo_date, kind, item_id, local_html, server_html FROM carry_reviews
              WHERE account_key = ?1 AND memo_date = ?2 AND status = 'open' ORDER BY created_at",
        )?
        .query_map(params![account, date], |r| {
            Ok(CarryReviewView {
                id: r.get(0)?,
                date: r.get(1)?,
                kind: r.get(2)?,
                item_id: r.get(3)?,
                local_html: r.get(4)?,
                server_html: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewChoice {
    /// 이 PC 의 내용(수정·삭제)을 남긴다
    Local,
    /// PLAN-A Work 쪽 내용을 남긴다
    Server,
}

/// 사용자가 고른 쪽으로 복사본 하나를 맞춘다(고르지 않은 쪽은 History 에 남는다).
pub fn resolve_review(conn: &mut Connection, review_id: &str, choice: ReviewChoice) -> AppResult<String> {
    let tx = conn.transaction()?;
    let row: (String, String, String, String, Option<String>, Option<String>) = tx
        .query_row(
            "SELECT account_key, memo_date, kind, item_id, other_item_id, server_html FROM carry_reviews WHERE id = ?1 AND status = 'open'",
            [review_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("복사본 선택"))?;
    let (account, date, kind, item_id, other, server_html) = row;
    if active_account(&tx)?.as_deref() != Some(account.as_str()) {
        return Err(AppError::new("account_mismatch", "다른 PLAN-A Work 계정의 복사본입니다. 그 계정으로 로그인한 뒤 골라주세요."));
    }
    let doc = repo::doc_for_location(&tx, &Location::Day { date: date.clone() })?.ok_or_else(|| AppError::not_found("문서"))?;
    repo::record_version(&tx, &doc.id, "carry_review")?;
    let live = repo::item_by_id(&tx, &item_id, false)?.filter(|i| i.document_id == doc.id);
    match (kind.as_str(), choice) {
        ("duplicate", ReviewChoice::Server) | ("copy_failed", ReviewChoice::Server) => soft_delete_item(&tx, &doc.id, &item_id)?,
        ("duplicate", ReviewChoice::Local) => {
            // 이미 있던 정식 복사본에 이 PC 의 수정을 옮기고, 따로 남은 임시 복사본은 뺀다.
            if let (Some(item), Some(other)) = (&live, &other) {
                set_item_content(&tx, other, &item.content_html, item.completed)?;
            }
            soft_delete_item(&tx, &doc.id, &item_id)?;
        }
        ("server_removed", ReviewChoice::Server) => soft_delete_item(&tx, &doc.id, &item_id)?,
        // 서버에서 없어진 복사본을 이 PC 에서 고친 내용 — 새 메모로 남긴다(옛 복사본을 되살리지 않는다).
        ("server_removed", ReviewChoice::Local) | ("copy_failed", ReviewChoice::Local) => unmap_item(&tx, &doc.id, &item_id)?,
        ("both_changed", ReviewChoice::Server) => match &server_html {
            Some(html) => set_item_content(&tx, &item_id, html, false)?,
            None => soft_delete_item(&tx, &doc.id, &item_id)?,
        },
        // 이 PC 의 삭제를 유지 — 다음 Push 가 서버 복사본을 지운다(살아 있으면 이 PC 내용이 그대로 서버 복사본의 수정이 된다)
        ("both_changed", ReviewChoice::Local) if live.is_none() => unmap_item(&tx, &doc.id, &item_id)?,
        _ => {}
    }
    tx.execute(
        "UPDATE carry_reviews SET status = ?2, resolved_at = ?3 WHERE id = ?1",
        params![review_id, if choice == ReviewChoice::Local { "resolved_local" } else { "resolved_server" }, now()],
    )?;
    repo::touch(&tx, &doc.id)?;
    tx.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&doc.id])?;
    tx.commit()?;
    Ok(date)
}

// ── 서버 상태 → 로컬 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct SharedDay {
    pub link_id: Option<String>,
    pub management_revision: i64,
    pub rule_version: i64,
    pub rule_timezone: Option<String>,
    pub rule_time: Option<String>,
    pub rule_offsets: Vec<i64>,
    pub rule_conflict: Option<RuleConflict>,
    pub prompt_dismissed: bool,
    pub prompt_copied_count: i64,
    pub carry_candidates: Option<Vec<i64>>,
    pub carry_auto_prompt: Option<bool>,
    pub carry_checked_at: Option<String>,
}

/// 알림 설정 충돌 — 서버 현재 설정과 이 PC 의 제안(둘 다 보관, 사용자가 고른다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleConflict {
    pub current: RuleDto,
    pub proposed: ProposedRule,
    /// 처음 연결할 때 양쪽 설정이 달랐다(409 가 아니라 첫 비교)
    #[serde(default)]
    pub initial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedRule {
    pub timezone: String,
    pub local_time: String,
    pub days_before: Vec<i64>,
}

pub fn shared_day(conn: &Connection, account_key: &str, date: &str) -> AppResult<Option<SharedDay>> {
    Ok(conn
        .query_row(
            "SELECT link_id, management_revision, rule_version, rule_timezone, rule_time, rule_offsets, rule_conflict_json,
                    prompt_dismissed, prompt_copied_count, carry_candidates_json, carry_auto_prompt, carry_checked_at
               FROM shared_days WHERE account_key = ?1 AND memo_date = ?2",
            params![account_key, date],
            |r| {
                Ok(SharedDay {
                    link_id: r.get(0)?,
                    management_revision: r.get(1)?,
                    rule_version: r.get(2)?,
                    rule_timezone: r.get(3)?,
                    rule_time: r.get(4)?,
                    rule_offsets: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                    rule_conflict: r.get::<_, Option<String>>(6)?.and_then(|j| serde_json::from_str(&j).ok()),
                    prompt_dismissed: r.get::<_, i64>(7)? == 1,
                    prompt_copied_count: r.get(8)?,
                    carry_candidates: r.get::<_, Option<String>>(9)?.and_then(|j| serde_json::from_str(&j).ok()),
                    carry_auto_prompt: r.get::<_, Option<i64>>(10)?.map(|v| v == 1),
                    carry_checked_at: r.get(11)?,
                })
            },
        )
        .optional()?)
}

fn ensure_shared_day(conn: &Connection, account_key: &str, date: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO shared_days (account_key, memo_date, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(account_key, memo_date) DO NOTHING",
        params![account_key, date, now()],
    )?;
    Ok(())
}

fn store_rule(conn: &Connection, account_key: &str, date: &str, rule: &RuleDto) -> AppResult<()> {
    ensure_shared_day(conn, account_key, date)?;
    conn.execute(
        "UPDATE shared_days SET rule_version = ?3, rule_timezone = ?4, rule_time = ?5, rule_offsets = ?6, updated_at = ?7
          WHERE account_key = ?1 AND memo_date = ?2",
        params![account_key, date, rule.version, rule.timezone, rule.local_time, serde_json::to_string(&rule.days_before)?, now()],
    )?;
    Ok(())
}

fn set_rule_conflict(conn: &Connection, account_key: &str, date: &str, conflict: Option<&RuleConflict>) -> AppResult<()> {
    ensure_shared_day(conn, account_key, date)?;
    conn.execute(
        "UPDATE shared_days SET rule_conflict_json = ?3, updated_at = ?4 WHERE account_key = ?1 AND memo_date = ?2",
        params![account_key, date, conflict.map(serde_json::to_string).transpose()?, now()],
    )?;
    Ok(())
}

fn mark_stale(conn: &Connection, account_key: &str, date: &str) -> AppResult<()> {
    ensure_shared_day(conn, account_key, date)?;
    conn.execute("UPDATE shared_days SET state_stale = 1 WHERE account_key = ?1 AND memo_date = ?2", params![account_key, date])?;
    Ok(())
}

/// 서버 UTC 시각 → 이 PC 의 로컬 시각.
fn utc_to_local(value: &str) -> Option<NaiveDateTime> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|t| t.with_timezone(&chrono::Local).naive_local())
}

#[derive(Debug, Clone)]
struct LocalOccurrence {
    offset_days: i64,
    scheduled_at: Option<String>,
    closed: bool,
}

fn local_occurrences(conn: &Connection, account_key: &str, date: &str) -> AppResult<Vec<LocalOccurrence>> {
    Ok(conn
        .prepare(
            "SELECT offset_days, scheduled_at, state, acknowledged_at, local_ack_at FROM shared_occurrences
              WHERE account_key = ?1 AND memo_date = ?2",
        )?
        .query_map(params![account_key, date], |r| {
            let state: String = r.get(2)?;
            let acked: Option<String> = r.get(3)?;
            let local_ack: Option<String> = r.get(4)?;
            Ok(LocalOccurrence {
                offset_days: r.get(0)?,
                scheduled_at: r.get(1)?,
                closed: matches!(state.as_str(), "acknowledged" | "cancelled" | "missed") || acked.is_some() || local_ack.is_some(),
            })
        })?
        .collect::<Result<_, _>>()?)
}

/// 서버 설정(또는 이 PC 의 제안)으로 그 날짜의 Windows 예약 행을 다시 쓴다. 서버 발생 시각이 있으면 그 시각(UTC → 로컬)을 쓴다.
fn write_shared_schedule(
    conn: &Connection,
    account_key: &str,
    date: &str,
    offsets: &[i64],
    time: &str,
    use_server_times: bool,
    now_local: NaiveDateTime,
) -> AppResult<()> {
    let day = reminders::parse_date(date)?;
    let at = reminders::parse_time(time).unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).unwrap());
    let occurrences = local_occurrences(conn, account_key, date)?;
    let entries: Vec<reminders::ScheduleEntry> = reminders::OFFSETS
        .iter()
        .filter(|o| offsets.contains(o))
        .map(|offset| {
            let occ = occurrences.iter().find(|o| o.offset_days == *offset);
            let when = occ
                .filter(|_| use_server_times)
                .and_then(|o| o.scheduled_at.as_deref())
                .and_then(utc_to_local)
                .unwrap_or_else(|| reminders::fire_at(day, *offset, at));
            (*offset, when, occ.map(|o| o.closed).unwrap_or(false))
        })
        .collect();
    reminders::write_schedule(conn, date, time, &entries, now_local)
}

fn has_rule_in_flight(conn: &Connection, account_key: &str, date: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM management_outbox WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule' AND status = 'pending')",
        params![account_key, date],
        |r| r.get(0),
    )?)
}

fn adopt_rule(conn: &Connection, account_key: &str, date: &str, rule: &RuleDto, now_local: NaiveDateTime) -> AppResult<()> {
    store_rule(conn, account_key, date, rule)?;
    let time = rule.local_time.clone().unwrap_or_else(|| reminders::DEFAULT_TIME.to_string());
    write_shared_schedule(conn, account_key, date, &rule.days_before, &time, true, now_local)
}

/// 날짜의 서버 관리 상태 전체를 로컬에 반영한다(호출자 transaction — cursor 와 함께 commit).
///
/// * 처음 받는 날짜(이 PC 에 그 날짜 상태가 없음): 이 PC 의 기존 알림 설정과 비교 — 이 PC 설정 없음 → 서버 설정,
///   서버 설정 없음(version 0) → 이 PC 설정을 base 0 으로 보냄, 같음 → 쓰기 없이 맞춤, 다름 → 둘 다 보관하고 사용자가 고른다.
/// * 이 PC 의 알림 제안을 보내는 중·충돌 선택 대기 → 이 PC 예약은 그대로(서버값은 비교용으로만 보관).
/// * 다른 곳에서 건너뛴 복사 안내 → 이 PC 에서도 다시 안내하지 않는다.
/// * 다른 곳에서 확인·취소된 알림 → 띄우지 않고, 이 PC 가 띄운 같은 알림은 거둔다.
pub fn apply_state(
    conn: &Connection,
    account_key: &str,
    date: &str,
    link_id: &str,
    state: &ManagementState,
    now_local: NaiveDateTime,
) -> AppResult<()> {
    let existing = shared_day(conn, account_key, date)?;
    // 처음 받는 상태인가 — 행은 복사·설정 명령 결과로 먼저 생길 수 있으므로 '전체 상태를 받은 적' 으로 판단한다.
    let initial: bool = conn
        .query_row(
            "SELECT state_json IS NULL FROM shared_days WHERE account_key = ?1 AND memo_date = ?2",
            params![account_key, date],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(true);
    ensure_shared_day(conn, account_key, date)?;
    conn.execute(
        "UPDATE shared_days SET link_id = ?3, management_revision = ?4, prompt_dismissed = ?5, prompt_copied_count = ?6,
                state_json = ?7, state_stale = 0, updated_at = ?8
          WHERE account_key = ?1 AND memo_date = ?2",
        params![
            account_key,
            date,
            link_id,
            state.management_revision,
            state.prompt.dismissed as i64,
            state.prompt.copied_count,
            serde_json::to_string(state)?,
            now()
        ],
    )?;
    if state.prompt.dismissed {
        // 다른 곳에서 건너뛰었다 — 이 PC 도 다시 저절로 안내하지 않는다(일부를 가져온 기록은 그대로).
        let source = state.prompt.source_date.clone().unwrap_or(crate::memo::carryover::source_date_of(date)?);
        conn.execute(
            "INSERT INTO carryover_prompts (target_date, source_date, status, created_at, updated_at) VALUES (?1, ?2, 'skipped', ?3, ?3)
             ON CONFLICT(target_date) DO UPDATE SET status = CASE WHEN status = 'imported' THEN status ELSE 'skipped' END,
                 updated_at = excluded.updated_at",
            params![date, source, now()],
        )?;
    }

    // 발생(occurrence) — 서버 id 그대로. 이 PC 의 확인(보내는 중)은 지우지 않는다.
    let ts = now();
    let mut seen: Vec<i64> = Vec::new();
    for occ in &state.occurrences {
        if !RULE_OFFSETS.contains(&occ.days_before) {
            continue;
        }
        seen.push(occ.days_before);
        // 같은 offset 에 다른 id 가 왔다(다른 namespace 등) — 그 offset 행을 바꾼다.
        conn.execute(
            "DELETE FROM shared_occurrences WHERE account_key = ?1 AND occurrence_id = ?2 AND NOT (memo_date = ?3 AND offset_days = ?4)",
            params![account_key, occ.id, date, occ.days_before],
        )?;
        conn.execute(
            "INSERT INTO shared_occurrences (account_key, memo_date, offset_days, occurrence_id, scheduled_at, state, delivery_status,
                                             acknowledged_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(account_key, memo_date, offset_days) DO UPDATE SET
                 local_ack_at = CASE WHEN shared_occurrences.occurrence_id = excluded.occurrence_id THEN shared_occurrences.local_ack_at ELSE NULL END,
                 occurrence_id = excluded.occurrence_id, scheduled_at = excluded.scheduled_at, state = excluded.state,
                 delivery_status = excluded.delivery_status, acknowledged_at = excluded.acknowledged_at, updated_at = excluded.updated_at",
            params![account_key, date, occ.days_before, occ.id, occ.scheduled_at, occ.state, occ.delivery_status, occ.acknowledged_at, ts],
        )?;
    }
    let stale: Vec<i64> = conn
        .prepare("SELECT offset_days FROM shared_occurrences WHERE account_key = ?1 AND memo_date = ?2")?
        .query_map(params![account_key, date], |r| r.get(0))?
        .collect::<Result<Vec<i64>, _>>()?
        .into_iter()
        .filter(|o| !seen.contains(o))
        .collect();
    for offset in stale {
        conn.execute(
            "DELETE FROM shared_occurrences WHERE account_key = ?1 AND memo_date = ?2 AND offset_days = ?3 AND local_ack_at IS NULL",
            params![account_key, date, offset],
        )?;
    }

    // 알림 설정
    let rule = &state.rule;
    let in_flight = has_rule_in_flight(conn, account_key, date)?;
    let conflict = existing.as_ref().and_then(|e| e.rule_conflict.clone());
    if initial && in_flight {
        // 이 PC 의 설정을 이미 보내는 중이다 — 첫 비교 대신 그 결과(저장 또는 409 선택)를 따른다. 예약은 그대로.
        store_rule(conn, account_key, date, rule)?;
    } else if initial {
        let local = reminders::get(conn, date)?;
        match local {
            None => adopt_rule(conn, account_key, date, rule, now_local)?,
            Some(local) => {
                let proposed =
                    ProposedRule { timezone: local_timezone(), local_time: local.time.clone(), days_before: local.offsets.clone() };
                if rule.version == 0 {
                    // 서버에 설정이 없다 — 이 PC 설정을 base 0 으로 보낸다(이 PC 예약은 그대로).
                    store_rule(conn, account_key, date, rule)?;
                    if !local.offsets.is_empty() {
                        insert_op(
                            conn,
                            account_key,
                            date,
                            "rule",
                            &RulePayload {
                                base_version: Some(0),
                                timezone: proposed.timezone,
                                local_time: proposed.local_time,
                                days_before: proposed.days_before,
                                rebuilds: 0,
                            },
                        )?;
                    }
                } else if same_rule(rule, &proposed) {
                    adopt_rule(conn, account_key, date, rule, now_local)?;
                } else {
                    store_rule(conn, account_key, date, rule)?;
                    set_rule_conflict(conn, account_key, date, Some(&RuleConflict { current: rule.clone(), proposed, initial: true }))?;
                }
            }
        }
    } else if let Some(mut conflict) = conflict {
        // 사용자 선택을 기다린다 — 서버 최신값만 비교용으로 바꾼다(이 PC 예약 유지).
        store_rule(conn, account_key, date, rule)?;
        if rule.version >= conflict.current.version {
            conflict.current = rule.clone();
            if same_rule(rule, &conflict.proposed) {
                // 다른 곳에서 같은 설정으로 맞춰졌다 — 고를 것이 없다.
                set_rule_conflict(conn, account_key, date, None)?;
                adopt_rule(conn, account_key, date, rule, now_local)?;
            } else {
                set_rule_conflict(conn, account_key, date, Some(&conflict))?;
            }
        }
    } else if in_flight {
        // 이 PC 의 제안을 보내는 중 — 이 PC 예약 유지, 확인·취소 상태만 반영.
        if let Some(local) = reminders::get(conn, date)? {
            write_shared_schedule(conn, account_key, date, &local.offsets, &local.time, false, now_local)?;
        }
    } else {
        adopt_rule(conn, account_key, date, rule, now_local)?;
    }

    withdraw_closed_toasts(conn, account_key, date)?;
    Ok(())
}

fn same_rule(rule: &RuleDto, proposed: &ProposedRule) -> bool {
    let mut a = rule.days_before.clone();
    let mut b = proposed.days_before.clone();
    a.sort();
    b.sort();
    if a != b {
        return false;
    }
    // 둘 다 알림 없음이면 시각은 상관없다.
    a.is_empty() || rule.local_time.as_deref() == Some(proposed.local_time.as_str())
}

/// 서버가 알려 준 복사 후보(아직 복사하지 않은 원본 서버 id) 를 보관한다.
pub fn apply_candidates(conn: &Connection, account_key: &str, date: &str, candidates: &CarryCandidates) -> AppResult<()> {
    ensure_shared_day(conn, account_key, date)?;
    let ids: Vec<i64> = candidates.items.iter().map(|i| i.id).collect();
    conn.execute(
        "UPDATE shared_days SET carry_candidates_json = ?3, carry_auto_prompt = ?4, carry_checked_at = ?5,
                prompt_dismissed = MAX(prompt_dismissed, ?6), updated_at = ?5
          WHERE account_key = ?1 AND memo_date = ?2",
        params![account_key, date, serde_json::to_string(&ids)?, candidates.auto_prompt as i64, now(), candidates.dismissed as i64],
    )?;
    if candidates.dismissed {
        let source = crate::memo::carryover::source_date_of(date)?;
        conn.execute(
            "INSERT INTO carryover_prompts (target_date, source_date, status, created_at, updated_at) VALUES (?1, ?2, 'skipped', ?3, ?3)
             ON CONFLICT(target_date) DO UPDATE SET status = CASE WHEN status = 'imported' THEN status ELSE 'skipped' END,
                 updated_at = excluded.updated_at",
            params![date, source, now()],
        )?;
    }
    Ok(())
}

/// 지난 미완료 가져오기 화면에 쓸 서버 정보(연결된 날짜).
pub struct CarryFilter {
    pub account_key: String,
    /// 서버가 아직 복사할 수 있다고 한 원본 서버 id(조회한 적 없으면 None)
    pub candidates: Option<HashSet<i64>>,
    pub dismissed: bool,
    pub server_auto_prompt: Option<bool>,
}

pub fn carry_filter(conn: &Connection, date: &str) -> AppResult<Option<CarryFilter>> {
    let DayScope::Shared { account_key, .. } = day_scope(conn, date)? else { return Ok(None) };
    let day = shared_day(conn, &account_key, date)?.unwrap_or_default();
    Ok(Some(CarryFilter {
        candidates: day.carry_candidates.map(|c| c.into_iter().collect()),
        dismissed: day.prompt_dismissed,
        server_auto_prompt: day.carry_auto_prompt,
        account_key,
    }))
}

/// 원본 항목의 서버 id(원본 날짜가 이 계정으로 연결돼 있을 때).
pub fn source_server_id(conn: &Connection, account_key: &str, source_date: &str, item_id: &str) -> AppResult<Option<i64>> {
    let Some(doc) = repo::doc_for_location(conn, &Location::Day { date: source_date.to_string() })? else { return Ok(None) };
    if !doc.sync_enabled || link::link_row(conn, &doc.id)?.and_then(|l| l.account_key).as_deref() != Some(account_key) {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT server_item_id FROM sync_item_map WHERE document_id = ?1 AND item_id = ?2 AND account_key = ?3",
            params![doc.id, item_id, account_key],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

// ── 알림 설정(Desktop 에서) ─────────────────────────────────────────────

/// 연결된 날짜의 알림 설정 저장 — 이 PC 예약에 바로 반영하고(오프라인에서도), 서버 공통 설정 변경을 Outbox 에 남긴다.
/// 기준 version 은 이 PC 가 마지막으로 본 서버 version — 그 사이 다른 곳에서 바뀌었으면 서버가 409 로 알려 준다.
pub fn propose_rule(
    conn: &mut Connection,
    account_key: &str,
    date: &str,
    offsets: &[i64],
    time: &str,
    now_local: NaiveDateTime,
) -> AppResult<()> {
    let (day, at) = reminders::validate_rule(date, offsets, time)?;
    let tx = conn.transaction()?;
    let current = shared_day(&tx, account_key, date)?.unwrap_or_default();
    let fields = ProposedRule { timezone: local_timezone(), local_time: time.to_string(), days_before: ordered(offsets) };
    // 충돌 선택 중에 새로 저장 = '내 설정' — 서버 현재 version 위에 보낸다.
    let base = match &current.rule_conflict {
        Some(conflict) => {
            set_rule_conflict(&tx, account_key, date, None)?;
            conflict.current.version
        }
        None => current.rule_version,
    };
    queue_rule(&tx, account_key, date, base, &fields)?;
    // 이 PC 예약 — 이미 확인·취소된 발생은 다시 띄우지 않는다.
    let occurrences = local_occurrences(&tx, account_key, date)?;
    let entries: Vec<reminders::ScheduleEntry> = reminders::local_entries(day, offsets, at)
        .into_iter()
        .map(|(o, when, _)| (o, when, occurrences.iter().any(|x| x.offset_days == o && x.closed)))
        .collect();
    reminders::write_schedule(&tx, date, time, &entries, now_local)?;
    tx.commit()?;
    Ok(())
}

fn ordered(offsets: &[i64]) -> Vec<i64> {
    reminders::OFFSETS.iter().filter(|o| offsets.contains(o)).copied().collect()
}

/// 알림 설정 명령을 남긴다. 아직 한 번도 보내지 않은 같은 날짜 명령이 있으면 그 내용을 바꾼다(기준 version 유지).
/// 이미 보낸(응답 미확인) 명령이 있으면 그 뒤에 이어 보낸다(앞 명령의 결과 version 위에).
fn queue_rule(conn: &Connection, account_key: &str, date: &str, base: i64, fields: &ProposedRule) -> AppResult<()> {
    let unsent: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, payload_json FROM management_outbox
              WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule' AND status = 'pending' AND sent_at IS NULL
              ORDER BY id DESC LIMIT 1",
            params![account_key, date],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let sent_pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM management_outbox WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule' AND status = 'pending' AND sent_at IS NOT NULL)",
        params![account_key, date],
        |r| r.get(0),
    )?;
    let payload = |base_version: Option<i64>| RulePayload {
        base_version,
        timezone: fields.timezone.clone(),
        local_time: fields.local_time.clone(),
        days_before: fields.days_before.clone(),
        rebuilds: 0,
    };
    match unsent {
        Some((id, json)) => {
            let previous: RulePayload = serde_json::from_str(&json)?;
            conn.execute(
                "UPDATE management_outbox SET payload_json = ?2, request_id = ?3, body_json = NULL, attempts = 0, next_attempt_at = NULL,
                        last_error = NULL, updated_at = ?4 WHERE id = ?1",
                params![id, serde_json::to_string(&payload(previous.base_version))?, new_id(), now()],
            )?;
        }
        None => {
            insert_op(conn, account_key, date, "rule", &payload(if sent_pending { None } else { Some(base) }))?;
        }
    }
    // 앞선 충돌 결과(사용자 선택 대기)가 있던 명령은 이 제안으로 대체되었다.
    conn.execute(
        "UPDATE management_outbox SET status = 'dropped', last_error = 'superseded', updated_at = ?3
          WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule' AND status = 'conflict'",
        params![account_key, date, now()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleChoice {
    /// PLAN-A Work(서버)의 현재 설정을 쓴다
    Server,
    /// 이 PC 의 설정을 쓴다(서버 현재 version 위에 다시 보낸다 — 그 사이 또 바뀌었으면 다시 묻는다)
    Mine,
}

pub fn resolve_rule_conflict(conn: &mut Connection, date: &str, choice: RuleChoice, now_local: NaiveDateTime) -> AppResult<()> {
    let tx = conn.transaction()?;
    let account = active_account(&tx)?.ok_or_else(|| AppError::new("auth_required", "PLAN-A Work 에 로그인한 뒤 골라주세요."))?;
    let day = shared_day(&tx, &account, date)?.ok_or_else(|| AppError::not_found("알림 설정"))?;
    let conflict = day.rule_conflict.ok_or_else(|| AppError::new("conflict_resolved", "이미 정리된 알림 설정입니다."))?;
    set_rule_conflict(&tx, &account, date, None)?;
    match choice {
        RuleChoice::Server => {
            tx.execute(
                "UPDATE management_outbox SET status = 'dropped', last_error = 'user_chose_server', updated_at = ?3
                  WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule' AND status IN ('pending', 'conflict') AND sent_at IS NULL",
                params![account, date, now()],
            )?;
            adopt_rule(&tx, &account, date, &conflict.current, now_local)?;
        }
        RuleChoice::Mine => {
            queue_rule(&tx, &account, date, conflict.current.version, &conflict.proposed)?;
            let (d, at) = reminders::validate_rule(date, &conflict.proposed.days_before, &conflict.proposed.local_time)?;
            let occurrences = local_occurrences(&tx, &account, date)?;
            let entries: Vec<reminders::ScheduleEntry> = reminders::local_entries(d, &conflict.proposed.days_before, at)
                .into_iter()
                .map(|(o, when, _)| (o, when, occurrences.iter().any(|x| x.offset_days == o && x.closed)))
                .collect();
            reminders::write_schedule(&tx, date, &conflict.proposed.local_time, &entries, now_local)?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ── 알림 확인(ACK) ──────────────────────────────────────────────────────

/// 연결된 날짜의 발생 상태(offset → (서버 상태, 확인했는가)) — 화면 표시용. 지금 계정만.
pub fn fire_states(conn: &Connection, date: &str) -> AppResult<HashMap<i64, (String, bool)>> {
    let mut out = HashMap::new();
    if !has_schema(conn) {
        return Ok(out);
    }
    let Some(account) = shared_account_for(conn, date)? else { return Ok(out) };
    let rows: Vec<(i64, String, Option<String>, Option<String>)> = conn
        .prepare(
            "SELECT offset_days, state, acknowledged_at, local_ack_at FROM shared_occurrences WHERE account_key = ?1 AND memo_date = ?2",
        )?
        .query_map(params![account, date], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    for (offset, state, acked, local) in rows {
        let ack = state == "acknowledged" || acked.is_some() || local.is_some();
        out.insert(offset, (if local.is_some() && state != "acknowledged" { "acknowledged".to_string() } else { state }, ack));
    }
    Ok(out)
}

/// 이 알림(날짜·offset)을 띄우지 말아야 하는가.
/// * 다른 계정(또는 해제된 이전 기기 등록)으로 연결된 날짜의 공통 알림
/// * 서버에서(또는 이 PC 에서) 이미 확인·취소·놓침 처리된 발생
pub fn reminder_suppressed(conn: &Connection, date: &str, offset_days: i64) -> AppResult<bool> {
    if !has_schema(conn) {
        return Ok(false);
    }
    let Some(doc) = repo::doc_for_location(conn, &Location::Day { date: date.to_string() })? else { return Ok(false) };
    if !doc.sync_enabled {
        return Ok(false);
    }
    let link_account = link::link_row(conn, &doc.id)?.and_then(|l| l.account_key);
    let active = active_account(conn)?;
    // 공통 상태를 받은 계정의 연결인데 지금 계정이 아니다 → 띄우지 않는다.
    if let Some(link_account) = &link_account {
        let has_shared: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM shared_days WHERE account_key = ?1 AND memo_date = ?2)",
            params![link_account, date],
            |r| r.get(0),
        )?;
        if active.as_deref() != Some(link_account.as_str()) {
            return Ok(has_shared);
        }
        let closed: Option<bool> = conn
            .query_row(
                "SELECT state IN ('acknowledged', 'cancelled', 'missed') OR acknowledged_at IS NOT NULL OR local_ack_at IS NOT NULL
                   FROM shared_occurrences WHERE account_key = ?1 AND memo_date = ?2 AND offset_days = ?3",
                params![link_account, date, offset_days],
                |r| r.get(0),
            )
            .optional()?;
        return Ok(closed.unwrap_or(false));
    }
    Ok(false)
}

/// 연결된 날짜의 알림을 띄울 때 — 누를 때 쓸 일회용 token(서버 id 를 알림 주소에 넣지 않는다). Local-only 는 None.
pub fn issue_toast_token(conn: &Connection, date: &str, offsets: &[i64]) -> AppResult<Option<String>> {
    if !has_schema(conn) {
        return Ok(None);
    }
    let Some(account) = shared_account_for(conn, date)? else { return Ok(None) };
    let ids: Vec<String> = offsets
        .iter()
        .filter_map(|o| {
            conn.query_row(
                "SELECT occurrence_id FROM shared_occurrences WHERE account_key = ?1 AND memo_date = ?2 AND offset_days = ?3",
                params![account, date, o],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
        })
        .collect();
    if ids.is_empty() {
        return Ok(None);
    }
    let token = new_id().replace('-', "");
    conn.execute(
        "INSERT INTO reminder_toasts (token, account_key, tag, dates_json, occurrences_json, shown_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![token, account, date, serde_json::to_string(&[date])?, serde_json::to_string(&ids)?, now()],
    )?;
    Ok(Some(token))
}

/// 알림 주소의 token 형식(32자리 hex).
pub fn valid_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Windows 알림을 눌렀다(사용자의 명시적 확인) — 그 알림이 알린 발생을 확인한다. 같은 알림을 여러 번 눌러도 한 번만.
/// 다른 계정의 token · 모르는 token 은 무시한다(임의 주소로 다른 사람의 상태를 바꿀 수 없다). 처리한 날짜를 돌려준다.
pub fn confirm_token(conn: &mut Connection, token: &str) -> AppResult<Option<String>> {
    if !has_schema(conn) || !valid_token(token) {
        return Ok(None);
    }
    let tx = conn.transaction()?;
    let row: Option<(Option<String>, String, String, Option<String>)> = tx
        .query_row("SELECT account_key, dates_json, occurrences_json, used_at FROM reminder_toasts WHERE token = ?1", [token], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?;
    let Some((account, dates, ids, used)) = row else { return Ok(None) };
    let date = serde_json::from_str::<Vec<String>>(&dates)?.into_iter().next();
    if used.is_some() {
        return Ok(date);
    }
    let active = active_account(&tx)?;
    if account.is_none() || account != active {
        return Ok(date);
    }
    let account = account.unwrap_or_default();
    tx.execute("UPDATE reminder_toasts SET used_at = ?2 WHERE token = ?1", params![token, now()])?;
    let ids: Vec<String> = serde_json::from_str(&ids)?;
    for id in ids {
        queue_ack_by_id(&tx, &account, &id)?;
    }
    tx.commit()?;
    Ok(date)
}

/// (날짜, offset, 서버 상태, 서버 확인 시각, 이 PC 확인 시각)
type OccurrenceRow = (String, i64, String, Option<String>, Option<String>);

fn queue_ack_by_id(conn: &Connection, account_key: &str, occurrence_id: &str) -> AppResult<bool> {
    let row: Option<OccurrenceRow> = conn
        .query_row(
            "SELECT memo_date, offset_days, state, acknowledged_at, local_ack_at FROM shared_occurrences
              WHERE account_key = ?1 AND occurrence_id = ?2",
            params![account_key, occurrence_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((date, offset, state, acked, local)) = row else { return Ok(false) };
    if state == "acknowledged" || acked.is_some() || local.is_some() {
        return Ok(false); // 이미 확인 — ACK 를 또 쌓지 않는다
    }
    conn.execute(
        "UPDATE shared_occurrences SET local_ack_at = ?3, updated_at = ?3 WHERE account_key = ?1 AND occurrence_id = ?2",
        params![account_key, occurrence_id, now()],
    )?;
    // ACK 는 화면을 닫기 전에 request_id 와 함께 영속 저장한다(오프라인이어도 다시 확인하지 않게).
    insert_op(conn, account_key, &date, "ack", &AckPayload { occurrence_id: occurrence_id.to_string(), offset_days: offset, rebuilds: 0 })?;
    Ok(true)
}

/// 화면에서 그 날짜의 알림을 명시적으로 확인했다(놓친 알림 안내에서 날짜 열기 등) — 시각이 지난 발생만.
/// 날짜를 열기만 한 것은 확인이 아니다(호출하지 않는다).
pub fn confirm_date(conn: &mut Connection, date: &str, now_utc: chrono::DateTime<chrono::Utc>) -> AppResult<usize> {
    if !has_schema(conn) {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    let Some(account) = shared_account_for(&tx, date)? else { return Ok(0) };
    let due: Vec<(String, Option<String>)> = tx
        .prepare("SELECT occurrence_id, scheduled_at FROM shared_occurrences WHERE account_key = ?1 AND memo_date = ?2")?
        .query_map(params![account, date], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut n = 0;
    for (id, scheduled) in due {
        let is_due = scheduled
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&chrono::Utc) <= now_utc)
            .unwrap_or(false);
        if is_due && queue_ack_by_id(&tx, &account, &id)? {
            n += 1;
        }
    }
    tx.commit()?;
    Ok(n)
}

/// 다른 곳에서 확인·취소된 발생만 알린 이 PC 의 Windows 알림 → 화면에서 거둘 차례로 표시.
fn withdraw_closed_toasts(conn: &Connection, account_key: &str, date: &str) -> AppResult<()> {
    let rows: Vec<(String, String)> = conn
        .prepare(
            "SELECT token, occurrences_json FROM reminder_toasts
              WHERE account_key = ?1 AND tag = ?2 AND used_at IS NULL AND withdraw = 0 AND withdrawn_at IS NULL",
        )?
        .query_map(params![account_key, date], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (token, ids) in rows {
        let ids: Vec<String> = serde_json::from_str(&ids).unwrap_or_default();
        let mut all_closed = !ids.is_empty();
        for id in &ids {
            let closed: Option<bool> = conn
                .query_row(
                    "SELECT state IN ('acknowledged', 'cancelled') OR acknowledged_at IS NOT NULL
                       FROM shared_occurrences WHERE account_key = ?1 AND occurrence_id = ?2",
                    params![account_key, id],
                    |r| r.get(0),
                )
                .optional()?;
            all_closed &= closed.unwrap_or(true);
        }
        if all_closed {
            conn.execute("UPDATE reminder_toasts SET withdraw = 1 WHERE token = ?1", [&token])?;
        }
    }
    Ok(())
}

/// 거둘 Windows 알림(tag) 목록.
pub fn pending_withdrawals(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    if !has_schema(conn) {
        return Ok(Vec::new());
    }
    Ok(conn
        .prepare("SELECT token, tag FROM reminder_toasts WHERE withdraw = 1 AND withdrawn_at IS NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?)
}

pub fn mark_withdrawn(conn: &Connection, token: &str) -> AppResult<()> {
    conn.execute("UPDATE reminder_toasts SET withdrawn_at = ?2 WHERE token = ?1", params![token, now()])?;
    Ok(())
}

// ── 화면용 요약 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementDayView {
    /// local | shared | unavailable | checking | other_account
    pub mode: &'static str,
    pub blocked_reason: Option<String>,
    pub reminder_conflict: Option<RuleConflict>,
    /// 이 PC 의 알림 설정 변경을 아직 PLAN-A Work 가 확정하지 않았다(보내는 중)
    pub reminder_pending: bool,
    pub reviews: Vec<CarryReviewView>,
}

pub fn day_view(conn: &Connection, date: &str) -> AppResult<ManagementDayView> {
    let scope = day_scope(conn, date)?;
    let mode = match &scope {
        DayScope::Local => "local",
        DayScope::Shared { .. } => "shared",
        DayScope::Unavailable => "unavailable",
        DayScope::Checking => "checking",
        DayScope::OtherAccount => "other_account",
    };
    let (conflict, pending) = match &scope {
        DayScope::Shared { account_key, .. } => {
            (shared_day(conn, account_key, date)?.and_then(|d| d.rule_conflict), has_rule_in_flight(conn, account_key, date)?)
        }
        _ => (None, false),
    };
    Ok(ManagementDayView {
        mode,
        blocked_reason: scope.blocked_reason().map(str::to_string),
        reminder_conflict: conflict,
        reminder_pending: pending,
        reviews: if scope.is_shared() { reviews_for(conn, date)? } else { Vec::new() },
    })
}

// ── Engine: 서버와 주고받기 ───────────────────────────────────────────────

/// 한 명령의 실패를 어떻게 다룰지.
enum OpError {
    Transport(TransportError),
    App(AppError),
}

impl From<TransportError> for OpError {
    fn from(e: TransportError) -> Self {
        OpError::Transport(e)
    }
}
impl From<AppError> for OpError {
    fn from(e: AppError) -> Self {
        OpError::App(e)
    }
}
impl From<rusqlite::Error> for OpError {
    fn from(e: rusqlite::Error) -> Self {
        OpError::App(e.into())
    }
}
impl From<serde_json::Error> for OpError {
    fn from(e: serde_json::Error) -> Self {
        OpError::App(e.into())
    }
}

fn is_link_problem(error: &TransportError) -> bool {
    matches!(error, TransportError::Conflict { code } if code.starts_with("link_") || code == "stale_link")
}

fn day_link(conn: &Connection, account_key: &str, date: &str) -> AppResult<Option<(String, Option<String>)>> {
    let Some(doc) = repo::doc_for_location(conn, &Location::Day { date: date.to_string() })? else { return Ok(None) };
    if !doc.sync_enabled {
        return Ok(None);
    }
    let Some(link) = link::link_row(conn, &doc.id)? else { return Ok(None) };
    if link.account_key.as_deref() != Some(account_key) {
        return Ok(None);
    }
    Ok(Some((doc.id, link.link_id)))
}

/// 보낼 차례가 된 명령 하나의 결과.
enum Sent {
    Done,
    /// 아직 보낼 수 없다(연결 진행 중·원본 매핑 대기) — 시도 횟수를 늘리지 않는다
    Wait,
}

/// 오프라인 등으로 이번 실행의 관리 명령 전송을 멈춰야 하는가.
fn stops(error: &TransportError) -> bool {
    matches!(
        error,
        TransportError::Offline
            | TransportError::Network(_)
            | TransportError::RateLimited
            | TransportError::AuthRequired
            | TransportError::Unavailable
            | TransportError::EndpointMissing
    )
}

impl SyncEngine {
    /// 서버가 v2 공통 관리를 지원하는가(계정별, 캐시). 확인할 차례가 아니면 저장된 값.
    /// `recheck_unavailable` — 사용자가 [지금 동기화] 를 눌렀다: '미지원' 캐시는 바로 다시 확인한다(서버가 막 켜졌을 수 있다).
    pub async fn management_capability(&self, storage: &Storage, ctx: &SyncContext, recheck_unavailable: bool) -> AppResult<Capability> {
        let (stale, cached) = storage.with_conn(|c| Ok((capability_stale(c, &ctx.account_key)?, capability(c, &ctx.account_key)?)))?;
        if !stale && !(recheck_unavailable && cached == Capability::Unavailable) {
            return Ok(cached);
        }
        match self.transport.v2_capabilities(ctx).await {
            Ok(caps) => {
                let ok = caps.supports_shared_management();
                storage.with_conn(|c| set_capability(c, &ctx.account_key, ok))?;
                Ok(if ok { Capability::Available } else { Capability::Unavailable })
            }
            Err(TransportError::NotFound | TransportError::EndpointMissing | TransportError::Unavailable) => {
                storage.with_conn(|c| set_capability(c, &ctx.account_key, false))?;
                Ok(Capability::Unavailable)
            }
            Err(error) => {
                log::info!("memo-sync v2 capability check deferred: {}", super::http::error_kind(&error));
                if matches!(error, TransportError::AuthRequired) {
                    self.auth.mark_expired();
                }
                Ok(cached)
            }
        }
    }

    /// ① 관리 명령 보내기 — 확인(ACK) → 복사 → 건너뛰기 → 알림 설정 순서. 복사는 같은 날짜 본문 Push 보다 먼저다.
    pub async fn management_outbox_phase(
        &self,
        storage: &Storage,
        ctx: &SyncContext,
        force: bool,
        report: &mut SyncReport,
    ) -> AppResult<()> {
        let ops: Vec<OutboxOp> = storage.with_conn(|c| {
            Ok(c.prepare(&format!(
                "SELECT {OP_COLUMNS} FROM management_outbox
                  WHERE account_key = ?1 AND status = 'pending' AND (?2 = 1 OR next_attempt_at IS NULL OR next_attempt_at <= ?3)
                  ORDER BY CASE kind WHEN 'ack' THEN 0 WHEN 'carry' THEN 1 WHEN 'dismiss' THEN 2 ELSE 3 END, id"
            ))?
            .query_map(params![ctx.account_key, force as i64, now()], op_from_row)?
            .collect::<Result<_, _>>()?)
        })?;
        for op in ops {
            let outcome = match op.kind.as_str() {
                "carry" => self.send_carry(storage, ctx, &op, report).await,
                "dismiss" => self.send_dismiss(storage, ctx, &op).await,
                "rule" => self.send_rule(storage, ctx, &op, report).await,
                "ack" => self.send_ack(storage, ctx, &op).await,
                _ => Ok(Sent::Done),
            };
            match outcome {
                Ok(_) => {}
                Err(OpError::Transport(error)) if stops(&error) => {
                    match error {
                        TransportError::AuthRequired => {
                            self.auth.mark_expired();
                            report.auth_required = true;
                        }
                        TransportError::Unavailable | TransportError::EndpointMissing => {
                            storage.with_conn(|c| set_capability(c, &ctx.account_key, false))?;
                        }
                        _ => report.offline = true,
                    }
                    return Ok(());
                }
                Err(OpError::Transport(error)) => self.op_failed(storage, &op, error, report)?,
                Err(OpError::App(error)) => {
                    log::warn!("management op prepare failed: kind={} code={}", op.kind, error.code());
                    storage.with_conn(|c| backoff_op(c, &op, error.code()))?;
                }
            }
        }
        Ok(())
    }

    fn op_failed(&self, storage: &Storage, op: &OutboxOp, error: TransportError, report: &mut SyncReport) -> AppResult<()> {
        log::info!("management op failed: kind={} kind_err={}", op.kind, super::http::error_kind(&error));
        storage.with_conn(|c| {
            let tx = c.transaction()?;
            let current = op_by_id(&tx, op.id)?.unwrap_or_else(|| op.clone());
            match (op.kind.as_str(), &error) {
                // 서버 오류 — 같은 본문으로 나중에 다시(응답 유실과 같게)
                (_, TransportError::Server(_)) => backoff_op(&tx, &current, "server")?,
                ("carry", e) => {
                    let mut payload: CarryPayload = serde_json::from_str(&current.payload_json)?;
                    let code = match e {
                        TransportError::Conflict { code } => code.clone(),
                        TransportError::NotFound => "not_found".into(),
                        TransportError::Rejected { status, .. } => format!("rejected_{status}"),
                        TransportError::Forbidden => "forbidden".into(),
                        _ => "failed".into(),
                    };
                    let retryable = code == "carry_source_changed"
                        || code == "request_id_reused"
                        || code == "copy_identity_reused"
                        || code == "not_found"
                        || is_link_problem(e);
                    if retryable && payload.rebuilds < MAX_REBUILDS {
                        payload.rebuilds += 1;
                        if code == "carry_source_changed" {
                            // 원본이 서버에서 바뀌었다 — 원본 날짜를 다시 받은 뒤 최신 version 으로 다시 보낸다.
                            if let Some(source) = repo::doc_for_location(&tx, &Location::Day { date: payload.source_date.clone() })? {
                                tx.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&source.id])?;
                            }
                        }
                        if code == "copy_identity_reused" {
                            // 임시 key 를 다른 것으로(이 key 가 다른 원본·다른 항목에 이미 쓰였다)
                            let key = new_id().to_ascii_lowercase();
                            if let Some((doc_id, _)) = day_link(&tx, &op.account_key, &op.memo_date)? {
                                tx.execute(
                                    "UPDATE sync_item_map SET client_key = ?3 WHERE document_id = ?1 AND item_id = ?2",
                                    params![doc_id, payload.copy_item_id, key],
                                )?;
                            }
                            payload.local_copy_key = key;
                        }
                        rebuild_op(&tx, op.id, &serde_json::to_string(&payload)?, &code)?;
                    } else {
                        // 서버가 복사를 받지 않았다 — 이 PC 의 임시 복사본을 어떻게 할지 묻는다(자동으로 지우지 않는다).
                        finish_op(&tx, op.id, "dropped", None, Some(&code))?;
                        let live = repo::item_by_id(&tx, &payload.copy_item_id, false)?;
                        if let Some(item) = live {
                            open_review(
                                &tx,
                                &op.account_key,
                                &op.memo_date,
                                "copy_failed",
                                &item.id,
                                None,
                                None,
                                Some(&item.content_html),
                                None,
                            )?;
                            report.notices.push(NOTICE_CARRY_REVIEW.into());
                        }
                    }
                }
                ("rule", e) => {
                    let mut payload: RulePayload = serde_json::from_str(&current.payload_json)?;
                    if (is_link_problem(e) || e.is_conflict("request_id_reused")) && payload.rebuilds < MAX_REBUILDS {
                        payload.rebuilds += 1;
                        rebuild_op(&tx, op.id, &serde_json::to_string(&payload)?, "link")?;
                    } else {
                        // 서버가 받지 않는 설정(형식 등) — 서버 설정으로 되돌릴 수 있게 상태를 다시 받는다.
                        finish_op(&tx, op.id, "dropped", None, Some(super::http::error_kind(e)))?;
                        mark_stale(&tx, &op.account_key, &op.memo_date)?;
                    }
                }
                ("ack", e) => {
                    let mut payload: AckPayload = serde_json::from_str(&current.payload_json)?;
                    if e.is_conflict("occurrence_not_due") || matches!(e, TransportError::NotFound) {
                        // 아직 시각 전 · 없는 발생 — 확인을 되돌린다(때가 되면 다시 알린다).
                        finish_op(&tx, op.id, "dropped", None, Some(super::http::error_kind(e)))?;
                        tx.execute(
                            "UPDATE shared_occurrences SET local_ack_at = NULL WHERE account_key = ?1 AND occurrence_id = ?2",
                            params![op.account_key, payload.occurrence_id],
                        )?;
                    } else if (is_link_problem(e) || e.is_conflict("request_id_reused")) && payload.rebuilds < MAX_REBUILDS {
                        payload.rebuilds += 1;
                        rebuild_op(&tx, op.id, &serde_json::to_string(&payload)?, "link")?;
                    } else {
                        backoff_op(&tx, &current, super::http::error_kind(e))?;
                    }
                }
                (_, e) => {
                    if is_link_problem(e) {
                        rebuild_op(&tx, op.id, &current.payload_json, "link")?;
                    } else {
                        finish_op(&tx, op.id, "dropped", None, Some(super::http::error_kind(e)))?;
                    }
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    async fn send_carry(&self, storage: &Storage, ctx: &SyncContext, op: &OutboxOp, report: &mut SyncReport) -> Result<Sent, OpError> {
        let payload: CarryPayload = serde_json::from_str(&op.payload_json)?;
        let prepared: Option<(String, String)> = match (&op.route, &op.body_json) {
            (Some(route), Some(body)) => Some((route.clone(), body.clone())),
            _ => self.build_carry(storage, ctx, op, &payload).await?,
        };
        let Some((route, body)) = prepared else { return Ok(Sent::Wait) };
        let response = match route.as_str() {
            "carry" => self.transport.v2_carry(ctx, &op.memo_date, &serde_json::from_str::<CarryRequest>(&body)?).await?,
            _ => self.transport.v2_local_copy(ctx, &op.memo_date, &serde_json::from_str::<LocalCopyRequest>(&body)?).await?,
        };
        storage.with_conn(|c| {
            let tx = c.transaction()?;
            if let Some((doc_id, _)) = day_link(&tx, &op.account_key, &op.memo_date)? {
                for m in response.mappings.iter().filter(|m| m.local_copy_key == payload.local_copy_key) {
                    // 임시 복사본 → 서버 정식 복사본(같은 항목). item version 은 다시 받을 때 정해진다.
                    mapper::write_map(&tx, &doc_id, &payload.copy_item_id, &op.account_key, m.copied_item_id, m.client_key.as_deref(), None)?;
                }
                tx.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&doc_id])?;
                report.touched(&doc_id);
            }
            tx.execute(
                "UPDATE management_outbox SET status = 'done', result_json = ?2, reconciled = 0, last_error = NULL, updated_at = ?3 WHERE id = ?1",
                params![op.id, serde_json::to_string(&response)?, now()],
            )?;
            mark_stale(&tx, &op.account_key, &op.memo_date)?;
            tx.commit()?;
            Ok(())
        })?;
        report.management_changed = true;
        Ok(Sent::Done)
    }

    /// 복사 요청 본문을 만든다(처음 한 번 — 그 뒤로는 저장한 본문 그대로). None = 아직 보낼 수 없다.
    async fn build_carry(
        &self,
        storage: &Storage,
        ctx: &SyncContext,
        op: &OutboxOp,
        payload: &CarryPayload,
    ) -> Result<Option<(String, String)>, OpError> {
        enum Plan {
            Drop,
            Wait,
            Server { link_id: String, source_link_id: String, id: i64, version: i64 },
            Local { link_id: String },
        }
        let plan = storage.with_conn(|c| {
            let Some((_, link_id)) = day_link(c, &op.account_key, &op.memo_date)? else { return Ok(Plan::Drop) };
            let Some(link_id) = link_id else { return Ok(Plan::Wait) }; // 대상 날짜 연결이 아직 끝나지 않았다
            let source = repo::doc_for_location(c, &Location::Day { date: payload.source_date.clone() })?;
            let source_link = match &source {
                Some(doc) if doc.sync_enabled => link::link_row(c, &doc.id)?.filter(|l| l.account_key.as_deref() == Some(op.account_key.as_str())),
                _ => None,
            };
            match (source, source_link) {
                (Some(source), Some(source_link)) => {
                    let Some(source_link_id) = source_link.link_id else { return Ok(Plan::Wait) };
                    let mapped: Option<(Option<i64>, Option<i64>)> = c
                        .query_row(
                            "SELECT server_item_id, item_version FROM sync_item_map WHERE document_id = ?1 AND item_id = ?2 AND account_key = ?3",
                            params![source.id, payload.source_item_id, op.account_key],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    match mapped {
                        Some((Some(id), Some(version))) => Ok(Plan::Server { link_id, source_link_id, id, version }),
                        Some((Some(_), None)) => {
                            // 서버 id 는 있는데 item version 을 모른다 — 원본 날짜를 다시 받는다.
                            c.execute("UPDATE sync_links SET remote_pending = 1 WHERE document_id = ?1", [&source.id])?;
                            Ok(Plan::Wait)
                        }
                        _ => {
                            let live = repo::item_by_id(c, &payload.source_item_id, false)?.is_some_and(|i| i.document_id == source.id);
                            // 원본을 아직 서버로 보내지 않았다 — 원본 Push 뒤에(서버 id 가 생기면) 보낸다.
                            // 원본이 이 PC 에서 지워졌으면 고른 내용만 local-source 로 보낸다.
                            Ok(if live { Plan::Wait } else { Plan::Local { link_id } })
                        }
                    }
                }
                _ => Ok(Plan::Local { link_id }),
            }
        })?;
        let (route, body) = match plan {
            Plan::Drop => {
                storage.with_conn(|c| finish_op(c, op.id, "dropped", None, Some("unlinked")))?;
                return Ok(None);
            }
            Plan::Wait => return Ok(None),
            Plan::Server { link_id, source_link_id, id, version } => (
                "carry",
                serde_json::to_string(&CarryRequest {
                    request_id: op.request_id.clone(),
                    link_id,
                    source_link_id,
                    items: vec![CarrySelection { id, version, local_copy_key: payload.local_copy_key.clone() }],
                })?,
            ),
            Plan::Local { link_id } => {
                // 고른 복사본의 이미지만 올린다(v1 업로드 — 같은 첨부는 같은 request id). 원본 날짜·History 는 보내지 않는다.
                self.upload_html_attachments(storage, ctx, &payload.original_html).await?;
                let content = storage.with_conn(|c| mapper::to_server_html(c, &ctx.account_key, &payload.original_html))?;
                (
                    "local",
                    serde_json::to_string(&LocalCopyRequest {
                        request_id: op.request_id.clone(),
                        link_id,
                        source_date: payload.source_date.clone(),
                        local_source_id: payload.source_item_id.to_ascii_lowercase(),
                        local_copy_key: payload.local_copy_key.clone(),
                        item: LocalCopyItem { content, section: payload.section.clone() },
                    })?,
                )
            }
        };
        storage.with_conn(|c| {
            c.execute(
                "UPDATE management_outbox SET route = ?2, body_json = ?3, sent_at = ?4, updated_at = ?4 WHERE id = ?1",
                params![op.id, route, body, now()],
            )?;
            Ok(())
        })?;
        Ok(Some((route.to_string(), body)))
    }

    async fn upload_html_attachments(&self, storage: &Storage, ctx: &SyncContext, html: &str) -> Result<(), OpError> {
        for id in crate::memo::text::attachment_ids(html) {
            if storage.with_conn(|c| mapper::server_name_for(c, &ctx.account_key, &id))?.is_some() {
                continue;
            }
            let (bytes, mime) = storage.with_conn(|c| crate::attachments::read_bytes(c, &storage.paths, &id)).map_err(|_| {
                AppError::new("sync_attachment_missing", "복사본의 이미지 파일을 찾을 수 없어 PLAN-A Work 로 보내지 못했습니다.")
            })?;
            let ext = IMAGE_TYPES
                .iter()
                .find(|(m, _)| *m == mime)
                .map(|(_, e)| *e)
                .ok_or_else(|| AppError::new("sync_image_unsupported", "PLAN-A Work 는 PNG·JPG·WEBP 이미지만 받습니다."))?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(AppError::new("sync_image_too_large", "PLAN-A Work 로 보낼 수 있는 이미지는 10MB 까지입니다.").into());
            }
            let uploaded = self.transport.upload(ctx, &id, &format!("{id}.{ext}"), &mime, bytes).await?;
            storage.with_conn(|c| mapper::remember_attachment(c, &id, &ctx.account_key, &uploaded.name, None))?;
        }
        Ok(())
    }

    /// 저장한 본문이 있으면 그대로, 없으면 `{request_id, link_id}` 를 만든다(None = 대상 날짜 연결 대기 · 연결 끝남).
    fn command_body(&self, storage: &Storage, op: &OutboxOp) -> AppResult<Option<Command>> {
        if let Some(body) = &op.body_json {
            return Ok(Some(serde_json::from_str(body)?));
        }
        storage.with_conn(|c| {
            let Some((_, link_id)) = day_link(c, &op.account_key, &op.memo_date)? else {
                finish_op(c, op.id, "dropped", None, Some("unlinked"))?;
                return Ok(None);
            };
            let Some(link_id) = link_id else { return Ok(None) };
            let body = Command { request_id: op.request_id.clone(), link_id };
            c.execute(
                "UPDATE management_outbox SET route = ?2, body_json = ?3, sent_at = ?4, updated_at = ?4 WHERE id = ?1",
                params![op.id, op.kind, serde_json::to_string(&body)?, now()],
            )?;
            Ok(Some(body))
        })
    }

    async fn send_dismiss(&self, storage: &Storage, ctx: &SyncContext, op: &OutboxOp) -> Result<Sent, OpError> {
        let Some(body) = self.command_body(storage, op)? else { return Ok(Sent::Wait) };
        let response = self.transport.v2_dismiss(ctx, &op.memo_date, &body).await?;
        storage.with_conn(|c| {
            finish_op(c, op.id, "done", Some(&serde_json::to_value(&response)?), None)?;
            ensure_shared_day(c, &op.account_key, &op.memo_date)?;
            c.execute(
                "UPDATE shared_days SET prompt_dismissed = 1 WHERE account_key = ?1 AND memo_date = ?2",
                params![op.account_key, op.memo_date],
            )?;
            Ok(())
        })?;
        Ok(Sent::Done)
    }

    async fn send_ack(&self, storage: &Storage, ctx: &SyncContext, op: &OutboxOp) -> Result<Sent, OpError> {
        let payload: AckPayload = serde_json::from_str(&op.payload_json)?;
        let Some(body) = self.command_body(storage, op)? else { return Ok(Sent::Wait) };
        let response = self.transport.v2_ack(ctx, &op.memo_date, &payload.occurrence_id, &body).await?;
        storage.with_conn(|c| apply_ack_result(c, op, &payload, &response))?;
        Ok(Sent::Done)
    }

    async fn send_rule(&self, storage: &Storage, ctx: &SyncContext, op: &OutboxOp, report: &mut SyncReport) -> Result<Sent, OpError> {
        let payload: RulePayload = serde_json::from_str(&op.payload_json)?;
        let body: RulePut = match &op.body_json {
            Some(body) => serde_json::from_str(body)?,
            None => {
                let built = storage.with_conn(|c| {
                    // 앞서 보낸 같은 날짜 명령이 끝나기를 기다린다(그 결과 version 위에 이어 보낸다).
                    let earlier: bool = c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM management_outbox WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule'
                                        AND status = 'pending' AND id < ?3)",
                        params![op.account_key, op.memo_date, op.id],
                        |r| r.get(0),
                    )?;
                    if earlier {
                        return Ok(None);
                    }
                    let Some((_, link_id)) = day_link(c, &op.account_key, &op.memo_date)? else {
                        finish_op(c, op.id, "dropped", None, Some("unlinked"))?;
                        return Ok(None);
                    };
                    let Some(link_id) = link_id else { return Ok(None) };
                    let base = match payload.base_version {
                        Some(base) => base,
                        None => shared_day(c, &op.account_key, &op.memo_date)?.map(|d| d.rule_version).unwrap_or(0),
                    };
                    let body = RulePut {
                        request_id: op.request_id.clone(),
                        link_id,
                        rule: RuleWrite {
                            version: base,
                            timezone: payload.timezone.clone(),
                            local_time: payload.local_time.clone(),
                            days_before: payload.days_before.clone(),
                        },
                    };
                    c.execute(
                        "UPDATE management_outbox SET route = 'rule', body_json = ?2, sent_at = ?3, updated_at = ?3 WHERE id = ?1",
                        params![op.id, serde_json::to_string(&body)?, now()],
                    )?;
                    Ok(Some(body))
                })?;
                match built {
                    Some(body) => body,
                    None => return Ok(Sent::Wait),
                }
            }
        };
        let result = self.transport.v2_put_rule(ctx, &op.memo_date, &body).await?;
        storage.with_conn(|c| {
            let tx = c.transaction()?;
            match &result {
                RulePutResult::Saved(rule) => {
                    finish_op(&tx, op.id, "done", Some(&serde_json::to_value(rule)?), None)?;
                    store_rule(&tx, &op.account_key, &op.memo_date, rule)?;
                    mark_stale(&tx, &op.account_key, &op.memo_date)?;
                }
                RulePutResult::Changed { current, .. }
                    if same_rule(
                        current,
                        &ProposedRule {
                            timezone: payload.timezone.clone(),
                            local_time: payload.local_time.clone(),
                            days_before: payload.days_before.clone(),
                        },
                    ) =>
                {
                    // 서버 현재값이 이미 이 제안과 같다(다른 곳에서 같은 설정으로 맞춤) — 고를 것이 없다.
                    finish_op(&tx, op.id, "done", Some(&serde_json::to_value(current)?), Some("already_equal"))?;
                    store_rule(&tx, &op.account_key, &op.memo_date, current)?;
                    mark_stale(&tx, &op.account_key, &op.memo_date)?;
                }
                RulePutResult::Changed { current, .. } => {
                    // 다른 곳에서 먼저 바뀌었다 — 두 설정을 모두 보관하고 사용자가 고른다(이 PC 의 가장 최근 제안 기준).
                    let latest: RulePayload = tx
                        .query_row(
                            "SELECT payload_json FROM management_outbox WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule'
                               AND status = 'pending' ORDER BY id DESC LIMIT 1",
                            params![op.account_key, op.memo_date],
                            |r| r.get::<_, String>(0),
                        )
                        .optional()?
                        .and_then(|j| serde_json::from_str(&j).ok())
                        .unwrap_or_else(|| payload.clone());
                    finish_op(&tx, op.id, "conflict", Some(&serde_json::json!({"current": current})), Some("reminder_changed"))?;
                    tx.execute(
                        "UPDATE management_outbox SET status = 'dropped', last_error = 'merged_into_conflict', updated_at = ?3
                          WHERE account_key = ?1 AND memo_date = ?2 AND kind = 'rule' AND status = 'pending'",
                        params![op.account_key, op.memo_date, now()],
                    )?;
                    store_rule(&tx, &op.account_key, &op.memo_date, current)?;
                    set_rule_conflict(
                        &tx,
                        &op.account_key,
                        &op.memo_date,
                        Some(&RuleConflict {
                            current: current.clone(),
                            proposed: ProposedRule {
                                timezone: latest.timezone,
                                local_time: latest.local_time,
                                days_before: latest.days_before,
                            },
                            initial: false,
                        }),
                    )?;
                    report.notices.push(NOTICE_RULE_CONFLICT.into());
                }
            }
            tx.commit()?;
            Ok(())
        })?;
        report.management_changed = true;
        Ok(Sent::Done)
    }

    /// ④ 서버 관리 상태 받기 — 처음(또는 새 기기)이면 연결된 날짜 전체, 그 뒤로는 v2 changes(cursor) + 내 명령 뒤의 날짜.
    pub async fn management_pull_phase(&self, storage: &Storage, ctx: &SyncContext, report: &mut SyncReport) -> AppResult<()> {
        let linked: Vec<(String, String)> = storage.with_conn(|c| {
            Ok(c.prepare(
                "SELECT d.memo_date, l.link_id FROM documents d JOIN sync_links l ON l.document_id = d.id
                  WHERE d.kind = 'DAY' AND d.sync_enabled = 1 AND l.account_key = ?1 AND l.link_id IS NOT NULL ORDER BY d.memo_date",
            )?
            .query_map([&ctx.account_key], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?)
        })?;
        if linked.is_empty() {
            return Ok(());
        }
        let init_key = format!("mgmt_init|{}|{}", ctx.account_key, ctx.server_device_id);
        let first = storage.with_conn(|c| state_get(c, &init_key))?.is_none();
        let wanted: Vec<(String, String)> = if first {
            linked.clone()
        } else {
            let stale: HashSet<String> = storage.with_conn(|c| {
                Ok(c.prepare("SELECT memo_date FROM shared_days WHERE account_key = ?1 AND state_stale = 1")?
                    .query_map([&ctx.account_key], |r| r.get(0))?
                    .collect::<Result<_, _>>()?)
            })?;
            let known: HashSet<String> = storage.with_conn(|c| {
                Ok(c.prepare("SELECT memo_date FROM shared_days WHERE account_key = ?1")?
                    .query_map([&ctx.account_key], |r| r.get(0))?
                    .collect::<Result<_, _>>()?)
            })?;
            linked.iter().filter(|(d, _)| stale.contains(d) || !known.contains(d)).cloned().collect()
        };
        for (date, link_id) in &wanted {
            match self.fetch_day(storage, ctx, date, link_id, report).await {
                Ok(()) => {}
                Err(error) if stops(&error) => return self.pull_stopped(storage, ctx, error, report),
                Err(error) => log::info!("management state fetch skipped: {}", super::http::error_kind(&error)),
            }
        }
        if first {
            storage.with_conn(|c| state_set(c, &init_key, &now()))?;
        }
        self.management_changes(storage, ctx, report).await
    }

    fn pull_stopped(&self, storage: &Storage, ctx: &SyncContext, error: TransportError, report: &mut SyncReport) -> AppResult<()> {
        match error {
            TransportError::AuthRequired => {
                self.auth.mark_expired();
                report.auth_required = true;
            }
            TransportError::Unavailable | TransportError::EndpointMissing => {
                storage.with_conn(|c| set_capability(c, &ctx.account_key, false))?;
            }
            _ => report.offline = true,
        }
        Ok(())
    }

    /// 날짜 하나의 관리 상태(+ 원본 날짜도 연결돼 있으면 복사 후보)를 받아 로컬에 반영한다.
    async fn fetch_day(&self, storage: &Storage, ctx: &SyncContext, date: &str, link_id: &str, report: &mut SyncReport) -> TResult<()> {
        let state = match self.transport.v2_state(ctx, date, link_id).await {
            Ok(state) => state,
            Err(error) if is_link_problem(&error) || matches!(error, TransportError::NotFound) => return Ok(()),
            Err(error) => return Err(error),
        };
        let candidates = self.fetch_candidates(storage, ctx, date, link_id).await?;
        storage
            .with_conn(|c| {
                let tx = c.transaction()?;
                apply_state(&tx, &ctx.account_key, date, link_id, &state, reminders::local_now())?;
                if let Some(candidates) = &candidates {
                    apply_candidates(&tx, &ctx.account_key, date, candidates)?;
                }
                tx.commit()?;
                Ok(())
            })
            .map_err(|e| TransportError::Server(e.to_string()))?;
        report.management_changed = true;
        Ok(())
    }

    /// 복사 후보 — 원본 날짜(D-7)도 이 계정으로 연결돼 있고, 대상 날짜가 지난주 이후일 때만 묻는다.
    async fn fetch_candidates(&self, storage: &Storage, ctx: &SyncContext, date: &str, link_id: &str) -> TResult<Option<CarryCandidates>> {
        let Ok(target) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else { return Ok(None) };
        let today = chrono::Local::now().date_naive();
        if target < today - chrono::Duration::days(7) {
            return Ok(None);
        }
        let source_date = (target - chrono::Duration::days(7)).format("%Y-%m-%d").to_string();
        let source_link = storage
            .with_conn(|c| Ok(day_link(c, &ctx.account_key, &source_date)?.and_then(|(_, l)| l)))
            .map_err(|e| TransportError::Server(e.to_string()))?;
        let Some(source_link) = source_link else { return Ok(None) };
        match self.transport.v2_carry_candidates(ctx, date, link_id, &source_link, &local_timezone()).await {
            Ok(c) => Ok(Some(c)),
            Err(error) if stops(&error) => Err(error),
            Err(error) => {
                log::info!("carry candidates skipped: {}", super::http::error_kind(&error));
                Ok(None)
            }
        }
    }

    async fn management_changes(&self, storage: &Storage, ctx: &SyncContext, report: &mut SyncReport) -> AppResult<()> {
        let key = format!("mgmt_cursor|{}|{}", ctx.account_key, ctx.server_device_id);
        let mut cursor = storage.with_conn(|c| state_get(c, &key))?;
        let mut reset_once = false;
        for _ in 0..50 {
            let page = match self.transport.v2_changes(ctx, cursor.as_deref()).await {
                Ok(page) => page,
                Err(TransportError::Conflict { code }) if code == "cursor_namespace_mismatch" && !reset_once => {
                    // 다른 기기·환경의 cursor — 버리고 연결된 날짜 상태를 다시 받는다.
                    reset_once = true;
                    cursor = None;
                    storage.with_conn(|c| {
                        c.execute("DELETE FROM sync_state WHERE key = ?1", [&key])?;
                        c.execute("UPDATE shared_days SET state_stale = 1 WHERE account_key = ?1", [&ctx.account_key])?;
                        Ok(())
                    })?;
                    continue;
                }
                Err(error) if stops(&error) => return self.pull_stopped(storage, ctx, error, report),
                Err(error) => {
                    log::info!("management changes failed: {}", super::http::error_kind(&error));
                    return Ok(());
                }
            };
            // 이벤트의 날짜 상태를 먼저 모두 받고(네트워크), 상태 + cursor 를 한 transaction 으로 반영한다.
            let mut fetched: Vec<(String, String, ManagementState, Option<CarryCandidates>)> = Vec::new();
            let mut unlinked: Vec<(String, Option<String>)> = Vec::new();
            let mut handled: HashSet<String> = HashSet::new();
            for event in page.events.iter().rev() {
                if event.kind == "unlinked" {
                    unlinked.push((event.day.clone(), event.link_id.clone()));
                    continue;
                }
                if !handled.insert(event.day.clone()) {
                    continue; // 같은 날짜는 최신 상태 한 번이면 된다
                }
                let local = storage.with_conn(|c| day_link(c, &ctx.account_key, &event.day))?;
                let Some((_, Some(link_id))) = local else { continue }; // 이 PC 에서 연결하지 않은 날짜
                if event.link_id.as_deref().is_some_and(|l| l != link_id) {
                    continue; // 이전 generation 의 이벤트
                }
                let state = match self.transport.v2_state(ctx, &event.day, &link_id).await {
                    Ok(state) => state,
                    Err(error) if is_link_problem(&error) || matches!(error, TransportError::NotFound) => continue,
                    Err(error) if stops(&error) => return self.pull_stopped(storage, ctx, error, report),
                    Err(error) => {
                        log::info!("management state failed: {}", super::http::error_kind(&error));
                        return Ok(()); // cursor 를 넘기지 않는다 — 다음에 다시
                    }
                };
                let candidates = match self.fetch_candidates(storage, ctx, &event.day, &link_id).await {
                    Ok(c) => c,
                    Err(error) => return self.pull_stopped(storage, ctx, error, report),
                };
                fetched.push((event.day.clone(), link_id, state, candidates));
            }
            storage.with_conn(|c| {
                let tx = c.transaction()?;
                for (day, link_id) in &unlinked {
                    if let Some((_, Some(local))) = day_link(&tx, &ctx.account_key, day)? {
                        if link_id.as_deref().map_or(true, |l| l == local) {
                            drop_day_ops(&tx, &ctx.account_key, day, "unlinked")?;
                        }
                    }
                }
                let now_local = reminders::local_now();
                for (day, link_id, state, candidates) in &fetched {
                    apply_state(&tx, &ctx.account_key, day, link_id, state, now_local)?;
                    if let Some(candidates) = candidates {
                        apply_candidates(&tx, &ctx.account_key, day, candidates)?;
                    }
                }
                state_set(&tx, &key, &page.cursor)?;
                tx.commit()?;
                Ok(())
            })?;
            if !fetched.is_empty() || !unlinked.is_empty() {
                report.management_changed = true;
            }
            cursor = Some(page.cursor.clone());
            if !page.has_more {
                break;
            }
        }
        Ok(())
    }

    /// 화면이 '지난 미완료 가져오기' 를 열 때 — 연결된 날짜면 서버 복사 후보를 다시 묻는다(최근에 물었으면 그대로).
    pub async fn refresh_carry(&self, storage: &Storage, date: &str) -> AppResult<()> {
        let Some(ctx) = self.context() else { return Ok(()) };
        let (scope, checked) = storage.with_conn(|c| {
            let scope = day_scope(c, date)?;
            let checked = match &scope {
                DayScope::Shared { account_key, .. } => shared_day(c, account_key, date)?.and_then(|d| d.carry_checked_at),
                _ => None,
            };
            Ok((scope, checked))
        })?;
        let DayScope::Shared { account_key, link_id: Some(link_id), .. } = scope else { return Ok(()) };
        if account_key != ctx.account_key || checked.as_deref().and_then(seconds_since).is_some_and(|s| s < CANDIDATE_TTL_SECS) {
            return Ok(());
        }
        if let Ok(Some(candidates)) = self.fetch_candidates(storage, &ctx, date, &link_id).await {
            storage.with_conn(|c| apply_candidates(c, &ctx.account_key, date, &candidates))?;
        }
        Ok(())
    }
}

fn apply_ack_result(conn: &mut Connection, op: &OutboxOp, payload: &AckPayload, response: &OccurrenceAckResponse) -> AppResult<()> {
    let tx = conn.transaction()?;
    finish_op(&tx, op.id, "done", Some(&serde_json::to_value(response)?), None)?;
    tx.execute(
        "UPDATE shared_occurrences SET state = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, ?3), updated_at = ?3
          WHERE account_key = ?1 AND occurrence_id = ?2",
        params![op.account_key, payload.occurrence_id, now()],
    )?;
    withdraw_closed_toasts(&tx, &op.account_key, &op.memo_date)?;
    tx.commit()?;
    Ok(())
}

// ── 작업 스케줄러가 실행한 알림 프로세스(앱 창 없음) ─────────────────────────

/// 시각이 된 '연결된 날짜' 알림이 있는 날짜(지금 계정).
pub fn due_shared_dates(conn: &Connection, now_local: NaiveDateTime) -> AppResult<Vec<String>> {
    if !has_schema(conn) {
        return Ok(Vec::new());
    }
    let Some(account) = active_account(conn)? else { return Ok(Vec::new()) };
    Ok(conn
        .prepare(
            "SELECT DISTINCT r.memo_date FROM day_reminders r JOIN shared_days s ON s.memo_date = r.memo_date AND s.account_key = ?1
              WHERE r.status = 'pending' AND r.fire_at <= ?2",
        )?
        .query_map(params![account, reminders::format_fire(now_local)], |r| r.get(0))?
        .collect::<Result<_, _>>()?)
}

/// 알림을 띄우기 직전(온라인이면) — 보내지 못한 확인(ACK)을 먼저 보내고, 그 날짜의 최신 발생 상태를 받는다.
/// 이미 다른 곳에서 확인·취소된 알림을 오래된 로컬 예약 때문에 다시 띄우지 않기 위해서다.
/// 모든 실패(오프라인·시간 초과·인증 만료)는 무시하고 로컬 상태로 진행한다(무한 대기·반복 실행 없음 — 호출자가 시간 제한).
pub async fn refresh_before_display(
    conn: &mut Connection,
    transport: &dyn SyncTransport,
    ctx: &SyncContext,
    dates: &[String],
) -> AppResult<usize> {
    let mut refreshed = 0;
    let acks: Vec<OutboxOp> = conn
        .prepare(&format!(
            "SELECT {OP_COLUMNS} FROM management_outbox WHERE account_key = ?1 AND kind = 'ack' AND status = 'pending' ORDER BY id"
        ))?
        .query_map([&ctx.account_key], op_from_row)?
        .collect::<Result<_, _>>()?;
    for op in acks {
        let payload: AckPayload = serde_json::from_str(&op.payload_json)?;
        let body = match &op.body_json {
            Some(body) => serde_json::from_str::<Command>(body)?,
            None => {
                let Some((_, Some(link_id))) = day_link(conn, &op.account_key, &op.memo_date)? else { continue };
                let body = Command { request_id: op.request_id.clone(), link_id };
                conn.execute(
                    "UPDATE management_outbox SET route = 'ack', body_json = ?2, sent_at = ?3, updated_at = ?3 WHERE id = ?1",
                    params![op.id, serde_json::to_string(&body)?, now()],
                )?;
                body
            }
        };
        match transport.v2_ack(ctx, &op.memo_date, &payload.occurrence_id, &body).await {
            Ok(response) => apply_ack_result(conn, &op, &payload, &response)?,
            Err(error) if stops(&error) => return Ok(refreshed),
            Err(_) => {} // 앱이 다음 Sync 에서 원인별로 처리한다
        }
    }
    for date in dates {
        let Some((_, Some(link_id))) = day_link(conn, &ctx.account_key, date)? else { continue };
        match transport.v2_occurrences(ctx, date, &link_id).await {
            Ok(list) => {
                let tx = conn.transaction()?;
                apply_occurrences(&tx, &ctx.account_key, date, &list.occurrences)?;
                tx.commit()?;
                refreshed += 1;
            }
            Err(error) if stops(&error) => return Ok(refreshed),
            Err(_) => {}
        }
    }
    Ok(refreshed)
}

/// 발생 상태만 반영(알림 직전 확인용) — 닫힌 발생의 예약 행은 띄우지 않게 한다.
fn apply_occurrences(conn: &Connection, account_key: &str, date: &str, occurrences: &[Occurrence]) -> AppResult<()> {
    let ts = now();
    for occ in occurrences.iter().filter(|o| RULE_OFFSETS.contains(&o.days_before)) {
        conn.execute(
            "INSERT INTO shared_occurrences (account_key, memo_date, offset_days, occurrence_id, scheduled_at, state, delivery_status,
                                             acknowledged_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(account_key, memo_date, offset_days) DO UPDATE SET
                 occurrence_id = excluded.occurrence_id, scheduled_at = excluded.scheduled_at, state = excluded.state,
                 delivery_status = excluded.delivery_status, acknowledged_at = excluded.acknowledged_at, updated_at = excluded.updated_at",
            params![account_key, date, occ.days_before, occ.id, occ.scheduled_at, occ.state, occ.delivery_status, occ.acknowledged_at, ts],
        )?;
    }
    withdraw_closed_toasts(conn, account_key, date)?;
    Ok(())
}
