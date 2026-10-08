//! Typed Tauri 명령 — React 가 부르는 유일한 입구. SQL·파일 경로 처리는 모두 이 아래(Rust)에 있다.
//!
//! DB 작업은 async 명령으로 두어 UI(main) 스레드를 막지 않는다. 오래 걸리는 작업(내보내기·위치 변경)은
//! blocking 스레드에서 한다.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::attachments::{self, AttachmentInfo};
use crate::auth::loopback::{self, LoopbackListener};
use crate::auth::{AuthProvider, AuthStatus, LoginStart, LogoutResult};
use crate::error::{AppError, AppResult};
use crate::memo::{export, history, repo, search, service, DayMemo, LocatedItem, Location, MemoItem, NextListInfo, NextListMemo, WeekMemo};
use crate::state::{AppState, StorageStatus};
use crate::storage::{self, backup, relocate, LocationInspection, Storage};
use crate::sync::{self, engine, link, SyncOverview};

type Cmd<T> = Result<T, AppError>;

// ── 앱·저장소 ───────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: &'static str,
    pub env: crate::config::AppEnv,
    pub storage: StorageStatus,
    pub sync_transport: &'static str,
    pub real_sync_configured: bool,
    pub today: String,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Cmd<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        env: state.env.env,
        storage: state.status(),
        sync_transport: state.sync.engine.transport.name(),
        real_sync_configured: state.env.real_sync_configured(),
        today: chrono::Local::now().format("%Y-%m-%d").to_string(),
    })
}

#[tauri::command]
pub async fn storage_status(state: State<'_, AppState>) -> Cmd<StorageStatus> {
    Ok(state.status())
}

#[tauri::command]
pub async fn storage_inspect(path: String) -> Cmd<LocationInspection> {
    Ok(storage::inspect_location(&PathBuf::from(path)))
}

/// 첫 실행·위치를 잃었을 때 — 고른 폴더를 저장 위치로 쓴다(이미 저장소면 그대로 연다).
/// `create_new` 가 false 인데 저장소가 아니면 만들지 않는다(실수로 빈 DB 를 여는 것 방지).
#[tauri::command]
pub async fn storage_initialize(state: State<'_, AppState>, path: String, create_new: bool) -> Cmd<StorageStatus> {
    if state.storage().is_ok() {
        return Err(AppError::new("storage_ready", "이미 저장 위치가 열려 있습니다. 설정에서 위치를 바꿔주세요."));
    }
    let inspection = storage::inspect_location(&PathBuf::from(&path));
    if let Some(problem) = inspection.problem {
        return Err(AppError::new("invalid_path", problem));
    }
    if !inspection.is_storage && !create_new {
        return Err(AppError::new("storage_missing", "선택한 위치에 PLAN-A Memo 데이터가 없습니다."));
    }
    let root = PathBuf::from(&inspection.resolved_path);
    let (storage, report) = tauri::async_runtime::spawn_blocking(move || Storage::open(&root, true))
        .await
        .map_err(|_| AppError::new("internal", "작업이 중단되었습니다."))??;
    log::info!("storage initialized (created={})", report.created);
    state.activate(storage);
    Ok(state.status())
}

#[tauri::command]
pub async fn storage_relocate(state: State<'_, AppState>, app: AppHandle, path: String) -> Cmd<relocate::RelocateReport> {
    let target = PathBuf::from(path);
    let report = state.replace_storage(|current| relocate::relocate(current, &target, relocate::FailPoint::None))?;
    let _ = app.emit("storage://changed", &report);
    Ok(report)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderKind {
    Root,
    Attachments,
    Backups,
    Exports,
    Logs,
}

/// 폴더 열기 — 경로는 Rust 가 정한다(화면이 임의 경로를 열지 못하게).
#[tauri::command]
pub async fn open_folder(state: State<'_, AppState>, app: AppHandle, kind: FolderKind) -> Cmd<()> {
    let path = match kind {
        FolderKind::Logs => state.log_dir.clone(),
        other => {
            let storage = state.storage()?;
            match other {
                FolderKind::Root => storage.paths.root.clone(),
                FolderKind::Attachments => storage.paths.attachments_dir(),
                FolderKind::Backups => storage.paths.backups_dir(),
                FolderKind::Exports => storage.paths.exports_dir(),
                FolderKind::Logs => unreachable!(),
            }
        }
    };
    std::fs::create_dir_all(&path)?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| AppError::new("open_failed", "폴더를 열지 못했습니다."))
}

