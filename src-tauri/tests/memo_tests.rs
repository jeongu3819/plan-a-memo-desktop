//! DayMemo · Next List · 체크/수정/삭제/이동/정렬 · 즐겨찾기 · History · 검색 · 첨부 · 내보내기.

mod common;

use std::io::Read;

use common::*;
use plan_a_memo_lib::attachments;
use plan_a_memo_lib::memo::service::{self, MoveItem, MovePolicy};
use plan_a_memo_lib::memo::{export, history, repo, search, trash, Location, DEFAULT_LIST_ID};
use plan_a_memo_lib::sync::link;

#[test]
fn day_memo_is_one_document_with_three_sections() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-10-07"), "main", "AWS 확인");
    add(&s, day("2026-10-07"), "am", "회의 준비");
    add(&s, day("2026-10-07"), "pm", "보고서 작성");
    add(&s, day("2026-10-07"), "main", "메일 확인");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM documents WHERE kind = 'DAY'"), 1, "하루 = 문서 1건");
    let daymemo = s.with_conn(|c| service::get_day(c, "2026-10-07")).unwrap();
    let sections: Vec<&str> = daymemo.items.iter().map(|i| i.section.as_str()).collect();
    assert_eq!(sections, vec!["main", "main", "am", "pm"], "메인 → 오전 → 오후 순서");
    assert_eq!(daymemo.document.unwrap().local_revision, 4);
    // 빈 날짜는 문서가 없다
    assert!(s.with_conn(|c| service::get_day(c, "2026-10-08")).unwrap().document.is_none());
    // 날짜 메모에 next 구역은 쓸 수 없다
    let wrong = s.with_conn(|c| {
        service::create_item(
            c,
            service::CreateItem {
                id: uuid::Uuid::new_v4().to_string(),
                location: day("2026-10-07"),
                section: "next".into(),
                kind: "checklist".into(),
                content_html: "x".into(),
            },
        )
    });
    assert_eq!(wrong.err().unwrap().code(), "validation");
}

#[test]
fn week_view_returns_seven_days_and_default_next() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-10-05"), "main", "월요일");
    add(&s, day("2026-10-11"), "pm", "일요일");
    add(&s, next(None), "next", "언젠가");
    let week = s.with_conn(|c| service::get_week(c, "2026-10-05")).unwrap();
    assert_eq!(week.days.len(), 7);
    assert_eq!(week.days[0].items.len(), 1);
    assert_eq!(week.days[6].items[0].content_html, "일요일");
    assert!(week.next.list.is_default);
    assert_eq!(week.next.items[0].content_html, "언젠가");
}

#[test]
fn create_is_idempotent_by_client_id() {
    let (_d, s) = temp_storage();
    let id = uuid::Uuid::new_v4().to_string();
    for _ in 0..3 {
        s.with_conn(|c| {
            service::create_item(
                c,
                service::CreateItem {
                    id: id.clone(),
                    location: day("2026-10-07"),
                    section: "main".into(),
                    kind: "checklist".into(),
                    content_html: "한 번만".into(),
                },
            )
        })
        .unwrap();
    }
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_items"), 1);
}

#[test]
fn edit_check_kind_and_search_text() {
    let (_d, s) = temp_storage();
    let item = add(&s, day("2026-10-07"), "main", "처음");
    let saved = s
        .with_conn(|c| {
            service::update_content(c, &item.id, "<p>A<strong>W</strong>S <em>확인</em></p><table><tr><td>표</td><td>칸</td></tr></table>")
        })
        .unwrap();
    assert!(saved.content_html.contains("<strong>"));
    let text: String = s.with_conn(|c| Ok(c.query_row("SELECT content_text FROM memo_items", [], |r| r.get(0))?)).unwrap();
    assert_eq!(text, "AWS 확인 표 칸");
    let done = s.with_conn(|c| service::set_completed(c, &item.id, true)).unwrap();
    assert!(done.completed && done.completed_at.is_some());
    let as_text = s.with_conn(|c| service::set_kind(c, &item.id, "text")).unwrap();
    assert!(!as_text.completed, "텍스트 메모는 완료 상태가 없다");
    // 로컬 절대 경로 이미지는 저장 거절
    let bad = s.with_conn(|c| service::update_content(c, &item.id, "<img src=\"file:///C:/Users/a.png\">"));
    assert_eq!(bad.err().unwrap().code(), "validation");
}

#[test]
fn delete_keeps_history_and_restore_undoes() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-07"), "main", "지울 메모");
    add(&s, day("2026-10-07"), "main", "남는 메모");
    s.with_conn(|c| service::delete_item(c, &a.id)).unwrap();
    assert_eq!(texts(&s, "2026-10-07"), vec!["남는 메모"]);
    let versions = s.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert_eq!(versions[0].reason, "delete");
    assert_eq!(versions[0].item_count, 2, "삭제 전 상태가 History 에 있다");
    s.with_conn(|c| service::restore_item(c, &a.id)).unwrap();
    assert_eq!(texts(&s, "2026-10-07"), vec!["지울 메모", "남는 메모"]);
}

