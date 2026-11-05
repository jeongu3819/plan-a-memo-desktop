//! List 휴지통 — 연결되지 않은(이 PC 에만 있는) List 와 그 안의 메모를 7일 동안 보관한다.
//!
//! · 보관 중에는 List·문서에 deleted_at 만 달린다. 메모·이미지 참조·History 는 그대로라 이미지 정리가 지우지 않고,
//!   목록·검색·즐겨찾기·내보내기에는 나타나지 않는다.
//! · 영구 삭제: 지우기 직전에 Backup 을 만들고, 문서에 달린 메모·History·Sync 기록을 함께 지운다. 이미지는 다른 곳에서 쓰지 않으면
//!   지운다 — Backup 이 참조하는 파일은 그 Backup 이 없어질 때까지 기다린다(attachments::sweep_purged).
//! · 연결된 List: 이름 변경·삭제·복구는 모든 기기가 같은 상태를 써야 하는데 memo-sync-v1/v2 에는 복구·이름 변경 API 가 없다.
//!   공통 관리 기능이 준비될 때까지 삭제를 받지 않는다(LINKED_MANAGED_CODE). 삭제가 Web 에만 전달되고 복구는 이 PC 에만 되는
//!   반쪽 상태를 만들지 않기 위해서다. 연동을 해제하면(메모는 양쪽에 남는다) 이 PC 의 List 로 관리할 수 있다.
//! · 이전 빌드에서 이미 지운 연결 List(was_linked): 내용을 그대로 보존한다 — 복구·영구 삭제·기간 만료 모두 하지 않는다.
//!   Outbox 에 있는 삭제 전달은 건드리지 않는다(재전송 규칙 그대로 서버로 간다). 처리는 docs/LIST_TRASH_SERVER_HANDOFF.md.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::{repo, Location, NextListInfo};
use crate::error::{AppError, AppResult};
use crate::storage::{backup, StoragePaths};
use crate::util::now;

pub const RETENTION_DAYS: i64 = 7;
/// 연결된 List 의 이름 변경·삭제·복구 — 공통 관리 기능(서버)이 준비되기 전에는 하지 않는다.
pub const LINKED_MANAGED_CODE: &str = "linked_list_managed";
const LINKED_DELETE_MESSAGE: &str = "연결된 List의 삭제는 PLAN-A Work 공통 관리 기능이 준비된 후 사용할 수 있습니다. 연동을 해제하면 이 PC의 List로 삭제할 수 있습니다.";
const LINKED_RESTORE_MESSAGE: &str = "PLAN-A Work 와 연결돼 있던 List 입니다. 복구는 공통 관리 기능이 준비된 후 사용할 수 있으며, 그때까지 내용을 그대로 보관합니다.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub list_id: String,
    pub name: String,
    pub item_count: i64,
    pub was_linked: bool,
    pub deleted_at: String,
    pub purge_after: String,
    /// 영구 삭제를 미루는 이유(없으면 지울 수 있다).
    pub blocked: Option<String>,
    /// 이 PC 에서 복구할 수 있는가(연결돼 있던 List 는 공통 관리 기능 전까지 아니다).
    pub restorable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    pub id: String,
    pub item_count: i64,
    pub purge_after: String,
    /// 이미 휴지통에 있었다(두 번 실행 — 아무것도 바꾸지 않았다).
    pub already: bool,
}

fn item_count(conn: &Connection, list_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM memo_items i JOIN documents d ON d.id = i.document_id
          WHERE d.kind = 'NEXT_LIST' AND d.next_list_id = ?1 AND i.deleted_at IS NULL",
        [list_id],
        |r| r.get(0),
    )?)
}

const IN_TRASH_SQL: &str = "FROM list_trash t JOIN next_lists l ON l.id = t.list_id WHERE t.list_id = ?1 AND l.deleted_at IS NOT NULL";