#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>) -> Cmd<backup::BackupInfo> {
    let storage = state.storage()?;
    let path = storage.with_conn(|c| backup::create(c, &storage.paths, "manual"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(backup::list(&storage.paths).into_iter().find(|b| b.file_name == name).unwrap_or(backup::BackupInfo {
        file_name: name,
        size: 0,
        created_at: None,
    }))
}

#[tauri::command]
pub async fn backup_list(state: State<'_, AppState>) -> Cmd<Vec<backup::BackupInfo>> {
    Ok(backup::list(&state.storage()?.paths))
}

// ── 메모 읽기 ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn memo_week(state: State<'_, AppState>, monday: String) -> Cmd<WeekMemo> {
    state.storage()?.with_conn(|c| service::get_week(c, &monday))
}

#[tauri::command]
pub async fn memo_day(state: State<'_, AppState>, date: String) -> Cmd<DayMemo> {
    state.storage()?.with_conn(|c| service::get_day(c, &date))
}

#[tauri::command]
pub async fn memo_list(state: State<'_, AppState>, list_id: Option<String>) -> Cmd<NextListMemo> {
    state.storage()?.with_conn(|c| service::get_list(c, list_id.as_deref()))
}

#[tauri::command]
pub async fn memo_lists(state: State<'_, AppState>) -> Cmd<Vec<NextListInfo>> {
    state.storage()?.with_conn(|c| service::lists(c))
}

#[tauri::command]
pub async fn memo_days(state: State<'_, AppState>, before: Option<String>) -> Cmd<Vec<service::DaySummary>> {
    state.storage()?.with_conn(|c| service::days(c, before.as_deref(), 40))
}

#[tauri::command]
pub async fn memo_search(state: State<'_, AppState>, query: String) -> Cmd<search::SearchResult> {
    state.storage()?.with_conn(|c| search::search(c, &query))
}

#[tauri::command]
pub async fn memo_favorites(state: State<'_, AppState>) -> Cmd<Vec<LocatedItem>> {
    state.storage()?.with_conn(|c| service::favorites(c))
}

// ── 메모 쓰기(쓰기 뒤에는 Sync 를 깨운다 — 연결된 문서가 없으면 아무것도 보내지 않는다) ─────

fn write<T>(state: &State<'_, AppState>, f: impl FnOnce(&mut rusqlite::Connection) -> AppResult<T>) -> Cmd<T> {
    let value = state.storage()?.with_conn(f)?;
    state.sync.poke();
    Ok(value)
}

#[tauri::command]
pub async fn item_create(state: State<'_, AppState>, input: service::CreateItem) -> Cmd<MemoItem> {
    write(&state, |c| service::create_item(c, input))
}

#[tauri::command]
pub async fn item_update_content(state: State<'_, AppState>, id: String, html: String) -> Cmd<MemoItem> {
    write(&state, |c| service::update_content(c, &id, &html))
}

#[tauri::command]
pub async fn item_set_completed(state: State<'_, AppState>, id: String, completed: bool) -> Cmd<MemoItem> {
    write(&state, |c| service::set_completed(c, &id, completed))
}

#[tauri::command]
pub async fn item_set_kind(state: State<'_, AppState>, id: String, kind: String) -> Cmd<MemoItem> {
    write(&state, |c| service::set_kind(c, &id, &kind))
}

