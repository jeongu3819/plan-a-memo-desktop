//! 전체 검색 — DayMemo · Next List · List 이름 · (지금은 없어진 내용의) History.
//! HTML 태그가 아니라 저장 시 만든 평문(content_text)에서 찾는다. 모든 단어가 들어 있어야 결과다.

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub tokens: Vec<String>,
    pub items: Vec<SearchHit>,
    pub lists: Vec<ListHit>,
    pub history: Vec<HistoryHit>,
    pub truncated: bool,
}

const ITEM_LIMIT: usize = 200;

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

pub fn search(conn: &Connection, query: &str) -> AppResult<SearchResult> {
    let tokens = text::search_tokens(query);
    if tokens.is_empty() {
        return Ok(SearchResult { query: query.to_string(), tokens, items: vec![], lists: vec![], history: vec![], truncated: false });
    }
    let patterns: Vec<String> = tokens.iter().map(|t| like_pattern(t)).collect();

    let items: Vec<MemoItem> = conn
        .prepare(&format!(
            "SELECT {ITEM_COLUMNS} FROM memo_items i
              WHERE i.deleted_at IS NULL AND {}
                AND EXISTS(SELECT 1 FROM documents d WHERE d.id = i.document_id AND d.deleted_at IS NULL)
              ORDER BY i.updated_at DESC LIMIT {}",
            where_all("i.content_text", patterns.len()),
            ITEM_LIMIT + 1
        ))?
        .query_map(params_from_iter(patterns.iter()), repo::item_from_row)?
        .collect::<Result<_, _>>()?;
    let truncated = items.len() > ITEM_LIMIT;
    let mut hits = Vec::new();
    for item in items.into_iter().take(ITEM_LIMIT) {
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

    Ok(SearchResult { query: query.to_string(), tokens, items: hits, lists, history, truncated })
}