pub fn move_to_trash(conn: &mut Connection, id: &str) -> AppResult<TrashResult> {
    let tx = conn.transaction()?;
    let trashed: Option<String> = tx.query_row(&format!("SELECT t.purge_after {IN_TRASH_SQL}"), [id], |r| r.get(0)).optional()?;
    if let Some(purge_after) = trashed {
        return Ok(TrashResult { id: id.to_string(), item_count: item_count(&tx, id)?, purge_after, already: true });
    }
    let info = repo::list_info(&tx, id)?;
    if info.is_default {
        return Err(AppError::validation("기본 Next 는 삭제할 수 없습니다."));
    }
    if info.document.as_ref().is_some_and(|d| d.sync_enabled) {
        return Err(AppError::new(LINKED_MANAGED_CODE, LINKED_DELETE_MESSAGE));
    }
    let ts = now();
    if let Some(doc) = &info.document {
        repo::record_version(&tx, &doc.id, "list_delete")?;
        tx.execute("UPDATE documents SET deleted_at = ?2 WHERE id = ?1", params![doc.id, ts])?;
    }
    tx.execute("UPDATE next_lists SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1", params![id, ts])?;
    if let Some(doc) = &info.document {
        repo::touch(&tx, &doc.id)?;
    }
    let until = (chrono::Utc::now() + chrono::Duration::days(RETENTION_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    tx.execute(
        "INSERT INTO list_trash (list_id, was_linked, deleted_at, purge_after) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(list_id) DO UPDATE SET was_linked = excluded.was_linked, deleted_at = excluded.deleted_at, purge_after = excluded.purge_after",
        params![id, 0, ts, until],
    )?;
    tx.commit()?;
    Ok(TrashResult { id: id.to_string(), item_count: info.item_count, purge_after: until, already: false })
}

fn blocked_reason(conn: &Connection, list_id: &str) -> AppResult<Option<String>> {
    let Some(doc) = repo::doc_for_location(conn, &Location::Next { list_id: Some(list_id.to_string()) })? else {
        return Ok(None);
    };
    if doc.has_conflict {
        return Ok(Some("PLAN-A Work 와 내용 비교가 끝나지 않아 보관을 이어 갑니다.".into()));
    }
    let outbox: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE document_id = ?1", [&doc.id], |r| r.get(0))?;
    if doc.sync_enabled || outbox > 0 {
        return Ok(Some("PLAN-A Work 전달이 끝난 뒤 지울 수 있습니다. 그때까지 보관을 이어 갑니다.".into()));
    }
    let was_linked: bool =
        conn.query_row("SELECT was_linked = 1 FROM list_trash WHERE list_id = ?1", [list_id], |r| r.get(0)).optional()?.unwrap_or(false);
    if was_linked {
        return Ok(Some(LINKED_RESTORE_MESSAGE.into()));
    }
    Ok(None)
}

pub fn entries(conn: &Connection) -> AppResult<Vec<TrashEntry>> {
    // 다른 경로(Web 에서 다시 연결)로 되살아난 List 의 행은 지운다.
    conn.execute("DELETE FROM list_trash WHERE list_id NOT IN (SELECT id FROM next_lists WHERE deleted_at IS NOT NULL)", [])?;
    let rows: Vec<(String, String, bool, String, String)> = conn
        .prepare(
            "SELECT t.list_id, l.name, t.was_linked = 1, t.deleted_at, t.purge_after
               FROM list_trash t JOIN next_lists l ON l.id = t.list_id
              ORDER BY t.deleted_at DESC",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<Result<_, _>>()?;
    rows.into_iter()
        .map(|(list_id, name, was_linked, deleted_at, purge_after)| {
            let item_count = item_count(conn, &list_id)?;
            let blocked = blocked_reason(conn, &list_id)?;
            Ok(TrashEntry { list_id, name, item_count, was_linked, deleted_at, purge_after, blocked, restorable: !was_linked })
        })
        .collect()
}

pub fn restore(conn: &mut Connection, id: &str) -> AppResult<NextListInfo> {
    let tx = conn.transaction()?;
    let row: Option<bool> = tx.query_row(&format!("SELECT t.was_linked = 1 {IN_TRASH_SQL}"), [id], |r| r.get(0)).optional()?;
    let Some(was_linked) = row else {
        // 이미 복구됐으면(두 번 실행) 그대로 돌려준다. 정말 없으면 list_info 가 not_found.
        return repo::list_info(&tx, id);
    };
    if was_linked {
        return Err(AppError::new(LINKED_MANAGED_CODE, LINKED_RESTORE_MESSAGE));
    }
    let doc = repo::doc_for_location(&tx, &Location::Next { list_id: Some(id.to_string()) })?;
    if let Some(doc) = &doc {
        repo::record_version(&tx, &doc.id, "list_restore")?;
        tx.execute("UPDATE documents SET deleted_at = NULL WHERE id = ?1", [&doc.id])?;
    }
    tx.execute("UPDATE next_lists SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1", params![id, now()])?;
    if let Some(doc) = &doc {
        repo::touch(&tx, &doc.id)?;
    }
    tx.execute("DELETE FROM list_trash WHERE list_id = ?1", [id])?;
    let list = repo::list_info(&tx, id)?;
    tx.commit()?;
    Ok(list)
}

/// 문서의 메모(지운 메모 포함)·History·비교가 참조하는 이미지 + 이 문서 소유로 기록된 이미지.
fn images_of_document(conn: &Connection, doc_id: &str) -> AppResult<std::collections::HashSet<String>> {
    let mut ids = std::collections::HashSet::new();
    for sql in [
        "SELECT content_html FROM memo_items WHERE document_id = ?1",
        "SELECT snapshot_json FROM document_versions WHERE document_id = ?1",
        "SELECT local_snapshot_json || remote_snapshot_json FROM conflicts WHERE document_id = ?1",
    ] {
        let mut stmt = conn.prepare(sql)?;
        for text in stmt.query_map([doc_id], |r| r.get::<_, String>(0))? {
            ids.extend(super::text::attachment_ids(&text?));
        }
    }
    let owned: Vec<String> = conn.prepare("SELECT id FROM attachments WHERE document_id = ?1")?.query_map([doc_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    ids.extend(owned);
    Ok(ids)
}

fn purge_one(conn: &mut Connection, id: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    if let Some(doc) = repo::doc_for_location(&tx, &Location::Next { list_id: Some(id.to_string()) })? {
        // 이 문서가 쓰던 이미지를 정리 대기에 올린다(다른 곳에서 쓰면 sweep_purged 가 지우지 않는다).
        let ts = now();
        for image in images_of_document(&tx, &doc.id)? {
            tx.execute("INSERT OR IGNORE INTO purged_attachments (attachment_id, purged_at) VALUES (?1, ?2)", params![image, ts])?;
        }
        // 메모·History·연결 기록은 문서를 따라 지워진다(ON DELETE CASCADE).
        tx.execute("DELETE FROM documents WHERE id = ?1", [&doc.id])?;
        tx.execute("DELETE FROM sync_state WHERE key LIKE ?1", [format!("accepted|%|{}", doc.id)])?;
    }
    tx.execute("DELETE FROM next_lists WHERE id = ?1 AND is_default = 0 AND deleted_at IS NOT NULL", [id])?;
    tx.execute("DELETE FROM list_trash WHERE list_id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

/// 사용자가 고른 영구 삭제. 이미 없으면 그대로 성공(두 번 실행).
pub fn purge(conn: &mut Connection, paths: &StoragePaths, id: &str) -> AppResult<()> {
    let exists: Option<i64> = conn.query_row(&format!("SELECT 1 {IN_TRASH_SQL}"), [id], |r| r.get(0)).optional()?;
    if exists.is_none() {
        return Ok(());
    }
    if let Some(reason) = blocked_reason(conn, id)? {
        return Err(AppError::new("trash_blocked", reason));
    }
    backup::create(conn, paths, "pre-trash-purge")?;
    purge_one(conn, id)?;
    // 파일 정리는 삭제 결과를 바꾸지 않는다(실패하면 다음 기회에).
    if let Err(error) = crate::attachments::sweep_purged(conn, paths) {
        log::warn!("purged image sweep failed: {}", error.code());
    }
    Ok(())
}

/// 보존 기간이 지난 항목을 지운다(앱 시작 · 휴지통을 열 때). 전달이 남은 항목은 다음 기회로 미룬다.
pub fn purge_expired(conn: &mut Connection, paths: &StoragePaths, at: &str) -> AppResult<Vec<String>> {
    let due: Vec<String> = conn
        .prepare(
            "SELECT t.list_id FROM list_trash t JOIN next_lists l ON l.id = t.list_id
              WHERE t.purge_after <= ?1 AND l.deleted_at IS NOT NULL",
        )?
        .query_map([at], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut ready = Vec::new();
    for id in due {
        if blocked_reason(conn, &id)?.is_none() {
            ready.push(id);
        }
    }
    if ready.is_empty() {
        return Ok(ready);
    }
    backup::create(conn, paths, "pre-trash-purge")?;
    for id in &ready {
        purge_one(conn, id)?;
    }
    log::info!("trash purge: {} list(s)", ready.len());
    Ok(ready)
}