#[tauri::command]
pub async fn item_set_favorite(state: State<'_, AppState>, id: String, favorite: bool) -> Cmd<MemoItem> {
    state.storage()?.with_conn(|c| service::set_favorite(c, &id, favorite))
}

#[tauri::command]
pub async fn item_delete(state: State<'_, AppState>, id: String) -> Cmd<MemoItem> {
    write(&state, |c| service::delete_item(c, &id))
}

#[tauri::command]
pub async fn item_restore(state: State<'_, AppState>, id: String) -> Cmd<MemoItem> {
    write(&state, |c| service::restore_item(c, &id))
}

#[tauri::command]
pub async fn item_move(state: State<'_, AppState>, input: service::MoveItem) -> Cmd<service::MoveOutcome> {
    // 계정은 화면이 보낸 값이 아니라 지금 로그인 상태에서만 가져온다.
    let account = state.auth.session_context().map(|s| s.account_key);
    write(&state, |c| service::move_item_linking(c, input, account.as_deref()))
}

#[tauri::command]
pub async fn items_reorder(state: State<'_, AppState>, location: Location, section: String, ids: Vec<String>) -> Cmd<Vec<MemoItem>> {
    write(&state, |c| service::reorder(c, &location, &section, &ids))
}

#[tauri::command]
pub async fn list_create(state: State<'_, AppState>, id: Option<String>, name: String) -> Cmd<NextListInfo> {
    write(&state, |c| service::create_list(c, id, &name))
}

#[tauri::command]
pub async fn list_rename(state: State<'_, AppState>, id: String, name: String) -> Cmd<NextListInfo> {
    write(&state, |c| service::rename_list(c, &id, &name))
}

#[tauri::command]
pub async fn list_delete(state: State<'_, AppState>, id: String) -> Cmd<service::DeleteListResult> {
    write(&state, |c| service::delete_list(c, &id))
}

#[tauri::command]
pub async fn lists_reorder(state: State<'_, AppState>, ids: Vec<String>) -> Cmd<Vec<NextListInfo>> {
    write(&state, |c| service::reorder_lists(c, &ids))
}

// ── History ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn history_list(state: State<'_, AppState>, location: Location) -> Cmd<Vec<history::VersionSummary>> {
    state.storage()?.with_conn(|c| history::list_for_location(c, &location))
}

#[tauri::command]
pub async fn history_get(state: State<'_, AppState>, version_id: i64) -> Cmd<history::VersionDetail> {
    state.storage()?.with_conn(|c| history::get(c, version_id))
}

#[tauri::command]
pub async fn history_restore(state: State<'_, AppState>, version_id: i64) -> Cmd<Location> {
    write(&state, |c| history::restore(c, version_id))
}

// ── 첨부 ────────────────────────────────────────────────────────────────

/// 붙여넣기·끌어 놓기 — 이미지 바이트를 raw body 로 받는다(JSON 배열 변환 없이).
#[tauri::command]
pub async fn attachment_import(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Cmd<AttachmentInfo> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::validation("이미지 데이터가 없습니다."));
    };
    let item_id = request.headers().get("x-item-id").and_then(|v| v.to_str().ok()).filter(|v| crate::util::is_uuid(v)).map(str::to_string);
    let storage = state.storage()?;
    storage.with_conn(|c| attachments::import_bytes(c, &storage.paths, bytes, None, item_id.as_deref()))
}

/// 파일 선택 — 사용자가 대화상자에서 고른 파일을 저장 폴더로 복사한다.
#[tauri::command]
pub async fn attachment_import_file(state: State<'_, AppState>, path: String, item_id: Option<String>) -> Cmd<AttachmentInfo> {
    let source = PathBuf::from(&path);
    let meta = std::fs::metadata(&source).map_err(|_| AppError::not_found("파일"))?;
    if !meta.is_file() || meta.len() as usize > attachments::MAX_IMAGE_BYTES {
        return Err(AppError::validation("이미지 파일이 아니거나 너무 큽니다(25MB 제한)."));
    }
    let bytes = std::fs::read(&source)?;
    let name = source.file_name().map(|n| n.to_string_lossy().to_string());
    let storage = state.storage()?;
    storage.with_conn(|c| attachments::import_bytes(c, &storage.paths, &bytes, name.as_deref(), item_id.as_deref()))
}

