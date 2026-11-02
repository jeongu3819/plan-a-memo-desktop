//! 전체 검색 — DayMemo · Next List · List 이름 · (지금은 없어진 내용의) History.
//! HTML 태그가 아니라 저장 시 만든 평문(content_text)에서 찾는다. 모든 단어가 들어 있어야 결과다.
//! 검색어가 날짜로 읽히면(해석은 화면의 parseDateQuery — 이 PC 의 오늘 기준) 그 날짜의 DAY 메모를 함께 돌려준다.
//! 본문 검색은 날짜 여부와 상관없이 그대로 한다('11/2' 라고 적은 메모도 찾는다).

use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use super::history::reason_label;
use super::repo::{self, ITEM_COLUMNS};
use super::{text, DocKind, LocatedItem, Location, MemoItem, DEFAULT_LIST_ID};
use crate::error::AppResult;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(flatten)]
    pub located: LocatedItem,
    pub excerpt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListHit {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHit {
    pub version_id: i64,
    pub document_id: String,
    pub location: Location,
    pub list_name: Option<String>,
    pub reason_label: &'static str,
    pub created_at: String,
    pub excerpt: String,
}

/// 검색어에서 읽어 낸 날짜.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateQuery {
    /// 없으면 모든 연도의 같은 월·일(prefer_year 를 맨 앞에)
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
    pub prefer_year: i32,
    /// 날짜를 뺀 나머지 검색어 — 있으면 그 날짜의 메모 중 이 단어가 들어 있는 것만
    #[serde(default)]
    pub rest: String,
}

/// 날짜로 찾은 하루.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayHit {
    pub date: String,
    pub items: Vec<SearchHit>,
    pub tokens: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub tokens: Vec<String>,
    pub days: Vec<DayHit>,
    pub items: Vec<SearchHit>,
    pub lists: Vec<ListHit>,
    pub history: Vec<HistoryHit>,
    pub truncated: bool,
}

pub const ITEM_LIMIT: usize = 200;
const MAX_ITEM_LIMIT: usize = 2000;
/// 연도 없는 날짜 검색이 돌려주는 날짜 수(같은 월·일이 있는 해).
const DAY_HIT_LIMIT: i64 = 10;

