//! PLAN-A Work 계정 연결(Desktop Auth) — 로컬 메모에는 로그인이 필요 없다. 'PLAN-A Work 와 연결' 할 때만 쓴다.
//!
//! memo-sync-v1 "Native authentication":
//! ```text
//! PLAN-A Memo ─ PKCE(S256) verifier/challenge + state, 127.0.0.1 임시 포트 listener
//!   → POST native/auth/start {name, challenge, state, redirect_uri, device_id?}
//!   → 기본 브라우저: <Web origin><browser_path>  (기존 PLAN-A 로그인 — Google/Naver/이메일)
//!   → Web 동의 → 60초 일회용 PLAN-A code → http://127.0.0.1:<port>/memo-sync/callback?code&state
//!   → state 확인 → POST native/auth/exchange {code, verifier, redirect_uri}
//!   → Desktop 전용 credential(30일) + device_id → Windows Credential Manager
//! ```
//! * Web Cookie·Google/Naver code 는 브라우저 밖으로 나오지 않는다. 이 앱은 Cookie 를 다루지 않는다.
//! * credential·code·verifier 는 DB·설정 파일·로그에 쓰지 않는다.
//! * 로그아웃 = 서버에서 이 기기 credential 폐기(연결 중단). 로컬 메모는 그대로.

pub mod loopback;
pub mod pkce;

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::config::AppEnv;
use crate::error::{AppError, AppResult};
use crate::sync::contract::{AuthStartRequest, AuthStartResponse, ExchangeRequest, ExchangeResponse};
use crate::sync::transport::{TResult, TransportError};

// ── 서버 Auth API(실제: sync::http::PlanAWorkAuthApi, 개발·테스트: sync::mock::MockSyncTransport) ──

#[async_trait]
pub trait AuthApi: Send + Sync {
    /// 브라우저로 열 Web origin(Mock 은 None — 브라우저를 열지 않는다).
    fn web_origin(&self) -> Option<String>;
    async fn start(&self, body: &AuthStartRequest) -> TResult<AuthStartResponse>;
    async fn exchange(&self, body: &ExchangeRequest) -> TResult<ExchangeResponse>;
    async fn logout(&self, access_token: &str) -> TResult<()>;
}

// ── Credential 저장소 ───────────────────────────────────────────────────

pub trait CredentialStore: Send + Sync {
    fn save(&self, key: &str, secret: &str) -> AppResult<()>;
    fn load(&self, key: &str) -> AppResult<Option<String>>;
    fn delete(&self, key: &str) -> AppResult<()>;
}

/// Windows Credential Manager. 서비스 이름은 환경별로 나눈다(개발 credential 이 운영과 섞이지 않게).
#[cfg(windows)]
pub struct WindowsCredentialStore {
    service: String,
}

#[cfg(windows)]
impl WindowsCredentialStore {
    pub fn new(service_suffix: &str) -> Self {
        WindowsCredentialStore { service: format!("PLAN-A Memo ({service_suffix})") }
    }
}

#[cfg(windows)]
impl CredentialStore for WindowsCredentialStore {
    fn save(&self, key: &str, secret: &str) -> AppResult<()> {
        keyring::Entry::new(&self.service, key)
            .and_then(|e| e.set_password(secret))
            .map_err(|_| AppError::new("credential_error", "자격 증명을 저장하지 못했습니다(Windows 자격 증명 관리자)."))
    }
    fn load(&self, key: &str) -> AppResult<Option<String>> {
        match keyring::Entry::new(&self.service, key).and_then(|e| e.get_password()) {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AppError::new("credential_error", "자격 증명을 읽지 못했습니다.")),
        }
    }
    fn delete(&self, key: &str) -> AppResult<()> {
        match keyring::Entry::new(&self.service, key).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::new("credential_error", "자격 증명을 지우지 못했습니다.")),
        }
    }
}

/// 테스트 용 — 프로세스 메모리에만.
#[derive(Default)]
pub struct MemoryCredentialStore {
    entries: Mutex<std::collections::HashMap<String, String>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn save(&self, key: &str, secret: &str) -> AppResult<()> {
        self.entries.lock().unwrap().insert(key.into(), secret.into());
        Ok(())
    }
    fn load(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self.entries.lock().unwrap().get(key).cloned())
    }
    fn delete(&self, key: &str) -> AppResult<()> {
        self.entries.lock().unwrap().remove(key);
        Ok(())
    }
}