/// 붙여넣은 외부 이미지 주소 — 이 PC 가 내려받아 첨부로 저장한다(외부 주소를 본문에 남기지 않는다).
#[tauri::command]
pub async fn attachment_import_url(state: State<'_, AppState>, url: String) -> Cmd<AttachmentInfo> {
    let parsed = url::Url::parse(&url).map_err(|_| AppError::validation("이미지 주소가 올바르지 않습니다."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::validation("http(s) 이미지 주소만 가져올 수 있습니다."));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| AppError::new("network", "네트워크를 준비하지 못했습니다."))?;
    let response = client.get(parsed).send().await.map_err(|_| AppError::new("network", "이미지를 내려받지 못했습니다."))?;
    if !response.status().is_success() {
        return Err(AppError::new("network", format!("이미지를 내려받지 못했습니다({}).", response.status().as_u16())));
    }
    if response.content_length().unwrap_or(0) as usize > attachments::MAX_IMAGE_BYTES {
        return Err(AppError::validation("이미지가 너무 큽니다(25MB 제한)."));
    }
    let bytes = response.bytes().await.map_err(|_| AppError::new("network", "이미지를 내려받지 못했습니다."))?;
    let storage = state.storage()?;
    storage.with_conn(|c| attachments::import_bytes(c, &storage.paths, &bytes, None, None))
}

/// 쓰지 않는 이미지 정리 — 먼저 dry_run 으로 개수·용량을 보여 주고, 사용자가 확인하면 지운다.
#[tauri::command]
pub async fn attachments_cleanup(state: State<'_, AppState>, dry_run: bool) -> Cmd<attachments::CleanupReport> {
    let storage = state.storage()?;
    tauri::async_runtime::spawn_blocking(move || {
        storage.with_conn(|c| {
            let tx = c.transaction()?;
            let report = attachments::cleanup_unreferenced(&tx, &storage.paths, dry_run)?;
            tx.commit()?;
            Ok(report)
        })
    })
    .await
    .map_err(|_| AppError::new("internal", "작업이 중단되었습니다."))?
}

// ── 내보내기 ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn export_default_path(state: State<'_, AppState>, format: String) -> Cmd<String> {
    let storage = state.storage()?;
    let ext = match format.as_str() {
        "txt" | "csv" | "zip" => format.as_str(),
        _ => return Err(AppError::validation("형식은 txt, csv, zip 중 하나입니다.")),
    };
    let name = format!("내메모_{}{}.{ext}", if ext == "zip" { "백업_" } else { "" }, chrono::Local::now().format("%Y%m%d-%H%M"));
    Ok(storage.paths.exports_dir().join(name).display().to_string())
}

#[tauri::command]
pub async fn export_memos(state: State<'_, AppState>, options: export::ExportOptions, path: String) -> Cmd<export::ExportResult> {
    let storage = state.storage()?;
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(AppError::validation("저장할 위치가 올바르지 않습니다."));
    }
    tauri::async_runtime::spawn_blocking(move || storage.with_conn(|c| export::export(c, &storage.paths, &options, &target)))
        .await
        .map_err(|_| AppError::new("internal", "작업이 중단되었습니다."))?
}

