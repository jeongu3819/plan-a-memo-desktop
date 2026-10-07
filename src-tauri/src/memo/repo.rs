//! 저수준 조회·문서 갱신 도우미. 모두 호출자가 연 transaction(&Connection) 안에서 쓴다.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{DocKind, DocumentInfo, DocumentSnapshot, ListMeta, Location, MemoItem, NextListInfo, SnapshotItem, DEFAULT_LIST_ID};
use crate::error::{AppError, AppResult};
use crate::util::{new_id, now};

pub const SECTION_RANK_SQL: &str = "CASE section WHEN 'main' THEN 0 WHEN 'am' THEN 1 WHEN 'pm' THEN 2 ELSE 3 END";

const DOC_COLUMNS: &str = "d.id, d.kind, d.memo_date, d.next_list_id, d.local_revision, d.synced_revision,
    d.server_version, d.sync_enabled, d.sync_status, d.sync_error, d.updated_at,
    EXISTS(SELECT 1 FROM conflicts c WHERE c.document_id = d.id AND c.status = 'open')";

fn doc_from_row(row: &Row) -> rusqlite::Result<DocumentInfo> {
    Ok(DocumentInfo {
        id: row.get(0)?,
        kind: DocKind::parse(&row.get::<_, String>(1)?),
        memo_date: row.get(2)?,
        next_list_id: row.get(3)?,
        local_revision: row.get(4)?,
        synced_revision: row.get(5)?,
        server_version: row.get(6)?,
        sync_enabled: row.get::<_, i64>(7)? == 1,
        sync_status: row.get(8)?,
        sync_error: row.get(9)?,
        updated_at: row.get(10)?,
        has_conflict: row.get::<_, i64>(11)? == 1,
    })
}

pub const ITEM_COLUMNS: &str = "id, document_id, section, kind, content_html, completed, completed_at,
    favorite, sort_order, created_at, updated_at";

