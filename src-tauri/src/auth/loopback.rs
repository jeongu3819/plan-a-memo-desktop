//! Loopback callback listener — RFC 8252 §7.3, memo-sync-v1 "Native authentication".
//!
//! * `127.0.0.1` 에만, 운영체제가 고른 임시 포트(1024–65535)로 연다. 브라우저를 열기 **전에** 연다.
//! * 받는 경로는 `GET /memo-sync/callback?code=…&state=…` 하나. 다른 요청(favicon 등)은 404 후 계속 기다린다.
//! * code·state 는 로그에 남기지 않는다. 응답 페이지에도 넣지 않는다.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::CallbackParams;
use crate::error::{AppError, AppResult};
use crate::sync::contract::CALLBACK_PATH;

pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_HEAD: usize = 8 * 1024;

pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
}

impl LoopbackListener {
    pub async fn bind() -> AppResult<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| AppError::new("auth_listener", "로그인 응답을 받을 준비를 하지 못했습니다(로컬 포트)."))?;
        let port = listener.local_addr().map_err(|_| AppError::new("auth_listener", "로컬 포트를 확인하지 못했습니다."))?.port();
        Ok(LoopbackListener { listener, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// 서버 `validate_redirect` 가 요구하는 정확한 모양.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// callback 한 번을 기다린다. 결과 페이지는 교환이 끝난 뒤 `CallbackResponder::finish` 로 보낸다.
    pub async fn wait(self, timeout: Duration) -> AppResult<(AppResult<CallbackParams>, CallbackResponder)> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let accepted = tokio::time::timeout_at(deadline, self.listener.accept()).await;
            let (mut stream, peer) = match accepted {
                Err(_) => return Err(AppError::new("auth_timeout", "로그인 시간이 지났습니다. 다시 시도해주세요.")),
                Ok(Err(_)) => continue,
                Ok(Ok(pair)) => pair,
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(Ok(head)) = tokio::time::timeout(Duration::from_secs(10), read_head(&mut stream)).await else { continue };
            let Some(target) = request_target(&head) else {
                let _ = respond(&mut stream, 400, "잘못된 요청").await;
                continue;
            };
            let path = target.split('?').next().unwrap_or_default();
            if path != CALLBACK_PATH {
                let _ = respond(&mut stream, 404, "").await;
                continue;
            }
            return Ok((parse_target(&target), CallbackResponder { stream: Some(stream) }));
        }
    }
}

pub struct CallbackResponder {
    stream: Option<TcpStream>,
}

impl CallbackResponder {
    pub async fn finish(mut self, ok: bool, message: &str) {
        if let Some(mut stream) = self.stream.take() {
            let body = page(ok, message);
            let _ = respond(&mut stream, if ok { 200 } else { 400 }, &body).await;
        }
    }

    /// 테스트·Mock 용 — 응답 없이 닫는다.
    pub fn none() -> Self {
        CallbackResponder { stream: None }
    }
}

async fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") || buffer.len() >= MAX_HEAD {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buffer).to_string())
}

/// `GET <target> HTTP/1.1` 의 target. GET 이외는 받지 않는다.
fn request_target(head: &str) -> Option<String> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    (method == "GET" && version.starts_with("HTTP/1.") && target.starts_with('/')).then(|| target.to_string())
}

/// callback 의 query 를 해석한다(code·state 또는 error).
pub fn parse_target(target: &str) -> AppResult<CallbackParams> {
    let parsed = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| AppError::new("auth_callback_invalid", "로그인 응답 주소가 올바르지 않습니다."))?;
    if parsed.path() != CALLBACK_PATH {
        return Err(AppError::new("auth_callback_invalid", "로그인 응답 주소가 올바르지 않습니다."));
    }
    let get = |name: &str| parsed.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.to_string());
    if get("error").is_some() {
        return Err(AppError::new("auth_denied", "로그인이 취소되었거나 거절되었습니다."));
    }
    match (get("code"), get("state")) {
        (Some(code), Some(state)) if !code.is_empty() && !state.is_empty() && code.len() <= 256 && state.len() <= 256 => {
            Ok(CallbackParams { code, state })
        }
        _ => Err(AppError::new("auth_callback_invalid", "로그인 응답에 필요한 값이 없습니다.")),
    }
}

fn page(ok: bool, message: &str) -> String {
    let title = if ok { "PLAN-A Memo 연결 완료" } else { "PLAN-A Memo 연결 실패" };
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>{title}</title>\
         <meta name=\"viewport\" content=\"width=device-width\"></head>\
         <body style=\"font-family:system-ui,sans-serif;padding:48px;color:#1f2937\">\
         <h1 style=\"font-size:20px\">{title}</h1><p>{}</p><p>이 창은 닫아도 됩니다.</p></body></html>",
        escape(message)
    )
}

async fn respond(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_callback_path() {
        let ok = parse_target("/memo-sync/callback?code=abc&state=xyz").unwrap();
        assert_eq!(ok, CallbackParams { code: "abc".into(), state: "xyz".into() });
        assert!(parse_target("/other?code=abc&state=xyz").is_err());
        assert!(parse_target("/memo-sync/callback?state=xyz").is_err());
        assert_eq!(parse_target("/memo-sync/callback?error=access_denied&state=x").unwrap_err().code(), "auth_denied");
        assert_eq!(
            request_target("GET /memo-sync/callback?code=a HTTP/1.1\r\nHost: x\r\n\r\n").as_deref(),
            Some("/memo-sync/callback?code=a")
        );
        assert!(request_target("POST /memo-sync/callback HTTP/1.1\r\n\r\n").is_none());
    }

    #[tokio::test]
    async fn listener_receives_browser_redirect_and_ignores_other_paths() {
        let listener = LoopbackListener::bind().await.unwrap();
        let redirect = listener.redirect_uri();
        assert!(redirect.starts_with("http://127.0.0.1:") && redirect.ends_with("/memo-sync/callback"));
        assert!(listener.port() >= 1024);
        let port = listener.port();
        let waiter = tokio::spawn(async move { listener.wait(Duration::from_secs(10)).await });
        // 브라우저가 favicon 먼저 요청해도 계속 기다린다
        let client = reqwest::Client::new();
        let fav = client.get(format!("http://127.0.0.1:{port}/favicon.ico")).send().await.unwrap();
        assert_eq!(fav.status().as_u16(), 404);
        let callback = tokio::spawn(async move {
            reqwest::get(format!("http://127.0.0.1:{port}/memo-sync/callback?code=the-code&state=the-state"))
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        let (params, responder) = waiter.await.unwrap().unwrap();
        assert_eq!(params.unwrap(), CallbackParams { code: "the-code".into(), state: "the-state".into() });
        responder.finish(true, "완료").await;
        let page = callback.await.unwrap();
        assert!(page.contains("연결 완료"));
        assert!(!page.contains("the-code"), "code 를 페이지에 되돌려 쓰지 않는다");
    }

    #[tokio::test]
    async fn listener_times_out() {
        let listener = LoopbackListener::bind().await.unwrap();
        let err = listener.wait(Duration::from_millis(50)).await.err().unwrap();
        assert_eq!(err.code(), "auth_timeout");
    }
}
