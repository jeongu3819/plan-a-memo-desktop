//! MockSyncTransport 의 memo-sync-v2(공통 관리 상태) 부분 — **실제 서버가 아니다**.
//!
//! 기준: `docs/upstream-plan-a-work/memo_sync_v2_api.py`(경로·요청 모델·journal·alias 검사·cursor) + v2 계약·인계서.
//! 서버 Planning 서비스(`memo_planning`·`memo_management`) 코드는 Desktop 에 주어지지 않았으므로 아래 규칙은 계약 문장을 따른 흉내다:
//! * 복사: (owner, 원본 identity, 대상 날짜)당 하나 — 이미 있으면 그 복사본(지워졌거나 옮겨졌어도 되살리지 않음), 원본 version 불일치 409
//!   carry_source_changed, 미완료 체크리스트·삭제 안 됨·바로 지난주 같은 요일만, 같은 섹션 맨 뒤·미완료로.
//! * 알림 rule: 날짜당 하나, version 비교(불일치 409 reminder_changed + current/proposed — journal 에도 남는다).
//! * 발생: (namespace, owner, 날짜, offset) 에 묶인 64자리 id. ACK 단조·계정 공통, 시각 전 ACK 409 occurrence_not_due.
//! * 같은 request_id 재전송 = 저장한 결과(상태 코드 포함), 다른 내용 = 409 request_id_reused. 인증·link 검사가 먼저.
//! * changes: 기기별 별도 cursor(`<digest>:<id>`), 비활성 link 의 이벤트는 kind=unlinked.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{NaiveDate, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};

use super::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MockRule {
    pub version: i64,
    pub timezone: Option<String>,
    pub local_time: Option<String>,
    pub days_before: Vec<i64>,
    pub saved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockMgmtChange {
    pub id: i64,
    pub device_id: String,
    pub owner: i64,
    pub day: String,
    pub link_id: String,
    pub document_id: String,
    pub revision: i64,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MockManagement {
    /// MEMO_SYNC_V2_ENABLED — 꺼져 있으면 모든 v2 경로가 404 'Memo management v2 unavailable'
    pub enabled: bool,
    /// 시험용 서버 시각(RFC 3339). 없으면 실제 시각.
    pub clock: Option<String>,
    /// "<owner>|<date>"
    pub rules: BTreeMap<String, MockRule>,
    /// "<owner>|<date>|<offset>" → 확인 시각
    pub acks: BTreeMap<String, String>,
    pub cancelled: BTreeSet<String>,
    pub published: BTreeSet<String>,
    /// 건너뛴 안내 "<owner>|<target>"
    pub notices: BTreeSet<String>,
    /// 복사 출처 "<owner>|<source identity>|<target>" → 복사본 memo id
    pub copies: BTreeMap<String, i64>,
    /// 관리 revision "<owner>|<date>"
    pub revisions: BTreeMap<String, i64>,
    pub changes: Vec<MockMgmtChange>,
    /// journal "<owner>|<client>|<request_id>" → (digest, status, result, day)
    pub requests: BTreeMap<String, (String, u16, serde_json::Value, String)>,
    /// 다음 N 번의 v2 명령은 서버가 처리한 뒤 응답만 잃는다
    pub drop_next_responses: u32,
}

pub fn occurrence_id(owner: i64, date: &str, offset: i64) -> String {
    crate::util::sha256_hex(format!("occurrence|{MOCK_NAMESPACE}|{owner}|{date}|{offset}").as_bytes())
}

fn day_key(owner: i64, date: &str) -> String {
    format!("{owner}|{date}")
}

fn offset_key(owner: i64, date: &str, offset: i64) -> String {
    format!("{owner}|{date}|{offset}")
}

fn unavailable() -> TransportError {
    TransportError::Unavailable
}

/// 날짜 + 미리 알림 + 로컬 시각 + 시간대 → UTC. 시간대는 UTC·Asia/Seoul 은 고정, 그 밖은 이 PC 의 시간대로 본다(Mock 한계).
pub fn scheduled_utc(date: &str, offset: i64, local_time: &str, timezone: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()? - chrono::Duration::days(offset);
    let naive = day.and_time(NaiveTime::parse_from_str(local_time, "%H:%M").ok()?);
    let shift = match timezone {
        "UTC" | "Etc/UTC" => 0,
        "Asia/Seoul" => 9 * 3600,
        _ => chrono::Local.offset_from_local_datetime(&naive).single()?.local_minus_utc() as i64,
    };
    Some(chrono::Utc.from_utc_datetime(&(naive - chrono::Duration::seconds(shift))))
}

fn source_day(date: &str) -> TResult<String> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| (d - chrono::Duration::days(7)).format("%Y-%m-%d").to_string())
        .map_err(|_| TransportError::rejected(422, "Invalid date"))
}

