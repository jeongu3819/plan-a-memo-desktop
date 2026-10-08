//! dayMemoService · nextListService — 화면 동작 하나 = transaction 하나.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::repo::{self, touch};
use super::{
    text, DayMemo, DocKind, LocatedItem, Location, MemoItem, NextListInfo, NextListMemo, WeekMemo, DEFAULT_LIST_ID, MAX_CONTENT_BYTES,
};
use crate::error::{AppError, AppResult};
use crate::util::{is_date, is_uuid, new_id, now};

// ── 읽기 ────────────────────────────────────────────────────────────────

pub fn get_day(conn: &Connection, date: &str) -> AppResult<DayMemo> {
    if !is_date(date) {
        return Err(AppError::validation("날짜 형식이 올바르지 않습니다."));
    }
    let document = repo::doc_for_location(conn, &Location::Day { date: date.to_string() })?;
    let items = match &document {
        Some(doc) => repo::items_of(conn, &doc.id)?,
        None => Vec::new(),
    };
    Ok(DayMemo { date: date.to_string(), document, items })
}

pub fn get_list(conn: &Connection, list_id: Option<&str>) -> AppResult<NextListMemo> {
    let id = list_id.unwrap_or(DEFAULT_LIST_ID);
    let list = repo::list_info(conn, id)?;
    let items = match &list.document {
        Some(doc) => repo::items_of(conn, &doc.id)?,
        None => Vec::new(),
    };
    Ok(NextListMemo { list, items })
}

pub fn get_week(conn: &Connection, monday: &str) -> AppResult<WeekMemo> {
    let start =
        chrono::NaiveDate::parse_from_str(monday, "%Y-%m-%d").map_err(|_| AppError::validation("날짜 형식이 올바르지 않습니다."))?;
    let days = (0..7)
        .map(|offset| get_day(conn, &(start + chrono::Duration::days(offset)).format("%Y-%m-%d").to_string()))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(WeekMemo { monday: monday.to_string(), days, next: get_list(conn, None)? })
}

pub fn lists(conn: &Connection) -> AppResult<Vec<NextListInfo>> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM next_lists WHERE deleted_at IS NULL ORDER BY is_default DESC, sort_order, created_at")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.iter().map(|id| repo::list_info(conn, id)).collect()
}

fn located(conn: &Connection, item: MemoItem) -> AppResult<LocatedItem> {
    let doc = repo::doc_by_id(conn, &item.document_id)?.ok_or_else(|| AppError::not_found("문서"))?;
    let location = repo::location_of_doc(&doc);
    let list_name = match doc.kind {
        DocKind::NextList => repo::list_name(conn, doc.next_list_id.as_deref().unwrap_or(DEFAULT_LIST_ID))?,
        DocKind::Day => None,
    };
    Ok(LocatedItem { item, location, list_name })
}

pub fn favorites(conn: &Connection) -> AppResult<Vec<LocatedItem>> {
    let items: Vec<MemoItem> = conn
        .prepare(&format!(
            "SELECT {} FROM memo_items WHERE favorite = 1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500",
            repo::ITEM_COLUMNS
        ))?
        .query_map([], repo::item_from_row)?
        .collect::<Result<_, _>>()?;
    items.into_iter().map(|item| located(conn, item)).collect()
}

/// 메모가 있는 지난 날짜(List 화면) — 최신순.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    pub date: String,
    pub item_count: i64,
    pub checklist_count: i64,
    pub done_count: i64,
    pub previews: Vec<String>,
    pub sync_enabled: bool,
}

