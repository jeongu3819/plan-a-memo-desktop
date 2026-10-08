//! MockSyncTransport — PLAN-A Work memo-sync-v1 서버를 **흉내 내는** 개발·테스트용 가짜 서버.
//!
//! 실제 서버가 아니다. 하지만 같은 Contract 규칙을 따른다(backend/app/services/memo_sync*.py 기준):
//! 문서 version · link generation · 기기별 change cursor · request_id idempotency(같은 id 다른 내용 = 409) ·
//! client_key · 문서 전체 교체(빠진 항목 soft delete) · 다른 문서 항목 가져오기 거절(item_moved_or_not_owned) ·
//! 출처(desktop/web)가 있는 Conflict · stale resolve 409 · 정확한 ACK manifest · PKCE start/exchange/logout ·
//! 서버 local-path 검사(현재 서버 정규식 그대로).
//!
//! 앱에서는 저장 폴더 `sync/mock-server-v1.json` 에 상태를 저장한다. 설정 화면의 '개발용 Mock 서버' 도구가
//! `web_*` 함수로 'Web 에서 수정' 같은 상황을 만든다.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::contract::*;
use super::transport::*;
use crate::auth::AuthApi;

pub const MOCK_NAMESPACE: &str = "local:mock-server-01";
pub const MOCK_USER: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Unit {
    pub unit_type: UnitType,
    pub key: String,
}

impl Unit {
    pub fn day(date: &str) -> Self {
        Unit { unit_type: UnitType::Day, key: date.into() }
    }
    pub fn list(key: &str) -> Self {
        Unit { unit_type: UnitType::NextList, key: key.into() }
    }
}