#[test]
fn everyday_edits_leave_no_snapshots_and_protective_records_still_restore() {
    let (_d, s) = temp_storage();
    let item = add(&s, day("2026-10-07"), "main", "v1");
    let other = add(&s, day("2026-10-07"), "main", "다른 메모");
    // 긴 메모를 200번 고쳐도(이전: 5분마다 문서 전체 Snapshot) 일상 편집은 쌓이지 않는다
    let body = "가".repeat(20_000);
    for v in 0..200 {
        s.with_conn(|c| service::update_content(c, &item.id, &format!("{body}{v}"))).unwrap();
    }
    s.with_conn(|c| service::reorder(c, &day("2026-10-07"), "main", &[other.id.clone(), item.id.clone()])).unwrap();
    s.with_conn(|c| service::set_completed(c, &item.id, true)).unwrap();
    assert_eq!(count(&s, "SELECT COUNT(*) FROM document_versions"), 0, "수정·순서 변경·체크는 Snapshot 을 남기지 않는다");
    assert_eq!(count(&s, "SELECT local_revision > 0 FROM documents"), 1, "Sync 가 쓰는 revision 은 그대로 오른다");
    // 데이터 보호 기록은 그대로 — 삭제 직전 내용이 남고 복원된다(지금 내용은 먼저 보존)
    s.with_conn(|c| service::update_content(c, &item.id, "삭제 직전")).unwrap();
    s.with_conn(|c| service::delete_item(c, &other.id)).unwrap();
    let versions = s.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].reason, "delete");
    s.with_conn(|c| service::update_content(c, &item.id, "그 뒤 수정")).unwrap();
    s.with_conn(|c| history::restore(c, versions[0].id)).unwrap();
    assert_eq!(texts(&s, "2026-10-07"), vec!["다른 메모", "삭제 직전"]);
    let after = s.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(after.iter().any(|v| v.reason == "restore" && v.preview.contains("그 뒤 수정")));
}

#[test]
fn moving_to_another_day_still_preserves_the_previous_content() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-07"), "main", "옮길 메모");
    s.with_conn(|c| service::move_item(c, MoveItem { id: a.id.clone(), target: day("2026-10-08"), section: None, index: None, policy: None })).unwrap();
    let versions = s.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert_eq!(versions[0].reason, "move");
    assert!(versions[0].preview.contains("옮길 메모"));
    // 같은 날짜 안의 구역 이동은 일상 편집이다
    s.with_conn(|c| service::move_item(c, MoveItem { id: a.id.clone(), target: day("2026-10-08"), section: Some("am".into()), index: None, policy: None })).unwrap();
    assert_eq!(s.with_conn(|c| history::list_for_location(c, &day("2026-10-08"))).unwrap().len(), 0);
}

#[test]
fn old_edit_history_is_kept_but_not_listed_and_preserved_list_covers_every_document() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-07"), "main", "새 내용");
    let list = s.with_conn(|c| service::create_list(c, None, "보관 List")).unwrap();
    let b = add(&s, next(Some(&list.id)), "next", "List 메모");
    // 이전 버전이 남긴 일반 편집 기록
    let doc_id = a.document_id.clone();
    s.with_conn(|c| {
        c.execute(
            "INSERT INTO document_versions (document_id, reason, local_revision, snapshot_json, content_text, created_at)
             SELECT ?1, 'edit', 1, snapshot_json, content_text, created_at FROM (SELECT '{\"kind\":\"DAY\",\"items\":[]}' AS snapshot_json, '옛 내용' AS content_text, '2026-10-01T00:00:00Z' AS created_at)",
            [&doc_id],
        )?;
        Ok(())
    })
    .unwrap();
    s.with_conn(|c| service::update_content(c, &a.id, "또 고침")).unwrap();
    assert_eq!(count(&s, "SELECT COUNT(*) FROM document_versions WHERE reason = 'edit'"), 1, "기존 기록을 지우지 않는다");
    assert!(s.with_conn(|c| history::list_preserved(c)).unwrap().is_empty(), "일반 편집 기록은 목록에 없다");
    s.with_conn(|c| service::delete_item(c, &a.id)).unwrap();
    s.with_conn(|c| service::delete_item(c, &b.id)).unwrap();
    let preserved = s.with_conn(|c| history::list_preserved(c)).unwrap();
    assert_eq!(preserved.len(), 2, "모든 날짜·List 의 보호 기록");
    assert_eq!(preserved[0].list_name.as_deref(), Some("보관 List"));
    assert_eq!(preserved[1].location, day("2026-10-07"));
    assert_eq!(count(&s, "SELECT COUNT(*) FROM document_versions WHERE reason = 'edit'"), 1);
    // 휴지통에 있는 List 의 기록은 복구한 뒤에 보인다
    s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    assert!(s.with_conn(|c| history::list_preserved(c)).unwrap().iter().all(|v| v.list_name.is_none()));
    s.with_conn(|c| trash::restore(c, &list.id)).unwrap();
    assert!(s.with_conn(|c| history::list_preserved(c)).unwrap().iter().any(|v| v.list_name.is_some()));
}

#[test]
fn move_between_sections_and_days_and_reorder() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-07"), "main", "A");
    let b = add(&s, day("2026-10-07"), "main", "B");
    let c_item = add(&s, day("2026-10-07"), "am", "C");
    // 같은 날 Main → 오전(맨 앞)
    s.with_conn(|c| {
        service::move_item(
            c,
            MoveItem { id: a.id.clone(), target: day("2026-10-07"), section: Some("am".into()), index: Some(0), policy: None },
        )
    })
    .unwrap();
    let items = s.with_conn(|c| service::get_day(c, "2026-10-07")).unwrap().items;
    let order: Vec<(String, String)> = items.iter().map(|i| (i.section.clone(), i.content_html.clone())).collect();
    assert_eq!(order, vec![("main".into(), "B".into()), ("am".into(), "A".into()), ("am".into(), "C".into())]);
    // 다른 날짜로 — 두 문서가 바뀐다
    let before = count(&s, "SELECT local_revision FROM documents WHERE memo_date = '2026-10-07'");
    let outcome = s
        .with_conn(|c| {
            service::move_item(c, MoveItem { id: b.id.clone(), target: day("2026-10-08"), section: None, index: None, policy: None })
        })
        .unwrap();
    assert_eq!(outcome.status, "moved");
    assert_eq!(texts(&s, "2026-10-08"), vec!["B"]);
    assert_eq!(count(&s, "SELECT local_revision FROM documents WHERE memo_date = '2026-10-07'"), before + 1);
    // Next 로 → section next, 다시 날짜로 → main
    s.with_conn(|c| service::move_item(c, MoveItem { id: b.id.clone(), target: next(None), section: None, index: None, policy: None }))
        .unwrap();
    assert_eq!(s.with_conn(|c| service::get_list(c, None)).unwrap().items[0].section, "next");
    s.with_conn(|c| {
        service::move_item(c, MoveItem { id: b.id.clone(), target: day("2026-10-09"), section: None, index: None, policy: None })
    })
    .unwrap();
    assert_eq!(s.with_conn(|c| service::get_day(c, "2026-10-09")).unwrap().items[0].section, "main");
    // 정렬
    s.with_conn(|c| service::reorder(c, &day("2026-10-07"), "am", &[c_item.id.clone(), a.id.clone()])).unwrap();
    assert_eq!(texts(&s, "2026-10-07"), vec!["C", "A"]);
    // 다른 날짜의 항목은 이 순서에 넣을 수 없다
    assert!(s.with_conn(|c| service::reorder(c, &day("2026-10-07"), "am", std::slice::from_ref(&b.id))).is_err());
}

