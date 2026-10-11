//! memo-sync-v2(공통 관리 상태) 시나리오 — **MockSyncTransport(가짜 서버)** 로 검증한 결과다. 실제 PLAN-A Work 서버 검증이 아니다.
//! Mock 의 v2 규칙은 `docs/upstream-plan-a-work/memo_sync_v2_api.py`·v2 계약·Desktop 인계서를 따른 흉내다(sync/mock/v2.rs).
//!
//! 날짜는 실행하는 날 기준(대상 = 내일, 원본 = 대상 - 7일)으로 잡는다 — 서버 후보 조회는 '지난주 이후 날짜' 에만 한다.

mod common;

use std::sync::Arc;

use chrono::{Duration, NaiveDate};
use common::*;
use plan_a_memo_lib::auth::{loopback, AuthProvider, DesktopAuth, MemoryCredentialStore};
use plan_a_memo_lib::config::AppEnv;
use plan_a_memo_lib::memo::{carryover, repo, service, Location};
use plan_a_memo_lib::reminders;
use plan_a_memo_lib::storage::{migrations, Storage, StoragePaths};
use plan_a_memo_lib::sync::engine::{SyncEngine, SyncReport};
use plan_a_memo_lib::sync::link;
use plan_a_memo_lib::sync::management::{self, DayScope, ReviewChoice, RuleChoice};
use plan_a_memo_lib::sync::mock::{MockSyncTransport, Unit};
use plan_a_memo_lib::sync::transport::TransportError;

const REDIRECT_BASE: &str = "http://127.0.0.1:54321";

struct Env {
    _dir: tempfile::TempDir,
    storage: Storage,
    mock: Arc<MockSyncTransport>,
    auth: Arc<DesktopAuth>,
    engine: SyncEngine,
}

fn env_with(mock: Arc<MockSyncTransport>) -> Env {
    let (dir, storage) = temp_storage();
    let auth = Arc::new(
        DesktopAuth::new(AppEnv::Development, mock.clone(), Arc::new(MemoryCredentialStore::default()), true).with_device_name("Test PC"),
    );
    let engine = SyncEngine::new(mock.clone(), auth.clone());
    Env { _dir: dir, storage, mock, auth, engine }
}

async fn ready() -> Env {
    let mock = Arc::new(MockSyncTransport::new());
    mock.set_v2_enabled(true);
    let e = env_with(mock);
    e.login(1).await;
    e
}

impl Env {
    async fn login(&self, owner: i64) {
        let start = self.auth.begin_login(&format!("{REDIRECT_BASE}/memo-sync/callback"), false).await.unwrap();
        let callback = self.mock.approve_login(&start.authorization_id, owner).unwrap();
        let params = loopback::parse_target(&callback[REDIRECT_BASE.len()..]).unwrap();
        self.auth.complete_login(params).await.unwrap();
    }
    fn account(&self) -> String {
        self.auth.session_context().unwrap().account_key
    }
    async fn sync(&self) -> SyncReport {
        self.engine.run_once(&self.storage, true).await.unwrap()
    }
    /// 변경이 수렴할 때까지(복사 → 원본 Push → 결과 맞춤 → 상태 받기) 몇 번 돌린다.
    async fn settle(&self) {
        for _ in 0..4 {
            self.sync().await;
        }
    }
    fn link(&self, location: Location) {
        let account = self.account();
        self.storage
            .with_conn(|c| {
                let doc = repo::ensure_doc(c, &location)?;
                link::enable_link(c, &doc.id, &account)
            })
            .unwrap();
    }
    fn unlink(&self, location: Location) {
        self.storage
            .with_conn(|c| {
                let doc = repo::doc_for_location(c, &location)?.unwrap();
                link::disable_link(c, &doc.id).map(|_| ())
            })
            .unwrap();
    }
    fn carry(&self, target: &str) -> carryover::CarryoverInfo {
        self.storage.with_conn(|c| carryover::get(c, target, &today())).unwrap()
    }
    fn import(&self, target: &str, ids: &[String]) -> carryover::CarryoverResult {
        self.storage.with_conn(|c| carryover::import(c, &self.storage.paths, target, ids, &today())).unwrap()
    }
    fn local_texts(&self, date: &str) -> Vec<String> {
        texts(&self.storage, date)
    }
    fn server_ids(&self, date: &str) -> Vec<(i64, String)> {
        self.mock.unit_items(1, &Unit::day(date)).into_iter().map(|(id, m)| (id, m.content)).collect()
    }
    fn ops(&self, status: &str) -> i64 {
        count(&self.storage, &format!("SELECT COUNT(*) FROM management_outbox WHERE status = '{status}'"))
    }
    fn scope(&self, date: &str) -> DayScope {
        self.storage.with_conn(|c| management::day_scope(c, date)).unwrap()
    }
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn shift(date: &str, days: i64) -> String {
    (NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap() + Duration::days(days)).format("%Y-%m-%d").to_string()
}

/// (원본 = 지난주 같은 요일, 대상 = 내일)
fn days() -> (String, String) {
    let target = shift(&today(), 1);
    (shift(&target, -7), target)
}

/// 원본·대상 모두 연결하고, 원본에 미완료 체크리스트를 둔다.
async fn linked_pair(e: &Env, items: &[&str]) -> (String, String) {
    let (source, target) = days();
    for item in items {
        add(&e.storage, day(&source), "main", item);
    }
    add(&e.storage, day(&target), "am", "대상 날짜 기존 메모");
    e.link(day(&source));
    e.link(day(&target));
    e.settle().await;
    (source, target)
}

// ── 복사 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn web_copy_appears_on_desktop_and_is_not_offered_again() {
    let e = ready().await;
    let (source, target) = linked_pair(&e, &["보고서 작성", "자료 정리", "장비 확인"]).await;
    assert_eq!(e.carry(&target).items.len(), 3, "처음에는 세 항목 모두 후보");
    // Web 에서 두 항목을 복사
    let server_source: Vec<i64> = e.server_ids(&source).into_iter().map(|(id, _)| id).collect();
    e.mock.web_v2_carry(1, &target, &server_source[..2]).unwrap();
    e.settle().await;
    // ① 복사본이 Desktop 대상 날짜에 보인다(기존 Sync), ② 이미 복사한 항목은 다시 권하지 않는다
    let local = e.local_texts(&target);
    assert!(local.contains(&"보고서 작성".to_string()) && local.contains(&"자료 정리".to_string()));
    let info = e.carry(&target);
    assert!(info.shared);
    assert_eq!(info.items.iter().map(|i| i.content_html.clone()).collect::<Vec<_>>(), vec!["장비 확인".to_string()]);
    // ③ 원본은 그대로
    assert_eq!(e.local_texts(&source), vec!["보고서 작성", "자료 정리", "장비 확인"]);
    // ④ Desktop 에서 나머지만 가져와도 Web 복사본과 겹치지 않는다
    let ids: Vec<String> = info.items.iter().map(|i| i.id.clone()).collect();
    e.import(&target, &ids);
    e.settle().await;
    let server: Vec<String> = e.server_ids(&target).into_iter().map(|(_, c)| c).collect();
    assert_eq!(server.iter().filter(|c| c.as_str() == "보고서 작성").count(), 1);
    assert_eq!(server.iter().filter(|c| c.as_str() == "장비 확인").count(), 1);
    assert_eq!(e.mock.v2_copies(1).len(), 3, "출처 기록 3건(Web 2 + Desktop 1)");
    assert_eq!(e.local_texts(&target).len(), 4, "기존 1 + 복사 3 — 중복 없음");
}