pub fn days(conn: &Connection, before: Option<&str>, limit: i64) -> AppResult<Vec<DaySummary>> {
    let before = before.filter(|d| is_date(d)).unwrap_or("9999-12-31");
    let rows: Vec<(String, String, bool)> = conn
        .prepare(
            "SELECT d.id, d.memo_date, d.sync_enabled FROM documents d
              WHERE d.kind = 'DAY' AND d.memo_date < ?1
                AND EXISTS(SELECT 1 FROM memo_items i WHERE i.document_id = d.id AND i.deleted_at IS NULL)
              ORDER BY d.memo_date DESC LIMIT ?2",
        )?
        .query_map(params![before, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? == 1)))?
        .collect::<Result<_, _>>()?;
    rows.into_iter()
        .map(|(doc_id, date, sync_enabled)| {
            let items = repo::items_of(conn, &doc_id)?;
            let checklist: Vec<&MemoItem> = items.iter().filter(|i| i.kind == "checklist").collect();
            Ok(DaySummary {
                date,
                item_count: items.len() as i64,
                checklist_count: checklist.len() as i64,
                done_count: checklist.iter().filter(|i| i.completed).count() as i64,
                previews: items.iter().take(3).map(|i| text::search_text(&i.content_html).chars().take(80).collect()).collect(),
                sync_enabled,
            })
        })
        .collect()
}

// ── 항목 쓰기 ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateItem {
    /// 화면이 만든 UUID — 같은 요청이 두 번 와도 한 번만 만든다(중복 방지).
    pub id: String,
    pub location: Location,
    pub section: String,
    pub kind: String,
    pub content_html: String,
}

fn check_content(html: &str) -> AppResult<()> {
    if html.len() > MAX_CONTENT_BYTES {
        return Err(AppError::validation("메모가 너무 깁니다(2MB 제한). 내용을 나눠 주세요."));
    }
    let lower = html.to_ascii_lowercase();
    // 로컬 절대 경로·임시 주소를 저장하지 않는다(이미지는 attachment:// 로만).
    if lower.contains("src=\"file:") || lower.contains("src='file:") || lower.contains("src=\"blob:") {
        return Err(AppError::validation("이미지가 아직 저장되지 않았습니다. 잠시 후 다시 시도해주세요."));
    }
    Ok(())
}

fn check_kind(kind: &str) -> AppResult<()> {
    if matches!(kind, "checklist" | "text") {
        Ok(())
    } else {
        Err(AppError::validation("알 수 없는 메모 유형입니다."))
    }
}

pub fn create_item(conn: &mut Connection, input: CreateItem) -> AppResult<MemoItem> {
    if !is_uuid(&input.id) {
        return Err(AppError::validation("메모 id 가 올바르지 않습니다."));
    }
    check_kind(&input.kind)?;
    check_content(&input.content_html)?;
    let tx = conn.transaction()?;
    if let Some(existing) = repo::item_by_id(&tx, &input.id, true)? {
        return Ok(existing); // 이미 저장된 요청(재시도)
    }
    let doc = repo::ensure_doc(&tx, &input.location)?;
    if !super::valid_section_for(doc.kind, &input.section) {
        return Err(AppError::validation("이 위치에 쓸 수 없는 구역입니다."));
    }
    let ts = now();
    let order = repo::next_sort_order(&tx, &doc.id, &input.section)?;
    tx.execute(
        "INSERT INTO memo_items (id, document_id, section, kind, content_html, content_text, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![input.id, doc.id, input.section, input.kind, input.content_html, text::search_text(&input.content_html), order, ts],
    )?;
    let item = repo::require_item(&tx, &input.id)?;
    repo::link_attachments(&tx, &item)?;
    touch(&tx, &doc.id)?;
    tx.commit()?;
    Ok(item)
}

pub fn update_content(conn: &mut Connection, id: &str, html: &str) -> AppResult<MemoItem> {
    check_content(html)?;
    let tx = conn.transaction()?;
    let item = repo::require_item(&tx, id)?;
    if item.content_html == html {
        return Ok(item);
    }
    repo::record_version(&tx, &item.document_id, "edit")?;
    tx.execute(
        "UPDATE memo_items SET content_html = ?2, content_text = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, html, text::search_text(html), now()],
    )?;
    let saved = repo::require_item(&tx, id)?;
    repo::link_attachments(&tx, &saved)?;
    touch(&tx, &saved.document_id)?;
    tx.commit()?;
    Ok(saved)
}

pub fn set_completed(conn: &mut Connection, id: &str, completed: bool) -> AppResult<MemoItem> {
    let tx = conn.transaction()?;
    let item = repo::require_item(&tx, id)?;
    if item.completed == completed {
        return Ok(item);
    }
    let ts = now();
    tx.execute(
        "UPDATE memo_items SET completed = ?2, completed_at = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, completed as i64, completed.then(|| ts.clone()), ts],
    )?;
    touch(&tx, &item.document_id)?;
    let saved = repo::require_item(&tx, id)?;
    tx.commit()?;
    Ok(saved)
}

