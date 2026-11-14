//! 요일마다 생성 — DAY 메모 하나를 **그 메모 날짜의 요일**마다(매주 1회) 새 메모로 만든다.
//!
//! * 규칙은 이 PC 의 메타데이터다(`memo_recurrences`). memo-sync-v1/v2 Contract 에 반복 규칙이 없으므로
//!   PLAN-A Work 로 보내지 않는다(Web 의 '요일마다 생성' 은 서버가 관리하는 별도 메타데이터).
//! * 회차는 평범한 새 메모(새 id · 미완료 · 원본과 같은 구역·유형·본문)다. 회차마다 따로 고치고·완료하고·지운다.
//!   원본을 고쳐도 다른 날짜는 바뀌지 않는다(규칙은 반복을 시작한 순간의 본문을 쓴다).
//! * 중복 방지 — (규칙, 날짜) 회차 기록이 있으면 다시 만들지 않는다. 본문 문자열을 비교하지 않으므로 같은 내용을
//!   사용자가 직접 쓴 메모와 섞이지 않고, 회차를 지우거나 옮겨도 그 날짜에 되살아나지 않는다.
//! * 필요한 날짜에만 — 오늘부터 2주(`HORIZON_DAYS`, Web 과 같은 범위)와, 화면이 그보다 먼 날짜를 읽을 때 그 날짜만.
//! * PLAN-A Work 와 연결된 날짜에는 만들지 않는다 — 회차를 넣으면 그 날짜의 변경으로 Web 에 올라가 Local-only 메모가
//!   자동 업로드되고, Web 의 반복과 겹쳐 같은 일이 두 번 생길 수 있다. 연결된 날짜의 메모에서 반복을 시작할 수도 없다.

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::repo::{self, touch};
use super::{text, DocKind, Location};
use crate::error::{AppError, AppResult};
use crate::storage::StoragePaths;
use crate::util::{new_id, now};

/// 미리 만드는 범위(오늘 + 14일 = 가까운 같은 요일 두 번).
pub const HORIZON_DAYS: i64 = 14;
pub const LINKED_CODE: &str = "recurrence_linked";
const LINKED_MESSAGE: &str = "PLAN-A Work 와 연결된 날짜의 메모는 요일마다 생성을 쓸 수 없습니다. 반복 규칙은 Web 과 동기화되지 않습니다.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleView {
    pub id: String,
    /// 0 = 일요일 … 6 = 토요일
    pub weekday: u32,
    pub source_date: String,
    pub starts_on: String,
    /// 이 메모가 규칙의 원본(source)인가 회차(occurrence)인가
    pub role: &'static str,
    /// 오늘 이후 가장 가까운 회차 날짜(안내용)
    pub next_date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceInfo {
    /// 메모가 속한 날짜의 요일(0 = 일요일 … 6 = 토요일). NEXT_LIST 면 None.
    pub weekday: Option<u32>,
    /// 이 메모가 속한 반복(진행 중인 것만)
    pub rule: Option<RuleView>,
    /// 반복을 시작할 수 없는 이유(연결된 날짜 · NEXT_LIST)
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    /// 손대지 않은 앞으로의 회차를 정리한 수
    pub removed: usize,
    /// 남겨 둔 앞으로의 회차(고쳤거나·완료했거나·연결된 날짜로 옮겨진 것)
    pub kept: usize,
}