const CREDENTIAL_KEY: &str = "memo-sync-v1-desktop-credential";

/// Credential Manager 에 한 건으로 넣는 값. Contract 가 주는 값만(refresh token 은 Contract 에 없다 —
/// 30일 만료 후 브라우저로 다시 연결한다).
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    version: u8,
    access_token: String,
    expires_at: String,
    /// 서버가 발급한 기기 id — 재연결(auth/start 의 device_id)에 쓴다.
    server_device_id: String,
    user_id: i64,
    namespace: String,
    device_name: String,
    connected_at: String,
    /// 서버가 401 을 돌려줬다(만료·Web 에서 기기 해제) — 다시 연결이 필요하다.
    #[serde(default)]
    expired: bool,
    /// 서버가 이 기기 id 를 폐기했다(409 device_revoked — Web 기기 해제·로그아웃). 같은 id 로는 다시 연결하지 않는다.
    #[serde(default)]
    revoked: bool,
}

impl std::fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredCredential")
            .field("access_token", &"<redacted>")
            .field("server_device_id", &self.server_device_id)
            .field("user_id", &self.user_id)
            .field("namespace", &self.namespace)
            .finish()
    }
}

impl StoredCredential {
    fn account_key(&self) -> String {
        account_key(&self.namespace, self.user_id)
    }
    fn usable(&self) -> bool {
        !self.expired
            && !self.revoked
            && chrono::DateTime::parse_from_rfc3339(&self.expires_at)
                .map(|t| t.with_timezone(&chrono::Utc) > chrono::Utc::now())
                .unwrap_or(false)
    }
}

/// 로컬 Sync 상태를 나누는 키. 권한 판단에 쓰지 않는다(권한은 서버가 credential 로 판단한다).
pub fn account_key(namespace: &str, user_id: i64) -> String {
    format!("{namespace}|{user_id}")
}

// ── 화면에 보이는 상태 ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub account_key: String,
    pub user_id: i64,
    pub display_name: String,
    pub namespace: String,
    pub server_device_id: String,
    pub device_name: String,
    pub connected_at: String,
    pub expires_at: String,
    /// 개발용 Mock 서버 계정 — 실제 PLAN-A Work 계정이 아니다.
    pub is_mock: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// mock | plan-a-work
    pub provider: &'static str,
    /// 연결할 서버가 정해져 있는가(개발 빌드에서 주소가 없으면 Mock).
    pub configured: bool,
    pub web_origin: Option<String>,
    pub logged_in: bool,
    /// 만료·Web 에서 기기 해제 — 같은 기기로 다시 연결할 수 있다.
    pub expired: bool,
    /// 이 기기가 PLAN-A Work 에서 폐기됨(device_revoked) — 같은 기기로 다시 연결할 수 없고, 새 기기 등록만 가능.
    pub revoked: bool,
    pub login_pending: bool,
    pub session: Option<AuthSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    /// browser — 기본 브라우저로 연다 / mock — 브라우저 없이 Mock 동의
    pub mode: &'static str,
    pub authorize_url: Option<String>,
    /// Mock 동의에 쓰는 요청 id(서버가 준 값 — 비밀이 아니다).
    pub authorization_id: String,
    pub expires_in: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResult {
    /// 서버에서 이 기기 credential 이 폐기되었는가(오프라인이면 false — Web 기기 관리에서 해제 가능).
    pub server_revoked: bool,
    pub account_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// Engine 이 요청에 쓰는 값.
#[derive(Clone)]
pub struct SessionContext {
    pub access_token: String,
    pub account_key: String,
    pub server_device_id: String,
}

impl std::fmt::Debug for SessionContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionContext").field("account_key", &self.account_key).finish()
    }
}

/// Engine 이 보는 인증 경계(테스트에서 바꿔 끼울 수 있게 trait).
pub trait AuthProvider: Send + Sync {
    fn status(&self) -> AuthStatus;
    /// 로그인돼 있고 만료되지 않았으면 요청 정보.
    fn session_context(&self) -> Option<SessionContext>;
    /// 서버가 401 — credential 만료·폐기.
    fn mark_expired(&self);
}

