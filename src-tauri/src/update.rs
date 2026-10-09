//! 앱 업데이트 — Tauri 공식 Updater(서명 검증) 위에 PLAN-A Memo 규칙만 얹는다.
//!
//! * 채널 = 빌드 환경(staging · production). 엔드포인트·공개키는 빌드 때 정해지고(`config::UpdateConfig`),
//!   업데이트 정보(latest.json)의 `channel` 이 이 앱의 채널과 다르면 설치를 제안하지 않는다.
//!   채널마다 서명키도 따로 쓰므로 다른 채널의 설치 파일은 서명 검증에서도 걸린다.
//! * 확인은 자동(시작 후 잠시 뒤·6시간마다, 1시간 안에는 다시 묻지 않음) + 설정의 [업데이트 확인].
//!   새 버전을 알리기만 하고, 설치는 사용자가 [업데이트 설치]를 눌렀을 때만 한다.
//! * 설치 전: 화면이 남은 입력을 저장(flushAll)한 뒤 요청 → 여기서 Backup('pre-update') → 내려받기·서명 검증
//!   → 설치 프로그램 실행(앱 종료, 설치가 끝나면 다시 실행). 서명이 맞지 않거나 내려받기에 실패하면 지금 버전 그대로.
//! * 메모 데이터는 설치 폴더 밖(사용자 폴더)에 있다 — 업데이트는 프로그램 파일만 바꾼다. 서버로 메모를 올리지 않는다.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::config::UpdateConfig;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const AUTO_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const AUTO_MIN_GAP: Duration = Duration::from_secs(3600);
const MANUAL_MIN_GAP: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    /// 릴리스 노트(latest.json 의 notes — 배포 때 release-notes/<버전>.md 에서 온다)
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// 이 빌드에 업데이트 서버·공개키가 설정돼 있는가
    pub enabled: bool,
    pub current_version: String,
    pub checking: bool,
    pub installing: bool,
    pub last_checked_at: Option<String>,
    pub available: Option<UpdateInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    /// downloading | verifying | installing
    pub phase: &'static str,
}

#[derive(Default)]
struct Inner {
    update: Option<Update>,
    info: Option<UpdateInfo>,
    last_check: Option<Instant>,
    last_checked_at: Option<String>,
    checking: bool,
    installing: bool,
    /// 자동 확인으로 이미 알린 버전(같은 실행 중에는 다시 알리지 않는다)
    notified: Option<String>,
}

pub struct UpdateState {
    config: UpdateConfig,
    current_version: String,
    inner: Mutex<Inner>,
}

impl UpdateState {
    pub fn new(config: UpdateConfig, current_version: String) -> Self {
        UpdateState { config, current_version, inner: Mutex::new(Inner::default()) }
    }

    pub fn status(&self) -> UpdateStatus {
        let inner = self.inner.lock().unwrap();
        UpdateStatus {
            enabled: self.config.enabled(),
            current_version: self.current_version.clone(),
            checking: inner.checking,
            installing: inner.installing,
            last_checked_at: inner.last_checked_at.clone(),
            available: inner.info.clone(),
        }
    }

    /// 업데이트 확인. `manual` 이 아니면 1시간 안에 다시 묻지 않는다(그동안은 마지막 결과).
    pub async fn check(&self, app: &AppHandle, manual: bool) -> AppResult<Option<UpdateInfo>> {
        let (endpoint, pubkey) = match (&self.config.endpoint, &self.config.pubkey) {
            (Some(endpoint), Some(pubkey)) => (endpoint.clone(), pubkey.clone()),
            _ => return Err(AppError::new("update_disabled", "이 버전에는 업데이트 서버가 설정되어 있지 않습니다.")),
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.installing {
                return Ok(inner.info.clone());
            }
            let gap = if manual { MANUAL_MIN_GAP } else { AUTO_MIN_GAP };
            if inner.checking || inner.last_check.is_some_and(|t| t.elapsed() < gap) {
                return Ok(inner.info.clone());
            }
            inner.checking = true;
        }
        let result = self.fetch(app, &endpoint, &pubkey).await;
        let mut inner = self.inner.lock().unwrap();
        inner.checking = false;
        inner.last_check = Some(Instant::now());
        match result {
            Ok(found) => {
                inner.last_checked_at = Some(crate::util::now());
                inner.info = found.as_ref().map(|u| info_of(u));
                inner.update = found;
                Ok(inner.info.clone())
            }
            Err(error) => {
                log::warn!("update check failed: {}", error.code());
                if error.code() == "update_channel_mismatch" {
                    // 다른 채널 정보를 받았다 — 예전에 찾은 업데이트도 믿지 않는다(다시 확인할 때까지 설치 제안 없음).
                    inner.update = None;
                    inner.info = None;
                }
                Err(error)
            }
        }
    }

