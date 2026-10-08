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
async fn reference_policy_allows_links_and_blocks_only_documents_with_local_references() {
    // 최신 서버(memo-sync-v1): URL 속성·CSS url() 만 검사 — https/http 링크·'profile:'·경로를 설명하는 글자는 허용.
    let e = env_logged_in().await;
    let ok = [
        "<a href=\"https://example.com/docs\">링크</a>",
        "<p>http://intranet/wiki 참고, profile: 설정</p>",
        "<p>경로는 C:\\Users\\me\\a.png 입니다</p>",
    ];
    for html in ok {
        add(&e.storage, day("2026-10-07"), "main", html);
    }
    add(&e.storage, day("2026-10-08"), "main", "첫 메모");
    let bad = add(&e.storage, day("2026-10-08"), "main", "<a href=\"file:///C:/Users/me/report.docx\">보고서</a>");
    add(&e.storage, day("2026-10-09"), "main", "<a href=\"//cdn.example/x\">주소</a>");
    for d in ["2026-10-07", "2026-10-08", "2026-10-09"] {
        e.link(day(d));
    }
    let report = e.sync().await;
    assert_eq!(e.status(&day("2026-10-07")), "synced", "정상 링크·글자는 그대로 올라간다");
    assert_eq!(e.server(&d7()).len(), 3);
    assert_eq!(e.status(&day("2026-10-08")), "error");
    let message = e.error(&day("2026-10-08")).unwrap();
    assert!(message.contains("PC 파일 경로"), "{message}");
    assert!(message.contains("2번째 메모('보고서')"), "서버가 알려 준 항목 위치를 이 PC 의 메모로: {message}");
    assert_eq!(e.status(&day("2026-10-09")), "error");
    assert!(e.error(&day("2026-10-09")).unwrap().contains("https://"), "https 로 바꾸라는 안내");
    assert_eq!(texts(&e.storage, "2026-10-08")[1], "<a href=\"file:///C:/Users/me/report.docx\">보고서</a>", "본문을 몰래 고치지 않는다");
    assert!(e.server(&Unit::day("2026-10-08")).is_empty(), "거절된 문서는 서버에 아무것도 남지 않는다(부분 저장 없음)");
    assert!(report.failed >= 2);
    // 사용자가 링크를 고치면 다시 보낸다
    e.storage.with_conn(|c| service::update_content(c, &bad.id, "<a href=\"https://drive.example/report\">보고서</a>")).unwrap();
    e.sync().await;
    assert_eq!(e.status(&day("2026-10-08")), "synced");
    assert_eq!(e.server(&Unit::day("2026-10-08")).len(), 2);
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

// ═══════════════════════════════════════════════════════════════════════
// 3차 Contract 검증(docs/upstream-plan-a-work 4개 파일 기준) — 데이터 유실 방지 회귀 테스트를 먼저 둔다.
// 모두 MockSyncTransport 결과다(실제 PLAN-A Work 서버 검증 아님). 장애는 `mock.inject` 로 흉내 낸다.
// ═══════════════════════════════════════════════════════════════════════

fn server_error() -> TransportError {
    TransportError::Server("HTTP 500".into())
}

fn deleted_on_server(e: &Env, unit: &Unit) -> usize {
    e.mock.snapshot_state().memos.values().filter(|m| m.owner == 1 && &m.unit == unit && m.deleted).count()
}

fn pushes_for(e: &Env, unit: &Unit) -> Vec<PushRequest> {
    let doc = e.mock.document_of(1, unit).map(|d| d.id).unwrap_or_default();
    e.mock.pushes().into_iter().filter(|(id, _)| *id == doc).map(|(_, body)| body).collect()
}

#[tokio::test]
async fn every_push_carries_the_whole_document_so_no_item_is_soft_deleted() {
    // 서버는 문서 전체 교체 — Push 에서 빠진 기존 항목은 soft delete 된다. 한 항목만 고쳐도 문서 전체를 보내야 한다.
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "AWS 확인");
    add(&e.storage, day("2026-10-07"), "main", "메일 확인");
    add(&e.storage, day("2026-10-07"), "am", "회의 준비");
    let pm = add(&e.storage, day("2026-10-07"), "pm", "캡처");
    let info = e.storage.with_conn(|c| attachments::import_bytes(c, &e.storage.paths, PNG, None, Some(&pm.id))).unwrap();
    e.storage.with_conn(|c| service::update_content(c, &pm.id, &format!("캡처<img src=\"{}\">", info.url))).unwrap();
    add(&e.storage, day("2026-10-08"), "main", "연결 안 한 날짜");
    let list = e.storage.with_conn(|c| service::create_list(c, None, "앱 개발")).unwrap();
    let n1 = add(&e.storage, next(Some(&list.id)), "next", "음성 메모");
    add(&e.storage, next(Some(&list.id)), "next", "Android 조사");
    add(&e.storage, next(Some(&list.id)), "next", "iOS 조사");
    e.link(day("2026-10-07"));
    e.link(next(Some(&list.id)));
    e.sync().await;

    // 한 항목만 고친다 → Push 는 Main 2 + 오전 1 + 오후 1(이미지 포함) 전체, 모두 서버 id 를 가진다
    e.storage.with_conn(|c| service::update_content(c, &a.id, "AWS 비용 확인")).unwrap();
    e.storage.with_conn(|c| service::update_content(c, &n1.id, "음성 메모 정리")).unwrap();
    e.sync().await;
    let day_push = pushes_for(&e, &d7()).pop().unwrap();
    assert_eq!(day_push.items.len(), 4, "DAY Push 는 날짜 하루 전체");
    let sections: Vec<&str> = day_push.items.iter().map(|i| i.section.as_str()).collect();
    assert_eq!(sections, vec!["main", "main", "am", "pm"]);
    assert!(day_push.items.iter().all(|i| i.id.is_some() && i.client_key.is_none()), "이미 보낸 항목을 새 항목으로 만들지 않는다");
    assert!(day_push.items[3].content.contains("/api/personal-memos/images/"), "이미지 변환 중 항목이 빠지지 않는다");
    assert!(!day_push.items.iter().any(|i| i.content.contains("연결 안 한 날짜")), "다른(로컬 전용) 문서가 섞이지 않는다");
    assert_eq!(deleted_on_server(&e, &d7()), 0, "서버에서 지워진 항목 없음");
    assert_eq!(e.server(&d7()).len(), 4);
    let list_push = pushes_for(&e, &Unit::list(&list.id)).pop().unwrap();
    assert_eq!(list_push.items.len(), 3, "NEXT_LIST Push 는 List 전체");
    assert!(list_push.items.iter().all(|i| i.section == "main"));
    assert_eq!(deleted_on_server(&e, &Unit::list(&list.id)), 0);

    // 로컬 삭제 → 그 항목만 빠진 전체 문서 → 서버에서도 그 항목 하나만 soft delete(History 로 복원 가능)
    e.storage.with_conn(|c| service::delete_item(c, &a.id)).unwrap();
    e.sync().await;
    assert_eq!(pushes_for(&e, &d7()).pop().unwrap().items.len(), 3);
    assert_eq!(deleted_on_server(&e, &d7()), 1);
    let left = e.server(&d7());
    assert_eq!(left.len(), 3);
    assert!(!left.iter().any(|t| t.contains("AWS")));
}

