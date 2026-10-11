//! 알림을 실제로 처리하는 두 곳.
//!
//! * `run_headless` — 작업 스케줄러가 시각에 실행한 **창 없는** 프로세스(앱이 꺼져 있을 때도). 시각이 된 알림을 선점해 Windows
//!   알림을 띄우고, 작업을 다음 시각으로 다시 맞춘 뒤 끝난다. Tauri 창·WebView 를 만들지 않는다(main.rs 에서 먼저 갈라진다).
//! * `ReminderRuntime` — 실행 중인 앱. 메모가 바뀌면 OS 예약을 맞추고(모두 완료 → 예약에서 빠짐), 작업이 어떤 이유로
//!   실행되지 않았으면(작업 등록 실패 등) 대신 알린다. 앱을 다시 열 때 놓친 알림은 화면 안내로 한 번 보인다.
//!
//! PLAN-A Work 와 연결된 날짜(memo-sync-v2)의 알림은 띄우기 직전에(온라인이면, 짧은 시간 제한 안에서) 보내지 못한 확인을 먼저 보내고
//! 서버의 최신 발생 상태를 받는다 — 다른 곳에서 이미 확인·취소한 알림을 오래된 로컬 예약 때문에 다시 띄우지 않는다.
//! 오프라인·시간 초과·인증 만료면 로컬 상태로 진행한다(기다리다 멈추거나 반복 실행하지 않는다).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use super::os::{self, TaskSpec, HEADLESS_FLAG};
use super::{claim_due_with_tokens, local_now, reconcile, summary_text, toast_text, DueReminder, TaskState};
use crate::error::AppResult;
use crate::sync::management;

/// 앱이 작업 스케줄러보다 늦게 처리하도록 기다리는 시간(분) — 같은 알림은 어차피 한 곳만 선점한다.
pub const APP_GRACE_MINUTES: i64 = 2;
/// 알림 프로세스가 서버 상태 확인에 쓰는 시간 상한(연결 3초 · 요청 6초 · 전체 12초).
const HEADLESS_NETWORK_BUDGET: Duration = Duration::from_secs(12);

/// 시각이 된 알림을 Windows 알림으로 띄운다. 여러 날짜가 한꺼번이면(놓친 알림 등) 하나로 묶는다.
/// 연결된 날짜의 알림은 누를 때 확인(ACK)할 일회용 token 을 주소에 담는다.
pub fn deliver(aumid: &str, scheme: &str, due: &[(DueReminder, Option<String>)]) -> Vec<String> {
    let mut errors = Vec::new();
    if due.is_empty() {
        return errors;
    }
    let plain: Vec<DueReminder> = due.iter().map(|(d, _)| d.clone()).collect();
    let combine = due.len() > 2 || (due.len() > 1 && due.iter().any(|(d, _)| d.late));
    if combine {
        // 묶은 알림은 첫 날짜를 연다 — 그 날짜 알림만 확인으로 본다(사용자가 실제로 여는 날짜).
        let (title, body) = summary_text(&plain);
        let uri = os::open_day_uri_with_ack(scheme, &due[0].0.date, due[0].1.as_deref());
        if let Err(e) = os::show_toast(aumid, &title, &body, &uri, "summary") {
            errors.push(e.to_string());
        }
        return errors;
    }
    for (item, token) in due {
        let (title, body) = toast_text(item);
        let uri = os::open_day_uri_with_ack(scheme, &item.date, token.as_deref());
        if let Err(e) = os::show_toast(aumid, &title, &body, &uri, &item.date) {
            errors.push(e.to_string());
        }
    }
    errors
}

/// 다른 곳에서 확인된 알림을 알림 센터에서 거둔다(지원되는 범위에서 — 이미 떠 있는 배너는 남을 수 있다).
pub fn withdraw(conn: &rusqlite::Connection, aumid: &str) -> AppResult<usize> {
    let mut n = 0;
    for (token, tag) in management::pending_withdrawals(conn)? {
        if let Err(error) = os::remove_toast(aumid, &tag) {
            log::info!("toast withdraw failed: {}", error.code());
        }
        management::mark_withdrawn(conn, &token)?;
        n += 1;
    }
    Ok(n)
}