    async fn fetch(&self, app: &AppHandle, endpoint: &str, pubkey: &str) -> AppResult<Option<Update>> {
        let url = url::Url::parse(endpoint).map_err(|_| AppError::new("update_disabled", "업데이트 주소가 올바르지 않습니다."))?;
        let updater = app
            .updater_builder()
            .pubkey(pubkey)
            .endpoints(vec![url])
            .map_err(|e| update_error(&e, "check"))?
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| update_error(&e, "check"))?;
        let found = updater.check().await.map_err(|e| update_error(&e, "check"))?;
        if let Some(update) = &found {
            let channel = update.raw_json.get("channel").and_then(|v| v.as_str()).unwrap_or_default();
            if channel != self.config.channel {
                log::warn!("update manifest channel '{channel}' does not match '{}'; ignored", self.config.channel);
                return Err(AppError::new(
                    "update_channel_mismatch",
                    "업데이트 정보가 이 앱의 배포 채널과 맞지 않아 설치하지 않습니다. 관리자에게 알려주세요.",
                ));
            }
        }
        Ok(found)
    }

    /// 자동 확인에서 새 버전을 처음 봤을 때만 true(같은 실행 중 같은 버전을 반복해서 알리지 않는다).
    fn should_notify(&self, version: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.notified.as_deref() == Some(version) {
            return false;
        }
        inner.notified = Some(version.to_string());
        true
    }

    /// 사용자가 [업데이트 설치]를 눌렀을 때만. 화면은 그 전에 남은 입력을 저장한다.
    pub async fn install(&self, app: &AppHandle) -> AppResult<()> {
        let update = {
            let mut inner = self.inner.lock().unwrap();
            if inner.installing {
                return Err(AppError::new("update_busy", "이미 업데이트를 설치하고 있습니다."));
            }
            let Some(update) = inner.update.take() else {
                return Err(AppError::new("update_none", "설치할 업데이트가 없습니다. 업데이트를 다시 확인해주세요."));
            };
            inner.installing = true;
            update
        };
        let result = self.install_inner(app, &update).await;
        // 여기까지 왔다면 설치 프로그램을 띄우지 못했다(성공하면 앱이 종료된다) — 지금 버전 그대로 쓴다.
        let mut inner = self.inner.lock().unwrap();
        inner.installing = false;
        inner.update = Some(update);
        result
    }

    async fn install_inner(&self, app: &AppHandle, update: &Update) -> AppResult<()> {
        // 1) 설치 전 Backup — 메모 DB·History 를 그대로 남겨 둔다(저장 위치가 열려 있을 때).
        let state = app.state::<AppState>();
        if let Ok(storage) = state.storage() {
            let backup = tauri::async_runtime::spawn_blocking(move || {
                storage.with_conn(|c| crate::storage::backup::create(c, &storage.paths, "pre-update"))
            })
            .await
            .map_err(|_| AppError::new("internal", "작업이 중단되었습니다."))?;
            if let Err(error) = backup {
                log::warn!("pre-update backup failed: {}", error.code());
                return Err(AppError::new(
                    "update_backup_failed",
                    "업데이트 전 Backup 을 만들지 못해 설치하지 않았습니다. 저장 공간을 확인한 뒤 다시 시도해주세요.",
                ));
            }
        }
        // 2) 내려받기 + 서명 검증(Updater 가 공개키로 확인 — 맞지 않으면 설치하지 않는다)
        let emitter = app.clone();
        let mut downloaded: u64 = 0;
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = emitter.emit("update://progress", UpdateProgress { downloaded, total, phase: "downloading" });
                },
                || {
                    let _ = emitter.emit("update://progress", UpdateProgress { downloaded: 0, total: None, phase: "verifying" });
                },
            )
            .await
            .map_err(|e| update_error(&e, "download"))?;
        // 3) 설치 프로그램 실행 → 앱 종료(설치가 끝나면 설치 프로그램이 다시 실행한다)
        let _ = app.emit("update://progress", UpdateProgress { downloaded, total: Some(downloaded), phase: "installing" });
        log::info!("installing update {} -> {}", update.current_version, update.version);
        update.install(bytes).map_err(|e| update_error(&e, "install"))?;
        Ok(())
    }
}

