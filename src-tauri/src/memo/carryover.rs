//! 지난 미완료 가져오기 — 바로 지난주 같은 요일(D-7)의 **완료하지 않은 체크리스트**를 D 로 **복사**한다.
//!
//! * 원본(D-7)은 그대로 — 날짜·완료 상태·내용·주인 문서 모두 바꾸지 않는다(이동이 아니다).
//! * 복사본은 새 항목 id(따라서 Sync 의 새 client_key)·미완료·같은 구역·대상 구역의 맨 뒤.
//! * 이미지는 새 첨부로 복제한다 — 원본을 지우거나 정리해도 복사본의 이미지가 남는다.
//! * (원본 id, 대상 날짜) 복사 관계를 남겨 같은 원본을 같은 날짜로 두 번 만들지 않는다(재클릭·재실행·재시도).
//! * D 문서가 PLAN-A Work 와 연결돼 있으면 D 의 변경으로 Outbox 에 남는다(touch). D-7 은 연결하지 않는다.
//! * 안내 상태(보였다·건너뛰었다·가져왔다)는 이 PC 의 메타데이터다 — 서버로 보내지 않는다.

use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::repo::{self, touch};
use super::{text, Location, MemoItem};
use crate::error::{AppError, AppResult};
use crate::storage::StoragePaths;
use crate::util::{new_id, now};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryoverInfo {
    pub target_date: String,
    pub source_date: String,
    /// 원본 날짜가 이미 지났는가(지나지 않은 날짜의 미완료는 가져오라고 하지 않는다)
    pub available: bool,
    /// 지금 화면이 저절로 안내해도 되는가(이번 주 · 아직 결정하지 않음 · 가져올 항목 있음)
    pub auto_prompt: bool,
    /// shown | skipped | imported | null
    pub status: Option<String>,
    /// 가져올 수 있는 항목(이미 이 날짜로 복사한 원본은 빠진다)
    pub items: Vec<MemoItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryoverResult {
    pub created: Vec<MemoItem>,
    /// 이미 복사했거나·그 사이에 완료·삭제돼 건너뛴 수
    pub skipped: usize,
}

fn parse(date: &str) -> AppResult<NaiveDate> {
    if !crate::util::is_date(date) {
        return Err(AppError::validation("날짜 형식이 올바르지 않습니다."));
    }
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| AppError::validation("날짜 형식이 올바르지 않습니다."))
}

