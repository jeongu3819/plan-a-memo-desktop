//! 저장 위치(폴더)와 SQLite 연결.
//!
//! ```text
//! <저장 위치>/
//!   .plana-memo-storage.json   이 폴더가 PLAN-A Memo 저장소임을 표시
//!   data/memo.sqlite3          메모 · History · Sync Outbox · 설정
//!   attachments/YYYY/MM/<id>.<ext>
//!   backups/
//!   exports/
//!   sync/                      (Mock 서버 상태 등 Sync 보조 파일)
//! ```

pub mod backup;
pub mod migrations;
pub mod relocate;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const MARKER_FILE: &str = ".plana-memo-storage.json";
pub const DEFAULT_FOLDER_NAME: &str = "PLAN-A Memo";

#[derive(Debug, Clone)]
pub struct StoragePaths {
    pub root: PathBuf,
}

impl StoragePaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        StoragePaths { root: root.into() }
    }
    pub fn data_dir(&self) -> PathBuf {
        self.root.join("data")
    }
    pub fn db_path(&self) -> PathBuf {
        self.data_dir().join("memo.sqlite3")
    }
    pub fn attachments_dir(&self) -> PathBuf {
        self.root.join("attachments")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.root.join("backups")
    }
    pub fn exports_dir(&self) -> PathBuf {
        self.root.join("exports")
    }
    pub fn sync_dir(&self) -> PathBuf {
        self.root.join("sync")
    }
    pub fn marker_path(&self) -> PathBuf {
        self.root.join(MARKER_FILE)
    }

    pub fn ensure_dirs(&self) -> AppResult<()> {
        for dir in [self.data_dir(), self.attachments_dir(), self.backups_dir(), self.exports_dir(), self.sync_dir()] {
            std::fs::create_dir_all(dir)?;
        }
        if !self.marker_path().exists() {
            let marker = serde_json::json!({
                "format": "plan-a-memo-storage",
                "version": 1,
                "created_at": crate::util::now(),
                "app_version": env!("CARGO_PKG_VERSION"),
            });
            std::fs::write(self.marker_path(), serde_json::to_vec_pretty(&marker)?)?;
        }
        Ok(())
    }

    /// 이미 메모 DB 가 있는 저장소인가.
    pub fn has_database(&self) -> bool {
        self.db_path().is_file()
    }
}

pub struct Storage {
    pub paths: StoragePaths,
    conn: Mutex<Connection>,
    /// 위치 변경 후 예전 저장소로 쓰기가 들어가지 않게 닫힘 표시.
    closed: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReport {
    pub created: bool,
    pub applied_migrations: Vec<i64>,
    pub backup_before_migration: Option<String>,
}

impl Storage {
    /// 저장소를 연다. `create` 가 false 면 DB 가 없을 때 새로 만들지 않는다
    /// (설정된 위치가 사라졌는데 빈 DB 가 열려 데이터가 사라진 것처럼 보이면 안 되므로).
    pub fn open(root: &Path, create: bool) -> AppResult<(Storage, OpenReport)> {
        let paths = StoragePaths::new(root);
        let existed = paths.has_database();
        if !existed && !create {
            return Err(AppError::new("storage_missing", "저장 위치에서 메모 데이터를 찾을 수 없습니다."));
        }
        paths.ensure_dirs()?;
        let mut conn = open_connection(&paths.db_path())?;
        let pending = migrations::pending(&conn)?;
        let mut backup_path = None;
        if existed && !pending.is_empty() && migrations::current_version(&conn)? > 0 {
            let path = backup::create(&conn, &paths, &format!("pre-migration-v{}", pending[0]))?;
            backup_path = Some(path.display().to_string());
        }
        let applied = migrations::apply(&mut conn)?;
        let storage = Storage { paths, conn: Mutex::new(conn), closed: AtomicBool::new(false) };
        Ok((storage, OpenReport { created: !existed, applied_migrations: applied, backup_before_migration: backup_path }))
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.conn.lock().map_err(|_| AppError::new("storage_busy", "저장소 잠금 오류"))?;
        if self.closed.load(Ordering::SeqCst) {
            return Err(AppError::new("storage_moved", "저장 위치가 바뀌었습니다. 다시 시도해주세요."));
        }
        f(&mut guard)
    }

