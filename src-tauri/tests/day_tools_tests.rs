//! 날짜 상세 도구 — 다가오는 같은 요일 · 지난 미완료 가져오기(복사) · 날짜별 알림(DB 쪽) · Migration v3.
//! OS(작업 스케줄러·Windows 알림) 동작은 여기서 검증하지 않는다(e2e/reminder-os.mjs — 실제 설치본).

mod common;

use chrono::NaiveDate;
use common::*;
use plan_a_memo_lib::attachments;
use plan_a_memo_lib::memo::carryover;
use plan_a_memo_lib::memo::{repo, service};
use plan_a_memo_lib::reminders::{self, DueReminder};
use plan_a_memo_lib::storage::{backup, migrations, Storage, StoragePaths};
use plan_a_memo_lib::sync::link;

fn at(date: &str, time: &str) -> chrono::NaiveDateTime {
    chrono::NaiveDateTime::parse_from_str(&format!("{date}T{time}"), "%Y-%m-%dT%H:%M").unwrap()
}

fn complete(s: &Storage, id: &str) {
    s.with_conn(|c| service::set_completed(c, id, true)).unwrap();
}

fn add_text(s: &Storage, date: &str, section: &str, html: &str) {
    s.with_conn(|c| {
        service::create_item(
            c,
            service::CreateItem {
                id: uuid::Uuid::new_v4().to_string(),
                location: day(date),
                section: section.into(),
                kind: "text".into(),
                content_html: html.into(),
            },
        )
    })
    .unwrap();
}

// ── Migration ───────────────────────────────────────────────────────────

#[test]
fn v2_database_upgrades_to_v3_with_backup_and_keeps_memos() {
    let dir = tempfile::tempdir().unwrap();
    let paths = StoragePaths::new(dir.path().join("PLAN-A Memo"));
    paths.ensure_dirs().unwrap();
    {
        // 지난 버전(v2)의 DB — migration 1·2 만 적용하고 메모를 쓴다.
        let conn = plan_a_memo_lib::storage::open_connection(&paths.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
        )
        .unwrap();
        for m in migrations::MIGRATIONS.iter().filter(|m| m.version <= 2) {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations VALUES (?1, ?2, 'x', '2026-10-01T00:00:00.000Z')",
                rusqlite::params![m.version, m.name],
            )
            .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO documents (id, kind, memo_date, local_revision, created_at, updated_at)
               VALUES ('d1', 'DAY', '2026-10-03', 1, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
             INSERT INTO memo_items (id, document_id, section, kind, content_html, content_text, created_at, updated_at)
               VALUES ('11111111-1111-4111-8111-111111111111', 'd1', 'main', 'checklist', '보고서 작성', '보고서 작성',
                       '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z');",
        )
        .unwrap();
    }
    let (storage, report) = Storage::open(&paths.root, false).unwrap();
    // v3(day_tools) 다음 v4(memo_sync_v2 — 새 테이블만)까지 한 번에 적용된다.
    assert_eq!(report.applied_migrations, vec![3, 4]);
    let backup = report.backup_before_migration.expect("migration 전 자동 Backup");
    assert!(backup.contains("pre-migration-v3"));
    assert!(backup::list(&storage.paths).iter().any(|b| b.file_name.contains("pre-migration-v3")));
    assert_eq!(texts(&storage, "2026-10-03"), vec!["보고서 작성"], "기존 메모 그대로");
    for table in ["carryover_prompts", "item_copies", "day_reminders"] {
        assert_eq!(count(&storage, &format!("SELECT COUNT(*) FROM sqlite_master WHERE name = '{table}'")), 1, "{table}");
    }
    // 새 기능이 바로 동작
    let info = storage.with_conn(|c| carryover::get(c, "2026-10-10", "2026-10-10")).unwrap();
    assert_eq!(info.items.len(), 1);
}

// ── 다가오는 같은 요일 ───────────────────────────────────────────────────