#[test]
fn moving_from_linked_to_unlinked_day_asks_first() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-07"), "main", "연결된 날의 메모");
    s.with_conn(|c| {
        let doc = repo::doc_for_location(c, &day("2026-10-07"))?.unwrap();
        link::enable_link(c, &doc.id, "local:test|1")
    })
    .unwrap();
    let ask = s
        .with_conn(|c| {
            service::move_item(c, MoveItem { id: a.id.clone(), target: day("2026-10-08"), section: None, index: None, policy: None })
        })
        .unwrap();
    assert_eq!(ask.status, "needs_decision");
    assert_eq!(texts(&s, "2026-10-07").len(), 1, "묻기 전에는 옮기지 않는다");
    // Desktop 에서만 이동 → 10/8 은 연결되지 않는다
    s.with_conn(|c| {
        service::move_item(
            c,
            MoveItem { id: a.id.clone(), target: day("2026-10-08"), section: None, index: None, policy: Some(MovePolicy::LocalOnly) },
        )
    })
    .unwrap();
    assert_eq!(count(&s, "SELECT sync_enabled FROM documents WHERE memo_date = '2026-10-08'"), 0);
    // 다시 10/7 로 옮긴 뒤 '연결하고 이동' 으로 10/9
    s.with_conn(|c| {
        service::move_item(c, MoveItem { id: a.id.clone(), target: day("2026-10-07"), section: None, index: None, policy: None })
    })
    .unwrap();
    s.with_conn(|c| {
        service::move_item_linking(
            c,
            MoveItem { id: a.id.clone(), target: day("2026-10-09"), section: None, index: None, policy: Some(MovePolicy::LinkTarget) },
            Some("local:test|1"),
        )
    })
    .unwrap();
    assert_eq!(count(&s, "SELECT sync_enabled FROM documents WHERE memo_date = '2026-10-09'"), 1);
}

#[test]
fn favorites_are_local_only_and_do_not_bump_revision() {
    let (_d, s) = temp_storage();
    let a = add(&s, day("2026-10-07"), "main", "중요");
    let rev = count(&s, "SELECT local_revision FROM documents");
    s.with_conn(|c| service::set_favorite(c, &a.id, true)).unwrap();
    assert_eq!(count(&s, "SELECT local_revision FROM documents"), rev);
    let favs = s.with_conn(|c| service::favorites(c)).unwrap();
    assert_eq!(favs.len(), 1);
    assert_eq!(favs[0].location, day("2026-10-07"));
}

#[test]
fn next_lists_create_rename_delete_keeps_items_in_trash() {
    let (_d, s) = temp_storage();
    let list = s.with_conn(|c| service::create_list(c, None, "앱 개발")).unwrap();
    add(&s, next(Some(&list.id)), "next", "음성 메모");
    add(&s, next(Some(&list.id)), "next", "Calendar 디자인");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM documents WHERE kind = 'NEXT_LIST'"), 1, "List 하나 = 문서 1건");
    let renamed = s.with_conn(|c| service::rename_list(c, &list.id, "앱 개발 2")).unwrap();
    assert_eq!(renamed.name, "앱 개발 2");
    assert!(s.with_conn(|c| service::rename_list(c, DEFAULT_LIST_ID, "x")).is_err());
    let result = s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    assert_eq!(result.item_count, 2);
    assert!(!result.already);
    let default = s.with_conn(|c| service::get_list(c, None)).unwrap();
    assert_eq!(default.items.len(), 0, "메모는 Next 로 섞이지 않고 List 와 함께 휴지통으로");
    assert_eq!(s.with_conn(|c| service::lists(c)).unwrap().len(), 1);
    assert!(s.with_conn(|c| trash::move_to_trash(c, DEFAULT_LIST_ID)).is_err(), "기본 Next 는 지울 수 없다");
}