impl MockServerState {
    fn v2_now(&self) -> chrono::DateTime<chrono::Utc> {
        self.mgmt
            .clock
            .as_deref()
            .and_then(|c| chrono::DateTime::parse_from_rfc3339(c).ok())
            .map(|t| t.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now)
    }

    fn v2_enabled(&self) -> TResult<()> {
        if self.mgmt.enabled {
            Ok(())
        } else {
            Err(unavailable())
        }
    }

    /// 서버 `access` — 날짜 형식 · (native) 현재 link generation 이 그 기기의 활성 연결인지. 연결을 만들지 않는다.
    fn v2_access(&self, ctx: &SyncContext, day: &str, link_id: Option<&str>) -> TResult<(i64, String)> {
        self.v2_enabled()?;
        let (device_id, device) = self.device_for(ctx)?;
        if NaiveDate::parse_from_str(day, "%Y-%m-%d").is_err() || day.len() != 10 {
            return Err(TransportError::rejected(422, "Invalid date"));
        }
        let Some(link_id) = link_id.filter(|l| !l.is_empty()) else { return Err(conflict("link_generation_required")) };
        let doc_id = self.doc_for_unit(device.owner, &Unit::day(day)).ok_or(TransportError::NotFound)?;
        self.link_owned(&device_id, &doc_id, Some(link_id))?;
        Ok((device.owner, device_id))
    }

    fn v2_rule(&self, owner: i64, date: &str) -> RuleDto {
        let rule = self.mgmt.rules.get(&day_key(owner, date)).cloned().unwrap_or_default();
        let occurrences = self.v2_occurrences(owner, date);
        RuleDto {
            version: rule.version,
            timezone: rule.timezone,
            local_time: rule.local_time,
            enabled: Some(!rule.days_before.is_empty()),
            days_before: rule.days_before,
            deliveries: serde_json::to_value(&occurrences).unwrap_or_default(),
        }
    }

