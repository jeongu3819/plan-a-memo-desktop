//! 이미지 첨부 — 붙여넣기·끌어 놓기·파일 선택 모두 저장 폴더 attachments/ 로 **복사**한다.
//! 원본 외부 경로는 저장하지 않는다. HTML 은 `attachment://<id>` 로만 참조한다.

use std::io::Write;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::storage::StoragePaths;
use crate::util::{new_id, now, sha256_hex};

pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    /// 본문에 넣을 저장 주소.
    pub url: String,
    pub mime_type: String,
    pub size: i64,
    pub content_hash: String,
}

#[derive(Debug, Clone)]
pub struct AttachmentRow {
    pub id: String,
    pub relative_path: String,
    pub mime_type: String,
    pub size: i64,
    pub content_hash: String,
    pub server_attachment_id: Option<String>,
}

/// 실제 바이트로 형식을 판별한다(확장자·클라이언트가 말한 형식을 믿지 않는다).
pub fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if bytes.starts_with(b"BM") {
        Some(("image/bmp", "bmp"))
    } else {
        None
    }
}

/// 이미지를 저장 폴더에 쓰고 DB 에 기록한다. 파일은 임시 이름으로 쓴 뒤 바꿔 끼운다(쓰다 꺼져도 반쪽 파일 없음).
pub fn import_bytes(
    conn: &Connection,
    paths: &StoragePaths,
    bytes: &[u8],
    original_name: Option<&str>,
    item_id: Option<&str>,
) -> AppResult<AttachmentInfo> {
    if bytes.is_empty() {
        return Err(AppError::validation("빈 이미지입니다."));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::validation("이미지가 너무 큽니다(25MB 제한)."));
    }
    let (mime, ext) = sniff_image(bytes).ok_or_else(|| AppError::validation("지원하지 않는 이미지 형식입니다(PNG·JPG·GIF·WEBP·BMP)."))?;
    let id = new_id();
    let month = chrono::Utc::now().format("%Y/%m").to_string();
    let relative = format!("attachments/{month}/{id}.{ext}");
    let target = paths.root.join(&relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension(format!("{ext}.tmp"));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, &target)?;
    let hash = sha256_hex(bytes);
    let (doc_id, item_id): (Option<String>, Option<String>) = match item_id {
        Some(item) => conn
            .query_row("SELECT document_id, id FROM memo_items WHERE id = ?1", [item], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .map(|(d, i)| (Some(d), Some(i)))
            .unwrap_or((None, None)),
        None => (None, None),
    };
    let name = original_name.map(|n| n.chars().take(200).collect::<String>());
    let inserted = conn.execute(
        "INSERT INTO attachments (id, document_id, item_id, relative_path, mime_type, size, content_hash, original_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, doc_id, item_id, relative, mime, bytes.len() as i64, hash, name, now()],
    );
    if let Err(error) = inserted {
        let _ = std::fs::remove_file(&target);
        return Err(error.into());
    }
    Ok(AttachmentInfo { url: format!("attachment://{id}"), id, mime_type: mime.into(), size: bytes.len() as i64, content_hash: hash })
}

pub fn get_row(conn: &Connection, id: &str) -> AppResult<Option<AttachmentRow>> {
    Ok(conn
        .query_row(
            "SELECT id, relative_path, mime_type, size, content_hash, server_attachment_id FROM attachments WHERE id = ?1",
            [id],
            |r| {
                Ok(AttachmentRow {
                    id: r.get(0)?,
                    relative_path: r.get(1)?,
                    mime_type: r.get(2)?,
                    size: r.get(3)?,
                    content_hash: r.get(4)?,
                    server_attachment_id: r.get(5)?,
                })
            },
        )
        .optional()?)
}

/// 상대 경로를 저장 폴더 **안의** 실제 경로로(.. · 절대 경로 거부).
pub fn resolve_path(paths: &StoragePaths, relative: &str) -> AppResult<PathBuf> {
    let rel = std::path::Path::new(relative);
    let safe = rel.components().all(|c| matches!(c, std::path::Component::Normal(_)));
    if !safe || !relative.starts_with("attachments/") {
        return Err(AppError::new("invalid_path", "잘못된 첨부 경로입니다."));
    }
    Ok(paths.root.join(rel))
}

