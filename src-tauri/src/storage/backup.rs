//! 자동 Backup — `VACUUM INTO` 로 일관된 DB 사본을 backups/ 에 만든다.
//!
//! 만드는 때: Migration 전, 저장 위치 변경 전, 앱 버전이 바뀐 첫 실행, 하루 한 번.
//! 개수(최대 20)·용량(최대 1GB) 제한 — 오래된 것부터 지운다(최소 3개는 남긴다).
//! 첨부 이미지는 지우지 않는 파일이라 백업에 복사하지 않는다(DB 가 참조만 한다).

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use rusqlite::Connection;
use serde::Serialize;

use super::StoragePaths;
use crate::error::AppResult;

pub const MAX_BACKUPS: usize = 20;
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
pub const MIN_KEEP: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub size: u64,
    pub created_at: Option<String>,
}

fn sanitize(reason: &str) -> String {
    let cleaned: String =
        reason.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' }).collect();
    cleaned.chars().take(48).collect()
}

pub fn create(conn: &Connection, paths: &StoragePaths, reason: &str) -> AppResult<PathBuf> {
    std::fs::create_dir_all(paths.backups_dir())?;
    let mut target = paths.backups_dir().join(format!("memo-{}-{}.sqlite3", crate::util::file_stamp(), sanitize(reason)));
    let mut n = 1;
    while target.exists() {
        target = paths.backups_dir().join(format!("memo-{}-{}-{n}.sqlite3", crate::util::file_stamp(), sanitize(reason)));
        n += 1;
    }
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    log::info!("backup created: reason={reason}");
    prune(paths)?;
    Ok(target)
}

fn entries(paths: &StoragePaths) -> Vec<(PathBuf, u64, SystemTime)> {
    let mut list: Vec<(PathBuf, u64, SystemTime)> = std::fs::read_dir(paths.backups_dir())
        .map(|it| {
            it.filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().ends_with(".sqlite3"))
                .filter_map(|e| {
                    let meta = e.metadata().ok()?;
                    Some((e.path(), meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)))
                })
                .collect()
        })
        .unwrap_or_default();
    // 새것부터
    list.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
    list
}

pub fn prune(paths: &StoragePaths) -> AppResult<usize> {
    let list = entries(paths);
    let mut total = 0u64;
    let mut removed = 0;
    for (index, (path, size, _)) in list.iter().enumerate() {
        total += size;
        let over = index >= MAX_BACKUPS || total > MAX_TOTAL_BYTES;
        if over && index >= MIN_KEEP && std::fs::remove_file(path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

pub fn list(paths: &StoragePaths) -> Vec<BackupInfo> {
    entries(paths)
        .into_iter()
        .map(|(path, size, modified)| BackupInfo {
            file_name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            size,
            created_at: Some(chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339()),
        })
        .collect()
}

pub fn newest_age(paths: &StoragePaths) -> Option<Duration> {
    entries(paths).first().and_then(|(_, _, modified)| SystemTime::now().duration_since(*modified).ok())
}
