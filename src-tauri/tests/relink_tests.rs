//! 같은 메모를 연결 해제 후 다시 연결 — **MockSyncTransport** 로 검증(실제 PLAN-A Work 서버 검증이 아니다).
//! Mock 은 Staging 에서 본 sanitizer 정규화(`style` 끝 `;` 제거)를 흉내 낸다 — 이 정규화 때문에 같은 내용인데 비교 화면이 떴다.
//! 원칙: 정말 같을 때만 자동 연결, 조금이라도 다르거나 판단할 수 없으면 비교 화면(양쪽 보존).

mod common;

use std::sync::Arc;

use common::*;
use plan_a_memo_lib::attachments;
use plan_a_memo_lib::auth::{loopback, AuthProvider, DesktopAuth, MemoryCredentialStore};
use plan_a_memo_lib::config::AppEnv;
use plan_a_memo_lib::memo::service::{self, MoveItem};
use plan_a_memo_lib::memo::{repo, Location};
use plan_a_memo_lib::storage::Storage;
use plan_a_memo_lib::sync::contract::{PushItem, PushRequest};
use plan_a_memo_lib::sync::engine::{list_conflicts, ConflictChoice, SyncEngine, SyncReport};
use plan_a_memo_lib::sync::link;
use plan_a_memo_lib::sync::mock::{MockSyncTransport, Unit};
use plan_a_memo_lib::sync::transport::{SyncContext, SyncTransport, TransportError};

const REDIRECT_BASE: &str = "http://127.0.0.1:54321";
const DATE: &str = "2026-11-04";
/// 실제 Staging 비교 화면에 저장돼 있던 본문 모양(이미지 없는 형태).
const STYLED: &str = "경로에서 내용 업데이트<br>-&gt; 내용 입력<div><span style=\"color: rgb(1, 2, 3);\">글</span><br></div>";

struct Env {
    storage: Storage,
    mock: Arc<MockSyncTransport>,
    auth: Arc<DesktopAuth>,
    engine: SyncEngine,
    // 맨 뒤 — 필드는 적은 순서로 정리된다. Windows 는 열린 DB 가 있으면 폴더를 지우지 못한다.
    _dir: tempfile::TempDir,
}

#[tokio::test]
async fn env_leaves_no_temp_folder_behind() {
    let e = ready().await;
    let dir = e._dir.path().to_path_buf();
    assert!(e.storage.paths.db_path().is_file());
    drop(e);
    assert!(!dir.exists(), "DB 를 닫은 뒤 폴더가 지워진다");
}

async fn ready() -> Env {
    let (dir, storage) = temp_storage();
    let mock = Arc::new(MockSyncTransport::new());
    let auth = Arc::new(
        DesktopAuth::new(AppEnv::Development, mock.clone(), Arc::new(MemoryCredentialStore::default()), true).with_device_name("Test PC"),
    );
    let engine = SyncEngine::new(mock.clone(), auth.clone());
    let e = Env { _dir: dir, storage, mock, auth, engine };
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
    fn link(&self, location: &Location) {
        let account = self.account();
        self.storage
            .with_conn(|c| {
                let doc = repo::ensure_doc(c, location)?;
                link::enable_link(c, &doc.id, &account)
            })
            .unwrap();
    }
    fn unlink(&self, location: &Location) {
        self.storage
            .with_conn(|c| {
                let doc = repo::doc_for_location(c, location)?.unwrap();
                link::disable_link(c, &doc.id).map(|_| ())
            })
            .unwrap();
    }
    /// 연결·동기화 → 해제까지(서버에 UNLINK 전달 포함).
    async fn link_then_unlink(&self, location: &Location) {
        self.link(location);
        self.sync().await;
        assert_eq!(self.status(location), "synced");
        self.unlink(location);
        self.sync().await;
    }
    fn status(&self, location: &Location) -> String {
        self.storage.with_conn(|c| Ok(repo::doc_for_location(c, location)?.unwrap().sync_status)).unwrap()
    }
    fn conflicts(&self) -> usize {
        self.storage.with_conn(|c| list_conflicts(c)).unwrap().len()
    }
    fn outbox(&self) -> i64 {
        count(&self.storage, "SELECT COUNT(*) FROM sync_outbox")
    }
    fn server_version(&self, unit: &Unit) -> i64 {
        self.mock.document_of(1, unit).unwrap().version
    }
    fn local(&self) -> Vec<String> {
        texts(&self.storage, DATE)
    }
    fn import_image(&self, item: &str, bytes: &[u8]) -> attachments::AttachmentInfo {
        self.storage.with_conn(|c| attachments::import_bytes(c, &self.storage.paths, bytes, None, Some(item))).unwrap()
    }
    /// 다시 연결 — 비교 화면 없이, 서버에 아무것도 새로 쓰지 않고 끝나야 한다.
    async fn assert_silent_relink(&self, location: &Location, unit: &Unit) {
        let version = self.server_version(unit);
        let pushes = self.mock.pushes().len();
        self.link(location);
        let report = self.sync().await;
        assert_eq!(report.conflicts, 0, "비교 화면을 열지 않는다");
        assert_eq!(self.conflicts(), 0);
        assert_eq!(self.status(location), "synced", "연결 완료");
        assert_eq!(self.mock.pushes().len(), pushes, "같은 내용을 다시 보내지 않는다");
        assert_eq!(self.server_version(unit), version, "서버 version 이 늘지 않는다");
        assert_eq!(self.outbox(), 0);
        let link_id = self.storage.with_conn(|c| Ok(link::link_row(c, &repo::doc_for_location(c, location)?.unwrap().id)?.unwrap().link_id)).unwrap();
        assert_eq!(self.mock.link_status(&link_id.unwrap()).as_deref(), Some("synced"), "ACK 까지 끝난다");
    }
}

