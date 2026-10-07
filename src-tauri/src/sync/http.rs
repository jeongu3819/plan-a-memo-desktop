//! PlanAWorkSyncTransport — 실제 PLAN-A Work 서버(HTTPS)와 memo-sync-v1 native 경로로 통신한다.
//!
//! * 주소는 환경별 설정(`config::EnvConfig::server_origin`)에서만 온다. 응답·deep link 가 알려 준 주소로 바꾸지 않는다.
//! * 인증은 Desktop 전용 Bearer credential 뿐이다. Cookie 를 저장하거나 보내지 않는다(cookie store 없음).
//! * 요청·응답 본문, 토큰, code, verifier 를 로그에 남기지 않는다(경로와 상태 코드만).

use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::contract::*;
use super::transport::*;
use crate::auth::AuthApi;

#[derive(Clone)]
pub struct HttpClient {
    origin: String,
    client: reqwest::Client,
    upload_client: reqwest::Client,
}

impl std::fmt::Debug for HttpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpClient").field("origin", &self.origin).finish()
    }
}

fn user_agent() -> String {
    format!("PLAN-A-Memo/{} (Windows; memo-sync-v1)", env!("CARGO_PKG_VERSION"))
}

impl HttpClient {
    /// `origin` 예: https://planawork.com (끝의 / 없이). 검증은 config 에서 끝났다.
    pub fn new(origin: &str) -> Result<Self, TransportError> {
        let build = |timeout: u64| {
            reqwest::Client::builder()
                .user_agent(user_agent())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(timeout))
                .redirect(reqwest::redirect::Policy::none())
                .https_only(origin.starts_with("https://"))
                .build()
                .map_err(|_| TransportError::Server("HTTP client".into()))
        };
        Ok(HttpClient { origin: origin.trim_end_matches('/').to_string(), client: build(30)?, upload_client: build(120)? })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn url(&self, path: &str) -> String {
        format!("{}{NATIVE_PREFIX}{path}", self.origin)
    }

    async fn send<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder, label: &str) -> TResult<T> {
        let response = request.send().await.map_err(network_error)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(network_error)?;
        if !status.is_success() {
            let error = map_status(status, &bytes);
            log::info!("memo-sync {label}: HTTP {}", status.as_u16());
            return Err(error);
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            log::warn!("memo-sync {label}: unexpected response shape");
            TransportError::Server("응답 형식이 Contract 와 다릅니다".into())
        })
    }

    async fn json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<&B>,
        label: &str,
    ) -> TResult<T> {
        let mut request = self.client.request(method, self.url(path)).header("Accept", "application/json");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        self.send(request, label).await
    }
}

fn network_error(error: reqwest::Error) -> TransportError {
    if error.is_timeout() || error.is_connect() || error.is_request() || error.is_body() {
        TransportError::Offline
    } else {
        TransportError::Server("네트워크".into())
    }
}

/// HTTP 상태 + FastAPI detail → TransportError.
pub fn map_status(status: StatusCode, body: &[u8]) -> TransportError {
    let parsed = parse_error_body(body);
    let message = parsed.message.clone().unwrap_or_default();
    match status.as_u16() {
        401 => TransportError::AuthRequired,
        403 => TransportError::Forbidden,
        404 if message == "Memo sync unavailable" => TransportError::Unavailable,
        404 => TransportError::NotFound,
        409 => TransportError::Conflict { code: parsed.code.or(parsed.message).unwrap_or_else(|| "conflict".into()) },
        413 | 422 => {
            TransportError::Rejected { status: status.as_u16(), message: if message.is_empty() { "형식 오류".into() } else { message } }
        }
        429 => TransportError::RateLimited,
        503 => TransportError::Unavailable,
        code => TransportError::Server(format!("HTTP {code}")),
    }
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// 실제 서버 Sync Adapter.
pub struct PlanAWorkSyncTransport {
    http: HttpClient,
}

impl PlanAWorkSyncTransport {
    pub fn new(http: HttpClient) -> Self {
        PlanAWorkSyncTransport { http }
    }
}

#[async_trait]
impl SyncTransport for PlanAWorkSyncTransport {
    fn name(&self) -> &'static str {
        "plan-a-work"
    }

    async fn create_list(&self, ctx: &SyncContext, body: &NativeListCreate) -> TResult<NativeList> {
        self.http.json(Method::POST, "/lists", Some(&ctx.access_token), Some(body), "lists").await
    }

    async fn link(&self, ctx: &SyncContext, body: &LinkRequest) -> TResult<LinkResponse> {
        self.http.json(Method::POST, "/links", Some(&ctx.access_token), Some(body), "link").await
    }

    async fn unlink(&self, ctx: &SyncContext, link_id: &str) -> TResult<()> {
        let _: serde_json::Value = self
            .http
            .json::<(), _>(Method::DELETE, &format!("/links/{}", segment(link_id)), Some(&ctx.access_token), None, "unlink")
            .await?;
        Ok(())
    }

    async fn changes(&self, ctx: &SyncContext, cursor: Option<&str>) -> TResult<ChangesResponse> {
        let path = match cursor {
            Some(cursor) => format!("/changes?cursor={}", segment(cursor)),
            None => "/changes".to_string(),
        };
        self.http.json::<(), _>(Method::GET, &path, Some(&ctx.access_token), None, "changes").await
    }

    async fn document(&self, ctx: &SyncContext, document_id: &str) -> TResult<PulledDocument> {
        self.http
            .json::<(), _>(Method::GET, &format!("/documents/{}", segment(document_id)), Some(&ctx.access_token), None, "document")
            .await
    }

    async fn push(&self, ctx: &SyncContext, document_id: &str, body: &PushRequest) -> TResult<PushResponse> {
        self.http
            .json(Method::POST, &format!("/documents/{}/push", segment(document_id)), Some(&ctx.access_token), Some(body), "push")
            .await
    }

    async fn ack(&self, ctx: &SyncContext, document_id: &str, body: &AckRequest) -> TResult<AckResponse> {
        self.http.json(Method::POST, &format!("/documents/{}/ack", segment(document_id)), Some(&ctx.access_token), Some(body), "ack").await
    }

    async fn conflicts(&self, ctx: &SyncContext, document_id: &str) -> TResult<ConflictsResponse> {
        self.http
            .json::<(), _>(
                Method::GET,
                &format!("/documents/{}/conflicts", segment(document_id)),
                Some(&ctx.access_token),
                None,
                "conflicts",
            )
            .await
    }

    async fn resolve(&self, ctx: &SyncContext, document_id: &str, conflict_id: &str, body: &ResolveRequest) -> TResult<WireDocument> {
        let path = format!("/documents/{}/conflicts/{}/resolve", segment(document_id), segment(conflict_id));
        self.http.json(Method::POST, &path, Some(&ctx.access_token), Some(body), "resolve").await
    }

    async fn upload(&self, ctx: &SyncContext, request_id: &str, file_name: &str, mime: &str, bytes: Vec<u8>) -> TResult<UploadResponse> {
        if !valid_request_id(request_id) {
            return Err(TransportError::Rejected { status: 422, message: "Invalid request ID".into() });
        }
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_string())
            .mime_str(mime)
            .map_err(|_| TransportError::Rejected { status: 422, message: "이미지 형식".into() })?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let request = self
            .http
            .upload_client
            .post(self.http.url(&format!("/attachments/{}", segment(request_id))))
            .bearer_auth(&ctx.access_token)
            .multipart(form);
        self.http.send(request, "upload").await
    }

    async fn download(&self, ctx: &SyncContext, name: &str) -> TResult<Vec<u8>> {
        let response = self
            .http
            .upload_client
            .get(self.http.url(&format!("/attachments/{}/download", segment(name))))
            .bearer_auth(&ctx.access_token)
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(network_error)?;
        if !status.is_success() {
            log::info!("memo-sync download: HTTP {}", status.as_u16());
            return Err(map_status(status, &bytes));
        }
        Ok(bytes.to_vec())
    }
}