#[tokio::test]
async fn desktop_copy_is_recorded_as_shared_copy_once() {
    let e = ready().await;
    let (source, target) = linked_pair(&e, &["보고서 작성", "자료 정리"]).await;
    let ids: Vec<String> = e.carry(&target).items.iter().map(|i| i.id.clone()).collect();
    let result = e.import(&target, &ids);
    assert_eq!(result.created.len(), 2, "복사본은 바로(오프라인이어도) 보인다");
    assert_eq!(e.ops("pending"), 2, "복사본마다 공통 복사 명령");
    e.settle().await;
    // 서버: 공통 복사 출처 2건, 대상 날짜 복사본 2개(+기존 1), 본문 Push 가 복사본을 따로 하나 더 만들지 않았다
    let copies = e.mock.v2_copies(1);
    assert_eq!(copies.len(), 2);
    assert!(copies.iter().all(|(src, t, _)| src.starts_with("server:") && t == &target));
    assert_eq!(e.server_ids(&target).len(), 3);
    // 로컬 복사본 = 서버 정식 복사본(같은 항목)
    let mapped = count(
        &e.storage,
        &format!(
            "SELECT COUNT(*) FROM sync_item_map m JOIN memo_items i ON i.id = m.item_id WHERE i.deleted_at IS NULL AND m.server_item_id IN ({})",
            copies.iter().map(|c| c.2.to_string()).collect::<Vec<_>>().join(",")
        ),
    );
    assert_eq!(mapped, 2);
    // Web 쪽 후보에서도 빠진다(같은 원본을 Web 에서 다시 복사해도 같은 복사본)
    let again = e.mock.web_v2_carry(1, &target, &e.server_ids(&source).into_iter().map(|(id, _)| id).collect::<Vec<_>>()).unwrap();
    assert_eq!(again.iter().copied().collect::<std::collections::BTreeSet<_>>(), copies.iter().map(|c| c.2).collect());
    assert_eq!(e.server_ids(&target).len(), 3);
    // 다시 가져오기 요청 — 아무것도 만들지 않는다
    assert_eq!(e.import(&target, &ids).created.len(), 0);
    e.settle().await;
    assert_eq!(e.server_ids(&target).len(), 3);
    assert_eq!(e.local_texts(&source), vec!["보고서 작성", "자료 정리"], "원본 보존");
    assert_eq!(e.ops("pending"), 0);
}