// ── 쓰지 않는 이미지 정리(보수적) ─────────────────────────────────────────

/// 이 날짜보다 새로 들어온 이미지는 정리하지 않는다(붙여넣은 직후 아직 저장 전인 초안 보호).
pub const CLEANUP_MIN_AGE_DAYS: i64 = 7;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub total: usize,
    /// 지울 수 있는 이미지(어디에서도 참조하지 않고, 오래된 것)
    pub candidates: usize,
    pub candidate_bytes: i64,
    /// Backup 에만 남아 있어서 지키는 이미지
    pub kept_for_backups: usize,
    pub removed: usize,
    pub dry_run: bool,
}

/// DB 의 모든 참조 — 현재 메모(삭제된 항목 포함), History Snapshot, 비교(Conflict) Snapshot.
fn referenced_ids(conn: &Connection) -> AppResult<std::collections::HashSet<String>> {
    let mut ids = std::collections::HashSet::new();
    for sql in [
        "SELECT content_html FROM memo_items",
        "SELECT snapshot_json FROM document_versions",
        "SELECT local_snapshot_json || remote_snapshot_json FROM conflicts",
    ] {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for text in rows {
            ids.extend(crate::memo::text::attachment_ids(&text?));
        }
    }
    Ok(ids)
}

/// 아무 데서도 참조하지 않는 오래된 이미지 파일을 정리한다. `dry_run` 이면 세기만 한다.
/// Backup DB 가 참조하는 이미지는 남긴다(Backup 을 복원했을 때 이미지가 없어지지 않게).
/// History 를 지우지 않는다 — History 가 참조하는 이미지는 언제나 남는다.
pub fn cleanup_unreferenced(conn: &Connection, paths: &StoragePaths, dry_run: bool) -> AppResult<CleanupReport> {
    let mut report = CleanupReport { dry_run, ..Default::default() };
    let live = referenced_ids(conn)?;
    let mut backup_refs = std::collections::HashSet::new();
    if let Ok(dir) = std::fs::read_dir(paths.backups_dir()) {
        for entry in dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("sqlite3") {
                continue;
            }
            let opened = rusqlite::Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            );
            match opened.map_err(AppError::from).and_then(|backup| referenced_ids(&backup)) {
                Ok(ids) => backup_refs.extend(ids),
                // 읽을 수 없는 Backup 이 있으면 무엇도 지우지 않는다(안전 쪽).
                Err(_) => {
                    log::warn!("cleanup skipped: a backup could not be read");
                    return Ok(report);
                }
            }
        }
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(CLEANUP_MIN_AGE_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rows: Vec<(String, String, i64, String)> = conn
        .prepare("SELECT id, relative_path, size, created_at FROM attachments")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    report.total = rows.len();
    for (id, relative, size, created_at) in rows {
        if live.contains(&id) || created_at > cutoff {
            continue;
        }
        if backup_refs.contains(&id) {
            report.kept_for_backups += 1;
            continue;
        }
        report.candidates += 1;
        report.candidate_bytes += size;
        if !dry_run {
            let path = resolve_path(paths, &relative)?;
            // DB 기록을 먼저 지우고(transaction) 파일을 지운다 — 파일만 남는 쪽이 안전하다.
            conn.execute("DELETE FROM attachments WHERE id = ?1", [&id])?;
            let _ = std::fs::remove_file(path);
            report.removed += 1;
        }
    }
    Ok(report)
}

pub fn read_bytes(conn: &Connection, paths: &StoragePaths, id: &str) -> AppResult<(Vec<u8>, String)> {
    let row = get_row(conn, id)?.ok_or_else(|| AppError::not_found("이미지"))?;
    let path = resolve_path(paths, &row.relative_path)?;
    Ok((std::fs::read(path)?, row.mime_type))
}