struct Rule {
    id: String,
    source_date: String,
    weekday: u32,
    section: String,
    kind: String,
    content_html: String,
    starts_on: NaiveDate,
    materialized_through: Option<NaiveDate>,
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

fn weekday_of(date: NaiveDate) -> u32 {
    date.weekday().num_days_from_sunday()
}

/// `from` 이후(같은 날 포함) 처음 오는 `weekday`.
fn on_or_after(from: NaiveDate, weekday: u32) -> NaiveDate {
    from + Duration::days(((weekday + 7 - weekday_of(from)) % 7) as i64)
}

/// 첫 회차 — 원본 다음 주 같은 요일. 원본이 지난 날짜면 지난 날짜를 채우지 않고 오늘 이후 첫 같은 요일부터.
fn first_occurrence(source: NaiveDate, today: NaiveDate) -> NaiveDate {
    (source + Duration::days(7)).max(on_or_after(today, weekday_of(source)))
}

const RULE_COLUMNS: &str = "id, source_item_id, source_date, weekday, section, kind, content_html, starts_on, materialized_through";

fn rule_from_row(row: &rusqlite::Row) -> rusqlite::Result<(String, String, String, u32, String, String, String, String, Option<String>)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?))
}

fn to_rule(raw: (String, String, String, u32, String, String, String, String, Option<String>)) -> AppResult<Rule> {
    Ok(Rule {
        id: raw.0,
        source_date: raw.2,
        weekday: raw.3,
        section: raw.4,
        kind: raw.5,
        content_html: raw.6,
        starts_on: parse(&raw.7)?,
        materialized_through: raw.8.as_deref().map(parse).transpose()?,
    })
}