#[test]
fn trash_hides_items_everywhere_and_restore_brings_back_everything() {
    let (_d, s) = temp_storage();
    let list = s.with_conn(|c| service::create_list(c, None, "메모장 개선")).unwrap();
    let other = s.with_conn(|c| service::create_list(c, None, "다른 List")).unwrap();
    let order_before: Vec<String> = s.with_conn(|c| service::lists(c)).unwrap().into_iter().map(|l| l.id).collect();
    let a = add(&s, next(Some(&list.id)), "next", "<p><b>굵은</b> 복구 대상</p>");
    let b = add(&s, next(Some(&list.id)), "next", "완료한 항목");
    s.with_conn(|c| service::set_completed(c, &b.id, true)).unwrap();
    s.with_conn(|c| service::set_favorite(c, &a.id, true)).unwrap();

    let first = s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    let again = s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    assert!(again.already, "두 번 실행해도 오류·중복 없음");
    assert_eq!(again.purge_after, first.purge_after, "보존 기한이 늘어나지 않는다");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM list_trash"), 1);

    assert_eq!(s.with_conn(|c| service::lists(c)).unwrap().len(), 2);
    assert_eq!(s.with_conn(|c| search::search(c, "복구")).unwrap().items.len(), 0, "휴지통 메모는 검색되지 않는다");
    assert_eq!(s.with_conn(|c| service::favorites(c)).unwrap().len(), 0, "휴지통 메모는 즐겨찾기에 없다");
    assert!(s.with_conn(|c| service::get_list(c, Some(&list.id))).is_err());
    let entries = s.with_conn(|c| trash::entries(c)).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].name.as_str(), entries[0].item_count, entries[0].was_linked), ("메모장 개선", 2, false));
    assert!(entries[0].blocked.is_none());
    let days = chrono::DateTime::parse_from_rfc3339(&entries[0].purge_after).unwrap() - chrono::DateTime::parse_from_rfc3339(&entries[0].deleted_at).unwrap();
    assert_eq!(days.num_days(), trash::RETENTION_DAYS);

    let restored = s.with_conn(|c| trash::restore(c, &list.id)).unwrap();
    assert_eq!(restored.item_count, 2);
    assert!(restored.document.as_ref().is_some_and(|d| !d.sync_enabled), "복구해도 연결하지 않는다");
    let order_after: Vec<String> = s.with_conn(|c| service::lists(c)).unwrap().into_iter().map(|l| l.id).collect();
    assert_eq!(order_after, order_before, "원래 List 순서로");
    let memo = s.with_conn(|c| service::get_list(c, Some(&list.id))).unwrap();
    assert_eq!(memo.items[0].content_html, "<p><b>굵은</b> 복구 대상</p>", "서식 그대로");
    assert!(memo.items[0].favorite, "즐겨찾기 그대로");
    assert!(memo.items[1].completed, "완료 상태 그대로");
    assert_eq!(s.with_conn(|c| search::search(c, "복구")).unwrap().items.len(), 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM list_trash"), 0);
    assert_eq!(s.with_conn(|c| trash::restore(c, &list.id)).unwrap().id, list.id, "복구를 두 번 눌러도 그대로");
    let _ = other;
}

#[test]
fn expired_trash_is_purged_after_backup_and_only_then() {
    let (_d, s) = temp_storage();
    let expired = s.with_conn(|c| service::create_list(c, None, "기한 지남")).unwrap();
    let kept = s.with_conn(|c| service::create_list(c, None, "기한 남음")).unwrap();
    add(&s, next(Some(&expired.id)), "next", "지워질 메모");
    add(&s, next(Some(&kept.id)), "next", "남을 메모");
    add(&s, day("2026-10-07"), "main", "날짜 메모");
    s.with_conn(|c| trash::move_to_trash(c, &expired.id)).unwrap();
    s.with_conn(|c| trash::move_to_trash(c, &kept.id)).unwrap();
    let now = plan_a_memo_lib::util::now();
    let purged = s.with_conn(|c| trash::purge_expired(c, &s.paths, &now)).unwrap();
    assert!(purged.is_empty(), "7일 전에는 아무것도 지우지 않는다");
    s.with_conn(|c| {
        Ok(c.execute("UPDATE list_trash SET purge_after = '2000-01-01T00:00:00.000Z' WHERE list_id = ?1", [&expired.id])?)
    })
    .unwrap();
    let backups_before = plan_a_memo_lib::storage::backup::list(&s.paths).len();
    let purged = s.with_conn(|c| trash::purge_expired(c, &s.paths, &now)).unwrap();
    assert_eq!(purged, vec![expired.id.clone()]);
    assert_eq!(plan_a_memo_lib::storage::backup::list(&s.paths).len(), backups_before + 1, "지우기 전에 Backup");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM next_lists WHERE name = '기한 지남'"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_items WHERE content_text LIKE '%지워질%'"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_items WHERE content_text LIKE '%남을%'"), 1, "기한 남은 List 는 그대로");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM memo_items WHERE content_text LIKE '%날짜 메모%'"), 1, "다른 메모는 그대로");
    assert_eq!(s.with_conn(|c| trash::entries(c)).unwrap().len(), 1);
    // 사용자가 고른 영구 삭제 — 두 번 실행해도 오류 없음.
    s.with_conn(|c| trash::purge(c, &s.paths, &kept.id)).unwrap();
    s.with_conn(|c| trash::purge(c, &s.paths, &kept.id)).unwrap();
    assert!(s.with_conn(|c| trash::entries(c)).unwrap().is_empty());
    assert!(s.with_conn(|c| trash::restore(c, &kept.id)).is_err(), "영구 삭제 후에는 복구할 수 없다");
}

#[test]
fn image_cleanup_keeps_images_of_trashed_lists() {
    let (_d, s) = temp_storage();
    let list = s.with_conn(|c| service::create_list(c, None, "이미지 List")).unwrap();
    let info = s.with_conn(|c| attachments::import_bytes(c, &s.paths, PNG, None, None)).unwrap();
    add(&s, next(Some(&list.id)), "next", &format!("<p><img src=\"attachment://{}\"></p>", info.id));
    s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    s.with_conn(|c| {
        Ok(c.execute("UPDATE attachments SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1", [&info.id])?)
    })
    .unwrap();
    let report = s.with_conn(|c| attachments::cleanup_unreferenced(c, &s.paths, false)).unwrap();
    assert_eq!(report.removed, 0, "휴지통에 있는 동안 이미지를 지우지 않는다");
    let restored = s.with_conn(|c| trash::restore(c, &list.id)).unwrap();
    assert_eq!(restored.item_count, 1);
    assert!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, &info.id)).is_ok(), "복구한 메모의 이미지 파일이 그대로 있다");
}

