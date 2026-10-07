//! Sync 시나리오 — **MockSyncTransport(가짜 서버)** 로 검증한 결과다. 실제 PLAN-A Work 서버 검증이 아니다.
//! Mock 은 memo-sync-v1 Contract 규칙(version·link generation·request_id·client_key·conflict 출처·ACK manifest)을 따른다.

mod common;

use std::sync::Arc;

use common::*;
use plan_a_memo_lib::attachments;
use plan_a_memo_lib::auth::{loopback, AuthProvider, AuthSession, DesktopAuth, MemoryCredentialStore};
use plan_a_memo_lib::config::AppEnv;
use plan_a_memo_lib::memo::service::{self, MoveItem, MovePolicy};
use plan_a_memo_lib::memo::{history, repo, Location};
use plan_a_memo_lib::storage::Storage;
use plan_a_memo_lib::sync::contract::{PushRequest, Side};
use plan_a_memo_lib::sync::engine::{self, list_conflicts, ConflictChoice, SyncEngine, SyncReport, NOTICE_MOVED, NOTICE_OTHER_ACCOUNT};
use plan_a_memo_lib::sync::link;
use plan_a_memo_lib::sync::mock::{MockSyncTransport, Unit};
use plan_a_memo_lib::sync::transport::{SyncContext, SyncTransport, TransportError};

const REDIRECT_BASE: &str = "http://127.0.0.1:54321";

struct Env {
    _dir: tempfile::TempDir,
    storage: Storage,
    mock: Arc<MockSyncTransport>,
    auth: Arc<DesktopAuth>,
    engine: SyncEngine,
}

fn env() -> Env {
    let (dir, storage) = temp_storage();
    let mock = Arc::new(MockSyncTransport::new());
    let auth = Arc::new(
        DesktopAuth::new(AppEnv::Development, mock.clone(), Arc::new(MemoryCredentialStore::default()), true).with_device_name("Test PC"),
    );
    let engine = SyncEngine::new(mock.clone(), auth.clone());
    Env { _dir: dir, storage, mock, auth, engine }
}

async fn env_logged_in() -> Env {
    let e = env();
    e.login(1, false).await;
    e
}

impl Env {
    /// 브라우저 동의(Mock) → callback 주소 → state 확인 → code+verifier 교환.
    async fn login(&self, owner: i64, reconnect: bool) -> AuthSession {
        let start = self.auth.begin_login(&format!("{REDIRECT_BASE}/memo-sync/callback"), reconnect).await.unwrap();
        let callback = self.mock.approve_login(&start.authorization_id, owner).unwrap();
        let params = loopback::parse_target(&callback[REDIRECT_BASE.len()..]).unwrap();
        self.auth.complete_login(params).await.unwrap()
    }
    fn account(&self) -> String {
        self.auth.session_context().unwrap().account_key
    }
    fn device(&self) -> String {
        self.auth.session_context().unwrap().server_device_id
    }
    async fn sync(&self) -> SyncReport {
        self.engine.run_once(&self.storage, true).await.unwrap()
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
    fn link_id(&self, location: &Location) -> String {
        self.storage
            .with_conn(|c| {
                let doc = repo::doc_for_location(c, location)?.unwrap();
                Ok(link::link_row(c, &doc.id)?.unwrap().link_id.unwrap())
            })
            .unwrap()
    }
    fn status(&self, location: &Location) -> String {
        self.storage.with_conn(|c| Ok(repo::doc_for_location(c, location)?.unwrap().sync_status)).unwrap()
    }
    fn error(&self, location: &Location) -> Option<String> {
        self.storage.with_conn(|c| Ok(repo::doc_for_location(c, location)?.unwrap().sync_error)).unwrap()
    }
    fn server(&self, unit: &Unit) -> Vec<String> {
        self.mock.unit_texts(1, unit)
    }
    fn outbox(&self) -> i64 {
        count(&self.storage, "SELECT COUNT(*) FROM sync_outbox")
    }
    async fn resolve(&self, choice: ConflictChoice) -> Result<Location, plan_a_memo_lib::error::AppError> {
        let conflict = self.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
        self.engine.resolve_conflict(&self.storage, &conflict.id, choice).await
    }
    fn ctx(&self) -> SyncContext {
        let s = self.auth.session_context().unwrap();
        SyncContext { access_token: s.access_token, account_key: s.account_key, server_device_id: s.server_device_id }
    }
}

fn d7() -> Unit {
    Unit::day("2026-10-07")
}

#[tokio::test]
async fn local_only_documents_are_never_sent() {
    // 로그인 전: 서버에 요청 자체가 없다
    let e = env();
    add(&e.storage, day("2026-10-07"), "main", "이 PC 에만");
    add(&e.storage, next(None), "next", "Next 도 이 PC 에만");
    let report = e.sync().await;
    assert_eq!(report.pushed, 0);
    assert_eq!(e.mock.request_count(), 0, "로그인 전·연결 전에는 서버에 요청조차 하지 않는다");
    // 로그인 후: Web 이 연결한 문서를 알기 위해 변경 목록만 본다 — 메모는 하나도 올리지 않는다
    e.login(1, false).await;
    let report = e.sync().await;
    assert_eq!(report.pushed, 0);
    let state = e.mock.snapshot_state();
    assert!(state.documents.is_empty(), "연결하지 않은 문서는 서버 문서도 만들지 않는다");
    assert!(state.memos.is_empty(), "로그인만으로 메모를 올리지 않는다");
    assert_eq!(e.outbox(), 0);
}

#[tokio::test]
async fn day_memo_link_pushes_whole_day_and_later_edits() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "AWS 확인");
    add(&e.storage, day("2026-10-07"), "am", "회의 준비");
    add(&e.storage, day("2026-10-07"), "pm", "보고서");
    add(&e.storage, day("2026-10-08"), "main", "다른 날(연결 안 함)");
    e.link(day("2026-10-07"));
    assert_eq!(e.status(&day("2026-10-07")), "pending");
    let report = e.sync().await;
    assert_eq!(report.pushed, 1);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    // DAY = main + 오전 + 오후 전체가 문서 하나
    let items = e.mock.unit_items(1, &d7());
    let sections: Vec<&str> = items.iter().map(|(_, m)| m.section.as_str()).collect();
    assert_eq!(sections, vec!["am", "main", "pm"]);
    assert_eq!(e.mock.snapshot_state().documents.len(), 1, "연결한 날짜만");
    assert!(e.mock.unit_items(1, &Unit::day("2026-10-08")).is_empty());
    assert_eq!(e.mock.link_status(&e.link_id(&day("2026-10-07"))).as_deref(), Some("synced"), "ACK 까지 끝났다");
    // 연결 후 편집은 자동으로(문서당 Outbox 1건)
    e.storage.with_conn(|c| service::set_completed(c, &a.id, true)).unwrap();
    e.storage.with_conn(|c| service::update_content(c, &a.id, "AWS <b>비용</b> 확인")).unwrap();
    assert_eq!(e.outbox(), 1);
    e.sync().await;
    let doc = e.mock.document_of(1, &d7()).unwrap();
    assert_eq!(doc.version, 3, "연결(v1) → 첫 push(v2) → 편집 push(v3)");
    let aws = doc.items.iter().find(|i| i.section == "main").unwrap();
    assert!(aws.completed);
    assert_eq!(aws.content, "AWS <b>비용</b> 확인");
    assert_eq!(doc.items.len(), 3, "같은 항목은 서버 id 로 갱신 — 새로 만들지 않는다");
    assert_eq!(e.outbox(), 0);
}

