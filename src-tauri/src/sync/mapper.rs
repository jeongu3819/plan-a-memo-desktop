//! Sync Mapper — Desktop 도메인(로컬 SQLite) ↔ memo-sync-v1 전송 형식.
//!
//! ```text
//! 로컬 문서(documents · memo_items · attachments)         서버 문서(WireDocument / PushItem)
//!   memo_items.id (UUID)              ↔ sync_item_map ↔   personal_memos.id (정수) / client_key
//!   section main|am|pm / next         ↔                   main|am|pm / main(NEXT_LIST)
//!   <img src="attachment://<id>">     ↔ sync_attachment_map ↔ <img src="/api/personal-memos/images/<name>/download">
//!   favorite                          ✕ (보내지 않는다 — Contract 에 없음)
//! ```
//! 로컬 id 를 서버 id 로 바꾸지 않는다. 서버 주소·서버 id 는 로컬 본문(HTML)에 저장하지 않는다.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::contract::*;
use crate::error::{AppError, AppResult};
use crate::memo::{repo, DocKind, DocumentInfo, DocumentSnapshot, SnapshotItem};
use crate::util::{new_id, now};

const LOCAL_PREFIX: &str = "attachment://";

pub fn server_section(kind: DocKind, local: &str) -> String {
    match kind {
        DocKind::NextList => "main".into(),
        DocKind::Day => local.into(),
    }
}

pub fn local_section(kind: DocKind, server: &str) -> String {
    match kind {
        DocKind::NextList => "next".into(),
        DocKind::Day => match server {
            "am" | "pm" => server.into(),
            _ => "main".into(),
        },
    }
}

pub fn unit_of(doc: &DocumentInfo) -> (UnitType, String) {
    match doc.kind {
        DocKind::Day => (UnitType::Day, doc.memo_date.clone().unwrap_or_default()),
        DocKind::NextList => {
            let list = doc.next_list_id.clone().unwrap_or_default();
            (UnitType::NextList, if list == crate::memo::DEFAULT_LIST_ID { "default".into() } else { list })
        }
    }
}

// ── 이미지 ──────────────────────────────────────────────────────────────

pub fn server_name_for(conn: &Connection, account_key: &str, attachment_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT server_name FROM sync_attachment_map WHERE attachment_id = ?1 AND account_key = ?2",
            params![attachment_id, account_key],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn local_attachment_for(conn: &Connection, account_key: &str, server_name: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT attachment_id FROM sync_attachment_map WHERE account_key = ?1 AND server_name = ?2",
            params![account_key, server_name],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn remember_attachment(
    conn: &Connection,
    attachment_id: &str,
    account_key: &str,
    server_name: &str,
    sha256: Option<&str>,
) -> AppResult<()> {
    conn.execute("DELETE FROM sync_attachment_map WHERE account_key = ?1 AND server_name = ?2", params![account_key, server_name])?;
    conn.execute(
        "INSERT INTO sync_attachment_map (attachment_id, account_key, server_name, server_sha256, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(attachment_id, account_key) DO UPDATE SET server_name = excluded.server_name, server_sha256 = excluded.server_sha256",
        params![attachment_id, account_key, server_name, sha256, now()],
    )?;
    Ok(())
}

/// 이 문서 본문이 참조하는 로컬 첨부 중 아직 서버 이름이 없는 것(업로드할 것).
pub fn attachments_to_upload(conn: &Connection, doc: &DocumentInfo, account_key: &str) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for item in repo::items_of(conn, &doc.id)? {
        for id in crate::memo::text::attachment_ids(&item.content_html) {
            if !out.contains(&id) && server_name_for(conn, account_key, &id)?.is_none() {
                out.push(id);
            }
        }
    }
    Ok(out)
}

/// 서버 문서가 참조하는 이미지 중 이 PC 에 (파일까지) 없는 것 — 내려받을 것.
pub fn attachments_to_download(
    conn: &Connection,
    paths: &crate::storage::StoragePaths,
    account_key: &str,
    names: &[WireAttachment],
) -> AppResult<Vec<WireAttachment>> {
    let mut out = Vec::new();
    for entry in names {
        let present = match local_attachment_for(conn, account_key, &entry.name)? {
            Some(local) => crate::attachments::read_bytes(conn, paths, &local).is_ok(),
            None => false,
        };
        if !present {
            out.push(entry.clone());
        }
    }
    Ok(out)
}

/// 본문 이름 목록에서 만든 manifest(Web 제안처럼 attachments 가 비어 올 수 있는 경우).
pub fn manifest_from_items(items: &[WireItem]) -> Vec<WireAttachment> {
    let mut names: Vec<String> = items.iter().flat_map(|i| image_names(&i.content)).collect();
    names.sort();
    names.dedup();
    names.into_iter().map(|name| WireAttachment { name, size: None, url: None, sha256: None }).collect()
}

fn to_server_html(conn: &Connection, account_key: &str, html: &str) -> AppResult<String> {
    let mut out = html.to_string();
    for id in crate::memo::text::attachment_ids(html) {
        let name = server_name_for(conn, account_key, &id)?
            .ok_or_else(|| AppError::new("sync_attachment_missing", "이미지를 먼저 올리지 못했습니다. 잠시 뒤 다시 보냅니다."))?;
        // attachment://<id> 는 대소문자 섞임 없이 저장된다(attachments::import_bytes).
        out = out.replace(&format!("{LOCAL_PREFIX}{id}"), &image_url(&name));
    }
    Ok(out)
}

fn to_local_html(conn: &Connection, account_key: &str, html: &str) -> AppResult<String> {
    let mut out = html.to_string();
    for name in image_names(html) {
        let local = local_attachment_for(conn, account_key, &name)?
            .ok_or_else(|| AppError::new("sync_attachment_missing", "PLAN-A Work 이미지를 아직 내려받지 못했습니다."))?;
        out = out.replace(&image_url(&name), &format!("{LOCAL_PREFIX}{local}"));
    }
    Ok(out)
}

// ── 항목 매핑 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MapRow {
    item_id: String,
    server_item_id: Option<i64>,
    client_key: Option<String>,
    item_version: Option<i64>,
}