#[tokio::test]
async fn item_version_is_echoed_and_never_used_as_base_version() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "A");
    let b = add(&e.storage, day("2026-10-07"), "main", "B");
    e.link(day("2026-10-07"));
    e.sync().await;
    // Web 이 A 를 세 번 고친다 → 문서 version 과 A 의 item_version 이 서로 다르게 증가
    let a_server = e.mock.unit_items(1, &d7()).into_iter().find(|(_, m)| m.content == "A").unwrap().0;
    for text in ["A1", "A2", "A3"] {
        e.mock.web_edit(a_server, |m| m.content = text.into());
    }
    e.sync().await;
    let doc_version = e.mock.document_of(1, &d7()).unwrap().version;
    let a_item_version = e.mock.unit_items(1, &d7()).into_iter().find(|(id, _)| *id == a_server).unwrap().1.version;
    assert_ne!(doc_version, a_item_version, "테스트 전제: 두 version 이 다르다");
    e.storage.with_conn(|c| service::update_content(c, &b.id, "B 수정")).unwrap();
    e.sync().await;
    let push = pushes_for(&e, &d7()).pop().unwrap();
    assert_eq!(push.base_version, doc_version, "base_version = 문서 version");
    let a_item = push.items.iter().find(|i| i.id == Some(a_server)).unwrap();
    assert_eq!(a_item.item_version, Some(a_item_version), "item_version 은 받은 값 그대로 되돌려 보낸다");
    assert_eq!(e.server(&d7()), vec!["A3", "B 수정"]);
    assert_eq!(deleted_on_server(&e, &d7()), 0);
}

#[tokio::test]
async fn pending_local_edit_is_never_overwritten_by_pull() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    // 이 PC 편집을 아직 못 보낸 사이(서버 오류) Web 도 같은 날짜를 고쳤다
    e.storage.with_conn(|c| service::update_content(c, &a.id, "이 PC 편집")).unwrap();
    e.mock.web_create(1, &d7(), "main", "Web 추가");
    e.mock.inject("push", server_error());
    let report = e.sync().await;
    assert_eq!(report.pulled, 0, "보내지 않은 편집이 있으면 서버 내용으로 덮지 않는다");
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["이 PC 편집"]);
    assert_eq!(e.outbox(), 1);
    // 다시 보내면 원래 base 로 → 서버가 비교를 만든다(양쪽 모두 보존)
    let report = e.sync().await;
    assert_eq!(report.conflicts, 1);
    assert_eq!(report.pushed, 0, "HTTP 200 + status=conflict 를 저장 성공으로 세지 않는다");
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["이 PC 편집"]);
    assert_eq!(e.server(&d7()), vec!["원래", "Web 추가"]);
}

#[tokio::test]
async fn first_link_cases_never_lose_either_side() {
    let e = env_logged_in().await;
    // Desktop 에만 내용
    add(&e.storage, day("2026-10-01"), "main", "Desktop 만");
    e.link(day("2026-10-01"));
    // 양쪽 모두 빈 날짜
    e.link(day("2026-10-02"));
    // 같은 날짜(제목) · 같은 글자 · 체크 상태만 다름 → 같은 내용으로 보지 않는다
    e.mock.web_create(1, &Unit::day("2026-10-03"), "main", "AWS 확인");
    let d3 = add(&e.storage, day("2026-10-03"), "main", "AWS 확인");
    e.storage.with_conn(|c| service::set_completed(c, &d3.id, true)).unwrap();
    // 서버에서 삭제된(tombstone) 문서 + 이 PC 내용 → 몰래 되살리지 않고 비교
    e.mock.web_tombstone(1, &Unit::day("2026-10-04"));
    add(&e.storage, day("2026-10-04"), "main", "이 PC 에 남은 메모");
    e.link(day("2026-10-03"));
    e.link(day("2026-10-04"));
    let report = e.sync().await;

    assert_eq!(e.server(&Unit::day("2026-10-01")), vec!["Desktop 만"]);
    assert_eq!(e.status(&day("2026-10-01")), "synced");
    assert!(e.server(&Unit::day("2026-10-02")).is_empty());
    assert_eq!(e.status(&day("2026-10-02")), "synced");
    assert!(pushes_for(&e, &Unit::day("2026-10-02")).is_empty(), "빈 문서끼리는 보낼 것이 없다");

    assert_eq!(report.conflicts, 2);
    for (date, server) in [("2026-10-03", vec!["AWS 확인"]), ("2026-10-04", vec![])] {
        assert_eq!(e.status(&day(date)), "conflict", "{date}: 비교");
        assert_eq!(e.server(&Unit::day(date)), server, "{date}: 서버 내용 그대로");
        let push = pushes_for(&e, &Unit::day(date)).pop().unwrap();
        assert_eq!(push.base_version, 0, "{date}: 최초 연결 비교는 base_version=0 제안");
    }
    assert!(e.mock.document_of(1, &Unit::day("2026-10-04")).unwrap().deleted, "tombstone 유지");
    assert_eq!(texts(&e.storage, "2026-10-04"), vec!["이 PC 에 남은 메모"]);
    let conflicts = e.storage.with_conn(|c| list_conflicts(c)).unwrap();
    assert!(conflicts.iter().all(|c| c.first_link), "첫 연결 비교로 안내");
    let local3 = e.storage.with_conn(|c| service::get_day(c, "2026-10-03")).unwrap().items;
    assert!(local3[0].completed, "이 PC 의 체크 상태도 그대로");
}