fn active_rules(conn: &Connection) -> AppResult<Vec<Rule>> {
    let raw = conn
        .prepare(&format!("SELECT {RULE_COLUMNS} FROM memo_recurrences WHERE stopped_at IS NULL ORDER BY created_at"))?
        .query_map([], rule_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    raw.into_iter().map(to_rule).collect()
}

/// 이 메모가 속한 진행 중 반복(원본이거나 회차).
fn rule_of_item(conn: &Connection, item_id: &str) -> AppResult<Option<(Rule, &'static str)>> {
    let source = conn
        .query_row(
            &format!("SELECT {RULE_COLUMNS} FROM memo_recurrences WHERE stopped_at IS NULL AND source_item_id = ?1"),
            [item_id],
            rule_from_row,
        )
        .optional()?;
    if let Some(raw) = source {
        return Ok(Some((to_rule(raw)?, "source")));
    }
    let occurrence = conn
        .query_row(
            &format!(
                "SELECT {} FROM memo_recurrences r JOIN memo_recurrence_occurrences o ON o.recurrence_id = r.id
                  WHERE r.stopped_at IS NULL AND o.item_id = ?1 LIMIT 1",
                RULE_COLUMNS.split(", ").map(|c| format!("r.{c}")).collect::<Vec<_>>().join(", ")
            ),
            [item_id],
            rule_from_row,
        )
        .optional()?;
    occurrence.map(|raw| Ok((to_rule(raw)?, "occurrence"))).transpose()
}

fn view(rule: &Rule, role: &'static str, today: NaiveDate) -> RuleView {
    RuleView {
        id: rule.id.clone(),
        weekday: rule.weekday,
        source_date: rule.source_date.clone(),
        starts_on: fmt(rule.starts_on),
        role,
        next_date: fmt(rule.starts_on.max(on_or_after(today, rule.weekday))),
    }
}

/// 날짜가 PLAN-A Work 와 연결돼 있거나(또는 Web 에서 지워진 표시가 있어) 회차를 넣으면 안 되는가.
fn day_is_shared(conn: &Connection, date: &str) -> AppResult<bool> {
    let row: Option<(i64, bool)> = conn
        .query_row("SELECT sync_enabled, deleted_at IS NOT NULL FROM documents WHERE kind = 'DAY' AND memo_date = ?1", [date], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    Ok(row.is_some_and(|(linked, deleted)| linked == 1 || deleted))
}

/// 메뉴용 — 이 메모의 반복 상태.
pub fn info(conn: &Connection, item_id: &str, today: &str) -> AppResult<RecurrenceInfo> {
    let today = parse(today)?;
    let item = repo::require_item(conn, item_id)?;
    let doc = repo::doc_by_id(conn, &item.document_id)?.ok_or_else(|| AppError::not_found("문서"))?;
    if doc.kind != DocKind::Day {
        return Ok(RecurrenceInfo {
            weekday: None, rule: None, blocked: Some("날짜가 없는 List 메모는 반복할 수 없습니다.".into())
        });
    }
    let date = parse(doc.memo_date.as_deref().unwrap_or_default())?;
    let rule = rule_of_item(conn, item_id)?.map(|(rule, role)| view(&rule, role, today));
    let blocked = doc.sync_enabled.then(|| LINKED_MESSAGE.to_string());
    Ok(RecurrenceInfo { weekday: Some(weekday_of(date)), rule, blocked })
}

/// [○요일마다 생성] — 규칙을 만들고 가까운 회차(2주)를 바로 만든다. 이미 반복 중이면 그대로 돌려준다(재클릭·재시도).
pub fn create(conn: &mut Connection, paths: &StoragePaths, item_id: &str, today: &str) -> AppResult<RecurrenceInfo> {
    let today_day = parse(today)?;
    {
        let tx = conn.transaction()?;
        let item = repo::require_item(&tx, item_id)?;
        let doc = repo::doc_by_id(&tx, &item.document_id)?.ok_or_else(|| AppError::not_found("문서"))?;
        if doc.kind != DocKind::Day || !matches!(item.section.as_str(), "main" | "am" | "pm") {
            return Err(AppError::validation("날짜가 없는 List 메모는 반복할 수 없습니다."));
        }
        if doc.sync_enabled {
            return Err(AppError::new(LINKED_CODE, LINKED_MESSAGE));
        }
        if rule_of_item(&tx, item_id)?.is_none() {
            let source = parse(doc.memo_date.as_deref().unwrap_or_default())?;
            let ts = now();
            tx.execute(
                "INSERT INTO memo_recurrences (id, source_item_id, source_date, weekday, section, kind, content_html, starts_on,
                                               created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    new_id(),
                    item.id,
                    fmt(source),
                    weekday_of(source),
                    item.section,
                    item.kind,
                    item.content_html,
                    fmt(first_occurrence(source, today_day)),
                    ts
                ],
            )?;
        }
        tx.commit()?;
    }
    materialize(conn, paths, today, &[])?;
    info(conn, item_id, today)
}

/// [반복 중지] — 앞으로 새 회차를 만들지 않는다. 지난·오늘 회차와 사용자가 손댄 회차는 그대로 둔다.
/// 내일 이후에 미리 만들어 두었고 **손대지 않은**(고치지·완료하지·즐겨찾기하지·옮기지 않은) 회차만 정리한다(History 에 남는다).
/// 연결된 날짜(이미 Web 과 공유된 내용)의 회차는 지우지 않는다.
pub fn stop(conn: &mut Connection, rule_id: &str, today: &str) -> AppResult<StopResult> {
    let today = fmt(parse(today)?);
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE memo_recurrences SET stopped_at = ?2, updated_at = ?2 WHERE id = ?1 AND stopped_at IS NULL",
        params![rule_id, now()],
    )?;
    if changed == 0 {
        let exists: Option<i64> = tx.query_row("SELECT 1 FROM memo_recurrences WHERE id = ?1", [rule_id], |r| r.get(0)).optional()?;
        if exists.is_none() {
            return Err(AppError::not_found("반복"));
        }
        return Ok(StopResult { removed: 0, kept: 0 }); // 이미 중지됨(재클릭)
    }
    let (cleanup, kept) = future_occurrences(&tx, rule_id, &today)?;
    for item in &cleanup {
        repo::record_version(&tx, &item.document_id, "recurrence_stop")?;
        tx.execute("UPDATE memo_items SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1", params![item.id, now()])?;
        touch(&tx, &item.document_id)?;
    }
    tx.commit()?;
    Ok(StopResult { removed: cleanup.len(), kept })
}