// ── Sync ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_overview(state: State<'_, AppState>) -> Cmd<SyncOverview> {
    let auth = state.auth.status();
    let account = auth.session.as_ref().map(|s| s.account_key.clone());
    let counts = state.storage()?.with_conn(|c| sync::counts(c, account.as_deref()))?;
    Ok(SyncOverview {
        transport: state.sync.engine.transport.name(),
        is_mock: state.mock.is_some(),
        env: state.env.env,
        server_origin: state.env.server_origin.clone(),
        auth,
        linked_documents: counts.linked,
        pending: counts.pending,
        conflicts: counts.conflicts,
        errors: counts.errors,
        auth_required: counts.auth_required,
        outbox: counts.outbox,
        other_account: counts.other_account,
        last_report: state.sync.last_report(),
        mock_online: state.mock.as_ref().map(|m| m.is_online()),
    })
}

/// [PLAN-A Work 와 연결] — DAY 하루 전체 또는 Next List 전체(사용자가 고른 문서 하나). 로그인이 먼저다.
#[tauri::command]
pub async fn sync_link(state: State<'_, AppState>, location: Location) -> Cmd<crate::memo::DocumentInfo> {
    let Some(session) = state.auth.session_context() else {
        return Err(AppError::new("auth_required", "PLAN-A Work 계정 연결이 필요합니다."));
    };
    let doc = state.storage()?.with_conn(|c| {
        let tx = c.transaction()?;
        let doc = repo::ensure_doc(&tx, &location)?;
        link::enable_link(&tx, &doc.id, &session.account_key)?;
        let doc = repo::doc_by_id(&tx, &doc.id)?.ok_or_else(|| AppError::not_found("문서"))?;
        tx.commit()?;
        Ok(doc)
    })?;
    state.sync.poke();
    Ok(doc)
}

#[tauri::command]
pub async fn sync_unlink(state: State<'_, AppState>, location: Location) -> Cmd<crate::memo::DocumentInfo> {
    let doc = state.storage()?.with_conn(|c| {
        let tx = c.transaction()?;
        let doc = repo::doc_for_location(&tx, &location)?.ok_or_else(|| AppError::not_found("문서"))?;
        let doc = link::disable_link(&tx, &doc.id)?;
        tx.commit()?;
        Ok(doc)
    })?;
    state.sync.poke();
    Ok(doc)
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>, app: AppHandle) -> Cmd<engine::SyncReport> {
    let storage = state.storage()?;
    let report = state.sync.run(&storage, true).await?;
    let _ = app.emit("sync://updated", &report);
    Ok(report)
}

#[tauri::command]
pub async fn conflicts_list(state: State<'_, AppState>) -> Cmd<Vec<engine::ConflictView>> {
    state.storage()?.with_conn(|c| engine::list_conflicts(c))
}

/// 비교 화면의 선택 — 서버 Resolve 가 성공한 뒤에만 로컬을 확정한다(오프라인이면 두 내용 모두 그대로).
#[tauri::command]
pub async fn conflict_resolve(state: State<'_, AppState>, app: AppHandle, id: String, choice: engine::ConflictChoice) -> Cmd<Location> {
    let storage = state.storage()?;
    let result = state.sync.resolve(&storage, &id, choice).await;
    let _ = app.emit("sync://updated", &state.sync.last_report().unwrap_or_default());
    result
}

// ── Auth(브라우저 + PKCE + 127.0.0.1 loopback) ─────────────────────────────