#[tokio::test]
async fn first_link_interrupted_by_network_is_retried_without_duplicates() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "Desktop 메모");
    e.link(day("2026-10-07"));
    // 연결은 만들어졌는데 문서를 받기 전에 끊겼다
    e.mock.inject("document", TransportError::Offline);
    let report = e.sync().await;
    assert!(report.offline);
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Desktop 메모"]);
    assert_eq!(e.outbox(), 1, "LINK 가 남는다");
    // 다시: 같은 서버 link 를 쓰고, 항목은 한 번만
    e.sync().await;
    let state = e.mock.snapshot_state();
    assert_eq!(state.links.values().filter(|l| l.active).count(), 1, "link 중복 없음");
    assert_eq!(e.server(&d7()), vec!["Desktop 메모"]);
    assert_eq!(e.status(&day("2026-10-07")), "synced");

    // 첫 비교 Push(base 0)의 응답을 잃어도 같은 request_id 로 다시 → 비교는 하나
    e.mock.web_create(1, &Unit::day("2026-10-09"), "main", "Web 메모");
    add(&e.storage, day("2026-10-09"), "main", "Desktop 메모 2");
    e.link(day("2026-10-09"));
    e.mock.drop_next_push_responses(1);
    e.sync().await;
    e.sync().await;
    let server_doc = e.mock.document_of(1, &Unit::day("2026-10-09")).unwrap().id;
    assert_eq!(e.mock.open_conflicts(&server_doc).len(), 1, "응답 유실 재시도로 비교가 둘 생기지 않는다");
    let bodies = pushes_for(&e, &Unit::day("2026-10-09"));
    assert!(bodies.len() >= 2 && bodies.windows(2).all(|w| w[0].request_id == w[1].request_id), "같은 request_id 로 재전송");
    assert_eq!(texts(&e.storage, "2026-10-09"), vec!["Desktop 메모 2"]);
}

#[tokio::test]
async fn ack_is_sent_later_when_the_ack_request_fails() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "처음");
    e.link(day("2026-10-07"));
    e.sync().await;
    let link_id = e.link_id(&day("2026-10-07"));
    e.storage.with_conn(|c| service::update_content(c, &a.id, "수정")).unwrap();
    // Push 직후 ACK + 같은 실행의 ACK 단계 — 둘 다 실패
    e.mock.inject("ack", server_error());
    e.mock.inject("ack", server_error());
    let report = e.sync().await;
    assert_eq!(report.pushed, 1);
    assert_eq!(report.acked, 0);
    assert_eq!(e.mock.link_status(&link_id).as_deref(), Some("connected"), "Push 성공만으로 synced 가 아니다");
    e.sync().await;
    assert_eq!(e.mock.link_status(&link_id).as_deref(), Some("synced"), "다음 실행에서 ACK");
}

#[tokio::test]
async fn attachment_download_failure_blocks_apply_and_ack_and_is_visible() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "처음");
    e.link(day("2026-10-07"));
    e.sync().await;
    let link_id = e.link_id(&day("2026-10-07"));
    let name = e.mock.web_upload_image(1, PNG);
    e.mock.web_create(1, &d7(), "pm", &format!("Web 캡처<img src=\"/api/personal-memos/images/{name}/download\">"));
    e.mock.inject("download", server_error());
    e.sync().await;
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["처음"], "이미지를 저장하지 못하면 적용하지 않는다");
    assert_eq!(e.status(&day("2026-10-07")), "error", "'동기화됨' 으로 보이지 않는다");
    assert!(e.error(&day("2026-10-07")).unwrap().contains("아직 받지 못했습니다"));
    assert_ne!(e.mock.link_status(&link_id).as_deref(), Some("synced"), "ACK 하지 않는다");
    e.sync().await;
    let now = texts(&e.storage, "2026-10-07");
    assert!(now[1].starts_with("Web 캡처<img src=\"attachment://"), "이미지는 로컬 첨부로");
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    assert_eq!(e.mock.link_status(&link_id).as_deref(), Some("synced"));
}

#[tokio::test]
async fn cursor_and_pending_documents_survive_a_crash() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "처음");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web 추가");
    // cursor 는 저장했는데 문서를 받기 전에 끊기고 앱이 강제 종료됐다
    e.mock.inject("document", TransportError::Offline);
    e.sync().await;
    let root = e.storage.paths.root.clone();
    std::mem::forget(e.storage);
    let (storage, _) = Storage::open(&root, false).unwrap();
    assert_eq!(count(&storage, "SELECT remote_pending FROM sync_links"), 1, "받아야 할 문서 표시가 cursor 와 함께 남았다");
    let report = e.engine.run_once(&storage, true).await.unwrap();
    assert_eq!(report.pulled, 1);
    assert_eq!(texts(&storage, "2026-10-07"), vec!["처음", "Web 추가"]);
}

#[tokio::test]
async fn stale_generation_outbox_is_never_replayed_after_relink() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "처음");
    e.link(day("2026-10-07"));
    e.sync().await;
    let old_link = e.link_id(&day("2026-10-07"));
    e.storage.with_conn(|c| service::update_content(c, &a.id, "응답을 잃은 편집")).unwrap();
    e.mock.drop_next_push_responses(1);
    e.sync().await; // 보낸 요청(old_link)이 Outbox 에 남았다
    e.unlink(day("2026-10-07"));
    e.sync().await;
    assert!(!e.mock.snapshot_state().links[&old_link].active);
    let sent_before = e.mock.pushes().len();
    e.link(day("2026-10-07"));
    e.sync().await;
    let new_link = e.link_id(&day("2026-10-07"));
    assert_ne!(new_link, old_link, "다시 연결 = 새 link generation");
    assert!(e.mock.pushes()[sent_before..].iter().all(|(_, body)| body.link_id == new_link), "이전 generation 요청을 다시 보내지 않는다");
    assert_eq!(e.server(&d7()), vec!["응답을 잃은 편집"]);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
}

