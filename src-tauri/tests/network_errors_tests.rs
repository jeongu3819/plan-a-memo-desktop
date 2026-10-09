//! 계정 연결 실패를 원인별로 나누는가 — 실제 소켓으로 DNS·TLS·시간 초과·연결 거부·라우트 없음(404)을 재현한다.
//!
//! 'PLAN-A Work 에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.' 한 문장으로 뭉치던 것을
//! 서버 주소 없음(DNS) / 인증서(TLS) / 응답 없음 / 오프라인 / 서버에 기능 없음 / 서버 오류로 나눈다.
//! 외부 서버에는 요청하지 않는다(127.0.0.1 과 예약 도메인 `.invalid` 만).

use std::time::Duration;

use plan_a_memo_lib::auth::{auth_error, AuthApi};
use plan_a_memo_lib::sync::contract::AuthStartRequest;
use plan_a_memo_lib::sync::http::{classify_network_chain, map_status, HttpClient, PlanAWorkAuthApi};
use plan_a_memo_lib::sync::transport::{NetFailure, TransportError};
use reqwest::StatusCode;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn start_body() -> AuthStartRequest {
    AuthStartRequest {
        name: "PLAN-A Memo · TEST".into(),
        challenge: "c".repeat(43),
        state: "s".repeat(43),
        redirect_uri: "http://127.0.0.1:50000/memo-sync/callback".into(),
        device_id: None,
    }
}

async fn start_error(client: HttpClient) -> TransportError {
    PlanAWorkAuthApi::new(client).start(&start_body()).await.unwrap_err()
}

/// 한 번 응답하는 평문 HTTP 서버.
async fn http_once(status: u16, body: &'static str) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 8192];
        let _ = stream.read(&mut buf).await;
        let reply = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(reply.as_bytes()).await;
    });
    origin
}

#[tokio::test]
async fn unknown_host_is_dns_failure_and_names_the_server() {
    // RFC 6761 — .invalid 는 어디에서도 풀리지 않는다(실제 'planawork.com 에 A 레코드 없음' 과 같은 상황).
    let error = start_error(HttpClient::new("https://plan-a-memo-test.invalid").unwrap()).await;
    assert_eq!(error, TransportError::Network(NetFailure::Dns));
    let shown = auth_error(&error, "로그인을 시작하지 못했습니다.", Some("plan-a-memo-test.invalid"));
    assert_eq!(shown.code(), "server_not_found");
    assert!(shown.to_string().contains("plan-a-memo-test.invalid"), "어느 서버를 못 찾았는지 보여 준다: {shown}");
    assert!(!shown.to_string().contains("인터넷 연결을 확인해주세요."), "DNS 실패를 '인터넷 확인' 으로 뭉치지 않는다");
}

#[tokio::test]
async fn https_to_a_non_tls_server_is_tls_failure() {
    // 평문 HTTP 서버에 https 로 붙으면 TLS handshake 가 실패한다(인증서·프록시 가로채기와 같은 분류).
    let origin = http_once(200, "{}").await.replace("http://", "https://");
    let error = start_error(HttpClient::new(&origin).unwrap()).await;
    assert_eq!(error, TransportError::Network(NetFailure::Tls));
    assert_eq!(auth_error(&error, "x", None).code(), "server_tls");
}

#[tokio::test]
async fn silent_server_is_timeout() {
    // 연결은 받지만 아무 응답도 하지 않는 서버
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move {
        let mut held = Vec::new();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            held.push(stream);
        }
    });
    let client = HttpClient::with_timeouts(&origin, Duration::from_secs(2), Duration::from_millis(600)).unwrap();
    let error = start_error(client).await;
    assert_eq!(error, TransportError::Network(NetFailure::Timeout));
    assert_eq!(auth_error(&error, "x", None).code(), "server_timeout");
}

#[tokio::test]
async fn refused_connection_stays_offline() {
    let error = start_error(HttpClient::new("http://127.0.0.1:9").unwrap()).await;
    assert_eq!(error, TransportError::Offline);
    assert_eq!(auth_error(&error, "x", None).code(), "server_unreachable");
}

