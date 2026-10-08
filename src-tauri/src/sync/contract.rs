//! PLAN-A Work memo-sync-v1 Contract 의 전송 형식(DTO).
//!
//! 기준: `plan-a-work/docs/contracts/memo-sync-v1.md` + `backend/app/services/memo_sync_api.py`(Pydantic
//! `Strict` 모델 — 모르는 필드를 보내면 서버가 422 로 거절한다). 이 파일의 이름·형식은 서버 코드를 그대로 따른다.
//! 로컬 도메인(DocumentSnapshot 등)은 여기 타입을 직접 쓰지 않는다 — `mapper` 가 변환한다.

use serde::{Deserialize, Serialize};

/// 모든 경로의 공통 앞부분(Desktop 전용 native 경로만 쓴다).
pub const NATIVE_PREFIX: &str = "/api/memo-sync/native";
/// 개인 메모 이미지 주소 — 서버 본문은 이 상대 주소만 허용한다(`prepare_content`).
pub const IMAGE_URL_PREFIX: &str = "/api/personal-memos/images/";
pub const IMAGE_URL_SUFFIX: &str = "/download";
/// loopback callback 경로(`validate_redirect`).
pub const CALLBACK_PATH: &str = "/memo-sync/callback";

pub const MAX_ITEMS: usize = 1000;
pub const MAX_ITEM_CHARS: usize = 500_000;
pub const MAX_DOCUMENT_BYTES: usize = 2_000_000;
/// 서버 INLINE_IMAGE_POLICY(기본 10MB, png/jpg/jpeg/webp).
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const IMAGE_TYPES: &[(&str, &str)] = &[("image/png", "png"), ("image/jpeg", "jpg"), ("image/webp", "webp")];

pub fn image_url(name: &str) -> String {
    format!("{IMAGE_URL_PREFIX}{name}{IMAGE_URL_SUFFIX}")
}

/// 본문의 서버 이미지 이름들 — 서버 `_IMAGE_REF_RE`
/// (`/api/personal-memos/images/(?P<name>[^/?#"'\s<>]+)/download`)와 같은 규칙.
pub fn image_names(content: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = content;
    while let Some(pos) = rest.find(IMAGE_URL_PREFIX) {
        let tail = &rest[pos + IMAGE_URL_PREFIX.len()..];
        let name: String =
            tail.chars().take_while(|c| !matches!(c, '/' | '?' | '#' | '"' | '\'' | '<' | '>') && !c.is_whitespace()).collect();
        if !name.is_empty() && tail[name.len()..].starts_with(IMAGE_URL_SUFFIX) && !names.contains(&name) {
            names.push(name.clone());
        }
        rest = &tail[name.len().max(1).min(tail.len())..];
    }
    names
}

/// request_id · upload request id 형식 `^[A-Za-z0-9_-]{8,64}$`.
pub fn valid_request_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ── Auth ────────────────────────────────────────────────────────────────

/// POST native/auth/start
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthStartRequest {
    pub name: String,
    pub challenge: String,
    pub state: String,
    pub redirect_uri: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthStartResponse {
    pub authorization_id: String,
    /// Web origin 기준 상대 경로(`/memo-desktop/authorize?request=…`).
    pub browser_path: String,
    pub namespace: String,
    pub expires_in: i64,
}

/// POST native/auth/exchange — Debug 에 code·verifier 가 나오지 않게 직접 구현.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExchangeRequest {
    pub code: String,
    pub verifier: String,
    pub redirect_uri: String,
}

impl std::fmt::Debug for ExchangeRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExchangeRequest")
            .field("code", &"<redacted>")
            .field("verifier", &"<redacted>")
            .field("redirect_uri", &self.redirect_uri)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct ExchangeResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub device_id: String,
    pub user_id: i64,
    pub namespace: String,
}

impl std::fmt::Debug for ExchangeResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExchangeResponse")
            .field("access_token", &"<redacted>")
            .field("expires_in", &self.expires_in)
            .field("device_id", &self.device_id)
            .field("user_id", &self.user_id)
            .field("namespace", &self.namespace)
            .finish()
    }
}

// ── Link · Unlink · Lists ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnitType {
    #[serde(rename = "DAY")]
    Day,
    #[serde(rename = "NEXT_LIST")]
    NextList,
}

/// POST native/links (device_id 는 보내지 않는다 — 토큰의 기기로 연결된다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LinkRequest {
    #[serde(rename = "type")]
    pub unit_type: UnitType,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinkResponse {
    pub document_id: String,
    pub link_id: String,
    pub version: i64,
    pub status: String,
}