/// 실제 서버 Auth API(native/auth/start · exchange · logout).
pub struct PlanAWorkAuthApi {
    http: HttpClient,
}

impl PlanAWorkAuthApi {
    pub fn new(http: HttpClient) -> Self {
        PlanAWorkAuthApi { http }
    }
}

#[async_trait]
impl AuthApi for PlanAWorkAuthApi {
    fn web_origin(&self) -> Option<String> {
        Some(self.http.origin().to_string())
    }

    async fn start(&self, body: &AuthStartRequest) -> TResult<AuthStartResponse> {
        self.http.json(Method::POST, "/auth/start", None, Some(body), "auth/start").await
    }

    async fn exchange(&self, body: &ExchangeRequest) -> TResult<ExchangeResponse> {
        self.http.json(Method::POST, "/auth/exchange", None, Some(body), "auth/exchange").await
    }

    async fn logout(&self, access_token: &str) -> TResult<()> {
        let _: serde_json::Value = self.http.json::<(), _>(Method::POST, "/logout", Some(access_token), None, "logout").await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping_follows_contract_errors() {
        let s = |code: u16| StatusCode::from_u16(code).unwrap();
        assert_eq!(map_status(s(401), br#"{"detail":"Desktop credential expired or revoked"}"#), TransportError::AuthRequired);
        assert_eq!(map_status(s(404), br#"{"detail":"Memo sync unavailable"}"#), TransportError::Unavailable);
        assert_eq!(map_status(s(404), br#"{"detail":"Document not found"}"#), TransportError::NotFound);
        assert!(map_status(s(409), br#"{"detail":{"code":"link_inactive"}}"#).is_conflict("link_inactive"));
        assert!(map_status(s(409), br#"{"detail":{"code":"item_moved_or_not_owned"}}"#).is_conflict("item_moved_or_not_owned"));
        assert!(map_status(s(409), br#"{"detail":"Request ID reused"}"#).is_conflict("Request ID reused"));
        assert_eq!(
            map_status(s(422), br#"{"detail":"Local paths are not allowed"}"#),
            TransportError::Rejected { status: 422, message: "Local paths are not allowed".into() }
        );
        assert_eq!(map_status(s(429), b"{}"), TransportError::RateLimited);
        assert_eq!(map_status(s(503), br#"{"detail":"Memo sync namespace is not configured"}"#), TransportError::Unavailable);
        assert!(map_status(s(502), b"<html>").is_transient());
    }

    #[test]
    fn urls_stay_on_the_configured_origin() {
        let http = HttpClient::new("https://staging.planawork.com/").unwrap();
        assert_eq!(http.url("/changes"), "https://staging.planawork.com/api/memo-sync/native/changes");
        // 경로 조각은 인코딩한다(서버 id 에 / 나 ? 가 섞여도 다른 경로가 되지 않게)
        assert_eq!(segment("a/b?c"), "a%2Fb%3Fc");
        assert!(!format!("{http:?}").contains("Bearer"));
    }
}