#[tokio::test]
async fn offline_copy_then_reconnect_and_lost_response_converge_once() {
    let e = ready().await;
    let (_, target) = linked_pair(&e, &["보고서 작성"]).await;
    e.mock.set_online(false);
    let ids: Vec<String> = e.carry(&target).items.iter().map(|i| i.id.clone()).collect();
    e.import(&target, &ids);
    let report = e.sync().await;
    assert!(report.offline);
    assert_eq!(e.ops("pending"), 1, "오프라인 — 명령은 영속 Outbox 에 남는다");
    assert!(e.local_texts(&target).contains(&"보고서 작성".to_string()));
    // 재연결 — 서버가 처리한 뒤 응답을 잃는다 → 같은 request_id 로 재전송 → 결과 재사용
    e.mock.set_online(true);
    e.mock.drop_next_v2_responses(1);
    e.settle().await;
    assert_eq!(e.mock.v2_copies(1).len(), 1);
    let server: Vec<String> = e.server_ids(&target).into_iter().map(|(_, c)| c).collect();
    assert_eq!(server.iter().filter(|c| c.as_str() == "보고서 작성").count(), 1, "중복 생성 없음");
    assert_eq!(e.local_texts(&target).iter().filter(|c| c.as_str() == "보고서 작성").count(), 1);
    assert_eq!(e.ops("pending"), 0);
    assert_eq!(e.ops("done"), 1);
}

#[tokio::test]
async fn app_restart_keeps_copy_outbox_and_mapping() {
    let mock = Arc::new(MockSyncTransport::new());
    mock.set_v2_enabled(true);
    let e = env_with(mock.clone());
    e.login(1).await;
    let (_, target) = linked_pair(&e, &["재시작 뒤에도"]).await;
    mock.set_online(false);
    let ids: Vec<String> = e.carry(&target).items.iter().map(|i| i.id.clone()).collect();
    e.import(&target, &ids);
    e.sync().await;
    // 같은 저장소를 새 엔진(앱 재실행)으로
    let engine = SyncEngine::new(mock.clone(), e.auth.clone());
    mock.set_online(true);
    for _ in 0..4 {
        engine.run_once(&e.storage, true).await.unwrap();
    }
    assert_eq!(mock.v2_copies(1).len(), 1);
    assert_eq!(e.server_ids(&target).into_iter().filter(|(_, c)| c == "재시작 뒤에도").count(), 1);
}

#[tokio::test]
async fn concurrent_web_and_offline_desktop_copy_end_with_one_copy() {
    let e = ready().await;
    let (source, target) = linked_pair(&e, &["장비 확인"]).await;
    e.mock.set_online(false);
    let ids: Vec<String> = e.carry(&target).items.iter().map(|i| i.id.clone()).collect();
    e.import(&target, &ids);
    e.sync().await;
    // 그 사이 Web 에서 같은 항목을 같은 날짜로 복사
    let src = e.server_ids(&source)[0].0;
    e.mock.web_v2_carry(1, &target, &[src]).unwrap();
    e.mock.set_online(true);
    e.settle().await;
    assert_eq!(e.mock.v2_copies(1).len(), 1);
    assert_eq!(e.server_ids(&target).into_iter().filter(|(_, c)| c == "장비 확인").count(), 1, "서버 복사본 하나");
    assert_eq!(e.local_texts(&target).iter().filter(|c| c.as_str() == "장비 확인").count(), 1, "이 PC 도 하나");
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM carry_reviews WHERE status = 'open'"), 0, "고치지 않은 복사본 — 물을 것 없음");
}

#[tokio::test]
async fn edited_copy_vs_web_edit_asks_user_and_keeps_both_until_choice() {
    let e = ready().await;
    let (source, target) = linked_pair(&e, &["원래 내용"]).await;
    // Desktop(오프라인): 복사 + 복사본 수정
    e.mock.set_online(false);
    let ids: Vec<String> = e.carry(&target).items.iter().map(|i| i.id.clone()).collect();
    let created = e.import(&target, &ids).created;
    e.storage.with_conn(|c| service::update_content(c, &created[0].id, "이 PC 에서 고침")).unwrap();
    e.sync().await;
    // 그 사이 Web: 같은 원본을 같은 날짜로 복사하고 그 복사본을 고침
    let src = e.server_ids(&source)[0].0;
    let copy = e.mock.web_v2_carry(1, &target, &[src]).unwrap()[0];
    e.mock.web_edit(copy, |m| m.content = "Web 에서 고침".into());
    e.mock.set_online(true);
    e.settle().await;
    let reviews = e.storage.with_conn(|c| management::reviews_for(c, &target)).unwrap();
    assert_eq!(reviews.len(), 1, "양쪽 모두 바뀜 → 사용자 선택");
    assert_eq!(reviews[0].kind, "both_changed");
    assert_eq!(reviews[0].local_html.as_deref(), Some("이 PC 에서 고침"));
    assert_eq!(reviews[0].server_html.as_deref(), Some("Web 에서 고침"));
    // 선택 전에는 어느 쪽도 덮지 않는다
    assert!(e.local_texts(&target).contains(&"이 PC 에서 고침".to_string()));
    assert!(e.server_ids(&target).iter().any(|(_, c)| c == "Web 에서 고침"));
    // 이 PC 내용 선택 → 서버 복사본에 반영(복사본은 여전히 하나)
    e.storage.with_conn(|c| management::resolve_review(c, &reviews[0].id, ReviewChoice::Local)).unwrap();
    e.settle().await;
    let server = e.server_ids(&target);
    assert!(server.iter().any(|(id, c)| *id == copy && c == "이 PC 에서 고침"));
    assert_eq!(server.len(), 2, "기존 1 + 복사본 1");
}