/// POST native/lists — 이름 있는 Next List 를 서버에 만든다(같은 id 재시도 안전).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NativeListCreate {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeList {
    pub id: String,
    pub title: String,
}

// ── Document ────────────────────────────────────────────────────────────

/// 문서 안 항목. Push 할 때도 같은 모양(서버 `Item`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireItem {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub item_version: Option<i64>,
    #[serde(default)]
    pub client_key: Option<String>,
    pub section: String,
    pub kind: String,
    pub content: String,
    pub completed: bool,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireAttachment {
    pub name: String,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub url: Option<String>,
    /// GET documents/{id} 에만 있다(다운로드할 바이트의 SHA-256).
    #[serde(default)]
    pub sha256: Option<String>,
}

/// 서버 문서 전체 Snapshot(`memo_sync.snapshot`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireDocument {
    pub id: String,
    #[serde(rename = "type")]
    pub unit_type: UnitType,
    pub key: String,
    #[serde(default)]
    pub title: Option<String>,
    pub version: i64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub items: Vec<WireItem>,
    #[serde(default)]
    pub attachments: Vec<WireAttachment>,
}

/// GET native/documents/{id}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PulledDocument {
    #[serde(flatten)]
    pub document: WireDocument,
    pub link_id: String,
    pub status: String,
}

/// POST native/documents/{id}/push — 문서 **전체**. 빠진 기존 항목은 서버에서 soft delete 된다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PushRequest {
    pub base_version: i64,
    pub local_version: i64,
    pub request_id: String,
    pub link_id: String,
    pub deleted: bool,
    pub items: Vec<PushItem>,
}

/// Push 항목 — 서버 `Item`(extra=forbid). 새 항목은 id 없이 client_key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PushItem {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub item_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_key: Option<String>,
    pub section: String,
    pub kind: String,
    pub content: String,
    pub completed: bool,
    pub sort_order: i64,
}

/// Push 응답 — conflict 도 HTTP 200(서버가 제안을 저장했다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum PushResponse {
    Accepted { document: WireDocument },
    Conflict { conflict_id: String, version: i64 },
}

/// POST native/documents/{id}/ack — 정확한 최신 version + 이미지 이름 전체.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AckRequest {
    pub version: i64,
    pub link_id: String,
    pub attachments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AckResponse {
    pub status: String,
}

// ── Changes ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangeEvent {
    pub cursor: String,
    pub document_id: String,
    pub link_id: String,
    pub version: i64,
    /// linked | changed | conflict | unlinked
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangesResponse {
    pub events: Vec<ChangeEvent>,
    pub cursor: String,
    pub has_more: bool,
}

// ── Conflict ────────────────────────────────────────────────────────────

/// 제안 내용 — Desktop 제안은 `{deleted, items}`, Web 제안은 과거 Snapshot 전체.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireProposal {
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub items: Vec<WireItem>,
    #[serde(default)]
    pub attachments: Vec<WireAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireConflict {
    pub id: String,
    pub proposal: WireProposal,
    /// 제안을 낸 쪽 — desktop | web
    pub source: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// GET native/documents/{id}/conflicts
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConflictsResponse {
    pub server: WireDocument,
    pub conflicts: Vec<WireConflict>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Web,
    Desktop,
}

/// POST native/documents/{id}/conflicts/{cid}/resolve — 응답은 새 버전의 문서 Snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResolveRequest {
    pub base_version: i64,
    pub side: Side,
}

// ── Attachment ──────────────────────────────────────────────────────────

/// POST native/attachments/{request_id} (multipart `file`)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UploadResponse {
    pub name: String,
    pub url: String,
    pub size: i64,
}

// ── 오류 응답 ───────────────────────────────────────────────────────────

/// FastAPI `HTTPException` 본문: `{"detail": "문장"}` 또는 `{"detail": {"code": "…"}}`,
/// 검증 오류는 `{"detail": [ … ]}`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ErrorBody {
    pub code: Option<String>,
    pub message: Option<String>,
    /// 참조 검사 오류의 항목 위치(Push items 배열 index)
    pub item: Option<usize>,
}