impl PartialOrd for UnitType {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for UnitType {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (*self as u8).cmp(&(*other as u8))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockMemo {
    pub owner: i64,
    pub unit: Unit,
    pub client_key: Option<String>,
    pub section: String,
    pub kind: String,
    pub content: String,
    pub completed: bool,
    pub sort_order: i64,
    pub version: i64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockDoc {
    pub owner: i64,
    pub unit: Unit,
    pub version: i64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockLink {
    pub document_id: String,
    pub device_id: String,
    pub active: bool,
    pub ack_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockChange {
    pub id: i64,
    pub device_id: String,
    pub link_id: String,
    pub document_id: String,
    pub version: i64,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockConflict {
    pub document_id: String,
    pub device_id: String,
    pub source: String,
    pub base_version: i64,
    pub proposed: WireProposal,
    pub server_snapshot: WireDocument,
    pub resolved_version: Option<i64>,
    pub seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockDevice {
    pub owner: i64,
    pub name: String,
    pub token_hash: String,
    pub revoked: bool,
    pub expired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockAuthorization {
    pub name: String,
    pub challenge: String,
    pub state: String,
    pub redirect_uri: String,
    pub device_id: Option<String>,
    pub owner: Option<i64>,
    pub code_hash: Option<String>,
    pub consumed: bool,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockImage {
    pub owner: i64,
    pub data_b64: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MockServerState {
    pub online: bool,
    pub request_count: u64,
    /// 다음 업로드 N 번 실패(서버 오류)
    pub fail_next_uploads: u32,
    /// 다음 push N 번은 **서버가 저장한 뒤** 응답만 잃어버린다(성공 응답 유실).
    pub drop_next_push_responses: u32,
    pub next_id: i64,
    pub memos: BTreeMap<i64, MockMemo>,
    pub lists: BTreeMap<String, (i64, String)>,
    pub documents: BTreeMap<String, MockDoc>,
    pub links: BTreeMap<String, MockLink>,
    pub revisions: Vec<(String, i64, WireDocument)>,
    pub changes: Vec<MockChange>,
    /// "<device>:<request_id>" → (digest, 결과)
    pub requests: BTreeMap<String, (String, serde_json::Value)>,
    pub conflicts: BTreeMap<String, MockConflict>,
    pub images: BTreeMap<String, MockImage>,
    pub uploads: BTreeMap<String, (String, String)>,
    pub pins: BTreeSet<(String, String)>,
    pub devices: BTreeMap<String, MockDevice>,
    pub authorizations: BTreeMap<String, MockAuthorization>,
}

impl Default for MockServerState {
    fn default() -> Self {
        MockServerState {
            online: true,
            request_count: 0,
            fail_next_uploads: 0,
            drop_next_push_responses: 0,
            next_id: 100,
            memos: BTreeMap::new(),
            lists: BTreeMap::new(),
            documents: BTreeMap::new(),
            links: BTreeMap::new(),
            revisions: Vec::new(),
            changes: Vec::new(),
            requests: BTreeMap::new(),
            conflicts: BTreeMap::new(),
            images: BTreeMap::new(),
            uploads: BTreeMap::new(),
            pins: BTreeSet::new(),
            devices: BTreeMap::new(),
            authorizations: BTreeMap::new(),
        }
    }
}

fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn hashed(value: &str) -> String {
    crate::util::sha256_hex(value.as_bytes())
}

fn token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 36];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn rejected(message: &str) -> TransportError {
    TransportError::rejected(422, message)
}

fn conflict(code: &str) -> TransportError {
    TransportError::Conflict { code: code.into() }
}

/// 공통 Web rich-content 정책의 항목당 원본 HTML 상한(서버 기본 1 MiB, 배포 설정으로 바뀔 수 있음 → 413).
pub const MOCK_ITEM_RAW_HTML_BYTES: usize = 1024 * 1024;

const IMAGE_ONLY_OWNED: &str = "개인 메모에 붙여넣은 이미지만 사용할 수 있습니다. 이미지를 다시 붙여넣어주세요.";

/// 서버 참조 검사 거절(422 `{code, item}` — 경로·본문은 싣지 않는다).
fn reference_rejected(code: &str, item: usize) -> TransportError {
    TransportError::Rejected { status: 422, message: code.into(), code: Some(code.into()), item: Some(item) }
}

impl MockServerState {
    fn id(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
    }

    fn rows(&self, doc: &MockDoc, include_deleted: bool) -> Vec<(i64, MockMemo)> {
        let mut rows: Vec<(i64, MockMemo)> = self
            .memos
            .iter()
            .filter(|(_, m)| m.owner == doc.owner && m.unit == doc.unit && (include_deleted || !m.deleted))
            .map(|(id, m)| (*id, m.clone()))
            .collect();
        rows.sort_by_key(|a| (a.1.section.clone(), a.1.sort_order, a.0));
        rows
    }

    fn manifest(&self, owner: i64, items: &[WireItem], with_sha: bool) -> TResult<Vec<WireAttachment>> {
        let mut names: Vec<String> = items.iter().flat_map(|i| image_names(&i.content)).collect();
        names.sort();
        names.dedup();
        names
            .into_iter()
            .map(|name| {
                let image = self.images.get(&name).filter(|i| i.owner == owner).ok_or_else(|| rejected("Attachment not found"))?;
                let bytes = base64::engine::general_purpose::STANDARD.decode(&image.data_b64).unwrap_or_default();
                Ok(WireAttachment {
                    size: Some(bytes.len() as i64),
                    url: Some(image_url(&name)),
                    sha256: with_sha.then(|| crate::util::sha256_hex(&bytes)),
                    name,
                })
            })
            .collect()
    }

    fn snapshot(&self, doc_id: &str) -> WireDocument {
        let doc = self.documents[doc_id].clone();
        let items: Vec<WireItem> = self
            .rows(&doc, false)
            .into_iter()
            .map(|(id, m)| WireItem {
                id: Some(id),
                item_version: Some(m.version),
                client_key: m.client_key,
                section: m.section,
                kind: m.kind,
                content: m.content,
                completed: m.completed,
                sort_order: m.sort_order,
            })
            .collect();
        let title = match doc.unit.unit_type {
            UnitType::Day => doc.unit.key.clone(),
            UnitType::NextList => self.lists.get(&doc.unit.key).map(|l| l.1.clone()).unwrap_or_else(|| "Next".into()),
        };
        WireDocument {
            id: doc_id.to_string(),
            unit_type: doc.unit.unit_type,
            key: doc.unit.key.clone(),
            title: Some(title),
            version: doc.version,
            deleted: doc.deleted,
            attachments: self.manifest(doc.owner, &items, false).unwrap_or_default(),
            items,
        }
    }

    fn pin(&mut self, doc_id: &str, items: &[WireItem]) {
        for item in items {
            for name in image_names(&item.content) {
                self.pins.insert((doc_id.to_string(), name));
            }
        }
    }

    fn emit(&mut self, doc_id: &str, kind: &str, only: Option<Vec<String>>) {
        let version = self.documents[doc_id].version;
        let links: Vec<(String, String)> = self
            .links
            .iter()
            .filter(|(id, l)| l.document_id == doc_id && only.as_ref().map(|o| o.contains(id)).unwrap_or(l.active))
            .map(|(id, l)| (id.clone(), l.device_id.clone()))
            .collect();
        for (link_id, device_id) in links {
            let id = self.id();
            self.changes.push(MockChange { id, device_id, link_id, document_id: doc_id.into(), version, kind: kind.into() });
        }
    }

    fn publish(&mut self, doc_id: &str, increment: bool) -> WireDocument {
        if increment {
            self.documents.get_mut(doc_id).unwrap().version += 1;
        }
        let value = self.snapshot(doc_id);
        self.pin(doc_id, &value.items);
        self.revisions.push((doc_id.into(), value.version, value.clone()));
        self.emit(doc_id, "changed", None);
        value
    }

    fn doc_for_unit(&self, owner: i64, unit: &Unit) -> Option<String> {
        self.documents.iter().find(|(_, d)| d.owner == owner && &d.unit == unit).map(|(id, _)| id.clone())
    }

    /// Web 쪽 변경의 commit hook(`commit_memo_changes`) — 연결 문서가 있으면 새 version 을 낸다.
    fn web_commit(&mut self, owner: i64, units: &[Unit]) {
        let mut seen = Vec::new();
        for unit in units {
            if seen.contains(unit) {
                continue;
            }
            seen.push(unit.clone());
            if let Some(doc_id) = self.doc_for_unit(owner, unit) {
                let doc = self.documents[&doc_id].clone();
                if !self.rows(&doc, false).is_empty() {
                    self.documents.get_mut(&doc_id).unwrap().deleted = false;
                }
                self.publish(&doc_id, true);
            }
        }
    }

    fn device_for(&self, ctx: &SyncContext) -> TResult<(String, MockDevice)> {
        self.device_by_token(&ctx.access_token)
    }

    fn device_by_token(&self, access_token: &str) -> TResult<(String, MockDevice)> {
        let hash = hashed(access_token.trim_start_matches("Bearer "));
        let (id, device) = self.devices.iter().find(|(_, d)| d.token_hash == hash).ok_or(TransportError::AuthRequired)?;
        if device.revoked || device.expired {
            return Err(TransportError::AuthRequired);
        }
        Ok((id.clone(), device.clone()))
    }

    fn doc_owned(&self, owner: i64, doc_id: &str) -> TResult<MockDoc> {
        self.documents.get(doc_id).filter(|d| d.owner == owner).cloned().ok_or(TransportError::NotFound)
    }

    fn link_owned(&self, device_id: &str, doc_id: &str, generation: Option<&str>) -> TResult<String> {
        self.links
            .iter()
            .find(|(id, l)| {
                l.document_id == doc_id && l.device_id == device_id && l.active && generation.map(|g| g == id.as_str()).unwrap_or(true)
            })
            .map(|(id, _)| id.clone())
            .ok_or_else(|| conflict("link_inactive"))
    }

    fn status(&self, doc_id: &str, link_id: &str) -> String {
        let doc = &self.documents[doc_id];
        let link = &self.links[link_id];
        if self.conflicts.values().any(|c| c.document_id == doc_id && c.resolved_version.is_none()) {
            "conflict"
        } else if link.ack_version == doc.version {
            "synced"
        } else if link.ack_version > 0 {
            "connected"
        } else {
            "pending"
        }
        .into()
    }

    fn validate_unit(&self, owner: i64, unit: &Unit) -> TResult<()> {
        match unit.unit_type {
            UnitType::Day => {
                if chrono::NaiveDate::parse_from_str(&unit.key, "%Y-%m-%d").is_err() || unit.key.len() != 10 {
                    return Err(rejected("date 는 YYYY-MM-DD 형식이어야 합니다."));
                }
            }
            UnitType::NextList => {
                if unit.key != "default" && !self.lists.get(&unit.key).map(|l| l.0 == owner).unwrap_or(false) {
                    return Err(TransportError::NotFound);
                }
            }
        }
        Ok(())
    }

    /// 서버와 같은 순서: Pydantic(항목 수·글자 수 → 422) → 문서 byte(413) → 항목별 검사.
    fn normalize(&self, doc: &MockDoc, deleted: bool, items: &[PushItem]) -> TResult<WireProposal> {
        if items.len() > MAX_ITEMS {
            return Err(rejected("List should have at most 1000 items"));
        }
        if items.iter().any(|i| i.content.chars().count() > MAX_ITEM_CHARS) {
            return Err(rejected("String should have at most 500000 characters"));
        }
        if items.iter().map(|i| i.content.len()).sum::<usize>() > MAX_DOCUMENT_BYTES {
            return Err(TransportError::rejected(413, "Document exceeds 2 MB"));
        }
        let (mut keys, mut ids) = (BTreeSet::new(), BTreeSet::new());
        let mut out = Vec::new();
        for (index, item) in items.iter().enumerate() {
            match item.id {
                Some(id) => {
                    if !ids.insert(id) {
                        return Err(rejected("Duplicate item"));
                    }
                }
                None => {
                    let key = item.client_key.clone().unwrap_or_default();
                    if !(8..=64).contains(&key.len()) || !keys.insert(key) {
                        return Err(rejected("New items require unique client_key"));
                    }
                }
            }
            if item.content.len() > MOCK_ITEM_RAW_HTML_BYTES {
                return Err(TransportError::rejected(413, "Rich content exceeds the size limit"));
            }
            // URL 이 쓰이는 속성·CSS url() 만 검사(본문 글자는 검사하지 않는다) — sync/reference.rs
            let scan = super::reference::scan(&item.content);
            if let Some(code) = scan.violation {
                return Err(reference_rejected(code, index));
            }
            // 이미지는 소유한 개인 메모 서버 이미지만(외부 https 이미지는 첨부가 아니다)
            if scan.image_sources.iter().any(|src| image_names(src).is_empty()) {
                return Err(rejected(IMAGE_ONLY_OWNED));
            }
            for name in image_names(&item.content) {
                if !self.images.get(&name).map(|i| i.owner == doc.owner).unwrap_or(false) {
                    return Err(rejected(IMAGE_ONLY_OWNED));
                }
            }
            if !matches!(item.section.as_str(), "main" | "am" | "pm") {
                return Err(rejected("구역은 main / am / pm 중 하나여야 합니다."));
            }
            if doc.unit.unit_type == UnitType::NextList && item.section != "main" {
                return Err(rejected("Next list uses main section"));
            }
            if !matches!(item.kind.as_str(), "checklist" | "text") {
                return Err(rejected("유형은 checklist / text 중 하나여야 합니다."));
            }
            out.push(WireItem {
                id: item.id,
                item_version: item.item_version,
                client_key: item.client_key.clone(),
                section: item.section.clone(),
                kind: item.kind.clone(),
                content: item.content.clone(),
                completed: item.kind == "checklist" && item.completed,
                sort_order: item.sort_order,
            });
        }
        if deleted && !out.is_empty() {
            return Err(rejected("Deleted document must have no items"));
        }
        Ok(WireProposal { deleted, items: out, attachments: Vec::new() })
    }

    /// 서버 `replace` — 문서 전체 교체. 실패하면 상태를 바꾸지 않는다(서버 transaction rollback).
    fn replace(&mut self, doc_id: &str, value: &WireProposal) -> TResult<()> {
        let doc = self.documents[doc_id].clone();
        let current: BTreeMap<i64, MockMemo> = self.rows(&doc, true).into_iter().collect();
        let mut staged = self.memos.clone();
        let mut next_id = self.next_id;
        let mut keep = BTreeSet::new();
        for item in &value.items {
            let id = match item.id {
                Some(id) => {
                    if !current.contains_key(&id) {
                        return Err(conflict("item_moved_or_not_owned"));
                    }
                    id
                }
                None => {
                    let key = item.client_key.clone().unwrap_or_default();
                    match staged.iter().find(|(_, m)| m.owner == doc.owner && m.client_key.as_deref() == Some(key.as_str())) {
                        Some((id, _)) if current.contains_key(id) => *id,
                        Some(_) => return Err(conflict("client_key_in_use")),
                        None => {
                            next_id += 1;
                            staged.insert(
                                next_id,
                                MockMemo {
                                    owner: doc.owner,
                                    unit: doc.unit.clone(),
                                    client_key: Some(key),
                                    section: "main".into(),
                                    kind: "checklist".into(),
                                    content: String::new(),
                                    completed: false,
                                    sort_order: 0,
                                    version: 0,
                                    deleted: false,
                                },
                            );
                            next_id
                        }
                    }
                }
            };
            // 같은 row 를 id 와 client_key 로 두 번 가리키면(별칭 중복) 422 — 부분 저장 없음
            if !keep.insert(id) {
                return Err(rejected("Duplicate item"));
            }
            let memo = staged.get_mut(&id).unwrap();
            memo.content = item.content.clone();
            memo.section = item.section.clone();
            memo.kind = item.kind.clone();
            memo.completed = item.completed;
            memo.sort_order = item.sort_order;
            memo.deleted = false;
            memo.version += 1;
        }
        for (id, memo) in &current {
            if !keep.contains(id) && !memo.deleted {
                let m = staged.get_mut(id).unwrap();
                m.deleted = true;
                m.version += 1;
            }
        }
        self.memos = staged;
        self.next_id = next_id;
        self.documents.get_mut(doc_id).unwrap().deleted = value.deleted;
        Ok(())
    }
}

pub struct MockSyncTransport {
    state: Mutex<MockServerState>,
    persist_path: Mutex<Option<PathBuf>>,
    /// 테스트용 장애 주입 — (경로 이름, 돌려줄 오류). 요청이 서버에 닿기 전에 실패한다(서버 상태 그대로).
    faults: Mutex<Vec<(String, TransportError)>>,
    /// 받은 push 요청(경로의 문서 id, 본문) — 테스트가 '문서 전체를 보냈는가' 를 확인한다.
    pushes: Mutex<Vec<(String, PushRequest)>>,
}

impl Default for MockSyncTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl MockSyncTransport {
    pub fn new() -> Self {
        MockSyncTransport {
            state: Mutex::new(MockServerState::default()),
            persist_path: Mutex::new(None),
            faults: Mutex::new(Vec::new()),
            pushes: Mutex::new(Vec::new()),
        }
    }

    /// 다음 `op` 요청 하나를 `error` 로 실패시킨다(op: create_list·link·unlink·changes·document·push·ack·conflicts·
    /// resolve·upload·download). 여러 번 부르면 차례로 쓴다. 413·422·429·503·409·오프라인 등 HTTP 결과 흉내.
    pub fn inject(&self, op: &str, error: TransportError) {
        self.faults.lock().unwrap().push((op.to_string(), error));
    }

    fn fault(&self, op: &str) -> TResult<()> {
        let mut faults = self.faults.lock().unwrap();
        match faults.iter().position(|(name, _)| name == op) {
            Some(index) => {
                self.state.lock().unwrap().request_count += 1;
                Err(faults.remove(index).1)
            }
            None => Ok(()),
        }
    }

    /// 지금까지 받은 push 본문(오래된 것부터).
    pub fn pushes(&self) -> Vec<(String, PushRequest)> {
        self.pushes.lock().unwrap().clone()
    }

    /// 저장 폴더가 열리면 그 안의 Mock 상태를 읽는다(바뀌면 그 파일에 쓴다).
    pub fn attach_file(&self, path: PathBuf) {
        let loaded = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<MockServerState>(&bytes).ok()).unwrap_or_default();
        *self.state.lock().unwrap() = loaded;
        *self.persist_path.lock().unwrap() = Some(path);
    }

    fn save(&self, state: &MockServerState) {
        if let Some(path) = self.persist_path.lock().unwrap().clone() {
            if let Ok(bytes) = serde_json::to_vec(state) {
                let tmp = path.with_extension("json.tmp");
                if std::fs::write(&tmp, bytes).is_ok() {
                    let _ = std::fs::rename(&tmp, &path);
                }
            }
        }
    }

    /// 네트워크 요청 1건. 실패하면 상태를 되돌린다(서버 transaction 처럼).
    fn call<T>(&self, f: impl FnOnce(&mut MockServerState) -> TResult<T>) -> TResult<T> {
        let mut state = self.state.lock().unwrap();
        state.request_count += 1;
        if !state.online {
            return Err(TransportError::Offline);
        }
        let backup = state.clone();
        let result = f(&mut state);
        if result.is_err() {
            let count = state.request_count;
            *state = backup;
            state.request_count = count;
        }
        self.save(&state);
        result
    }

    /// Web 쪽 도구(네트워크 아님 — 오프라인이어도 Web 은 바뀔 수 있다).
    fn web<T>(&self, f: impl FnOnce(&mut MockServerState) -> T) -> T {
        let mut state = self.state.lock().unwrap();
        let value = f(&mut state);
        self.save(&state);
        value
    }

    // ── 조회(테스트·개발 화면) ─────────────────────────────────────────

    pub fn snapshot_state(&self) -> MockServerState {
        self.state.lock().unwrap().clone()
    }

    pub fn set_online(&self, online: bool) {
        self.web(|s| s.online = online);
    }

    pub fn is_online(&self) -> bool {
        self.state.lock().unwrap().online
    }

    pub fn fail_next_uploads(&self, count: u32) {
        self.web(|s| s.fail_next_uploads = count);
    }

    pub fn drop_next_push_responses(&self, count: u32) {
        self.web(|s| s.drop_next_push_responses = count);
    }

    pub fn request_count(&self) -> u64 {
        self.state.lock().unwrap().request_count
    }

    /// 서버(Web)에 보이는 그 날짜/List 의 현재 항목.
    pub fn unit_items(&self, owner: i64, unit: &Unit) -> Vec<(i64, MockMemo)> {
        let s = self.state.lock().unwrap();
        let mut rows: Vec<(i64, MockMemo)> =
            s.memos.iter().filter(|(_, m)| m.owner == owner && &m.unit == unit && !m.deleted).map(|(i, m)| (*i, m.clone())).collect();
        rows.sort_by_key(|a| (a.1.section.clone(), a.1.sort_order, a.0));
        rows
    }

    pub fn unit_texts(&self, owner: i64, unit: &Unit) -> Vec<String> {
        self.unit_items(owner, unit).into_iter().map(|(_, m)| m.content).collect()
    }

    pub fn document_of(&self, owner: i64, unit: &Unit) -> Option<WireDocument> {
        let s = self.state.lock().unwrap();
        s.doc_for_unit(owner, unit).map(|id| s.snapshot(&id))
    }

    pub fn link_status(&self, link_id: &str) -> Option<String> {
        let s = self.state.lock().unwrap();
        s.links.get(link_id).map(|l| s.status(&l.document_id, link_id))
    }

    pub fn open_conflicts(&self, document_id: &str) -> Vec<(String, String)> {
        let s = self.state.lock().unwrap();
        s.conflicts
            .iter()
            .filter(|(_, c)| c.document_id == document_id && c.resolved_version.is_none())
            .map(|(id, c)| (id.clone(), c.source.clone()))
            .collect()
    }

    pub fn devices(&self) -> Vec<(String, i64, bool)> {
        self.state.lock().unwrap().devices.iter().map(|(id, d)| (id.clone(), d.owner, d.revoked)).collect()
    }

    // ── 'Web 에서' 일어난 일(개발 도구·테스트) ─────────────────────────

    /// Web 에서 메모 작성(그 날짜/List 의 맨 뒤).
    pub fn web_create(&self, owner: i64, unit: &Unit, section: &str, content: &str) -> i64 {
        self.web(|s| {
            let id = s.id();
            let order =
                s.memos.values().filter(|m| m.owner == owner && &m.unit == unit && m.section == section && !m.deleted).count() as i64;
            s.memos.insert(
                id,
                MockMemo {
                    owner,
                    unit: unit.clone(),
                    client_key: Some(uid().replace('-', "")),
                    section: section.into(),
                    kind: "checklist".into(),
                    content: content.into(),
                    completed: false,
                    sort_order: order,
                    version: 1,
                    deleted: false,
                },
            );
            s.web_commit(owner, std::slice::from_ref(unit));
            id
        })
    }

    pub fn web_edit(&self, memo_id: i64, f: impl FnOnce(&mut MockMemo)) -> bool {
        self.web(|s| {
            let Some(memo) = s.memos.get_mut(&memo_id) else { return false };
            f(memo);
            memo.version += 1;
            let (owner, unit) = (memo.owner, memo.unit.clone());
            s.web_commit(owner, &[unit]);
            true
        })
    }

    pub fn web_delete(&self, memo_id: i64) -> bool {
        self.web_edit(memo_id, |m| m.deleted = true)
    }

    /// 서버 문서를 삭제(tombstone: deleted=true, 항목 없음) — 다른 기기가 List 를 지운 것처럼.
    pub fn web_tombstone(&self, owner: i64, unit: &Unit) {
        self.web(|s| {
            let doc_id = match s.doc_for_unit(owner, unit) {
                Some(id) => id,
                None => {
                    let id = uid();
                    s.documents.insert(id.clone(), MockDoc { owner, unit: unit.clone(), version: 1, deleted: false });
                    s.publish(&id, false);
                    id
                }
            };
            for memo in s.memos.values_mut().filter(|m| m.owner == owner && &m.unit == unit && !m.deleted) {
                memo.deleted = true;
                memo.version += 1;
            }
            s.documents.get_mut(&doc_id).unwrap().deleted = true;
            s.publish(&doc_id, true);
        })
    }

    /// Web 에서 다른 날짜/List 로 이동(같은 서버 id 유지). 연결된 문서 양쪽이 같이 바뀐다.
    pub fn web_move(&self, memo_id: i64, to: &Unit) -> bool {
        self.web(|s| {
            let Some(memo) = s.memos.get_mut(&memo_id) else { return false };
            let from = std::mem::replace(&mut memo.unit, to.clone());
            if to.unit_type == UnitType::NextList {
                memo.section = "main".into();
            }
            memo.version += 1;
            let owner = memo.owner;
            s.web_commit(owner, &[from, to.clone()]);
            true
        })
    }

    /// Web 에서 이름 있는 Next List 만들기.
    pub fn web_create_list(&self, owner: i64, title: &str) -> String {
        self.web(|s| {
            let id = uid();
            s.lists.insert(id.clone(), (owner, title.into()));
            id
        })
    }

    /// Web 에서 날짜/List 를 이 기기와 연결(Web → Desktop link).
    pub fn web_link(&self, owner: i64, device_id: &str, unit: &Unit) -> TResult<LinkResponse> {
        self.web(|s| Self::create_link(s, owner, device_id, unit))
    }

    pub fn web_unlink(&self, link_id: &str) -> bool {
        self.web(|s| {
            let Some(link) = s.links.get_mut(link_id) else { return false };
            if link.active {
                link.active = false;
                let doc = link.document_id.clone();
                s.emit(&doc, "unlinked", Some(vec![link_id.to_string()]));
            }
            true
        })
    }

    /// Web '기기 관리' 에서 이 PC 해제.
    pub fn web_revoke_device(&self, device_id: &str) {
        self.web(|s| Self::revoke(s, device_id));
    }

    /// credential 30일 만료를 흉내.
    pub fn expire_device(&self, device_id: &str) {
        self.web(|s| {
            if let Some(d) = s.devices.get_mut(device_id) {
                d.expired = true;
            }
        });
    }

    /// 열어 둔 오래된 Web 편집기가 늦게 저장 — `preserve_web_conflict` 처럼 Web 출처 제안을 만든다.
    pub fn web_stale_edit(&self, memo_id: i64, stale_item_version: i64, content: &str) -> Option<String> {
        self.web(|s| {
            let memo = s.memos.get(&memo_id)?.clone();
            let doc_id = s.doc_for_unit(memo.owner, &memo.unit)?;
            s.links.values().find(|l| l.document_id == doc_id && l.active)?;
            let revision = s
                .revisions
                .iter()
                .rev()
                .find(|(d, _, snap)| {
                    d == &doc_id && snap.items.iter().any(|i| i.id == Some(memo_id) && i.item_version == Some(stale_item_version))
                })?
                .clone();
            let mut proposed =
                WireProposal { deleted: false, items: revision.2.items.clone(), attachments: revision.2.attachments.clone() };
            for item in proposed.items.iter_mut() {
                if item.id == Some(memo_id) {
                    item.content = content.into();
                }
            }
            let device_id = s.links.values().find(|l| l.document_id == doc_id && l.active).map(|l| l.device_id.clone())?;
            let id = uid();
            let seq = s.id();
            let server_snapshot = s.snapshot(&doc_id);
            s.pin(&doc_id, &proposed.items);
            s.conflicts.insert(
                id.clone(),
                MockConflict {
                    document_id: doc_id.clone(),
                    device_id,
                    source: "web".into(),
                    base_version: revision.1,
                    proposed,
                    server_snapshot,
                    resolved_version: None,
                    seq,
                },
            );
            s.emit(&doc_id, "conflict", None);
            Some(id)
        })
    }

    /// Web 에서 이미지를 붙여넣었다(개인 메모 이미지) — 서버 이름.
    pub fn web_upload_image(&self, owner: i64, bytes: &[u8]) -> String {
        self.web(|s| {
            let mime = crate::attachments::sniff_image(bytes).map(|(m, _)| m).unwrap_or("image/png");
            let ext = IMAGE_TYPES.iter().find(|(m, _)| *m == mime).map(|(_, e)| *e).unwrap_or("png");
            let name = format!("{}.{ext}", uid().replace('-', ""));
            s.images.insert(
                name.clone(),
                MockImage { owner, data_b64: base64::engine::general_purpose::STANDARD.encode(bytes), mime: mime.into() },
            );
            name
        })
    }

    /// Web 의 비교 화면에서 해결(web/desktop) — Desktop 이 아닌 곳에서 해결된 경우.
    pub fn web_resolve(&self, conflict_id: &str, side: Side) -> TResult<WireDocument> {
        self.web(|s| {
            let c = s.conflicts.get(conflict_id).filter(|c| c.resolved_version.is_none()).cloned().ok_or(TransportError::NotFound)?;
            let side = if side == Side::Web { "web" } else { "desktop" };
            if side == c.source {
                s.replace(&c.document_id, &c.proposed)?;
            }
            let value = s.publish(&c.document_id, true);
            s.conflicts.get_mut(conflict_id).unwrap().resolved_version = Some(value.version);
            Ok(value)
        })
    }

    /// Web 의 동의 화면에서 [확인] — 일회용 code 가 담긴 loopback callback 주소를 돌려준다.
    pub fn approve_login(&self, authorization_id: &str, owner: i64) -> TResult<String> {
        self.web(|s| {
            let auth = s.authorizations.get_mut(authorization_id).ok_or(TransportError::NotFound)?;
            if expired(&auth.expires_at) {
                return Err(TransportError::NotFound);
            }
            if let Some(device) = &auth.device_id {
                if s.devices.get(device).map(|d| d.owner) != Some(owner) {
                    return Err(TransportError::Forbidden);
                }
                // 명시적 폐기(Web 기기 해제·로그아웃)는 그 기기 id 의 끝 — 브라우저 동의도 409
                if s.devices.get(device).is_some_and(|d| d.revoked) {
                    return Err(conflict("device_revoked"));
                }
            }
            let auth = s.authorizations.get_mut(authorization_id).unwrap();
            if auth.code_hash.is_some() {
                return Err(conflict("Authorization already issued"));
            }
            let code = token();
            auth.code_hash = Some(hashed(&code));
            auth.owner = Some(owner);
            auth.expires_at = (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339();
            let query: String =
                url::form_urlencoded::Serializer::new(String::new()).append_pair("code", &code).append_pair("state", &auth.state).finish();
            Ok(format!("{}?{query}", auth.redirect_uri))
        })
    }

    fn revoke(s: &mut MockServerState, device_id: &str) {
        if let Some(d) = s.devices.get_mut(device_id) {
            d.revoked = true;
        }
        for link in s.links.values_mut().filter(|l| l.device_id == device_id) {
            link.active = false;
        }
    }

    fn create_link(s: &mut MockServerState, owner: i64, device_id: &str, unit: &Unit) -> TResult<LinkResponse> {
        s.validate_unit(owner, unit)?;
        let doc_id = match s.doc_for_unit(owner, unit) {
            Some(id) => id,
            None => {
                let id = uid();
                s.documents.insert(id.clone(), MockDoc { owner, unit: unit.clone(), version: 1, deleted: false });
                s.publish(&id, false);
                id
            }
        };
        let existing =
            s.links.iter().find(|(_, l)| l.document_id == doc_id && l.device_id == device_id && l.active).map(|(id, _)| id.clone());
        let link_id = match existing {
            Some(id) => id,
            None => {
                let id = uid();
                s.links.insert(
                    id.clone(),
                    MockLink { document_id: doc_id.clone(), device_id: device_id.into(), active: true, ack_version: 0 },
                );
                s.emit(&doc_id, "linked", Some(vec![id.clone()]));
                id
            }
        };
        Ok(LinkResponse {
            document_id: doc_id.clone(),
            version: s.documents[&doc_id].version,
            status: s.status(&doc_id, &link_id),
            link_id,
        })
    }
}

fn expired(at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(at).map(|t| t.with_timezone(&chrono::Utc) <= chrono::Utc::now()).unwrap_or(true)
}

#[async_trait]
impl SyncTransport for MockSyncTransport {
    fn name(&self) -> &'static str {
        "mock"
    }

    async fn create_list(&self, ctx: &SyncContext, body: &NativeListCreate) -> TResult<NativeList> {
        self.fault("create_list")?;
        self.call(|s| {
            let (_, device) = s.device_for(ctx)?;
            if uuid::Uuid::parse_str(&body.id).is_err()
                || body.id != body.id.to_lowercase()
                || body.title.is_empty()
                || body.title.chars().count() > 120
            {
                return Err(rejected("invalid list"));
            }
            match s.lists.get(&body.id) {
                Some((owner, title)) if *owner != device.owner || title != &body.title => Err(conflict("List ID already in use")),
                Some(_) => Ok(NativeList { id: body.id.clone(), title: body.title.clone() }),
                None => {
                    s.lists.insert(body.id.clone(), (device.owner, body.title.clone()));
                    Ok(NativeList { id: body.id.clone(), title: body.title.clone() })
                }
            }
        })
    }

    async fn link(&self, ctx: &SyncContext, body: &LinkRequest) -> TResult<LinkResponse> {
        self.fault("link")?;
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            Self::create_link(s, device.owner, &device_id, &Unit { unit_type: body.unit_type, key: body.key.clone() })
        })
    }

    async fn unlink(&self, ctx: &SyncContext, link_id: &str) -> TResult<()> {
        self.fault("unlink")?;
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            let link = s.links.get(link_id).filter(|l| l.device_id == device_id).cloned().ok_or(TransportError::NotFound)?;
            s.doc_owned(device.owner, &link.document_id)?;
            if link.active {
                s.links.get_mut(link_id).unwrap().active = false;
                s.emit(&link.document_id, "unlinked", Some(vec![link_id.to_string()]));
            }
            Ok(())
        })
    }

    async fn changes(&self, ctx: &SyncContext, cursor: Option<&str>) -> TResult<ChangesResponse> {
        self.fault("changes")?;
        self.call(|s| {
            let (device_id, _) = s.device_for(ctx)?;
            let prefix = format!("{}:", &hashed(&format!("{MOCK_NAMESPACE}:{device_id}"))[..32]);
            let after = match cursor {
                Some(c) => match c.strip_prefix(&prefix).and_then(|n| n.parse::<i64>().ok()) {
                    Some(n) => n,
                    None => return Err(conflict("cursor_namespace_mismatch")),
                },
                None => 0,
            };
            let events: Vec<&MockChange> = s.changes.iter().filter(|c| c.device_id == device_id && c.id > after).take(101).collect();
            let page: Vec<ChangeEvent> = events
                .iter()
                .take(100)
                .map(|e| ChangeEvent {
                    cursor: format!("{prefix}{}", e.id),
                    document_id: e.document_id.clone(),
                    link_id: e.link_id.clone(),
                    version: e.version,
                    kind: e.kind.clone(),
                })
                .collect();
            let last = page.last().map(|e| e.cursor.clone()).unwrap_or_else(|| format!("{prefix}{after}"));
            Ok(ChangesResponse { events: page, cursor: last, has_more: events.len() > 100 })
        })
    }

    async fn document(&self, ctx: &SyncContext, document_id: &str) -> TResult<PulledDocument> {
        self.fault("document")?;
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            let doc = s.doc_owned(device.owner, document_id)?;
            let link_id = s.link_owned(&device_id, document_id, None)?;
            let mut value = s.snapshot(document_id);
            value.attachments = s.manifest(doc.owner, &value.items, true)?;
            Ok(PulledDocument { document: value, status: s.status(document_id, &link_id), link_id })
        })
    }