    pub(crate) fn v2_occurrences(&self, owner: i64, date: &str) -> Vec<Occurrence> {
        let rule = self.mgmt.rules.get(&day_key(owner, date)).cloned().unwrap_or_default();
        let now = self.v2_now();
        let saved =
            rule.saved_at.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&chrono::Utc));
        let mut out = Vec::new();
        for offset in RULE_OFFSETS {
            let key = offset_key(owner, date, offset);
            let selected = rule.days_before.contains(&offset);
            let acked = self.mgmt.acks.get(&key).cloned();
            let cancelled = self.mgmt.cancelled.contains(&key);
            let published = self.mgmt.published.contains(&key);
            if !selected && acked.is_none() && !cancelled && !published {
                continue;
            }
            let at = scheduled_utc(
                date,
                offset,
                rule.local_time.as_deref().unwrap_or("09:00"),
                rule.timezone.as_deref().unwrap_or("Asia/Seoul"),
            );
            let state = if acked.is_some() {
                "acknowledged"
            } else if cancelled || !selected {
                "cancelled"
            } else if published {
                "published"
            } else if matches!((at, saved), (Some(at), Some(saved)) if at <= saved) {
                "missed"
            } else if at.is_some_and(|at| at <= now) {
                "published"
            } else {
                "scheduled"
            };
            out.push(Occurrence {
                id: occurrence_id(owner, date, offset),
                days_before: offset,
                scheduled_at: at.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
                state: state.into(),
                delivery_status: Some(
                    if matches!(state, "published") || (acked.is_some() && published) { "sent" } else { "pending" }.into(),
                ),
                acknowledged_at: acked,
                notification_id: None,
            });
        }
        out
    }

    fn v2_state(&self, owner: i64, date: &str) -> ManagementState {
        let source = source_day(date).unwrap_or_default();
        let copies: Vec<serde_json::Value> = self
            .mgmt
            .copies
            .iter()
            .filter(|(k, _)| k.starts_with(&format!("{owner}|")) && k.ends_with(&format!("|{date}")))
            .map(|(k, id)| serde_json::json!({"key": k, "copied_item_id": id}))
            .collect();
        ManagementState {
            namespace: Some(MOCK_NAMESPACE.into()),
            day: date.into(),
            management_revision: self.mgmt.revisions.get(&day_key(owner, date)).copied().unwrap_or(0),
            updated_at: None,
            updated_by_client: None,
            prompt: PromptState {
                source_date: Some(source),
                dismissed: self.mgmt.notices.contains(&day_key(owner, date)),
                copied_count: copies.len() as i64,
            },
            local_source_copies: copies.iter().filter(|c| c["key"].as_str().unwrap_or("").contains("|local:")).cloned().collect(),
            copies: copies.into_iter().filter(|c| c["key"].as_str().unwrap_or("").contains("|server:")).collect(),
            rule: self.v2_rule(owner, date),
            occurrences: self.v2_occurrences(owner, date),
        }
    }

    /// 관리 상태가 바뀌었다 — revision +1, 그 날짜에 연결된 기기마다 변경 이벤트.
    fn v2_touch(&mut self, owner: i64, date: &str) {
        let revision = {
            let entry = self.mgmt.revisions.entry(day_key(owner, date)).or_insert(0);
            *entry += 1;
            *entry
        };
        let Some(doc_id) = self.doc_for_unit(owner, &Unit::day(date)) else { return };
        let links: Vec<(String, String)> = self
            .links
            .iter()
            .filter(|(_, l)| l.document_id == doc_id && l.active)
            .map(|(id, l)| (id.clone(), l.device_id.clone()))
            .collect();
        for (link_id, device_id) in links {
            let id = self.id();
            self.mgmt.changes.push(MockMgmtChange {
                id,
                device_id,
                owner,
                day: date.into(),
                link_id,
                document_id: doc_id.clone(),
                revision,
                kind: "changed".into(),
            });
        }
    }

    /// 새로 연결된 DAY — 초기 상태 이벤트(이미 있는 Web 설정 포함).
    pub(super) fn v2_link_event(&mut self, owner: i64, device_id: &str, link_id: &str, unit: &Unit, document_id: &str) {
        if unit.unit_type != UnitType::Day {
            return;
        }
        let revision = self.mgmt.revisions.get(&day_key(owner, &unit.key)).copied().unwrap_or(0);
        let id = self.id();
        self.mgmt.changes.push(MockMgmtChange {
            id,
            device_id: device_id.into(),
            owner,
            day: unit.key.clone(),
            link_id: link_id.into(),
            document_id: document_id.into(),
            revision,
            kind: "changed".into(),
        });
    }

    /// 연결이 끝났다(해제·기기 폐기) — changes 에서 kind=unlinked 로 보인다.
    pub(super) fn v2_unlink_event(&mut self, link_id: &str) {
        let Some(link) = self.links.get(link_id).cloned() else { return };
        let Some(doc) = self.documents.get(&link.document_id).cloned() else { return };
        if doc.unit.unit_type != UnitType::Day {
            return;
        }
        let revision = self.mgmt.revisions.get(&day_key(doc.owner, &doc.unit.key)).copied().unwrap_or(0);
        let id = self.id();
        self.mgmt.changes.push(MockMgmtChange {
            id,
            device_id: link.device_id,
            owner: doc.owner,
            day: doc.unit.key,
            link_id: link_id.into(),
            document_id: link.document_id,
            revision,
            kind: "unlinked".into(),
        });
    }

    /// 서버 `run` — journal(같은 요청 = 저장한 결과, 다른 내용 = 409). `action` 이 실패하면 기록하지 않는다(rollback).
    #[allow(clippy::too_many_arguments)]
    fn v2_run(
        &mut self,
        owner: i64,
        client: &str,
        day: &str,
        kind: &str,
        request_id: &str,
        body: &impl Serialize,
        action: impl FnOnce(&mut MockServerState) -> TResult<(u16, serde_json::Value)>,
    ) -> TResult<(u16, serde_json::Value)> {
        if !valid_request_id(request_id) {
            return Err(TransportError::rejected(422, "Invalid request ID"));
        }
        let key = format!("{owner}|{client}|{request_id}");
        let digest = hashed(&serde_json::to_string(&(day, kind, body)).unwrap_or_default());
        if let Some((previous, status, result, _)) = self.mgmt.requests.get(&key) {
            if previous != &digest {
                return Err(conflict("request_id_reused"));
            }
            return Ok((*status, result.clone()));
        }
        let (status, result) = action(self)?;
        self.mgmt.requests.insert(key, (digest, status, result.clone(), day.into()));
        Ok((status, result))
    }

    /// 지금까지 이 날짜에 기록된 복사 mapping 들(alias 검사).
    fn v2_validate_aliases(&self, owner: i64, day: &str, mappings: &[CopyMapping]) -> TResult<()> {
        let keys: BTreeSet<&str> = mappings.iter().map(|m| m.local_copy_key.as_str()).collect();
        if keys.len() != mappings.len() {
            return Err(TransportError::rejected(422, "Duplicate local copy key"));
        }
        let mut old: BTreeMap<String, CopyMapping> = BTreeMap::new();
        for (k, (_, status, result, d)) in &self.mgmt.requests {
            if *status != 200 || d != day || !k.starts_with(&format!("{owner}|")) {
                continue;
            }
            if let Ok(r) = serde_json::from_value::<CarryResponse>(result.clone()) {
                for m in r.mappings {
                    old.insert(m.local_copy_key.clone(), m);
                }
            }
        }
        for m in mappings {
            let previous = old.get(&m.local_copy_key);
            let collision =
                self.memos.iter().find(|(_, memo)| memo.owner == owner && memo.client_key.as_deref() == Some(m.local_copy_key.as_str()));
            if previous.is_some_and(|p| p.source_identity != m.source_identity) || collision.is_some_and(|(id, _)| *id != m.copied_item_id)
            {
                return Err(conflict("copy_identity_reused"));
            }
        }
        Ok(())
    }

    fn v2_mapping(&self, id: i64, key: &str, source: &str, day: &str) -> CopyMapping {
        let memo = &self.memos[&id];
        CopyMapping {
            source_identity: source.into(),
            local_copy_key: key.into(),
            copied_item_id: id,
            client_key: memo.client_key.clone(),
            deleted: memo.deleted,
            moved: memo.unit != Unit::day(day),
        }
    }

    /// 서버 원본 → 대상 날짜 복사(Planning copy_items + provenance). 반환: (원본 id, 복사본 id).
    fn v2_copy_items(&mut self, owner: i64, day: &str, selections: &[(i64, Option<i64>)]) -> TResult<Vec<(i64, i64)>> {
        if selections.is_empty() || selections.len() > 100 {
            return Err(TransportError::rejected(422, "Select 1-100 items"));
        }
        let unique: BTreeSet<i64> = selections.iter().map(|s| s.0).collect();
        if unique.len() != selections.len() {
            return Err(TransportError::rejected(422, "Duplicate item"));
        }
        let source = source_day(day)?;
        let target = Unit::day(day);
        let mut out = Vec::new();
        let mut touched = false;
        for (id, version) in selections {
            let key = format!("{owner}|server:{id}|{day}");
            if let Some(copied) = self.mgmt.copies.get(&key) {
                // 이미 복사됨 — 원본이 바뀌었거나 복사본이 옮겨·지워졌어도 그 복사본을 돌려준다(되살리지 않음).
                out.push((*id, *copied));
                continue;
            }
            let memo =
                self.memos.get(id).filter(|m| m.owner == owner).cloned().ok_or_else(|| TransportError::rejected(422, "Item not found"))?;
            if memo.unit != Unit::day(&source) || memo.deleted || memo.kind != "checklist" || memo.completed {
                return Err(TransportError::rejected(422, "Source must be an incomplete checklist from the previous same weekday"));
            }
            if version.is_some_and(|v| v != memo.version) {
                return Err(conflict("carry_source_changed"));
            }
            let new_id = self.id();
            let order =
                self.memos.values().filter(|m| m.owner == owner && m.unit == target && m.section == memo.section && !m.deleted).count()
                    as i64;
            self.memos.insert(
                new_id,
                MockMemo {
                    owner,
                    unit: target.clone(),
                    client_key: Some(format!("carry-{}", &hashed(&key)[..24])),
                    section: memo.section.clone(),
                    kind: "checklist".into(),
                    content: memo.content.clone(),
                    completed: false,
                    sort_order: order,
                    version: 1,
                    deleted: false,
                },
            );
            self.mgmt.copies.insert(key, new_id);
            out.push((*id, new_id));
            touched = true;
        }
        if touched {
            self.ensure_day_doc(owner, day);
            self.web_commit(owner, &[target]);
        }
        Ok(out)
    }

    fn ensure_day_doc(&mut self, owner: i64, day: &str) {
        if self.doc_for_unit(owner, &Unit::day(day)).is_none() {
            let id = uid();
            self.documents.insert(id.clone(), MockDoc { owner, unit: Unit::day(day), version: 1, deleted: false });
            self.publish(&id, false);
        }
    }

    fn v2_save_rule(&mut self, owner: i64, day: &str, rule: &RuleWrite) -> TResult<()> {
        let mut offsets = rule.days_before.clone();
        offsets.sort();
        offsets.dedup();
        if offsets.len() != rule.days_before.len() || offsets.iter().any(|o| !RULE_OFFSETS.contains(o)) {
            return Err(TransportError::rejected(422, "days_before must be a unique subset of [7, 2]"));
        }
        if NaiveTime::parse_from_str(&rule.local_time, "%H:%M").is_err() || rule.local_time.len() != 5 || rule.timezone.trim().is_empty() {
            return Err(TransportError::rejected(422, "Invalid time or timezone"));
        }
        let previous = self.mgmt.rules.get(&day_key(owner, day)).cloned().unwrap_or_default();
        let ordered: Vec<i64> = RULE_OFFSETS.iter().filter(|o| rule.days_before.contains(o)).copied().collect();
        self.mgmt.rules.insert(
            day_key(owner, day),
            MockRule {
                version: previous.version + 1,
                timezone: Some(rule.timezone.clone()),
                local_time: Some(rule.local_time.clone()),
                days_before: ordered,
                saved_at: Some(self.v2_now().to_rfc3339()),
            },
        );
        self.v2_touch(owner, day);
        Ok(())
    }

    fn v2_ack(&mut self, owner: i64, day: &str, occurrence: &str) -> TResult<()> {
        let occ = self.v2_occurrences(owner, day).into_iter().find(|o| o.id == occurrence).ok_or(TransportError::NotFound)?;
        let due = occ
            .scheduled_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|t| t.with_timezone(&chrono::Utc) <= self.v2_now());
        if !due {
            return Err(conflict("occurrence_not_due"));
        }
        let key = offset_key(owner, day, occ.days_before);
        if !self.mgmt.acks.contains_key(&key) {
            let at = self.v2_now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            self.mgmt.acks.insert(key, at);
            self.v2_touch(owner, day);
        }
        Ok(())
    }

    fn v2_cancel(&mut self, owner: i64, day: &str, occurrence: &str) -> TResult<()> {
        let occ = self.v2_occurrences(owner, day).into_iter().find(|o| o.id == occurrence).ok_or(TransportError::NotFound)?;
        if self.mgmt.cancelled.insert(offset_key(owner, day, occ.days_before)) {
            self.v2_touch(owner, day);
        }
        Ok(())
    }
}

