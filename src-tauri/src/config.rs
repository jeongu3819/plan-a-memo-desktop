//! 실행 환경(development/staging/production)과 앱 설정 파일.
//!
//! 앱 설정 파일(`%APPDATA%\com.plana.memo\app-config.json`)에는 **저장 위치 경로만** 둔다.
//! 메모·토큰·계정 정보는 여기에 쓰지 않는다(토큰은 Windows Credential Manager).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppEnv {
    Development,
    Staging,
    Production,
}

impl AppEnv {
    pub fn current() -> Self {
        match option_env!("PLANA_ENV") {
            Some("production") => AppEnv::Production,
            Some("staging") => AppEnv::Staging,
            Some("development") => AppEnv::Development,
            _ if cfg!(debug_assertions) => AppEnv::Development,
            _ => AppEnv::Production,
        }
    }
}

impl AppEnv {
    pub fn label(&self) -> &'static str {
        match self {
            AppEnv::Development => "development",
            AppEnv::Staging => "staging",
            AppEnv::Production => "production",
        }
    }

    /// 업데이트 채널 이름(= 환경). 업데이트 정보(latest.json)의 `channel` 과 엔드포인트 경로에 들어간다.
    pub fn channel(&self) -> &'static str {
        self.label()
    }

    /// 창 열기용 scheme — staging·개발 빌드는 따로 등록해 운영 설치의 `plana-memo://` 를 덮어쓰지 않는다
    /// (개발 실행 파일은 실행할 때 HKCU 에 자기 scheme 을 등록한다 — tauri.dev.conf.json).
    pub fn deep_link_scheme(&self) -> &'static str {
        match self {
            AppEnv::Production => "plana-memo",
            AppEnv::Staging => "plana-memo-staging",
            AppEnv::Development => "plana-memo-dev",
        }
    }

    /// 기본 메모 저장 폴더 이름(사용자 폴더 아래). staging 은 시험 데이터가 실제 메모와 섞이지 않게 따로.
    pub fn default_storage_folder(&self) -> &'static str {
        match self {
            AppEnv::Staging => "PLAN-A Memo Staging",
            _ => "PLAN-A Memo",
        }
    }

    /// 환경별 기본 PLAN-A Work 주소. 개발 빌드는 기본값이 없다(→ Mock 서버) — 운영 Installer 에
    /// 개발·로컬 주소가 들어가지 않게 한다.
    pub fn default_origin(&self) -> Option<&'static str> {
        match self {
            AppEnv::Production => Some("https://planawork.com"),
            AppEnv::Staging => Some("https://staging.planawork.com"),
            AppEnv::Development => None,
        }
    }
}

/// PLAN-A Work 연동 설정(환경별).
///
/// * production → https://planawork.com, staging → https://staging.planawork.com (빌드 때 `PLANA_SERVER_ORIGIN` 으로 바꿀 수 있음)
/// * development → 주소가 없으면 **Mock 서버**. 로컬 Backend 로 시험할 때만 `PLANA_SERVER_ORIGIN=http://127.0.0.1:8000`
///   (빌드 때 또는 실행 때 — 실행 때 값은 development 에서만 읽는다).
/// * API 경로(`/api/memo-sync/native/...`)는 Contract 그대로 코드에 있고, 여기에는 origin 만 둔다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvConfig {
    pub env: AppEnv,
    /// PLAN-A Work Web/API origin(끝 / 없이). None = Mock 서버.
    pub server_origin: Option<String>,
    /// 설치 때 등록하는 scheme — 창 열기 전용(로그인 callback 은 Contract 대로 127.0.0.1 loopback).
    pub deep_link_scheme: &'static str,
    /// 앱 업데이트(Tauri Updater) — 빌드 때 정한 채널의 엔드포인트·서명 공개키. 없으면 업데이트 확인을 끈다.
    pub update: UpdateConfig,
}

/// 업데이트 설정. 개인키는 여기에 없다(빌드 PC 의 환경 변수로만 서명) — 공개키만 앱에 들어간다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    pub channel: &'static str,
    /// latest.json 주소(`{{target}}`·`{{arch}}`·`{{current_version}}` 사용 가능).
    pub endpoint: Option<String>,
    #[serde(skip)]
    pub pubkey: Option<String>,
}

impl UpdateConfig {
    pub fn enabled(&self) -> bool {
        self.endpoint.is_some() && self.pubkey.is_some()
    }
}