#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> Cmd<AuthStatus> {
    Ok(state.auth.status())
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 로그인 시작 — listener 를 먼저 열고(브라우저보다 먼저) 서버에 start → 기본 브라우저를 연다.
/// callback 이 오면 이 PC 가 code 를 교환하고 `auth://changed` 를 보낸다. 앱 창은 앞으로 가져온다.
/// `reconnect` 면 저장된 서버 기기 id 로 같은 기기를 다시 연결(연결·cursor 유지).
#[tauri::command]
pub async fn auth_login_begin(state: State<'_, AppState>, app: AppHandle, reconnect: Option<bool>) -> Cmd<LoginStart> {
    let listener = LoopbackListener::bind().await?;
    let start = state.auth.begin_login(&listener.redirect_uri(), reconnect.unwrap_or(false)).await?;
    let auth = state.auth.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = match listener.wait(loopback::LOGIN_TIMEOUT).await {
            Err(error) => {
                auth.cancel_login();
                Err(error)
            }
            Ok((Err(error), responder)) => {
                auth.cancel_login();
                responder.finish(false, &error.to_string()).await;
                Err(error)
            }
            Ok((Ok(params), responder)) => {
                let result = auth.complete_login(params).await;
                match &result {
                    Ok(_) => responder.finish(true, "PLAN-A Memo 와 PLAN-A Work 계정을 연결했습니다.").await,
                    Err(error) => responder.finish(false, &error.to_string()).await,
                }
                result.map(|_| ())
            }
        };
        focus_main(&handle);
        let state = handle.state::<AppState>();
        match outcome {
            Ok(()) => {
                let _ = handle.emit("auth://changed", &state.auth.status());
                state.sync.poke();
            }
            Err(error) => {
                log::info!("login not completed: {}", error.code());
                let _ = handle.emit("auth://error", &error);
                let _ = handle.emit("auth://changed", &state.auth.status());
            }
        }
    });
    match (&start.authorize_url, &state.mock) {
        (Some(url), _) => {
            app.opener().open_url(url, None::<&str>).map_err(|_| AppError::new("open_failed", "브라우저를 열지 못했습니다."))?;
        }
        // 개발용 Mock 서버 — 브라우저 대신 'Web 동의' 를 흉내 내고 실제 loopback callback 으로 돌아온다.
        (None, Some(mock)) => {
            let callback = mock.approve_login(&start.authorization_id, mock_account()).map_err(|e| {
                // 실제 서버라면 브라우저 동의 화면이 보여 줄 오류 — 개발용 Mock 은 여기서 알린다.
                state.auth.cancel_login();
                if e.is_conflict("device_revoked") {
                    AppError::new("device_revoked", crate::auth::DEVICE_REVOKED_MESSAGE)
                } else {
                    AppError::new("auth_failed", e.to_string())
                }
            })?;
            tauri::async_runtime::spawn(async move {
                if reqwest::get(callback).await.is_err() {
                    log::warn!("mock consent callback could not reach the local listener");
                }
            });
        }
        (None, None) => return Err(AppError::new("auth_failed", "로그인 주소가 없습니다.")),
    }
    Ok(start)
}

#[tauri::command]
pub async fn auth_login_cancel(state: State<'_, AppState>, app: AppHandle) -> Cmd<AuthStatus> {
    state.auth.cancel_login();
    let status = state.auth.status();
    let _ = app.emit("auth://changed", &status);
    Ok(status)
}

/// 로그아웃 — 서버에서 이 기기 credential 폐기(→ 서버의 이 기기 연결이 모두 끝난다). 이 PC 의 메모는 그대로이고,
/// 이 계정으로 연결돼 있던 날짜/List 는 '이 PC 에만' 으로 바뀐다.
#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>, app: AppHandle) -> Cmd<LogoutResult> {
    let result = state.auth.logout().await?;
    if let (Some(account), Ok(storage)) = (&result.account_key, state.storage()) {
        storage.with_conn(|c| engine::end_account_links(c, account))?;
    }
    let _ = app.emit("auth://changed", &state.auth.status());
    state.sync.poke();
    Ok(result)
}

// ── 개발용 Mock 서버 도구(개발 빌드 + 서버 주소 없음일 때만, 실제 서버 아님) ─────────────────

fn mock(state: &State<'_, AppState>) -> Cmd<std::sync::Arc<crate::sync::mock::MockSyncTransport>> {
    state.mock.clone().ok_or_else(|| AppError::new("not_mock", "Mock 서버를 쓰고 있지 않습니다."))
}

static MOCK_ACCOUNT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(crate::sync::mock::MOCK_USER);