impl MockSyncTransport {
    fn v2_drop_response(&self) -> bool {
        self.web(|s| {
            if s.mgmt.drop_next_responses > 0 {
                s.mgmt.drop_next_responses -= 1;
                true
            } else {
                false
            }
        })
    }

    pub(super) fn v2_capabilities_impl(&self, ctx: &SyncContext) -> TResult<Capabilities> {
        self.fault("v2_capabilities")?;
        self.call(|s| {
            s.device_for(ctx)?;
            s.v2_enabled()?;
            Ok(Capabilities {
                version: 2,
                namespace: Some(MOCK_NAMESPACE.into()),
                features: vec!["carryover".into(), "reminder_rules".into(), "occurrences".into(), "shared_ack".into()],
                content_sync: Some(1),
                management_sync: Some(2),
                local_only_upload: Some(false),
            })
        })
    }

    pub(super) fn v2_state_impl(&self, ctx: &SyncContext, day: &str, link_id: &str) -> TResult<ManagementState> {
        self.fault("v2_state")?;
        self.call(|s| {
            let (owner, _) = s.v2_access(ctx, day, Some(link_id))?;
            Ok(s.v2_state(owner, day))
        })
    }

    pub(super) fn v2_candidates_impl(&self, ctx: &SyncContext, day: &str, link_id: &str, source_link_id: &str) -> TResult<CarryCandidates> {
        self.fault("v2_candidates")?;
        self.call(|s| {
            let (owner, _) = s.v2_access(ctx, day, Some(link_id))?;
            let source = source_day(day)?;
            s.v2_access(ctx, &source, Some(source_link_id))?;
            let items: Vec<CandidateItem> = s
                .memos
                .iter()
                .filter(|(id, m)| {
                    m.owner == owner
                        && m.unit == Unit::day(&source)
                        && !m.deleted
                        && m.kind == "checklist"
                        && !m.completed
                        && !s.mgmt.copies.contains_key(&format!("{owner}|server:{id}|{day}"))
                })
                .map(|(id, m)| CandidateItem { id: *id, version: Some(m.version) })
                .collect();
            let dismissed = s.mgmt.notices.contains(&day_key(owner, day));
            Ok(CarryCandidates {
                source_date: Some(source),
                target_date: Some(day.into()),
                dismissed,
                auto_prompt: !dismissed && !items.is_empty(),
                items,
            })
        })
    }

