//! Sync — 사용자가 연결한 DAY / NEXT_LIST 만 PLAN-A Work 와 양방향으로 맞춘다(memo-sync-v1).
//!
//! ```text
//!   React UI → Tauri 명령 → memo(로컬 DB + Outbox, 한 transaction)
//!                                  │
//!            SyncRuntime(변경 시·30초마다) → SyncEngine ─ mapper(도메인 ↔ Contract DTO)
//!                                                    └ SyncTransport
//!                                                        ├ PlanAWorkSyncTransport (HTTPS, 실제 서버)
//!                                                        └ MockSyncTransport      (개발·테스트용 가짜 서버)
//! ```

pub mod contract;
pub mod engine;
pub mod http;
pub mod link;
pub mod mapper;
pub mod mock;
pub mod transport;

use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;

use crate::auth::AuthStatus;
use crate::error::AppResult;
use crate::storage::Storage;
use engine::{SyncEngine, SyncReport};

pub struct SyncRuntime {
    pub engine: SyncEngine,
    notify: Arc<tokio::sync::Notify>,
    run_lock: tokio::sync::Mutex<()>,
    last: std::sync::Mutex<Option<SyncReport>>,
}

impl SyncRuntime {
    pub fn new(engine: SyncEngine) -> Self {
        SyncRuntime {
            engine,
            notify: Arc::new(tokio::sync::Notify::new()),
            run_lock: tokio::sync::Mutex::new(()),
            last: std::sync::Mutex::new(None),
        }
    }

    /// 로컬 변경이 있었다 — 잠시 뒤 Sync 를 돌린다(연결된 문서가 없으면 보내는 것이 없다).
    pub fn poke(&self) {
        self.notify.notify_one();
    }

    pub fn notifier(&self) -> Arc<tokio::sync::Notify> {
        self.notify.clone()
    }

    /// 한 번에 하나만 실행한다.
    pub async fn run(&self, storage: &Storage, force: bool) -> AppResult<SyncReport> {
        let _guard = self.run_lock.lock().await;
        let report = self.engine.run_once(storage, force).await?;
        *self.last.lock().unwrap() = Some(report.clone());
        Ok(report)
    }

    /// Conflict 선택 — Sync 실행과 겹치지 않게 같은 잠금 안에서.
    pub async fn resolve(&self, storage: &Storage, conflict_id: &str, choice: engine::ConflictChoice) -> AppResult<crate::memo::Location> {
        let _guard = self.run_lock.lock().await;
        self.engine.resolve_conflict(storage, conflict_id, choice).await
    }

    pub fn last_report(&self) -> Option<SyncReport> {
        self.last.lock().unwrap().clone()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOverview {
    pub transport: &'static str,
    pub is_mock: bool,
    pub env: crate::config::AppEnv,
    pub server_origin: Option<String>,
    pub auth: AuthStatus,
    pub linked_documents: i64,
    pub pending: i64,
    pub conflicts: i64,
    pub errors: i64,
    pub auth_required: i64,
    pub outbox: i64,
    pub other_account: i64,
    pub last_report: Option<SyncReport>,
    pub mock_online: Option<bool>,
}

pub struct Counts {
    pub linked: i64,
    pub pending: i64,
    pub conflicts: i64,
    pub errors: i64,
    pub auth_required: i64,
    pub outbox: i64,
    pub other_account: i64,
}

pub fn counts(conn: &Connection, account_key: Option<&str>) -> AppResult<Counts> {
    Ok(conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM documents WHERE sync_enabled = 1),
            (SELECT COUNT(*) FROM documents WHERE sync_enabled = 1 AND sync_status = 'pending'),
            (SELECT COUNT(*) FROM conflicts WHERE status = 'open'),
            (SELECT COUNT(*) FROM documents WHERE sync_enabled = 1 AND sync_status = 'error'),
            (SELECT COUNT(*) FROM documents WHERE sync_enabled = 1 AND sync_status = 'auth_required'),
            (SELECT COUNT(*) FROM sync_outbox),
            (SELECT COUNT(*) FROM sync_links WHERE ?1 IS NOT NULL AND (account_key IS NULL OR account_key <> ?1))",
        [account_key],
        |r| {
            Ok(Counts {
                linked: r.get(0)?,
                pending: r.get(1)?,
                conflicts: r.get(2)?,
                errors: r.get(3)?,
                auth_required: r.get(4)?,
                outbox: r.get(5)?,
                other_account: r.get(6)?,
            })
        },
    )?)
}
