//! 내보내기 — PLAN-A Work 개인 메모 내보내기와 같은 형식(txt · csv · zip).
//!
//! ZIP 구성은 서버 `personal_memo_backup.py` 와 같다:
//!   index.html · memos/memo-<id>.html · images/image-001.png · style.css · memos.txt · memos.csv
//!   · manifest.json(format "plan-a-personal-memo-backup", version 1) · MISSING_IMAGES.txt(누락이 있을 때만)
//! 서버로 아무것도 올리지 않는다. 이미지는 저장 폴더의 첨부 파일을 그대로 담는다.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{repo, text, MemoItem, DEFAULT_LIST_ID};
use crate::attachments;
use crate::error::{AppError, AppResult};
use crate::storage::StoragePaths;

const WEEKDAY_KO: [&str; 7] = ["월", "화", "수", "목", "금", "토", "일"];

fn section_label(section: &str) -> &'static str {
    match section {
        "main" => "메인 할 일",
        "am" => "오전 할 일",
        "pm" => "오후 할 일",
        _ => "",
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// txt | csv | zip
    pub format: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub include_next: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub memo_count: usize,
    pub images_saved: usize,
    pub images_missing: usize,
}

struct Row {
    item: MemoItem,
    memo_date: Option<String>,
    list_name: Option<String>,
}

fn day_label(day: &str) -> String {
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map(|d| {
            use chrono::Datelike;
            format!("{day} ({})", WEEKDAY_KO[d.weekday().num_days_from_monday() as usize])
        })
        .unwrap_or_else(|_| day.to_string())
}

fn location_key(row: &Row) -> String {
    row.memo_date.clone().unwrap_or_else(|| format!("next:{}", row.list_name.clone().unwrap_or_default()))
}

fn location_label(row: &Row) -> String {
    match (&row.memo_date, &row.list_name) {
        (Some(day), _) => day_label(day),
        (None, Some(name)) => format!("Next > {name}"),
        (None, None) => "Next (날짜 미정)".into(),
    }
}

fn collect(conn: &Connection, options: &ExportOptions) -> AppResult<Vec<Row>> {
    let mut rows = Vec::new();
    let mut docs: Vec<(String, Option<String>, Option<String>)> = conn
        .prepare(
            "SELECT id, memo_date, next_list_id FROM documents WHERE deleted_at IS NULL
              ORDER BY kind, memo_date",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    // Next: 기본 Next 먼저, 그다음 List 순서
    let list_order: HashMap<String, (i64, i64)> = conn
        .prepare("SELECT id, is_default, sort_order FROM next_lists WHERE deleted_at IS NULL")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, (1 - r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))))?
        .collect::<Result<_, _>>()?;
    docs.sort_by_key(|(_, date, list)| {
        (date.is_none(), date.clone().unwrap_or_default(), list.as_ref().and_then(|l| list_order.get(l)).copied().unwrap_or((9, 9)))
    });
    for (doc_id, date, list) in docs {
        match &date {
            Some(day) => {
                if options.from.as_deref().map(|f| day.as_str() < f).unwrap_or(false)
                    || options.to.as_deref().map(|t| day.as_str() > t).unwrap_or(false)
                {
                    continue;
                }
            }
            None => {
                if !options.include_next {
                    continue;
                }
                if list.as_ref().map(|l| !list_order.contains_key(l)).unwrap_or(true) {
                    continue; // 삭제된 List
                }
            }
        }
        let list_name = match &list {
            Some(id) if id != DEFAULT_LIST_ID => repo::list_name(conn, id)?,
            _ => None,
        };
        for item in repo::items_of(conn, &doc_id)? {
            rows.push(Row { item, memo_date: date.clone(), list_name: list_name.clone() });
        }
    }
    Ok(rows)
}

fn status(item: &MemoItem) -> &'static str {
    if item.kind != "checklist" {
        "텍스트"
    } else if item.completed {
        "완료"
    } else {
        "할 일"
    }
}