#[test]
fn same_weekday_dates_after_a_day_only_lists_days_with_memos() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-10-17"), "main", "다음 주 토");
    add(&s, day("2026-10-31"), "pm", "3주 뒤 토");
    add(&s, day("2026-11-07"), "am", "4주 뒤 토");
    add(&s, day("2026-10-18"), "main", "일요일(다른 요일)");
    let removed = add(&s, day("2026-11-14"), "main", "지운 메모뿐");
    s.with_conn(|c| service::delete_item(c, &removed.id)).unwrap();
    let after_two_weeks = s.with_conn(|c| service::same_weekday_dates(c, "2026-10-24", 10)).unwrap();
    assert_eq!(after_two_weeks, vec!["2026-10-31", "2026-11-07"], "14일 뒤 이후의 같은 요일 · 메모 있는 날만");
    let limited = s.with_conn(|c| service::same_weekday_dates(c, "2026-10-10", 1)).unwrap();
    assert_eq!(limited, vec!["2026-10-17"]);
    // 연말 경계
    add(&s, day("2027-01-02"), "main", "새해 토");
    let year_end = s.with_conn(|c| service::same_weekday_dates(c, "2026-12-26", 5)).unwrap();
    assert_eq!(year_end, vec!["2027-01-02"]);
}

#[test]
fn editing_a_future_day_changes_only_that_day_document() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-10-10"), "main", "오늘");
    let future = add(&s, day("2026-10-17"), "main", "정기 점검");
    let today_rev = s.with_conn(|c| service::get_day(c, "2026-10-10")).unwrap().document.unwrap().local_revision;
    s.with_conn(|c| service::update_content(c, &future.id, "정기 점검(수정)")).unwrap();
    complete(&s, &future.id);
    assert_eq!(texts(&s, "2026-10-17"), vec!["정기 점검(수정)"]);
    assert!(s.with_conn(|c| service::get_day(c, "2026-10-17")).unwrap().items[0].completed);
    assert_eq!(texts(&s, "2026-10-10"), vec!["오늘"]);
    assert_eq!(
        s.with_conn(|c| service::get_day(c, "2026-10-10")).unwrap().document.unwrap().local_revision,
        today_rev,
        "보고 있던 날짜 문서는 바뀌지 않는다"
    );
}

// ── 지난 미완료 가져오기 ─────────────────────────────────────────────────

#[test]
fn carryover_lists_only_incomplete_checklists_of_last_week_same_day() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-03"), "main", "보고서 작성");
    let done = add(&s, day("2026-10-03"), "am", "완료한 일");
    complete(&s, &done.id);
    add_text(&s, "2026-10-03", "pm", "그냥 메모");
    let c = add(&s, day("2026-10-03"), "pm", "점검 결과 확인");
    add(&s, day("2026-10-02"), "main", "다른 날");
    let info = s.with_conn(|conn| carryover::get(conn, "2026-10-10", "2026-10-10")).unwrap();
    assert_eq!(info.source_date, "2026-10-03");
    assert!(info.available);
    assert!(info.auto_prompt, "이번 주 날짜 · 처음 · 가져올 항목 있음");
    let ids: Vec<&str> = info.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec![a.id.as_str(), c.id.as_str()], "완료·텍스트 제외, 메인→오후 순");

    // 미래 주의 날짜를 미리 열어도 저절로 안내하지 않는다
    let later = s.with_conn(|conn| carryover::get(conn, "2026-10-17", "2026-10-10")).unwrap();
    assert!(!later.available, "10/10 은 아직 지나지 않았다");
    assert!(!later.auto_prompt);
    assert!(later.items.is_empty());
    // 지난 주를 보고 있으면 수동으로만(자동 안내 없음)
    add(&s, day("2026-09-26"), "main", "2주 전 미완료");
    let past = s.with_conn(|conn| carryover::get(conn, "2026-10-03", "2026-10-10")).unwrap();
    assert!(past.available && !past.auto_prompt);
    assert_eq!(past.items.len(), 1);
}