pub fn parse_error_body(bytes: &[u8]) -> ErrorBody {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else { return ErrorBody::default() };
    let detail = value.get("detail").cloned().unwrap_or(serde_json::Value::Null);
    match detail {
        serde_json::Value::String(message) => ErrorBody { code: None, message: Some(message), item: None },
        serde_json::Value::Object(map) => ErrorBody {
            code: map.get("code").and_then(|v| v.as_str()).map(str::to_string),
            message: map.get("message").and_then(|v| v.as_str()).map(str::to_string),
            item: map.get("item").and_then(|v| v.as_u64()).map(|n| n as usize),
        },
        serde_json::Value::Array(list) => ErrorBody {
            code: Some("validation".into()),
            message: list.first().and_then(|e| e.get("msg")).and_then(|v| v.as_str()).map(str::to_string),
            item: None,
        },
        _ => ErrorBody::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 서버 `memo_sync.snapshot` + GET documents 응답 모양 그대로(backend/tests/test_memo_sync.py 기준).
    #[test]
    fn pulled_document_matches_server_shape() {
        let body = json!({
            "id": "6d0f8c35-4f5b-4f0b-9df4-3f1c6e9a1a01", "type": "DAY", "key": "2026-10-07", "title": "2026-10-07",
            "version": 3, "deleted": false,
            "items": [
                {"id": 101, "client_key": null, "section": "am", "item_version": 2, "kind": "checklist",
                 "content": "<p>회의 준비</p>", "completed": true, "sort_order": 1},
                {"id": 102, "client_key": "k-123456789", "section": "pm", "item_version": 1, "kind": "text",
                 "content": "<img src=\"/api/personal-memos/images/abc.png/download\">", "completed": false, "sort_order": 0}
            ],
            "attachments": [{"name": "abc.png", "size": 10, "url": "/api/personal-memos/images/abc.png/download", "sha256": "00"}],
            "link_id": "c1", "status": "connected"
        });
        let pulled: PulledDocument = serde_json::from_value(body).unwrap();
        assert_eq!(pulled.document.unit_type, UnitType::Day);
        assert_eq!(pulled.document.items[0].id, Some(101));
        assert_eq!(pulled.document.items[0].item_version, Some(2));
        assert_eq!(pulled.document.items[1].client_key.as_deref(), Some("k-123456789"));
        assert_eq!(pulled.document.attachments[0].sha256.as_deref(), Some("00"));
        assert_eq!(pulled.link_id, "c1");
    }

    /// MEMO_SYNC_IMPLEMENTATION.md §5 의 push 예시와 같은 JSON 이 나와야 한다.
    #[test]
    fn push_request_serializes_like_contract_example() {
        let push = PushRequest {
            base_version: 1,
            local_version: 4,
            request_id: "stable-request-0001".into(),
            link_id: "server-link-generation".into(),
            deleted: false,
            items: vec![PushItem {
                id: Some(101),
                item_version: Some(1),
                client_key: None,
                section: "am".into(),
                kind: "checklist".into(),
                content: "<p>회의 준비</p>".into(),
                completed: true,
                sort_order: 1,
            }],
        };
        let value = serde_json::to_value(&push).unwrap();
        assert_eq!(
            value,
            json!({"base_version":1,"local_version":4,"request_id":"stable-request-0001",
                   "link_id":"server-link-generation","deleted":false,
                   "items":[{"id":101,"item_version":1,"section":"am",
                     "kind":"checklist","completed":true,"content":"<p>회의 준비</p>","sort_order":1}]})
        );
        // 새 항목은 id·item_version 을 아예 보내지 않는다(null 도 아님).
        let new_item = PushItem { id: None, item_version: None, client_key: Some("ck-00000001".into()), ..push.items[0].clone() };
        let v = serde_json::to_value(&new_item).unwrap();
        assert!(v.get("id").is_none() && v.get("item_version").is_none());
        assert_eq!(v["client_key"], "ck-00000001");
        // 서버 Strict 모델처럼 모르는 필드는 거절
        assert!(serde_json::from_value::<PushItem>(
            json!({"section":"main","kind":"text","content":"","completed":false,"sort_order":0,"favorite":true})
        )
        .is_err());
    }

    #[test]
    fn push_response_both_statuses() {
        let accepted: PushResponse = serde_json::from_value(json!({"status":"accepted","document":{
            "id":"d","type":"NEXT_LIST","key":"default","title":"Next","version":2,"deleted":false,"items":[],"attachments":[]}}))
        .unwrap();
        assert!(
            matches!(accepted, PushResponse::Accepted { ref document } if document.version == 2 && document.unit_type == UnitType::NextList)
        );
        let conflict: PushResponse = serde_json::from_value(json!({"status":"conflict","conflict_id":"c","version":5})).unwrap();
        assert_eq!(conflict, PushResponse::Conflict { conflict_id: "c".into(), version: 5 });
    }

    #[test]
    fn changes_conflicts_and_auth_shapes() {
        let changes: ChangesResponse = serde_json::from_value(json!({
            "events":[{"cursor":"abc:7","document_id":"d","link_id":"l","version":2,"kind":"changed"}],
            "cursor":"abc:7","has_more":false}))
        .unwrap();
        assert_eq!(changes.events[0].kind, "changed");
        // Desktop 제안({deleted, items}) · Web 제안(과거 Snapshot 전체) 모두 읽는다
        let conflicts: ConflictsResponse = serde_json::from_value(json!({
            "server":{"id":"d","type":"DAY","key":"2026-10-07","title":"2026-10-07","version":3,"deleted":false,"items":[],"attachments":[]},
            "conflicts":[
              {"id":"c1","source":"desktop","created_at":"2026-10-07T00:00:00","proposal":{"deleted":false,"items":[
                 {"id":null,"item_version":null,"client_key":"ck-1234567","section":"main","kind":"checklist","content":"x","completed":false,"sort_order":0}]}},
              {"id":"c2","source":"web","created_at":"2026-10-07T00:00:01","proposal":{"id":"d","type":"DAY","key":"2026-10-07",
                 "title":"2026-10-07","version":2,"deleted":false,"items":[],"attachments":[]}}
            ]})).unwrap();
        assert_eq!(conflicts.conflicts.len(), 2);
        assert_eq!(conflicts.conflicts[0].proposal.items[0].client_key.as_deref(), Some("ck-1234567"));
        assert_eq!(
            serde_json::to_value(ResolveRequest { base_version: 3, side: Side::Desktop }).unwrap(),
            json!({"base_version":3,"side":"desktop"})
        );
        let ack = AckRequest { version: 3, link_id: "l".into(), attachments: vec!["a.png".into()] };
        assert_eq!(serde_json::to_value(&ack).unwrap(), json!({"version":3,"link_id":"l","attachments":["a.png"]}));
        let link = LinkRequest { unit_type: UnitType::NextList, key: "default".into() };
        assert_eq!(serde_json::to_value(&link).unwrap(), json!({"type":"NEXT_LIST","key":"default"}));

        let exchange: ExchangeResponse = serde_json::from_value(json!({"access_token":"pms_secret","token_type":"Bearer",
            "expires_in":2592000,"device_id":"dev","user_id":42,"namespace":"local:offline-test-server"}))
        .unwrap();
        assert!(!format!("{exchange:?}").contains("pms_secret"), "토큰은 Debug 에 나오지 않는다");
        let request = ExchangeRequest { code: "the-code".into(), verifier: "the-verifier".into(), redirect_uri: "r".into() };
        let debug = format!("{request:?}");
        assert!(!debug.contains("the-code") && !debug.contains("the-verifier"));
        let start =
            AuthStartRequest { name: "PC".into(), challenge: "c".into(), state: "s".into(), redirect_uri: "r".into(), device_id: None };
        assert_eq!(serde_json::to_value(&start).unwrap()["device_id"], serde_json::Value::Null);
    }

    #[test]
    fn error_bodies() {
        assert_eq!(parse_error_body(br#"{"detail":{"code":"link_inactive"}}"#).code.as_deref(), Some("link_inactive"));
        assert_eq!(parse_error_body(br#"{"detail":"Memo sync unavailable"}"#).message.as_deref(), Some("Memo sync unavailable"));
        assert_eq!(parse_error_body(br#"{"detail":[{"msg":"field required"}]}"#).code.as_deref(), Some("validation"));
        assert_eq!(parse_error_body(b"<html>"), ErrorBody::default());
        // 참조 검사(422): 경로·본문은 싣지 않고 code + 항목 위치만
        let reference = parse_error_body(br#"{"detail":{"code":"local_path_not_allowed","item":2}}"#);
        assert_eq!((reference.code.as_deref(), reference.item), (Some("local_path_not_allowed"), Some(2)));
    }

    #[test]
    fn image_names_follow_server_regex() {
        let html = r#"<p>a<img src="/api/personal-memos/images/0a1b.png/download" width="10"><img src='/api/personal-memos/images/0a1b.png/download'>
            <img src="/api/personal-memos/images/ff.webp/download"> /api/personal-memos/images/bad/name/download</p>"#;
        assert_eq!(image_names(html), vec!["0a1b.png".to_string(), "ff.webp".to_string()]);
        assert!(image_names("<img src=\"attachment://x\">").is_empty());
    }

    #[test]
    fn request_id_rule() {
        assert!(valid_request_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!valid_request_id("short"));
        assert!(!valid_request_id("has space in it"));
    }
}