#[tokio::test]
async fn local_only_source_sends_only_selected_item() {
    let e = ready().await;
    let (source, target) = days();
    add(&e.storage, day(&source), "pm", "이 PC 에만 있는 할 일");
    add(&e.storage, day(&source), "pm", "고르지 않은 할 일");
    add(&e.storage, day(&target), "main", "대상");
    e.link(day(&target));
    e.settle().await;
    let info = e.carry(&target);
    let picked = info.items.iter().find(|i| i.content_html == "이 PC 에만 있는 할 일").unwrap().id.clone();
    e.import(&target, std::slice::from_ref(&picked));
    e.settle().await;
    let copies = e.mock.v2_copies(1);
    assert_eq!(copies.len(), 1);
    assert!(copies[0].0.starts_with("local:") && copies[0].0.ends_with(&picked.to_lowercase()), "출처 = 이 기기 + 로컬 원본 UUID");
    assert!(e.mock.document_of(1, &Unit::day(&source)).is_none(), "원본 날짜는 서버에 만들지도 연결하지도 않는다");
    assert!(!e.mock.snapshot_state().memos.values().any(|m| m.content == "고르지 않은 할 일"), "고르지 않은 항목은 보내지 않는다");
    let server: Vec<String> = e.server_ids(&target).into_iter().map(|(_, c)| c).collect();
    assert_eq!(server.iter().filter(|c| c.as_str() == "이 PC 에만 있는 할 일").count(), 1);
    assert_eq!(e.scope(&source), DayScope::Local);
}

#[tokio::test]
async fn local_only_days_never_use_v2() {
    let e = ready().await;
    let (source, target) = days();
    add(&e.storage, day(&source), "main", "A");
    let ids: Vec<String> = e.carry(&target).items.iter().map(|i| i.id.clone()).collect();
    e.import(&target, &ids);
    e.storage.with_conn(|c| reminders::set(c, &shift(&target, 20), &[7], "09:00", reminders::local_now())).unwrap();
    e.storage.with_conn(|c| carryover::skip(c, &shift(&target, 7))).unwrap();
    e.settle().await;
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM management_outbox"), 0);
    let state = e.mock.snapshot_state();
    assert!(state.memos.is_empty() && state.documents.is_empty(), "연결하지 않은 날짜는 올리지 않는다");
    assert!(state.mgmt.requests.is_empty() && state.mgmt.rules.is_empty());
    assert!(!e.carry(&target).shared);
}

#[tokio::test]
async fn dismiss_is_shared_both_ways() {
    let e = ready().await;
    let (_, target) = linked_pair(&e, &["A", "B"]).await;
    e.storage.with_conn(|c| carryover::skip(c, &target)).unwrap();
    e.settle().await;
    assert!(e.mock.v2_dismissed(1, &target), "Desktop 건너뛰기 → 서버 공통 안내 상태");
    // Web 에서 건너뛴 다른 날짜 → Desktop 도 다시 저절로 안내하지 않는다
    let (source2, target2) = (shift(&days().0, -7), shift(&days().1, -7));
    add(&e.storage, day(&source2), "main", "지난 할 일");
    e.link(day(&source2));
    e.link(day(&target2));
    e.settle().await;
    e.mock.web_v2_dismiss(1, &target2);
    e.settle().await;
    let info = e.storage.with_conn(|c| carryover::get(c, &target2, &target2)).unwrap();
    assert!(!info.auto_prompt);
    assert_eq!(info.status.as_deref(), Some("skipped"));
    assert_eq!(info.items.len(), 1, "보조 메뉴로는 언제든 다시 고를 수 있다");
}

// ── 알림 설정 ───────────────────────────────────────────────────────────

async fn linked_future_day(e: &Env, offset: i64) -> String {
    let date = shift(&today(), offset);
    add(&e.storage, day(&date), "main", "그날 할 일");
    e.link(day(&date));
    e.settle().await;
    date
}

fn set_reminder(e: &Env, date: &str, offsets: &[i64], time: &str) {
    e.storage
        .with_conn(|c| match management::day_scope(c, date)? {
            DayScope::Shared { account_key, .. } => management::propose_rule(c, &account_key, date, offsets, time, reminders::local_now()),
            DayScope::Local => reminders::set(c, date, offsets, time, reminders::local_now()).map(|_| ()),
            other => panic!("unexpected scope {other:?}"),
        })
        .unwrap();
}

#[tokio::test]
async fn desktop_rule_reaches_server_and_web_rule_reaches_desktop() {
    let e = ready().await;
    let date = linked_future_day(&e, 20).await;
    set_reminder(&e, &date, &[7, 2], "09:00");
    e.settle().await;
    let rule = e.mock.v2_rule_of(1, &date);
    assert_eq!((rule.version, rule.days_before.clone(), rule.local_time.as_deref()), (1, vec![7, 2], Some("09:00")));
    // Web 에서 바꿈 → Desktop 설정·Windows 예약 행 갱신
    e.mock.web_v2_set_rule(1, &date, &[2], "18:30").unwrap();
    e.settle().await;
    let local = e.storage.with_conn(|c| reminders::get(c, &date)).unwrap().unwrap();
    assert_eq!((local.offsets.clone(), local.time.as_str()), (vec![2], "18:30"));
    // 알림 끄기(Web) → Desktop 예약 없음
    e.mock.web_v2_set_rule(1, &date, &[], "18:30").unwrap();
    e.settle().await;
    assert!(e.storage.with_conn(|c| reminders::get(c, &date)).unwrap().is_none());
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM management_outbox WHERE kind = 'rule' AND status = 'pending'"), 0);
}