pub fn set_kind(conn: &mut Connection, id: &str, kind: &str) -> AppResult<MemoItem> {
    check_kind(kind)?;
    let tx = conn.transaction()?;
    let item = repo::require_item(&tx, id)?;
    if item.kind == kind {
        return Ok(item);
    }
    tx.execute(
        "UPDATE memo_items SET kind = ?2, completed = CASE WHEN ?2 = 'text' THEN 0 ELSE completed END,
                completed_at = CASE WHEN ?2 = 'text' THEN NULL ELSE completed_at END, updated_at = ?3 WHERE id = ?1",
        params![id, kind, now()],
    )?;
    touch(&tx, &item.document_id)?;
    let saved = repo::require_item(&tx, id)?;
    tx.commit()?;
    Ok(saved)
}

/// 즐겨찾기는 이 PC 에만 있는 표시 — 문서 revision 을 올리지 않는다(서버로 보내지 않음).
pub fn set_favorite(conn: &mut Connection, id: &str, favorite: bool) -> AppResult<MemoItem> {
    let item = repo::require_item(conn, id)?;
    conn.execute("UPDATE memo_items SET favorite = ?2 WHERE id = ?1", params![id, favorite as i64])?;
    Ok(MemoItem { favorite, ..item })
}

pub fn delete_item(conn: &mut Connection, id: &str) -> AppResult<MemoItem> {
    let tx = conn.transaction()?;
    let item = repo::require_item(&tx, id)?;
    repo::record_version(&tx, &item.document_id, "delete")?;
    tx.execute("UPDATE memo_items SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1", params![id, now()])?;
    touch(&tx, &item.document_id)?;
    tx.commit()?;
    Ok(item)
}

/// 삭제 실행 취소 — 원래 자리(문서·구역·순서)로.
pub fn restore_item(conn: &mut Connection, id: &str) -> AppResult<MemoItem> {
    let tx = conn.transaction()?;
    let item = repo::item_by_id(&tx, id, true)?.ok_or_else(|| AppError::not_found("메모"))?;
    tx.execute("UPDATE memo_items SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1", params![id, now()])?;
    touch(&tx, &item.document_id)?;
    let saved = repo::require_item(&tx, id)?;
    tx.commit()?;
    Ok(saved)
}

// ── 이동·정렬 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovePolicy {
    /// 대상 날짜/List 도 PLAN-A Work 와 연결하고 옮긴다.
    LinkTarget,
    /// Desktop 에서만 옮긴다(대상은 이 PC 에만 저장).
    LocalOnly,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveItem {
    pub id: String,
    pub target: Location,
    /// 날짜 안 구역. 없으면 원래 구역(Next → 날짜는 main).
    pub section: Option<String>,
    /// 대상 구역 안 위치(0 = 맨 앞). 없으면 맨 뒤.
    pub index: Option<usize>,
    pub policy: Option<MovePolicy>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    /// moved | needs_decision
    pub status: &'static str,
    pub item: Option<MemoItem>,
    pub target: Location,
    /// 연결 대상이 되는 위치를 연결해야 하는가(needs_decision 일 때)
    pub source_linked: bool,
}

pub fn move_item(conn: &mut Connection, input: MoveItem) -> AppResult<MoveOutcome> {
    move_item_linking(conn, input, None)
}

