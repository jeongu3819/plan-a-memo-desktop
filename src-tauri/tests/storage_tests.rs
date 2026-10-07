//! 저장 위치 · SQLite · Migration · Transaction · Backup · 위치 변경 · Crash 복구.

mod common;

use common::*;
use plan_a_memo_lib::attachments;
use plan_a_memo_lib::storage::relocate::{relocate, FailPoint};
use plan_a_memo_lib::storage::{backup, inspect_location, migrations, Storage, StoragePaths};

#[test]
fn first_open_creates_folder_layout_and_schema() {
    let (_dir, storage) = temp_storage();
    let paths = &storage.paths;
    for dir in [paths.data_dir(), paths.attachments_dir(), paths.backups_dir(), paths.exports_dir(), paths.sync_dir()] {
        assert!(dir.is_dir(), "{dir:?}");
    }
    assert!(paths.db_path().is_file());
    assert!(paths.marker_path().is_file());
    assert_eq!(count(&storage, "SELECT MAX(version) FROM schema_migrations"), migrations::latest_version());
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM next_lists WHERE is_default = 1"), 1);
    let mode: String = storage.with_conn(|c| Ok(c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?)).unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
    assert_eq!(count(&storage, "PRAGMA foreign_keys"), 1);
}

#[test]
fn reopen_keeps_data_and_applies_no_migration() {
    let (dir, storage) = temp_storage();
    let root = storage.paths.root.clone();
    add(&storage, day("2026-10-07"), "main", "AWS 확인");
    storage.close();
    drop(storage);
    let (reopened, report) = Storage::open(&root, false).unwrap();
    assert!(report.applied_migrations.is_empty());
    assert!(!report.created);
    assert_eq!(texts(&reopened, "2026-10-07"), vec!["AWS 확인"]);
    drop(dir);
}

#[test]
fn missing_configured_location_is_not_silently_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let error = Storage::open(&dir.path().join("gone"), false).err().unwrap();
    assert_eq!(error.code(), "storage_missing");
    assert!(!dir.path().join("gone").exists(), "빈 저장소를 만들면 안 된다");
}

#[test]
fn newer_database_is_refused() {
    let (_dir, storage) = temp_storage();
    let root = storage.paths.root.clone();
    storage
        .with_conn(|c| {
            c.execute("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'future', 'x', 'now')", [])?;
            Ok(())
        })
        .unwrap();
    storage.close();
    drop(storage);
    assert_eq!(Storage::open(&root, false).err().unwrap().code(), "db_newer_than_app");
}

#[test]
fn failed_migration_rolls_back_completely() {
    let dir = tempfile::tempdir().unwrap();
    let paths = StoragePaths::new(dir.path().join("broken"));
    std::fs::create_dir_all(paths.data_dir()).unwrap();
    {
        // migration v1 의 중간(documents)에서 실패하도록 같은 이름의 다른 테이블을 미리 만든다.
        let conn = rusqlite::Connection::open(paths.db_path()).unwrap();
        conn.execute_batch("CREATE TABLE documents (x INTEGER);").unwrap();
    }
    assert!(Storage::open(&paths.root, false).is_err());
    let conn = rusqlite::Connection::open(paths.db_path()).unwrap();
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'next_lists', 'memo_items')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0, "실패한 migration 의 앞부분도 남지 않는다");
    let applied: i64 = conn.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(applied, 0);
}

#[test]
fn foreign_keys_and_checks_are_enforced() {
    let (_dir, storage) = temp_storage();
    let result = storage.with_conn(|c| {
        c.execute(
            "INSERT INTO memo_items (id, document_id, section, created_at, updated_at) VALUES ('a', 'no-such-doc', 'main', 'x', 'x')",
            [],
        )?;
        Ok(())
    });
    assert!(result.is_err(), "없는 문서를 가리키는 항목은 저장되지 않는다");
    let bad_section = storage.with_conn(|c| {
        c.execute("INSERT INTO documents (id, kind, memo_date, created_at, updated_at) VALUES ('d', 'DAY', '2026-10-07', 'x', 'x')", [])?;
        c.execute("INSERT INTO memo_items (id, document_id, section, created_at, updated_at) VALUES ('b', 'd', 'evening', 'x', 'x')", [])?;
        Ok(())
    });
    assert!(bad_section.is_err());
    // 같은 날짜 문서는 하나뿐
    let dup = storage.with_conn(|c| {
        c.execute("INSERT INTO documents (id, kind, memo_date, created_at, updated_at) VALUES ('d2', 'DAY', '2026-10-07', 'x', 'x')", [])?;
        Ok(())
    });
    assert!(dup.is_err());
}