#[tokio::test]
async fn edits_during_an_open_conflict_are_held_then_sent_after_choice() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web 수정");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop 수정")).unwrap();
    e.sync().await;
    let sent = e.mock.pushes().len();
    e.storage.with_conn(|c| service::update_content(c, &a.id, "비교 중 더 고침")).unwrap();
    e.sync().await;
    assert_eq!(e.mock.pushes().len(), sent, "비교를 고르기 전에는 보내지 않는다(서버에 비교가 더 생기지 않음)");
    let server_doc = e.mock.document_of(1, &d7()).unwrap().id;
    assert_eq!(e.mock.open_conflicts(&server_doc).len(), 1);
    let view = e.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
    assert_eq!(view.local.items[0].content_html, "비교 중 더 고침", "비교 화면의 Desktop 쪽은 지금 내용");
    assert!(!view.first_link);
    e.resolve(ConflictChoice::Local).await.unwrap();
    assert_eq!(e.server(&d7()), vec!["비교 중 더 고침"]);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
}

#[tokio::test]
async fn one_conflicted_document_does_not_block_others() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "7일");
    let b = add(&e.storage, day("2026-10-08"), "main", "8일");
    e.link(day("2026-10-07"));
    e.link(day("2026-10-08"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web 7일");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "7일 Desktop")).unwrap();
    e.storage.with_conn(|c| service::update_content(c, &b.id, "8일 Desktop")).unwrap();
    let report = e.sync().await;
    assert_eq!(report.conflicts, 1);
    assert_eq!(e.status(&day("2026-10-07")), "conflict");
    assert_eq!(e.server(&Unit::day("2026-10-08")), vec!["8일 Desktop"], "비교 중인 문서가 있어도 다른 문서는 보낸다");
    e.mock.web_create(1, &Unit::day("2026-10-08"), "pm", "Web 8일");
    e.sync().await;
    assert_eq!(texts(&e.storage, "2026-10-08"), vec!["8일 Desktop", "Web 8일"], "다른 문서의 Web 변경도 받는다");
    assert_eq!(e.status(&day("2026-10-08")), "synced");
    assert_eq!(e.status(&day("2026-10-07")), "conflict");
}

#[tokio::test]
async fn http_error_statuses_follow_the_contract() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "7일");
    let b = add(&e.storage, day("2026-10-08"), "main", "8일");
    e.link(day("2026-10-07"));
    e.link(day("2026-10-08"));
    e.sync().await;
    let edit = |id: &str, text: &str| e.storage.with_conn(|c| service::update_content(c, id, text)).unwrap();

    // 413 / 422 → 그 문서만 오류(이유 표시), Outbox 보관, 로컬 그대로. 다른 문서는 계속
    for (status, text) in [(413u16, "413 편집"), (422, "422 편집")] {
        edit(&a.id, text);
        let other = format!("8일 {status}");
        edit(&b.id, &other);
        e.mock.inject("push", TransportError::rejected(status, "rejected"));
        e.sync().await;
        assert_eq!(e.status(&day("2026-10-07")), "error", "{status}");
        assert!(e.error(&day("2026-10-07")).is_some());
        assert_eq!(texts(&e.storage, "2026-10-07"), vec![text]);
        assert_eq!(e.outbox(), 1, "{status}: 거절된 문서의 Outbox 보관");
        assert_eq!(e.server(&Unit::day("2026-10-08")), vec![other], "{status}: 다른 문서는 진행");
        e.sync().await; // 재시도(사용자가 [지금 동기화]) — 이번에는 서버가 받는다
        assert_eq!(e.server(&d7()), vec![text]);
        assert_eq!(e.status(&day("2026-10-07")), "synced");
    }
    // 429 / 503 → 이번 실행만 멈춤(오류 표시 아님), Outbox 보관
    edit(&a.id, "429 편집");
    e.mock.inject("push", TransportError::RateLimited);
    assert!(e.sync().await.offline);
    assert_eq!(e.status(&day("2026-10-07")), "pending");
    edit(&a.id, "503 편집");
    e.mock.inject("push", TransportError::Unavailable);
    let report = e.sync().await;
    assert!(report.unavailable && !report.notices.is_empty());
    assert_eq!(e.status(&day("2026-10-07")), "pending");
    assert_eq!(e.outbox(), 1);
    e.sync().await;
    assert_eq!(e.server(&d7()), vec!["503 편집"]);
    // 409 ack_version_stale · attachments_incomplete → 서버 문서를 다시 받아 확인한 뒤(같은 실행 안에서) ACK
    for code in ["ack_version_stale", "attachments_incomplete"] {
        edit(&a.id, code);
        e.mock.inject("ack", TransportError::Conflict { code: code.into() });
        let requests = e.mock.request_count();
        let report = e.sync().await;
        assert_eq!(report.pushed, 1, "{code}");
        assert!(e.mock.request_count() - requests >= 5, "{code}: push·ack(409)·changes·document·ack");
        assert_eq!(e.mock.link_status(&e.link_id(&day("2026-10-07"))).as_deref(), Some("synced"), "{code}");
        assert_eq!(e.server(&d7()), vec![code]);
    }
    // 409 cursor_namespace_mismatch → cursor 를 버리고 연결 문서를 다시 확인(실패 아님)
    e.mock.inject("changes", TransportError::Conflict { code: "cursor_namespace_mismatch".into() });
    let report = e.sync().await;
    assert_eq!(report.failed, 0);
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    // 409 link_inactive(Push) → 그 연결만 끝내고 로컬은 보존
    edit(&b.id, "해제된 뒤 편집");
    e.mock.inject("push", TransportError::Conflict { code: "link_inactive".into() });
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n.contains("연결이 해제")));
    assert_eq!(e.status(&day("2026-10-08")), "local_only");
    assert_eq!(texts(&e.storage, "2026-10-08"), vec!["해제된 뒤 편집"]);
}