#[test]
fn past_memos_stop_at_today_but_search_and_week_still_find_future_memos() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-10-28"), "main", "지난 메모");
    add(&s, day("2026-11-01"), "main", "어제 메모");
    add(&s, day("2026-11-02"), "main", "오늘 메모");
    add(&s, day("2026-11-09"), "main", "다음 주 메모");
    add(&s, day("2026-11-30"), "main", "이번 달 말 메모");
    add(&s, day("2026-12-25"), "main", "다음 달 메모");
    let today = "2026-11-02";
    let months = s.with_conn(|c| service::day_months(c, today)).unwrap();
    let summary: Vec<(&str, i64)> = months.iter().map(|m| (m.month.as_str(), m.item_count)).collect();
    assert_eq!(summary, vec![("2026-11", 2), ("2026-10", 1)], "미래 메모는 세지 않고, 미래 달은 카드가 없다");
    let days = s.with_conn(|c| service::days_in_month(c, "2026-11", today)).unwrap();
    assert_eq!(days.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(), vec!["2026-11-02", "2026-11-01"], "오늘까지만");
    assert!(s.with_conn(|c| service::days_in_month(c, "2026-12", today)).unwrap().is_empty());
    assert!(s.with_conn(|c| service::day_months(c, "2026-13-40")).is_err());
    // 하루 지나면 그날 메모가 지난 메모에 들어온다.
    let next = s.with_conn(|c| service::days_in_month(c, "2026-11", "2026-11-09")).unwrap();
    assert_eq!(next[0].date, "2026-11-09");
    // 메모 자체는 그대로 — 검색·날짜 상세에서 찾는다.
    assert_eq!(s.with_conn(|c| search::search(c, "이번 달 말")).unwrap().items.len(), 1);
    let date = search::DateQuery { year: None, month: 11, day: 30, prefer_year: 2026, rest: String::new() };
    assert_eq!(s.with_conn(|c| search::search_with(c, "11/30", Some(&date), 200)).unwrap().days.len(), 1);
    assert_eq!(s.with_conn(|c| service::get_day(c, "2026-11-30")).unwrap().items.len(), 1);
}

#[test]
fn history_survives_the_trash_and_is_removed_by_purge() {
    let (_d, s) = temp_storage();
    let list = s.with_conn(|c| service::create_list(c, None, "기록 List")).unwrap();
    let location = next(Some(&list.id));
    let item = add(&s, location.clone(), "next", "처음 내용");
    s.with_conn(|c| service::update_content(c, &item.id, "처음 내용 고침")).unwrap();
    s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    s.with_conn(|c| trash::restore(c, &list.id)).unwrap();
    let versions = s.with_conn(|c| history::list_for_location(c, &location)).unwrap();
    assert!(versions.iter().any(|v| v.reason == "list_delete" && v.preview.contains("처음 내용 고침")), "복구 후 삭제 직전 내용이 남아 있다");
    s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    s.with_conn(|c| trash::purge(c, &s.paths, &list.id)).unwrap();
    assert_eq!(count(&s, "SELECT COUNT(*) FROM document_versions WHERE content_text LIKE '%처음 내용%'"), 0, "영구 삭제 — History 도 지운다");
}

#[test]
fn purge_removes_only_this_lists_images_and_waits_for_backups() {
    let (_d, s) = temp_storage();
    let gone = s.with_conn(|c| service::create_list(c, None, "지울 List")).unwrap();
    let other = s.with_conn(|c| service::create_list(c, None, "남을 List")).unwrap();
    let only = s.with_conn(|c| attachments::import_bytes(c, &s.paths, PNG, None, None)).unwrap();
    let mut other_png = PNG.to_vec();
    other_png.extend_from_slice(b"shared"); // PNG 뒤의 군더더기 — 내용이 달라 다른 첨부가 된다
    let shared = s.with_conn(|c| attachments::import_bytes(c, &s.paths, &other_png, None, None)).unwrap();
    add(&s, next(Some(&gone.id)), "next", &format!("<p><img src=\"attachment://{}\"><img src=\"attachment://{}\"></p>", only.id, shared.id));
    add(&s, next(Some(&other.id)), "next", &format!("<p><img src=\"attachment://{}\"></p>", shared.id));
    s.with_conn(|c| trash::move_to_trash(c, &gone.id)).unwrap();
    assert_eq!(s.with_conn(|c| attachments::sweep_purged(c, &s.paths)).unwrap(), 0, "휴지통에 있는 동안은 대상이 아니다");

    s.with_conn(|c| trash::purge(c, &s.paths, &gone.id)).unwrap();
    assert!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, &shared.id)).is_ok(), "다른 List 가 쓰는 이미지는 지우지 않는다");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM purged_attachments"), 1, "다른 List 가 쓰는 이미지는 대기에서 빠진다");
    assert!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, &only.id)).is_ok(), "영구 삭제 전 Backup 이 참조하는 동안은 파일을 남긴다");

    // Backup 이 정리되면 다음 정리에서 지워진다.
    for entry in std::fs::read_dir(s.paths.backups_dir()).unwrap() {
        std::fs::remove_file(entry.unwrap().path()).unwrap();
    }
    assert_eq!(s.with_conn(|c| attachments::sweep_purged(c, &s.paths)).unwrap(), 1);
    assert!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, &only.id)).is_err(), "이제 파일까지 지워졌다");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM purged_attachments"), 0);
    assert!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, &shared.id)).is_ok());
}

#[test]
fn renaming_or_deleting_a_trashed_or_missing_list_is_safe() {
    let (_d, s) = temp_storage();
    let list = s.with_conn(|c| service::create_list(c, None, "List")).unwrap();
    s.with_conn(|c| trash::move_to_trash(c, &list.id)).unwrap();
    assert!(s.with_conn(|c| service::rename_list(c, &list.id, "새 이름")).is_err(), "휴지통의 List 는 이름을 바꿀 수 없다");
    assert_eq!(s.with_conn(|c| trash::entries(c)).unwrap()[0].name, "List");
    assert!(s.with_conn(|c| trash::move_to_trash(c, "00000000-0000-4000-8000-00000000ffff")).is_err());
    assert!(s.with_conn(|c| trash::restore(c, "00000000-0000-4000-8000-00000000ffff")).is_err());
    s.with_conn(|c| trash::purge(c, &s.paths, "00000000-0000-4000-8000-00000000ffff")).unwrap();
}