#[test]
fn uncommitted_transaction_disappears_after_crash_and_committed_data_survives() {
    let (_dir, storage) = temp_storage();
    let root = storage.paths.root.clone();
    add(&storage, day("2026-10-07"), "main", "commit 된 메모");
    // 쓰는 도중 꺼짐: transaction 을 열고 commit 없이 연결을 버린다.
    {
        let conn = plan_a_memo_lib::storage::open_connection(&storage.paths.db_path()).unwrap();
        conn.execute_batch("BEGIN; UPDATE memo_items SET content_html = '반쯤 쓴 내용';").unwrap();
        std::mem::forget(conn); // 정리(rollback/close) 없이 사라짐
    }
    // 앱도 정상 종료 없이 꺼짐(WAL checkpoint 없음)
    std::mem::forget(storage);
    let (reopened, _) = Storage::open(&root, false).unwrap();
    assert_eq!(texts(&reopened, "2026-10-07"), vec!["commit 된 메모"]);
    let check: String = reopened.with_conn(|c| Ok(c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?)).unwrap();
    assert_eq!(check, "ok");
}

#[test]
fn inspect_location_rules() {
    let dir = tempfile::tempdir().unwrap();
    // 드라이브 최상위는 거절
    let root = std::path::Path::new(if cfg!(windows) { "C:\\" } else { "/" });
    assert!(inspect_location(root).problem.is_some());
    assert!(inspect_location(std::path::Path::new("relative\\path")).problem.is_some());
    // 비어 있지 않은 일반 폴더 → 그 안의 "PLAN-A Memo"
    std::fs::write(dir.path().join("다른 파일.txt"), b"x").unwrap();
    let inspected = inspect_location(dir.path());
    assert!(inspected.problem.is_none());
    assert!(inspected.resolved_path.ends_with("PLAN-A Memo"));
    // 빈 폴더는 그대로
    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    assert_eq!(inspect_location(&empty).resolved_path, empty.display().to_string());
    // 아직 없는 폴더도 가능(만들 수 있으면)
    let fresh = inspect_location(&dir.path().join("new folder"));
    assert!(fresh.writable && !fresh.exists && fresh.problem.is_none());
}

