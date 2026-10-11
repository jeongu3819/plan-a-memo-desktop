//! PLAN-A Work memo-sync-v2(공통 관리 상태) 전송 형식(DTO).
//!
//! 기준: `docs/upstream-plan-a-work/memo-sync-v2.md` · `MEMO_SYNC_V2_DESKTOP_HANDOFF.md` · `memo_sync_v2_api.py`.
//! 보내는 본문은 서버 Pydantic `Strict`(모르는 필드 → 422) 모델과 같은 필드만 쓴다. 받는 응답은 인계서에 적힌 필드만 읽고,
//! 인계서가 모양을 정하지 않은 값(`state.copies` 항목 등)은 해석하지 않고 그대로 보관한다.
//! v1 DTO(`contract`)는 바꾸지 않는다 — v1 Snapshot 에 새 필드를 넣지 않는다.

use serde::{Deserialize, Serialize};

/// v2 경로 — `NATIVE_PREFIX`(/api/memo-sync/native) 뒤에 붙는다.
pub const V2_PREFIX: &str = "/v2";

/// 서버 rule 이 다룰 수 있는 미리 알림(일) — 1주 전·2일 전.
pub const RULE_OFFSETS: [i64; 2] = [7, 2];

// ── capabilities ────────────────────────────────────────────────────────

/// GET v2/capabilities
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Capabilities {
    pub version: i64,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub content_sync: Option<i64>,
    #[serde(default)]
    pub management_sync: Option<i64>,
    #[serde(default)]
    pub local_only_upload: Option<bool>,
}

impl Capabilities {
    /// 이 PC 가 쓰는 공통 관리 기능이 모두 있는가(복사·알림 설정·발생·공통 확인).
    pub fn supports_shared_management(&self) -> bool {
        self.version >= 2
            && ["carryover", "reminder_rules", "occurrences", "shared_ack"].iter().all(|f| self.features.iter().any(|x| x == f))
    }
}

// ── 명령 공통 ───────────────────────────────────────────────────────────

/// `{request_id, link_id}` — dismiss · ack · cancel 본문.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub request_id: String,
    pub link_id: String,
}

// ── Carryover ───────────────────────────────────────────────────────────

/// POST v2/days/{target}/carry 의 항목 — 서버 item id + 그 item 의 version(문서 version 아님) + 임시 복사본 key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CarrySelection {
    pub id: i64,
    pub version: i64,
    pub local_copy_key: String,
}

/// POST v2/days/{target}/carry — 원본·대상 모두 이 기기에 연결된 경우.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CarryRequest {
    pub request_id: String,
    pub link_id: String,
    pub source_link_id: String,
    pub items: Vec<CarrySelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LocalCopyItem {
    pub content: String,
    pub section: String,
}

/// POST v2/days/{target}/carry/local-source — 이 PC 에만 있는 원본에서 고른 항목 하나(원본 문서는 올리지 않는다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LocalCopyRequest {
    pub request_id: String,
    pub link_id: String,
    pub source_date: String,
    pub local_source_id: String,
    pub local_copy_key: String,
    pub item: LocalCopyItem,
}

/// 복사 결과 — 임시 key → 서버 정식 복사본(id·client_key). 이미 있던 복사본이면 그 복사본(지워졌거나 옮겨졌어도 되살리지 않음).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopyMapping {
    pub source_identity: String,
    pub local_copy_key: String,
    pub copied_item_id: i64,
    #[serde(default)]
    pub client_key: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub moved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CarryResponse {
    pub mappings: Vec<CopyMapping>,
    #[serde(default)]
    pub refresh_required: bool,
}

/// GET v2/days/{target}/carry — 아직 복사하지 않은 원본 후보(이미 복사한 항목은 안내를 건너뛰었어도 빠진다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CarryCandidates {
    #[serde(default)]
    pub source_date: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
    #[serde(default)]
    pub dismissed: bool,
    #[serde(default)]
    pub auto_prompt: bool,
    #[serde(default)]
    pub items: Vec<CandidateItem>,
}

/// 기존 PersonalMemo DTO — 이 PC 는 서버 id 만 쓴다(나머지 필드는 읽지 않는다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateItem {
    pub id: i64,
    #[serde(default, alias = "item_version")]
    pub version: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DismissResponse {
    pub dismissed: bool,
}

// ── Reminder rule ───────────────────────────────────────────────────────

/// 서버 rule DTO. `enabled`·`deliveries` 는 읽기 전용(보내는 rule 에 넣지 않는다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuleDto {
    pub version: i64,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub local_time: Option<String>,
    #[serde(default)]
    pub days_before: Vec<i64>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub deliveries: serde_json::Value,
}

