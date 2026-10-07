//! Local DB Migration. 앱 업데이트에서 DB 를 지우고 새로 만드는 일은 없다 —
//! 버전 순서대로 한 번씩, 각자 transaction 안에서 적용한다.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "init", sql: include_str!("../../../migrations/0001_init.sql") },
    Migration { version: 2, name: "memo_sync_v1", sql: include_str!("../../../migrations/0002_memo_sync_v1.sql") },
];

pub fn latest_version() -> i64 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
}

fn ensure_table(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            checksum    TEXT NOT NULL,
            applied_at  TEXT NOT NULL
        );",
    )?;
    Ok(())
}

pub fn current_version(conn: &Connection) -> AppResult<i64> {
    ensure_table(conn)?;
    let version: Option<i64> = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get(0)).optional()?.flatten();
    Ok(version.unwrap_or(0))
}

pub fn pending(conn: &Connection) -> AppResult<Vec<i64>> {
    let current = current_version(conn)?;
    if current > latest_version() {
        return Err(AppError::new(
            "db_newer_than_app",
            "이 메모 데이터는 더 새로운 버전의 PLAN-A Memo 에서 만들어졌습니다. 앱을 업데이트해주세요.",
        ));
    }
    Ok(MIGRATIONS.iter().filter(|m| m.version > current).map(|m| m.version).collect())
}

pub fn apply(conn: &mut Connection) -> AppResult<Vec<i64>> {
    let todo = pending(conn)?;
    let mut applied = Vec::new();
    for migration in MIGRATIONS.iter().filter(|m| todo.contains(&m.version)) {
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            params![migration.version, migration.name, crate::util::sha256_hex(migration.sql.as_bytes()), crate::util::now()],
        )?;
        tx.commit()?;
        log::info!("migration applied: v{} {}", migration.version, migration.name);
        applied.push(migration.version);
    }
    // 이미 적용된 migration 의 SQL 이 바뀌었으면(개발 중 실수) 기록만 남긴다.
    let mut stmt = conn.prepare("SELECT version, checksum FROM schema_migrations")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (version, checksum) = row?;
        if let Some(m) = MIGRATIONS.iter().find(|m| m.version == version) {
            if crate::util::sha256_hex(m.sql.as_bytes()) != checksum {
                log::warn!("migration v{version} checksum differs from applied version");
            }
        }
    }
    Ok(applied)
}