#[test]
fn backup_is_consistent_and_pruned() {
    let (_dir, storage) = temp_storage();
    add(&storage, day("2026-10-07"), "main", "백업될 메모");
    let path = storage.with_conn(|c| backup::create(c, &storage.paths, "manual test")).unwrap();
    assert!(path.file_name().unwrap().to_string_lossy().contains("manual-test"));
    let copy = rusqlite::Connection::open(&path).unwrap();
    let n: i64 = copy.query_row("SELECT COUNT(*) FROM memo_items", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    drop(copy); // Windows 는 열린 파일을 지울 수 없다
    for i in 0..(backup::MAX_BACKUPS + 5) {
        storage.with_conn(|c| backup::create(c, &storage.paths, &format!("n{i}"))).unwrap();
    }
    let n = backup::list(&storage.paths).len();
    assert!(
        n <= backup::MAX_BACKUPS,
        "{n} backups: {:?}",
        backup::list(&storage.paths).iter().map(|b| b.file_name.clone()).collect::<Vec<_>>()
    );
}

fn storage_with_content() -> (tempfile::TempDir, Storage) {
    let (dir, storage) = temp_storage();
    let item = add(&storage, day("2026-10-07"), "main", "이동할 메모");
    let info = storage.with_conn(|c| attachments::import_bytes(c, &storage.paths, PNG, Some("a.png"), Some(&item.id))).unwrap();
    storage
        .with_conn(|c| plan_a_memo_lib::memo::service::update_content(c, &item.id, &format!("이동할 메모<img src=\"{}\">", info.url)))
        .unwrap();
    (dir, storage)
}

#[test]
fn relocate_copies_verifies_and_switches() {
    let (dir, storage) = storage_with_content();
    let target = dir.path().join("D drive").join("PLAN-A Memo");
    let (moved, report) = relocate(&storage, &target, FailPoint::None).unwrap();
    assert_eq!(report.new_root, target.display().to_string());
    assert_eq!(texts(&moved, "2026-10-07").len(), 1);
    assert_eq!(count(&moved, "SELECT COUNT(*) FROM attachments"), 1);
    let rel: String = moved.with_conn(|c| Ok(c.query_row("SELECT relative_path FROM attachments", [], |r| r.get(0))?)).unwrap();
    assert!(target.join(rel).is_file(), "첨부 파일도 새 위치로");
    assert!(target.join("backups").read_dir().unwrap().count() >= 1, "변경 전 Backup 도 함께 옮겨진다");
    // 예전 저장소는 닫혀 더는 쓰이지 않는다(데이터는 남아 있다)
    assert_eq!(storage.with_conn(|_| Ok(())).err().unwrap().code(), "storage_moved");
    assert!(storage.paths.db_path().is_file());
}

#[test]
fn relocate_failure_rolls_back_and_keeps_old_location() {
    for fail in [FailPoint::AfterCopy, FailPoint::Verify] {
        let (dir, storage) = storage_with_content();
        let target = dir.path().join("new place");
        assert!(relocate(&storage, &target, fail).is_err());
        assert!(!target.exists(), "실패하면 새 위치에 만든 것을 지운다 ({fail:?})");
        // 기존 저장소는 계속 쓸 수 있다
        add(&storage, day("2026-10-08"), "main", "계속 저장됨");
        assert_eq!(texts(&storage, "2026-10-08"), vec!["계속 저장됨"]);
    }
}

#[test]
fn relocate_refuses_existing_storage_and_overlap() {
    let (dir, storage) = storage_with_content();
    let other_root = dir.path().join("other");
    let (other, _) = Storage::open(&other_root, true).unwrap();
    drop(other);
    assert_eq!(relocate(&storage, &other_root, FailPoint::None).err().unwrap().code(), "target_has_storage");
    let inside = storage.paths.root.join("sub");
    assert_eq!(relocate(&storage, &inside, FailPoint::None).err().unwrap().code(), "invalid_path");
}

#[test]
fn install_folder_is_never_used_as_storage() {
    let install_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let inspected = inspect_location(&install_dir.join("PLAN-A Memo"));
    assert!(inspected.problem.unwrap().contains("설치 폴더"));
}

/// 0.1.x 사용자의 v1 DB(메모·Mock 시절 연결·충돌 기록 포함)를 v2(memo-sync-v1)로 올려도 데이터가 그대로이고,
/// 올리기 전에 Backup 이 생긴다.
#[test]
fn upgrade_from_v1_database_keeps_everything_and_backs_up_first() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("PLAN-A Memo");
    let paths = StoragePaths::new(&root);
    paths.ensure_dirs().unwrap();
    {
        let conn = rusqlite::Connection::open(paths.db_path()).unwrap();
        conn.execute_batch(migrations::MIGRATIONS[0].sql).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
             INSERT INTO schema_migrations VALUES (1, 'init', 'x', '2026-10-01T00:00:00Z');
             INSERT INTO documents (id, kind, memo_date, local_revision, sync_enabled, sync_status, created_at, updated_at)
               VALUES ('d1', 'DAY', '2026-10-07', 3, 1, 'conflict', 't', 't');
             INSERT INTO memo_items (id, document_id, section, content_html, content_text, created_at, updated_at)
               VALUES ('i1', 'd1', 'am', '<b>회의</b>', '회의', 't', 't');
             INSERT INTO sync_links (document_id, server_document_id, account_id, linked_at) VALUES ('d1', 'mock-doc', 'mock-account-1', 't');
             INSERT INTO conflicts (id, document_id, local_snapshot_json, remote_snapshot_json, local_revision, remote_version, created_at, updated_at)
               VALUES ('c1', 'd1', '{}', '{}', 3, 2, 't', 't');",
        )
        .unwrap();
    }
    let (storage, report) = Storage::open(&root, false).unwrap();
    assert_eq!(report.applied_migrations, vec![2]);
    assert!(report.backup_before_migration.is_some(), "migration 전 Backup");
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM memo_items WHERE content_html = '<b>회의</b>'"), 1);
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM conflicts WHERE id = 'c1' AND status = 'open'"), 1, "충돌 기록 보존(테이블 교체)");
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM sync_links WHERE account_key IS NULL"), 1, "예전 개발용 연결은 계정 없음으로 남는다");
    assert_eq!(count(&storage, "SELECT COUNT(*) FROM sync_item_map"), 0);
    // 새 컬럼·제약
    storage
        .with_conn(|c| Ok(c.execute("UPDATE conflicts SET status = 'resolved_elsewhere', source = 'web' WHERE id = 'c1'", [])?))
        .unwrap();
    assert!(storage.with_conn(|c| Ok(c.execute("UPDATE conflicts SET source = 'other' WHERE id = 'c1'", [])?)).is_err());
}
