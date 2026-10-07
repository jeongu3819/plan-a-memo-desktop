#![allow(dead_code)]

use plan_a_memo_lib::memo::{service, Location, MemoItem};
use plan_a_memo_lib::storage::Storage;

/// 1x1 PNG
pub const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
    0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63,
    0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
    0xAE, 0x42, 0x60, 0x82,
];

pub fn temp_storage() -> (tempfile::TempDir, Storage) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("PLAN-A Memo");
    let (storage, _) = Storage::open(&root, true).unwrap();
    (dir, storage)
}

pub fn day(date: &str) -> Location {
    Location::Day { date: date.into() }
}

pub fn next(list: Option<&str>) -> Location {
    Location::Next { list_id: list.map(str::to_string) }
}

pub fn add(storage: &Storage, location: Location, section: &str, html: &str) -> MemoItem {
    storage
        .with_conn(|c| {
            service::create_item(
                c,
                service::CreateItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    location,
                    section: section.into(),
                    kind: "checklist".into(),
                    content_html: html.into(),
                },
            )
        })
        .unwrap()
}

pub fn texts(storage: &Storage, date: &str) -> Vec<String> {
    storage.with_conn(|c| service::get_day(c, date)).unwrap().items.into_iter().map(|i| i.content_html).collect()
}

pub fn count(storage: &Storage, sql: &str) -> i64 {
    storage.with_conn(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
}
