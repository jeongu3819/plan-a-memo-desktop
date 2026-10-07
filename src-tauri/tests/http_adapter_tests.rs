//! PlanAWorkSyncTransport · PlanAWorkAuthApi(실제 HTTP Adapter) 단위 테스트.
//!
//! 127.0.0.1 에 띄운 작은 HTTP stub 이 요청을 기록하고 정해 둔 응답을 돌려준다. **실제 PLAN-A Work 서버가 아니다** —
//! Adapter 가 Contract 의 Method·경로·헤더·본문을 정확히 보내고, 응답·오류를 Contract 대로 해석하는지만 확인한다.

use std::sync::{Arc, Mutex};

use plan_a_memo_lib::auth::AuthApi;
use plan_a_memo_lib::sync::contract::*;
use plan_a_memo_lib::sync::http::{HttpClient, PlanAWorkAuthApi, PlanAWorkSyncTransport};
use plan_a_memo_lib::sync::transport::{SyncContext, SyncTransport, TransportError};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }
    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

/// 요청 하나마다 (상태, 본문) 하나를 순서대로 돌려준다.
async fn stub(responses: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<Recorded>>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen = log.clone();
    tokio::spawn(async move {
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head_end, length) = loop {
                let n = stream.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                    let length = head
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    break (pos + 4, length);
                }
            };
            while buf.len() < head_end + length {
                let n = stream.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
            }
            let head = String::from_utf8_lossy(&buf[..head_end - 4]).to_string();
            let mut lines = head.lines();
            let mut first = lines.next().unwrap().split_whitespace();
            let method = first.next().unwrap().to_string();
            let target = first.next().unwrap().to_string();
            let headers = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
            seen.lock().unwrap().push(Recorded { method, target, headers, body: buf[head_end..head_end + length].to_vec() });
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).await.unwrap();
            let _ = stream.shutdown().await;
        }
    });
    (origin, log)
}

fn ctx() -> SyncContext {
    SyncContext { access_token: "pms_test-token".into(), account_key: "local:x|1".into(), server_device_id: "dev".into() }
}

fn doc_json(version: i64) -> serde_json::Value {
    json!({"id":"doc-1","type":"DAY","key":"2026-10-07","title":"2026-10-07","version":version,"deleted":false,
           "items":[{"id":7,"client_key":"ck-12345678","section":"am","item_version":2,"kind":"checklist","content":"x","completed":false,"sort_order":0}],
           "attachments":[]})
}

