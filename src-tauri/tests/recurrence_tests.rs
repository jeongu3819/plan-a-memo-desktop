//! 요일마다 생성 — 규칙(이 PC 메타데이터) · 필요한 날짜에만 회차 · 중복 방지 · 중지 · 연결된 날짜 보호 · Migration v7.

mod common;

use common::*;
use plan_a_memo_lib::attachments;
use plan_a_memo_lib::memo::{carryover, recurrence, repo, service};
use plan_a_memo_lib::storage::{migrations, Storage, StoragePaths};
use plan_a_memo_lib::sync::link;

/// 2026-11-14 = 토요일
const TODAY: &str = "2026-11-14";

fn fill(s: &Storage, dates: &[&str]) -> usize {
    let dates: Vec<String> = dates.iter().map(|d| d.to_string()).collect();
    s.with_conn(|c| recurrence::materialize(c, &s.paths, TODAY, &dates)).unwrap()
}

fn items(s: &Storage, date: &str) -> Vec<plan_a_memo_lib::memo::MemoItem> {
    s.with_conn(|c| service::get_day(c, date)).unwrap().items
}

fn start(s: &Storage, item_id: &str) -> recurrence::RecurrenceInfo {
    s.with_conn(|c| recurrence::create(c, &s.paths, item_id, TODAY)).unwrap()
}

fn link_day(s: &Storage, date: &str) {
    s.with_conn(|c| {
        let doc = repo::ensure_doc(c, &day(date))?;
        link::enable_link(c, &doc.id, "local:test|1")
    })
    .unwrap();
}