#[test]
fn search_finds_dates_and_body_together() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-11-02"), "main", "<p>AWS 설정</p>");
    add(&s, day("2026-11-02"), "pm", "회의록");
    add(&s, day("2025-11-02"), "am", "작년 메모");
    add(&s, day("2026-10-20"), "main", "11/2 까지 제출");
    let date = |year: Option<i32>, rest: &str| search::DateQuery { year, month: 11, day: 2, prefer_year: 2026, rest: rest.into() };

    let r = s.with_conn(|c| search::search_with(c, "11/2", Some(&date(None, "")), 200)).unwrap();
    let dates: Vec<&str> = r.days.iter().map(|d| d.date.as_str()).collect();
    assert_eq!(dates, vec!["2026-11-02", "2025-11-02"], "연도 없으면 올해 먼저, 다른 해는 그 뒤");
    assert_eq!(r.days[0].items.len(), 2, "그 날짜의 메모 모두");
    assert_eq!(r.items.len(), 1, "본문에 '11/2' 라고 적은 메모도 빠지지 않는다");
    assert!(r.items[0].excerpt.contains("11/2"));

    let r = s.with_conn(|c| search::search_with(c, "2026-11-02", Some(&date(Some(2026), "")), 200)).unwrap();
    assert_eq!(r.days.len(), 1, "연도를 적으면 그 해만");
    assert_eq!(r.days[0].date, "2026-11-02");

    let r = s.with_conn(|c| search::search_with(c, "11/2 aws", Some(&date(Some(2026), "aws")), 200)).unwrap();
    assert_eq!(r.days[0].items.len(), 1, "날짜 + 단어 — 그 날짜에서 그 단어가 있는 메모만");

    let r = s.with_conn(|c| search::search_with(c, "1/1", Some(&search::DateQuery { year: None, month: 1, day: 1, prefer_year: 2026, rest: String::new() }), 200)).unwrap();
    assert!(r.days.is_empty(), "메모가 없는 날짜는 결과에 없다");
}

#[test]
fn search_limit_truncates_and_more_returns_the_rest() {
    let (_d, s) = temp_storage();
    for i in 0..5 {
        add(&s, day("2026-10-07"), "main", &format!("반복 단어 {i}"));
    }
    let r = s.with_conn(|c| search::search_with(c, "반복", None, 3)).unwrap();
    assert_eq!(r.items.len(), 3);
    assert!(r.truncated);
    let r = s.with_conn(|c| search::search_with(c, "반복", None, 10)).unwrap();
    assert_eq!(r.items.len(), 5);
    assert!(!r.truncated);
}

#[test]
fn months_group_by_memo_date_not_edit_time() {
    let (_d, s) = temp_storage();
    let old = add(&s, day("2026-10-28"), "main", "10월 메모");
    add(&s, day("2026-10-28"), "pm", "10월 메모 2");
    add(&s, day("2026-10-20"), "am", "10월 메모 3");
    add(&s, day("2026-11-02"), "main", "11월 메모");
    add(&s, day("2025-12-31"), "main", "작년 12월");
    let gone = add(&s, day("2026-09-01"), "main", "지운 메모");
    s.with_conn(|c| service::delete_item(c, &gone.id)).unwrap();
    add(&s, next(None), "next", "Next 메모는 월 카드에 없다");
    s.with_conn(|c| service::update_content(c, &old.id, "11월에 고친 10월 메모")).unwrap();

    let months = s.with_conn(|c| service::day_months(c, "2026-11-02")).unwrap();
    let summary: Vec<(&str, i64, i64)> = months.iter().map(|m| (m.month.as_str(), m.day_count, m.item_count)).collect();
    assert_eq!(summary, vec![("2026-11", 1, 1), ("2026-10", 2, 3), ("2025-12", 1, 1)], "최신 월부터 · 빈 월 없음 · 수정해도 원래 월");
    let days = s.with_conn(|c| service::days_in_month(c, "2026-10", "2026-11-02")).unwrap();
    assert_eq!(days.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(), vec!["2026-10-28", "2026-10-20"]);
    assert_eq!(days[0].item_count, 2);
    assert!(s.with_conn(|c| service::days_in_month(c, "2026-13", "2026-11-02")).is_err());
}

#[test]
fn search_finds_text_not_tags_and_only_current_content() {
    let (_d, s) = temp_storage();
    add(&s, day("2026-10-07"), "main", "<p>A<b>W</b>S 비용 확인</p>");
    let list = s.with_conn(|c| service::create_list(c, None, "회사 업무")).unwrap();
    add(&s, next(Some(&list.id)), "next", "CMP 데이터");
    let gone = add(&s, day("2026-10-08"), "pm", "사라질 보고서");
    add(&s, day("2026-10-08"), "pm", "남는 것");
    s.with_conn(|c| service::delete_item(c, &gone.id)).unwrap();

    let r = s.with_conn(|c| search::search(c, "aws 비용")).unwrap();
    assert_eq!(r.items.len(), 1);
    assert!(r.items[0].excerpt.contains("AWS"));
    assert_eq!(s.with_conn(|c| search::search(c, "strong")).unwrap().items.len(), 0, "태그 이름은 검색되지 않는다");
    let r = s.with_conn(|c| search::search(c, "회사")).unwrap();
    assert_eq!(r.lists.len(), 1);
    let r = s.with_conn(|c| search::search(c, "cmp")).unwrap();
    assert_eq!(r.items[0].located.list_name.as_deref(), Some("회사 업무"));
    let r = s.with_conn(|c| search::search(c, "사라질")).unwrap();
    assert!(r.items.is_empty(), "지운 메모는 검색되지 않는다");
    // LIKE 특수문자
    assert_eq!(s.with_conn(|c| search::search(c, "%")).unwrap().items.len(), 0);
}