#[tokio::test]
async fn resolving_a_conflict_already_resolved_elsewhere_reloads_and_keeps_history() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    e.link(day("2026-10-07"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "main", "Web");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop")).unwrap();
    e.sync().await;
    let server_doc = e.mock.document_of(1, &d7()).unwrap().id;
    let (cid, _) = e.mock.open_conflicts(&server_doc).remove(0);
    e.mock.web_resolve(&cid, Side::Web).unwrap(); // Web 에서 먼저 골랐다(이 PC 는 아직 모름)
    let err = e.resolve(ConflictChoice::Local).await.unwrap_err();
    assert_eq!(err.code(), "conflict_resolved_elsewhere", "이미 해결된 비교를 오래된 선택으로 덮지 않는다");
    assert_eq!(e.server(&d7()), vec!["원래", "Web"]);
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["원래", "Web"]);
    let versions = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(versions.iter().any(|v| v.reason == "conflict_local" && v.preview.contains("Desktop")));
}

#[tokio::test]
async fn server_limits_and_unsupported_images_block_only_that_document() {
    let e = env_logged_in().await;
    // 50만 자 초과 항목
    add(&e.storage, day("2026-10-01"), "main", &"가".repeat(500_001));
    // GIF 이미지(서버 inline image 정책은 PNG·JPG·WEBP)
    let gif_item = add(&e.storage, day("2026-10-02"), "main", "GIF");
    let gif: &[u8] = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;";
    let info = e.storage.with_conn(|c| attachments::import_bytes(c, &e.storage.paths, gif, None, Some(&gif_item.id))).unwrap();
    let gif_html = format!("GIF<img src=\"{}\">", info.url);
    e.storage.with_conn(|c| service::update_content(c, &gif_item.id, &gif_html)).unwrap();
    add(&e.storage, day("2026-10-03"), "main", "평범");
    for d in ["2026-10-01", "2026-10-02", "2026-10-03"] {
        e.link(day(d));
    }
    e.sync().await;
    assert_eq!(e.status(&day("2026-10-01")), "error");
    assert!(e.error(&day("2026-10-01")).unwrap().contains("50만 자"));
    assert_eq!(texts(&e.storage, "2026-10-01")[0].chars().count(), 500_001, "로컬 내용은 그대로");
    assert_eq!(e.status(&day("2026-10-02")), "error");
    assert!(e.error(&day("2026-10-02")).unwrap().contains("GIF"));
    assert_eq!(texts(&e.storage, "2026-10-02"), vec![gif_html], "지원하지 않는 이미지를 몰래 지우거나 바꾸지 않는다");
    assert!(e.storage.with_conn(|c| attachments::read_bytes(c, &e.storage.paths, &info.id)).is_ok(), "원본 이미지 파일 보존");
    assert_eq!(e.status(&day("2026-10-03")), "synced", "다른 날짜는 계속");
    assert!(e.mock.snapshot_state().images.is_empty(), "GIF 를 올리지 않았다");
    // 한 문서 1,000개 초과
    for i in 0..1001 {
        add(&e.storage, day("2026-10-04"), "main", &format!("항목 {i}"));
    }
    e.link(day("2026-10-04"));
    e.sync().await;
    assert!(e.error(&day("2026-10-04")).unwrap().contains("1,000개"));
    assert_eq!(texts(&e.storage, "2026-10-04").len(), 1001);
}

#[tokio::test]
async fn renaming_a_linked_list_stays_on_this_pc() {
    let e = env_logged_in().await;
    let list = e.storage.with_conn(|c| service::create_list(c, None, "앱 개발")).unwrap();
    add(&e.storage, next(Some(&list.id)), "next", "항목");
    e.link(next(Some(&list.id)));
    e.sync().await;
    let renamed = e.storage.with_conn(|c| service::rename_list(c, &list.id, "앱 개발 2")).unwrap();
    assert_eq!(renamed.name, "앱 개발 2");
    assert_eq!(e.outbox(), 0, "이름 변경 API 가 없다 — 보낼 것이 없다");
    assert_eq!(e.status(&next(Some(&list.id))), "synced");
    let pushes = e.mock.pushes().len();
    e.sync().await;
    assert_eq!(e.mock.pushes().len(), pushes);
    assert_eq!(e.mock.document_of(1, &Unit::list(&list.id)).unwrap().title.as_deref(), Some("앱 개발"), "서버 이름은 그대로");
    // 이름이 바뀐 뒤 해제 → 다시 연결해도(서버 List 409 'List ID already in use') 연결은 이어진다
    e.unlink(next(Some(&list.id)));
    e.sync().await;
    e.link(next(Some(&list.id)));
    e.sync().await;
    assert_eq!(e.status(&next(Some(&list.id))), "synced");
    assert_eq!(e.server(&Unit::list(&list.id)), vec!["항목"]);
}

#[tokio::test]
async fn loopback_listeners_never_share_a_port() {
    let first = loopback::LoopbackListener::bind().await.unwrap();
    let second = loopback::LoopbackListener::bind().await.unwrap();
    assert_ne!(first.port(), second.port(), "이미 쓰는 포트와 겹치지 않는다(운영체제가 임시 포트를 고름)");
    for listener in [&first, &second] {
        assert!(listener.port() >= 1024);
        assert_eq!(listener.redirect_uri(), format!("http://127.0.0.1:{}/memo-sync/callback", listener.port()));
    }
}

#[test]
fn environments_never_accept_each_others_servers() {
    use plan_a_memo_lib::auth::namespace_allowed;
    // (빌드 환경, 서버 namespace, 허용) — credential·cursor·Outbox 는 namespace|user 로도 나뉜다(account_key)
    let matrix = [
        (AppEnv::Production, "production:planawork-01", true),
        (AppEnv::Production, "staging:planawork-stg", false),
        (AppEnv::Production, "local:mock-server-01", false),
        (AppEnv::Staging, "staging:planawork-stg", true),
        (AppEnv::Staging, "production:planawork-01", false),
        (AppEnv::Staging, "local:dev", false),
        (AppEnv::Development, "local:mock-server-01", true),
        (AppEnv::Development, "staging:planawork-stg", true),
        (AppEnv::Development, "production:planawork-01", false),
    ];
    for (env, namespace, allowed) in matrix {
        assert_eq!(namespace_allowed(env, namespace), allowed, "{env:?} ← {namespace}");
    }
}