/// 업데이트 엔드포인트 검사 — https 만(개발 빌드는 127.0.0.1/localhost 의 http 허용, 로컬 시험용).
/// staging·production 은 경로에 자기 채널 이름(`/staging/`·`/production/`)이 있어야 하고 다른 채널 이름은 없어야 한다
/// — 운영 앱이 staging 업데이트를, staging 앱이 운영 업데이트를 받지 않게(서명키도 채널별로 다르게 쓴다).
pub fn validate_update_endpoint(value: &str, env: AppEnv) -> Option<String> {
    let url = url::Url::parse(value.trim()).ok()?;
    let host = url.host_str()?.to_string();
    let local = matches!(host.as_str(), "127.0.0.1" | "localhost");
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local && env == AppEnv::Development);
    if !scheme_ok || !url.username().is_empty() || url.password().is_some() || (local && env != AppEnv::Development) {
        return None;
    }
    let path = url.path().to_ascii_lowercase();
    let segment = |name: &str| path.contains(&format!("/{name}/"));
    match env {
        AppEnv::Production if !segment("production") || segment("staging") => return None,
        AppEnv::Staging if !segment("staging") || segment("production") => return None,
        _ => {}
    }
    Some(url.as_str().to_string())
}

/// minisign 공개키(`tauri signer generate` 의 .pub 내용 — base64). 형식만 본다.
fn valid_pubkey(value: &str) -> bool {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .is_some_and(|text| text.contains("minisign public key"))
}

/// 운영 PLAN-A Work 호스트(`AppEnv::Production.default_origin`).
fn is_production_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(host.as_str(), "planawork.com" | "www.planawork.com")
}