/// 중지 전 확인용 — 지금 중지하면 정리될(손대지 않은 앞으로의) 회차 수와 남을 회차 수. 아무것도 바꾸지 않는다.
/// 화면은 정리할 회차가 있을 때만 확인창을 띄운다.
pub fn stop_preview(conn: &Connection, rule_id: &str, today: &str) -> AppResult<StopResult> {
    let today = fmt(parse(today)?);
    let active: Option<i64> =
        conn.query_row("SELECT 1 FROM memo_recurrences WHERE id = ?1 AND stopped_at IS NULL", [rule_id], |r| r.get(0)).optional()?;
    if active.is_none() {
        return Ok(StopResult { removed: 0, kept: 0 });
    }
    let (cleanup, kept) = future_occurrences(conn, rule_id, &today)?;
    Ok(StopResult { removed: cleanup.len(), kept })
}

/// 내일 이후 회차를 (정리할 것, 남길 수)로 나눈다 — 정리 대상은 손대지 않았고(수정·완료·즐겨찾기 없음)
/// 만든 날짜에 그대로 있으며 연결되지 않은 날짜의 회차뿐이다. 중지와 미리 보기가 같은 규칙을 쓴다.
fn future_occurrences(conn: &Connection, rule_id: &str, today: &str) -> AppResult<(Vec<super::MemoItem>, usize)> {
    let future: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT occurrence_date, item_id, created_at FROM memo_recurrence_occurrences
              WHERE recurrence_id = ?1 AND occurrence_date > ?2 ORDER BY occurrence_date",
        )?
        .query_map(params![rule_id, today], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let (mut cleanup, mut kept) = (Vec::new(), 0);
    for (date, item_id, created_at) in future {
        let Some(item) = repo::item_by_id(conn, &item_id, false)? else { continue };
        let doc = repo::doc_by_id(conn, &item.document_id)?;
        let untouched = item.updated_at == created_at && !item.completed && !item.favorite;
        let in_place =
            doc.as_ref().is_some_and(|d| d.kind == DocKind::Day && d.memo_date.as_deref() == Some(date.as_str()) && !d.sync_enabled);
        if untouched && in_place {
            cleanup.push(item);
        } else {
            kept += 1;
        }
    }
    Ok((cleanup, kept))
}

/// 한 날짜의 회차를 만든다(이미 기록이 있거나 연결된 날짜면 만들지 않는다). 만들었으면 true.
fn occur(conn: &Connection, paths: &StoragePaths, rule: &Rule, date: NaiveDate) -> AppResult<bool> {
    let date_text = fmt(date);
    let recorded: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM memo_recurrence_occurrences WHERE recurrence_id = ?1 AND occurrence_date = ?2",
            params![rule.id, date_text],
            |r| r.get(0),
        )
        .optional()?;
    if recorded.is_some() || date_text == rule.source_date || day_is_shared(conn, &date_text)? {
        return Ok(false);
    }
    let doc = repo::ensure_doc(conn, &Location::Day { date: date_text.clone() })?;
    let item_id = new_id();
    let mut html = rule.content_html.clone();
    // 이미지는 회차마다 새 첨부로 복제한다 — 원본이나 다른 회차를 지우거나 정리해도 이 회차의 이미지가 남는다.
    for attachment in text::attachment_ids(&rule.content_html) {
        if let Some(copy) = crate::attachments::duplicate(conn, paths, &attachment, None, &doc.id)? {
            html = html.replace(&format!("attachment://{attachment}"), &format!("attachment://{copy}"));
        }
    }
    let order = repo::next_sort_order(conn, &doc.id, &rule.section)?;
    let ts = now();
    conn.execute(
        "INSERT INTO memo_items (id, document_id, section, kind, content_html, content_text, completed, completed_at, favorite,
                                 sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, 0, ?7, ?8, ?8)",
        params![item_id, doc.id, rule.section, rule.kind, html, text::search_text(&html), order, ts],
    )?;
    conn.execute(
        "INSERT INTO memo_recurrence_occurrences (recurrence_id, occurrence_date, item_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![rule.id, date_text, item_id, ts],
    )?;
    let saved = repo::require_item(conn, &item_id)?;
    repo::link_attachments(conn, &saved)?;
    touch(conn, &doc.id)?;
    Ok(true)
}