    async fn push(&self, ctx: &SyncContext, document_id: &str, body: &PushRequest) -> TResult<PushResponse> {
        self.pushes.lock().unwrap().push((document_id.to_string(), body.clone()));
        self.fault("push")?;
        let result = self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            let doc = s.doc_owned(device.owner, document_id)?;
            s.link_owned(&device_id, document_id, Some(&body.link_id))?;
            let fingerprint = hashed(&serde_json::to_string(&(document_id, body)).unwrap());
            let request_key = format!("{device_id}:{}", body.request_id);
            if let Some((digest, result)) = s.requests.get(&request_key) {
                if digest != &fingerprint {
                    return Err(conflict("request_id_reused"));
                }
                return serde_json::from_value(result.clone()).map_err(|_| TransportError::Server("mock".into()));
            }
            let value = s.normalize(&doc, body.deleted, &body.items)?;
            let pending = s.conflicts.values().any(|c| c.document_id == document_id && c.resolved_version.is_none());
            let result = if body.base_version != doc.version || pending {
                let id = uid();
                let seq = s.id();
                let server_snapshot = s.snapshot(document_id);
                s.pin(document_id, &value.items);
                s.conflicts.insert(
                    id.clone(),
                    MockConflict {
                        document_id: document_id.into(),
                        device_id: device_id.clone(),
                        source: "desktop".into(),
                        base_version: body.base_version,
                        proposed: value,
                        server_snapshot,
                        resolved_version: None,
                        seq,
                    },
                );
                s.emit(document_id, "conflict", None);
                PushResponse::Conflict { conflict_id: id, version: doc.version }
            } else {
                s.replace(document_id, &value)?;
                PushResponse::Accepted { document: s.publish(document_id, true) }
            };
            s.requests.insert(request_key, (fingerprint, serde_json::to_value(&result).unwrap()));
            Ok(result)
        })?;
        // 서버는 저장했지만 응답이 오는 도중 끊긴 상황
        let drop = self.web(|s| {
            if s.drop_next_push_responses > 0 {
                s.drop_next_push_responses -= 1;
                true
            } else {
                false
            }
        });
        if drop {
            return Err(TransportError::Offline);
        }
        Ok(result)
    }