/// PUT 의 `rule` — 쓸 수 있는 필드만(version 은 이 제안의 기준 version).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RuleWrite {
    pub version: i64,
    pub timezone: String,
    pub local_time: String,
    pub days_before: Vec<i64>,
}

/// PUT v2/days/{day}/reminder
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RulePut {
    pub request_id: String,
    pub link_id: String,
    pub rule: RuleWrite,
}

/// PUT 결과 — 저장됨 또는 409 `reminder_changed`(서버 현재값·보낸 제안 — 자동으로 고르지 않는다).
#[derive(Debug, Clone, PartialEq)]
pub enum RulePutResult {
    Saved(RuleDto),
    Changed { current: RuleDto, proposed: serde_json::Value },
}

/// 409 본문 `{detail:{code:"reminder_changed", current, proposed}}` 을 읽는다.
pub fn parse_rule_conflict(body: &[u8]) -> Option<(RuleDto, serde_json::Value)> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let detail = value.get("detail")?;
    if detail.get("code")?.as_str()? != "reminder_changed" {
        return None;
    }
    let current: RuleDto = serde_json::from_value(detail.get("current")?.clone()).ok()?;
    Some((current, detail.get("proposed").cloned().unwrap_or(serde_json::Value::Null)))
}

// ── Occurrence ──────────────────────────────────────────────────────────

/// 알림 발생 하나 — 서버 공통 id(날짜·offset 마다 하나). Web notification_id 나 OS 알림 id 를 논리 id 로 쓰지 않는다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Occurrence {
    pub id: String,
    pub days_before: i64,
    #[serde(default)]
    pub scheduled_at: Option<String>,
    /// scheduled | published | acknowledged | cancelled | missed
    pub state: String,
    #[serde(default)]
    pub delivery_status: Option<String>,
    #[serde(default)]
    pub acknowledged_at: Option<String>,
    #[serde(default)]
    pub notification_id: Option<i64>,
}

impl Occurrence {
    /// 이 PC 가 더는 띄우지 않을 상태(확인·취소·놓침).
    pub fn closed(&self) -> bool {
        matches!(self.state.as_str(), "acknowledged" | "cancelled" | "missed") || self.acknowledged_at.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OccurrencesResponse {
    pub occurrences: Vec<Occurrence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OccurrenceAckResponse {
    pub acknowledged: bool,
    pub occurrence_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OccurrenceCancelResponse {
    pub cancelled: bool,
    pub occurrence_id: String,
}

// ── 날짜 관리 상태 · 변경 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PromptState {
    #[serde(default)]
    pub source_date: Option<String>,
    #[serde(default)]
    pub dismissed: bool,
    #[serde(default)]
    pub copied_count: i64,
}

/// GET v2/days/{day}/state — 날짜 하나의 관리 상태 전체.
/// `copies`·`local_source_copies` 항목 모양은 인계서에 없다 — 해석하지 않고 보관만 한다(복사 후보는 GET carry 로 판단).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManagementState {
    #[serde(default)]
    pub namespace: Option<String>,
    pub day: String,
    #[serde(default)]
    pub management_revision: i64,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub updated_by_client: Option<String>,
    #[serde(default)]
    pub prompt: PromptState,
    #[serde(default)]
    pub copies: Vec<serde_json::Value>,
    #[serde(default)]
    pub local_source_copies: Vec<serde_json::Value>,
    pub rule: RuleDto,
    #[serde(default)]
    pub occurrences: Vec<Occurrence>,
}

/// GET v2/changes 의 이벤트 — v1 cursor 와 다른 별도 cursor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManagementEvent {
    pub cursor: String,
    pub day: String,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub link_id: Option<String>,
    #[serde(default)]
    pub management_revision: i64,
    /// changed · unlinked · (초기 연결 이벤트 등 — unlinked 가 아니면 상태를 다시 받는다)
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManagementChanges {
    pub events: Vec<ManagementEvent>,
    pub cursor: String,
    pub has_more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 인계서 §2 의 carry 요청·응답 예시 그대로.
    #[test]
    fn carry_request_and_response_match_handoff_example() {
        let body = CarryRequest {
            request_id: "8ae854ed-1265-4bab-82ed-684034c31fd0".into(),
            link_id: "<target-generation>".into(),
            source_link_id: "<previous-week-generation>".into(),
            items: vec![CarrySelection { id: 101, version: 4, local_copy_key: "<stable-provisional-key>".into() }],
        };
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            json!({"request_id":"8ae854ed-1265-4bab-82ed-684034c31fd0","link_id":"<target-generation>",
                   "source_link_id":"<previous-week-generation>",
                   "items":[{"id":101,"version":4,"local_copy_key":"<stable-provisional-key>"}]})
        );
        let response: CarryResponse = serde_json::from_value(json!({"mappings":[{
            "source_identity":"server:101","local_copy_key":"<stable-provisional-key>",
            "copied_item_id":208,"client_key":"carry-<server-key>","deleted":false,"moved":false}],"refresh_required":true}))
        .unwrap();
        assert_eq!(response.mappings[0].copied_item_id, 208);
        assert_eq!(response.mappings[0].client_key.as_deref(), Some("carry-<server-key>"));
        assert!(response.refresh_required);
    }

    /// 인계서 §2 Local-only 원본 예시 그대로(원본 문서·History 없이 고른 항목 하나).
    #[test]
    fn local_copy_request_matches_handoff_example() {
        let body = LocalCopyRequest {
            request_id: "<uuid>".into(),
            link_id: "<target-generation>".into(),
            source_date: "2026-10-03".into(),
            local_source_id: "<lowercase-local-source-uuid>".into(),
            local_copy_key: "<stable-provisional-key>".into(),
            item: LocalCopyItem { content: "<p>Only selected copy</p>".into(), section: "am".into() },
        };
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            json!({"request_id":"<uuid>","link_id":"<target-generation>","source_date":"2026-10-03",
                   "local_source_id":"<lowercase-local-source-uuid>","local_copy_key":"<stable-provisional-key>",
                   "item":{"content":"<p>Only selected copy</p>","section":"am"}})
        );
    }