fn fmt(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn week_start(date: NaiveDate) -> NaiveDate {
    date - chrono::Duration::days(date.weekday().num_days_from_monday() as i64)
}

pub fn source_date_of(target: &str) -> AppResult<String> {
    Ok(fmt(parse(target)? - chrono::Duration::days(7)))
}

/// D-7 의 미완료 체크리스트 중 아직 D 로 복사하지 않은 것(원본 순서: 메인 → 오전 → 오후).
fn candidates(conn: &Connection, source: &str, target: &str) -> AppResult<Vec<MemoItem>> {
    let Some(doc) = repo::doc_for_location(conn, &Location::Day { date: source.to_string() })? else { return Ok(Vec::new()) };
    let copied: Vec<String> = conn
        .prepare("SELECT source_item_id FROM item_copies WHERE target_date = ?1")?
        .query_map([target], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(repo::items_of(conn, &doc.id)?
        .into_iter()
        .filter(|item| item.kind == "checklist" && !item.completed && !copied.contains(&item.id))
        .collect())
}

fn status_of(conn: &Connection, target: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT status FROM carryover_prompts WHERE target_date = ?1", [target], |r| r.get(0)).optional()?)
}

fn set_status(conn: &Connection, target: &str, source: &str, status: &str) -> AppResult<()> {
    let ts = now();
    conn.execute(
        "INSERT INTO carryover_prompts (target_date, source_date, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(target_date) DO UPDATE SET source_date = excluded.source_date, status = excluded.status, updated_at = excluded.updated_at",
        params![target, source, status, ts],
    )?;
    Ok(())
}

/// `today` — 사용자 PC 의 오늘(YYYY-MM-DD).
pub fn get(conn: &Connection, target: &str, today: &str) -> AppResult<CarryoverInfo> {
    let target_day = parse(target)?;
    let today_day = parse(today)?;
    let source_day = target_day - chrono::Duration::days(7);
    let source = fmt(source_day);
    let available = source_day < today_day;
    let items = if available { candidates(conn, &source, target)? } else { Vec::new() };
    let status = status_of(conn, target)?;
    let decided = matches!(status.as_deref(), Some("skipped" | "imported"));
    let this_week = week_start(target_day) == week_start(today_day);
    Ok(CarryoverInfo {
        target_date: target.to_string(),
        source_date: source,
        available,
        auto_prompt: available && this_week && !decided && !items.is_empty(),
        status,
        items,
    })
}

/// 안내를 화면에 보였다(기록만 — 결정하기 전까지는 다시 보일 수 있다).
pub fn mark_shown(conn: &Connection, target: &str) -> AppResult<()> {
    let source = source_date_of(target)?;
    if status_of(conn, target)?.is_none() {
        set_status(conn, target, &source, "shown")?;
    }
    Ok(())
}

/// [이번에는 건너뛰기] — 이 날짜에는 다시 저절로 안내하지 않는다.
pub fn skip(conn: &Connection, target: &str) -> AppResult<()> {
    let source = source_date_of(target)?;
    if status_of(conn, target)?.as_deref() != Some("imported") {
        set_status(conn, target, &source, "skipped")?;
    }
    Ok(())
}

/// 고른 항목만 복사한다. 같은 요청이 두 번 와도(재클릭·재시도) 한 번만 만든다.
pub fn import(conn: &mut Connection, paths: &StoragePaths, target: &str, item_ids: &[String], today: &str) -> AppResult<CarryoverResult> {
    let source = source_date_of(target)?;
    if parse(&source)? >= parse(today)? {
        return Err(AppError::validation("아직 지나지 않은 날짜의 할 일은 가져올 수 없습니다."));
    }
    let tx = conn.transaction()?;
    let eligible = candidates(&tx, &source, target)?;
    let mut picked: Vec<MemoItem> = Vec::new();
    for id in item_ids {
        if let Some(item) = eligible.iter().find(|i| &i.id == id) {
            if !picked.iter().any(|p| p.id == item.id) {
                picked.push(item.clone());
            }
        }
    }
    let skipped = item_ids.len().saturating_sub(picked.len());
    let mut created = Vec::new();
    if !picked.is_empty() {
        let target_doc = repo::ensure_doc(&tx, &Location::Day { date: target.to_string() })?;
        repo::record_version(&tx, &target_doc.id, "carryover")?;
        let ts = now();
        for item in &picked {
            let new_item_id = new_id();
            let mut html = item.content_html.clone();
            for attachment in text::attachment_ids(&item.content_html) {
                if let Some(copy) = crate::attachments::duplicate(&tx, paths, &attachment, None, &target_doc.id)? {
                    html = html.replace(&format!("attachment://{attachment}"), &format!("attachment://{copy}"));
                }
            }
            let order = repo::next_sort_order(&tx, &target_doc.id, &item.section)?;
            tx.execute(
                "INSERT INTO memo_items (id, document_id, section, kind, content_html, content_text, completed, completed_at, favorite,
                                         sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'checklist', ?4, ?5, 0, NULL, 0, ?6, ?7, ?7)",
                params![new_item_id, target_doc.id, item.section, html, text::search_text(&html), order, ts],
            )?;
            tx.execute(
                "INSERT INTO item_copies (source_item_id, source_date, target_date, new_item_id, copied_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![item.id, source, target, new_item_id, ts],
            )?;
            let saved = repo::require_item(&tx, &new_item_id)?;
            repo::link_attachments(&tx, &saved)?;
            created.push(saved);
        }
        touch(&tx, &target_doc.id)?;
    }
    set_status(&tx, target, &source, "imported")?;
    tx.commit()?;
    Ok(CarryoverResult { created, skipped })
}