    pub(super) fn v2_carry_impl(&self, ctx: &SyncContext, day: &str, body: &CarryRequest) -> TResult<CarryResponse> {
        self.fault("v2_carry")?;
        let (_, result) = self.call(|s| {
            let (owner, client) = s.v2_access(ctx, day, Some(&body.link_id))?;
            let source = source_day(day)?;
            s.v2_access(ctx, &source, Some(&body.source_link_id))?;
            s.v2_run(owner, &client, day, "carry", &body.request_id, body, |s| {
                let selections: Vec<(i64, Option<i64>)> = body.items.iter().map(|i| (i.id, Some(i.version))).collect();
                let pairs = s.v2_copy_items(owner, day, &selections)?;
                let mappings: Vec<CopyMapping> = body
                    .items
                    .iter()
                    .zip(pairs)
                    .map(|(sel, (src, copied))| s.v2_mapping(copied, &sel.local_copy_key, &format!("server:{src}"), day))
                    .collect();
                s.v2_validate_aliases(owner, day, &mappings)?;
                s.v2_touch(owner, day);
                Ok((200, serde_json::to_value(CarryResponse { mappings, refresh_required: true }).unwrap()))
            })
        })?;
        if self.v2_drop_response() {
            return Err(TransportError::Offline);
        }
        serde_json::from_value(result).map_err(|_| TransportError::Server("mock".into()))
    }

