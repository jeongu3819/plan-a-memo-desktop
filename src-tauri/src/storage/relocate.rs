//! 저장 위치 변경.
//!
//!   기존 저장 정지 → (기존 위치에 Backup) → 새 위치에 복사 → 검증 → 새 위치 활성화
//!
//! 실패하면 새 위치에 만든 것만 지우고 기존 저장소를 그대로 쓴다(기존 데이터는 건드리지 않는다).
//! 성공해도 기존 폴더는 지우지 않는다 — 사용자가 확인한 뒤 직접 지운다.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use super::{backup, inspect_location, open_connection, Storage, StoragePaths, MARKER_FILE};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocateReport {
    pub old_root: String,
    pub new_root: String,
    pub copied_files: u64,
    pub copied_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailPoint {
    None,
    AfterCopy,
    Verify,
}

const COUNTED_TABLES: &[&str] = &[
    "next_lists",
    "documents",
    "memo_items",
    "attachments",
    "document_versions",
    "sync_links",
    "sync_outbox",
    "sync_state",
    "conflicts",
    "settings",
];

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    text.trim_end_matches('\\').to_lowercase()
}

fn is_same_or_inside(child: &Path, parent: &Path) -> bool {
    let c = normalized(child);
    let p = normalized(parent);
    c == p || c.starts_with(&format!("{p}\\"))
}

fn copy_dir(from: &Path, to: &Path, files: &mut u64, bytes: &mut u64) -> AppResult<()> {
    if !from.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target, files, bytes)?;
        } else if kind.is_file() {
            *bytes += std::fs::copy(entry.path(), &target)?;
            *files += 1;
        }
    }
    Ok(())
}

fn table_counts(conn: &Connection) -> AppResult<Vec<i64>> {
    COUNTED_TABLES.iter().map(|table| Ok(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))?)).collect()
}

/// 새 위치를 검증한다 — 무결성, 행 개수, 첨부 파일(개수·크기).
fn verify(old: &Connection, new_paths: &StoragePaths) -> AppResult<()> {
    let new_conn = open_connection(&new_paths.db_path())?;
    let check: String = new_conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if check != "ok" {
        return Err(AppError::new("relocate_verify_failed", "새 위치의 데이터 검증에 실패했습니다(무결성)."));
    }
    if table_counts(old)? != table_counts(&new_conn)? {
        return Err(AppError::new("relocate_verify_failed", "새 위치의 데이터 개수가 기존과 다릅니다."));
    }
    let mut stmt = new_conn.prepare("SELECT relative_path, size FROM attachments")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    for row in rows {
        let (relative, size) = row?;
        let path = new_paths.root.join(&relative);
        let actual = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(-1);
        if actual != size {
            return Err(AppError::new("relocate_verify_failed", "새 위치에 첨부 이미지가 모두 복사되지 않았습니다."));
        }
    }
    Ok(())
}

/// `old` 저장소를 `requested` 위치로 옮기고 새 저장소를 돌려준다.
/// 성공하면 `old` 는 닫힌다(이후 쓰기 불가). 실패하면 `old` 는 그대로 열려 있다.
pub fn relocate(old: &Storage, requested: &Path, fail: FailPoint) -> AppResult<(Storage, RelocateReport)> {
    let inspection = inspect_location(requested);
    if let Some(problem) = inspection.problem {
        return Err(AppError::new("invalid_path", problem));
    }
    let new_root = PathBuf::from(&inspection.resolved_path);
    if inspection.is_storage {
        return Err(AppError::new(
            "target_has_storage",
            "선택한 위치에 이미 PLAN-A Memo 데이터가 있습니다. 비어 있는 폴더를 선택해주세요.",
        ));
    }
    if is_same_or_inside(&new_root, &old.paths.root) || is_same_or_inside(&old.paths.root, &new_root) {
        return Err(AppError::new("invalid_path", "현재 저장 위치와 겹치지 않는 폴더를 선택해주세요."));
    }

    // 1) 기존 저장 정지(연결 잠금) + Backup + WAL 정리
    let guard = old.lock_for_maintenance()?;
    backup::create(&guard, &old.paths, "pre-relocate")?;
    guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;

    let new_paths = StoragePaths::new(&new_root);
    let root_existed = new_root.exists();
    let created: Vec<PathBuf> = vec![
        new_paths.data_dir(),
        new_paths.attachments_dir(),
        new_paths.backups_dir(),
        new_paths.exports_dir(),
        new_paths.sync_dir(),
        new_paths.marker_path(),
    ];
    let cleanup = || {
        if !root_existed {
            let _ = std::fs::remove_dir_all(&new_root);
        } else {
            for path in &created {
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(path);
                } else {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    };

    let result = (|| -> AppResult<RelocateReport> {
        // 2) 복사 — DB 는 VACUUM INTO(일관된 사본), 나머지는 파일 복사
        std::fs::create_dir_all(new_paths.data_dir())?;
        guard.execute("VACUUM INTO ?1", [new_paths.db_path().to_string_lossy().as_ref()])?;
        let mut files = 1u64;
        let mut bytes = std::fs::metadata(new_paths.db_path())?.len();
        for (from, to) in [
            (old.paths.attachments_dir(), new_paths.attachments_dir()),
            (old.paths.backups_dir(), new_paths.backups_dir()),
            (old.paths.exports_dir(), new_paths.exports_dir()),
            (old.paths.sync_dir(), new_paths.sync_dir()),
        ] {
            copy_dir(&from, &to, &mut files, &mut bytes)?;
        }
        if old.paths.marker_path().exists() {
            std::fs::copy(old.paths.marker_path(), new_paths.root.join(MARKER_FILE))?;
        }
        new_paths.ensure_dirs()?;
        if fail == FailPoint::AfterCopy {
            return Err(AppError::new("relocate_copy_failed", "테스트용 복사 실패"));
        }
        // 3) 검증
        verify(&guard, &new_paths)?;
        if fail == FailPoint::Verify {
            return Err(AppError::new("relocate_verify_failed", "테스트용 검증 실패"));
        }
        Ok(RelocateReport {
            old_root: old.paths.root.display().to_string(),
            new_root: new_root.display().to_string(),
            copied_files: files,
            copied_bytes: bytes,
        })
    })();

    match result {
        Ok(report) => {
            // 4) 새 위치 열기 — 여기서 실패해도 기존 저장소는 아직 열려 있다.
            match Storage::open(&new_root, false) {
                Ok((storage, _)) => {
                    old.mark_closed();
                    drop(guard);
                    log::info!("storage relocated ({} files)", report.copied_files);
                    Ok((storage, report))
                }
                Err(error) => {
                    drop(guard);
                    cleanup();
                    Err(error)
                }
            }
        }
        Err(error) => {
            drop(guard);
            cleanup();
            log::warn!("storage relocation rolled back: {}", error.code());
            Err(error)
        }
    }
}