/// 화면이 날짜를 읽기 전에 부른다 — 오늘부터 2주 안의 빠진 회차와, `dates` 중 그보다 먼 반복 요일의 회차를 만든다.
/// 몇 번을 불러도 같은 결과다(회차 기록). 만든 회차 수를 돌려준다.
pub fn materialize(conn: &mut Connection, paths: &StoragePaths, today: &str, dates: &[String]) -> AppResult<usize> {
    let today = parse(today)?;
    let horizon = today + Duration::days(HORIZON_DAYS);
    let rules = active_rules(conn)?;
    let mut created = 0;
    for rule in rules {
        let mut date = match rule.materialized_through {
            Some(done) => done + Duration::days(7),
            None => rule.starts_on,
        };
        let extra: Vec<NaiveDate> = dates
            .iter()
            .filter_map(|d| parse(d).ok())
            .filter(|d| *d > horizon && *d >= rule.starts_on && weekday_of(*d) == rule.weekday)
            .collect();
        if date > horizon && extra.is_empty() {
            continue;
        }
        let tx = conn.transaction()?;
        let mut through = rule.materialized_through;
        while date <= horizon {
            if occur(&tx, paths, &rule, date)? {
                created += 1;
            }
            through = Some(date);
            date += Duration::days(7);
        }
        if through != rule.materialized_through {
            tx.execute("UPDATE memo_recurrences SET materialized_through = ?2 WHERE id = ?1", params![rule.id, through.map(fmt)])?;
        }
        for day in extra {
            if occur(&tx, paths, &rule, day)? {
                created += 1;
            }
        }
        tx.commit()?;
    }
    Ok(created)
}

/// 지난 미완료 가져오기에서 뺄 원본 — 이미 `target` 날짜에 회차가 있는 반복의 메모들(원본·다른 회차).
/// 반복 회차와 '지난주 미완료 복사' 가 같은 일을 두 번 만들지 않게 한다.
pub fn series_items_on(conn: &Connection, target: &str) -> AppResult<Vec<String>> {
    Ok(conn
        .prepare(
            "SELECT r.source_item_id FROM memo_recurrences r
              WHERE r.id IN (SELECT recurrence_id FROM memo_recurrence_occurrences WHERE occurrence_date = ?1)
             UNION
             SELECT o.item_id FROM memo_recurrence_occurrences o
              WHERE o.recurrence_id IN (SELECT recurrence_id FROM memo_recurrence_occurrences WHERE occurrence_date = ?1)",
        )?
        .query_map([target], |r| r.get(0))?
        .collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn first_occurrence_is_next_week_or_next_upcoming_weekday() {
        // 2026-11-14 = 토요일(오늘) → 다음 토요일
        assert_eq!(first_occurrence(d("2026-11-14"), d("2026-11-14")), d("2026-11-21"));
        // 미래 원본(11-21) → 그다음 주
        assert_eq!(first_occurrence(d("2026-11-21"), d("2026-11-14")), d("2026-11-28"));
        // 지난 원본(10-03 토) → 지난 날짜를 채우지 않고 오늘(11-14 토)부터
        assert_eq!(first_occurrence(d("2026-10-03"), d("2026-11-14")), d("2026-11-14"));
        // 지난 월요일 원본(11-09) → 다음 월요일(11-16)
        assert_eq!(first_occurrence(d("2026-11-09"), d("2026-11-14")), d("2026-11-16"));
        assert_eq!(weekday_of(d("2026-11-14")), 6);
        assert_eq!(weekday_of(d("2026-11-15")), 0);
    }
}