#[test]
fn attachments_are_copied_typed_and_safe() {
    let (_d, s) = temp_storage();
    let item = add(&s, day("2026-10-07"), "main", "이미지");
    let info = s.with_conn(|c| attachments::import_bytes(c, &s.paths, PNG, Some("캡처.png"), Some(&item.id))).unwrap();
    assert!(info.url.starts_with("attachment://"));
    assert_eq!(info.mime_type, "image/png");
    let rel: String = s.with_conn(|c| Ok(c.query_row("SELECT relative_path FROM attachments", [], |r| r.get(0))?)).unwrap();
    assert!(rel.starts_with("attachments/") && !rel.contains(':'), "상대 경로만 저장");
    let (bytes, mime) = s.with_conn(|c| attachments::read_bytes(c, &s.paths, &info.id)).unwrap();
    assert_eq!(bytes, PNG);
    assert_eq!(mime, "image/png");
    assert!(s.with_conn(|c| attachments::import_bytes(c, &s.paths, b"not an image", None, None)).is_err());
    assert!(attachments::resolve_path(&s.paths, "attachments/../../secret.txt").is_err());
    assert!(attachments::resolve_path(&s.paths, "C:/Windows/win.ini").is_err());
    // 본문이 참조하면 그 항목·문서에 묶인다
    let other = add(&s, day("2026-10-08"), "main", "다른 날");
    s.with_conn(|c| service::update_content(c, &other.id, &format!("<img src=\"{}\">", info.url))).unwrap();
    let owner: String = s.with_conn(|c| Ok(c.query_row("SELECT item_id FROM attachments", [], |r| r.get(0))?)).unwrap();
    assert_eq!(owner, other.id);
}

#[test]
fn export_zip_matches_web_backup_layout() {
    let (dir, s) = temp_storage();
    let item = add(&s, day("2026-10-07"), "main", "보고서");
    let info = s.with_conn(|c| attachments::import_bytes(c, &s.paths, PNG, None, Some(&item.id))).unwrap();
    s.with_conn(|c| service::update_content(c, &item.id, &format!("<p>보고서 <b>작성</b></p><img src=\"{}\"><table><colgroup><col data-col-width=\"120\"></colgroup><tr><td>a</td></tr></table>", info.url))).unwrap();
    s.with_conn(|c| service::set_completed(c, &item.id, true)).unwrap();
    add(&s, day("2026-10-07"), "am", "회의, \"준비\"");
    add(&s, next(None), "next", "언젠가");
    let target = dir.path().join("export.zip");
    let opts = export::ExportOptions { format: "zip".into(), from: None, to: None, include_next: true };
    let result = s.with_conn(|c| export::export(c, &s.paths, &opts, &target)).unwrap();
    assert_eq!((result.memo_count, result.images_saved, result.images_missing), (3, 1, 0));
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&target).unwrap()).unwrap();
    for name in ["index.html", "style.css", "memos.txt", "memos.csv", "manifest.json", "images/image-001.png"] {
        assert!(zip.by_name(name).is_ok(), "{name}");
    }
    let mut index = String::new();
    zip.by_name("index.html").unwrap().read_to_string(&mut index).unwrap();
    assert!(index.contains("src=\"images/image-001.png\""), "이미지는 ZIP 안 상대 경로");
    assert!(!index.contains("attachment://"));
    assert!(index.contains("style=\"width:120px\""), "열 너비는 정적 style 로");
    assert!(index.contains("메인 할 일") && index.contains("오전 할 일") && index.contains("Next (날짜 미정)"));
    let mut manifest = String::new();
    zip.by_name("manifest.json").unwrap().read_to_string(&mut manifest).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["format"], "plan-a-personal-memo-backup");
    assert_eq!(manifest["complete"], true);
    let mut csv = String::new();
    zip.by_name("memos.csv").unwrap().read_to_string(&mut csv).unwrap();
    assert!(csv.starts_with('\u{feff}'), "Excel 용 BOM");
    assert!(csv.contains("\"회의, \"\"준비\"\"\""));
    let mut txt = String::new();
    zip.by_name("memos.txt").unwrap().read_to_string(&mut txt).unwrap();
    // 서버 render_txt 와 같이 이미지 수는 본문(표 포함) 끝에 붙는다.
    assert!(txt.contains("[x] 보고서 작성\n") && txt.contains("a [이미지 1장]"), "{txt}");

    // 기간 필터 + Next 제외 txt
    let opts = export::ExportOptions { format: "txt".into(), from: Some("2026-10-08".into()), to: None, include_next: false };
    let r = s.with_conn(|c| export::export(c, &s.paths, &opts, &dir.path().join("e.txt"))).unwrap();
    assert_eq!(r.memo_count, 0);
    let _ = Location::Next { list_id: None };
}