#[tokio::test]
async fn next_list_link_is_whole_list_with_stable_list_id() {
    let e = env_logged_in().await;
    let list = e.storage.with_conn(|c| service::create_list(c, None, "앱 개발")).unwrap();
    add(&e.storage, next(Some(&list.id)), "next", "음성 메모");
    add(&e.storage, next(Some(&list.id)), "next", "Android 조사");
    add(&e.storage, next(None), "next", "기본 Next(연결 안 함)");
    e.link(next(Some(&list.id)));
    e.sync().await;
    // 서버 List id = 로컬 List UUID(native/lists 로 먼저 만든다), 항목은 section main
    let doc = e.mock.document_of(1, &Unit::list(&list.id)).unwrap();
    assert_eq!(doc.title.as_deref(), Some("앱 개발"));
    assert_eq!(doc.items.iter().map(|i| i.content.as_str()).collect::<Vec<_>>(), vec!["음성 메모", "Android 조사"]);
    assert!(doc.items.iter().all(|i| i.section == "main"));
    assert!(e.mock.document_of(1, &Unit::list("default")).is_none(), "기본 Next 는 연결하지 않았다");
    // 서버에서 받은 항목은 로컬 section 'next' 로
    e.mock.web_create(1, &Unit::list(&list.id), "main", "Web 에서 추가");
    e.sync().await;
    let local = e.storage.with_conn(|c| service::get_list(c, Some(&list.id))).unwrap();
    assert_eq!(local.items.len(), 3);
    assert!(local.items.iter().all(|i| i.section == "next"));
}

#[tokio::test]
async fn server_changes_flow_to_desktop_with_cursor_and_ack() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "Desktop 에서 씀");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "pm", "Web 에서 추가");
    let report = e.sync().await;
    assert_eq!(report.pulled, 1);
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Desktop 에서 씀", "Web 에서 추가"]);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    assert_eq!(e.outbox(), 0, "받은 변경을 다시 서버로 보내지 않는다");
    // ACK: 로컬 반영 후 정확한 최신 version 으로
    assert_eq!(e.mock.link_status(&e.link_id(&day("2026-10-07"))).as_deref(), Some("synced"));
    // cursor 는 계정·기기별 키로 저장(재시작 후에도 이어진다)
    let key = format!("cursor|{}|{}", e.account(), e.device());
    let cursor: String = e.storage.with_conn(|c| Ok(engine::state_get(c, &key)?.unwrap())).unwrap();
    assert!(cursor.contains(':'));
    // 같은 변경을 두 번 적용하지 않는다
    let again = e.sync().await;
    assert_eq!(again.pulled, 0);
    let versions = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(versions.iter().any(|v| v.reason == "remote_apply"), "서버 변경 반영 전 상태도 History 에");
}