    pub(super) fn v2_local_copy_impl(&self, ctx: &SyncContext, day: &str, body: &LocalCopyRequest) -> TResult<CarryResponse> {
        self.fault("v2_local_copy")?;
        let (_, result) = self.call(|s| {
            let (owner, client) = s.v2_access(ctx, day, Some(&body.link_id))?;
            if body.source_date != source_day(day)? {
                return Err(TransportError::rejected(422, "Source must be previous same weekday"));
            }
            if uuid::Uuid::parse_str(&body.local_source_id).is_err() || body.local_source_id != body.local_source_id.to_lowercase() {
                return Err(TransportError::rejected(422, "local_source_id"));
            }
            s.v2_run(owner, &client, day, "local-copy", &body.request_id, body, |s| {
                let identity = format!("local:{client}:{}", body.local_source_id);
                let key = hashed(&format!("local-copy-v2|{MOCK_NAMESPACE}|{owner}|{identity}|{day}"));
                let existing =
                    s.memos.iter().find(|(_, m)| m.owner == owner && m.client_key.as_deref() == Some(key.as_str())).map(|(id, _)| *id);
                let copied = match existing {
                    Some(id) => id,
                    None => {
                        // 서버 normalize 와 같은 이미지·참조 검사(소유한 개인 메모 이미지만)
                        let doc_id = s.doc_for_unit(owner, &Unit::day(day)).ok_or(TransportError::NotFound)?;
                        let doc = s.documents[&doc_id].clone();
                        let item = PushItem {
                            id: None,
                            item_version: None,
                            client_key: Some(key.clone()),
                            section: body.item.section.clone(),
                            kind: "checklist".into(),
                            content: body.item.content.clone(),
                            completed: false,
                            sort_order: 0,
                        };
                        s.normalize(&doc, false, &[item])?;
                        let id = s.id();
                        let order = s
                            .memos
                            .values()
                            .filter(|m| m.owner == owner && m.unit == Unit::day(day) && m.section == body.item.section && !m.deleted)
                            .count() as i64;
                        s.memos.insert(
                            id,
                            MockMemo {
                                owner,
                                unit: Unit::day(day),
                                client_key: Some(key.clone()),
                                section: body.item.section.clone(),
                                kind: "checklist".into(),
                                content: body.item.content.clone(),
                                completed: false,
                                sort_order: order,
                                version: 1,
                                deleted: false,
                            },
                        );
                        s.mgmt.copies.insert(format!("{owner}|{identity}|{day}"), id);
                        s.web_commit(owner, &[Unit::day(day)]);
                        id
                    }
                };
                let mappings = vec![s.v2_mapping(copied, &body.local_copy_key, &identity, day)];
                s.v2_validate_aliases(owner, day, &mappings)?;
                s.v2_touch(owner, day);
                Ok((200, serde_json::to_value(CarryResponse { mappings, refresh_required: true }).unwrap()))
            })
        })?;
        if self.v2_drop_response() {
            return Err(TransportError::Offline);
        }
        serde_json::from_value(result).map_err(|_| TransportError::Server("mock".into()))
    }

    pub(super) fn v2_dismiss_impl(&self, ctx: &SyncContext, day: &str, body: &Command) -> TResult<DismissResponse> {
        self.fault("v2_dismiss")?;
        let (_, result) = self.call(|s| {
            let (owner, client) = s.v2_access(ctx, day, Some(&body.link_id))?;
            s.v2_run(owner, &client, day, "dismiss", &body.request_id, body, |s| {
                if s.mgmt.notices.insert(day_key(owner, day)) {
                    s.v2_touch(owner, day);
                }
                Ok((200, serde_json::json!({"dismissed": true})))
            })
        })?;
        serde_json::from_value(result).map_err(|_| TransportError::Server("mock".into()))
    }

