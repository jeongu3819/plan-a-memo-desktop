//! 앱 전역 상태 — 지금 열린 저장소, Sync/Auth 구성.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;

use crate::auth::{AuthApi, CredentialStore, DesktopAuth};
use crate::config::{default_storage_dir, AppConfigFile, AppConfigStore, EnvConfig};
use crate::error::{AppError, AppResult};
use crate::storage::{backup, Storage};
use crate::sync::engine::SyncEngine;
use crate::sync::http::{HttpClient, PlanAWorkAuthApi, PlanAWorkSyncTransport};
use crate::sync::mock::MockSyncTransport;
use crate::sync::transport::SyncTransport;
use crate::sync::SyncRuntime;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    /// ready | first_run | missing | error
    pub state: &'static str,
    pub path: Option<String>,
    pub default_path: Option<String>,
    pub message: Option<String>,
}

pub struct AppState {
    pub env: EnvConfig,
    pub config: AppConfigStore,
    storage: RwLock<Option<Arc<Storage>>>,
    problem: Mutex<Option<StorageStatus>>,
    pub sync: Arc<SyncRuntime>,
    pub auth: Arc<DesktopAuth>,
    /// 개발 빌드에서 서버 주소가 없을 때만 — 운영·staging 빌드에는 없다(개발용 도구도 숨겨진다).
    pub mock: Option<Arc<MockSyncTransport>>,
    pub log_dir: PathBuf,
}

/// (Sync Transport, Auth API, 개발용 Mock 서버, Credential Manager 서비스 이름)
type Adapters = (Arc<dyn SyncTransport>, Arc<dyn AuthApi>, Option<Arc<MockSyncTransport>>, String);

fn credential_store(service_suffix: &str) -> Arc<dyn CredentialStore> {
    #[cfg(windows)]
    {
        Arc::new(crate::auth::WindowsCredentialStore::new(service_suffix))
    }
    #[cfg(not(windows))]
    {
        let _ = service_suffix;
        Arc::new(crate::auth::MemoryCredentialStore::default())
    }
}

impl AppState {
    pub fn new(env: EnvConfig, config_dir: PathBuf, log_dir: PathBuf) -> Self {
        // 환경별: production/staging → 실제 PLAN-A Work(PlanAWorkSyncTransport), development(주소 없음) → Mock 서버.
        let real = env.server_origin.as_deref().and_then(|origin| HttpClient::new(origin).ok());
        let (transport, api, mock, suffix): Adapters = match real {
            Some(http) => (
                Arc::new(PlanAWorkSyncTransport::new(http.clone())),
                Arc::new(PlanAWorkAuthApi::new(http)),
                None,
                env.env.label().to_string(),
            ),
            None => {
                let mock = Arc::new(MockSyncTransport::new());
                // E2E(PLANA_CONFIG_DIR) 는 별도 Credential Manager 항목 — 평소 개발 credential 과 섞이지 않게.
                let suffix = if std::env::var_os("PLANA_CONFIG_DIR").is_some() { "development-e2e" } else { "development-mock" };
                (mock.clone(), mock.clone(), Some(mock), suffix.to_string())
            }
        };
        let auth = Arc::new(DesktopAuth::new(env.env, api, credential_store(&suffix), mock.is_some()));
        let sync = Arc::new(SyncRuntime::new(SyncEngine::new(transport, auth.clone())));
        AppState {
            env,
            config: AppConfigStore::new(&config_dir),
            storage: RwLock::new(None),
            problem: Mutex::new(None),
            sync,
            auth,
            mock,
            log_dir,
        }
    }

    pub fn storage(&self) -> AppResult<Arc<Storage>> {
        self.storage
            .read()
            .map_err(|_| AppError::new("storage_busy", "저장소 잠금 오류"))?
            .clone()
            .ok_or_else(|| AppError::new("storage_not_ready", "메모 저장 위치가 아직 준비되지 않았습니다."))
    }