#[tokio::test]
async fn offline_queue_survives_restart_and_retries() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "처음");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.set_online(false);
    e.storage.with_conn(|c| service::update_content(c, &a.id, "오프라인에서 수정")).unwrap();
    let report = e.sync().await;
    assert!(report.offline);
    assert_eq!(e.status(&day("2026-10-07")), "pending", "전달 대기");
    assert_eq!(e.outbox(), 1);
    // 앱 강제 종료 후 재실행
    let root = e.storage.paths.root.clone();
    std::mem::forget(e.storage);
    let (storage, _) = Storage::open(&root, false).unwrap();
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM sync_outbox"), 1, "Outbox 는 재실행 후에도 남는다");
    e.mock.set_online(true);
    let report = e.engine.run_once(&storage, true).await.unwrap();
    assert_eq!(report.pushed, 1);
    assert_eq!(e.mock.unit_texts(1, &d7()), vec!["오프라인에서 수정"]);
}

#[tokio::test]
async fn lost_push_response_is_retried_with_the_same_request_without_duplicates() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "한 번");
    e.link(day("2026-10-07"));
    e.sync().await;
    let before = e.mock.document_of(1, &d7()).unwrap().version;
    e.storage.with_conn(|c| service::update_content(c, &a.id, "두 번 보내도 한 번")).unwrap();
    add(&e.storage, day("2026-10-07"), "main", "새 항목");
    // 서버는 저장했는데 응답이 끊겼다
    e.mock.drop_next_push_responses(1);
    let report = e.sync().await;
    assert!(report.offline);
    assert_eq!(e.mock.document_of(1, &d7()).unwrap().version, before + 1, "서버에는 이미 저장됨");
    let inflight: String = e.storage.with_conn(|c| Ok(c.query_row("SELECT payload FROM sync_outbox", [], |r| r.get(0))?)).unwrap();
    assert!(inflight.contains("requestId") || inflight.contains("request_id"), "보낸 요청을 그대로 보관");
    // 같은 request_id·같은 본문으로 다시 → 서버는 처음 결과를 돌려준다(version·항목 중복 없음)
    e.sync().await;
    let doc = e.mock.document_of(1, &d7()).unwrap();
    assert_eq!(doc.version, before + 1);
    assert_eq!(doc.items.len(), 2, "새 항목이 두 번 생기지 않는다");
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    assert_eq!(e.outbox(), 0);
    // 같은 request_id 로 다른 내용을 보내면 서버가 409(request_id_reused)
    let body: serde_json::Value = serde_json::from_str(&inflight).unwrap();
    let mut push: PushRequest = serde_json::from_value(body["inflight"]["body"].clone()).unwrap();
    push.local_version += 100;
    let err = e.mock.push(&e.ctx(), &doc.id, &push).await.unwrap_err();
    assert!(err.is_conflict("request_id_reused"));
}

#[tokio::test]
async fn conflict_is_detected_and_resolved_with_desktop_keeping_web_in_history() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web 수정");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop 수정")).unwrap();
    let report = e.sync().await;
    assert_eq!(report.conflicts, 1);
    assert_eq!(e.status(&day("2026-10-07")), "conflict");
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Desktop 수정"], "자동으로 덮어쓰지 않는다");
    assert_eq!(e.server(&d7()), vec!["원래", "Web 수정"], "서버도 덮어쓰지 않는다(제안으로 보관)");
    // 고르기 전에는 계속 보내지 않는다
    e.sync().await;
    assert_eq!(e.server(&d7()), vec!["원래", "Web 수정"]);
    let conflict = e.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
    assert_eq!(conflict.source.as_deref(), Some("desktop"));
    assert_eq!(conflict.local.items[0].content_html, "Desktop 수정");
    assert_eq!(conflict.remote.items.len(), 2);
    e.resolve(ConflictChoice::Local).await.unwrap();
    assert_eq!(e.server(&d7()), vec!["Desktop 수정"]);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    let versions = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    let kept = versions.iter().find(|v| v.reason == "conflict_remote").expect("선택하지 않은 Web 내용은 History 에");
    assert!(kept.preview.contains("Web 수정"));
}

#[tokio::test]
async fn conflict_resolved_with_web_keeps_desktop_in_history() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web 수정");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop 수정")).unwrap();
    e.sync().await;
    e.resolve(ConflictChoice::Remote).await.unwrap();
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["원래", "Web 수정"]);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    assert_eq!(e.outbox(), 0);
    let versions = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(versions.iter().any(|v| v.reason == "conflict_local" && v.preview.contains("Desktop 수정")));
    // 이후 편집은 정상 전송
    add(&e.storage, day("2026-10-07"), "pm", "해결 후 편집");
    e.sync().await;
    assert_eq!(e.server(&d7()).len(), 3);
}