pub fn item_from_row(row: &Row) -> rusqlite::Result<MemoItem> {
    Ok(MemoItem {
        id: row.get(0)?,
        document_id: row.get(1)?,
        section: row.get(2)?,
        kind: row.get(3)?,
        content_html: row.get(4)?,
        completed: row.get::<_, i64>(5)? == 1,
        completed_at: row.get(6)?,
        favorite: row.get::<_, i64>(7)? == 1,
        sort_order: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn doc_by_id(conn: &Connection, id: &str) -> AppResult<Option<DocumentInfo>> {
    Ok(conn.query_row(&format!("SELECT {DOC_COLUMNS} FROM documents d WHERE d.id = ?1"), [id], doc_from_row).optional()?)
}

pub fn doc_for_location(conn: &Connection, location: &Location) -> AppResult<Option<DocumentInfo>> {
    Ok(match location {
        Location::Day { date } => conn
            .query_row(&format!("SELECT {DOC_COLUMNS} FROM documents d WHERE d.kind = 'DAY' AND d.memo_date = ?1"), [date], doc_from_row)
            .optional()?,
        Location::Next { list_id } => {
            let list_id = list_id.as_deref().unwrap_or(DEFAULT_LIST_ID);
            conn.query_row(
                &format!("SELECT {DOC_COLUMNS} FROM documents d WHERE d.kind = 'NEXT_LIST' AND d.next_list_id = ?1"),
                [list_id],
                doc_from_row,
            )
            .optional()?
        }
    })
}

pub fn validate_location(conn: &Connection, location: &Location) -> AppResult<()> {
    match location {
        Location::Day { date } => {
            if !crate::util::is_date(date) {
                return Err(AppError::validation("날짜 형식이 올바르지 않습니다."));
            }
        }
        Location::Next { list_id } => {
            let id = list_id.as_deref().unwrap_or(DEFAULT_LIST_ID);
            let alive: Option<i64> =
                conn.query_row("SELECT 1 FROM next_lists WHERE id = ?1 AND deleted_at IS NULL", [id], |r| r.get(0)).optional()?;
            if alive.is_none() {
                return Err(AppError::not_found("List"));
            }
        }
    }
    Ok(())
}

/// 문서가 없으면 만든다(빈 날짜는 문서가 없다 — 처음 쓰는 순간 생긴다).
pub fn ensure_doc(conn: &Connection, location: &Location) -> AppResult<DocumentInfo> {
    if let Some(doc) = doc_for_location(conn, location)? {
        if doc.kind == DocKind::NextList {
            // 삭제된 List 의 문서를 다시 쓰지 않는다.
            validate_location(conn, location)?;
        }
        return Ok(doc);
    }
    validate_location(conn, location)?;
    let id = new_id();
    let ts = now();
    match location {
        Location::Day { date } => conn.execute(
            "INSERT INTO documents (id, kind, memo_date, created_at, updated_at) VALUES (?1, 'DAY', ?2, ?3, ?3)",
            params![id, date, ts],
        )?,
        Location::Next { list_id } => conn.execute(
            "INSERT INTO documents (id, kind, next_list_id, created_at, updated_at) VALUES (?1, 'NEXT_LIST', ?2, ?3, ?3)",
            params![id, list_id.as_deref().unwrap_or(DEFAULT_LIST_ID), ts],
        )?,
    };
    doc_by_id(conn, &id)?.ok_or_else(|| AppError::not_found("문서"))
}

pub fn location_of_doc(doc: &DocumentInfo) -> Location {
    match doc.kind {
        DocKind::Day => Location::Day { date: doc.memo_date.clone().unwrap_or_default() },
        DocKind::NextList => Location::Next { list_id: doc.next_list_id.clone().filter(|id| id != DEFAULT_LIST_ID) },
    }
}

pub fn items_of(conn: &Connection, doc_id: &str) -> AppResult<Vec<MemoItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM memo_items WHERE document_id = ?1 AND deleted_at IS NULL
         ORDER BY {SECTION_RANK_SQL}, sort_order, created_at"
    ))?;
    let items = stmt.query_map([doc_id], item_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

pub fn item_by_id(conn: &Connection, id: &str, include_deleted: bool) -> AppResult<Option<MemoItem>> {
    let sql =
        format!("SELECT {ITEM_COLUMNS} FROM memo_items WHERE id = ?1 {}", if include_deleted { "" } else { "AND deleted_at IS NULL" });
    Ok(conn.query_row(&sql, [id], item_from_row).optional()?)
}

pub fn require_item(conn: &Connection, id: &str) -> AppResult<MemoItem> {
    item_by_id(conn, id, false)?.ok_or_else(|| AppError::not_found("메모"))
}

pub fn next_sort_order(conn: &Connection, doc_id: &str, section: &str) -> AppResult<i64> {
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(sort_order) FROM memo_items WHERE document_id = ?1 AND section = ?2 AND deleted_at IS NULL",
        params![doc_id, section],
        |r| r.get(0),
    )?;
    Ok(max.map(|m| m + 1).unwrap_or(0))
}

pub fn list_info(conn: &Connection, list_id: &str) -> AppResult<NextListInfo> {
    let row = conn
        .query_row(
            "SELECT l.id, l.name, l.is_default, l.sort_order,
                    (SELECT COUNT(*) FROM memo_items i JOIN documents d ON d.id = i.document_id
                      WHERE d.kind = 'NEXT_LIST' AND d.next_list_id = l.id AND i.deleted_at IS NULL)
               FROM next_lists l WHERE l.id = ?1 AND l.deleted_at IS NULL",
            [list_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? == 1, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("List"))?;
    let document = doc_for_location(conn, &Location::Next { list_id: Some(row.0.clone()) })?;
    Ok(NextListInfo { id: row.0, name: row.1, is_default: row.2, sort_order: row.3, item_count: row.4, document })
}

pub fn list_name(conn: &Connection, list_id: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT name FROM next_lists WHERE id = ?1", [list_id], |r| r.get(0)).optional()?)
}

/// 문서 전체 Snapshot(삭제되지 않은 항목).
pub fn build_snapshot(conn: &Connection, doc: &DocumentInfo, include_favorite: bool) -> AppResult<DocumentSnapshot> {
    let items = items_of(conn, &doc.id)?
        .into_iter()
        .map(|item| SnapshotItem {
            item_key: item.id,
            section: item.section,
            kind: item.kind,
            content_html: item.content_html,
            completed: item.completed,
            completed_at: item.completed_at,
            sort_order: item.sort_order,
            favorite: include_favorite.then_some(item.favorite),
        })
        .collect();
    let list = match (&doc.kind, &doc.next_list_id) {
        (DocKind::NextList, Some(list_id)) => conn
            .query_row("SELECT name, is_default, sort_order, deleted_at IS NOT NULL FROM next_lists WHERE id = ?1", [list_id], |r| {
                Ok((ListMeta { name: r.get(0)?, is_default: r.get::<_, i64>(1)? == 1, sort_order: r.get(2)? }, r.get::<_, bool>(3)?))
            })
            .optional()?,
        _ => None,
    };
    let list_deleted = list.as_ref().map(|(_, deleted)| *deleted).unwrap_or(false);
    let deleted: bool = conn.query_row("SELECT deleted_at IS NOT NULL FROM documents WHERE id = ?1", [&doc.id], |r| r.get(0))?;
    Ok(DocumentSnapshot {
        kind: doc.kind,
        memo_date: doc.memo_date.clone(),
        list: list.map(|(meta, _)| meta),
        deleted: deleted || list_deleted,
        items,
    })
}

/// 로컬 변경 1회 — revision +1, (연결된 문서면) 같은 transaction 에서 Outbox 에 남긴다.
pub fn touch(conn: &Connection, doc_id: &str) -> AppResult<i64> {
    let ts = now();
    conn.execute("UPDATE documents SET local_revision = local_revision + 1, updated_at = ?2 WHERE id = ?1", params![doc_id, ts])?;
    let (revision, sync_enabled, status): (i64, i64, String) =
        conn.query_row("SELECT local_revision, sync_enabled, sync_status FROM documents WHERE id = ?1", [doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    if sync_enabled == 1 {
        let linked: Option<Option<String>> =
            conn.query_row("SELECT server_document_id FROM sync_links WHERE document_id = ?1", [doc_id], |r| r.get(0)).optional()?;
        // 서버 문서가 아직 없으면(첫 연결 대기) LINK 가 최신 내용을 보낸다.
        let op = if matches!(linked, Some(Some(_))) { "PUSH" } else { "LINK" };
        enqueue(conn, doc_id, op, revision, None)?;
        if status != "conflict" && status != "auth_required" {
            conn.execute("UPDATE documents SET sync_status = 'pending', sync_error = NULL WHERE id = ?1", [doc_id])?;
        }
    }
    Ok(revision)
}

/// Outbox 에 문서·작업당 1건 — 이미 있으면 최신 revision 으로 바꾸고 재시도 상태를 초기화한다.
pub fn enqueue(conn: &Connection, doc_id: &str, op: &str, revision: i64, payload: Option<&str>) -> AppResult<()> {
    let key = format!("{doc_id}:{op}:{revision}:{}", new_id());
    conn.execute(
        "INSERT INTO sync_outbox (document_id, op, local_revision, idempotency_key, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(document_id, op) DO UPDATE SET
            local_revision = excluded.local_revision,
            idempotency_key = excluded.idempotency_key,
            payload = COALESCE(excluded.payload, sync_outbox.payload),
            attempts = 0, next_attempt_at = NULL, last_error = NULL",
        params![doc_id, op, revision, key, payload, now()],
    )?;
    Ok(())
}

/// 같은 편집이 이어질 때 History 를 매번 남기지 않는 간격.
pub const EDIT_COALESCE_SECONDS: i64 = 300;
pub const MAX_VERSIONS_PER_DOCUMENT: i64 = 200;

/// 변경 **전** 상태를 History 로 남긴다. 편집(edit)은 5분에 한 번으로 합치고,
/// 삭제·이동·충돌·복원 같은 중요한 변경은 항상 남긴다. 직전 기록과 같으면 남기지 않는다.
pub fn record_version(conn: &Connection, doc_id: &str, reason: &str) -> AppResult<Option<i64>> {
    let Some(doc) = doc_by_id(conn, doc_id)? else { return Ok(None) };
    let snapshot = build_snapshot(conn, &doc, true)?;
    let always = !matches!(reason, "edit" | "remote_apply");
    if snapshot.items.is_empty() && !reason.starts_with("conflict") {
        return Ok(None);
    }
    let json = serde_json::to_string(&snapshot)?;
    let last: Option<(String, String, String)> = conn
        .query_row(
            "SELECT snapshot_json, reason, created_at FROM document_versions WHERE document_id = ?1 ORDER BY id DESC LIMIT 1",
            [doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((last_json, last_reason, created_at)) = &last {
        if *last_json == json {
            return Ok(None);
        }
        if !always && last_reason == reason {
            let recent = chrono::DateTime::parse_from_rfc3339(created_at)
                .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds() < EDIT_COALESCE_SECONDS)
                .unwrap_or(false);
            if recent {
                return Ok(None);
            }
        }
    }
    conn.execute(
        "INSERT INTO document_versions (document_id, reason, local_revision, snapshot_json, content_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![doc_id, reason, doc.local_revision, json, snapshot.text(), now()],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "DELETE FROM document_versions WHERE document_id = ?1 AND id NOT IN
           (SELECT id FROM document_versions WHERE document_id = ?1 ORDER BY id DESC LIMIT ?2)",
        params![doc_id, MAX_VERSIONS_PER_DOCUMENT],
    )?;
    Ok(Some(id))
}

/// 본문이 참조하는 첨부를 그 항목·문서에 묶는다(다른 항목으로 옮겨 붙여도 마지막 참조가 주인).
pub fn link_attachments(conn: &Connection, item: &MemoItem) -> AppResult<()> {
    for id in super::text::attachment_ids(&item.content_html) {
        conn.execute("UPDATE attachments SET item_id = ?2, document_id = ?3 WHERE id = ?1", params![id, item.id, item.document_id])?;
    }
    Ok(())
}

/// Snapshot 의 항목들로 문서 내용을 바꾼다(History 복원 · 원격 적용 · Conflict 해결 공용).
/// `keep_favorites` 면 같은 key 항목의 로컬 즐겨찾기를 유지한다.
/// 다른 문서에 살아 있는 key 는 `move_foreign` 이 true 면 이 문서로 옮기고, 아니면 새 id 로 복사한다.
pub fn replace_items(
    conn: &Connection,
    doc: &DocumentInfo,
    items: &[SnapshotItem],
    keep_favorites: bool,
    move_foreign: bool,
) -> AppResult<()> {
    let ts = now();
    let mut kept: Vec<String> = Vec::new();
    for item in items {
        if !super::valid_section_for(doc.kind, &item.section) {
            continue;
        }
        let existing: Option<(String, Option<String>, i64)> = conn
            .query_row("SELECT document_id, deleted_at, favorite FROM memo_items WHERE id = ?1", [&item.item_key], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let mut target_id = item.item_key.clone();
        let favorite = |current: i64| -> i64 {
            if keep_favorites {
                current
            } else {
                item.favorite.map(|f| f as i64).unwrap_or(current)
            }
        };
        let text = super::text::search_text(&item.content_html);
        match existing {
            Some((owner, deleted_at, current_fav)) if owner == doc.id || deleted_at.is_some() || move_foreign => {
                conn.execute(
                    "UPDATE memo_items SET document_id = ?2, section = ?3, kind = ?4, content_html = ?5, content_text = ?6,
                            completed = ?7, completed_at = ?8, sort_order = ?9, favorite = ?10, deleted_at = NULL, updated_at = ?11
                      WHERE id = ?1",
                    params![
                        item.item_key,
                        doc.id,
                        item.section,
                        item.kind,
                        item.content_html,
                        text,
                        item.completed as i64,
                        item.completed_at,
                        item.sort_order,
                        favorite(current_fav),
                        ts
                    ],
                )?;
            }
            Some(_) => {
                // 다른 문서에서 쓰이는 key — 그 문서를 건드리지 않게 새 id 로 복사.
                target_id = new_id();
                conn.execute(
                    &format!(
                        "INSERT INTO memo_items ({ITEM_COLUMNS}, content_text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)"
                    ),
                    params![
                        target_id,
                        doc.id,
                        item.section,
                        item.kind,
                        item.content_html,
                        item.completed as i64,
                        item.completed_at,
                        item.favorite.unwrap_or(false) as i64,
                        item.sort_order,
                        ts,
                        text
                    ],
                )?;
            }
            None => {
                conn.execute(
                    &format!(
                        "INSERT INTO memo_items ({ITEM_COLUMNS}, content_text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)"
                    ),
                    params![
                        target_id,
                        doc.id,
                        item.section,
                        item.kind,
                        item.content_html,
                        item.completed as i64,
                        item.completed_at,
                        item.favorite.unwrap_or(false) as i64,
                        item.sort_order,
                        ts,
                        text
                    ],
                )?;
            }
        }
        if let Some(saved) = item_by_id(conn, &target_id, false)? {
            link_attachments(conn, &saved)?;
        }
        kept.push(target_id);
    }
    // Snapshot 에 없는 항목은 지운다(soft delete — History 에 남아 있다).
    let current = items_of(conn, &doc.id)?;
    for item in current.iter().filter(|i| !kept.contains(&i.id)) {
        conn.execute("UPDATE memo_items SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1", params![item.id, ts])?;
    }
    Ok(())
}