    async fn ack(&self, ctx: &SyncContext, document_id: &str, body: &AckRequest) -> TResult<AckResponse> {
        self.fault("ack")?;
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            let doc = s.doc_owned(device.owner, document_id)?;
            let link_id = s.link_owned(&device_id, document_id, Some(&body.link_id))?;
            if body.version != doc.version {
                return Err(conflict("ack_version_stale"));
            }
            let value = s.snapshot(document_id);
            let mut expected: Vec<String> = s.manifest(doc.owner, &value.items, true)?.into_iter().map(|a| a.name).collect();
            let mut got = body.attachments.clone();
            expected.sort();
            got.sort();
            if expected != got {
                return Err(conflict("attachments_incomplete"));
            }
            s.links.get_mut(&link_id).unwrap().ack_version = body.version;
            Ok(AckResponse { status: s.status(document_id, &link_id) })
        })
    }

    async fn conflicts(&self, ctx: &SyncContext, document_id: &str) -> TResult<ConflictsResponse> {
        self.fault("conflicts")?;
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            s.doc_owned(device.owner, document_id)?;
            s.link_owned(&device_id, document_id, None)?;
            let mut list: Vec<(&String, &MockConflict)> =
                s.conflicts.iter().filter(|(_, c)| c.document_id == document_id && c.resolved_version.is_none()).collect();
            list.sort_by_key(|(_, c)| c.seq);
            Ok(ConflictsResponse {
                server: s.snapshot(document_id),
                conflicts: list
                    .into_iter()
                    .map(|(id, c)| WireConflict {
                        id: id.clone(),
                        proposal: c.proposed.clone(),
                        source: c.source.clone(),
                        created_at: None,
                    })
                    .collect(),
            })
        })
    }

    async fn resolve(&self, ctx: &SyncContext, document_id: &str, conflict_id: &str, body: &ResolveRequest) -> TResult<WireDocument> {
        self.fault("resolve")?;
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            let doc = s.doc_owned(device.owner, document_id)?;
            s.link_owned(&device_id, document_id, None)?;
            let c = s
                .conflicts
                .get(conflict_id)
                .filter(|c| c.document_id == document_id && c.resolved_version.is_none())
                .cloned()
                .ok_or(TransportError::NotFound)?;
            if body.base_version != doc.version {
                return Err(conflict("resolution_stale"));
            }
            let side = match body.side {
                Side::Web => "web",
                Side::Desktop => "desktop",
            };
            if side == c.source {
                s.replace(document_id, &c.proposed)?;
            }
            let value = s.publish(document_id, true);
            s.conflicts.get_mut(conflict_id).unwrap().resolved_version = Some(value.version);
            Ok(value)
        })
    }

    async fn upload(&self, ctx: &SyncContext, request_id: &str, file_name: &str, mime: &str, bytes: Vec<u8>) -> TResult<UploadResponse> {
        self.fault("upload")?;
        // 서버 오류 흉내 — 실패해도 카운터는 줄어든다(요청 롤백과 별개).
        let fail = self.web(|s| {
            s.online && s.fail_next_uploads > 0 && {
                s.fail_next_uploads -= 1;
                true
            }
        });
        if fail {
            self.call(|_| Ok(()))?;
            return Err(TransportError::Server("HTTP 500".into()));
        }
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            if !valid_request_id(request_id) {
                return Err(rejected("Invalid request ID"));
            }
            let fingerprint = crate::util::sha256_hex(&bytes);
            let key = format!("{device_id}:{request_id}");
            if let Some((digest, name)) = s.uploads.get(&key) {
                if digest != &fingerprint {
                    return Err(conflict("Request ID reused"));
                }
                let size = s
                    .images
                    .get(name)
                    .map(|i| base64::engine::general_purpose::STANDARD.decode(&i.data_b64).unwrap_or_default().len())
                    .unwrap_or(0);
                return Ok(UploadResponse { name: name.clone(), url: image_url(name), size: size as i64 });
            }
            let ext = file_name.rsplit('.').next().unwrap_or_default().to_lowercase();
            if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") || bytes.len() > MAX_IMAGE_BYTES {
                return Err(TransportError::rejected(413, "이미지 형식 또는 크기 제한"));
            }
            let sniffed = crate::attachments::sniff_image(&bytes).map(|(m, _)| m);
            if !matches!(sniffed, Some("image/png" | "image/jpeg" | "image/webp")) || sniffed != Some(mime) {
                return Err(TransportError::rejected(413, "이미지 형식"));
            }
            let name = format!("{}.{}", uid().replace('-', ""), if ext == "jpeg" { "jpg" } else { &ext });
            s.images.insert(
                name.clone(),
                MockImage { owner: device.owner, data_b64: base64::engine::general_purpose::STANDARD.encode(&bytes), mime: mime.into() },
            );
            s.uploads.insert(key, (fingerprint, name.clone()));
            Ok(UploadResponse { url: image_url(&name), size: bytes.len() as i64, name })
        })
    }

    async fn download(&self, ctx: &SyncContext, name: &str) -> TResult<Vec<u8>> {
        self.fault("download")?;
        self.call(|s| {
            let (device_id, device) = s.device_for(ctx)?;
            let image = s.images.get(name).filter(|i| i.owner == device.owner).cloned().ok_or(TransportError::NotFound)?;
            let linked = s
                .pins
                .iter()
                .any(|(doc, n)| n == name && s.links.values().any(|l| &l.document_id == doc && l.device_id == device_id && l.active));
            let uploaded = s.uploads.iter().any(|(k, (_, n))| n == name && k.starts_with(&format!("{device_id}:")));
            if !linked && !uploaded {
                return Err(TransportError::NotFound);
            }
            base64::engine::general_purpose::STANDARD.decode(&image.data_b64).map_err(|_| TransportError::Server("mock".into()))
        })
    }
}