#[tokio::test]
async fn sync_routes_methods_headers_and_bodies_follow_the_contract() {
    let mut pulled = doc_json(3);
    pulled["link_id"] = json!("link-1");
    pulled["status"] = json!("connected");
    let (origin, log) = stub(vec![
        (200, json!({"id":"5b0a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b","title":"앱 개발"}).to_string()),
        (200, json!({"document_id":"doc-1","link_id":"link-1","version":1,"status":"pending"}).to_string()),
        (200, json!({"events":[{"cursor":"p:9","document_id":"doc-1","link_id":"link-1","version":3,"kind":"changed"}],"cursor":"p:9","has_more":false}).to_string()),
        (200, pulled.to_string()),
        (200, json!({"status":"accepted","document":doc_json(4)}).to_string()),
        (200, json!({"status":"synced"}).to_string()),
        (200, json!({"server":doc_json(4),"conflicts":[]}).to_string()),
        (200, doc_json(5).to_string()),
        (200, json!({"unlinked":true}).to_string()),
    ])
    .await;
    let t = PlanAWorkSyncTransport::new(HttpClient::new(&origin).unwrap());
    let c = ctx();
    t.create_list(&c, &NativeListCreate { id: "5b0a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b".into(), title: "앱 개발".into() }).await.unwrap();
    let link = t.link(&c, &LinkRequest { unit_type: UnitType::Day, key: "2026-10-07".into() }).await.unwrap();
    assert_eq!(link.link_id, "link-1");
    let changes = t.changes(&c, Some("p:8")).await.unwrap();
    assert_eq!(changes.events[0].kind, "changed");
    let doc = t.document(&c, "doc-1").await.unwrap();
    assert_eq!(doc.document.items[0].item_version, Some(2));
    let push = PushRequest {
        base_version: 3,
        local_version: 12,
        request_id: "0f8fad5bd9cb469fa16570867728950e".into(),
        link_id: "link-1".into(),
        deleted: false,
        items: vec![PushItem {
            id: Some(7),
            item_version: Some(2),
            client_key: None,
            section: "am".into(),
            kind: "checklist".into(),
            content: "x".into(),
            completed: true,
            sort_order: 0,
        }],
    };
    assert!(matches!(t.push(&c, "doc-1", &push).await.unwrap(), PushResponse::Accepted { .. }));
    t.ack(&c, "doc-1", &AckRequest { version: 4, link_id: "link-1".into(), attachments: vec![] }).await.unwrap();
    t.conflicts(&c, "doc-1").await.unwrap();
    let resolved = t.resolve(&c, "doc-1", "conf-1", &ResolveRequest { base_version: 4, side: Side::Desktop }).await.unwrap();
    assert_eq!(resolved.version, 5);
    t.unlink(&c, "link-1").await.unwrap();

    let log = log.lock().unwrap().clone();
    let routes: Vec<(String, String)> = log.iter().map(|r| (r.method.clone(), r.target.clone())).collect();
    assert_eq!(
        routes,
        vec![
            ("POST".into(), "/api/memo-sync/native/lists".into()),
            ("POST".into(), "/api/memo-sync/native/links".into()),
            ("GET".into(), "/api/memo-sync/native/changes?cursor=p%3A8".into()),
            ("GET".into(), "/api/memo-sync/native/documents/doc-1".into()),
            ("POST".into(), "/api/memo-sync/native/documents/doc-1/push".into()),
            ("POST".into(), "/api/memo-sync/native/documents/doc-1/ack".into()),
            ("GET".into(), "/api/memo-sync/native/documents/doc-1/conflicts".into()),
            ("POST".into(), "/api/memo-sync/native/documents/doc-1/conflicts/conf-1/resolve".into()),
            ("DELETE".into(), "/api/memo-sync/native/links/link-1".into()),
        ]
    );
    for r in &log {
        assert_eq!(r.header("authorization").as_deref(), Some("Bearer pms_test-token"), "Desktop Bearer 만");
        assert!(r.header("cookie").is_none(), "Web Cookie 를 보내지 않는다");
    }
    assert_eq!(log[1].json(), json!({"type":"DAY","key":"2026-10-07"}), "body 에 device_id·user_id 없음");
    assert_eq!(
        log[4].json(),
        json!({"base_version":3,"local_version":12,"request_id":"0f8fad5bd9cb469fa16570867728950e","link_id":"link-1","deleted":false,
               "items":[{"id":7,"item_version":2,"section":"am","kind":"checklist","content":"x","completed":true,"sort_order":0}]})
    );
    assert_eq!(log[5].json(), json!({"version":4,"link_id":"link-1","attachments":[]}));
    assert_eq!(log[7].json(), json!({"base_version":4,"side":"desktop"}));
    assert!(log[4].header("content-type").unwrap().starts_with("application/json"));
}

#[tokio::test]
async fn upload_is_multipart_file_and_download_returns_bytes() {
    let (origin, log) = stub(vec![
        (200, json!({"name":"abc.png","url":"/api/personal-memos/images/abc.png/download","size":4}).to_string()),
        (200, "\u{89}PNG".to_string()),
    ])
    .await;
    let t = PlanAWorkSyncTransport::new(HttpClient::new(&origin).unwrap());
    let up = t.upload(&ctx(), "0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5b.png", "image/png", b"\x89PNG".to_vec()).await.unwrap();
    assert_eq!(up.url, image_url("abc.png"));
    let bytes = t.download(&ctx(), "abc.png").await.unwrap();
    assert!(!bytes.is_empty());
    let log = log.lock().unwrap().clone();
    assert_eq!(log[0].target, "/api/memo-sync/native/attachments/0f8fad5b-d9cb-469f-a165-70867728950e");
    assert!(log[0].header("content-type").unwrap().starts_with("multipart/form-data"));
    let body = String::from_utf8_lossy(&log[0].body);
    assert!(body.contains("name=\"file\"") && body.contains("filename=\"0f8fad5b.png\"") && body.contains("image/png"));
    assert_eq!(log[1].target, "/api/memo-sync/native/attachments/abc.png/download");
    // request id 형식이 틀리면 보내지도 않는다
    let err = t.upload(&ctx(), "bad id", "a.png", "image/png", vec![1]).await.unwrap_err();
    assert!(matches!(err, TransportError::Rejected { .. }));
}