fn unit() -> Unit {
    Unit::day(DATE)
}

// ── A·B: 같은 내용 재연결 ─────────────────────────────────────────────

#[tokio::test]
async fn same_day_relinks_silently_with_every_section() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    add(&e.storage, location.clone(), "am", "<p style=\"text-align: center;\">오전</p>");
    let pm = add(&e.storage, location.clone(), "pm", "오후");
    e.storage.with_conn(|c| service::set_completed(c, &pm.id, true)).unwrap();
    e.link_then_unlink(&location).await;
    let before = e.local();
    e.assert_silent_relink(&location, &unit()).await;
    assert_eq!(e.local(), before, "로컬 본문은 그대로");
    assert_eq!(e.mock.snapshot_state().documents.len(), 1, "서버 문서 하나");
    // 다시 연결한 뒤의 편집은 평소처럼 올라간다
    e.storage.with_conn(|c| service::update_content(c, &pm.id, "오후 수정")).unwrap();
    assert_eq!(e.sync().await.pushed, 1);
    assert!(e.mock.unit_texts(1, &unit()).contains(&"오후 수정".to_string()));
    assert_eq!(e.conflicts(), 0);
}

#[tokio::test]
async fn relink_repeats_without_ever_asking() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    e.link(&location);
    e.sync().await;
    for _ in 0..3 {
        e.unlink(&location);
        e.sync().await;
        e.assert_silent_relink(&location, &unit()).await;
    }
}

#[tokio::test]
async fn relink_before_the_unlink_reached_the_server_is_silent_too() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    e.link(&location);
    e.sync().await;
    e.mock.set_online(false);
    e.unlink(&location); // UNLINK 가 서버에 가지 못한 채
    e.mock.set_online(true);
    e.assert_silent_relink(&location, &unit()).await;
}

#[tokio::test]
async fn same_next_list_relinks_silently() {
    let e = ready().await;
    let location = next(None);
    add(&e.storage, location.clone(), "next", STYLED);
    add(&e.storage, location.clone(), "next", "두 번째");
    e.link_then_unlink(&location).await;
    e.assert_silent_relink(&location, &Unit::list("default")).await;
}

#[tokio::test]
async fn same_named_list_relinks_silently() {
    let e = ready().await;
    let list = e.storage.with_conn(|c| service::create_list(c, None, "업무")).unwrap();
    let location = next(Some(&list.id));
    add(&e.storage, location.clone(), "next", STYLED);
    e.link_then_unlink(&location).await;
    e.assert_silent_relink(&location, &Unit::list(&list.id)).await;
}

#[tokio::test]
async fn same_day_with_an_image_relinks_silently() {
    let e = ready().await;
    let location = day(DATE);
    let item = add(&e.storage, location.clone(), "main", "이미지");
    let info = e.import_image(&item.id, PNG);
    // Staging 에서 충돌창을 만든 바로 그 모양
    let html = format!("글<div><img src=\"{}\" alt=\"붙여넣은 이미지\" style=\"width: 572px; height: auto;\"><br></div>", info.url);
    e.storage.with_conn(|c| service::update_content(c, &item.id, &html)).unwrap();
    e.link_then_unlink(&location).await;
    assert!(e.mock.unit_texts(1, &unit())[0].contains("height: auto\""), "서버는 끝의 ; 를 지워 저장한다");
    e.assert_silent_relink(&location, &unit()).await;
    assert_eq!(e.local(), vec![html], "로컬 본문·이미지 참조 그대로");
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM attachments"), 1, "이미지를 다시 받거나 복제하지 않는다");
    assert_eq!(e.mock.snapshot_state().images.len(), 1, "이미지를 다시 올리지 않는다");
}