fn mock_account() -> i64 {
    MOCK_ACCOUNT.load(std::sync::atomic::Ordering::SeqCst)
}

fn mock_unit(state: &State<'_, AppState>, location: &Location) -> Cmd<crate::sync::mock::Unit> {
    let doc = state.storage()?.with_conn(|c| repo::doc_for_location(c, location))?.ok_or_else(|| AppError::not_found("문서"))?;
    let (unit_type, key) = crate::sync::mapper::unit_of(&doc);
    Ok(crate::sync::mock::Unit { unit_type, key })
}

#[tauri::command]
pub async fn mock_set_online(state: State<'_, AppState>, online: bool) -> Cmd<()> {
    mock(&state)?.set_online(online);
    state.sync.poke();
    Ok(())
}

/// 'Web 에서' 그 날짜/List 에 메모를 추가한 것처럼.
#[tauri::command]
pub async fn mock_remote_edit(state: State<'_, AppState>, location: Location, text: String) -> Cmd<i64> {
    let unit = mock_unit(&state, &location)?;
    let html = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let id = mock(&state)?.web_create(mock_account(), &unit, "main", &html);
    state.sync.poke();
    Ok(id)
}

/// 'Web 에서' 그 날짜/List 의 메모를 모두 지운 것처럼.
#[tauri::command]
pub async fn mock_remote_delete(state: State<'_, AppState>, location: Location) -> Cmd<i64> {
    let unit = mock_unit(&state, &location)?;
    let m = mock(&state)?;
    let ids: Vec<i64> = m.unit_items(mock_account(), &unit).into_iter().map(|(id, _)| id).collect();
    for id in &ids {
        m.web_delete(*id);
    }
    state.sync.poke();
    Ok(ids.len() as i64)
}

/// 'Web 에서' 이 날짜/List 의 연결 해제.
#[tauri::command]
pub async fn mock_remote_unlink(state: State<'_, AppState>, location: Location) -> Cmd<()> {
    let storage = state.storage()?;
    let doc = storage.with_conn(|c| repo::doc_for_location(c, &location))?.ok_or_else(|| AppError::not_found("문서"))?;
    let link_id = storage
        .with_conn(|c| link::link_row(c, &doc.id))?
        .and_then(|l| l.link_id)
        .ok_or_else(|| AppError::new("not_linked", "아직 서버에 연결되지 않았습니다."))?;
    mock(&state)?.web_unlink(&link_id);
    state.sync.poke();
    Ok(())
}

/// 'Web 기기 관리' 에서 이 PC 해제.
#[tauri::command]
pub async fn mock_revoke_device(state: State<'_, AppState>) -> Cmd<()> {
    let device = state
        .auth
        .session_context()
        .map(|s| s.server_device_id)
        .ok_or_else(|| AppError::new("auth_required", "로그인돼 있지 않습니다."))?;
    mock(&state)?.web_revoke_device(&device);
    state.sync.poke();
    Ok(())
}

#[tauri::command]
pub async fn mock_fail_uploads(state: State<'_, AppState>, count: u32) -> Cmd<()> {
    mock(&state)?.fail_next_uploads(count);
    Ok(())
}

/// 다음 push 는 서버가 저장한 뒤 응답만 잃는다(같은 요청 재전송 확인).
#[tauri::command]
pub async fn mock_drop_push_responses(state: State<'_, AppState>, count: u32) -> Cmd<()> {
    mock(&state)?.drop_next_push_responses(count);
    Ok(())
}

/// 다음 Mock 로그인 계정(1 또는 2) — 계정 바꾸기 보호 확인용.
#[tauri::command]
pub async fn mock_set_account(state: State<'_, AppState>, user_id: i64) -> Cmd<()> {
    mock(&state)?;
    if !(1..=2).contains(&user_id) {
        return Err(AppError::validation("Mock 계정은 1 또는 2 입니다."));
    }
    MOCK_ACCOUNT.store(user_id, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}
