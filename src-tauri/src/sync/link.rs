//! 문서 연결/해제 — 로컬 DB 상태만 바꾼다(전송은 Engine 이 Outbox 를 보고 한다).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::contract::PushRequest;
use crate::error::{AppError, AppResult};
use crate::memo::{repo, DocumentInfo, DocumentSnapshot};
use crate::util::now;

/// Outbox payload(JSON). PUSH 는 보낸 요청을 **그대로** 남긴다 — 응답을 잃으면 같은 request_id·같은 본문으로
/// 다시 보내 서버 idempotency 로 결과를 받는다(중복 항목·중복 version 없음).
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OutboxPayload {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub server_document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub link_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub inflight: Option<InflightPush>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InflightPush {
    pub server_document_id: String,
    pub body: PushRequest,
    /// 이 요청을 만든 로컬 revision
    pub local_revision: i64,
}

pub fn link_row(conn: &Connection, doc_id: &str) -> AppResult<Option<LinkRow>> {
    Ok(conn
        .query_row(
            "SELECT document_id, server_document_id, account_key, link_id, acked_version, remote_pending, server_digest
               FROM sync_links WHERE document_id = ?1",
            [doc_id],
            |r| {
                Ok(LinkRow {
                    document_id: r.get(0)?,
                    server_document_id: r.get(1)?,
                    account_key: r.get(2)?,
                    link_id: r.get(3)?,
                    acked_version: r.get(4)?,
                    remote_pending: r.get::<_, i64>(5)? == 1,
                    server_digest: r.get(6)?,
                })
            },
        )
        .optional()?)
}

#[derive(Debug, Clone)]
pub struct LinkRow {
    pub document_id: String,
    pub server_document_id: Option<String>,
    pub account_key: Option<String>,
    pub link_id: Option<String>,
    pub acked_version: i64,
    pub remote_pending: bool,
    pub server_digest: Option<String>,
}

/// 이 문서를 PLAN-A Work 와 연결한다(사용자가 고른 문서 하나). 실제 전송은 다음 Sync 때.
/// `account_key` — 지금 로그인한 계정. 이 계정의 Sync 상태로만 묶는다.
pub fn enable_link(conn: &Connection, doc_id: &str, account_key: &str) -> AppResult<()> {
    let doc = repo::doc_by_id(conn, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
    if doc.sync_enabled {
        return Ok(());
    }
    // 해제를 아직 서버에 보내지 못했는데 다시 연결 — 그 UNLINK 는 취소(서버 link 는 아직 살아 있다).
    let pending_unlink: Option<(Option<String>, Option<String>)> = conn
        .query_row("SELECT payload, account_key FROM sync_outbox WHERE document_id = ?1 AND op = 'UNLINK'", [doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let reuse = pending_unlink
        .filter(|(_, account)| account.as_deref() == Some(account_key))
        .and_then(|(payload, _)| payload)
        .and_then(|p| serde_json::from_str::<OutboxPayload>(&p).ok())
        .and_then(|p| Some((p.server_document_id?, p.link_id?)));
    if reuse.is_some() {
        conn.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op = 'UNLINK'", [doc_id])?;
    }
    conn.execute(
        "INSERT INTO sync_links (document_id, server_document_id, account_id, account_key, link_id, linked_at, acked_version, remote_pending)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT(document_id) DO UPDATE SET server_document_id = excluded.server_document_id, account_id = excluded.account_id,
             account_key = excluded.account_key, link_id = excluded.link_id, linked_at = excluded.linked_at,
             acked_version = 0, remote_pending = excluded.remote_pending, server_digest = NULL",
        params![doc_id, reuse.as_ref().map(|r| r.0.clone()), account_key, reuse.as_ref().map(|r| r.1.clone()), now(), reuse.is_some() as i64],
    )?;
    conn.execute(
        "UPDATE documents SET sync_enabled = 1, sync_status = 'pending', sync_error = NULL, server_version = NULL, synced_revision = 0 WHERE id = ?1",
        [doc_id],
    )?;
    // 다시 쓰는 서버 link 라도 첫 연결과 같은 비교(LINK)를 거친다 — 로컬·서버 어느 쪽도 덮어쓰지 않는다.
    repo::enqueue(conn, doc_id, "LINK", doc.local_revision, None)?;
    conn.execute("UPDATE sync_outbox SET account_key = ?2 WHERE document_id = ?1 AND op = 'LINK'", params![doc_id, account_key])?;
    Ok(())
}

/// 연결 해제(사용자) — Sync 만 멈춘다. 로컬 메모는 그대로, 서버 사본도 지우지 않는다(서버도 둘 다 보존).
/// 열려 있던 Conflict 의 PLAN-A Work 내용은 History 로 남긴다(조용히 버리지 않는다).
pub fn disable_link(conn: &Connection, doc_id: &str) -> AppResult<DocumentInfo> {
    let link = link_row(conn, doc_id)?;
    end_local_link(conn, doc_id)?;
    if let Some(LinkRow { server_document_id: Some(server_id), link_id: Some(link_id), account_key, .. }) = link {
        let payload = OutboxPayload { server_document_id: Some(server_id), link_id: Some(link_id), inflight: None };
        let doc = repo::doc_by_id(conn, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
        repo::enqueue(conn, doc_id, "UNLINK", doc.local_revision, Some(&serde_json::to_string(&payload)?))?;
        conn.execute("UPDATE sync_outbox SET account_key = ?2 WHERE document_id = ?1 AND op = 'UNLINK'", params![doc_id, account_key])?;
    }
    repo::doc_by_id(conn, doc_id)?.ok_or_else(|| AppError::not_found("문서"))
}

/// 로컬 연결 상태만 정리한다(서버가 이미 끊었거나, 사용자가 해제했을 때 공통).
pub fn end_local_link(conn: &Connection, doc_id: &str) -> AppResult<()> {
    let doc = repo::doc_by_id(conn, doc_id)?.ok_or_else(|| AppError::not_found("문서"))?;
    let open: Option<(String, String)> = conn
        .query_row("SELECT id, remote_snapshot_json FROM conflicts WHERE document_id = ?1 AND status = 'open'", [doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    if let Some((conflict_id, remote_json)) = open {
        let remote: DocumentSnapshot = serde_json::from_str(&remote_json)?;
        insert_version(conn, doc_id, "conflict_remote", doc.local_revision, &remote)?;
        conn.execute(
            "UPDATE conflicts SET status = 'closed', resolved_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![conflict_id, now()],
        )?;
    }
    conn.execute("DELETE FROM sync_outbox WHERE document_id = ?1 AND op IN ('LINK', 'PUSH')", [doc_id])?;
    conn.execute("DELETE FROM sync_links WHERE document_id = ?1", [doc_id])?;
    conn.execute(
        "UPDATE documents SET sync_enabled = 0, sync_status = 'local_only', sync_error = NULL,
                server_version = NULL, synced_revision = 0 WHERE id = ?1",
        [doc_id],
    )?;
    Ok(())
}

/// History 에 Snapshot 을 그대로 남긴다(편집 합치기 규칙 없이 — Conflict 의 선택되지 않은 버전 등).
pub fn insert_version(conn: &Connection, doc_id: &str, reason: &str, revision: i64, snapshot: &DocumentSnapshot) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO document_versions (document_id, reason, local_revision, snapshot_json, content_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![doc_id, reason, revision, serde_json::to_string(snapshot)?, snapshot.text(), now()],
    )?;
    Ok(conn.last_insert_rowid())
}