#[tokio::test]
async fn unsent_edit_before_unlink_is_a_real_difference() {
    let e = ready().await;
    let location = day(DATE);
    let a = add(&e.storage, location.clone(), "main", "원래");
    e.link(&location);
    e.sync().await;
    e.storage.with_conn(|c| service::update_content(c, &a.id, "보내기 전에 해제")).unwrap();
    e.unlink(&location); // 자동 저장은 끝났지만 Push 전
    e.sync().await;
    e.link(&location);
    assert_eq!(e.sync().await.conflicts, 1, "실제로 다르다");
    assert_eq!(e.local(), vec!["보내기 전에 해제"]);
    assert_eq!(e.mock.unit_texts(1, &unit()), vec!["원래"]);
}

// ── C·E·F: 실제 차이는 언제나 비교 화면 ─────────────────────────────────

/// 해제 후 Web 에서 `change` 로 바꾸고 다시 연결 → 비교 화면, 양쪽 모두 그대로.
async fn assert_web_change_asks(e: &Env, change: impl FnOnce(&MockSyncTransport)) {
    let location = day(DATE);
    e.link_then_unlink(&location).await;
    let local = e.local();
    change(&e.mock);
    let server = e.mock.unit_texts(1, &unit());
    e.link(&location);
    assert_eq!(e.sync().await.conflicts, 1, "실제 차이 — 비교 화면을 연다");
    assert_eq!(e.status(&location), "conflict");
    assert_eq!(e.local(), local, "이 PC 내용을 덮어쓰지 않는다");
    assert_eq!(e.mock.unit_texts(1, &unit()), server, "서버 내용을 덮어쓰지 않는다");
}

#[tokio::test]
async fn web_edit_after_unlink_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", STYLED);
    assert_web_change_asks(&e, |mock| {
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_edit(memo, |m| m.content = format!("{STYLED}추가"));
    })
    .await;
    assert_eq!(e.conflicts(), 1);
    e.resolve_local().await;
    assert_eq!(e.status(&day(DATE)), "synced");
    assert!(e.storage.with_conn(|c| Ok(c.query_row(
        "SELECT COUNT(*) FROM document_versions WHERE reason = 'conflict_remote' AND content_text LIKE '%추가%'",
        [],
        |r| r.get::<_, i64>(0)
    )?)).unwrap() == 1, "선택하지 않은 내용을 보존한다");
}

impl Env {
    async fn resolve_local(&self) {
        let conflict = self.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
        self.engine.resolve_conflict(&self.storage, &conflict.id, ConflictChoice::Local).await.unwrap();
    }
}

#[tokio::test]
async fn completion_difference_asks_even_with_the_same_text() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", "같은 문장");
    assert_web_change_asks(&e, |mock| {
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_edit(memo, |m| m.completed = true);
    })
    .await;
}

#[tokio::test]
async fn formatting_difference_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", "<span style=\"color: red;\">글</span>");
    assert_web_change_asks(&e, |mock| {
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_edit(memo, |m| m.content = "<span style=\"color: blue\">글</span>".into());
    })
    .await;
}

#[tokio::test]
async fn added_item_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", "하나");
    assert_web_change_asks(&e, |mock| {
        mock.web_create(1, &unit(), "main", "Web 에서 추가");
    })
    .await;
}

#[tokio::test]
async fn deleted_item_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", "하나");
    add(&e.storage, day(DATE), "main", "둘");
    assert_web_change_asks(&e, |mock| {
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_delete(memo);
    })
    .await;
}

#[tokio::test]
async fn order_difference_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", "하나");
    add(&e.storage, day(DATE), "main", "둘");
    assert_web_change_asks(&e, |mock| {
        let items = mock.unit_items(1, &unit());
        let (first, second) = (items[0].0, items[1].0);
        mock.web_edit(first, |m| m.sort_order = 5);
        mock.web_edit(second, |m| m.sort_order = 1);
    })
    .await;
}

#[tokio::test]
async fn section_difference_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "am", "오전 일");
    assert_web_change_asks(&e, |mock| {
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_edit(memo, |m| m.section = "pm".into());
    })
    .await;
}

#[tokio::test]
async fn kind_difference_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", "같은 문장");
    assert_web_change_asks(&e, |mock| {
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_edit(memo, |m| m.kind = "text".into());
    })
    .await;
}

