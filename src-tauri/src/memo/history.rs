//! 보존된 내용 — 데이터 보호를 위해 남긴 문서 Snapshot 의 목록·보기·복원.
//! 일상 편집의 변경 이력이 아니다. 예전 버전이 남긴 `edit` 기록은 지우지 않지만 목록에 보이지 않는다.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::repo;
use super::{DocumentSnapshot, Location};
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub id: i64,
    pub document_id: String,
    pub reason: String,
    pub reason_label: &'static str,
    pub local_revision: i64,
    pub created_at: String,
    pub item_count: usize,
    pub preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetail {
    pub summary: VersionSummary,
    pub location: Location,
    pub snapshot: DocumentSnapshot,
}

/// 보존된 내용 목록 한 줄 — 어느 날짜·List 의 내용인지 함께.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedVersion {
    #[serde(flatten)]
    pub summary: VersionSummary,
    pub location: Location,
    pub list_name: Option<String>,
}

const PRESERVED_LIMIT: i64 = 200;

pub fn reason_label(reason: &str) -> &'static str {
    match reason {
        "edit" => "수정 전",
        "delete" => "삭제 전",
        "move" => "이동 전",
        "list_delete" => "List 삭제 전",
        "list_restore" => "휴지통에서 복구 전",
        "restore" => "복원 전",
        "carryover" => "지난 미완료 가져오기 전",
        "carry_mapping" | "carry_review" => "지난 미완료 복사본 맞추기 전",
        "remote_apply" => "PLAN-A Work 변경 반영 전",
        "remote_deleted" => "PLAN-A Work 에서 삭제됨",
        "conflict_local" => "충돌 — 선택하지 않은 Desktop 내용",
        "conflict_remote" => "충돌 — 선택하지 않은 PLAN-A Work 내용",
        _ => "변경 전",
    }
}

fn summary(
    id: i64,
    document_id: String,
    reason: String,
    revision: i64,
    created_at: String,
    json: &str,
) -> AppResult<(VersionSummary, DocumentSnapshot)> {
    let snapshot: DocumentSnapshot = serde_json::from_str(json)?;
    let preview: String = snapshot.text().replace('\n', " · ").chars().take(120).collect();
    Ok((
        VersionSummary {
            id,
            document_id,
            reason_label: reason_label(&reason),
            reason,
            local_revision: revision,
            created_at,
            item_count: snapshot.items.len(),
            preview,
        },
        snapshot,
    ))
}

pub fn list_for_location(conn: &Connection, location: &Location) -> AppResult<Vec<VersionSummary>> {
    let Some(doc) = repo::doc_for_location(conn, location)? else { return Ok(Vec::new()) };
    let mut stmt = conn.prepare(
        "SELECT id, document_id, reason, local_revision, created_at, snapshot_json
           FROM document_versions WHERE document_id = ?1 ORDER BY id DESC LIMIT 200",
    )?;
    let rows = stmt
        .query_map([&doc.id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(|(id, doc_id, reason, rev, created, json)| Ok(summary(id, doc_id, reason, rev, created, &json)?.0)).collect()
}

/// 모든 날짜·List 의 보존된 내용(최근 순). 휴지통에 있는 List 는 복구한 뒤에 보인다.
pub fn list_preserved(conn: &Connection) -> AppResult<Vec<PreservedVersion>> {
    let rows = conn
        .prepare(
            "SELECT v.id, v.document_id, v.reason, v.local_revision, v.created_at, v.snapshot_json
               FROM document_versions v
               JOIN documents d ON d.id = v.document_id
               LEFT JOIN next_lists l ON l.id = d.next_list_id
              WHERE v.reason <> 'edit' AND (d.next_list_id IS NULL OR l.deleted_at IS NULL)
              ORDER BY v.id DESC LIMIT ?1",
        )?
        .query_map([PRESERVED_LIMIT], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, doc_id, reason, rev, created, json) in rows {
        let Some(doc) = repo::doc_by_id(conn, &doc_id)? else { continue };
        let list_name = doc.next_list_id.as_deref().map(|l| repo::list_name(conn, l)).transpose()?.flatten();
        out.push(PreservedVersion { summary: summary(id, doc_id, reason, rev, created, &json)?.0, location: repo::location_of_doc(&doc), list_name });
    }
    Ok(out)
}

pub fn get(conn: &Connection, version_id: i64) -> AppResult<VersionDetail> {
    let row = conn
        .query_row(
            "SELECT id, document_id, reason, local_revision, created_at, snapshot_json FROM document_versions WHERE id = ?1",
            [version_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("보존된 내용"))?;
    let doc = repo::doc_by_id(conn, &row.1)?.ok_or_else(|| AppError::not_found("문서"))?;
    let (summary, snapshot) = summary(row.0, row.1, row.2, row.3, row.4, &row.5)?;
    Ok(VersionDetail { summary, location: repo::location_of_doc(&doc), snapshot })
}

/// 이 내용으로 되돌린다. 지금 내용을 먼저 보존한다(되돌리기도 되돌릴 수 있게).
pub fn restore(conn: &mut Connection, version_id: i64) -> AppResult<Location> {
    let detail = get(conn, version_id)?;
    let tx = conn.transaction()?;
    let doc = repo::doc_by_id(&tx, &detail.summary.document_id)?.ok_or_else(|| AppError::not_found("문서"))?;
    if doc.next_list_id.is_some() {
        let alive: Option<i64> = tx
            .query_row("SELECT 1 FROM next_lists WHERE id = ?1 AND deleted_at IS NULL", [doc.next_list_id.as_deref().unwrap_or("")], |r| {
                r.get(0)
            })
            .optional()?;
        if alive.is_none() {
            return Err(AppError::validation("삭제된 List 의 내용은 복원할 수 없습니다. 내용을 복사해 사용해주세요."));
        }
    }
    repo::record_version(&tx, &doc.id, "restore")?;
    repo::replace_items(&tx, &doc, &detail.snapshot.items, true, false)?;
    tx.execute("UPDATE documents SET deleted_at = NULL WHERE id = ?1", params![doc.id])?;
    repo::touch(&tx, &doc.id)?;
    tx.commit()?;
    Ok(detail.location)
}