struct PendingLogin {
    /// 같은 기기로 다시 연결하는 요청이면 그 서버 기기 id
    device_id: Option<String>,
    state: String,
    pkce: pkce::PkcePair,
    redirect_uri: String,
    authorization_id: String,
    started: std::time::Instant,
}

/// 실제 Desktop Auth. `api` 가 실제 서버면 브라우저 로그인, Mock 이면 개발용 흉내.
pub struct DesktopAuth {
    env: AppEnv,
    api: Arc<dyn AuthApi>,
    credentials: Arc<dyn CredentialStore>,
    device_name: String,
    is_mock: bool,
    cache: Mutex<Option<Option<StoredCredential>>>,
    pending: Mutex<Option<PendingLogin>>,
}

/// 서버 namespace(`<환경>:<server id>`)가 이 빌드의 환경과 맞는가 — 운영 앱이 개발 서버 credential 을 받지 않고,
/// 개발 빌드(시험·E2E)가 운영 서버에 연결해 시험 데이터를 올리지 않게.
pub fn namespace_allowed(env: AppEnv, namespace: &str) -> bool {
    let server_env = namespace.split(':').next().unwrap_or_default();
    match env {
        AppEnv::Production => server_env == "production",
        AppEnv::Staging => server_env == "staging",
        AppEnv::Development => matches!(server_env, "local" | "staging"),
    }
}

pub fn default_device_name() -> String {
    let host = std::env::var("COMPUTERNAME").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "Windows PC".into());
    let name = format!("PLAN-A Memo · {host}");
    name.chars().take(80).collect()
}

impl DesktopAuth {
    pub fn new(env: AppEnv, api: Arc<dyn AuthApi>, credentials: Arc<dyn CredentialStore>, is_mock: bool) -> Self {
        DesktopAuth {
            env,
            api,
            credentials,
            device_name: default_device_name(),
            is_mock,
            cache: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }

    pub fn with_device_name(mut self, name: &str) -> Self {
        self.device_name = name.chars().take(80).collect();
        self
    }

    fn stored(&self) -> Option<StoredCredential> {
        let mut cache = self.cache.lock().unwrap();
        if cache.is_none() {
            let loaded = match self.credentials.load(CREDENTIAL_KEY) {
                Ok(Some(json)) => serde_json::from_str::<StoredCredential>(&json).ok(),
                Ok(None) => None,
                Err(error) => {
                    log::warn!("credential load failed: {}", error.code());
                    None
                }
            };
            // 다른 환경의 credential 은 쓰지 않는다(서비스 이름이 환경별이라 보통 없다).
            *cache = Some(loaded.filter(|c| namespace_allowed(self.env, &c.namespace)));
        }
        cache.clone().flatten()
    }

    fn store(&self, credential: Option<StoredCredential>) -> AppResult<()> {
        match &credential {
            Some(value) => self.credentials.save(CREDENTIAL_KEY, &serde_json::to_string(value)?)?,
            None => self.credentials.delete(CREDENTIAL_KEY)?,
        }
        *self.cache.lock().unwrap() = Some(credential);
        Ok(())
    }

    fn session_of(&self, c: &StoredCredential) -> AuthSession {
        AuthSession {
            account_key: c.account_key(),
            user_id: c.user_id,
            display_name: if self.is_mock {
                format!("Mock 사용자 #{}", c.user_id)
            } else {
                format!("PLAN-A Work 사용자 #{}", c.user_id)
            },
            namespace: c.namespace.clone(),
            server_device_id: c.server_device_id.clone(),
            device_name: c.device_name.clone(),
            connected_at: c.connected_at.clone(),
            expires_at: c.expires_at.clone(),
            is_mock: self.is_mock,
        }
    }

    /// 로그인 시작 — listener 는 호출자가 먼저 열어 redirect_uri 를 넘긴다(브라우저보다 먼저).
    /// `reconnect` 면 저장된 서버 device_id 로 같은 기기를 다시 연결한다(링크·cursor 유지).
    pub async fn begin_login(&self, redirect_uri: &str, reconnect: bool) -> AppResult<LoginStart> {
        let pair = pkce::PkcePair::generate();
        let state = pkce::random_state();
        if reconnect && self.stored().is_some_and(|c| c.revoked) {
            // 폐기된 기기 id 로 다시 시도하지 않는다(서버도 409) — 새 기기 등록은 사용자가 따로 고른다.
            return Err(device_revoked_error());
        }
        let device_id = if reconnect { self.stored().map(|c| c.server_device_id) } else { None };
        let body = AuthStartRequest {
            name: self.device_name.clone(),
            challenge: pair.challenge.clone(),
            state: state.clone(),
            redirect_uri: redirect_uri.to_string(),
            device_id: device_id.clone(),
        };
        let response = self.api.start(&body).await.map_err(|e| auth_error(&e, "로그인을 시작하지 못했습니다."))?;
        if !namespace_allowed(self.env, &response.namespace) {
            return Err(AppError::new("auth_wrong_environment", "이 PLAN-A Memo 와 다른 환경의 PLAN-A Work 서버입니다."));
        }
        let authorize_url = match self.api.web_origin() {
            Some(origin) => {
                let path = &response.browser_path;
                if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
                    return Err(AppError::new("auth_invalid_response", "서버가 알려 준 로그인 주소가 올바르지 않습니다."));
                }
                Some(format!("{}{path}", origin.trim_end_matches('/')))
            }
            None => None,
        };
        *self.pending.lock().unwrap() = Some(PendingLogin {
            state,
            pkce: pair,
            redirect_uri: redirect_uri.to_string(),
            authorization_id: response.authorization_id.clone(),
            device_id,
            started: std::time::Instant::now(),
        });
        Ok(LoginStart {
            mode: if authorize_url.is_some() { "browser" } else { "mock" },
            authorize_url,
            authorization_id: response.authorization_id,
            expires_in: response.expires_in,
        })
    }