#[tokio::test]
async fn deleted_document_on_the_server_asks() {
    let e = ready().await;
    add(&e.storage, day(DATE), "main", "하나");
    assert_web_change_asks(&e, |mock| mock.web_tombstone(1, &unit())).await;
}

#[tokio::test]
async fn different_image_with_the_same_text_asks() {
    let e = ready().await;
    let location = day(DATE);
    let item = add(&e.storage, location.clone(), "main", "이미지");
    let info = e.import_image(&item.id, PNG);
    let html = format!("같은 글<img src=\"{}\" style=\"width: 10px;\">", info.url);
    e.storage.with_conn(|c| service::update_content(c, &item.id, &html)).unwrap();
    assert_web_change_asks(&e, |mock| {
        let mut other = PNG.to_vec();
        other.extend_from_slice(b"other");
        let name = mock.web_upload_image(1, &other);
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_edit(memo, |m| m.content = format!("같은 글<img src=\"/api/personal-memos/images/{name}/download\" style=\"width: 10px\">"));
    })
    .await;
}

#[tokio::test]
async fn image_size_difference_asks() {
    let e = ready().await;
    let item = add(&e.storage, day(DATE), "main", "이미지");
    let info = e.import_image(&item.id, PNG);
    let html = format!("글<img src=\"{}\" style=\"width: 10px;\">", info.url);
    e.storage.with_conn(|c| service::update_content(c, &item.id, &html)).unwrap();
    assert_web_change_asks(&e, |mock| {
        let memo = mock.unit_items(1, &unit())[0].0;
        mock.web_edit(memo, |m| m.content = m.content.replace("width: 10px", "width: 90px"));
    })
    .await;
}

// ── D: 내부 표현만 다른 경우 ────────────────────────────────────────────

#[tokio::test]
async fn first_link_with_only_representation_differences_does_not_ask() {
    let e = ready().await;
    let location = day(DATE);
    // 이 PC 와 Web 에 따로 쓴, 표현만 다른 같은 내용
    add(&e.storage, location.clone(), "main", "<a rel=\"r\" href=\"https://a.test/x\">링크</a><br/>A&#38;B <span style=\"COLOR: red ;\">글</span>");
    e.mock.web_create(1, &unit(), "main", "<a href=\"https://a.test/x\" rel=\"r\">링크</a><br>A&amp;B <span style=\"color: red\">글</span>");
    e.link(&location);
    let report = e.sync().await;
    assert_eq!(report.conflicts, 0);
    assert_eq!(e.status(&location), "synced");
    assert!(e.mock.pushes().is_empty(), "같은 내용 — 보내지 않는다");
}

#[tokio::test]
async fn relink_is_silent_when_the_server_removed_something_we_cannot_predict() {
    // 규칙을 모르는 정리 — 서버가 받아 준 짝을 기억하므로 양쪽이 그대로면 같은 내용이다.
    let e = ready().await;
    let location = day(DATE);
    let html = "<span data-server-strips=\"x\">글</span>";
    add(&e.storage, location.clone(), "main", html);
    e.link_then_unlink(&location).await;
    assert_eq!(e.mock.unit_texts(1, &unit()), vec!["<span>글</span>"], "서버가 속성을 지웠다");
    e.assert_silent_relink(&location, &unit()).await;
    assert_eq!(e.local(), vec![html], "로컬은 그대로");
}

#[tokio::test]
async fn remembered_pair_never_hides_a_later_change() {
    let e = ready().await;
    let location = day(DATE);
    let item = add(&e.storage, location.clone(), "main", "<span data-server-strips=\"x\">글</span>");
    e.link_then_unlink(&location).await;
    // 이 PC 만 고침
    e.storage.with_conn(|c| service::update_content(c, &item.id, "<span data-server-strips=\"y\">글</span>")).unwrap();
    e.link(&location);
    let report = e.sync().await;
    // 서버가 정리한 제안이 서버 현재와 같다 — 서버 기준으로 같은 내용이므로 묻지 않는다(양쪽 내용은 그대로).
    assert_eq!(report.conflicts, 0);
    assert_eq!(e.local(), vec!["<span data-server-strips=\"y\">글</span>"]);
    // Web 도 바뀌면 묻는다
    e.unlink(&location);
    e.sync().await;
    let memo = e.mock.unit_items(1, &unit())[0].0;
    e.mock.web_edit(memo, |m| m.content = "<span>Web 글</span>".into());
    e.link(&location);
    assert_eq!(e.sync().await.conflicts, 1);
}

// ── 이미 열린 비교·서버에 남은 비교 ─────────────────────────────────────