/// `link_account` — [연결하고 이동] 을 고른 때 지금 로그인한 계정(대상 날짜/List 를 그 계정으로 연결).
/// PLAN-A Work 규칙과 같게, 사용자가 고르지 않으면 대상은 **절대 자동 연결하지 않는다**.
pub fn move_item_linking(conn: &mut Connection, input: MoveItem, link_account: Option<&str>) -> AppResult<MoveOutcome> {
    if input.policy == Some(MovePolicy::LinkTarget) && link_account.is_none() {
        return Err(AppError::new("auth_required", "대상도 연결하려면 PLAN-A Work 로그인이 필요합니다."));
    }
    let tx = conn.transaction()?;
    let item = repo::require_item(&tx, &input.id)?;
    let source = repo::doc_by_id(&tx, &item.document_id)?.ok_or_else(|| AppError::not_found("문서"))?;
    repo::validate_location(&tx, &input.target)?;
    let existing_target = repo::doc_for_location(&tx, &input.target)?;
    let same_doc = existing_target.as_ref().map(|d| d.id == source.id).unwrap_or(false);
    let target_linked = existing_target.as_ref().map(|d| d.sync_enabled).unwrap_or(false);

    // 연결된 문서 → 연결되지 않은 문서: 몰래 Cloud 연결하지 않는다. 사용자가 고르게 한다.
    if !same_doc && source.sync_enabled && !target_linked && input.policy.is_none() {
        return Ok(MoveOutcome { status: "needs_decision", item: None, target: input.target, source_linked: true });
    }

    let target = repo::ensure_doc(&tx, &input.target)?;
    let section = match target.kind {
        DocKind::NextList => "next".to_string(),
        DocKind::Day => input.section.clone().filter(|s| super::valid_section_for(DocKind::Day, s)).unwrap_or_else(|| {
            if item.section == "next" {
                "main".into()
            } else {
                item.section.clone()
            }
        }),
    };
    repo::record_version(&tx, &source.id, if same_doc { "edit" } else { "move" })?;

    // 대상 구역의 새 순서
    let mut ids: Vec<String> =
        repo::items_of(&tx, &target.id)?.into_iter().filter(|i| i.section == section && i.id != item.id).map(|i| i.id).collect();
    let at = input.index.unwrap_or(ids.len()).min(ids.len());
    ids.insert(at, item.id.clone());
    let ts = now();
    tx.execute(
        "UPDATE memo_items SET document_id = ?2, section = ?3, updated_at = ?4 WHERE id = ?1",
        params![item.id, target.id, section, ts],
    )?;
    for (order, id) in ids.iter().enumerate() {
        tx.execute("UPDATE memo_items SET sort_order = ?2 WHERE id = ?1", params![id, order as i64])?;
    }
    tx.execute("UPDATE attachments SET document_id = ?2 WHERE item_id = ?1", params![item.id, target.id])?;

    if !same_doc && input.policy == Some(MovePolicy::LinkTarget) && !target.sync_enabled {
        if let Some(account) = link_account {
            crate::sync::link::enable_link(&tx, &target.id, account)?;
        }
    }
    touch(&tx, &source.id)?;
    if !same_doc {
        touch(&tx, &target.id)?;
    }
    let saved = repo::require_item(&tx, &item.id)?;
    tx.commit()?;
    Ok(MoveOutcome { status: "moved", item: Some(saved), target: input.target, source_linked: source.sync_enabled })
}

/// 한 구역의 순서를 통째로 정한다(다른 구역에서 끌어온 항목은 이 구역으로 옮겨진다 — 같은 문서 안에서만).
pub fn reorder(conn: &mut Connection, location: &Location, section: &str, ids: &[String]) -> AppResult<Vec<MemoItem>> {
    let tx = conn.transaction()?;
    let doc = repo::doc_for_location(&tx, location)?.ok_or_else(|| AppError::not_found("문서"))?;
    if !super::valid_section_for(doc.kind, section) {
        return Err(AppError::validation("이 위치에 쓸 수 없는 구역입니다."));
    }
    let current = repo::items_of(&tx, &doc.id)?;
    for id in ids {
        if !current.iter().any(|i| &i.id == id) {
            return Err(AppError::validation("다른 날짜의 메모는 이 순서에 넣을 수 없습니다."));
        }
    }
    repo::record_version(&tx, &doc.id, "edit")?;
    let ts = now();
    for (order, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE memo_items SET section = ?2, sort_order = ?3, updated_at = CASE WHEN section = ?2 THEN updated_at ELSE ?4 END WHERE id = ?1",
            params![id, section, order as i64, ts],
        )?;
    }
    touch(&tx, &doc.id)?;
    let items = repo::items_of(&tx, &doc.id)?;
    tx.commit()?;
    Ok(items)
}