#[test]
fn carryover_copies_selected_items_and_keeps_originals() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-03"), "main", "<b>보고서</b> 작성");
    let b = add(&s, day("2026-10-03"), "am", "자료 정리");
    let not_picked = add(&s, day("2026-10-03"), "pm", "점검 결과 확인");
    let existing = add(&s, day("2026-10-10"), "main", "이번 주에 이미 쓴 일");
    let source_rev = s.with_conn(|c| service::get_day(c, "2026-10-03")).unwrap().document.unwrap().local_revision;

    let result = s.with_conn(|c| carryover::import(c, &s.paths, "2026-10-10", &[a.id.clone(), b.id.clone()], "2026-10-10")).unwrap();
    assert_eq!(result.created.len(), 2);
    let target = s.with_conn(|c| service::get_day(c, "2026-10-10")).unwrap();
    let main: Vec<&str> = target.items.iter().filter(|i| i.section == "main").map(|i| i.content_html.as_str()).collect();
    assert_eq!(main, vec!["이번 주에 이미 쓴 일", "<b>보고서</b> 작성"], "기존 메모 뒤에 추가 · 서식 유지");
    assert!(target.items.iter().any(|i| i.section == "am" && i.content_html == "자료 정리"), "구역 유지");
    for copy in &result.created {
        assert_ne!(copy.id, a.id);
        assert_ne!(copy.id, b.id);
        assert!(!copy.completed);
        assert_eq!(copy.kind, "checklist");
    }
    assert!(target.items.iter().any(|i| i.id == existing.id));

    // 원본은 그대로(날짜·내용·완료 상태·문서 revision)
    let source = s.with_conn(|c| service::get_day(c, "2026-10-03")).unwrap();
    assert_eq!(source.items.len(), 3);
    assert!(source.items.iter().all(|i| !i.completed));
    assert_eq!(source.document.unwrap().local_revision, source_rev);
    assert!(source.items.iter().any(|i| i.id == a.id && i.content_html == "<b>보고서</b> 작성"));

    // 같은 요청 다시(재클릭·재시도·재실행) — 중복 없음
    let again = s.with_conn(|c| carryover::import(c, &s.paths, "2026-10-10", &[a.id.clone(), b.id.clone()], "2026-10-10")).unwrap();
    assert!(again.created.is_empty());
    assert_eq!(again.skipped, 2);
    assert_eq!(s.with_conn(|c| service::get_day(c, "2026-10-10")).unwrap().items.len(), 3);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM item_copies WHERE target_date = '2026-10-10'"), 2);
    // 남은 후보는 고르지 않은 것만, 이미 가져왔으니 저절로 안내하지 않는다
    let info = s.with_conn(|c| carryover::get(c, "2026-10-10", "2026-10-10")).unwrap();
    assert_eq!(info.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), vec![not_picked.id.clone()]);
    assert_eq!(info.status.as_deref(), Some("imported"));
    assert!(!info.auto_prompt);
    // 복사본을 완료해도 원본은 미완료
    complete(&s, &result.created[0].id);
    assert!(!s.with_conn(|c| repo::require_item(c, &a.id)).unwrap().completed);
}

#[test]
fn carryover_rejects_future_sources_and_foreign_items() {
    let (_d, s) = temp_storage();
    let other = add(&s, day("2026-10-02"), "main", "다른 날 항목");
    add(&s, day("2026-10-10"), "main", "이번 주 토");
    // 다른 날짜의 항목 id 는 가져오지 않는다
    let r = s.with_conn(|c| carryover::import(c, &s.paths, "2026-10-10", std::slice::from_ref(&other.id), "2026-10-10")).unwrap();
    assert!(r.created.is_empty());
    // 아직 지나지 않은 날짜에서 가져오기 거절
    let err = s.with_conn(|c| carryover::import(c, &s.paths, "2026-10-17", &[], "2026-10-10")).err().unwrap();
    assert_eq!(err.code(), "validation");
}

#[test]
fn skipping_is_remembered_across_restart() {
    let (dir, s) = temp_storage();
    add(&s, day("2026-10-03"), "main", "보고서 작성");
    s.with_conn(|c| carryover::mark_shown(c, "2026-10-10")).unwrap();
    assert!(s.with_conn(|c| carryover::get(c, "2026-10-10", "2026-10-10")).unwrap().auto_prompt, "보이기만 했으면 아직 결정 전");
    s.with_conn(|c| carryover::skip(c, "2026-10-10")).unwrap();
    let root = s.paths.root.clone();
    s.close();
    drop(s);
    let (reopened, _) = Storage::open(&root, false).unwrap();
    let info = reopened.with_conn(|c| carryover::get(c, "2026-10-10", "2026-10-10")).unwrap();
    assert_eq!(info.status.as_deref(), Some("skipped"));
    assert!(!info.auto_prompt, "건너뛴 안내는 다시 저절로 보이지 않는다");
    assert_eq!(info.items.len(), 1, "보조 메뉴에서는 여전히 가져올 수 있다");
    drop(dir);
}