fn proposal_of(e: &Env, base_version: i64, content: &str) -> PushRequest {
    let doc = e.mock.document_of(1, &unit()).unwrap();
    let link_id = e.mock.snapshot_state().links.iter().find(|(_, l)| l.document_id == doc.id && l.active).unwrap().0.clone();
    let existing = e.mock.unit_items(1, &unit());
    PushRequest {
        base_version,
        local_version: 1,
        request_id: uuid::Uuid::new_v4().to_string(),
        link_id,
        deleted: false,
        items: vec![PushItem {
            id: Some(existing[0].0),
            item_version: None,
            client_key: None,
            section: "main".into(),
            kind: "checklist".into(),
            content: content.into(),
            completed: false,
            sort_order: 0,
        }],
    }
}

fn ctx(e: &Env) -> SyncContext {
    let s = e.auth.session_context().unwrap();
    SyncContext { access_token: s.access_token, account_key: s.account_key, server_device_id: s.server_device_id }
}

#[tokio::test]
async fn false_conflict_left_by_the_previous_version_closes_itself() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    e.link(&location);
    e.sync().await;
    // v0.2.6 이 표현 차이로 base 0 제안을 보내 열어 둔 비교를 재현
    let doc = e.mock.document_of(1, &unit()).unwrap();
    e.mock.push(&ctx(&e), &doc.id, &proposal_of(&e, 0, STYLED)).await.unwrap();
    assert_eq!(e.mock.open_conflicts(&doc.id).len(), 1);
    let (doc_id, remote): (String, String) = e
        .storage
        .with_conn(|c| {
            let d = repo::doc_for_location(c, &location)?.unwrap();
            let mut snapshot = repo::build_snapshot(c, &d, false)?;
            snapshot.items[0].content_html = snapshot.items[0].content_html.replace(";\"", "\"");
            Ok((d.id, serde_json::to_string(&snapshot)?))
        })
        .unwrap();
    let conflict_id = e.mock.open_conflicts(&doc.id)[0].0.clone();
    e.storage
        .with_conn(|c| {
            c.execute(
                "INSERT INTO conflicts (id, document_id, local_snapshot_json, remote_snapshot_json, local_revision, remote_version,
                                        server_conflict_id, source, account_key, created_at, updated_at)
                 VALUES ('old', ?1, ?2, ?2, 1, ?3, ?4, 'desktop', ?5, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')",
                rusqlite::params![doc_id, remote, doc.version, conflict_id, e.account()],
            )?;
            c.execute("UPDATE documents SET sync_status = 'conflict' WHERE id = ?1", [&doc_id])?;
            Ok(())
        })
        .unwrap();
    assert_eq!(e.conflicts(), 1);
    let before = e.local();
    let report = e.sync().await;
    assert_eq!(report.conflicts, 0);
    assert_eq!(e.conflicts(), 0, "같은 내용의 비교는 스스로 닫힌다");
    assert!(e.mock.open_conflicts(&doc.id).is_empty(), "서버의 비교도 닫힌다");
    assert_eq!(e.status(&location), "synced");
    assert_eq!(e.local(), before, "내용은 그대로");
}

#[tokio::test]
async fn server_conflict_left_before_unlink_closes_when_everything_is_the_same() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    e.link(&location);
    e.sync().await;
    let doc = e.mock.document_of(1, &unit()).unwrap();
    e.mock.push(&ctx(&e), &doc.id, &proposal_of(&e, 0, STYLED)).await.unwrap();
    e.unlink(&location);
    e.sync().await;
    e.link(&location);
    let report = e.sync().await;
    assert_eq!(report.conflicts, 0);
    e.sync().await;
    assert_eq!(e.conflicts(), 0);
    assert!(e.mock.open_conflicts(&doc.id).is_empty());
    assert_eq!(e.status(&location), "synced");
}

#[tokio::test]
async fn another_devices_different_proposal_is_never_closed() {
    // 비교 목록은 기기별이 아니다 — 이 PC 와 서버가 같아도, 다른 내용의 제안이 있으면 닫지 않는다.
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    e.link(&location);
    e.sync().await;
    let doc = e.mock.document_of(1, &unit()).unwrap();
    e.mock.push(&ctx(&e), &doc.id, &proposal_of(&e, 0, "다른 기기의 다른 내용")).await.unwrap();
    e.unlink(&location);
    e.sync().await;
    e.link(&location);
    e.sync().await;
    e.sync().await;
    assert_eq!(e.mock.open_conflicts(&doc.id).len(), 1, "제안을 지우지 않는다");
    assert_eq!(e.conflicts(), 1, "사용자가 판단한다");
}