// ── Next List ────────────────────────────────────────────────────────────

fn clean_list_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        return Err(AppError::validation("List 이름은 1~100자로 적어주세요."));
    }
    Ok(trimmed.to_string())
}

pub fn create_list(conn: &mut Connection, id: Option<String>, name: &str) -> AppResult<NextListInfo> {
    let name = clean_list_name(name)?;
    let id = id.filter(|v| is_uuid(v)).unwrap_or_else(new_id);
    let tx = conn.transaction()?;
    let exists: Option<i64> = tx.query_row("SELECT 1 FROM next_lists WHERE id = ?1", [&id], |r| r.get(0)).optional()?;
    if exists.is_none() {
        let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM next_lists", [], |r| r.get(0))?;
        let ts = now();
        tx.execute(
            "INSERT INTO next_lists (id, name, is_default, sort_order, created_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4, ?4)",
            params![id, name, order, ts],
        )?;
    }
    let info = repo::list_info(&tx, &id)?;
    tx.commit()?;
    Ok(info)
}

pub fn rename_list(conn: &mut Connection, id: &str, name: &str) -> AppResult<NextListInfo> {
    let name = clean_list_name(name)?;
    let tx = conn.transaction()?;
    let info = repo::list_info(&tx, id)?;
    if info.is_default {
        return Err(AppError::validation("기본 Next 의 이름은 바꿀 수 없습니다."));
    }
    // List 이름은 이 PC 의 정보다. memo-sync-v1 에는 이미 있는 List 의 이름을 바꾸는 API 가 없고 Push 문서에도
    // 이름 필드가 없다 — 연결된 List 라도 PLAN-A Work 로 보내지 않는다(화면이 '이 PC 에만' 이라고 알린다).
    // 문서 revision 을 올리지 않는다(올려도 보낼 내용이 없어 '보내는 중' 표시만 생긴다).
    tx.execute("UPDATE next_lists SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, name, now()])?;
    let info = repo::list_info(&tx, id)?;
    tx.commit()?;
    Ok(info)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteListResult {
    pub id: String,
    pub moved_count: usize,
}

/// List 만 지운다. 안의 메모는 기본 Next 로 옮긴다(Web 과 같은 규칙 — 메모는 지우지 않는다).
pub fn delete_list(conn: &mut Connection, id: &str) -> AppResult<DeleteListResult> {
    let tx = conn.transaction()?;
    let info = repo::list_info(&tx, id)?;
    if info.is_default {
        return Err(AppError::validation("기본 Next 는 삭제할 수 없습니다."));
    }
    let mut moved = 0;
    if let Some(doc) = &info.document {
        repo::record_version(&tx, &doc.id, "list_delete")?;
        let items = repo::items_of(&tx, &doc.id)?;
        if !items.is_empty() {
            let default_doc = repo::ensure_doc(&tx, &Location::Next { list_id: None })?;
            let start = repo::next_sort_order(&tx, &default_doc.id, "next")?;
            for (order, item) in (start..).zip(items.iter()) {
                tx.execute(
                    "UPDATE memo_items SET document_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
                    params![item.id, default_doc.id, order, now()],
                )?;
                tx.execute("UPDATE attachments SET document_id = ?2 WHERE item_id = ?1", params![item.id, default_doc.id])?;
            }
            moved = items.len();
            touch(&tx, &default_doc.id)?;
        }
        tx.execute("UPDATE documents SET deleted_at = ?2 WHERE id = ?1", params![doc.id, now()])?;
        touch(&tx, &doc.id)?; // 연결된 List 면 '삭제됨' 을 전달
    }
    tx.execute("UPDATE next_lists SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1", params![id, now()])?;
    tx.commit()?;
    Ok(DeleteListResult { id: id.to_string(), moved_count: moved })
}

pub fn reorder_lists(conn: &mut Connection, ids: &[String]) -> AppResult<Vec<NextListInfo>> {
    let tx = conn.transaction()?;
    for (order, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE next_lists SET sort_order = ?2, updated_at = ?3 WHERE id = ?1 AND is_default = 0",
            params![id, order as i64 + 1, now()],
        )?;
    }
    tx.commit()?;
    lists(conn)
}