fn render_txt(rows: &[Row], period: &str, exported_at: &str) -> String {
    let mut lines = vec![
        "내 메모 내보내기".to_string(),
        format!("기간: {period} · 메모 {}개 · 내보낸 시각: {exported_at}", rows.len()),
        "표시: [x] 완료 · [ ] 할 일 · • 텍스트 메모".into(),
        String::new(),
    ];
    let mut current_day = String::from("__none__");
    let mut current_section = String::new();
    for row in rows {
        if location_key(row) != current_day {
            current_day = location_key(row);
            current_section.clear();
            lines.push(String::new());
            lines.push(format!("==== {} ====", location_label(row)));
        }
        if row.memo_date.is_some() && row.item.section != current_section {
            current_section = row.item.section.clone();
            lines.push(format!("[{}]", section_label(&current_section)));
        }
        let (mut body, images) = text::plain_text(&row.item.content_html);
        if images > 0 {
            body = format!("{}[이미지 {images}장]", if body.is_empty() { String::new() } else { format!("{body} ") });
        }
        let marker = if row.item.kind == "checklist" {
            if row.item.completed {
                "[x]"
            } else {
                "[ ]"
            }
        } else {
            " • "
        };
        let body = if body.is_empty() { "(내용 없음)".to_string() } else { body };
        let mut parts = body.split('\n');
        lines.push(format!("{marker} {}", parts.next().unwrap_or_default()));
        lines.extend(parts.map(|l| format!("    {l}")));
    }
    format!("{}\n", lines.join("\n").trim())
}