#[tokio::test]
async fn resolve_is_rejected_when_web_changed_again_and_comparison_refreshes() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web 1");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop 1")).unwrap();
    e.sync().await;
    // 충돌 중 양쪽 모두 더 바뀜 → 비교 화면은 양쪽 최신
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop 2")).unwrap();
    e.mock.web_create(1, &d7(), "main", "Web 2");
    e.sync().await;
    let conflicts = e.storage.with_conn(|c| list_conflicts(c)).unwrap();
    assert_eq!(conflicts.len(), 1, "같은 문서의 충돌은 하나");
    assert_eq!(conflicts[0].local.items[0].content_html, "Desktop 2");
    assert_eq!(conflicts[0].remote.items.len(), 3);
    // 비교 화면을 연 뒤 Web 이 또 바뀜(아직 Sync 전) → 선택은 거절되고 비교가 최신으로
    e.mock.web_create(1, &d7(), "main", "Web 3");
    let err = e.resolve(ConflictChoice::Local).await.unwrap_err();
    assert_eq!(err.code(), "conflict_stale");
    let refreshed = e.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
    assert_eq!(refreshed.remote.items.len(), 4, "새 Web 변경이 비교 화면에 들어왔다");
    assert_eq!(e.server(&d7()), vec!["원래", "Web 1", "Web 2", "Web 3"], "오래된 선택으로 덮어쓰지 않았다");
    // 다시 고르면 — Desktop 의 최신(Desktop 2)까지 올라간다
    e.resolve(ConflictChoice::Local).await.unwrap();
    assert_eq!(e.server(&d7()), vec!["Desktop 2"]);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
}

#[tokio::test]
async fn delete_vs_edit_becomes_conflict_and_web_choice_restores_item() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "지울까 고칠까");
    e.link(day("2026-10-07"));
    e.sync().await;
    let memo = e.mock.unit_items(1, &d7())[0].0;
    e.storage.with_conn(|c| service::delete_item(c, &a.id)).unwrap();
    e.mock.web_edit(memo, |m| m.content = "Web 에서 고침".into());
    let report = e.sync().await;
    assert_eq!(report.conflicts, 1);
    let conflict = e.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
    assert!(conflict.local.items.is_empty());
    e.resolve(ConflictChoice::Remote).await.unwrap();
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Web 에서 고침"]);
}

#[tokio::test]
async fn web_stale_editor_conflict_shows_web_proposal() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    let (memo, m) = e.mock.unit_items(1, &d7()).remove(0);
    let stale_version = m.version;
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop 수정")).unwrap();
    e.sync().await;
    // 오래 열어 둔 Web 편집기가 늦게 저장 → 서버가 Web 출처 제안으로 보존
    e.mock.web_stale_edit(memo, stale_version, "Web 늦은 저장").expect("web conflict");
    e.sync().await;
    let conflict = e.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
    assert_eq!(conflict.source.as_deref(), Some("web"));
    assert_eq!(conflict.remote.items[0].content_html, "Web 늦은 저장", "PLAN-A Work 쪽 = Web 제안");
    assert_eq!(conflict.local.items[0].content_html, "Desktop 수정");
    e.resolve(ConflictChoice::Remote).await.unwrap();
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Web 늦은 저장"]);
    assert_eq!(e.server(&d7()), vec!["Web 늦은 저장"]);
}

#[tokio::test]
async fn conflict_resolved_elsewhere_closes_local_comparison() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop")).unwrap();
    e.sync().await;
    let server_doc = e.mock.document_of(1, &d7()).unwrap().id;
    let (cid, _) = e.mock.open_conflicts(&server_doc).remove(0);
    e.mock.web_resolve(&cid, Side::Web).unwrap();
    e.sync().await;
    assert!(e.storage.with_conn(|c| list_conflicts(c)).unwrap().is_empty());
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["원래", "Web"]);
    let versions = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(versions.iter().any(|v| v.reason == "conflict_local" && v.preview.contains("Desktop")), "이 PC 내용은 History 에");
}

#[tokio::test]
async fn unlink_stops_sync_but_keeps_both_copies() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "연결했다 해제");
    e.link(day("2026-10-07"));
    e.sync().await;
    let link_id = e.link_id(&day("2026-10-07"));
    e.unlink(day("2026-10-07"));
    assert_eq!(e.status(&day("2026-10-07")), "local_only");
    add(&e.storage, day("2026-10-07"), "main", "해제 후 편집");
    e.sync().await;
    assert!(!e.mock.snapshot_state().links[&link_id].active, "서버 link 도 비활성(DELETE native/links)");
    assert_eq!(e.server(&d7()).len(), 1, "해제 후 편집은 보내지 않는다");
    assert_eq!(texts(&e.storage, "2026-10-07").len(), 2, "로컬 메모는 그대로");
    assert_eq!(e.outbox(), 0);
    e.mock.web_create(1, &d7(), "main", "Web");
    e.sync().await;
    assert_eq!(texts(&e.storage, "2026-10-07").len(), 2, "서버 변경도 받지 않는다");
}

#[tokio::test]
async fn web_unlink_and_device_revoke_keep_local_copy() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "남아야 할 메모");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_unlink(&e.link_id(&day("2026-10-07")));
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n.contains("연결이 해제")));
    assert_eq!(e.status(&day("2026-10-07")), "local_only");
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["남아야 할 메모"]);
    // Web 기기 관리에서 이 PC 해제 → 401 → 다시 로그인 필요(메모는 그대로)
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_revoke_device(&e.device());
    let report = e.sync().await;
    assert!(report.auth_required);
    assert!(e.auth.status().expired);
    assert_eq!(e.status(&day("2026-10-07")), "auth_required");
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["남아야 할 메모"]);
}