#[tokio::test]
async fn next_and_day_moves_follow_the_same_selective_link_policy() {
    let e = env_logged_in().await;
    let n = add(&e.storage, next(None), "next", "Next 에서 날짜로");
    let d = add(&e.storage, day("2026-10-07"), "pm", "날짜에서 List 로");
    let list = e.storage.with_conn(|c| service::create_list(c, None, "보관")).unwrap();
    e.link(next(None));
    e.link(day("2026-10-07"));
    e.sync().await;
    let mv = |id: &str, target: Location, policy: Option<MovePolicy>| {
        e.storage.with_conn(|c| service::move_item(c, MoveItem { id: id.into(), target, section: None, index: None, policy })).unwrap()
    };
    // 연결된 Next → 연결 안 된 날짜, 연결된 날짜 → 연결 안 된 List: 묻는다
    assert_eq!(mv(&n.id, day("2026-10-20"), None).status, "needs_decision");
    assert_eq!(mv(&d.id, next(Some(&list.id)), None).status, "needs_decision");
    mv(&n.id, day("2026-10-20"), Some(MovePolicy::LocalOnly));
    mv(&d.id, next(Some(&list.id)), Some(MovePolicy::LocalOnly));
    e.sync().await;
    assert!(e.server(&Unit::list("default")).is_empty(), "원래 문서에서만 빠진다");
    assert!(e.server(&d7()).is_empty());
    assert!(e.mock.document_of(1, &Unit::day("2026-10-20")).is_none(), "대상 날짜를 몰래 연결하지 않는다");
    assert!(e.mock.document_of(1, &Unit::list(&list.id)).is_none(), "대상 List 를 몰래 만들거나 연결하지 않는다");
    assert_eq!(texts(&e.storage, "2026-10-20"), vec!["Next 에서 날짜로"]);
    assert_eq!(e.storage.with_conn(|c| service::get_list(c, Some(&list.id))).unwrap().items[0].content_html, "날짜에서 List 로");
    // 연결된 날짜 ↔ 연결된 Next: 묻지 않고 옮기며, 서버에는 원래 문서에서 빠지고 대상 문서에 새 항목으로(v1 규칙)
    let m = add(&e.storage, day("2026-10-07"), "main", "연결끼리 이동");
    e.sync().await;
    assert_eq!(mv(&m.id, next(None), None).status, "moved");
    e.sync().await;
    assert!(e.server(&d7()).is_empty());
    assert_eq!(e.server(&Unit::list("default")), vec!["연결끼리 이동"]);
    let history = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(history.iter().any(|v| v.preview.contains("연결끼리 이동")), "옮기기 전 상태는 원래 날짜 History 에");
}

// ═══════════════════════════════════════════════════════════════════════
// 4차 — 최신 PLAN-A Work 계약(device_revoked · 오류 규격 · ACK manifest · 참조 검사) 반영. Mock 결과다.
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn revoked_device_is_never_reactivated_and_needs_explicit_new_registration() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "원래");
    add(&e.storage, day("2026-10-20"), "main", "이 PC 에만(로컬)");
    e.link(day("2026-10-07"));
    e.sync().await;
    let old_device = e.device();
    let old_link = e.link_id(&day("2026-10-07"));
    // 단순 만료 → 같은 기기로 다시 연결하던 중(브라우저 동의까지 받음) Web 에서 이 PC 를 해제했다
    e.mock.expire_device(&old_device);
    e.storage.with_conn(|c| service::update_content(c, &a.id, "보내지 못한 편집")).unwrap();
    assert!(e.sync().await.auth_required);
    let start = e.auth.begin_login(&format!("{REDIRECT_BASE}/memo-sync/callback"), true).await.unwrap();
    let callback = e.mock.approve_login(&start.authorization_id, 1).unwrap(); // 폐기 전에 발급된 code
    e.mock.web_revoke_device(&old_device);
    let params = loopback::parse_target(&callback[REDIRECT_BASE.len()..]).unwrap();
    let err = e.auth.complete_login(params).await.unwrap_err();
    assert_eq!(err.code(), "device_revoked", "폐기 전에 받은 code 로도 되살리지 않는다");
    assert!(err.to_string().contains("로컬 메모는 그대로"));
    let status = e.auth.status();
    assert!(status.revoked && !status.logged_in);
    assert!(e.mock.devices().iter().any(|(id, _, revoked)| *id == old_device && *revoked), "서버 기기는 폐기 상태 그대로");
    // 같은 기기 id 로 자동·반복 재시도하지 않는다(서버 요청조차 없음)
    let requests = e.mock.request_count();
    assert_eq!(e.auth.begin_login(&format!("{REDIRECT_BASE}/memo-sync/callback"), true).await.unwrap_err().code(), "device_revoked");
    e.sync().await;
    assert_eq!(e.mock.request_count(), requests, "폐기된 credential 로 계속 요청하지 않는다");
    // 브라우저 동의 단계에서도 폐기된 id 는 409
    let again = plan_a_memo_lib::auth::AuthApi::start(
        e.mock.as_ref(),
        &plan_a_memo_lib::sync::contract::AuthStartRequest {
            name: "Test PC".into(),
            challenge: "c".repeat(43),
            state: "s".repeat(43),
            redirect_uri: format!("{REDIRECT_BASE}/memo-sync/callback"),
            device_id: Some(old_device.clone()),
        },
    )
    .await
    .unwrap();
    assert!(e.mock.approve_login(&again.authorization_id, 1).unwrap_err().is_conflict("device_revoked"));
    // 로컬 메모·미전송 Outbox 보존
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["보내지 못한 편집"]);
    assert_eq!(texts(&e.storage, "2026-10-20"), vec!["이 PC 에만(로컬)"]);
    assert_eq!(e.outbox(), 1);

    // 사용자가 [새 기기로 등록] — device_id 없이 새 로그인 → 새 기기. 이전 연결·cursor 는 이어받지 않는다
    let session = e.login(1, false).await;
    assert_ne!(session.server_device_id, old_device);
    let sent_before = e.mock.pushes().len();
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n == engine::NOTICE_PREVIOUS_DEVICE));
    assert_eq!(e.status(&day("2026-10-07")), "auth_required");
    assert_eq!(e.error(&day("2026-10-07")).as_deref(), Some(engine::NOTICE_PREVIOUS_DEVICE));
    assert_eq!(e.mock.pushes().len(), sent_before, "이전 generation 요청을 새 credential 로 보내지 않는다");
    assert_eq!(e.server(&d7()), vec!["원래"], "미전송 편집을 몰래 올리지 않는다");
    assert_eq!(e.outbox(), 1, "이전 기기의 Outbox 도 지우지 않고 보관");
    assert!(!e.mock.snapshot_state().links[&old_link].active);
    // 사용자가 그 날짜를 직접 다시 연결 → 새 link generation, 양쪽 내용을 비교부터(덮어쓰지 않음)
    e.link(day("2026-10-07"));
    let report = e.sync().await;
    assert_eq!(report.conflicts, 1);
    assert_ne!(e.link_id(&day("2026-10-07")), old_link);
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["보내지 못한 편집"]);
    assert_eq!(e.server(&d7()), vec!["원래"]);
}