// ── G·H·I: 오프라인·재전송·계정 ─────────────────────────────────────────

#[tokio::test]
async fn offline_edits_on_both_sides_keep_both() {
    let e = ready().await;
    let location = day(DATE);
    let a = add(&e.storage, location.clone(), "main", "원래");
    e.link_then_unlink(&location).await;
    e.mock.set_online(false);
    e.storage.with_conn(|c| service::update_content(c, &a.id, "오프라인 Desktop")).unwrap();
    e.mock.set_online(true);
    let memo = e.mock.unit_items(1, &unit())[0].0;
    e.mock.web_edit(memo, |m| m.content = "Web 수정".into());
    e.mock.set_online(false);
    e.link(&location);
    e.sync().await;
    assert_eq!(e.status(&location), "pending", "연결되면 비교한다");
    e.mock.set_online(true);
    assert_eq!(e.sync().await.conflicts, 1);
    assert_eq!(e.local(), vec!["오프라인 Desktop"]);
    assert_eq!(e.mock.unit_texts(1, &unit()), vec!["Web 수정"]);
    let conflict = e.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
    assert_eq!(conflict.local.items[0].content_html, "오프라인 Desktop");
    assert_eq!(conflict.remote.items[0].content_html, "Web 수정");
}

#[tokio::test]
async fn lost_responses_while_relinking_do_not_duplicate() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    e.link_then_unlink(&location).await;
    let version = e.server_version(&unit());
    let links_before = e.mock.snapshot_state().links.len();
    e.link(&location);
    e.mock.inject("link", TransportError::Offline);
    e.sync().await;
    assert_eq!(e.status(&location), "pending", "응답을 못 받으면 연결 대기");
    e.mock.inject("document", TransportError::Offline);
    e.sync().await;
    assert_eq!(e.status(&location), "pending");
    let report = e.sync().await;
    assert_eq!(report.conflicts, 0);
    assert_eq!(e.status(&location), "synced");
    let state = e.mock.snapshot_state();
    assert_eq!(state.documents.len(), 1);
    assert_eq!(state.links.values().filter(|l| l.active).count(), 1, "활성 연결은 하나");
    assert!(state.links.len() <= links_before + 1);
    assert_eq!(e.mock.unit_texts(1, &unit()).len(), 1, "항목 중복 없음");
    assert_eq!(e.server_version(&unit()), version);
}

#[tokio::test]
async fn another_account_does_not_inherit_the_remembered_pair() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", "<span data-server-strips=\"x\">글</span>");
    e.link_then_unlink(&location).await;
    let account = e.account();
    assert_eq!(count(&e.storage, &format!("SELECT COUNT(*) FROM sync_state WHERE key LIKE 'accepted|{account}|%'")), 1);
    // 같은 날짜를 다른 계정에서 — 그 계정의 서버 문서에 다른 내용이 있다
    e.auth.logout().await.unwrap();
    e.storage.with_conn(|c| plan_a_memo_lib::sync::engine::end_account_links(c, &account)).unwrap();
    e.login(2).await;
    e.mock.web_create(2, &unit(), "main", "다른 계정의 내용");
    e.link(&location);
    assert_eq!(e.sync().await.conflicts, 1, "다른 계정에는 이전 확인을 쓰지 않는다");
    assert_eq!(e.mock.unit_texts(2, &unit()), vec!["다른 계정의 내용"]);
    assert_eq!(e.mock.unit_texts(1, &unit()), vec!["<span>글</span>"], "이전 계정의 서버 내용은 그대로");
}

#[tokio::test]
async fn linking_right_after_registering_a_new_device_works() {
    // 로그아웃 뒤 다시 로그인하면 서버 기기가 바뀐다. 첫 Sync 전에 연결해도(계정 화면은 로그인 직후 바로 연결한다) 멈추지 않는다.
    let e = ready().await;
    let (location, older) = (day(DATE), day("2026-11-05"));
    add(&e.storage, location.clone(), "main", STYLED);
    add(&e.storage, older.clone(), "main", "이전 기기로 연결한 메모");
    e.link_then_unlink(&location).await;
    e.link(&older);
    e.sync().await;
    let account = e.account();
    e.auth.logout().await.unwrap();
    e.login(1).await;
    assert_eq!(e.account(), account);
    let device = e.auth.session_context().unwrap().server_device_id;
    // sync_link 명령과 같은 순서
    e.storage.with_conn(|c| plan_a_memo_lib::sync::engine::retire_previous_device(c, &account, &device)).unwrap();
    e.link(&location);
    let report = e.sync().await;
    assert_eq!(report.conflicts, 0);
    assert_eq!(e.status(&location), "synced", "방금 만든 연결은 지금 기기의 연결이다");
    assert_eq!(e.status(&older), "auth_required", "이전 기기의 연결은 이어받지 않는다");
    assert_eq!(e.conflicts(), 0);
}