#[tokio::test]
async fn attachments_upload_with_retry_and_download_from_server() {
    let e = env_logged_in().await;
    let item = add(&e.storage, day("2026-10-07"), "main", "이미지");
    let info = e.storage.with_conn(|c| attachments::import_bytes(c, &e.storage.paths, PNG, None, Some(&item.id))).unwrap();
    e.storage.with_conn(|c| service::update_content(c, &item.id, &format!("이미지<img src=\"{}\">", info.url))).unwrap();
    e.link(day("2026-10-07"));
    e.mock.fail_next_uploads(1);
    let report = e.sync().await;
    assert_eq!(report.failed, 1);
    assert_eq!(e.outbox(), 1, "첨부 업로드 실패 → Outbox 에 남아 재시도");
    assert_eq!(count(&e.storage, "SELECT attempts FROM sync_outbox"), 1);
    let skipped = e.engine.run_once(&e.storage, false).await.unwrap();
    assert_eq!(skipped.pushed, 0, "대기 시간 전 자동 실행은 건너뛴다");
    let report = e.sync().await;
    assert_eq!(report.pushed, 1);
    let html = e.server(&d7()).remove(0);
    let name = e.mock.snapshot_state().images.keys().next().cloned().unwrap();
    assert_eq!(html, format!("이미지<img src=\"/api/personal-memos/images/{name}/download\">"), "서버 이미지 주소 규칙");
    assert!(!html.contains("attachment://"), "로컬 참조를 서버로 보내지 않는다");
    assert_eq!(e.mock.snapshot_state().images.len(), 1);
    assert_eq!(e.mock.link_status(&e.link_id(&day("2026-10-07"))).as_deref(), Some("synced"), "이미지 manifest 까지 ACK");
    // Web 이 같은 이미지 + Web 에서 붙인 새 이미지를 쓰면 — 있는 것은 같은 로컬 id, 새 것은 내려받는다
    let mut web_png = PNG.to_vec();
    web_png.extend_from_slice(b"web");
    let web_name = e.mock.web_upload_image(1, &web_png);
    let memo = e.mock.unit_items(1, &d7())[0].0;
    e.mock.web_edit(memo, |m| {
        m.content = format!(
            "Web 이 바꿈<img src=\"/api/personal-memos/images/{name}/download\"><img src=\"/api/personal-memos/images/{web_name}/download\">"
        )
    });
    e.sync().await;
    let local_html = texts(&e.storage, "2026-10-07").remove(0);
    assert!(local_html.starts_with(&format!("Web 이 바꿈<img src=\"{}\">", info.url)), "이미 있는 첨부는 같은 로컬 id 로");
    assert!(!local_html.contains("/api/personal-memos"), "서버 주소를 로컬 본문에 저장하지 않는다");
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM attachments"), 2);
    let new_id: String =
        e.storage.with_conn(|c| Ok(c.query_row("SELECT id FROM attachments WHERE id <> ?1", [&info.id], |r| r.get(0))?)).unwrap();
    let (bytes, _) = e.storage.with_conn(|c| attachments::read_bytes(c, &e.storage.paths, &new_id)).unwrap();
    assert_eq!(bytes, web_png, "내려받은 바이트(SHA-256 확인)");
    assert_eq!(e.mock.link_status(&e.link_id(&day("2026-10-07"))).as_deref(), Some("synced"));
}

#[tokio::test]
async fn linking_a_day_that_already_exists_on_the_server() {
    // Web 에서 먼저 쓴 날짜 + Desktop 에도 다른 내용 → 덮어쓰지 않고 base 0 으로 보내 서버가 비교를 만든다
    let e = env_logged_in().await;
    e.mock.web_create(1, &d7(), "main", "Web 이 먼저 쓴 메모");
    add(&e.storage, day("2026-10-07"), "main", "Desktop 메모");
    e.link(day("2026-10-07"));
    let report = e.sync().await;
    assert_eq!(report.conflicts, 1);
    assert_eq!(e.status(&day("2026-10-07")), "conflict");
    assert_eq!(e.server(&d7()), vec!["Web 이 먼저 쓴 메모"]);
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Desktop 메모"]);
    // Desktop 이 비어 있으면 서버 내용을 받아 온다
    e.mock.web_create(1, &Unit::day("2026-10-09"), "main", "Web 메모");
    e.link(day("2026-10-09"));
    e.sync().await;
    assert_eq!(texts(&e.storage, "2026-10-09"), vec!["Web 메모"]);
    assert_eq!(e.status(&day("2026-10-09")), "synced");
    // 같은 내용이면 비교 없이 연결
    e.mock.web_create(1, &Unit::day("2026-10-10"), "main", "같은 내용");
    add(&e.storage, day("2026-10-10"), "main", "같은 내용");
    e.link(day("2026-10-10"));
    let report = e.sync().await;
    assert_eq!(report.conflicts, 0);
    assert_eq!(e.status(&day("2026-10-10")), "synced");
    assert_eq!(e.mock.unit_items(1, &Unit::day("2026-10-10")).len(), 1, "중복 생성 없음");
}