#[test]
fn carried_images_are_independent_copies() {
    let (_d, s) = temp_storage();
    let item = add(&s, day("2026-10-03"), "main", "사진");
    let image = s.with_conn(|c| attachments::import_bytes(c, &s.paths, PNG, Some("a.png"), Some(&item.id))).unwrap();
    let html = format!("사진 <img src=\"attachment://{}\"> 확인", image.id);
    s.with_conn(|c| service::update_content(c, &item.id, &html)).unwrap();

    let result = s.with_conn(|c| carryover::import(c, &s.paths, "2026-10-10", std::slice::from_ref(&item.id), "2026-10-10")).unwrap();
    let copy = &result.created[0];
    assert!(!copy.content_html.contains(&image.id), "복사본은 새 첨부를 가리킨다");
    let ids = plan_a_memo_lib::memo::text::attachment_ids(&copy.content_html);
    assert_eq!(ids.len(), 1);
    let new_id = ids[0].clone();
    // 원본 첨부의 주인은 원본 항목 그대로, 새 첨부의 주인은 복사본
    let owner = |id: &str| -> String {
        s.with_conn(|c| Ok(c.query_row("SELECT item_id FROM attachments WHERE id = ?1", [id], |r| r.get(0))?)).unwrap()
    };
    assert_eq!(owner(&image.id), item.id);
    assert_eq!(owner(&new_id), copy.id);
    // 원본 메모를 지우고 정리해도 복사본 이미지는 읽힌다
    s.with_conn(|c| service::delete_item(c, &item.id)).unwrap();
    s.with_conn(|c| Ok(c.execute("UPDATE attachments SET created_at = '2000-01-01T00:00:00.000Z'", [])?)).unwrap();
    s.with_conn(|c| Ok(c.execute("DELETE FROM document_versions", [])?)).unwrap();
    s.with_conn(|c| Ok(c.execute("DELETE FROM memo_items WHERE id = ?1", [&item.id])?)).unwrap();
    s.with_conn(|c| attachments::cleanup_unreferenced(c, &s.paths, false)).unwrap();
    let (bytes, mime) = s.with_conn(|c| attachments::read_bytes(c, &s.paths, &new_id)).unwrap();
    assert_eq!(bytes, PNG);
    assert_eq!(mime, "image/png");
}

#[test]
fn carryover_into_linked_day_queues_only_that_day() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-03"), "main", "보고서 작성");
    add(&s, day("2026-10-10"), "main", "이번 주");
    s.with_conn(|c| {
        let doc = repo::ensure_doc(c, &day("2026-10-10"))?;
        link::enable_link(c, &doc.id, "local:test|1")
    })
    .unwrap();
    s.with_conn(|c| Ok(c.execute("DELETE FROM sync_outbox", [])?)).unwrap();
    // memo-sync-v2: 연결된 날짜는 서버가 공통 관리를 지원하는지 확인하기 전에는 복사하지 않는다(인계서 §6).
    let blocked = s.with_conn(|c| carryover::import(c, &s.paths, "2026-10-10", std::slice::from_ref(&a.id), "2026-10-10"));
    assert_eq!(blocked.unwrap_err().code(), "carry_unavailable");
    s.with_conn(|c| {
        plan_a_memo_lib::sync::management::set_active_account(c, Some("local:test|1"))?;
        plan_a_memo_lib::sync::management::set_capability(c, "local:test|1", true)
    })
    .unwrap();
    s.with_conn(|c| carryover::import(c, &s.paths, "2026-10-10", std::slice::from_ref(&a.id), "2026-10-10")).unwrap();
    let target = s.with_conn(|c| repo::doc_for_location(c, &day("2026-10-10"))).unwrap().unwrap();
    let source = s.with_conn(|c| repo::doc_for_location(c, &day("2026-10-03"))).unwrap().unwrap();
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM sync_outbox WHERE document_id = '{}'", target.id)), 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM management_outbox WHERE kind = 'carry' AND memo_date = '2026-10-10'"), 1, "공통 복사 명령");
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM sync_outbox WHERE document_id = '{}'", source.id)), 0);
    assert!(!source.sync_enabled, "복사 때문에 지난주를 연결하지 않는다");
    assert_eq!(source.sync_status, "local_only");
}