    /// 모든 쓰기를 멈추고 WAL 을 DB 파일로 합친다. 이후 with_conn 은 실패한다.
    pub fn close(&self) {
        if let Ok(guard) = self.conn.lock() {
            let _ = guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    /// 위치 변경처럼 잠근 채로 여러 단계를 해야 할 때.
    pub(crate) fn lock_for_maintenance(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        let guard = self.conn.lock().map_err(|_| AppError::new("storage_busy", "저장소 잠금 오류"))?;
        if self.closed.load(Ordering::SeqCst) {
            return Err(AppError::new("storage_moved", "저장 위치가 바뀌었습니다."));
        }
        Ok(guard)
    }

    pub(crate) fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

pub fn open_connection(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(conn)
}

/// WAL + FULL sync(전원이 꺼져도 commit 된 내용은 남는다) + 외래키.
pub fn configure(conn: &Connection) -> AppResult<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInspection {
    pub path: String,
    /// 실제로 저장소가 만들어질 폴더(비어 있지 않은 일반 폴더면 그 안의 "PLAN-A Memo").
    pub resolved_path: String,
    pub exists: bool,
    pub is_storage: bool,
    pub writable: bool,
    pub problem: Option<String>,
}

/// 사용자가 고른 폴더를 저장 위치로 쓸 수 있는지 본다(아무것도 만들지 않는다).
pub fn inspect_location(path: &Path) -> LocationInspection {
    let mut result = LocationInspection {
        path: path.display().to_string(),
        resolved_path: path.display().to_string(),
        exists: path.exists(),
        is_storage: false,
        writable: false,
        problem: None,
    };
    if !path.is_absolute() {
        result.problem = Some("전체 경로(예: C:\\Users\\…)를 선택해주세요.".into());
        return result;
    }
    if path.parent().is_none() {
        result.problem = Some("드라이브 최상위 폴더는 쓸 수 없습니다. 그 안의 폴더를 선택해주세요.".into());
        return result;
    }
    if result.exists && !path.is_dir() {
        result.problem = Some("폴더가 아니라 파일입니다.".into());
        return result;
    }
    // 프로그램 설치 폴더 안은 제거(Uninstall) 때 함께 지워질 수 있다 — 메모 저장소로 쓰지 않는다.
    if let Some(install_dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        let inside = |a: &Path, b: &Path| {
            let (a, b) = (a.to_string_lossy().replace('/', "\\").to_lowercase(), b.to_string_lossy().replace('/', "\\").to_lowercase());
            let b = b.trim_end_matches('\\').to_string();
            a == b || a.starts_with(&format!("{b}\\"))
        };
        if inside(path, &install_dir) {
            result.problem = Some("프로그램 설치 폴더 안에는 저장할 수 없습니다(제거할 때 함께 지워질 수 있습니다).".into());
            return result;
        }
    }
    let paths = StoragePaths::new(path);
    result.is_storage = paths.has_database();
    let mut resolved = path.to_path_buf();
    if result.exists && !result.is_storage {
        let empty = std::fs::read_dir(path).map(|mut it| it.next().is_none()).unwrap_or(false);
        if !empty {
            resolved = path.join(DEFAULT_FOLDER_NAME);
            if StoragePaths::new(&resolved).has_database() {
                result.is_storage = true;
            }
        }
    }
    result.resolved_path = resolved.display().to_string();
    // 쓰기 확인: 가장 가까운 존재하는 상위 폴더에 임시 파일을 써 본다.
    let mut probe_dir = resolved.as_path();
    while !probe_dir.exists() {
        match probe_dir.parent() {
            Some(parent) => probe_dir = parent,
            None => break,
        }
    }
    let probe = probe_dir.join(format!(".plana-write-test-{}", crate::util::new_id()));
    result.writable = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    if !result.writable {
        result.problem = Some("이 위치에 쓸 권한이 없습니다. 다른 폴더를 선택해주세요.".into());
    }
    result
}