#[async_trait]
impl AuthApi for MockSyncTransport {
    fn web_origin(&self) -> Option<String> {
        None
    }

    async fn start(&self, body: &AuthStartRequest) -> TResult<AuthStartResponse> {
        self.call(|s| {
            let port_ok = body
                .redirect_uri
                .strip_prefix("http://127.0.0.1:")
                .and_then(|rest| rest.strip_suffix(CALLBACK_PATH))
                .and_then(|port| port.parse::<u32>().ok())
                .map(|p| (1024..=65535).contains(&p))
                .unwrap_or(false);
            if !port_ok {
                return Err(rejected("Invalid native redirect URI"));
            }
            if body.challenge.len() != 43 || !(32..=128).contains(&body.state.len()) || body.name.is_empty() {
                return Err(rejected("validation"));
            }
            if let Some(device) = &body.device_id {
                if !s.devices.contains_key(device) {
                    return Err(TransportError::NotFound);
                }
            }
            let id = token();
            s.authorizations.insert(
                id.clone(),
                MockAuthorization {
                    name: body.name.clone(),
                    challenge: body.challenge.clone(),
                    state: body.state.clone(),
                    redirect_uri: body.redirect_uri.clone(),
                    device_id: body.device_id.clone(),
                    owner: None,
                    code_hash: None,
                    consumed: false,
                    expires_at: (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
                },
            );
            Ok(AuthStartResponse {
                browser_path: format!("/memo-desktop/authorize?request={id}"),
                authorization_id: id,
                namespace: MOCK_NAMESPACE.into(),
                expires_in: 300,
            })
        })
    }

    async fn exchange(&self, body: &ExchangeRequest) -> TResult<ExchangeResponse> {
        self.call(|s| {
            let hash = hashed(&body.code);
            let (id, auth) = s
                .authorizations
                .iter()
                .find(|(_, a)| a.code_hash.as_deref() == Some(hash.as_str()))
                .map(|(i, a)| (i.clone(), a.clone()))
                .ok_or(TransportError::AuthRequired)?;
            if crate::auth::pkce::challenge_for(&body.verifier) != auth.challenge
                || body.redirect_uri != auth.redirect_uri
                || auth.owner.is_none()
            {
                return Err(TransportError::AuthRequired);
            }
            if auth.consumed || expired(&auth.expires_at) {
                return Err(TransportError::AuthRequired);
            }
            s.authorizations.get_mut(&id).unwrap().consumed = true;
            let owner = auth.owner.unwrap();
            let access_token = format!("pms_{}", token());
            let device_id = match auth.device_id {
                Some(device) => {
                    let d = s.devices.get_mut(&device).ok_or(TransportError::NotFound)?;
                    if d.owner != owner {
                        return Err(TransportError::Forbidden);
                    }
                    // 폐기된 기기는 되살리지 않는다(폐기 전에 받은 code 라도) — 서버 409 device_revoked.
                    // 단순 만료(expired)는 같은 기기로 credential 만 바꾼다(link·cursor 유지).
                    if d.revoked {
                        return Err(conflict("device_revoked"));
                    }
                    d.token_hash = hashed(&access_token);
                    d.expired = false;
                    device
                }
                None => {
                    let device = uid();
                    s.devices.insert(
                        device.clone(),
                        MockDevice { owner, name: auth.name.clone(), token_hash: hashed(&access_token), revoked: false, expired: false },
                    );
                    device
                }
            };
            Ok(ExchangeResponse {
                access_token,
                token_type: "Bearer".into(),
                expires_in: 2_592_000,
                device_id,
                user_id: owner,
                namespace: MOCK_NAMESPACE.into(),
            })
        })
    }

    async fn logout(&self, access_token: &str) -> TResult<()> {
        self.call(|s| {
            let (device_id, _) = s.device_by_token(access_token)?;
            Self::revoke(s, &device_id);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_errors_carry_code_and_item_index_only() {
        assert_eq!(
            reference_rejected(super::super::reference::LOCAL_PATH_NOT_ALLOWED, 3),
            TransportError::Rejected {
                status: 422,
                message: "local_path_not_allowed".into(),
                code: Some("local_path_not_allowed".into()),
                item: Some(3)
            }
        );
    }
}