#[test]
fn weekly_occurrences_follow_the_memo_weekday_from_next_week() {
    let (_d, s) = temp_storage();
    let src = add(&s, day("2026-11-14"), "am", "<p>VOC 개선사항 <strong>확인</strong></p>");
    s.with_conn(|c| service::set_completed(c, &src.id, true)).unwrap();
    let info = start(&s, &src.id);
    assert_eq!(info.weekday, Some(6), "토요일");
    let rule = info.rule.expect("반복 중");
    assert_eq!(rule.role, "source");
    assert_eq!(rule.starts_on, "2026-11-21");

    // 원본 날짜에는 다시 만들지 않는다
    assert_eq!(items(&s, "2026-11-14").len(), 1);
    // 가까운 2주는 바로 만들어진다 — 같은 구역·유형·서식, 미완료, 새 id
    for date in ["2026-11-21", "2026-11-28"] {
        let day_items = items(&s, date);
        assert_eq!(day_items.len(), 1, "{date}");
        let occ = &day_items[0];
        assert_ne!(occ.id, src.id);
        assert_eq!(occ.section, "am");
        assert_eq!(occ.kind, "checklist");
        assert_eq!(occ.content_html, src.content_html);
        assert!(!occ.completed, "원본이 완료여도 회차는 미완료");
        let info = s.with_conn(|c| recurrence::info(c, &occ.id, TODAY)).unwrap();
        assert_eq!(info.rule.unwrap().role, "occurrence");
    }
    // 다른 요일·2주 밖은 아직 없다(무한히 미리 만들지 않는다)
    assert!(items(&s, "2026-11-22").is_empty());
    assert!(items(&s, "2026-12-05").is_empty());
    // 먼 날짜를 읽을 때만 그 날짜를 만든다(사이의 날짜는 만들지 않는다)
    assert_eq!(fill(&s, &["2027-01-02"]), 1);
    assert_eq!(items(&s, "2027-01-02").len(), 1);
    assert!(items(&s, "2026-12-26").is_empty());
    // 몇 번을 불러도 중복되지 않는다
    for _ in 0..5 {
        assert_eq!(fill(&s, &["2026-11-21", "2026-11-28", "2027-01-02"]), 0);
    }
    assert_eq!(items(&s, "2026-11-21").len(), 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_recurrence_occurrences"), 3);
    // 다시 눌러도 규칙은 하나
    start(&s, &src.id);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_recurrences"), 1);
}

#[test]
fn horizon_moves_with_today_and_rules_survive_restart() {
    let dir = temp_dir();
    let root = dir.path().join("PLAN-A Memo");
    {
        let (s, _) = Storage::open(&root, true).unwrap();
        let src = add(&s, day("2026-11-16"), "main", "주간 회의 준비"); // 월요일
        let info = start(&s, &src.id);
        assert_eq!(info.weekday, Some(1));
        assert_eq!(items(&s, "2026-11-23").len(), 1);
        assert!(items(&s, "2026-11-30").is_empty(), "오늘(11-14)+14일 밖");
        s.close();
    }
    let (s, _) = Storage::open(&root, false).unwrap();
    // 일주일 뒤 앱을 다시 연 날 — 그만큼 더 만든다
    let later: Vec<String> = Vec::new();
    s.with_conn(|c| recurrence::materialize(c, &s.paths, "2026-11-21", &later)).unwrap();
    assert_eq!(items(&s, "2026-11-30").len(), 1);
    assert_eq!(items(&s, "2026-11-23").len(), 1, "이미 있던 회차는 그대로 하나");
}

#[test]
fn identical_text_written_by_the_user_is_left_alone() {
    let (_d, s) = temp_storage();
    let src = add(&s, day("2026-11-14"), "main", "VOC 개선사항 확인");
    let mine = add(&s, day("2026-11-21"), "main", "VOC 개선사항 확인");
    start(&s, &src.id);
    let day_items = items(&s, "2026-11-21");
    assert_eq!(day_items.len(), 2, "같은 글이라도 직접 쓴 메모와 회차는 따로");
    assert!(day_items.iter().any(|i| i.id == mine.id));
    s.with_conn(|c| recurrence::stop(c, &recurrence::info(c, &src.id, TODAY)?.rule.unwrap().id, TODAY)).unwrap();
    assert!(items(&s, "2026-11-21").iter().any(|i| i.id == mine.id), "중지해도 직접 쓴 메모는 남는다");
}

#[test]
fn each_occurrence_is_independent_and_deleted_ones_do_not_come_back() {
    let (_d, s) = temp_storage();
    let src = add(&s, day("2026-11-14"), "main", "보고서");
    start(&s, &src.id);
    let a = items(&s, "2026-11-21").remove(0);
    let b = items(&s, "2026-11-28").remove(0);
    // 한 회차만 고치고·완료해도 다른 날짜·원본은 그대로
    s.with_conn(|c| service::update_content(c, &a.id, "보고서 — 11/21 버전")).unwrap();
    s.with_conn(|c| service::set_completed(c, &a.id, true)).unwrap();
    assert_eq!(items(&s, "2026-11-28")[0].content_html, "보고서");
    assert!(!items(&s, "2026-11-28")[0].completed);
    assert_eq!(items(&s, "2026-11-14")[0].content_html, "보고서");
    // 원본을 고쳐도 이미 만든 회차는 그대로
    s.with_conn(|c| service::update_content(c, &src.id, "보고서(원본 수정)")).unwrap();
    assert_eq!(items(&s, "2026-11-28")[0].content_html, "보고서");
    // 이 항목만 삭제 → 다시 읽어도 되살아나지 않는다
    s.with_conn(|c| service::delete_item(c, &b.id)).unwrap();
    fill(&s, &["2026-11-28"]);
    assert!(items(&s, "2026-11-28").is_empty());
    // 다른 날로 옮겨도 원래 날짜에 다시 생기지 않는다
    s.with_conn(|c| {
        service::move_item(c, service::MoveItem { id: a.id.clone(), target: day("2026-11-24"), section: None, index: None, policy: None })
    })
    .unwrap();
    fill(&s, &["2026-11-21"]);
    assert!(items(&s, "2026-11-21").is_empty());
    // 원본을 지워도 반복은 계속된다(규칙은 반복을 시작할 때의 본문을 쓴다)
    s.with_conn(|c| service::delete_item(c, &src.id)).unwrap();
    fill(&s, &["2027-01-02"]);
    assert_eq!(items(&s, "2027-01-02")[0].content_html, "보고서");
}

#[test]
fn stopping_keeps_past_and_touched_occurrences_and_removes_untouched_future_ones() {
    let (_d, s) = temp_storage();
    let src = add(&s, day("2026-10-31"), "main", "주간 점검"); // 지난 토요일
    let info = start(&s, &src.id);
    assert_eq!(info.rule.as_ref().unwrap().starts_on, "2026-11-14", "지난 날짜를 채우지 않고 오늘부터");
    assert!(items(&s, "2026-11-07").is_empty());
    let today_occ = items(&s, "2026-11-14").remove(0);
    let touched = items(&s, "2026-11-21").remove(0);
    s.with_conn(|c| service::update_content(c, &touched.id, "주간 점검 + 메모")).unwrap();
    assert_eq!(items(&s, "2026-11-28").len(), 1);
    fill(&s, &["2027-01-02"]);

    let rule_id = info.rule.unwrap().id;
    // 확인창용 미리 보기 — 중지와 같은 수를 알려 주고 아무것도 바꾸지 않는다(취소하면 그대로)
    let versions = count(&s, "SELECT COUNT(*) FROM document_versions");
    for _ in 0..2 {
        let preview = s.with_conn(|c| recurrence::stop_preview(c, &rule_id, TODAY)).unwrap();
        assert_eq!((preview.removed, preview.kept), (2, 1));
    }
    assert_eq!(items(&s, "2026-11-28").len(), 1, "미리 보기는 지우지 않는다");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_recurrences WHERE stopped_at IS NULL"), 1, "미리 보기는 중지하지 않는다");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM document_versions"), versions);
    let result = s.with_conn(|c| recurrence::stop(c, &rule_id, TODAY)).unwrap();
    assert_eq!(result.removed, 2, "11-28 · 1-2 (손대지 않은 앞으로의 회차)");
    assert_eq!(result.kept, 1, "고친 11-21");
    assert!(items(&s, "2026-11-14").iter().any(|i| i.id == today_occ.id), "오늘 회차는 남는다");
    assert!(items(&s, "2026-11-21").iter().any(|i| i.id == touched.id));
    assert!(items(&s, "2026-11-28").is_empty());
    assert!(items(&s, "2026-10-31").iter().any(|i| i.id == src.id), "원본은 남는다");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM document_versions WHERE reason = 'recurrence_stop'"), 2, "정리 전 상태는 History 에");
    // 중지 후에는 새로 만들지 않는다
    fill(&s, &["2027-01-09", "2026-12-05"]);
    assert!(items(&s, "2027-01-09").is_empty());
    assert!(items(&s, "2026-12-05").is_empty());
    let info = s.with_conn(|c| recurrence::info(c, &src.id, TODAY)).unwrap();
    assert!(info.rule.is_none());
    // 다시 누르면 새 규칙으로 다시 시작할 수 있다
    assert!(start(&s, &src.id).rule.is_some());
    assert_eq!(s.with_conn(|c| recurrence::stop(c, &rule_id, TODAY)).unwrap().removed, 0, "이미 중지된 규칙은 그대로");
}