#[tokio::test]
async fn web_initiated_link_reaches_desktop() {
    let e = env_logged_in().await;
    e.mock.web_create(1, &Unit::day("2026-10-12"), "am", "Web 에서 쓰고 이 PC 로 연결");
    e.mock.web_link(1, &e.device(), &Unit::day("2026-10-12")).unwrap();
    let list = e.mock.web_create_list(1, "Web List");
    e.mock.web_create(1, &Unit::list(&list), "main", "List 항목");
    e.mock.web_link(1, &e.device(), &Unit::list(&list)).unwrap();
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n.contains("연결한 메모")));
    assert_eq!(texts(&e.storage, "2026-10-12"), vec!["Web 에서 쓰고 이 PC 로 연결"]);
    assert_eq!(e.status(&day("2026-10-12")), "synced");
    let local = e.storage.with_conn(|c| service::get_list(c, Some(&list))).unwrap();
    assert_eq!(local.list.name, "Web List");
    assert_eq!(local.items[0].content_html, "List 항목");
    assert_eq!(e.mock.link_status(&e.link_id(&next(Some(&list)))).as_deref(), Some("synced"));
}

#[tokio::test]
async fn move_to_unlinked_day_never_links_without_consent() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "옮길 메모");
    let b = add(&e.storage, day("2026-10-07"), "main", "또 옮길 메모");
    e.link(day("2026-10-07"));
    e.sync().await;
    // 묻기 전에는 옮기지 않는다
    let ask = e
        .storage
        .with_conn(|c| {
            service::move_item(c, MoveItem { id: a.id.clone(), target: day("2026-10-08"), section: None, index: None, policy: None })
        })
        .unwrap();
    assert_eq!(ask.status, "needs_decision");
    // 'Desktop 에서만 이동' = Web 의 이동과 같은 의미: 원래 날짜에서 빠지고, 대상은 연결하지 않는다
    e.storage
        .with_conn(|c| {
            service::move_item(
                c,
                MoveItem { id: a.id.clone(), target: day("2026-10-08"), section: None, index: None, policy: Some(MovePolicy::LocalOnly) },
            )
        })
        .unwrap();
    e.sync().await;
    assert_eq!(e.server(&d7()), vec!["또 옮길 메모"]);
    assert!(e.mock.document_of(1, &Unit::day("2026-10-08")).is_none(), "대상 날짜는 서버 문서조차 만들지 않는다");
    assert_eq!(e.status(&day("2026-10-08")), "local_only");
    // [10월 9일도 연결하고 이동] — 사용자가 고른 경우에만, 로그인한 계정으로
    let no_login = e.storage.with_conn(|c| {
        service::move_item(
            c,
            MoveItem { id: b.id.clone(), target: day("2026-10-09"), section: None, index: None, policy: Some(MovePolicy::LinkTarget) },
        )
    });
    assert_eq!(no_login.unwrap_err().code(), "auth_required");
    let account = e.account();
    e.storage
        .with_conn(|c| {
            service::move_item_linking(
                c,
                MoveItem { id: b.id.clone(), target: day("2026-10-09"), section: None, index: None, policy: Some(MovePolicy::LinkTarget) },
                Some(&account),
            )
        })
        .unwrap();
    e.sync().await;
    assert!(e.server(&d7()).is_empty());
    assert_eq!(e.server(&Unit::day("2026-10-09")), vec!["또 옮길 메모"]);
}

#[tokio::test]
async fn stale_request_for_an_item_moved_elsewhere_is_explained_not_unknown() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "A");
    add(&e.storage, day("2026-10-08"), "main", "B");
    e.link(day("2026-10-07"));
    e.link(day("2026-10-08"));
    e.sync().await;
    // 이 PC 의 오래된 매핑이 이미 다른 날짜(10/8)의 서버 항목을 가리킨다
    let b_server = e.mock.unit_items(1, &Unit::day("2026-10-08"))[0].0;
    e.storage
        .with_conn(|c| Ok(c.execute("UPDATE sync_item_map SET server_item_id = ?2 WHERE item_id = ?1", rusqlite::params![a.id, b_server])?))
        .unwrap();
    e.storage.with_conn(|c| service::update_content(c, &a.id, "A 수정")).unwrap();
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n == NOTICE_MOVED), "일반 오류가 아니라 '다른 위치에서 이미 변경' 안내");
    e.sync().await;
    assert_eq!(e.server(&d7()), vec!["A 수정"]);
    assert_eq!(e.server(&Unit::day("2026-10-08")), vec!["B"], "다른 날짜의 항목을 가져오지 않았다");
    assert_eq!(e.status(&day("2026-10-07")), "synced");
}

#[tokio::test]
async fn server_rejection_marks_only_that_document() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "<a href=\"https://example.com\">링크</a>");
    add(&e.storage, day("2026-10-08"), "main", "평범한 메모");
    e.link(day("2026-10-07"));
    e.link(day("2026-10-08"));
    let report = e.sync().await;
    assert_eq!(e.status(&day("2026-10-07")), "error");
    assert!(e.error(&day("2026-10-07")).unwrap().contains("PC 경로"), "서버 거절 이유를 알 수 있게");
    assert_eq!(e.status(&day("2026-10-08")), "synced", "다른 문서는 계속 진행");
    assert!(report.failed >= 1);
}