// ── 날짜별 알림(DB) ─────────────────────────────────────────────────────

#[test]
fn reminder_settings_compute_local_fire_times_and_skip_past_ones() {
    let (_d, s) = temp_storage();
    let now = at("2026-10-18", "10:00");
    let r = s.with_conn(|c| reminders::set(c, "2026-10-24", &[7, 2], "09:00", now)).unwrap().unwrap();
    assert_eq!(r.time, "09:00");
    let fires: Vec<(i64, &str, &str)> = r.fires.iter().map(|f| (f.offset_days, f.fire_at.as_str(), f.status.as_str())).collect();
    assert_eq!(
        fires,
        vec![(7, "2026-10-17T09:00", "expired"), (2, "2026-10-22T09:00", "pending")],
        "이미 지난 시각은 소급해서 알리지 않는다"
    );
    // 2일 전만
    let only_two = s.with_conn(|c| reminders::set(c, "2026-10-31", &[2], "18:30", now)).unwrap().unwrap();
    assert_eq!(only_two.offsets, vec![2]);
    assert_eq!(only_two.fires[0].fire_at, "2026-10-29T18:30");
    // 끄기
    assert!(s.with_conn(|c| reminders::set(c, "2026-10-31", &[], "09:00", now)).unwrap().is_none());
    assert!(s.with_conn(|c| reminders::get(c, "2026-10-31")).unwrap().is_none());
    // 잘못된 값
    assert!(s.with_conn(|c| reminders::set(c, "2026-10-31", &[3], "09:00", now)).is_err());
    assert!(s.with_conn(|c| reminders::set(c, "2026-10-31", &[2], "9시", now)).is_err());
}

#[test]
fn triggers_follow_open_checklists() {
    let (_d, s) = temp_storage();
    let now = at("2026-10-10", "12:00");
    let item = add(&s, day("2026-10-24"), "main", "월말 자료 정리");
    s.with_conn(|c| reminders::set(c, "2026-10-24", &[7, 2], "09:00", now)).unwrap();
    s.with_conn(|c| reminders::set(c, "2026-10-31", &[2], "09:00", now)).unwrap(); // 메모 없는 날짜
    let triggers = s.with_conn(|c| reminders::upcoming_triggers(c, now)).unwrap();
    assert_eq!(triggers, vec![at("2026-10-17", "09:00"), at("2026-10-22", "09:00")]);
    // 모두 완료 → 예약에서 빠진다
    complete(&s, &item.id);
    assert!(s.with_conn(|c| reminders::upcoming_triggers(c, now)).unwrap().is_empty());
    // 다시 미완료가 생기면 다시 들어간다
    add(&s, day("2026-10-24"), "pm", "다음 달 계획");
    assert_eq!(s.with_conn(|c| reminders::upcoming_triggers(c, now)).unwrap().len(), 2);
}