fn info_of(update: &Update) -> UpdateInfo {
    UpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
        date: update.date.map(|d| d.to_string()),
    }
}

/// Updater 오류 → 화면 안내. 진단 로그에는 단계와 분류만.
fn update_error(error: &tauri_plugin_updater::Error, stage: &str) -> AppError {
    use tauri_plugin_updater::Error as E;
    let mapped = match error {
        // 서명 불일치 · 서명된 버전과 공지된 버전이 다름(오래된 설치 파일로 바꿔치기 방지) · 서명에 버전 없음
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => {
            AppError::new("update_signature", "업데이트 파일의 서명을 확인하지 못해 설치하지 않았습니다. 지금 버전을 그대로 사용합니다.")
        }
        E::Reqwest(_) | E::Network(_) if stage == "download" => AppError::new(
            "update_download",
            "업데이트 파일을 내려받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요. 지금 버전은 그대로입니다.",
        ),
        E::Reqwest(_) | E::Network(_) => AppError::new("update_network", "업데이트 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."),
        E::ReleaseNotFound | E::Serialization(_) | E::TargetNotFound(_) | E::TargetsNotFound(_) | E::Semver(_) | E::UrlParse(_) => {
            AppError::new("update_manifest", "업데이트 정보를 읽지 못했습니다. 잠시 후 다시 시도해주세요.")
        }
        E::Io(_) | E::Extract(_) | E::BinaryNotFoundInArchive | E::TempDirNotFound | E::PackageInstallFailed => {
            AppError::new("update_install", "업데이트를 설치하지 못했습니다. 지금 버전을 그대로 사용합니다.")
        }
        _ if error.to_string().to_ascii_lowercase().contains("signature") => {
            AppError::new("update_signature", "업데이트 파일의 서명을 확인하지 못해 설치하지 않았습니다. 지금 버전을 그대로 사용합니다.")
        }
        _ => AppError::new("update_failed", "업데이트를 처리하지 못했습니다. 지금 버전을 그대로 사용합니다."),
    };
    log::warn!("updater {stage} failed: {} ({})", mapped.code(), short_kind(error));
    mapped
}

fn short_kind(error: &tauri_plugin_updater::Error) -> String {
    // 오류 이름만(주소·경로 없음)
    format!("{error:?}").split(['(', ' ', '{']).next().unwrap_or("unknown").to_string()
}

/// 시작 20초 뒤, 이후 6시간마다 확인. 새 버전을 처음 보면 화면에 알린다(설치는 하지 않는다). 오프라인은 조용히 넘어간다.
pub fn spawn_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let state = app.state::<UpdateState>();
            if state.config.enabled() {
                if let Ok(Some(info)) = state.check(&app, false).await {
                    if state.should_notify(&info.version) {
                        let _ = app.emit("update://available", &info);
                    }
                }
            }
            tokio::time::sleep(AUTO_INTERVAL).await;
        }
    });
}