    pub fn cancel_login(&self) {
        *self.pending.lock().unwrap() = None;
    }

    pub fn login_pending(&self) -> bool {
        self.pending.lock().unwrap().is_some()
    }

    /// callback(code, state) → state 확인 → code + verifier 교환 → credential 저장.
    pub async fn complete_login(&self, params: CallbackParams) -> AppResult<AuthSession> {
        let pending = self.pending.lock().unwrap().take();
        let Some(pending) = pending else {
            return Err(AppError::new("auth_no_pending", "진행 중인 로그인이 없습니다. 다시 시도해주세요."));
        };
        if !constant_time_eq(pending.state.as_bytes(), params.state.as_bytes()) {
            return Err(AppError::new("auth_state_mismatch", "로그인 요청이 일치하지 않습니다. 다시 시도해주세요."));
        }
        if pending.started.elapsed() > loopback::LOGIN_TIMEOUT {
            return Err(AppError::new("auth_timeout", "로그인 시간이 지났습니다. 다시 시도해주세요."));
        }
        let request =
            ExchangeRequest { code: params.code, verifier: pending.pkce.verifier.clone(), redirect_uri: pending.redirect_uri.clone() };
        let response = match self.api.exchange(&request).await {
            Ok(response) => response,
            Err(error) if error.is_conflict("device_revoked") => {
                // 폐기된 기기 — 되살리지 않는다. 같은 id 로 다시 묻지 않도록 기억하고(로컬 메모·Outbox 는 그대로),
                // 새 기기 등록은 사용자가 고를 때만.
                if pending.device_id.is_some() {
                    self.mark_revoked();
                }
                return Err(device_revoked_error());
            }
            Err(error) => return Err(auth_error(&error, "로그인을 마치지 못했습니다.")),
        };
        if response.token_type != "Bearer" || !response.access_token.starts_with("pms_") {
            return Err(AppError::new("auth_invalid_response", "서버 응답이 Desktop credential 형식이 아닙니다."));
        }
        if !namespace_allowed(self.env, &response.namespace) {
            return Err(AppError::new("auth_wrong_environment", "이 PLAN-A Memo 와 다른 환경의 PLAN-A Work 서버입니다."));
        }
        let now = chrono::Utc::now();
        let credential = StoredCredential {
            version: 1,
            access_token: response.access_token.clone(),
            expires_at: (now + chrono::Duration::seconds(response.expires_in.clamp(60, 400 * 24 * 3600)))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            server_device_id: response.device_id.clone(),
            user_id: response.user_id,
            namespace: response.namespace.clone(),
            device_name: self.device_name.clone(),
            connected_at: crate::util::now(),
            expired: false,
            revoked: false,
        };
        self.store(Some(credential.clone()))?;
        log::info!("desktop credential stored (device registered)");
        Ok(self.session_of(&credential))
    }