#[tokio::test]
async fn backend_without_memo_sync_routes_is_reported_as_missing_feature() {
    // 지금 staging.planawork.com 이 주는 응답과 같은 모양(FastAPI 기본 404)
    let origin = http_once(404, r#"{"detail":"Not Found"}"#).await;
    let error = start_error(HttpClient::new(&origin).unwrap()).await;
    assert_eq!(error, TransportError::EndpointMissing);
    let shown = auth_error(&error, "x", None);
    assert_eq!(shown.code(), "server_feature_missing");
}

#[tokio::test]
async fn server_errors_are_temporary_server_errors() {
    let origin = http_once(502, "<html>bad gateway</html>").await;
    let error = start_error(HttpClient::new(&origin).unwrap()).await;
    assert_eq!(error, TransportError::Server("HTTP 502".into()));
    assert!(error.is_transient());
    assert_eq!(auth_error(&error, "x", None).code(), "server_error");
}

#[test]
fn status_mapping_keeps_contract_404s_specific() {
    // Contract 의 404 는 구체적인 detail — 기존 의미 그대로
    assert_eq!(map_status(StatusCode::NOT_FOUND, br#"{"detail":"Device not found"}"#), TransportError::NotFound);
    assert_eq!(map_status(StatusCode::NOT_FOUND, br#"{"detail":"Memo sync unavailable"}"#), TransportError::Unavailable);
    // 라우트 없음(FastAPI 기본) · 프록시 HTML 404
    assert_eq!(map_status(StatusCode::NOT_FOUND, br#"{"detail":"Not Found"}"#), TransportError::EndpointMissing);
    assert_eq!(map_status(StatusCode::NOT_FOUND, b"<html>404</html>"), TransportError::EndpointMissing);
    // 권한·인증
    assert_eq!(
        map_status(StatusCode::UNAUTHORIZED, br#"{"detail":"Invalid authorization code or verifier"}"#),
        TransportError::AuthRequired
    );
    assert_eq!(map_status(StatusCode::FORBIDDEN, br#"{"detail":"Device belongs to another account"}"#), TransportError::Forbidden);
    assert_eq!(auth_error(&TransportError::AuthRequired, "x", None).code(), "auth_code_invalid");
    assert_eq!(auth_error(&TransportError::Forbidden, "x", None).code(), "auth_forbidden");
}

#[test]
fn network_chain_classification() {
    assert_eq!(
        classify_network_chain("error sending request\ndns error: no such host is known.\n"),
        Some(TransportError::Network(NetFailure::Dns))
    );
    assert_eq!(
        classify_network_chain("error sending request\ninvalid peer certificate: unknownissuer\n"),
        Some(TransportError::Network(NetFailure::Tls))
    );
    assert_eq!(classify_network_chain("operation timed out\n"), Some(TransportError::Network(NetFailure::Timeout)));
    assert_eq!(classify_network_chain("tcp connect error\nconnection refused (os error 10061)\n"), None);
}

#[test]
fn unreachable_errors_are_retried_like_offline() {
    for kind in [NetFailure::Dns, NetFailure::Tls, NetFailure::Timeout] {
        assert!(TransportError::Network(kind).is_transient(), "{kind:?} 도 변경을 보관하고 나중에 다시 보낸다");
    }
}

#[tokio::test]
async fn start_rejected_by_a_global_auth_middleware_is_a_server_setting_problem() {
    // 지금 staging.planawork.com 이 POST /api/* 에 주는 응답 — 로그인 전 요청이므로 '세션 만료' 로 안내하지 않는다.
    use plan_a_memo_lib::auth::{DesktopAuth, MemoryCredentialStore};
    use plan_a_memo_lib::config::AppEnv;
    use std::sync::Arc;
    let origin = http_once(401, r#"{"detail":"Authentication required"}"#).await;
    let api = Arc::new(PlanAWorkAuthApi::new(HttpClient::new(&origin).unwrap()));
    let auth = DesktopAuth::new(AppEnv::Development, api, Arc::new(MemoryCredentialStore::default()), false);
    let error = auth.begin_login("http://127.0.0.1:50000/memo-sync/callback", false).await.unwrap_err();
    assert_eq!(error.code(), "server_auth_config");
    assert!(!auth.login_pending(), "실패한 시작은 대기 상태를 남기지 않는다");
}
