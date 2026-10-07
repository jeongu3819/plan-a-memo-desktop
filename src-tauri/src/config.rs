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
}

/// origin 검사 — https(개발 빌드는 127.0.0.1/localhost 의 http 허용), 경로·query·계정 정보 없음.
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
        EnvConfig { env, server_origin, deep_link_scheme: "plana-memo" }
    }

    /// 실제 PLAN-A Work 서버를 쓰는가(false = 개발용 Mock 서버).
    pub fn real_sync_configured(&self) -> bool {
        self.server_origin.is_some()
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

/// 운영체제가 알려 준 사용자 폴더 + "PLAN-A Memo". 드라이브 문자를 코드에 적지 않는다.
pub fn default_storage_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("PLAN-A Memo"))
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
        assert_eq!(AppEnv::Development.default_origin(), None, "개발 빌드의 기본은 Mock");
        assert_eq!(AppEnv::Production.default_origin(), Some("https://planawork.com"));
    }
}