    pub(super) fn v2_rule_impl(&self, ctx: &SyncContext, day: &str, link_id: &str) -> TResult<RuleDto> {
        self.fault("v2_rule")?;
        self.call(|s| {
            let (owner, _) = s.v2_access(ctx, day, Some(link_id))?;
            Ok(s.v2_rule(owner, day))
        })
    }

    pub(super) fn v2_put_rule_impl(&self, ctx: &SyncContext, day: &str, body: &RulePut) -> TResult<RulePutResult> {
        self.fault("v2_put_rule")?;
        let (status, result) = self.call(|s| {
            let (owner, client) = s.v2_access(ctx, day, Some(&body.link_id))?;
            s.v2_run(owner, &client, day, "rule", &body.request_id, body, |s| {
                let current = s.v2_rule(owner, day);
                if current.version != body.rule.version {
                    return Ok((
                        409,
                        serde_json::json!({"detail": {"code": "reminder_changed", "current": current, "proposed": body.rule}}),
                    ));
                }
                s.v2_save_rule(owner, day, &body.rule)?;
                Ok((200, serde_json::to_value(s.v2_rule(owner, day)).unwrap()))
            })
        })?;
        if self.v2_drop_response() {
            return Err(TransportError::Offline);
        }
        if status == 409 {
            let bytes = serde_json::to_vec(&result).unwrap_or_default();
            let (current, proposed) = parse_rule_conflict(&bytes).ok_or_else(|| TransportError::Server("mock".into()))?;
            return Ok(RulePutResult::Changed { current, proposed });
        }
        serde_json::from_value(result).map(RulePutResult::Saved).map_err(|_| TransportError::Server("mock".into()))
    }

    pub(super) fn v2_occurrences_impl(&self, ctx: &SyncContext, day: &str, link_id: &str) -> TResult<OccurrencesResponse> {
        self.fault("v2_occurrences")?;
        self.call(|s| {
            let (owner, _) = s.v2_access(ctx, day, Some(link_id))?;
            Ok(OccurrencesResponse { occurrences: s.v2_occurrences(owner, day) })
        })
    }

    pub(super) fn v2_ack_impl(&self, ctx: &SyncContext, day: &str, occurrence: &str, body: &Command) -> TResult<OccurrenceAckResponse> {
        self.fault("v2_ack")?;
        let (_, result) = self.call(|s| {
            let (owner, client) = s.v2_access(ctx, day, Some(&body.link_id))?;
            s.v2_run(owner, &client, day, &format!("ack:{occurrence}"), &body.request_id, body, |s| {
                s.v2_ack(owner, day, occurrence)?;
                Ok((200, serde_json::json!({"acknowledged": true, "occurrence_id": occurrence})))
            })
        })?;
        if self.v2_drop_response() {
            return Err(TransportError::Offline);
        }
        serde_json::from_value(result).map_err(|_| TransportError::Server("mock".into()))
    }

    pub(super) fn v2_cancel_impl(
        &self,
        ctx: &SyncContext,
        day: &str,
        occurrence: &str,
        body: &Command,
    ) -> TResult<OccurrenceCancelResponse> {
        self.fault("v2_cancel")?;
        let (_, result) = self.call(|s| {
            let (owner, client) = s.v2_access(ctx, day, Some(&body.link_id))?;
            s.v2_run(owner, &client, day, &format!("cancel:{occurrence}"), &body.request_id, body, |s| {
                s.v2_cancel(owner, day, occurrence)?;
                Ok((200, serde_json::json!({"cancelled": true, "occurrence_id": occurrence})))
            })
        })?;
        serde_json::from_value(result).map_err(|_| TransportError::Server("mock".into()))
    }

    pub(super) fn v2_changes_impl(&self, ctx: &SyncContext, cursor: Option<&str>) -> TResult<ManagementChanges> {
        self.fault("v2_changes")?;
        self.call(|s| {
            s.v2_enabled()?;
            let (device_id, device) = s.device_for(ctx)?;
            let prefix = format!("{}:", &hashed(&format!("management-v2|{MOCK_NAMESPACE}|{}|{device_id}", device.owner))[..32]);
            let after = match cursor {
                Some(c) => match c.strip_prefix(&prefix).and_then(|n| n.parse::<i64>().ok()) {
                    Some(n) => n,
                    None => return Err(conflict("cursor_namespace_mismatch")),
                },
                None => 0,
            };
            let rows: Vec<&MockMgmtChange> =
                s.mgmt.changes.iter().filter(|c| c.device_id == device_id && c.owner == device.owner && c.id > after).take(101).collect();
            let events: Vec<ManagementEvent> = rows
                .iter()
                .take(100)
                .map(|c| ManagementEvent {
                    cursor: format!("{prefix}{}", c.id),
                    day: c.day.clone(),
                    document_id: Some(c.document_id.clone()),
                    link_id: Some(c.link_id.clone()),
                    management_revision: c.revision,
                    kind: if s.links.get(&c.link_id).is_some_and(|l| !l.active) { "unlinked".into() } else { c.kind.clone() },
                })
                .collect();
            let last = events.last().map(|e| e.cursor.clone()).unwrap_or_else(|| format!("{prefix}{after}"));
            Ok(ManagementChanges { events, cursor: last, has_more: rows.len() > 100 })
        })
    }