#[test]
fn due_reminders_are_claimed_once_with_current_counts() {
    let (_d, s) = temp_storage();
    let set_at = at("2026-10-10", "12:00");
    add(&s, day("2026-10-24"), "main", "A");
    let b = add(&s, day("2026-10-24"), "pm", "B");
    add(&s, day("2026-10-24"), "am", "C");
    complete(&s, &b.id);
    s.with_conn(|c| reminders::set(c, "2026-10-24", &[7, 2], "09:00", set_at)).unwrap();
    // 시각 전에는 없다
    assert!(s.with_conn(|c| reminders::claim_due(c, at("2026-10-17", "08:59"), 0)).unwrap().is_empty());
    // 시각 — 제때(완료하지 않은 체크리스트 2개)
    let due = s.with_conn(|c| reminders::claim_due(c, at("2026-10-17", "09:00"), 0)).unwrap();
    assert_eq!(due, vec![DueReminder { date: "2026-10-24".into(), open_count: 2, late: false }]);
    // 두 번째 처리(실행 중인 앱 · 작업 스케줄러가 겹쳐도) — 없음
    assert!(s.with_conn(|c| reminders::claim_due(c, at("2026-10-17", "09:01"), 0)).unwrap().is_empty());
    let r = s.with_conn(|c| reminders::get(c, "2026-10-24")).unwrap().unwrap();
    assert_eq!(r.fires[0].status, "delivered");
    assert_eq!(r.fires[1].status, "pending");
    // 같은 설정으로 다시 저장해도 이미 띄운 알림을 다시 띄우지 않는다
    s.with_conn(|c| reminders::set(c, "2026-10-24", &[7, 2], "09:00", at("2026-10-17", "10:00"))).unwrap();
    assert_eq!(s.with_conn(|c| reminders::get(c, "2026-10-24")).unwrap().unwrap().fires[0].status, "delivered");
}

#[test]
fn completed_days_are_skipped_and_missed_reminders_shown_once() {
    let (_d, s) = temp_storage();
    let set_at = at("2026-10-01", "12:00");
    let done = add(&s, day("2026-10-30"), "main", "다 한 일");
    complete(&s, &done.id);
    add(&s, day("2026-10-31"), "main", "남은 일");
    add(&s, day("2026-10-20"), "main", "지나 버린 날");
    for date in ["2026-10-30", "2026-10-31", "2026-10-20"] {
        s.with_conn(|c| reminders::set(c, date, &[7, 2], "09:00", set_at)).unwrap();
    }
    // PC 가 10/17 ~ 10/29 10:00 동안 꺼져 있었다 → 켜진 뒤 한 번에 처리
    let due = s.with_conn(|c| reminders::claim_due(c, at("2026-10-29", "10:00"), 0)).unwrap();
    assert_eq!(due, vec![DueReminder { date: "2026-10-31".into(), open_count: 1, late: true }], "날짜당 하나, 놓친 알림 한 번");
    let status = |date: &str| -> Vec<String> {
        s.with_conn(|c| reminders::get(c, date)).unwrap().unwrap().fires.into_iter().map(|f| f.status).collect()
    };
    assert_eq!(status("2026-10-30"), vec!["skipped", "skipped"], "모두 완료한 날은 띄우지 않는다");
    assert_eq!(status("2026-10-20"), vec!["expired", "expired"], "대상 날짜가 지나면 늦게 보내지 않는다");
    assert_eq!(status("2026-10-31"), vec!["missed", "missed"]);
    assert!(s.with_conn(|c| reminders::claim_due(c, at("2026-10-29", "10:05"), 0)).unwrap().is_empty(), "반복 발송 없음");
}

#[test]
fn app_grace_lets_the_scheduled_task_go_first() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-10-24"), "main", "A");
    s.with_conn(|c| reminders::set(c, "2026-10-24", &[2], "09:00", at("2026-10-10", "12:00"))).unwrap();
    assert!(s.with_conn(|c| reminders::claim_due(c, at("2026-10-22", "09:01"), 2)).unwrap().is_empty(), "앱은 2분 기다린다");
    assert_eq!(s.with_conn(|c| reminders::claim_due(c, at("2026-10-22", "09:02"), 2)).unwrap().len(), 1);
}

#[test]
fn fire_time_boundaries() {
    let nine = reminders::parse_time("09:00").unwrap();
    let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
    assert_eq!(reminders::format_fire(reminders::fire_at(d(2026, 11, 1), 2, nine)), "2026-10-30T09:00", "월 경계");
    assert_eq!(reminders::format_fire(reminders::fire_at(d(2027, 1, 5), 7, nine)), "2026-12-29T09:00", "연 경계");
    assert_eq!(reminders::format_fire(reminders::fire_at(d(2028, 3, 6), 7, nine)), "2028-02-28T09:00", "윤년");
}