#[tokio::test]
async fn revoked_device_cannot_relink() {
    let e = ready().await;
    let location = day(DATE);
    add(&e.storage, location.clone(), "main", STYLED);
    e.link_then_unlink(&location).await;
    let device = e.auth.session_context().unwrap().server_device_id;
    e.mock.web_revoke_device(&device);
    e.link(&location);
    let report = e.sync().await;
    assert!(report.auth_required, "폐기된 기기는 연결되지 않는다");
    assert_eq!(e.status(&location), "auth_required");
    assert_eq!(e.outbox(), 1, "연결 요청은 보관");
    assert_eq!(e.local(), vec![STYLED]);
}

#[tokio::test]
async fn moved_item_then_relink_only_compares_what_is_there() {
    let e = ready().await;
    let location = day(DATE);
    let a = add(&e.storage, location.clone(), "main", "옮길 메모");
    add(&e.storage, location.clone(), "main", "남는 메모");
    e.link_then_unlink(&location).await;
    // 연결 해제 뒤 이 PC 에서 다른 날짜로 옮기면 실제 차이다 — 비교 화면
    e.storage
        .with_conn(|c| {
            service::move_item(c, MoveItem { id: a.id.clone(), target: day("2026-11-05"), section: None, index: None, policy: None }).map(|_| ())
        })
        .unwrap();
    e.link(&location);
    assert_eq!(e.sync().await.conflicts, 1);
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM documents WHERE memo_date = '2026-11-05' AND sync_enabled = 1"), 0, "옮긴 날짜는 연결하지 않는다");
}

// ── NEXT_LIST: 기본·이름 있는 List 모두 DAY 와 같은 기준 ─────────────────