#[tokio::test]
async fn expired_credential_keeps_the_same_device_and_links() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "처음");
    e.link(day("2026-10-07"));
    e.sync().await;
    let (device, link_id) = (e.device(), e.link_id(&day("2026-10-07")));
    e.mock.expire_device(&device);
    assert!(e.sync().await.auth_required);
    assert!(!e.auth.status().revoked, "만료는 폐기가 아니다");
    let session = e.login(1, true).await;
    assert_eq!(session.server_device_id, device, "같은 기기 id 로 credential 만 바뀐다");
    e.sync().await;
    assert_eq!(e.link_id(&day("2026-10-07")), link_id, "연결(generation) 유지");
    assert_eq!(e.status(&day("2026-10-07")), "synced");
}

#[tokio::test]
async fn client_key_already_used_elsewhere_is_checked_not_blindly_resent() {
    let e = env_logged_in().await;
    add(&e.storage, day("2026-10-07"), "main", "7일 항목");
    let b = add(&e.storage, day("2026-10-08"), "main", "8일 기존");
    e.link(day("2026-10-07"));
    e.link(day("2026-10-08"));
    e.sync().await;
    // 8일의 새 항목이 (오래된 매핑 때문에) 7일 항목의 client_key 를 들고 있다
    let used_key = e.mock.unit_items(1, &d7())[0].1.client_key.clone().unwrap();
    let fresh = add(&e.storage, day("2026-10-08"), "main", "8일 새 항목");
    e.storage
        .with_conn(|c| {
            let doc = repo::doc_for_location(c, &day("2026-10-08"))?.unwrap();
            // 로컬에서는 7일 항목 매핑이 그 key 를 잊었고(서버에는 남아 있음) 8일 새 항목이 그 key 를 쓴다
            c.execute("UPDATE sync_item_map SET client_key = NULL WHERE client_key = ?1", [&used_key])?;
            c.execute(
                "INSERT INTO sync_item_map (document_id, item_id, account_key, client_key) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![doc.id, fresh.id, e.account(), used_key],
            )?;
            Ok(())
        })
        .unwrap();
    e.storage.with_conn(|c| service::update_content(c, &b.id, "8일 기존 수정")).unwrap();
    let report = e.sync().await;
    assert!(report.notices.iter().any(|n| n == engine::NOTICE_CLIENT_KEY));
    assert_eq!(
        pushes_for(&e, &Unit::day("2026-10-08")).iter().filter(|p| p.items.len() == 2).count(),
        1,
        "같은 실행에서 바로 다시 보내지 않는다"
    );
    assert_eq!(e.server(&d7()), vec!["7일 항목"], "다른 날짜의 항목을 가져가지 않는다");
    // 다음 실행: 최신 상태 확인 뒤 이 날짜의 새 항목(새 client_key)으로
    e.sync().await;
    assert_eq!(e.server(&Unit::day("2026-10-08")), vec!["8일 기존 수정", "8일 새 항목"]);
    assert_eq!(e.server(&d7()), vec!["7일 항목"]);
    assert_eq!(e.status(&day("2026-10-08")), "synced");
}

#[tokio::test]
async fn choosing_a_proposal_whose_item_moved_elsewhere_keeps_both_and_asks_again() {
    let e = env_logged_in().await;
    let a = add(&e.storage, day("2026-10-07"), "main", "옮겨질 항목");
    e.link(day("2026-10-07"));
    e.link(day("2026-10-08"));
    e.sync().await;
    e.mock.web_create(1, &d7(), "pm", "Web 추가");
    e.storage.with_conn(|c| service::update_content(c, &a.id, "Desktop 수정")).unwrap();
    assert_eq!(e.sync().await.conflicts, 1);
    // 비교를 고르기 전에 Web 이 그 항목을 8일로 옮겼다
    let moved = e.mock.unit_items(1, &d7()).into_iter().find(|(_, m)| m.content == "옮겨질 항목").unwrap().0;
    e.mock.web_move(moved, &Unit::day("2026-10-08"));
    assert_eq!(e.resolve(ConflictChoice::Local).await.unwrap_err().code(), "conflict_stale", "먼저 최신 base 로 비교를 새로 고친다");
    let err = e.resolve(ConflictChoice::Local).await.unwrap_err();
    assert_eq!(err.code(), "conflict_items_moved", "409 item_moved_or_not_owned — 다른 날짜의 항목을 가져오지 않는다");
    assert_eq!(e.storage.with_conn(|c| list_conflicts(c)).unwrap().len(), 1, "비교는 열린 채로");
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Desktop 수정"], "이 PC 내용 그대로");
    assert_eq!(e.server(&Unit::day("2026-10-08")), vec!["옮겨질 항목"], "옮겨진 위치도 그대로");
    // PLAN-A Work 쪽을 고르면 정상 해결
    e.resolve(ConflictChoice::Remote).await.unwrap();
    assert_eq!(texts(&e.storage, "2026-10-07"), vec!["Web 추가"]);
    let versions = e.storage.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(versions.iter().any(|v| v.preview.contains("Desktop 수정")), "고르지 않은 이 PC 내용은 History 에");
}