#[tokio::test]
async fn concurrent_rule_edits_keep_both_until_user_chooses() {
    let e = ready().await;
    let date = linked_future_day(&e, 20).await;
    e.mock.set_online(false);
    set_reminder(&e, &date, &[7], "09:00"); // Desktop(오프라인) — 1주 전
    e.mock.web_v2_set_rule(1, &date, &[2], "10:00").unwrap(); // 동시에 Web — 2일 전
    e.mock.set_online(true);
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n == management::NOTICE_RULE_CONFLICT));
    let view = e.storage.with_conn(|c| management::day_view(c, &date)).unwrap();
    let conflict = view.reminder_conflict.expect("충돌 보관");
    assert_eq!(conflict.current.days_before, vec![2]);
    assert_eq!(conflict.proposed.days_before, vec![7]);
    assert_eq!(e.mock.v2_rule_of(1, &date).days_before, vec![2], "조용히 덮어쓰지 않는다");
    // 사용자가 '이 PC 설정' — 서버 최신 version 위에 다시 보낸다
    e.storage.with_conn(|c| management::resolve_rule_conflict(c, &date, RuleChoice::Mine, reminders::local_now())).unwrap();
    e.settle().await;
    let rule = e.mock.v2_rule_of(1, &date);
    assert_eq!((rule.days_before.clone(), rule.local_time.as_deref()), (vec![7], Some("09:00")));
    assert!(e.storage.with_conn(|c| management::day_view(c, &date)).unwrap().reminder_conflict.is_none());
    // 다시 엇갈림 → 이번엔 'PLAN-A Work 설정'
    e.mock.set_online(false);
    set_reminder(&e, &date, &[7, 2], "08:00");
    e.mock.web_v2_set_rule(1, &date, &[2], "11:00").unwrap();
    e.mock.set_online(true);
    e.sync().await;
    e.storage.with_conn(|c| management::resolve_rule_conflict(c, &date, RuleChoice::Server, reminders::local_now())).unwrap();
    e.settle().await;
    let local = e.storage.with_conn(|c| reminders::get(c, &date)).unwrap().unwrap();
    assert_eq!((local.offsets.clone(), local.time.as_str()), (vec![2], "11:00"));
    assert_eq!(e.mock.v2_rule_of(1, &date).local_time.as_deref(), Some("11:00"));
}

#[tokio::test]
async fn first_link_keeps_local_rule_and_asks_when_server_differs() {
    let e = ready().await;
    // 서버 설정 없음 + 이 PC 설정 있음 → base 0 으로 올린다
    let a = shift(&today(), 20);
    add(&e.storage, day(&a), "main", "x");
    e.storage.with_conn(|c| reminders::set(c, &a, &[7], "09:00", reminders::local_now())).unwrap();
    e.link(day(&a));
    e.settle().await;
    assert_eq!(e.mock.v2_rule_of(1, &a).days_before, vec![7]);
    // 서버(Web) 설정 + 다른 이 PC 설정 → 둘 다 보관하고 묻는다(이 PC 예약 유지)
    let b = shift(&today(), 21);
    add(&e.storage, day(&b), "main", "y");
    e.storage.with_conn(|c| reminders::set(c, &b, &[2], "07:00", reminders::local_now())).unwrap();
    e.mock.web_create(1, &Unit::day(&b), "main", "web");
    e.mock.web_v2_set_rule(1, &b, &[7], "09:00").unwrap();
    e.link(day(&b));
    e.settle().await;
    let view = e.storage.with_conn(|c| management::day_view(c, &b)).unwrap();
    assert!(view.reminder_conflict.as_ref().is_some_and(|c| c.initial));
    let local = e.storage.with_conn(|c| reminders::get(c, &b)).unwrap().unwrap();
    assert_eq!(local.offsets, vec![2], "이 PC 설정을 버리지 않는다");
    assert_eq!(e.mock.v2_rule_of(1, &b).days_before, vec![7], "서버 설정을 덮지 않는다");
}

#[tokio::test]
async fn copy_before_first_state_still_compares_legacy_local_rule() {
    // 연결된 날짜에 상태를 받기 전에 복사부터 했다(shared_days 행이 먼저 생김) — 그래도 이 PC 의 기존 알림 설정을 버리지 않는다.
    let e = ready().await;
    let (source, target) = days();
    add(&e.storage, day(&source), "main", "원본");
    add(&e.storage, day(&target), "main", "대상");
    e.storage.with_conn(|c| reminders::set(c, &target, &[2], "07:00", reminders::local_now())).unwrap();
    e.mock.web_create(1, &Unit::day(&target), "main", "web");
    e.mock.web_v2_set_rule(1, &target, &[7], "09:00").unwrap();
    e.storage
        .with_conn(|c| {
            let account = e.account();
            management::set_active_account(c, Some(&account))?;
            management::set_capability(c, &account, true)?;
            // 복사 명령 결과로 행이 먼저 생긴 상황
            c.execute(
                "INSERT INTO shared_days (account_key, memo_date, state_stale, updated_at) VALUES (?1, ?2, 1, 'x')",
                rusqlite::params![account, target],
            )?;
            Ok(())
        })
        .unwrap();
    e.link(day(&target));
    e.settle().await;
    let view = e.storage.with_conn(|c| management::day_view(c, &target)).unwrap();
    assert!(view.reminder_conflict.is_some_and(|c| c.initial), "첫 상태 — 두 설정을 보관하고 묻는다");
    assert_eq!(e.storage.with_conn(|c| reminders::get(c, &target)).unwrap().unwrap().offsets, vec![2], "이 PC 설정 유지");
}