#[test]
fn linked_days_are_never_touched_and_local_only_stays_local() {
    let (_d, s) = temp_storage();
    // 연결된 날짜의 메모는 반복을 시작할 수 없다(반복 규칙은 Sync Contract 에 없다)
    let shared = add(&s, day("2026-11-07"), "main", "공유 메모");
    link_day(&s, "2026-11-07");
    let info = s.with_conn(|c| recurrence::info(c, &shared.id, TODAY)).unwrap();
    assert!(info.blocked.is_some());
    let err = s.with_conn(|c| recurrence::create(c, &s.paths, &shared.id, TODAY)).unwrap_err();
    assert_eq!(err.code(), recurrence::LINKED_CODE);

    // Local-only 원본 — 연결된 회차 날짜(11-21)에는 넣지 않는다(자동 업로드 금지)
    let local = add(&s, day("2026-11-14"), "main", "Local-only 할 일");
    add(&s, day("2026-11-21"), "main", "Web 과 공유하는 날");
    link_day(&s, "2026-11-21");
    s.with_conn(|c| Ok(c.execute("DELETE FROM sync_outbox", [])?)).unwrap();
    start(&s, &local.id);
    assert_eq!(items(&s, "2026-11-21").len(), 1, "연결된 날짜에는 회차 없음");
    assert_eq!(items(&s, "2026-11-28").len(), 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM sync_outbox"), 0, "아무것도 보내지 않는다");
    let source_doc = s.with_conn(|c| repo::doc_for_location(c, &day("2026-11-14"))).unwrap().unwrap();
    let occ_doc = s.with_conn(|c| repo::doc_for_location(c, &day("2026-11-28"))).unwrap().unwrap();
    assert!(!source_doc.sync_enabled && !occ_doc.sync_enabled);
    assert_eq!(occ_doc.sync_status, "local_only");

    // NEXT_LIST 는 대상이 아니다
    let listed = add(&s, next(None), "next", "날짜 없음");
    let info = s.with_conn(|c| recurrence::info(c, &listed.id, TODAY)).unwrap();
    assert_eq!(info.weekday, None);
    assert!(info.blocked.is_some());
    assert!(s.with_conn(|c| recurrence::create(c, &s.paths, &listed.id, TODAY)).is_err());
}

#[test]
fn carryover_does_not_offer_an_item_that_already_recurs_on_that_day() {
    let (_d, s) = temp_storage();
    // 11-07 원본(미완료) → 11-14 회차. 11-14 의 '지난주 미완료 가져오기' 에서 원본을 다시 권하지 않는다.
    let src = add(&s, day("2026-11-07"), "main", "반복 할 일");
    let other = add(&s, day("2026-11-07"), "main", "그냥 할 일");
    start(&s, &src.id);
    assert_eq!(items(&s, "2026-11-14").len(), 1);
    let offer = s.with_conn(|c| carryover::get(c, "2026-11-14", TODAY)).unwrap();
    let ids: Vec<&str> = offer.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec![other.id.as_str()]);
}