    /// 로그아웃 — 서버에 이 기기 폐기를 알리고(실패해도) 로컬 credential 을 지운다.
    pub async fn logout(&self) -> AppResult<LogoutResult> {
        self.cancel_login();
        let Some(credential) = self.stored() else { return Ok(LogoutResult { server_revoked: false, account_key: None }) };
        let server_revoked = if credential.usable() {
            match self.api.logout(&credential.access_token).await {
                Ok(()) | Err(TransportError::AuthRequired) => true,
                Err(error) => {
                    log::info!("logout not confirmed by server: {error}");
                    false
                }
            }
        } else {
            true // 이미 만료·폐기된 credential
        };
        self.store(None)?;
        Ok(LogoutResult { server_revoked, account_key: Some(credential.account_key()) })
    }

    /// 서버가 이 기기 id 를 폐기했다고 알렸다 — credential 은 쓸 수 없게 지우고(토큰 없음) 계정·기기 정보만 남긴다.
    fn mark_revoked(&self) {
        if let Some(mut c) = self.stored() {
            c.revoked = true;
            c.expired = true;
            c.access_token.clear();
            if let Err(error) = self.store(Some(c)) {
                log::warn!("credential update failed: {}", error.code());
            }
        }
    }

    pub fn pending_authorization_id(&self) -> Option<String> {
        self.pending.lock().unwrap().as_ref().map(|p| p.authorization_id.clone())
    }
}

impl AuthProvider for DesktopAuth {
    fn status(&self) -> AuthStatus {
        let stored = self.stored();
        AuthStatus {
            provider: if self.is_mock { "mock" } else { "plan-a-work" },
            configured: true,
            web_origin: self.api.web_origin(),
            logged_in: stored.as_ref().map(|c| c.usable()).unwrap_or(false),
            expired: stored.as_ref().map(|c| !c.usable()).unwrap_or(false),
            revoked: stored.as_ref().map(|c| c.revoked).unwrap_or(false),
            login_pending: self.login_pending(),
            session: stored.as_ref().map(|c| self.session_of(c)),
        }
    }

    fn session_context(&self) -> Option<SessionContext> {
        let c = self.stored()?;
        c.usable().then(|| SessionContext {
            access_token: c.access_token.clone(),
            account_key: c.account_key(),
            server_device_id: c.server_device_id.clone(),
        })
    }

    fn mark_expired(&self) {
        if let Some(mut c) = self.stored() {
            if !c.expired {
                c.expired = true;
                if let Err(error) = self.store(Some(c)) {
                    log::warn!("credential update failed: {}", error.code());
                }
            }
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub const DEVICE_REVOKED_MESSAGE: &str =
    "이 기기의 PLAN-A Work 연결이 해제되었습니다. 로컬 메모는 그대로 보존되어 있습니다. 다시 연결하려면 새 기기 등록이 필요합니다.";

fn device_revoked_error() -> AppError {
    AppError::new("device_revoked", DEVICE_REVOKED_MESSAGE)
}

fn auth_error(error: &TransportError, fallback: &str) -> AppError {
    match error {
        TransportError::Offline => AppError::new("offline", "PLAN-A Work 에 연결할 수 없습니다. 인터넷 연결을 확인해주세요."),
        TransportError::Unavailable => AppError::new("sync_unavailable", "PLAN-A Work 에서 Desktop 연결을 아직 사용할 수 없습니다."),
        TransportError::AuthRequired => {
            AppError::new("auth_code_invalid", "로그인 코드가 만료되었거나 이미 사용되었습니다. 다시 로그인해주세요.")
        }
        TransportError::NotFound => AppError::new("auth_device_missing", "이 PC 의 기기 등록을 찾을 수 없습니다. 새로 로그인해주세요."),
        TransportError::Conflict { code } if code == "device_revoked" => device_revoked_error(),
        TransportError::RateLimited => AppError::new("rate_limited", "로그인 시도가 너무 많습니다. 잠시 뒤 다시 시도해주세요."),
        other => AppError::new("auth_failed", format!("{fallback} ({other})")),
    }
}