    /// 인계서 §3 — rule 은 `rule` 안에 쓸 수 있는 필드만(enabled·deliveries 를 되돌려 보내지 않는다).
    #[test]
    fn rule_put_sends_only_writable_fields() {
        let body = RulePut {
            request_id: "<uuid>".into(),
            link_id: "<generation>".into(),
            rule: RuleWrite { version: 3, timezone: "Asia/Seoul".into(), local_time: "09:00".into(), days_before: vec![7, 2] },
        };
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            json!({"request_id":"<uuid>","link_id":"<generation>",
                   "rule":{"version":3,"timezone":"Asia/Seoul","local_time":"09:00","days_before":[7,2]}})
        );
        let conflict = br#"{"detail":{"code":"reminder_changed","current":{"version":4,"timezone":"Asia/Seoul","local_time":"10:00","days_before":[2],"enabled":true,"deliveries":[]},"proposed":{"version":3,"timezone":"Asia/Seoul","local_time":"09:00","days_before":[7]}}}"#;
        let (current, proposed) = parse_rule_conflict(conflict).unwrap();
        assert_eq!((current.version, current.days_before.clone()), (4, vec![2]));
        assert_eq!(proposed["days_before"], json!([7]));
        assert!(parse_rule_conflict(br#"{"detail":{"code":"link_inactive"}}"#).is_none());
    }

    /// 인계서 §4·§5 의 occurrence·changes 예시 그대로.
    #[test]
    fn occurrence_state_and_changes_shapes() {
        let occ: Occurrence = serde_json::from_value(json!({"id":"a".repeat(64),"days_before":7,
            "scheduled_at":"2026-10-17T00:00:00Z","state":"acknowledged","delivery_status":"sent",
            "acknowledged_at":"2026-10-17T00:01:00Z","notification_id":99}))
        .unwrap();
        assert!(occ.closed());
        let changes: ManagementChanges = serde_json::from_value(json!({"events":[{"cursor":"<opaque>","day":"2026-10-24",
            "document_id":"<id>","link_id":"<generation>","management_revision":4,"kind":"changed"}],
            "cursor":"<page-cursor>","has_more":false}))
        .unwrap();
        assert_eq!(changes.events[0].management_revision, 4);
        let state: ManagementState = serde_json::from_value(json!({"namespace":"local:x","day":"2026-10-24","management_revision":4,
            "updated_at":"2026-10-11T00:00:00Z","updated_by_client":"web",
            "prompt":{"source_date":"2026-10-17","dismissed":true,"copied_count":2},
            "copies":[{"anything":"kept as-is"}],"local_source_copies":[],
            "rule":{"version":0,"timezone":null,"local_time":null,"days_before":[],"enabled":false,"deliveries":[]},
            "occurrences":[]}))
        .unwrap();
        assert!(state.prompt.dismissed);
        assert_eq!(state.rule.version, 0);
        let caps: Capabilities = serde_json::from_value(json!({"version":2,"namespace":"local:x",
            "features":["carryover","reminder_rules","occurrences","shared_ack"],"content_sync":1,"management_sync":2,"local_only_upload":false}))
        .unwrap();
        assert!(caps.supports_shared_management());
        // 모르는 필드는 보내지 않는다(서버 Strict 모델)
        assert!(serde_json::from_value::<Command>(json!({"request_id":"x","link_id":"y","user_id":1})).is_err());
    }
}
