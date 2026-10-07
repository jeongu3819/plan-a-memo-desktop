//! DayMemo · Next List · 체크/수정/삭제/이동/정렬 · 즐겨찾기 · History · 검색 · 첨부 · 내보내기.

mod common;

use std::io::Read;

use common::*;
use plan_a_memo_lib::attachments;
use plan_a_memo_lib::memo::service::{self, MoveItem, MovePolicy};
use plan_a_memo_lib::memo::{export, history, repo, search, Location, DEFAULT_LIST_ID};
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
fn edits_are_coalesced_in_history_and_restore_works() {
    let (_d, s) = temp_storage();
    let item = add(&s, day("2026-10-07"), "main", "v1");
    for v in 2..6 {
        s.with_conn(|c| service::update_content(c, &item.id, &format!("v{v}"))).unwrap();
    }
    let versions = s.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert_eq!(versions.len(), 1, "연속 편집은 5분 안에서 한 번만 남긴다");
    assert!(versions[0].preview.contains("v1"));
    s.with_conn(|c| history::restore(c, versions[0].id)).unwrap();
    assert_eq!(texts(&s, "2026-10-07"), vec!["v1"]);
    // 복원 전 상태(v5)도 History 에 남는다
    let after = s.with_conn(|c| history::list_for_location(c, &day("2026-10-07"))).unwrap();
    assert!(after.iter().any(|v| v.reason == "restore" && v.preview.contains("v5")));
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
fn next_lists_create_rename_delete_moves_items_to_default() {
    let (_d, s) = temp_storage();
    let list = s.with_conn(|c| service::create_list(c, None, "앱 개발")).unwrap();
    add(&s, next(Some(&list.id)), "next", "음성 메모");
    add(&s, next(Some(&list.id)), "next", "Calendar 디자인");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM documents WHERE kind = 'NEXT_LIST'"), 1, "List 하나 = 문서 1건");
    let renamed = s.with_conn(|c| service::rename_list(c, &list.id, "앱 개발 2")).unwrap();
    assert_eq!(renamed.name, "앱 개발 2");
    assert!(s.with_conn(|c| service::rename_list(c, DEFAULT_LIST_ID, "x")).is_err());
    let result = s.with_conn(|c| service::delete_list(c, &list.id)).unwrap();
    assert_eq!(result.moved_count, 2);
    let default = s.with_conn(|c| service::get_list(c, None)).unwrap();
    assert_eq!(default.items.len(), 2, "List 를 지워도 메모는 기본 Next 로");
    assert_eq!(s.with_conn(|c| service::lists(c)).unwrap().len(), 1);
}

#[test]
fn search_finds_text_not_tags_and_history_only_content() {
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
    assert!(r.items.is_empty());
    assert_eq!(r.history.len(), 1, "지금은 없는 내용도 History 에서 찾는다");
    assert_eq!(r.history[0].location, day("2026-10-08"));
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