#[tokio::test]
async fn conflict_with_identical_settings_is_not_asked() {
    let e = ready().await;
    let date = linked_future_day(&e, 20).await;
    e.mock.set_online(false);
    set_reminder(&e, &date, &[7], "09:00");
    e.mock.web_v2_set_rule(1, &date, &[7], "09:00").unwrap(); // 다른 곳에서 똑같이 저장
    e.mock.set_online(true);
    e.settle().await;
    assert!(e.storage.with_conn(|c| management::day_view(c, &date)).unwrap().reminder_conflict.is_none(), "같은 설정이면 묻지 않는다");
    assert_eq!(e.mock.v2_rule_of(1, &date).version, 1);
}

// ── 알림 발생 · 확인 ─────────────────────────────────────────────────────

/// 공통 알림을 하나 맞춰 두고 (날짜, 1주 전 알림 시각(로컬)) 를 돌려준다. 서버 시각은 1주 전 알림 직후로.
async fn shared_reminder(e: &Env) -> (String, chrono::NaiveDateTime) {
    let date = linked_future_day(e, 20).await;
    set_reminder(e, &date, &[7, 2], "09:00");
    e.settle().await;
    let fire = e
        .storage
        .with_conn(|c| reminders::get(c, &date))
        .unwrap()
        .unwrap()
        .fires
        .iter()
        .find(|f| f.offset_days == 7)
        .unwrap()
        .fire_at
        .clone();
    let fire = chrono::NaiveDateTime::parse_from_str(&fire, "%Y-%m-%dT%H:%M").unwrap();
    let utc = fire.and_local_timezone(chrono::Local).unwrap().with_timezone(&chrono::Utc);
    e.mock.set_v2_clock(Some(utc + Duration::minutes(1)));
    (date, fire)
}

#[tokio::test]
async fn desktop_ack_via_toast_token_is_shared_and_per_occurrence() {
    let e = ready().await;
    let (date, fire) = shared_reminder(&e).await;
    let due = e.storage.with_conn(|c| reminders::claim_due_with_tokens(c, fire + Duration::minutes(1), 0)).unwrap();
    assert_eq!(due.len(), 1);
    let token = due[0].1.clone().expect("연결된 날짜 알림은 확인 token 을 갖는다");
    // 알림 클릭 = 명시적 확인. 같은 알림을 두 번 눌러도 확인은 한 번.
    let opened = e.storage.with_conn(|c| management::confirm_token(c, &token)).unwrap();
    assert_eq!(opened.as_deref(), Some(date.as_str()));
    e.storage.with_conn(|c| management::confirm_token(c, &token)).unwrap();
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM management_outbox WHERE kind = 'ack'"), 1);
    e.settle().await;
    assert_eq!(e.mock.v2_occurrence(1, &date, 7).unwrap().state, "acknowledged", "Web 에서도 확인 완료");
    assert_ne!(e.mock.v2_occurrence(1, &date, 2).unwrap().state, "acknowledged", "1주 전 확인이 2일 전을 확인하지 않는다");
    let fires = e.storage.with_conn(|c| reminders::get(c, &date)).unwrap().unwrap().fires;
    assert!(fires.iter().find(|f| f.offset_days == 7).unwrap().acknowledged);
    assert!(!fires.iter().find(|f| f.offset_days == 2).unwrap().acknowledged);
    // 모르는·변조된 token 은 아무것도 바꾸지 않는다
    assert!(e.storage.with_conn(|c| management::confirm_token(c, &"0".repeat(32))).unwrap().is_none());
    assert!(e.storage.with_conn(|c| management::confirm_token(c, "../../etc")).unwrap().is_none());
}

#[tokio::test]
async fn web_ack_suppresses_desktop_toast_and_opening_day_is_not_ack() {
    let e = ready().await;
    let (date, fire) = shared_reminder(&e).await;
    e.mock.web_v2_ack(1, &date, 7).unwrap();
    e.settle().await;
    assert!(e.storage.with_conn(|c| reminders::get(c, &date)).unwrap().unwrap().fires.iter().any(|f| f.offset_days == 7 && f.acknowledged));
    let due = e.storage.with_conn(|c| reminders::claim_due_with_tokens(c, fire + Duration::minutes(1), 0)).unwrap();
    assert!(due.is_empty(), "Web 에서 이미 확인한 알림은 다시 띄우지 않는다");
    // 날짜를 열기만 한 것(메모 조회)은 확인이 아니다 — ACK 명령이 생기지 않는다
    e.storage.with_conn(|c| service::get_day(c, &date)).unwrap();
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM management_outbox WHERE kind = 'ack'"), 0);
}