fn map_rows(conn: &Connection, doc_id: &str, account_key: &str) -> AppResult<Vec<MapRow>> {
    let mut stmt = conn.prepare(
        "SELECT item_id, server_item_id, client_key, item_version FROM sync_item_map WHERE document_id = ?1 AND account_key = ?2",
    )?;
    let rows = stmt
        .query_map(params![doc_id, account_key], |r| {
            Ok(MapRow { item_id: r.get(0)?, server_item_id: r.get(1)?, client_key: r.get(2)?, item_version: r.get(3)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 새 client_key — 서버 권장대로 소문자 UUID(8–64자 규칙 안). 로컬 id 와 별개(같은 로컬 항목이 다른 문서로 가면 새 key).
/// 이미 보낸 key(예전 32자 hex)는 그대로 쓴다. 서버 저장소는 대소문자를 구분하므로 대소문자만 다른 key 를 만들지 않는다.
fn new_client_key() -> String {
    new_id().to_ascii_lowercase()
}

pub struct PushPlan {
    pub deleted: bool,
    pub items: Vec<PushItem>,
}

/// 로컬 문서 → Push 항목(문서 전체). 새 항목의 client_key 는 같은 transaction 에서 sync_item_map 에 남긴다
/// — 응답을 잃어도 같은 key 로 다시 보낸다.
pub fn build_push(conn: &Connection, doc: &DocumentInfo, account_key: &str) -> AppResult<PushPlan> {
    let snapshot = repo::build_snapshot(conn, doc, false)?;
    if snapshot.deleted {
        return Ok(PushPlan { deleted: true, items: Vec::new() });
    }
    let rows: HashMap<String, MapRow> = map_rows(conn, &doc.id, account_key)?.into_iter().map(|r| (r.item_id.clone(), r)).collect();
    let mut per_section: HashMap<String, i64> = HashMap::new();
    let mut items = Vec::new();
    let mut total = 0usize;
    for item in &snapshot.items {
        let section = server_section(doc.kind, &item.section);
        let order = per_section.entry(section.clone()).or_insert(0);
        let content = to_server_html(conn, account_key, &item.content_html)?;
        if content.chars().count() > MAX_ITEM_CHARS {
            return Err(AppError::new("sync_too_large", "메모 하나가 PLAN-A Work 의 최대 크기(50만 자)를 넘습니다."));
        }
        total += content.len();
        let (id, item_version, client_key) = match rows.get(&item.item_key) {
            Some(MapRow { server_item_id: Some(id), item_version, .. }) => (Some(*id), *item_version, None),
            Some(MapRow { client_key: Some(key), .. }) => (None, None, Some(key.clone())),
            _ => {
                let key = new_client_key();
                conn.execute(
                    "INSERT INTO sync_item_map (document_id, item_id, account_key, client_key) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(document_id, item_id) DO UPDATE SET account_key = excluded.account_key, client_key = excluded.client_key,
                         server_item_id = NULL, item_version = NULL",
                    params![doc.id, item.item_key, account_key, key],
                )?;
                (None, None, Some(key))
            }
        };
        items.push(PushItem {
            id,
            item_version,
            client_key,
            section,
            kind: item.kind.clone(),
            content,
            completed: item.kind == "checklist" && item.completed,
            sort_order: *order,
        });
        *order += 1;
    }
    if items.len() > MAX_ITEMS {
        return Err(AppError::new("sync_too_large", "한 날짜/List 의 메모가 PLAN-A Work 최대 개수(1,000개)를 넘습니다."));
    }
    if total > MAX_DOCUMENT_BYTES {
        return Err(AppError::new("sync_too_large", "한 날짜/List 의 내용이 PLAN-A Work 최대 크기(2MB)를 넘습니다."));
    }
    Ok(PushPlan { deleted: false, items })
}

/// 서버가 받아 준(또는 내려준) 문서로 이 문서의 매핑을 다시 쓴다.
/// 로컬 항목 ↔ 서버 항목은 (1) 서버 id (2) 우리가 보낸 client_key 로 맞춘다. 서버에 없는 매핑은 지운다.
pub fn adopt_server_ids(conn: &Connection, doc_id: &str, account_key: &str, server: &[WireItem]) -> AppResult<()> {
    let rows = map_rows(conn, doc_id, account_key)?;
    let mut by_id: HashMap<i64, String> = HashMap::new();
    let mut by_key: HashMap<String, String> = HashMap::new();
    for row in &rows {
        if let Some(id) = row.server_item_id {
            by_id.insert(id, row.item_id.clone());
        }
        if let Some(key) = &row.client_key {
            by_key.insert(key.clone(), row.item_id.clone());
        }
    }
    let mut keep: Vec<(String, i64, Option<String>, Option<i64>)> = Vec::new();
    for item in server {
        let Some(server_id) = item.id else { continue };
        let local = by_id.get(&server_id).or_else(|| item.client_key.as_ref().and_then(|k| by_key.get(k))).cloned();
        if let Some(local) = local {
            keep.push((local, server_id, item.client_key.clone(), item.item_version));
        }
    }
    conn.execute("DELETE FROM sync_item_map WHERE document_id = ?1", [doc_id])?;
    for (local, server_id, client_key, version) in keep {
        write_map(conn, doc_id, &local, account_key, server_id, client_key.as_deref(), version)?;
    }
    Ok(())
}

fn write_map(
    conn: &Connection,
    doc_id: &str,
    item_id: &str,
    account_key: &str,
    server_id: i64,
    client_key: Option<&str>,
    version: Option<i64>,
) -> AppResult<()> {
    // 같은 서버 항목을 가리키던 다른 문서의 매핑은 옛 위치다(서버에서 옮겨 왔다).
    conn.execute(
        "DELETE FROM sync_item_map WHERE account_key = ?1 AND server_item_id = ?2 AND document_id <> ?3",
        params![account_key, server_id, doc_id],
    )?;
    if let Some(key) = client_key {
        conn.execute(
            "UPDATE sync_item_map SET client_key = NULL WHERE account_key = ?1 AND client_key = ?2 AND NOT (document_id = ?3 AND item_id = ?4)",
            params![account_key, key, doc_id, item_id],
        )?;
    }
    conn.execute(
        "INSERT INTO sync_item_map (document_id, item_id, account_key, server_item_id, client_key, item_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(document_id, item_id) DO UPDATE SET account_key = excluded.account_key, server_item_id = excluded.server_item_id,
             client_key = excluded.client_key, item_version = excluded.item_version",
        params![doc_id, item_id, account_key, server_id, client_key, version],
    )?;
    Ok(())
}

/// 서버 항목을 어느 로컬 항목으로 받을지 — 같은 문서·삭제된 항목·같은 계정으로 연결된 문서의 항목이면
/// 같은 로컬 id(즐겨찾기·History 유지). 연결 안 된 문서에 따로 있는 로컬 항목은 건드리지 않는다(새 id).
fn local_id_for(conn: &Connection, doc: &DocumentInfo, account_key: &str, item: &WireItem) -> AppResult<String> {
    let candidates: Vec<String> = {
        let mut out = Vec::new();
        if let Some(id) = item.id {
            let mut stmt = conn.prepare("SELECT item_id FROM sync_item_map WHERE account_key = ?1 AND server_item_id = ?2")?;
            out.extend(stmt.query_map(params![account_key, id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?);
        }
        if let Some(key) = &item.client_key {
            let found: Option<String> = conn
                .query_row("SELECT item_id FROM sync_item_map WHERE account_key = ?1 AND client_key = ?2", params![account_key, key], |r| {
                    r.get(0)
                })
                .optional()?;
            out.extend(found);
        }
        out
    };
    for local in candidates {
        let owner: Option<(String, Option<String>)> = conn
            .query_row("SELECT document_id, deleted_at FROM memo_items WHERE id = ?1", [&local], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let ok = match owner {
            None => true, // 로컬 행이 없다 — 이 id 로 새로 만든다
            Some((owner_doc, deleted)) => {
                owner_doc == doc.id
                    || deleted.is_some()
                    || conn
                        .query_row(
                            "SELECT 1 FROM documents d JOIN sync_links l ON l.document_id = d.id
                              WHERE d.id = ?1 AND d.sync_enabled = 1 AND l.account_key = ?2",
                            params![owner_doc, account_key],
                            |r| r.get::<_, i64>(0),
                        )
                        .optional()?
                        .is_some()
            }
        };
        if ok {
            return Ok(local);
        }
    }
    Ok(new_id())
}

/// 서버 문서 → 로컬 Snapshot(이미지는 미리 내려받아 sync_attachment_map 에 있어야 한다) + 매핑 목록.
pub struct LocalForm {
    pub snapshot: DocumentSnapshot,
    pub mapping: Vec<(String, i64, Option<String>, Option<i64>)>,
}

pub fn to_local(conn: &Connection, doc: &DocumentInfo, account_key: &str, deleted: bool, items: &[WireItem]) -> AppResult<LocalForm> {
    let current: HashMap<String, (bool, Option<String>)> =
        repo::items_of(conn, &doc.id)?.into_iter().map(|i| (i.id, (i.completed, i.completed_at))).collect();
    let mut ordered: Vec<&WireItem> = items.iter().collect();
    ordered.sort_by_key(|a| (section_rank(&a.section), a.sort_order, a.id));
    let mut out = Vec::new();
    let mut mapping = Vec::new();
    let mut used = HashSet::new();
    let mut per_section: HashMap<String, i64> = HashMap::new();
    for item in ordered {
        let mut local = local_id_for(conn, doc, account_key, item)?;
        if !used.insert(local.clone()) {
            local = new_id();
            used.insert(local.clone());
        }
        let section = local_section(doc.kind, &item.section);
        let order = per_section.entry(section.clone()).or_insert(0);
        let completed = item.kind == "checklist" && item.completed;
        let completed_at = match current.get(&local) {
            Some((was, at)) if *was == completed => at.clone(),
            _ => completed.then(now),
        };
        out.push(SnapshotItem {
            item_key: local.clone(),
            section,
            kind: if item.kind == "text" { "text".into() } else { "checklist".into() },
            content_html: to_local_html(conn, account_key, &item.content)?,
            completed,
            completed_at,
            sort_order: *order,
            favorite: None,
        });
        *order += 1;
        if let Some(id) = item.id {
            mapping.push((local, id, item.client_key.clone(), item.item_version));
        }
    }
    let list = match doc.kind {
        DocKind::NextList => repo::build_snapshot(conn, doc, false)?.list,
        DocKind::Day => None,
    };
    Ok(LocalForm { snapshot: DocumentSnapshot { kind: doc.kind, memo_date: doc.memo_date.clone(), list, deleted, items: out }, mapping })
}

/// 서버 내용을 로컬 문서에 적용(History 를 먼저 남긴다). 매핑도 함께 바꾼다 — 같은 transaction 에서 부른다.
pub fn apply_to_local(
    conn: &Connection,
    doc: &DocumentInfo,
    account_key: &str,
    form: &LocalForm,
    history_reason: Option<&str>,
) -> AppResult<()> {
    if let Some(reason) = history_reason {
        repo::record_version(conn, &doc.id, reason)?;
    }
    repo::replace_items(conn, doc, &form.snapshot.items, true, true)?;
    conn.execute("DELETE FROM sync_item_map WHERE document_id = ?1", [&doc.id])?;
    for (local, server_id, key, version) in &form.mapping {
        write_map(conn, &doc.id, local, account_key, *server_id, key.as_deref(), *version)?;
    }
    Ok(())
}

fn section_rank(section: &str) -> u8 {
    match section {
        "main" => 0,
        "am" => 1,
        "pm" => 2,
        _ => 3,
    }
}

/// (구역, 정렬 번호, 서버 id, 유형, 본문, 체크)
pub type DigestRow = (String, i64, Option<i64>, String, String, bool);

/// 내용 비교용 digest — id·정렬 숫자 값과 무관하게 (구역별 순서, 유형, 본문, 체크)만 본다.
pub fn digest_of(deleted: bool, items: impl IntoIterator<Item = DigestRow>) -> String {
    type Ordered = (i64, i64, String, String, bool);
    let mut sections: BTreeMap<String, Vec<Ordered>> = BTreeMap::new();
    for (section, order, id, kind, content, completed) in items {
        sections.entry(section).or_default().push((order, id.unwrap_or(i64::MAX), kind, content, completed));
    }
    let normalized: BTreeMap<String, Vec<(String, String, bool)>> = sections
        .into_iter()
        .map(|(section, mut list)| {
            list.sort_by_key(|a| (a.0, a.1));
            (section, list.into_iter().map(|(_, _, kind, content, completed)| (kind, content, completed)).collect())
        })
        .collect();
    crate::util::sha256_hex(serde_json::to_string(&(deleted, normalized)).unwrap_or_default().as_bytes())
}

pub fn digest_wire(deleted: bool, items: &[WireItem]) -> String {
    digest_of(
        deleted,
        items
            .iter()
            .map(|i| (i.section.clone(), i.sort_order, i.id, i.kind.clone(), i.content.clone(), i.kind == "checklist" && i.completed)),
    )
}

pub fn digest_push(plan: &PushPlan) -> String {
    digest_of(
        plan.deleted,
        plan.items.iter().map(|i| (i.section.clone(), i.sort_order, i.id, i.kind.clone(), i.content.clone(), i.completed)),
    )
}

/// 같은 내용이면 서버 항목 id 를 순서대로 로컬 항목에 붙인다(처음 연결했는데 양쪽 내용이 같을 때).
pub fn adopt_positionally(conn: &Connection, doc: &DocumentInfo, account_key: &str, server: &[WireItem]) -> AppResult<()> {
    let local = repo::items_of(conn, &doc.id)?;
    let mut ordered: Vec<&WireItem> = server.iter().collect();
    ordered.sort_by_key(|a| (section_rank(&a.section), a.sort_order, a.id));
    conn.execute("DELETE FROM sync_item_map WHERE document_id = ?1", [&doc.id])?;
    for (item, wire) in local.iter().zip(ordered) {
        if let Some(id) = wire.id {
            write_map(conn, &doc.id, &item.id, account_key, id, wire.client_key.as_deref(), wire.item_version)?;
        }
    }
    Ok(())
}

/// ACK 할 이미지 이름 — 지금 로컬 본문이 참조하는 첨부의 서버 이름(파일이 실제로 있어야 한다).
pub fn ack_manifest(
    conn: &Connection,
    paths: &crate::storage::StoragePaths,
    doc: &DocumentInfo,
    account_key: &str,
) -> AppResult<Option<Vec<String>>> {
    let mut names = Vec::new();
    for item in repo::items_of(conn, &doc.id)? {
        for id in crate::memo::text::attachment_ids(&item.content_html) {
            let Some(name) = server_name_for(conn, account_key, &id)? else { return Ok(None) };
            if crate::attachments::read_bytes(conn, paths, &id).is_err() {
                return Ok(None); // 파일이 없으면 ACK 하지 않는다
            }
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names.sort();
    Ok(Some(names))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_map_between_desktop_and_server() {
        assert_eq!(server_section(DocKind::Day, "am"), "am");
        assert_eq!(server_section(DocKind::NextList, "next"), "main");
        assert_eq!(local_section(DocKind::NextList, "main"), "next");
        assert_eq!(local_section(DocKind::Day, "pm"), "pm");
        assert_eq!(local_section(DocKind::Day, "weird"), "main");
    }

    #[test]
    fn digest_ignores_ids_and_order_numbers_but_not_content() {
        let a = digest_of(
            false,
            vec![
                ("main".into(), 5, Some(9), "checklist".into(), "A".into(), false),
                ("am".into(), 0, None, "text".into(), "B".into(), false),
            ],
        );
        let b = digest_of(
            false,
            vec![
                ("am".into(), 7, Some(1), "text".into(), "B".into(), false),
                ("main".into(), 1, None, "checklist".into(), "A".into(), false),
            ],
        );
        assert_eq!(a, b);
        let c = digest_of(
            false,
            vec![("main".into(), 0, None, "checklist".into(), "A".into(), true), ("am".into(), 0, None, "text".into(), "B".into(), false)],
        );
        assert_ne!(a, c);
        assert_ne!(digest_of(true, Vec::new()), digest_of(false, Vec::new()));
    }
}
