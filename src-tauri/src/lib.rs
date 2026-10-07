//! PLAN-A Memo — Tauri 앱 진입점.
//!
//! React UI ─ typed commands ─▶ Rust(memo · storage · attachments · sync · auth) ─▶ SQLite + 파일

pub mod attachments;
pub mod auth;
pub mod commands;
pub mod config;
pub mod error;
pub mod memo;
pub mod state;
pub mod storage;
pub mod sync;
pub mod util;

use std::time::Duration;

use tauri::http::{Response, StatusCode};
use tauri::{Emitter, Manager};

use state::AppState;

/// `attachment` 프로토콜 — 화면 주소 http://attachment.localhost/<id> 를 저장 폴더의 파일로.
/// id 로만 찾고(경로를 받지 않는다) 저장 폴더 밖의 파일은 절대 돌려주지 않는다.
fn serve_attachment(app: &tauri::AppHandle, path: &str) -> Response<Vec<u8>> {
    let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    let id = path.trim_start_matches('/').split(['?', '#']).next().unwrap_or_default().to_lowercase();
    if !util::is_uuid(&id) {
        return not_found();
    }
    let Ok(storage) = app.state::<AppState>().storage() else { return not_found() };
    match storage.with_conn(|c| attachments::read_bytes(c, &storage.paths, &id)) {
        Ok((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime)
            .header("Cache-Control", "private, max-age=31536000, immutable")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => not_found(),
    }
}

/// `plana-memo://` — 창을 앞으로 가져오기만 한다. 로그인 callback 은 memo-sync-v1 Contract 대로
/// 127.0.0.1 loopback 으로만 받는다(deep link 로 온 code·서버 주소는 어떤 것도 믿지 않는다).
fn handle_deep_links(app: &tauri::AppHandle, urls: Vec<String>) {
    if urls.iter().any(|url| url.starts_with("plana-memo://")) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// 창 위치·크기를 움직임이 멈춘 뒤 1초에 한 번 저장한다(강제 종료돼도 마지막 위치가 남게).
/// 이동·크기 이벤트마다 쓰지 않는다 — 메모 저장(SQLite)과 무관한 작은 JSON 파일 한 번.
fn watch_window_state(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let Some(window) = app.get_webview_window("main") else { return };
    let generation = std::sync::Arc::new(AtomicU64::new(0));
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
            let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
            let generation = generation.clone();
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                if generation.load(Ordering::SeqCst) == mine {
                    if let Err(error) = handle.save_window_state(StateFlags::all()) {
                        log::warn!("window state save failed: {error}");
                    }
                }
            });
        }
    });
}

fn spawn_sync_scheduler(app: tauri::AppHandle) {
    let notify = app.state::<AppState>().sync.notifier();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        loop {
            {
                let state = app.state::<AppState>();
                if let Ok(storage) = state.storage() {
                    match state.sync.run(&storage, false).await {
                        Ok(report) if report.changed() || report.offline || report.auth_required => {
                            let _ = app.emit("sync://updated", &report);
                        }
                        Ok(_) => {}
                        Err(error) => log::warn!("sync run failed: {}", error.code()),
                    }
                }
            }
            tokio::select! {
                _ = notify.notified() => {
                    // 연달아 들어오는 편집을 한 번에 보낸다.
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                }
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 이미 실행 중이면 새 창을 띄우지 않고 기존 창을 앞으로(deep link 는 기존 프로세스로 전달).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("plan-a-memo".into()) }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_asynchronous_uri_scheme_protocol("attachment", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || responder.respond(serve_attachment(&app, &path)));
        })
        .setup(|app| {
            let env = config::EnvConfig::load();
            // E2E 격리(development 빌드만): 앱 설정을 다른 폴더에 — 사용자의 실제 설정을 건드리지 않는다.
            let config_dir = match (env.env, std::env::var_os("PLANA_CONFIG_DIR")) {
                (config::AppEnv::Development, Some(dir)) => std::path::PathBuf::from(dir),
                _ => app.path().app_config_dir()?,
            };
            let log_dir = app.path().app_log_dir()?;
            log::info!("PLAN-A Memo {} starting (env={:?})", env!("CARGO_PKG_VERSION"), env.env);
            let state = AppState::new(env, config_dir, log_dir);
            state.open_configured();
            app.manage(state);

            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // 개발 실행 파일에도 scheme 을 등록(설치본은 Installer 가 등록한다).
                #[cfg(all(debug_assertions, windows))]
                {
                    let _ = app.deep_link().register_all();
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    handle_deep_links(&handle, event.urls().iter().map(|u| u.to_string()).collect());
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    handle_deep_links(app.handle(), urls.iter().map(|u| u.to_string()).collect());
                }
            }

            spawn_sync_scheduler(app.handle().clone());
            watch_window_state(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::storage_status,
            commands::storage_inspect,
            commands::storage_initialize,
            commands::storage_relocate,
            commands::open_folder,
            commands::backup_now,
            commands::backup_list,
            commands::memo_week,
            commands::memo_day,
            commands::memo_list,
            commands::memo_lists,
            commands::memo_days,
            commands::memo_search,
            commands::memo_favorites,
            commands::item_create,
            commands::item_update_content,
            commands::item_set_completed,
            commands::item_set_kind,
            commands::item_set_favorite,
            commands::item_delete,
            commands::item_restore,
            commands::item_move,
            commands::items_reorder,
            commands::list_create,
            commands::list_rename,
            commands::list_delete,
            commands::lists_reorder,
            commands::history_list,
            commands::history_get,
            commands::history_restore,
            commands::attachment_import,
            commands::attachment_import_file,
            commands::attachment_import_url,
            commands::attachments_cleanup,
            commands::export_default_path,
            commands::export_memos,
            commands::sync_overview,
            commands::sync_link,
            commands::sync_unlink,
            commands::sync_now,
            commands::conflicts_list,
            commands::conflict_resolve,
            commands::auth_status,
            commands::auth_login_begin,
            commands::auth_login_cancel,
            commands::auth_logout,
            commands::mock_set_online,
            commands::mock_remote_edit,
            commands::mock_remote_delete,
            commands::mock_remote_unlink,
            commands::mock_revoke_device,
            commands::mock_fail_uploads,
            commands::mock_drop_push_responses,
            commands::mock_set_account,
        ])
        .run(tauri::generate_context!())
        .expect("PLAN-A Memo 실행 중 오류");
}