#[tokio::test]
async fn offline_ack_is_kept_and_sent_after_reconnect_safely() {
    let e = ready().await;
    let (date, _) = shared_reminder(&e).await;
    e.mock.set_online(false);
    // 놓친 알림 안내에서 그 날짜를 열었다(명시적 확인) — 시각이 지난 발생만
    let n = e.storage.with_conn(|c| management::confirm_date(c, &date, e_now(&e))).unwrap();
    assert_eq!(n, 1, "1주 전만 시각이 지났다");
    e.sync().await;
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM management_outbox WHERE kind = 'ack' AND status = 'pending'"), 1);
    // 재연결 — 응답을 한 번 잃어도 같은 요청으로 다시 보내 한 번만
    e.mock.set_online(true);
    e.mock.drop_next_v2_responses(1);
    e.settle().await;
    let occ = e.mock.v2_occurrence(1, &date, 7).unwrap();
    assert_eq!(occ.state, "acknowledged");
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM management_outbox WHERE kind = 'ack' AND status = 'done'"), 1);
    // 같은 날짜를 다시 확인해도 ACK 를 또 쌓지 않는다
    assert_eq!(e.storage.with_conn(|c| management::confirm_date(c, &date, e_now(&e))).unwrap(), 0);
}

fn e_now(e: &Env) -> chrono::DateTime<chrono::Utc> {
    e.mock
        .snapshot_state()
        .mgmt
        .clock
        .as_deref()
        .map(|c| chrono::DateTime::parse_from_rfc3339(c).unwrap().with_timezone(&chrono::Utc))
        .unwrap()
}