#[tokio::test]
async fn size_errors_follow_the_413_422_contract_and_keep_local_text() {
    let e = env_logged_in().await;
    // 50만 자 이하라도 공통 rich-content 정책(항목당 HTML 1MiB)을 넘으면 서버가 413
    let big = "가".repeat(400_000); // 1.2MB
    add(&e.storage, day("2026-10-01"), "main", &big);
    add(&e.storage, day("2026-10-02"), "main", "평범");
    e.link(day("2026-10-01"));
    e.link(day("2026-10-02"));
    e.sync().await;
    assert_eq!(e.status(&day("2026-10-01")), "error");
    assert!(e.error(&day("2026-10-01")).unwrap().contains("크기 제한"));
    assert_eq!(texts(&e.storage, "2026-10-01")[0].len(), big.len(), "로컬 내용 그대로");
    assert_eq!(e.status(&day("2026-10-02")), "synced");
    // 서버가 돌려주는 모양 그대로: 개수·글자 수(Pydantic) 422, 문서 byte 413
    let ctx = e.ctx();
    let doc = e.mock.document_of(1, &Unit::day("2026-10-02")).unwrap();
    let link_id = e.link_id(&day("2026-10-02"));
    let item = |content: String, key: usize| plan_a_memo_lib::sync::contract::PushItem {
        id: None,
        item_version: None,
        client_key: Some(format!("00000000-0000-4000-8000-{key:012}")),
        section: "main".into(),
        kind: "text".into(),
        content,
        completed: false,
        sort_order: 0,
    };
    let push = |items| PushRequest {
        base_version: doc.version,
        local_version: 1,
        request_id: uuid::Uuid::new_v4().to_string(),
        link_id: link_id.clone(),
        deleted: false,
        items,
    };
    let too_many: Vec<_> = (0..1001).map(|i| item("x".into(), i)).collect();
    assert!(matches!(e.mock.push(&ctx, &doc.id, &push(too_many)).await.unwrap_err(), TransportError::Rejected { status: 422, .. }));
    let too_long = vec![item("a".repeat(500_001), 1)];
    assert!(matches!(e.mock.push(&ctx, &doc.id, &push(too_long)).await.unwrap_err(), TransportError::Rejected { status: 422, .. }));
    let too_heavy: Vec<_> = (0..3).map(|i| item("가".repeat(300_000), i)).collect(); // 2.7MB
    assert!(matches!(e.mock.push(&ctx, &doc.id, &push(too_heavy)).await.unwrap_err(), TransportError::Rejected { status: 413, .. }));
    // 같은 row 를 id 와 client_key 로 두 번 → 422, 부분 저장 없음
    let current = e.mock.document_of(1, &Unit::day("2026-10-02")).unwrap();
    let row = current.items[0].clone();
    let mut by_id = item(row.content.clone(), 9);
    (by_id.id, by_id.client_key) = (row.id, None);
    let mut by_key = item("별칭".into(), 9);
    by_key.client_key = row.client_key.clone();
    assert!(matches!(
        e.mock.push(&ctx, &doc.id, &push(vec![by_id, by_key])).await.unwrap_err(),
        TransportError::Rejected { status: 422, .. }
    ));
    assert_eq!(e.mock.document_of(1, &Unit::day("2026-10-02")).unwrap().version, current.version);
}

#[tokio::test]
async fn one_image_used_many_times_is_acked_once() {
    let e = env_logged_in().await;
    let main = add(&e.storage, day("2026-10-07"), "main", "M");
    let am = add(&e.storage, day("2026-10-07"), "am", "A");
    let pm = add(&e.storage, day("2026-10-07"), "pm", "P");
    let info = e.storage.with_conn(|c| attachments::import_bytes(c, &e.storage.paths, PNG, None, Some(&main.id))).unwrap();
    let twice = format!("<img src=\"{0}\"> 두 번 <img src=\"{0}\">", info.url);
    for item in [&main, &am, &pm] {
        e.storage.with_conn(|c| service::update_content(c, &item.id, &twice)).unwrap();
    }
    e.link(day("2026-10-07"));
    e.sync().await;
    assert_eq!(e.mock.snapshot_state().images.len(), 1, "한 장만 올린다");
    let manifest = e.mock.document_of(1, &d7()).unwrap().attachments;
    assert_eq!(manifest.len(), 1, "서버 manifest 는 문서 전체에서 이름이 하나");
    assert_eq!(e.mock.link_status(&e.link_id(&day("2026-10-07"))).as_deref(), Some("synced"), "중복 없는 이름으로 ACK");
    // ACK 이름이 중복·누락·추가되면 409 attachments_incomplete
    let ctx = e.ctx();
    let doc = e.mock.document_of(1, &d7()).unwrap();
    let name = manifest[0].name.clone();
    for names in [vec![name.clone(), name.clone()], vec![], vec![name.clone(), "extra.png".into()]] {
        let ack = plan_a_memo_lib::sync::contract::AckRequest {
            version: doc.version,
            link_id: e.link_id(&day("2026-10-07")),
            attachments: names,
        };
        assert!(e.mock.ack(&ctx, &doc.id, &ack).await.unwrap_err().is_conflict("attachments_incomplete"));
    }
    // Web 이 같은 이미지를 여러 날짜 구역에 다시 써도 한 번만 받고 synced
    e.mock.web_create(1, &d7(), "am", &format!("Web {}", twice.replace(&info.url, &format!("/api/personal-memos/images/{name}/download"))));
    e.sync().await;
    assert_eq!(e.status(&day("2026-10-07")), "synced");
    assert_eq!(e.mock.link_status(&e.link_id(&day("2026-10-07"))).as_deref(), Some("synced"));
}