#[tokio::test]
async fn errors_map_to_contract_meanings() {
    let (origin, _) = stub(vec![
        (409, json!({"detail":{"code":"link_inactive"}}).to_string()),
        (401, json!({"detail":"Desktop credential expired or revoked"}).to_string()),
        (404, json!({"detail":"Memo sync unavailable"}).to_string()),
        (409, json!({"detail":{"code":"resolution_stale"}}).to_string()),
        (422, json!({"detail":"Local paths are not allowed"}).to_string()),
        (500, "oops".to_string()),
    ])
    .await;
    let t = PlanAWorkSyncTransport::new(HttpClient::new(&origin).unwrap());
    let c = ctx();
    assert!(t.document(&c, "d").await.unwrap_err().is_conflict("link_inactive"));
    assert_eq!(t.changes(&c, None).await.unwrap_err(), TransportError::AuthRequired);
    assert_eq!(t.changes(&c, None).await.unwrap_err(), TransportError::Unavailable);
    assert!(t
        .resolve(&c, "d", "c", &ResolveRequest { base_version: 1, side: Side::Web })
        .await
        .unwrap_err()
        .is_conflict("resolution_stale"));
    let push = PushRequest {
        base_version: 1,
        local_version: 1,
        request_id: "abcdefgh".into(),
        link_id: "l".into(),
        deleted: false,
        items: vec![],
    };
    assert!(matches!(t.push(&c, "d", &push).await.unwrap_err(), TransportError::Rejected { status: 422, .. }));
    assert!(t.changes(&c, None).await.unwrap_err().is_transient());
    // 아무도 듣지 않는 포트 → 오프라인
    let dead = PlanAWorkSyncTransport::new(HttpClient::new("http://127.0.0.1:9").unwrap());
    assert_eq!(dead.changes(&c, None).await.unwrap_err(), TransportError::Offline);
}

#[tokio::test]
async fn auth_api_start_exchange_logout() {
    let (origin, log) = stub(vec![
        (200, json!({"authorization_id":"a".repeat(43),"browser_path":"/memo-desktop/authorize?request=aaa","namespace":"production:srv-0001","expires_in":300}).to_string()),
        (200, json!({"access_token":"pms_new","token_type":"Bearer","expires_in":2592000,"device_id":"dev-1","user_id":42,"namespace":"production:srv-0001"}).to_string()),
        (200, json!({"revoked":true}).to_string()),
    ])
    .await;
    let api = PlanAWorkAuthApi::new(HttpClient::new(&origin).unwrap());
    assert_eq!(api.web_origin().as_deref(), Some(origin.as_str()));
    let start = AuthStartRequest {
        name: "PLAN-A Memo · PC".into(),
        challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".into(),
        state: "s".repeat(43),
        redirect_uri: "http://127.0.0.1:50123/memo-sync/callback".into(),
        device_id: None,
    };
    api.start(&start).await.unwrap();
    let exchanged = api
        .exchange(&ExchangeRequest {
            code: "c".repeat(43),
            verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
            redirect_uri: start.redirect_uri.clone(),
        })
        .await
        .unwrap();
    assert_eq!(exchanged.user_id, 42);
    api.logout("pms_new").await.unwrap();
    let log = log.lock().unwrap().clone();
    assert_eq!(log[0].target, "/api/memo-sync/native/auth/start");
    assert!(log[0].header("authorization").is_none(), "start·exchange 는 공개 PKCE 경로");
    assert_eq!(log[0].json()["challenge"], "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert_eq!(log[1].target, "/api/memo-sync/native/auth/exchange");
    assert_eq!(
        log[1].json(),
        json!({"code":"c".repeat(43),"verifier":"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk","redirect_uri":"http://127.0.0.1:50123/memo-sync/callback"})
    );
    assert_eq!(log[2].target, "/api/memo-sync/native/logout");
    assert_eq!(log[2].header("authorization").as_deref(), Some("Bearer pms_new"));
}

/// plan-a-work 저장소가 이 PC 에 있으면 문서의 push 예시 JSON 을 그대로 읽어 Desktop DTO 와 맞는지 본다(Contract drift 감지).
/// 경로: 환경 변수 PLAN_A_WORK_DIR, 없으면 ~/Documents/GitHub/plan-a-work. 없으면 건너뛴다.
#[test]
fn contract_example_in_plan_a_work_docs_matches_desktop_dto() {
    let dir = std::env::var("PLAN_A_WORK_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join("Documents").join("GitHub").join("plan-a-work"));
    let Ok(doc) = std::fs::read_to_string(dir.join("docs").join("MEMO_SYNC_IMPLEMENTATION.md")) else {
        eprintln!("plan-a-work 문서가 없어 건너뜀");
        return;
    };
    let start = doc.find("```json").expect("json example") + "```json".len();
    let end = start + doc[start..].find("```").unwrap();
    let push: PushRequest = serde_json::from_str(doc[start..end].trim()).expect("문서의 push 예시가 Desktop PushRequest 로 읽혀야 한다");
    assert_eq!(push.items[0].id, Some(101));
    assert_eq!(push.items[0].section, "am");
    let contract = std::fs::read_to_string(dir.join("docs").join("contracts").join("memo-sync-v1.md")).unwrap();
    for needle in ["127.0.0.1:<ephemeral-port>/memo-sync/callback", "/api/personal-memos/images/{name}/download", "base_version=0"] {
        assert!(contract.contains(needle), "Contract 문구가 바뀌었다: {needle}");
    }
}