#[tokio::test]
async fn early_ack_is_rejected_and_rolled_back() {
    let e = ready().await;
    let (date, _) = shared_reminder(&e).await;
    // 2일 전 발생은 아직 시각 전 — 강제로 확인을 쌓아도 서버가 409 occurrence_not_due → 이 PC 확인 표시도 되돌린다
    e.storage
        .with_conn(|c| {
            let account = management::active_account(c)?.unwrap();
            let id: String =
                c.query_row("SELECT occurrence_id FROM shared_occurrences WHERE memo_date = ?1 AND offset_days = 2", [&date], |r| {
                    r.get(0)
                })?;
            c.execute("UPDATE shared_occurrences SET local_ack_at = 'x' WHERE occurrence_id = ?1", [&id])?;
            c.execute(
                "INSERT INTO management_outbox (account_key, memo_date, kind, request_id, payload_json, created_at, updated_at)
                 VALUES (?1, ?2, 'ack', 'early-ack-0001', ?3, 'now', 'now')",
                rusqlite::params![account, date, serde_json::json!({"occurrenceId": id, "offsetDays": 2}).to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    e.settle().await;
    assert_eq!(e.mock.v2_occurrence(1, &date, 2).unwrap().state, "scheduled");
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM shared_occurrences WHERE offset_days = 2 AND local_ack_at IS NOT NULL"), 0);
}

// ── 계정 · 서버 지원 · 연결 해제 ──────────────────────────────────────────

#[tokio::test]
async fn other_account_cannot_see_or_use_shared_state() {
    let e = ready().await;
    let (date, fire) = shared_reminder(&e).await;
    let (_, target) = linked_pair(&e, &["A 계정 할 일"]).await;
    // 계정 B 로 다시 로그인(같은 PC)
    e.login(2).await;
    e.sync().await;
    assert_eq!(e.scope(&date), DayScope::OtherAccount);
    assert!(
        e.storage.with_conn(|c| reminders::claim_due_with_tokens(c, fire + Duration::minutes(1), 0)).unwrap().is_empty(),
        "A 의 공통 알림을 B 로 띄우지 않는다"
    );
    assert!(e
        .storage
        .with_conn(|c| reminders::get(c, &date))
        .unwrap()
        .unwrap()
        .fires
        .iter()
        .all(|f| !f.acknowledged && f.shared_state.is_none()));
    let info = e.carry(&target);
    assert!(info.blocked.is_some() && !info.auto_prompt);
    assert!(e.storage.with_conn(|c| carryover::import(c, &e.storage.paths, &target, &[], &today())).is_err());
    assert!(e.storage.with_conn(|c| management::reviews_for(c, &target)).unwrap().is_empty());
}

#[tokio::test]
async fn server_without_v2_keeps_v1_and_blocks_shared_editing() {
    let mock = Arc::new(MockSyncTransport::new()); // v2 꺼짐(서버 기본값)
    let e = env_with(mock.clone());
    e.login(1).await;
    let date = linked_future_day(&e, 20).await;
    let report = e.sync().await;
    assert!(!report.unavailable, "v2 미지원은 v1 동기화 중단 사유가 아니다");
    assert_eq!(e.mock.unit_texts(1, &Unit::day(&date)), vec!["그날 할 일"], "v1 본문 Sync 정상");
    assert_eq!(e.scope(&date), DayScope::Unavailable);
    assert!(e.scope(&date).blocked_reason().is_some());
    let (_, target) = linked_pair(&e, &["x"]).await;
    let err = e.storage.with_conn(|c| carryover::import(c, &e.storage.paths, &target, &[], &today())).unwrap_err();
    assert_eq!(err.code(), "carry_unavailable");
    assert!(e.mock.snapshot_state().mgmt.requests.is_empty());
}

#[tokio::test]
async fn server_enabling_v2_later_is_picked_up_by_manual_sync_only() {
    let mock = Arc::new(MockSyncTransport::new());
    let e = env_with(mock.clone());
    e.login(1).await;
    let date = linked_future_day(&e, 20).await;
    assert_eq!(e.scope(&date), DayScope::Unavailable);
    mock.set_v2_enabled(true);
    // 자동 Sync(30초 주기, force=false)는 '미지원' 캐시를 10분 동안 그대로 쓴다(서버에 확인 요청을 남발하지 않는다)
    e.engine.run_once(&e.storage, false).await.unwrap();
    assert_eq!(e.scope(&date), DayScope::Unavailable);
    // 사용자가 [지금 동기화] → 바로 다시 확인
    e.sync().await;
    assert!(e.scope(&date).is_shared());
}

#[tokio::test]
async fn unlink_drops_pending_management_commands_but_keeps_local_copies() {
    let e = ready().await;
    let (_, target) = linked_pair(&e, &["연결 해제 전 복사"]).await;
    e.mock.set_online(false);
    let ids: Vec<String> = e.carry(&target).items.iter().map(|i| i.id.clone()).collect();
    e.import(&target, &ids);
    e.unlink(day(&target));
    assert_eq!(e.ops("pending"), 0);
    assert_eq!(e.ops("dropped"), 1);
    e.mock.set_online(true);
    e.settle().await;
    assert!(e.mock.v2_copies(1).is_empty(), "끝난 연결로 보내지 않는다");
    assert!(e.local_texts(&target).contains(&"연결 해제 전 복사".to_string()), "이 PC 의 복사본은 그대로");
}

#[tokio::test]
async fn revoked_credential_stops_v2_without_losing_work() {
    let e = ready().await;
    let date = linked_future_day(&e, 20).await;
    e.mock.web_revoke_device(&e.auth.session_context().unwrap().server_device_id);
    set_reminder(&e, &date, &[7], "09:00");
    let report = e.sync().await;
    assert!(report.auth_required);
    assert!(e.storage.with_conn(|c| reminders::get(c, &date)).unwrap().is_some(), "이 PC 예약은 유지");
    assert_eq!(e.ops("pending"), 1, "보내지 못한 설정은 보관");
}

#[tokio::test]
async fn transport_errors_are_classified() {
    let e = ready().await;
    let date = linked_future_day(&e, 20).await;
    set_reminder(&e, &date, &[7], "09:00");
    e.mock.inject("v2_put_rule", TransportError::Server("HTTP 500".into()));
    e.sync().await;
    assert_eq!(e.ops("pending"), 1, "서버 일시 오류 — 같은 요청으로 다시");
    e.settle().await;
    assert_eq!(e.ops("pending"), 0);
    assert_eq!(e.mock.v2_rule_of(1, &date).version, 1, "재시도해도 한 번만 저장");
}

// ── Migration ───────────────────────────────────────────────────────────

#[test]
fn v3_database_upgrades_to_v4_with_backup_and_keeps_day_tools() {
    let dir = tempfile::tempdir().unwrap();
    let paths = StoragePaths::new(dir.path().join("PLAN-A Memo"));
    paths.ensure_dirs().unwrap();
    {
        let conn = plan_a_memo_lib::storage::open_connection(&paths.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
        )
        .unwrap();
        for m in migrations::MIGRATIONS.iter().filter(|m| m.version <= 3) {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations VALUES (?1, ?2, 'x', '2026-10-01T00:00:00.000Z')",
                rusqlite::params![m.version, m.name],
            )
            .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO documents (id, kind, memo_date, created_at, updated_at) VALUES ('d1', 'DAY', '2026-10-10', 'x', 'x');
             INSERT INTO memo_items (id, document_id, section, content_html, created_at, updated_at) VALUES ('i1', 'd1', 'main', '기존 메모', 'x', 'x');
             INSERT INTO item_copies VALUES ('s1', '2026-10-03', '2026-10-10', 'i1', 'x');
             INSERT INTO carryover_prompts VALUES ('2026-10-10', '2026-10-03', 'imported', 'x', 'x');
             INSERT INTO day_reminders (memo_date, offset_days, remind_time, fire_at, status, created_at, updated_at)
                  VALUES ('2026-10-24', 7, '09:00', '2026-10-17T09:00', 'pending', 'x', 'x');",
        )
        .unwrap();
    }
    let (storage, report) = Storage::open(paths.root.as_path(), false).unwrap();
    assert_eq!(report.applied_migrations, vec![4]);
    assert!(report.backup_before_migration.is_some(), "적용 전 Backup");
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM memo_items"), 1);
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM item_copies"), 1);
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM carryover_prompts"), 1);
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM day_reminders"), 1);
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM management_outbox"), 0);
    drop(storage);
    // 다시 열어도 같은 migration 을 또 적용하지 않는다
    let (_, again) = Storage::open(paths.root.as_path(), false).unwrap();
    assert!(again.applied_migrations.is_empty());
}