/// 작업 스케줄러가 실행한 알림 프로세스 — 연결된 날짜의 알림이 시각이 됐으면 서버 상태를 먼저 확인한다(시간 제한 안에서).
fn refresh_shared_before_display(conn: &mut rusqlite::Connection) -> String {
    let now = local_now();
    let dates = match management::due_shared_dates(conn, now) {
        Ok(dates) if !dates.is_empty() => dates,
        Ok(_) => return "shared none".into(),
        Err(error) => return format!("shared check failed ({})", error.code()),
    };
    let env = crate::config::EnvConfig::load();
    let Some(origin) = env.server_origin.clone() else { return "shared local-state (no server)".into() };
    let Ok(http) = crate::sync::http::HttpClient::with_timeouts(&origin, Duration::from_secs(3), Duration::from_secs(6)) else {
        return "shared local-state (http)".into();
    };
    let auth = crate::auth::DesktopAuth::new(
        env.env,
        std::sync::Arc::new(crate::sync::http::PlanAWorkAuthApi::new(http.clone())),
        crate::state::credential_store(env.env.label()),
        false,
    );
    use crate::auth::AuthProvider;
    let Some(session) = auth.session_context() else { return "shared local-state (no credential)".into() };
    // 다른 계정의 credential 로 이 계정의 알림 상태를 바꾸지 않는다.
    if management::active_account(conn).ok().flatten().as_deref() != Some(session.account_key.as_str()) {
        return "shared local-state (account mismatch)".into();
    }
    let ctx = crate::sync::transport::SyncContext {
        access_token: session.access_token,
        account_key: session.account_key,
        server_device_id: session.server_device_id,
    };
    let transport = crate::sync::http::PlanAWorkSyncTransport::new(http);
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
        return "shared local-state (runtime)".into();
    };
    let result = runtime.block_on(async {
        tokio::time::timeout(HEADLESS_NETWORK_BUDGET, management::refresh_before_display(conn, &transport, &ctx, &dates)).await
    });
    match result {
        Ok(Ok(n)) => format!("shared refreshed {n}/{}", dates.len()),
        Ok(Err(error)) => format!("shared local-state ({})", error.code()),
        Err(_) => "shared local-state (timeout)".into(),
    }
}

fn headless_log(aumid: &str, line: &str) {
    let Some(base) = dirs::data_local_dir() else { return };
    let dir = base.join(aumid).join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("reminder.log");
    if std::fs::metadata(&file).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&file);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{} {line}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    }
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// 작업 스케줄러가 실행한 경우면 처리하고 종료 코드를 돌려준다(아니면 None — 평소대로 앱 실행).
pub fn run_headless(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some(HEADLESS_FLAG) {
        return None;
    }
    let (Some(storage), Some(aumid), Some(scheme), Some(task)) =
        (arg_value(args, "--storage"), arg_value(args, "--aumid"), arg_value(args, "--scheme"), arg_value(args, "--task"))
    else {
        return Some(2);
    };
    let spec = TaskSpec {
        name: task,
        exe: std::env::current_exe().unwrap_or_else(|_| PathBuf::from(&args[0])),
        storage_root: PathBuf::from(storage),
        aumid,
        scheme,
    };
    match headless(&spec) {
        Ok(summary) => {
            headless_log(&spec.aumid, &summary);
            Some(0)
        }
        Err(error) => {
            headless_log(&spec.aumid, &format!("failed: {error}"));
            Some(1)
        }
    }
}