#[test]
fn occurrence_images_are_independent_copies_and_template_images_are_kept() {
    let (_d, s) = temp_storage();
    let src = add(&s, day("2026-11-14"), "main", "사진");
    let image = s.with_conn(|c| attachments::import_bytes(c, &s.paths, PNG, Some("a.png"), Some(&src.id))).unwrap();
    s.with_conn(|c| service::update_content(c, &src.id, &format!("사진 <img src=\"attachment://{}\">", image.id))).unwrap();
    start(&s, &src.id);
    let occ = items(&s, "2026-11-21").remove(0);
    let ids = plan_a_memo_lib::memo::text::attachment_ids(&occ.content_html);
    assert_eq!(ids.len(), 1);
    assert_ne!(ids[0], image.id, "회차는 새 첨부");
    // 원본을 완전히 지우고 정리해도 — 진행 중인 반복이 참조하므로 원본 이미지가 남아 이후 회차도 만든다
    s.with_conn(|c| Ok(c.execute("DELETE FROM memo_items WHERE id = ?1", [&src.id])?)).unwrap();
    s.with_conn(|c| Ok(c.execute("DELETE FROM document_versions", [])?)).unwrap();
    s.with_conn(|c| Ok(c.execute("UPDATE attachments SET created_at = '2000-01-01T00:00:00.000Z'", [])?)).unwrap();
    s.with_conn(|c| attachments::cleanup_unreferenced(c, &s.paths, false)).unwrap();
    assert!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, &image.id)).is_ok());
    fill(&s, &["2027-01-02"]);
    let far = items(&s, "2027-01-02").remove(0);
    let far_id = plan_a_memo_lib::memo::text::attachment_ids(&far.content_html).remove(0);
    assert_eq!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, &far_id)).unwrap().0, PNG);
}

#[test]
fn v6_database_upgrades_to_v7_and_keeps_memos() {
    let dir = temp_dir();
    let paths = StoragePaths::new(dir.path().join("PLAN-A Memo"));
    paths.ensure_dirs().unwrap();
    {
        let conn = plan_a_memo_lib::storage::open_connection(&paths.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
        )
        .unwrap();
        for m in migrations::MIGRATIONS.iter().filter(|m| m.version <= 6) {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations VALUES (?1, ?2, 'x', '2026-11-01T00:00:00.000Z')",
                rusqlite::params![m.version, m.name],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO documents (id, kind, memo_date, created_at, updated_at) VALUES ('d1', 'DAY', '2026-11-14', 'x', 'x')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memo_items (id, document_id, section, content_html, content_text, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-0000000000aa', 'd1', 'main', '예전 메모', '예전 메모', 'x', 'x')",
            [],
        )
        .unwrap();
    }
    let (s, report) = Storage::open(&paths.root, false).unwrap();
    assert!(report.applied_migrations.contains(&7), "{:?}", report.applied_migrations);
    assert_eq!(texts(&s, "2026-11-14"), vec!["예전 메모".to_string()]);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_recurrences"), 0);
    let info = start(&s, "00000000-0000-4000-8000-0000000000aa");
    assert!(info.rule.is_some());
}

#[test]
fn stop_preview_is_zero_when_every_future_occurrence_was_touched_or_already_stopped() {
    let (_d, s) = temp_storage();
    let src = add(&s, day("2026-11-14"), "main", "모두 손댄 반복");
    let rule_id = start(&s, &src.id).rule.unwrap().id;
    let a = items(&s, "2026-11-21").remove(0);
    let b = items(&s, "2026-11-28").remove(0);
    s.with_conn(|c| service::set_completed(c, &a.id, true)).unwrap();
    s.with_conn(|c| service::set_favorite(c, &b.id, true)).unwrap();
    let preview = s.with_conn(|c| recurrence::stop_preview(c, &rule_id, TODAY)).unwrap();
    assert_eq!((preview.removed, preview.kept), (0, 2), "정리할 회차가 없으면 화면은 확인창 없이 바로 중지한다");
    let result = s.with_conn(|c| recurrence::stop(c, &rule_id, TODAY)).unwrap();
    assert_eq!((result.removed, result.kept), (0, 2));
    assert_eq!(items(&s, "2026-11-21").len() + items(&s, "2026-11-28").len(), 2, "손댄 회차는 그대로");
    let after = s.with_conn(|c| recurrence::stop_preview(c, &rule_id, TODAY)).unwrap();
    assert_eq!((after.removed, after.kept), (0, 0), "이미 중지된 반복");
}