#[tokio::test]
async fn web_deleting_everything_is_applied_with_history() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "Web 이 지울 메모");
    e.link(day("2026-10-07"));
    e.sync().await;
    let ids: Vec<i64> = e.mock.unit_items(1, &d7()).into_iter().map(|(id, _)| id).collect();
    for id in ids {
        e.mock.web_delete(id);
    }
    e.sync().await;
    assert!(texts(&e.storage, "2026-10-07").is_empty());
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    let versions = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(versions.iter().any(|v| v.preview.contains("Web 이 지울 메모")), "History 에서 복원 가능");
}

#[tokio::test]
async fn deleting_a_linked_list_sends_a_tombstone_then_unlinks() {
    let e = env_logged_in().await;
    let list = e.storage.with_conn(|c| service::create_list(c, None, "지울 List")).unwrap();
    add(&e.storage, next(Some(&list.id)), "next", "List 항목");
    e.link(next(Some(&list.id)));
    e.sync().await;
    let link_id = e.link_id(&next(Some(&list.id)));
    e.storage.with_conn(|c| service::delete_list(c, &list.id)).unwrap();
    e.sync().await;
    let doc = e.mock.document_of(1, &Unit::list(&list.id)).unwrap();
    assert!(doc.deleted && doc.items.is_empty(), "서버 문서는 tombstone(History 로 복원 가능)");
    assert!(!e.mock.snapshot_state().links[&link_id].active);
    let default = e.storage.with_conn(|c| service::get_list(c, None)).unwrap();
    assert_eq!(default.items[0].content_html, "List 항목", "로컬 메모는 기본 Next 로 옮겨져 남는다");
}

#[tokio::test]
async fn logged_out_or_expired_means_nothing_is_sent_and_local_data_stays() {
    let e = env();
    add(&e.storage, day("2026-10-07"), "main", "로그인 전");
    let report = e.sync().await;
    assert!(!report.auth_required, "연결한 문서가 없으면 로그인도 묻지 않는다");
    e.login(1, false).await;
    e.link(day("2026-10-07"));
    e.sync().await;
    // credential 만료 → 401 → 멈춤(로컬 그대로)
    e.mock.expire_device(&e.device());
    add(&e.storage, day("2026-10-07"), "main", "만료 중 편집");
    let report = e.sync().await;
    assert!(report.auth_required);
    assert_eq!(e.status(&day("2026-10-07")), "auth_required");
    let requests = e.mock.request_count();
    e.sync().await;
    assert_eq!(e.mock.request_count(), requests, "만료된 credential 로 계속 요청하지 않는다");
    // 같은 기기로 다시 연결 → link·cursor 유지, 이어서 전송
    let device = e.device_after_expiry();
    let session = e.login(1, true).await;
    assert_eq!(session.server_device_id, device, "재인증은 같은 서버 기기");
    e.sync().await;
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    assert_eq!(e.server(&d7()), vec!["로그인 전", "만료 중 편집"]);
    // 로그아웃 → 서버에서 이 기기 폐기, 연결은 '이 PC 에만' 으로, 메모는 그대로
    let result = e.auth.logout().await.unwrap();
    assert!(result.server_revoked);
    e.storage.with_conn(|c| engine::end_account_links(c, result.account_key.as_deref().unwrap())).unwrap();
    assert_eq!(e.status(&day("2026-10-07")), "local_only");
    assert_eq!(texts(&e.storage, "2026-10-07").len(), 2);
    assert!(e.mock.devices().iter().all(|(_, _, revoked)| *revoked));
}

impl Env {
    fn device_after_expiry(&self) -> String {
        self.auth.status().session.unwrap().server_device_id
    }
}

#[tokio::test]
async fn another_account_never_receives_previous_accounts_queue() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "A 계정 메모");
    add(&e.storage, day("2026-10-20"), "main", "이 PC 에만(로컬)");
    e.link(day("2026-10-07"));
    e.sync().await;
    // A 의 보내지 못한 편집이 남은 채로 B 로 로그인
    e.mock.set_online(false);
    e.storage.with_conn(|c| service::update_content(c, &a.id, "A 의 미전송 편집")).unwrap();
    e.sync().await;
    e.mock.set_online(true);
    e.mock.expire_device(&e.device());
    e.login(2, false).await;
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n == NOTICE_OTHER_ACCOUNT));
    assert_eq!(e.status(&day("2026-10-07")), "auth_required");
    assert!(e.mock.document_of(2, &d7()).is_none(), "B 계정 서버에는 아무것도 가지 않는다");
    assert!(e.mock.snapshot_state().memos.values().all(|m| m.owner == 1), "B 로 어떤 메모도 올리지 않는다");
    assert_eq!(e.server(&d7()), vec!["A 계정 메모"], "A 의 Outbox 도 B credential 로 보내지 않는다");
    assert_eq!(e.outbox(), 1, "A 의 Outbox 는 지우지 않고 보관");
    assert_eq!(texts(&e.storage, "2026-10-20"), vec!["이 PC 에만(로컬)"]);
}

