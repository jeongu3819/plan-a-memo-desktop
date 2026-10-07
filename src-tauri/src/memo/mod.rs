//! 메모 도메인 — DayMemo(날짜 하루 = 문서 1건) · Next List(List 하나 = 문서 1건).
//!
//! React 는 SQL 을 모른다. 화면은 Tauri 명령 → 이 모듈의 함수만 부른다.
//! 모든 쓰기는 transaction 안에서 [로컬 데이터 변경 + 문서 revision + (연결된 문서면) Outbox] 를
//! 함께 commit 한다 — 하나만 저장되고 다른 하나가 빠지는 일이 없다.

pub mod export;
pub mod history;
pub mod repo;
pub mod search;
pub mod service;
pub mod text;

use serde::{Deserialize, Serialize};

pub const DEFAULT_LIST_ID: &str = "00000000-0000-4000-8000-000000000001";
pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DocKind {
    Day,
    NextList,
}

impl DocKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            DocKind::Day => "DAY",
            DocKind::NextList => "NEXT_LIST",
        }
    }
    pub fn parse(value: &str) -> DocKind {
        if value == "NEXT_LIST" {
            DocKind::NextList
        } else {
            DocKind::Day
        }
    }
}

/// 날짜 메모(main/am/pm) 또는 Next List(next) 의 위치.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Location {
    Day { date: String },
    Next { list_id: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub id: String,
    pub kind: DocKind,
    pub memo_date: Option<String>,
    pub next_list_id: Option<String>,
    pub local_revision: i64,
    pub synced_revision: i64,
    pub server_version: Option<i64>,
    pub sync_enabled: bool,
    pub sync_status: String,
    pub sync_error: Option<String>,
    pub has_conflict: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoItem {
    pub id: String,
    pub document_id: String,
    pub section: String,
    pub kind: String,
    pub content_html: String,
    pub completed: bool,
    pub completed_at: Option<String>,
    pub favorite: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayMemo {
    pub date: String,
    pub document: Option<DocumentInfo>,
    pub items: Vec<MemoItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextListInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub sort_order: i64,
    pub item_count: i64,
    pub document: Option<DocumentInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextListMemo {
    pub list: NextListInfo,
    pub items: Vec<MemoItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekMemo {
    pub monday: String,
    pub days: Vec<DayMemo>,
    pub next: NextListMemo,
}

/// 검색·즐겨찾기 결과처럼 위치가 함께 필요한 항목.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedItem {
    pub item: MemoItem,
    pub location: Location,
    pub list_name: Option<String>,
}

// ── Snapshot: History 와 Sync 가 같이 쓰는 '문서 한 건 전체' 표현 ─────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListMeta {
    pub name: String,
    pub is_default: bool,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotItem {
    /// 항목의 안정된 key(로컬 item id). 서버·다른 PC 도 같은 key 로 같은 항목을 가리킨다.
    pub item_key: String,
    pub section: String,
    pub kind: String,
    pub content_html: String,
    pub completed: bool,
    pub completed_at: Option<String>,
    pub sort_order: i64,
    /// 즐겨찾기 — History 에만 담는다. Sync Contract 가 지원하기 전에는 서버로 보내지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub kind: DocKind,
    pub memo_date: Option<String>,
    pub list: Option<ListMeta>,
    #[serde(default)]
    pub deleted: bool,
    pub items: Vec<SnapshotItem>,
}

impl DocumentSnapshot {
    /// 비교·검색용 평문(항목 순서대로).
    pub fn text(&self) -> String {
        self.items.iter().map(|item| text::search_text(&item.content_html)).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n")
    }

    /// 서버로 보낼 형태 — 로컬 전용 값(즐겨찾기)을 뺀다.
    pub fn for_sync(&self) -> DocumentSnapshot {
        let mut copy = self.clone();
        copy.items.iter_mut().for_each(|item| item.favorite = None);
        copy
    }

    /// 내용이 같은가(정렬 번호·즐겨찾기 제외, 항목 순서·내용·체크 기준).
    pub fn same_content(&self, other: &DocumentSnapshot) -> bool {
        let key = |s: &DocumentSnapshot| {
            s.items
                .iter()
                .map(|i| (i.item_key.clone(), i.section.clone(), i.kind.clone(), i.content_html.clone(), i.completed))
                .collect::<Vec<_>>()
        };
        self.deleted == other.deleted && key(self) == key(other)
    }
}

pub fn valid_section_for(kind: DocKind, section: &str) -> bool {
    match kind {
        DocKind::Day => matches!(section, "main" | "am" | "pm"),
        DocKind::NextList => section == "next",
    }
}
