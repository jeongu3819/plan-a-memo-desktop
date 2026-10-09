//! SyncTransport — PLAN-A Work memo-sync-v1 native API 경계.
//!
//! ```text
//! SyncTransport
//! ├─ PlanAWorkSyncTransport  실제 서버(HTTPS, sync/http.rs)
//! └─ MockSyncTransport       같은 Contract 를 흉내 내는 개발·테스트용 가짜 서버(sync/mock.rs)
//! ```
//!
//! 메서드는 Contract 의 경로와 1:1 이다. 입력·출력은 Contract DTO(`contract`)이고, 로컬 도메인 ↔ DTO 변환은
//! `mapper` 가 한다(UI·Local DB 는 서버 JSON 을 모른다).

use async_trait::async_trait;

use super::contract::*;

/// 연결 단계에서 무엇이 실패했는가 — 화면 안내와 진단 로그를 원인별로 나눈다(모두 '다시 시도' 대상).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetFailure {
    /// 서버 이름을 찾지 못함(DNS — 주소 없음·오타·DNS 서버 문제)
    Dns,
    /// HTTPS 인증서·보안 연결 실패(인증서 오류·보안 프로그램/프록시 가로채기·PC 시각)
    Tls,
    /// 응답 없음(연결·응답 시간 초과)
    Timeout,
}

impl NetFailure {
    pub fn label(&self) -> &'static str {
        match self {
            NetFailure::Dns => "dns",
            NetFailure::Tls => "tls",
            NetFailure::Timeout => "timeout",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
    /// 네트워크 단절·연결 거부 — 나중에 그대로 다시 시도한다.
    #[error("PLAN-A Work 에 연결할 수 없습니다(오프라인).")]
    Offline,
    /// DNS·TLS·시간 초과 — 오프라인처럼 다시 시도하되, 안내는 원인별로 한다.
    #[error("PLAN-A Work 에 연결할 수 없습니다({}).", .0.label())]
    Network(NetFailure),
    /// 401 — Desktop credential 만료·폐기. 브라우저로 다시 연결해야 한다.
    #[error("PLAN-A Work 연결이 만료되었습니다. 다시 로그인해주세요.")]
    AuthRequired,
    /// 서버 Desktop Sync 기능이 꺼져 있다(404 'Memo sync unavailable') 또는 설정 안 됨(503).
    #[error("PLAN-A Work 에서 Desktop 연결을 아직 사용할 수 없습니다.")]
    Unavailable,
    /// 404 + FastAPI 기본 detail('Not Found') — 서버에 memo-sync-v1 경로 자체가 없다(미배포 Backend).
    /// Contract 의 404 는 모두 구체적인 detail('Device not found' 등)을 준다.
    #[error("PLAN-A Work 서버에 Desktop 연결 기능이 없습니다(미배포).")]
    EndpointMissing,
    #[error("서버에서 찾을 수 없습니다.")]
    NotFound,
    #[error("권한이 없습니다.")]
    Forbidden,
    /// 409 — code 는 서버 detail.code(link_inactive, request_id_reused, resolution_stale, item_moved_or_not_owned, …).
    #[error("서버 상태와 맞지 않습니다({code}).")]
    Conflict { code: String },
    /// 413 · 422 — 내용 거절(용량·형식·참조 검사 등). `code`·`item` 은 서버 detail 이 객체일 때
    /// (예: `{code: local_path_not_allowed, item: 0}` — item 은 Push 항목 배열의 0부터 시작하는 위치, 서버 id 아님).
    #[error("서버가 요청을 거절했습니다: {message}")]
    Rejected { status: u16, message: String, code: Option<String>, item: Option<usize> },
    #[error("요청이 너무 많습니다. 잠시 뒤 다시 시도합니다.")]
    RateLimited,
    #[error("서버 오류({0})")]
    Server(String),
}

impl TransportError {
    /// 문장만 있는 거절(코드·항목 위치 없음).
    pub fn rejected(status: u16, message: impl Into<String>) -> Self {
        TransportError::Rejected { status, message: message.into(), code: None, item: None }
    }
    pub fn is_conflict(&self, code: &str) -> bool {
        matches!(self, TransportError::Conflict { code: c } if c == code)
    }
    /// 그대로 다시 보내도 되는 오류인가(요청 내용을 바꾸지 않는다).
    pub fn is_transient(&self) -> bool {
        matches!(self, TransportError::Offline | TransportError::Network(_) | TransportError::RateLimited | TransportError::Server(_))
    }
}

pub type TResult<T> = Result<T, TransportError>;

/// 요청마다 필요한 인증·계정 정보. Debug 로 토큰이 찍히지 않게 직접 구현한다.
#[derive(Clone)]
pub struct SyncContext {
    pub access_token: String,
    /// '<namespace>|<user_id>' — 로컬 Sync 상태를 계정·환경별로 나누는 키(권한 판단에 쓰지 않는다).
    pub account_key: String,
    /// 서버가 발급한 기기 id(로컬 기기 id 와 다르다).
    pub server_device_id: String,
}

impl std::fmt::Debug for SyncContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncContext")
            .field("access_token", &"<redacted>")
            .field("account_key", &self.account_key)
            .field("server_device_id", &self.server_device_id)
            .finish()
    }
}

#[async_trait]
pub trait SyncTransport: Send + Sync {
    /// "mock" | "plan-a-work"
    fn name(&self) -> &'static str;

    /// POST native/lists
    async fn create_list(&self, ctx: &SyncContext, body: &NativeListCreate) -> TResult<NativeList>;
    /// POST native/links
    async fn link(&self, ctx: &SyncContext, body: &LinkRequest) -> TResult<LinkResponse>;
    /// DELETE native/links/{link_id}
    async fn unlink(&self, ctx: &SyncContext, link_id: &str) -> TResult<()>;
    /// GET native/changes?cursor=
    async fn changes(&self, ctx: &SyncContext, cursor: Option<&str>) -> TResult<ChangesResponse>;
    /// GET native/documents/{id}
    async fn document(&self, ctx: &SyncContext, document_id: &str) -> TResult<PulledDocument>;
    /// POST native/documents/{id}/push
    async fn push(&self, ctx: &SyncContext, document_id: &str, body: &PushRequest) -> TResult<PushResponse>;
    /// POST native/documents/{id}/ack
    async fn ack(&self, ctx: &SyncContext, document_id: &str, body: &AckRequest) -> TResult<AckResponse>;
    /// GET native/documents/{id}/conflicts
    async fn conflicts(&self, ctx: &SyncContext, document_id: &str) -> TResult<ConflictsResponse>;
    /// POST native/documents/{id}/conflicts/{cid}/resolve
    async fn resolve(&self, ctx: &SyncContext, document_id: &str, conflict_id: &str, body: &ResolveRequest) -> TResult<WireDocument>;
    /// POST native/attachments/{request_id} — multipart `file`
    async fn upload(&self, ctx: &SyncContext, request_id: &str, file_name: &str, mime: &str, bytes: Vec<u8>) -> TResult<UploadResponse>;
    /// GET native/attachments/{name}/download
    async fn download(&self, ctx: &SyncContext, name: &str) -> TResult<Vec<u8>>;
}