#[test]
fn unreferenced_image_cleanup_keeps_history_backups_and_recent_drafts() {
    let (_d, s) = temp_storage();
    let item = add(&s, day("2026-10-07"), "main", "이미지");
    let import = |extra: &[u8]| {
        let mut bytes = PNG.to_vec();
        bytes.extend_from_slice(extra);
        s.with_conn(|c| attachments::import_bytes(c, &s.paths, &bytes, None, None)).unwrap()
    };
    let current = import(b"current");
    let in_history = import(b"history");
    let orphan_old = import(b"old");
    let orphan_recent = import(b"recent");
    let in_backup = import(b"backup");
    // History 에만 남은 이미지: 이동(History 에 항상 남는다) 뒤 본문에서 지움
    let moved = add(&s, day("2026-10-09"), "main", &format!("<img src=\"{}\">", in_history.url));
    s.with_conn(|c| {
        service::move_item(c, MoveItem { id: moved.id.clone(), target: day("2026-10-10"), section: None, index: None, policy: None })
    })
    .unwrap();
    s.with_conn(|c| service::update_content(c, &moved.id, "중간")).unwrap();
    // Backup 에만 남은 이미지: Backup 을 만든 뒤 본문·History 에서 사라짐
    let other = add(&s, day("2026-10-08"), "main", &format!("<img src=\"{}\">", in_backup.url));
    s.with_conn(|c| plan_a_memo_lib::storage::backup::create(c, &s.paths, "manual").map(|_| ())).unwrap();
    s.with_conn(|c| {
        c.execute("DELETE FROM document_versions WHERE content_text LIKE '%' AND snapshot_json LIKE ?1", [format!("%{}%", in_backup.id)])?;
        c.execute("UPDATE memo_items SET content_html = '바뀜' WHERE id = ?1", [&other.id])?;
        Ok(())
    })
    .unwrap();
    s.with_conn(|c| service::update_content(c, &item.id, &format!("<img src=\"{}\">", current.url))).unwrap();
    // 오래된 이미지로 만든다(최근 7일 안의 이미지는 아직 저장 전 초안일 수 있어 건드리지 않는다)
    let old = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
    s.with_conn(|c| Ok(c.execute("UPDATE attachments SET created_at = ?1 WHERE id <> ?2", [&old, &orphan_recent.id])?)).unwrap();

    let dry = s.with_conn(|c| attachments::cleanup_unreferenced(c, &s.paths, true)).unwrap();
    assert_eq!(dry.candidates, 1, "{dry:?}");
    assert_eq!(dry.kept_for_backups, 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM attachments"), 5, "dry run 은 지우지 않는다");
    let done = s.with_conn(|c| attachments::cleanup_unreferenced(c, &s.paths, false)).unwrap();
    assert_eq!(done.removed, 1);
    let left: Vec<String> =
        s.with_conn(|c| Ok(c.prepare("SELECT id FROM attachments")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert!(!left.contains(&orphan_old.id));
    for kept in [&current.id, &in_history.id, &orphan_recent.id, &in_backup.id] {
        assert!(left.contains(kept));
        assert!(s.with_conn(|c| attachments::read_bytes(c, &s.paths, kept)).is_ok(), "남긴 이미지는 파일도 그대로");
    }
}

/// 긴 문서 붙여넣기 — 수십만 자 본문이 SQLite 에 그대로 저장되고, 저장소를 다시 열어도(재실행) 마지막 글자까지 같다.
#[test]
fn long_pasted_memo_is_stored_and_reopened_without_loss() {
    let (_d, s) = temp_storage();
    let body: String = (0..6000).map(|i| format!("{i}번째 줄 가나다 English 123 😀👨‍👩‍👧‍👦 &amp; &lt;tag&gt;<br>")).collect();
    let html = format!("[FIRST] {body}[END-OF-MEMO-PASTE-TEST-12345]");
    assert!(html.chars().count() > 250_000);
    let item = add(&s, next(None), "next", &html);
    let appended = format!("{html}<br>{body}끝에 붙인 장문 [APPEND]");
    s.with_conn(|c| service::update_content(c, &item.id, &appended)).unwrap();
    let root = s.paths.root.clone();
    drop(s);
    let (s, _) = plan_a_memo_lib::storage::Storage::open(&root, false).unwrap();
    let list = s.with_conn(|c| service::get_list(c, None)).unwrap();
    assert_eq!(list.items[0].content_html, appended, "재실행 후에도 한 글자도 다르지 않다");
    let text: String = s
        .with_conn(|c| Ok(c.query_row("SELECT content_text FROM memo_items WHERE id = ?1", [&item.id], |r| r.get(0))?))
        .unwrap();
    assert!(text.starts_with("[FIRST]") && text.ends_with("[APPEND]"), "검색용 평문도 끝까지");
    // 저장 한도(2MB)를 넘으면 잘라 저장하지 않고 분명한 오류 — 기존 내용은 그대로
    let huge = "가".repeat(800_000);
    let err = s.with_conn(|c| service::update_content(c, &item.id, &huge)).unwrap_err();
    assert_eq!(err.code(), "validation");
    assert!(err.to_string().contains("2MB"));
    assert_eq!(s.with_conn(|c| service::get_list(c, None)).unwrap().items[0].content_html, appended);
}

#[test]
fn search_and_months_stay_fast_with_many_memos() {
    let (_d, s) = temp_storage();
    s.with_conn(|c| {
        let tx = c.transaction()?;
        for n in 0..1000 {
            let date = (chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap() + chrono::Duration::days(n)).format("%Y-%m-%d").to_string();
            tx.execute("INSERT INTO documents (id, kind, memo_date, created_at, updated_at) VALUES (?1, 'DAY', ?2, 't', 't')", [format!("doc-{n}"), date])?;
            for i in 0..20 {
                tx.execute(
                    "INSERT INTO memo_items (id, document_id, section, content_html, content_text, sort_order, created_at, updated_at) VALUES (?1, ?2, 'main', ?3, ?3, ?4, 't', 't')",
                    rusqlite::params![format!("item-{n}-{i}"), format!("doc-{n}"), format!("<p>반복되는 메모 본문 {n} {i} 프로젝트 정리</p>"), i],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    let date = search::DateQuery { year: None, month: 3, day: 9, prefer_year: 2026, rest: String::new() };
    let timed = |label: &str, run: &dyn Fn() -> usize, expect: usize| {
        let start = std::time::Instant::now();
        let found = run();
        let elapsed = start.elapsed();
        println!("{label}: {found}건 {elapsed:?}");
        assert_eq!(found, expect, "{label}");
        assert!(elapsed.as_millis() < 3000, "{label} {elapsed:?}");
    };
    timed("본문 검색 20000건 중 첫 200건", &|| s.with_conn(|c| search::search(c, "프로젝트")).unwrap().items.len(), 200);
    timed("날짜 검색", &|| s.with_conn(|c| search::search_with(c, "3/9", Some(&date), 200)).unwrap().days.len(), 3);
    timed("월 카드", &|| s.with_conn(|c| service::day_months(c, "2026-11-02")).unwrap().len(), 33);
    timed("한 달 펼치기", &|| s.with_conn(|c| service::days_in_month(c, "2025-03", "2026-11-02")).unwrap().len(), 31);
}