    // ── 'Web 에서' 일어난 일(개발 도구·테스트) — 같은 서버 규칙(Web 은 link 가 필요 없다) ─────────────────

    pub fn set_v2_enabled(&self, enabled: bool) {
        self.web(|s| s.mgmt.enabled = enabled);
    }

    /// 시험용 서버 시각(None = 실제 시각).
    pub fn set_v2_clock(&self, at: Option<chrono::DateTime<chrono::Utc>>) {
        self.web(|s| s.mgmt.clock = at.map(|t| t.to_rfc3339()));
    }

    /// 다음 v2 명령 N 번은 서버가 처리한 뒤 응답만 잃는다.
    pub fn drop_next_v2_responses(&self, count: u32) {
        self.web(|s| s.mgmt.drop_next_responses = count);
    }

    /// Web 에서 지난 미완료 복사(원본 서버 id 들) → 복사본 id 들.
    pub fn web_v2_carry(&self, owner: i64, target: &str, source_ids: &[i64]) -> TResult<Vec<i64>> {
        self.web(|s| {
            let backup = s.clone();
            let selections: Vec<(i64, Option<i64>)> = source_ids.iter().map(|id| (*id, None)).collect();
            match s.v2_copy_items(owner, target, &selections) {
                Ok(pairs) => {
                    s.v2_touch(owner, target);
                    Ok(pairs.into_iter().map(|(_, c)| c).collect())
                }
                Err(e) => {
                    *s = backup;
                    Err(e)
                }
            }
        })
    }

    pub fn web_v2_dismiss(&self, owner: i64, target: &str) {
        self.web(|s| {
            if s.mgmt.notices.insert(day_key(owner, target)) {
                s.v2_touch(owner, target);
            }
        });
    }

    /// Web 에서 알림 설정 저장(현재 version 위에 — Web 화면이 최신 설정을 보고 저장).
    pub fn web_v2_set_rule(&self, owner: i64, date: &str, days_before: &[i64], local_time: &str) -> TResult<RuleDto> {
        self.web(|s| {
            let version = s.v2_rule(owner, date).version;
            s.v2_save_rule(
                owner,
                date,
                &RuleWrite { version, timezone: "Asia/Seoul".into(), local_time: local_time.into(), days_before: days_before.to_vec() },
            )?;
            Ok(s.v2_rule(owner, date))
        })
    }

    pub fn web_v2_ack(&self, owner: i64, date: &str, offset: i64) -> TResult<()> {
        self.web(|s| s.v2_ack(owner, date, &occurrence_id(owner, date, offset)))
    }

    pub fn web_v2_cancel(&self, owner: i64, date: &str, offset: i64) -> TResult<()> {
        self.web(|s| s.v2_cancel(owner, date, &occurrence_id(owner, date, offset)))
    }

    pub fn v2_rule_of(&self, owner: i64, date: &str) -> RuleDto {
        self.state.lock().unwrap().v2_rule(owner, date)
    }

    pub fn v2_occurrence(&self, owner: i64, date: &str, offset: i64) -> Option<Occurrence> {
        self.state.lock().unwrap().v2_occurrences(owner, date).into_iter().find(|o| o.days_before == offset)
    }

    pub fn v2_state_of(&self, owner: i64, date: &str) -> ManagementState {
        self.state.lock().unwrap().v2_state(owner, date)
    }

    /// 복사 출처 기록(원본 identity, 대상 날짜, 복사본 id).
    pub fn v2_copies(&self, owner: i64) -> Vec<(String, String, i64)> {
        self.state
            .lock()
            .unwrap()
            .mgmt
            .copies
            .iter()
            .filter_map(|(k, id)| {
                let mut parts = k.splitn(2, '|');
                let o: i64 = parts.next()?.parse().ok()?;
                let rest = parts.next()?;
                let (source, target) = rest.rsplit_once('|')?;
                (o == owner).then(|| (source.to_string(), target.to_string(), *id))
            })
            .collect()
    }

    pub fn v2_dismissed(&self, owner: i64, date: &str) -> bool {
        self.state.lock().unwrap().mgmt.notices.contains(&day_key(owner, date))
    }
}