    pub fn status(&self) -> StorageStatus {
        let default_path = default_storage_dir(self.env.env).map(|p| p.display().to_string());
        if let Ok(storage) = self.storage() {
            return StorageStatus { state: "ready", path: Some(storage.paths.root.display().to_string()), default_path, message: None };
        }
        if let Some(problem) = self.problem.lock().unwrap().clone() {
            return StorageStatus { default_path, ..problem };
        }
        StorageStatus { state: "first_run", path: None, default_path, message: None }
    }

    /// 앱 시작 시 설정된 저장 위치를 연다. 없으면 빈 DB 를 만들지 않고 'missing' 으로 알린다.
    pub fn open_configured(&self) {
        let config = self.config.load();
        let Some(dir) = config.storage_dir else { return };
        match Storage::open(&dir, false) {
            Ok((storage, report)) => {
                if !report.applied_migrations.is_empty() {
                    log::info!("storage opened with migrations {:?}", report.applied_migrations);
                }
                self.activate(storage);
            }
            Err(error) => {
                let state = if error.code() == "storage_missing" { "missing" } else { "error" };
                log::warn!("configured storage could not be opened: {}", error.code());
                *self.problem.lock().unwrap() = Some(StorageStatus {
                    state,
                    path: Some(dir.display().to_string()),
                    default_path: None,
                    message: Some(error.to_string()),
                });
            }
        }
    }

    /// 저장소를 활성화하고 설정 파일에 위치를 기록한다.
    pub fn activate(&self, storage: Storage) {
        if let Some(mock) = &self.mock {
            mock.attach_file(storage.paths.sync_dir().join("mock-server-v1.json"));
        }
        let _ = self.config.save(&AppConfigFile { storage_dir: Some(storage.paths.root.clone()) });
        after_open(&storage);
        *self.storage.write().unwrap() = Some(Arc::new(storage));
        *self.problem.lock().unwrap() = None;
    }

    /// 위치 변경처럼 저장소를 통째로 바꿀 때 — 쓰기 잠금을 잡은 채로 실행.
    pub fn replace_storage<T>(&self, f: impl FnOnce(&Storage) -> AppResult<(Storage, T)>) -> AppResult<T> {
        let mut guard = self.storage.write().map_err(|_| AppError::new("storage_busy", "저장소 잠금 오류"))?;
        let current = guard.clone().ok_or_else(|| AppError::new("storage_not_ready", "저장소가 열려 있지 않습니다."))?;
        let (next, value) = f(&current)?;
        if let Some(mock) = &self.mock {
            mock.attach_file(next.paths.sync_dir().join("mock-server-v1.json"));
        }
        self.config.save(&AppConfigFile { storage_dir: Some(next.paths.root.clone()) })?;
        *guard = Some(Arc::new(next));
        Ok(value)
    }
}

/// 저장소를 연 직후 — 앱 버전이 바뀌었으면 Backup, 하루 한 번 자동 Backup.
fn after_open(storage: &Storage) {
    let version = env!("CARGO_PKG_VERSION");
    let result = storage.with_conn(|conn| {
        let previous: Option<String> =
            rusqlite::OptionalExtension::optional(
                conn.query_row("SELECT value FROM settings WHERE key = 'last_app_version'", [], |r| r.get(0)),
            )?;
        let has_items: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM memo_items)", [], |r| r.get(0))?;
        if let Some(previous) = &previous {
            if previous != version && has_items {
                backup::create(conn, &storage.paths, &format!("upgrade-{previous}-to-{version}"))?;
            }
        }
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('last_app_version', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![version, crate::util::now()],
        )?;
        let stale = backup::newest_age(&storage.paths).map(|age| age.as_secs() > 24 * 3600).unwrap_or(true);
        if has_items && stale {
            backup::create(conn, &storage.paths, "daily")?;
        }
        Ok(())
    });
    if let Err(error) = result {
        log::warn!("post-open maintenance failed: {}", error.code());
    }
}