#[tokio::test]
async fn favorites_never_leave_the_device() {
    let e = env_logged_in().await;
    let a = add(&e.storage, next(None), "next", "즐겨찾기");
    e.storage.with_conn(|c| service::set_favorite(c, &a.id, true)).unwrap();
    e.link(next(None));
    e.sync().await; // Push 항목은 서버 Strict 모델처럼 favorite 필드를 가질 수 없다
    assert_eq!(e.status(&next(None)), "synced");
    let doc = e.mock.document_of(1, &Unit::list("default")).unwrap();
    assert_eq!(doc.key, "default");
    let memo = doc.items[0].id.unwrap();
    e.mock.web_edit(memo, |m| m.content = "Web 이 고침".into());
    e.sync().await;
    let item = e.storage.with_conn(|c| service::get_list(c, None)).unwrap().items.remove(0);
    assert_eq!(item.content_html, "Web 이 고침");
    assert!(item.favorite, "서버 변경을 받아도 로컬 즐겨찾기는 유지");
    assert_eq!(item.id, a.id, "같은 서버 항목은 같은 로컬 id");
}

#[tokio::test]
async fn relink_after_unlink_reuses_server_document_and_compares() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "다시 연결");
    e.link(day("2026-10-07"));
    e.sync().await;
    let server_doc = e.mock.document_of(1, &d7()).unwrap().id;
    e.mock.set_online(false);
    e.unlink(day("2026-10-07"));
    e.link(day("2026-10-07"));
    e.mock.set_online(true);
    e.sync().await;
    assert_eq!(e.mock.document_of(1, &d7()).unwrap().id, server_doc);
    assert_eq!(e.mock.snapshot_state().documents.len(), 1);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    assert_eq!(e.server(&d7()), vec!["다시 연결"], "중복 없음");
    // 서버에서 해제된 뒤 다시 연결하면 새 generation
    let first_link = e.link_id(&day("2026-10-07"));
    e.unlink(day("2026-10-07"));
    e.sync().await;
    e.link(day("2026-10-07"));
    e.sync().await;
    assert_ne!(e.link_id(&day("2026-10-07")), first_link);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
}

#[tokio::test]
async fn login_uses_real_loopback_listener_and_never_stores_token_in_sqlite() {
    let e = env();
    let listener = loopback::LoopbackListener::bind().await.unwrap();
    let redirect = listener.redirect_uri();
    let start = e.auth.begin_login(&redirect, false).await.unwrap();
    assert_eq!(start.mode, "mock");
    let waiter = tokio::spawn(async move { listener.wait(std::time::Duration::from_secs(10)).await });
    let callback = e.mock.approve_login(&start.authorization_id, 1).unwrap();
    let browser = tokio::spawn(async move { reqwest::get(callback).await.unwrap().text().await.unwrap() });
    let (params, responder) = waiter.await.unwrap().unwrap();
    let params = params.unwrap();
    let session = e.auth.complete_login(params.clone()).await.unwrap();
    responder.finish(true, "연결했습니다").await;
    assert!(browser.await.unwrap().contains("연결 완료"));
    assert_eq!(session.user_id, 1);
    assert!(e.auth.status().logged_in);
    // 같은 code 재사용 → 거절(일회용)
    let start2 = e.auth.begin_login(&redirect, false).await.unwrap();
    let state2 = e.mock.approve_login(&start2.authorization_id, 1).unwrap();
    let mut replay = loopback::parse_target(&state2[state2.find("/memo-sync").unwrap()..]).unwrap();
    replay.code = params.code;
    assert_eq!(e.auth.complete_login(replay).await.unwrap_err().code(), "auth_code_invalid");
    // state 가 다르면 교환하지 않는다
    let start3 = e.auth.begin_login(&redirect, false).await.unwrap();
    let cb3 = e.mock.approve_login(&start3.authorization_id, 1).unwrap();
    let mut forged = loopback::parse_target(&cb3[cb3.find("/memo-sync").unwrap()..]).unwrap();
    forged.state = "x".repeat(43);
    assert_eq!(e.auth.complete_login(forged).await.unwrap_err().code(), "auth_state_mismatch");
    // 토큰은 SQLite 에 없다
    add(&e.storage, day("2026-10-07"), "main", "메모");
    e.link(day("2026-10-07"));
    e.sync().await;
    let token = e.auth.session_context().unwrap().access_token;
    e.storage.with_conn(|c| Ok(c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?)).unwrap();
    let db = std::fs::read(e.storage.paths.db_path()).unwrap();
    assert!(!db.windows(token.len()).any(|w| w == token.as_bytes()), "credential 은 DB 에 평문으로 저장되지 않는다");
    assert!(!db.windows(4).any(|w| w == b"pms_"));
}

#[tokio::test]
async fn production_build_refuses_a_non_production_server() {
    let mock = Arc::new(MockSyncTransport::new());
    let auth = DesktopAuth::new(AppEnv::Production, mock.clone(), Arc::new(MemoryCredentialStore::default()), false);
    let err = auth.begin_login("http://127.0.0.1:50000/memo-sync/callback", false).await.unwrap_err();
    assert_eq!(err.code(), "auth_wrong_environment", "운영 앱은 local/staging namespace credential 을 받지 않는다");
    let _ = TransportError::Offline;
}