/// origin 검사 — https(개발 빌드는 127.0.0.1/localhost 의 http 허용), 경로·query·계정 정보 없음.
/// 운영 주소는 운영 빌드에서만 허용한다.
pub fn validate_origin(value: &str, env: AppEnv) -> Option<String> {
    let url = url::Url::parse(value.trim()).ok()?;
    let host = url.host_str()?.to_string();
    let local = matches!(host.as_str(), "127.0.0.1" | "localhost");
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local && env == AppEnv::Development);
    let clean =
        url.path() == "/" && url.query().is_none() && url.fragment().is_none() && url.username().is_empty() && url.password().is_none();
    if !scheme_ok || !clean || (local && env != AppEnv::Development) {
        return None;
    }
    // 운영 주소는 운영 빌드에서만 — 개발·staging 빌드가 운영 서버에 시험 요청을 보내지 않게.
    if env != AppEnv::Production && is_production_host(&host) {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

impl EnvConfig {
    pub fn load() -> Self {
        let env = AppEnv::current();
        let build = option_env!("PLANA_SERVER_ORIGIN").filter(|v| !v.trim().is_empty());
        let runtime =
            if env == AppEnv::Development { std::env::var("PLANA_SERVER_ORIGIN").ok().filter(|v| !v.trim().is_empty()) } else { None };
        let requested = runtime.or_else(|| build.map(str::to_string));
        let server_origin = match requested {
            Some(value) => match validate_origin(&value, env) {
                Some(origin) => Some(origin),
                None => {
                    log::warn!("PLANA_SERVER_ORIGIN is not a valid origin for {:?}; using the default", env);
                    env.default_origin().map(str::to_string)
                }
            },
            None => env.default_origin().map(str::to_string),
        };
        EnvConfig { env, server_origin, deep_link_scheme: env.deep_link_scheme(), update: UpdateConfig::load(env) }
    }

    /// 실제 PLAN-A Work 서버를 쓰는가(false = 개발용 Mock 서버).
    pub fn real_sync_configured(&self) -> bool {
        self.server_origin.is_some()
    }
}

impl UpdateConfig {
    /// 빌드 때 `PLANA_UPDATE_ENDPOINT`·`PLANA_UPDATER_PUBKEY`. development 빌드만 실행 때 같은 이름도 읽는다(로컬 시험).
    pub fn load(env: AppEnv) -> Self {
        let read = |build: Option<&'static str>, name: &str| {
            let runtime = if env == AppEnv::Development { std::env::var(name).ok() } else { None };
            runtime.or_else(|| build.map(str::to_string)).filter(|v| !v.trim().is_empty())
        };
        let endpoint = read(option_env!("PLANA_UPDATE_ENDPOINT"), "PLANA_UPDATE_ENDPOINT").and_then(|value| {
            let checked = validate_update_endpoint(&value, env);
            if checked.is_none() {
                log::warn!("PLANA_UPDATE_ENDPOINT is not valid for the {} channel; updates are disabled", env.channel());
            }
            checked
        });
        let pubkey = read(option_env!("PLANA_UPDATER_PUBKEY"), "PLANA_UPDATER_PUBKEY").and_then(|value| {
            let ok = valid_pubkey(&value);
            if !ok {
                log::warn!("PLANA_UPDATER_PUBKEY is not a minisign public key; updates are disabled");
            }
            ok.then(|| value.trim().to_string())
        });
        UpdateConfig { channel: env.channel(), endpoint, pubkey }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigFile {
    pub storage_dir: Option<PathBuf>,
}

pub struct AppConfigStore {
    path: PathBuf,
}

impl AppConfigStore {
    pub fn new(config_dir: &Path) -> Self {
        AppConfigStore { path: config_dir.join("app-config.json") }
    }

    pub fn load(&self) -> AppConfigFile {
        std::fs::read(&self.path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    /// 임시 파일에 쓰고 바꿔 끼운다 — 쓰는 중 꺼져도 예전 설정이 남는다.
    pub fn save(&self, config: &AppConfigFile) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(config)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// 운영체제가 알려 준 사용자 폴더 + "PLAN-A Memo"(staging 은 "PLAN-A Memo Staging"). 드라이브 문자를 코드에 적지 않는다.
/// 프로그램 설치 폴더(%LOCALAPPDATA%\PLAN-A Memo)와 다른 곳이다 — 제거·업데이트가 메모에 닿지 않는다.
pub fn default_storage_dir(env: AppEnv) -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(env.default_storage_folder()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_validated_per_environment() {
        assert_eq!(validate_origin("https://planawork.com/", AppEnv::Production).as_deref(), Some("https://planawork.com"));
        assert_eq!(validate_origin("http://127.0.0.1:8000", AppEnv::Development).as_deref(), Some("http://127.0.0.1:8000"));
        // 운영·staging 빌드에는 로컬·http 주소를 넣을 수 없다
        assert!(validate_origin("http://127.0.0.1:8000", AppEnv::Production).is_none());
        assert!(validate_origin("https://localhost", AppEnv::Staging).is_none());
        assert!(validate_origin("http://planawork.com", AppEnv::Production).is_none());
        // 경로·query·계정 정보가 섞인 값은 거절
        assert!(validate_origin("https://planawork.com/api", AppEnv::Production).is_none());
        assert!(validate_origin("https://user:pw@planawork.com", AppEnv::Production).is_none());
        assert!(validate_origin("https://planawork.com/?x=1", AppEnv::Production).is_none());
        // 개발·staging 빌드에 운영 주소를 넣을 수 없다(시험 데이터가 운영 서버로 가지 않게)
        assert!(validate_origin("https://planawork.com", AppEnv::Development).is_none());
        assert!(validate_origin("https://WWW.planawork.com", AppEnv::Staging).is_none());
        assert_eq!(validate_origin("https://staging.planawork.com", AppEnv::Development).as_deref(), Some("https://staging.planawork.com"));
        assert_eq!(AppEnv::Development.default_origin(), None, "개발 빌드의 기본은 Mock");
        assert_eq!(AppEnv::Production.default_origin(), Some("https://planawork.com"));
    }

    #[test]
    fn update_endpoints_are_bound_to_their_channel() {
        let prod = "https://updates.example.com/plan-a-memo/production/latest.json";
        let staging = "https://updates.example.com/plan-a-memo/staging/latest.json";
        assert!(validate_update_endpoint(prod, AppEnv::Production).is_some());
        assert!(validate_update_endpoint(staging, AppEnv::Staging).is_some());
        // 운영 앱이 staging 업데이트를, staging 앱이 운영 업데이트를 받지 않는다
        assert!(validate_update_endpoint(staging, AppEnv::Production).is_none());
        assert!(validate_update_endpoint(prod, AppEnv::Staging).is_none());
        assert!(validate_update_endpoint("https://x.example.com/production/staging/latest.json", AppEnv::Production).is_none());
        // https 만(개발 빌드의 로컬 시험 서버만 예외)
        assert!(validate_update_endpoint("http://updates.example.com/production/latest.json", AppEnv::Production).is_none());
        assert!(validate_update_endpoint("http://127.0.0.1:8765/production/latest.json", AppEnv::Production).is_none());
        assert!(validate_update_endpoint("http://127.0.0.1:8765/latest.json", AppEnv::Development).is_some());
        assert!(validate_update_endpoint("https://user:pw@updates.example.com/production/latest.json", AppEnv::Production).is_none());
    }

    #[test]
    fn environments_do_not_share_install_identity() {
        assert_eq!(AppEnv::Production.deep_link_scheme(), "plana-memo");
        assert_eq!(AppEnv::Staging.deep_link_scheme(), "plana-memo-staging");
        assert_eq!(AppEnv::Development.deep_link_scheme(), "plana-memo-dev", "개발 실행이 운영 scheme 등록을 덮지 않는다");
        assert_ne!(AppEnv::Staging.default_storage_folder(), AppEnv::Production.default_storage_folder());
        assert_eq!(AppEnv::Production.default_storage_folder(), "PLAN-A Memo", "기존 운영 사용자의 저장 위치는 그대로");
    }
}