fn csv_field(value: &str) -> String {
    if value.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn render_csv(rows: &[Row]) -> String {
    let mut out = String::from("\u{feff}");
    let header = ["날짜", "요일", "구역", "종류", "상태", "완료 시각", "내용", "이미지 수", "작성 시각", "수정 시각"];
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    let minutes = |ts: &str| ts.replace('T', " ").chars().take(16).collect::<String>();
    for row in rows {
        let (body, images) = text::plain_text(&row.item.content_html);
        let weekday = row
            .memo_date
            .as_deref()
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .map(|d| {
                use chrono::Datelike;
                WEEKDAY_KO[d.weekday().num_days_from_monday() as usize].to_string()
            })
            .unwrap_or_default();
        let fields = [
            row.memo_date.clone().unwrap_or_else(|| match &row.list_name {
                Some(name) => format!("Next > {name}"),
                None => "Next".into(),
            }),
            weekday,
            if row.memo_date.is_some() { section_label(&row.item.section).into() } else { String::new() },
            if row.item.kind == "checklist" { "체크리스트".into() } else { "텍스트".into() },
            status(&row.item).into(),
            row.item.completed_at.as_deref().filter(|_| row.item.kind == "checklist").map(minutes).unwrap_or_default(),
            body,
            images.to_string(),
            minutes(&row.item.created_at),
            minutes(&row.item.updated_at),
        ];
        out.push_str(&fields.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out
}

const STYLE_CSS_HEAD: &str = r#"/* PLAN-A 개인 메모 백업 — 저장 서식 계약(앱 index.css 와 같은 값). 외부 리소스 없음. */
body { font-family: -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
  color: #273142; margin: 0 auto; max-width: 960px; padding: 24px 16px 64px; line-height: 1.6; font-size: 15px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 28px 0 8px; border-bottom: 1px solid #e5e7eb; }
h3 { font-size: 14px; color: #6b7280; margin: 14px 0 6px; }
.meta { color: #6b7280; font-size: 13px; }
.warning { background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 10px 14px; margin: 16px 0; }
.memo { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px dashed #eef0f3; }
.memo .mark { width: 20px; flex-shrink: 0; color: #9ca3af; }
.memo.done .body { color: #9ca3af; text-decoration: line-through; }
.memo .body { flex: 1; min-width: 0; word-break: break-word; white-space: pre-wrap; }
.memo .link { font-size: 12px; color: #6b7280; }
.body p { margin: 0; }
.body img { max-width: 100%; height: auto; vertical-align: top; border-radius: 4px; }
.body table { border-collapse: collapse; max-width: 100%; margin: 4px 0; }
.body td, .body th { border: 1px solid #d1d5db; padding: 2px 6px; vertical-align: top; }
.body table[data-resizable-table] { table-layout: fixed; }
.missing-image { display: inline-block; padding: 2px 8px; border: 1px dashed #f97316; border-radius: 4px;
  color: #c2410c; font-size: 12px; background: #fff7ed; }
[data-text-size="small"] { font-size: 12px; } [data-text-size="normal"] { font-size: 14.4px; }
[data-text-size="large"] { font-size: 16px; } [data-text-size="xlarge"] { font-size: 20px; }
"#;

fn style_css() -> String {
    let mut css = STYLE_CSS_HEAD.to_string();
    for n in 12..=24 {
        css.push_str(&format!("[data-text-size=\"{n}\"] {{ font-size: {n}px; }}\n"));
    }
    css.push_str(
        r#"td[data-align="left"], th[data-align="left"] { text-align: left !important; }
td[data-align="center"], th[data-align="center"] { text-align: center !important; }
td[data-align="right"], th[data-align="right"] { text-align: right !important; }
:is(p, div, h1, h2, h3, h4, h5, h6, li, blockquote)[data-align="center"] { text-align: center; }
:is(p, div, h1, h2, h3, h4, h5, h6, li, blockquote)[data-align="right"] { text-align: right; }
:is(p, div, h1, h2, h3, h4, h5, h6, li, blockquote)[data-align="left"] { text-align: left; }
"#,
    );
    for n in 1..=6 {
        css.push_str(&format!(":is(p, div)[data-indent=\"{n}\"] {{ margin-left: {}px; }}\n", n * 40));
    }
    css.push_str("table[data-align=\"center\"] { margin-left: auto; margin-right: auto; }\ntable[data-align=\"right\"] { margin-left: auto; margin-right: 0; }\n");
    css
}

fn escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn page(title: &str, body: &str, css_href: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{}</title><link rel=\"stylesheet\" href=\"{css_href}\"></head><body>\n{body}\n</body></html>\n",
        escape(title)
    )
}

/// 앱은 열 너비·행 높이를 실행 중에 펼친다. 스크립트 없는 백업 HTML 은 style 로 옮긴다.
fn static_table_sizes(content: &str) -> String {
    let once = content.to_string();
    let once = add_size_style(&once, "data-col-width=\"", "<col", "width");
    add_size_style(&once, "data-row-min-height=\"", "<tr", "height")
}

fn add_size_style(content: &str, attr: &str, tag_prefix: &str, css: &str) -> String {
    let mut out = String::with_capacity(content.len() + 32);
    let mut rest = content;
    while let Some(pos) = rest.find(attr) {
        let tag_start = rest[..pos].rfind('<').unwrap_or(0);
        let value: String = rest[pos + attr.len()..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let is_tag = rest[tag_start..].get(..tag_prefix.len()).map(|p| p.eq_ignore_ascii_case(tag_prefix)).unwrap_or(false);
        let end = (pos + attr.len() + value.len() + 1).min(rest.len());
        out.push_str(&rest[..end]);
        if is_tag && !value.is_empty() {
            out.push_str(&format!(" style=\"{css}:{value}px\""));
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn image_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/bmp" => ".bmp",
        _ => ".img",
    }
}

pub fn export(conn: &Connection, paths: &StoragePaths, options: &ExportOptions, target: &Path) -> AppResult<ExportResult> {
    let rows = collect(conn, options)?;
    let period =
        format!("{} ~ {}", options.from.clone().unwrap_or_else(|| "처음".into()), options.to.clone().unwrap_or_else(|| "현재".into()));
    let exported_at = chrono::Local::now();
    let stamp = exported_at.format("%Y-%m-%d %H:%M").to_string();
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("partial");
    let mut result = ExportResult { path: target.display().to_string(), memo_count: rows.len(), images_saved: 0, images_missing: 0 };
    match options.format.as_str() {
        "txt" => std::fs::write(&tmp, render_txt(&rows, &period, &stamp))?,
        "csv" => std::fs::write(&tmp, render_csv(&rows))?,
        "zip" => {
            let file = std::fs::File::create(&tmp)?;
            let mut zip = zip::ZipWriter::new(file);
            // ZIP 안 파일 시각 = 내보낸 시각(로컬). 없으면 ZIP 기본값(1980-01-01)이 된다.
            let stamp_time = {
                use chrono::{Datelike, Timelike};
                zip::DateTime::from_date_and_time(
                    exported_at.year().clamp(1980, 2107) as u16,
                    exported_at.month() as u8,
                    exported_at.day() as u8,
                    exported_at.hour() as u8,
                    exported_at.minute() as u8,
                    exported_at.second() as u8,
                )
                .unwrap_or_default()
            };
            let deflate = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .last_modified_time(stamp_time);
            let stored =
                zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).last_modified_time(stamp_time);
            let mut files_by_src: HashMap<String, Option<String>> = HashMap::new();
            let mut manifest_images = Vec::new();
            let mut missing = Vec::new();
            let mut memo_entries = Vec::new();
            let mut sections: Vec<String> = Vec::new();
            let mut current_day = String::from("__none__");
            let mut current_section = String::new();

            for row in &rows {
                // 본문의 이미지를 ZIP 안 파일로
                let mut localize = |prefix: &str, zip: &mut zip::ZipWriter<std::fs::File>| -> AppResult<(String, Vec<String>)> {
                    let mut html = row.item.content_html.clone();
                    let mut used = Vec::new();
                    for id in text::attachment_ids(&row.item.content_html) {
                        let src = format!("attachment://{id}");
                        if !files_by_src.contains_key(&src) {
                            let name = match attachments::read_bytes(conn, paths, &id) {
                                Ok((bytes, mime)) => {
                                    let name = format!("images/image-{:03}{}", manifest_images.len() + 1, image_ext(&mime));
                                    zip.start_file(&name, stored)?;
                                    zip.write_all(&bytes)?;
                                    manifest_images.push(serde_json::json!({
                                        "file": name, "source_kind": "local_attachment", "content_type": mime,
                                        "bytes": bytes.len(), "sha256": crate::util::sha256_hex(&bytes),
                                    }));
                                    Some(name)
                                }
                                Err(_) => {
                                    missing.push(serde_json::json!({
                                        "memo_id": row.item.id, "memo_date": row.memo_date, "source": src,
                                        "source_kind": "local_attachment", "reason": "storage_read_failed",
                                        "message": "저장소에서 이미지 파일을 읽지 못했습니다.",
                                    }));
                                    None
                                }
                            };
                            files_by_src.insert(src.clone(), name);
                        }
                        match files_by_src.get(&src).cloned().flatten() {
                            Some(name) => {
                                html = html.replace(&src, &format!("{prefix}{name}"));
                                used.push(name);
                            }
                            None => {
                                html = html.replace(&format!("src=\"{src}\""), "src=\"\" data-missing=\"1\"");
                            }
                        }
                    }
                    Ok((static_table_sizes(&html), used))
                };
                let (index_body, _) = localize("", &mut zip)?;
                let (page_body, used) = localize("../", &mut zip)?;
                let checklist = row.item.kind == "checklist";
                let done = checklist && row.item.completed;
                let mark = if checklist {
                    if done {
                        "☑"
                    } else {
                        "☐"
                    }
                } else {
                    "•"
                };
                let page_name = format!("memos/memo-{}.html", row.item.id);
                let label = location_label(row);
                if location_key(row) != current_day {
                    current_day = location_key(row);
                    current_section.clear();
                    sections.push(format!("<h2>{}</h2>", escape(&label)));
                }
                if row.memo_date.is_some() && row.item.section != current_section {
                    current_section = row.item.section.clone();
                    sections.push(format!("<h3>{}</h3>", escape(section_label(&current_section))));
                }
                let done_class = if done { " done" } else { "" };
                sections.push(format!(
                    "<div class=\"memo{done_class}\"><span class=\"mark\">{mark}</span><div class=\"body\">{index_body}</div><a class=\"link\" href=\"{page_name}\">개별 파일</a></div>"
                ));
                let heading =
                    if row.memo_date.is_some() { format!("{label} · {}", section_label(&row.item.section)) } else { label.clone() };
                zip.start_file(&page_name, deflate)?;
                zip.write_all(page(
                    &format!("메모 {}", row.item.id),
                    &format!(
                        "<p class=\"meta\"><a href=\"../index.html\">← 전체 메모</a> · {}</p><div class=\"memo{done_class}\"><span class=\"mark\">{mark}</span><div class=\"body\">{page_body}</div></div>",
                        escape(&heading)
                    ),
                    "../style.css",
                ).as_bytes())?;
                memo_entries.push(serde_json::json!({
                    "id": row.item.id, "memo_date": row.memo_date,
                    "section": if row.memo_date.is_some() { row.item.section.clone() } else { "main".into() },
                    "list_name": row.list_name, "kind": row.item.kind, "completed": done,
                    "file": page_name, "images": used,
                    "created_at": row.item.created_at, "updated_at": row.item.updated_at,
                }));
            }
            let warning = if missing.is_empty() {
                String::new()
            } else {
                format!("<div class=\"warning\"><b>이미지 {}개를 백업하지 못했습니다.</b> 본문의 [이미지 누락] 자리와 MISSING_IMAGES.txt 에 사유가 있습니다.</div>", missing.len())
            };
            let header = format!(
                "<h1>내 메모 백업</h1><p class=\"meta\">기간: {} · 메모 {}개 · 이미지 {}개 · 내보낸 시각 {stamp}</p>{warning}",
                escape(&period),
                rows.len(),
                manifest_images.len()
            );
            zip.start_file("index.html", deflate)?;
            zip.write_all(page("내 메모 백업", &format!("{header}{}", sections.join("\n")), "style.css").as_bytes())?;
            zip.start_file("style.css", deflate)?;
            zip.write_all(style_css().as_bytes())?;
            zip.start_file("memos.txt", deflate)?;
            zip.write_all(render_txt(&rows, &period, &stamp).as_bytes())?;
            zip.start_file("memos.csv", deflate)?;
            zip.write_all(render_csv(&rows).as_bytes())?;
            if !missing.is_empty() {
                let mut lines = vec!["백업하지 못한 이미지".to_string(), String::new()];
                for m in &missing {
                    lines.push(format!(
                        "- 메모 {} ({}): {}",
                        m["memo_id"],
                        m["memo_date"].as_str().unwrap_or("Next"),
                        m["message"].as_str().unwrap_or("")
                    ));
                }
                zip.start_file("MISSING_IMAGES.txt", deflate)?;
                zip.write_all(format!("{}\n", lines.join("\n")).as_bytes())?;
            }
            zip.start_file("manifest.json", deflate)?;
            zip.write_all(
                serde_json::to_string_pretty(&serde_json::json!({
                    "format": "plan-a-personal-memo-backup", "version": 1,
                    "source": "plan-a-memo-desktop", "app_version": env!("CARGO_PKG_VERSION"),
                    "exported_at": exported_at.to_rfc3339(), "period": period,
                    "memo_count": rows.len(), "image_count": manifest_images.len(),
                    "complete": missing.is_empty(),
                    "memos": memo_entries, "images": manifest_images, "missing_images": missing,
                }))?
                .as_bytes(),
            )?;
            zip.finish()?;
            result.images_saved = files_by_src.values().filter(|v| v.is_some()).count();
            result.images_missing = files_by_src.values().filter(|v| v.is_none()).count();
        }
        _ => return Err(AppError::validation("형식은 txt, csv, zip 중 하나입니다.")),
    }
    std::fs::rename(&tmp, target)?;
    Ok(result)
}