/// 삭제되지 않은 메모의 (구역, 본문, 체크) — 순서대로.
fn list_rows(e: &Env, location: &Location) -> Vec<(String, String, bool)> {
    e.storage
        .with_conn(|c| {
            let doc = repo::doc_for_location(c, location)?.unwrap();
            Ok(c.prepare("SELECT section, content_html, completed FROM memo_items WHERE document_id = ?1 AND deleted_at IS NULL ORDER BY section, sort_order")?
                .query_map([&doc.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?)
        })
        .unwrap()
}

/// 기본 List·이름 있는 List 각각 새 환경에서: 내용 준비 → 연결 → 해제 → Web 변경 → 재연결.
async fn assert_list_change_asks(change: fn(&MockSyncTransport, &Unit)) {
    for named in [false, true] {
        let e = ready().await;
        let list_id = named.then(|| e.storage.with_conn(|c| service::create_list(c, None, "업무")).unwrap().id);
        let location = next(list_id.as_deref());
        let list_unit = Unit::list(list_id.as_deref().unwrap_or("default"));
        add(&e.storage, location.clone(), "next", STYLED);
        add(&e.storage, location.clone(), "next", "두 번째");
        e.link_then_unlink(&location).await;
        let local = list_rows(&e, &location);
        change(&e.mock, &list_unit);
        let server = e.mock.unit_texts(1, &list_unit);
        e.link(&location);
        assert_eq!(e.sync().await.conflicts, 1, "실제 차이 — 비교 화면(named={named})");
        assert_eq!(e.status(&location), "conflict");
        assert_eq!(list_rows(&e, &location), local, "이 PC 내용을 덮어쓰지 않는다(named={named})");
        assert_eq!(e.mock.unit_texts(1, &list_unit), server, "서버 내용을 덮어쓰지 않는다(named={named})");
    }
}

#[tokio::test]
async fn next_list_web_edit_asks() {
    assert_list_change_asks(|mock, unit| {
        let memo = mock.unit_items(1, unit)[0].0;
        mock.web_edit(memo, |m| m.content.push_str("추가"));
    })
    .await;
}

#[tokio::test]
async fn next_list_completion_difference_asks() {
    assert_list_change_asks(|mock, unit| {
        let memo = mock.unit_items(1, unit)[0].0;
        mock.web_edit(memo, |m| m.completed = true);
    })
    .await;
}

#[tokio::test]
async fn next_list_formatting_difference_asks() {
    assert_list_change_asks(|mock, unit| {
        let memo = mock.unit_items(1, unit)[1].0;
        mock.web_edit(memo, |m| m.content = "<b>두 번째</b>".into());
    })
    .await;
}

#[tokio::test]
async fn next_list_added_and_deleted_items_ask() {
    assert_list_change_asks(|mock, unit| {
        mock.web_create(1, unit, "main", "Web 에서 추가");
    })
    .await;
    assert_list_change_asks(|mock, unit| {
        let memo = mock.unit_items(1, unit)[0].0;
        mock.web_delete(memo);
    })
    .await;
}

#[tokio::test]
async fn next_list_order_difference_asks() {
    assert_list_change_asks(|mock, unit| {
        let items = mock.unit_items(1, unit);
        let (first, second) = (items[0].0, items[1].0);
        mock.web_edit(first, |m| m.sort_order = 5);
        mock.web_edit(second, |m| m.sort_order = 1);
    })
    .await;
}

#[tokio::test]
async fn next_list_with_an_image_relinks_silently_every_time() {
    let e = ready().await;
    let location = next(None);
    let item = add(&e.storage, location.clone(), "next", "이미지");
    let info = e.import_image(&item.id, PNG);
    let html = format!("글<div><img src=\"{}\" alt=\"붙여넣은 이미지\" style=\"width: 572px; height: auto;\"><br></div>", info.url);
    e.storage.with_conn(|c| service::update_content(c, &item.id, &html)).unwrap();
    e.storage.with_conn(|c| service::set_completed(c, &item.id, true)).unwrap();
    e.link(&location);
    e.sync().await;
    let list_unit = Unit::list("default");
    for _ in 0..3 {
        e.unlink(&location);
        e.sync().await;
        e.assert_silent_relink(&location, &list_unit).await;
    }
    assert_eq!(list_rows(&e, &location), vec![("next".to_string(), html, true)], "본문·이미지 참조·체크 그대로");
    assert_eq!(count(&e.storage, "SELECT COUNT(*) FROM attachments"), 1);
}

// ── 앱을 다시 켠 뒤·Web 쪽을 고른 뒤 ─────────────────────────────────────

#[tokio::test]
async fn relink_after_restart_still_uses_what_the_server_accepted() {
    let mut e = ready().await;
    let location = day(DATE);
    let html = "<span data-server-strips=\"x\" style=\"color: red;\">글</span>";
    add(&e.storage, location.clone(), "main", html);
    e.link_then_unlink(&location).await;
    let root = e.storage.paths.root.clone();
    // 프로그램 재시작 — 기억은 SQLite 에 있다
    e.storage = Storage::open(&root, false).unwrap().0;
    e.assert_silent_relink(&location, &unit()).await;
    assert_eq!(e.local(), vec![html]);
    // 재시작 뒤에도 실제 변경은 숨기지 않는다
    e.unlink(&location);
    e.sync().await;
    let memo = e.mock.unit_items(1, &unit())[0].0;
    e.mock.web_edit(memo, |m| m.content.push_str("추가"));
    e.link(&location);
    assert_eq!(e.sync().await.conflicts, 1);
    assert_eq!(e.local(), vec![html]);
}

#[tokio::test]
async fn choosing_the_web_side_keeps_this_pc_content_and_the_next_relink_is_silent() {
    let e = ready().await;
    let location = day(DATE);
    let item = add(&e.storage, location.clone(), "main", STYLED);
    e.storage.with_conn(|c| service::set_completed(c, &item.id, true)).unwrap();
    e.link_then_unlink(&location).await;
    let memo = e.mock.unit_items(1, &unit())[0].0;
    e.mock.web_edit(memo, |m| m.content = "Web 에서 고친 내용".into());
    e.link(&location);
    assert_eq!(e.sync().await.conflicts, 1);
    let conflict = e.storage.with_conn(|c| list_conflicts(c)).unwrap().remove(0);
    e.engine.resolve_conflict(&e.storage, &conflict.id, ConflictChoice::Remote).await.unwrap();
    e.sync().await;
    assert_eq!(e.status(&location), "synced");
    assert_eq!(e.local(), vec!["Web 에서 고친 내용"], "고른 내용");
    assert_eq!(e.mock.unit_texts(1, &unit()), vec!["Web 에서 고친 내용"]);
    assert_eq!(
        count(&e.storage, "SELECT COUNT(*) FROM document_versions WHERE reason = 'conflict_local' AND content_text LIKE '%내용 업데이트%'"),
        1,
        "고르지 않은 이 PC 내용을 보존한다"
    );
    // 고른 뒤에는 같은 내용 — 다시 묻지 않는다
    e.unlink(&location);
    e.sync().await;
    e.assert_silent_relink(&location, &unit()).await;
}