fn headless(spec: &TaskSpec) -> AppResult<String> {
    let db = crate::storage::StoragePaths::new(&spec.storage_root).db_path();
    if !db.is_file() {
        // 저장소가 옮겨졌거나 사라졌다 — 이 작업은 더 이상 쓸 곳이 없다(앱을 다시 열면 새 위치로 다시 등록된다).
        let _ = os::delete_task(&spec.name);
        return Ok(format!("storage missing ({}) — task removed", spec.storage_root.display()));
    }
    let mut conn = crate::storage::open_connection(&db)?;
    if crate::storage::migrations::current_version(&conn)? < 3 {
        return Ok("schema not ready".into());
    }
    // 연결된 날짜 알림 — 띄우기 전에 서버 확인 상태를 맞춘다(시간 제한 안에서, 실패하면 로컬 상태로).
    let shared = refresh_shared_before_display(&mut conn);
    let now = local_now();
    let due = claim_due_with_tokens(&mut conn, now, 0)?;
    let errors = deliver(&spec.aumid, &spec.scheme, &due);
    let _ = withdraw(&conn, &spec.aumid);
    let state = reconcile(&conn, spec, now, false)?;
    if !due.is_empty() {
        // 알림 표시가 Windows 에 넘어갈 때까지 잠깐 둔다(곧바로 끝나도 알림은 남지만 안전하게).
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    Ok(format!(
        "delivered {} ({}) · errors {:?} · next {:?} · {shared}",
        due.len(),
        due.iter()
            .map(|(d, t)| format!(
                "{}:{}{}{}",
                d.date,
                d.open_count,
                if d.late { ":late" } else { "" },
                if t.is_some() { ":shared" } else { "" }
            ))
            .collect::<Vec<_>>()
            .join(","),
        errors,
        state.triggers.first()
    ))
}

// ── 실행 중인 앱 ─────────────────────────────────────────────────────────

/// 실행 중인 앱의 알림 상태.
pub struct ReminderRuntime {
    /// 작업 이름 · 실행 파일 · 알림 식별자 · scheme(setup 에서 정한다)
    base: Mutex<Option<TaskSpec>>,
    last_root: Mutex<Option<PathBuf>>,
    /// 앱을 다시 열 때 찾은 놓친 알림(화면이 가져가면 비운다)
    missed: Mutex<Vec<DueReminder>>,
    pub notify: tokio::sync::Notify,
}

impl Default for ReminderRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl ReminderRuntime {
    pub fn new() -> Self {
        ReminderRuntime {
            base: Mutex::new(None),
            last_root: Mutex::new(None),
            missed: Mutex::new(Vec::new()),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub fn configure(&self, name: String, exe: PathBuf, aumid: String, scheme: String) {
        *self.base.lock().unwrap() = Some(TaskSpec { name, exe, storage_root: PathBuf::new(), aumid, scheme });
    }

    pub fn spec_for(&self, root: &Path) -> Option<TaskSpec> {
        self.base.lock().unwrap().clone().map(|base| TaskSpec { storage_root: root.to_path_buf(), ..base })
    }

    /// 메모·알림 설정이 바뀌었다 — 곧 OS 예약을 맞춘다.
    pub fn poke(&self) {
        self.notify.notify_one();
    }

    pub fn take_missed(&self) -> Vec<DueReminder> {
        std::mem::take(&mut *self.missed.lock().unwrap())
    }

    /// 한 번 돌기 — OS 예약 맞추기 + 작업이 놓친 알림 처리. 화면에 알릴 놓친 알림이 새로 생겼으면 true.
    pub fn tick(&self, storage: &crate::storage::Storage) -> AppResult<bool> {
        let root = storage.paths.root.clone();
        let Some(spec) = self.spec_for(&root) else { return Ok(false) };
        let moved = self.last_root.lock().unwrap().as_ref() != Some(&root);
        let first = self.last_root.lock().unwrap().is_none();
        let now = local_now();
        // 매번 DB 와 OS 예약을 비교한다 — 화면 편집·PLAN-A Work 에서 받은 변경·충돌 해결·History 복원 어느 길로 바뀌어도
        // 맞춰진다(바뀐 것이 없으면 OS 를 부르지 않는다). 앱을 처음 열 때·저장 위치가 바뀌었을 때는 다시 등록한다
        // (설치 위치·실행 파일·저장 위치를 새로 반영).
        storage.with_conn(|c| reconcile(c, &spec, now, moved).map(|_| ()))?;
        *self.last_root.lock().unwrap() = Some(root);
        // 다른 곳에서 확인된 알림 거두기(연결된 날짜).
        storage.with_conn(|c| withdraw(c, &spec.aumid).map(|_| ()))?;
        let grace = if first { 0 } else { APP_GRACE_MINUTES };
        let due = storage.with_conn(|c| claim_due_with_tokens(c, now, grace))?;
        if due.is_empty() {
            return Ok(false);
        }
        let (late, on_time): (Vec<_>, Vec<_>) = due.into_iter().partition(|(d, _)| d.late);
        for error in deliver(&spec.aumid, &spec.scheme, &on_time) {
            log::warn!("reminder toast failed: {error}");
        }
        if !on_time.is_empty() {
            // 띄운 알림 뒤의 다음 시각으로 맞춘다.
            storage.with_conn(|c| reconcile(c, &spec, now, false).map(|_| ()))?;
        }
        if late.is_empty() {
            return Ok(false);
        }
        // 놓친 알림은 앱 화면의 한 줄 안내로(누르면 그 날짜 + 확인).
        self.missed.lock().unwrap().extend(late.into_iter().map(|(d, _)| d));
        Ok(true)
    }

    /// 연결된 날짜 알림을 눌렀다(token) — 확인을 Outbox 에 남긴다(같은 알림을 다시 눌러도 한 번만). 처리한 날짜.
    pub fn confirm_tokens(&self, storage: &crate::storage::Storage, tokens: &[String]) -> AppResult<Vec<String>> {
        let mut dates = Vec::new();
        for token in tokens {
            if let Some(date) = storage.with_conn(|c| management::confirm_token(c, token))? {
                dates.push(date);
            }
        }
        Ok(dates)
    }

    pub fn task_state(&self, storage: &crate::storage::Storage) -> AppResult<Option<TaskState>> {
        storage.with_conn(|c| super::task_state(c))
    }

    pub fn notification_setting(&self) -> &'static str {
        match self.base.lock().unwrap().as_ref() {
            // Installer 로 설치한 실행 파일 옆에는 제거 프로그램이 있다(시작 메뉴 바로가기 = 알림 식별자 등록).
            Some(spec) => {
                let installed = spec.exe.parent().map(|dir| dir.join("uninstall.exe").is_file()).unwrap_or(false);
                os::notification_setting(&spec.aumid, installed)
            }
            None => "unknown",
        }
    }

    /// 알림 설정을 저장한 직후 — 바로 OS 예약을 맞추고 결과를 돌려준다.
    pub fn sync_now(&self, storage: &crate::storage::Storage) -> AppResult<Option<TaskState>> {
        let Some(spec) = self.spec_for(&storage.paths.root) else { return Ok(None) };
        let state = storage.with_conn(|c| reconcile(c, &spec, local_now(), false))?;
        Ok(Some(state))
    }
}