fn like_pattern(token: &str) -> String {
    let escaped = token.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

fn where_all(column: &str, count: usize) -> String {
    (0..count).map(|i| format!("lower({column}) LIKE ?{} ESCAPE '\\'", i + 1)).collect::<Vec<_>>().join(" AND ")
}

/// 첫 단어 주변의 한 토막.
pub fn excerpt(text: &str, tokens: &[String]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_lowercase().chars().collect();
    let first = tokens.first().map(|t| t.chars().collect::<Vec<_>>()).unwrap_or_default();
    let mut at = 0;
    if !first.is_empty() && lower.len() == chars.len() {
        if let Some(pos) = lower.windows(first.len()).position(|w| w == first.as_slice()) {
            at = pos;
        }
    }
    let start = at.saturating_sub(30);
    let end = (at + 90).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    if start > 0 {
        out = format!("…{out}");
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// 날짜로 찾기 — 메모가 있는 날짜만(빈 날짜를 결과로 내지 않는다).
fn day_hits(conn: &Connection, date: &DateQuery) -> AppResult<Vec<DayHit>> {
    let month_day = format!("{:02}-{:02}", date.month, date.day);
    let year = date.year.map(|y| format!("{y:04}")).unwrap_or_default();
    let rows: Vec<(String, String)> = conn
        .prepare(
            "SELECT d.id, d.memo_date FROM documents d
              WHERE d.kind = 'DAY' AND d.deleted_at IS NULL AND substr(d.memo_date, 6, 5) = ?1
                AND (?2 = '' OR substr(d.memo_date, 1, 4) = ?2)
                AND EXISTS(SELECT 1 FROM memo_items i WHERE i.document_id = d.id AND i.deleted_at IS NULL)
              ORDER BY substr(d.memo_date, 1, 4) = ?3 DESC, d.memo_date DESC LIMIT ?4",
        )?
        .query_map(rusqlite::params![month_day, year, format!("{:04}", date.prefer_year), DAY_HIT_LIMIT], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    let tokens = text::search_tokens(&date.rest);
    let mut days = Vec::new();
    for (doc_id, memo_date) in rows {
        let Some(doc) = repo::doc_by_id(conn, &doc_id)? else { continue };
        let mut items = Vec::new();
        for item in repo::items_of(conn, &doc_id)? {
            let plain = text::search_text(&item.content_html);
            let lower = plain.to_lowercase();
            if tokens.iter().all(|t| lower.contains(t.as_str())) {
                let excerpt = excerpt(&plain, &tokens);
                items.push(SearchHit { located: LocatedItem { location: repo::location_of_doc(&doc), list_name: None, item }, excerpt });
            }
        }
        if !items.is_empty() {
            days.push(DayHit { date: memo_date, items, tokens: tokens.clone() });
        }
    }
    Ok(days)
}

pub fn search(conn: &Connection, query: &str) -> AppResult<SearchResult> {
    search_with(conn, query, None, ITEM_LIMIT)
}

pub fn search_with(conn: &Connection, query: &str, date: Option<&DateQuery>, limit: usize) -> AppResult<SearchResult> {
    let tokens = text::search_tokens(query);
    let days = date.map(|d| day_hits(conn, d)).transpose()?.unwrap_or_default();
    if tokens.is_empty() {
        return Ok(SearchResult { query: query.to_string(), tokens, days, items: vec![], lists: vec![], history: vec![], truncated: false });
    }
    let limit = limit.clamp(1, MAX_ITEM_LIMIT);
    let patterns: Vec<String> = tokens.iter().map(|t| like_pattern(t)).collect();

    let items: Vec<MemoItem> = conn
        .prepare(&format!(
            "SELECT {ITEM_COLUMNS} FROM memo_items i
              WHERE i.deleted_at IS NULL AND {}
                AND EXISTS(SELECT 1 FROM documents d WHERE d.id = i.document_id AND d.deleted_at IS NULL)
              ORDER BY i.updated_at DESC LIMIT {}",
            where_all("i.content_text", patterns.len()),
            limit + 1
        ))?
        .query_map(params_from_iter(patterns.iter()), repo::item_from_row)?
        .collect::<Result<_, _>>()?;
    let truncated = items.len() > limit;
    let mut hits = Vec::new();
    for item in items.into_iter().take(limit) {
        let doc = match repo::doc_by_id(conn, &item.document_id)? {
            Some(doc) => doc,
            None => continue,
        };
        let list_name = match doc.kind {
            DocKind::NextList => repo::list_name(conn, doc.next_list_id.as_deref().unwrap_or(DEFAULT_LIST_ID))?,
            DocKind::Day => None,
        };
        let excerpt = excerpt(&text::search_text(&item.content_html), &tokens);
        hits.push(SearchHit { located: LocatedItem { location: repo::location_of_doc(&doc), list_name, item }, excerpt });
    }

    let lists: Vec<ListHit> = conn
        .prepare(&format!(
            "SELECT id, name, is_default FROM next_lists WHERE deleted_at IS NULL AND {} ORDER BY sort_order",
            where_all("name", patterns.len())
        ))?
        .query_map(params_from_iter(patterns.iter()), |r| {
            Ok(ListHit { id: r.get(0)?, name: r.get(1)?, is_default: r.get::<_, i64>(2)? == 1 })
        })?
        .collect::<Result<_, _>>()?;

    // History — 지금 내용에는 없는데 예전 버전에 있던 것(문서당 가장 최근 1건).
    let rows: Vec<(i64, String, String, String, String)> = conn
        .prepare(&format!(
            "SELECT v.id, v.document_id, v.reason, v.created_at, v.content_text FROM document_versions v
              WHERE {} AND v.id = (SELECT MAX(v2.id) FROM document_versions v2 WHERE v2.document_id = v.document_id AND {})
              ORDER BY v.id DESC LIMIT 30",
            where_all("v.content_text", patterns.len()),
            where_all("v2.content_text", patterns.len()),
        ))?
        .query_map(params_from_iter(patterns.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<Result<_, _>>()?;
    let mut history = Vec::new();
    for (version_id, document_id, reason, created_at, content) in rows {
        if hits.iter().any(|h| h.located.item.document_id == document_id) {
            continue; // 지금 내용에서 이미 찾았다
        }
        let Some(doc) = repo::doc_by_id(conn, &document_id)? else { continue };
        // 삭제된 List(휴지통 포함)의 History 는 열 수 있는 화면이 없다 — 복구는 휴지통에서.
        if let Some(list_id) = doc.next_list_id.as_deref() {
            let alive: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM next_lists WHERE id = ?1 AND deleted_at IS NULL)", [list_id], |r| r.get(0))?;
            if !alive {
                continue;
            }
        }
        let list_name = doc.next_list_id.as_deref().map(|id| repo::list_name(conn, id)).transpose()?.flatten();
        history.push(HistoryHit {
            version_id,
            document_id,
            location: repo::location_of_doc(&doc),
            list_name,
            reason_label: reason_label(&reason),
            created_at,
            excerpt: excerpt(&content.replace('\n', " "), &tokens),
        });
    }

    Ok(SearchResult { query: query.to_string(), tokens, days, items: hits, lists, history, truncated })
}
