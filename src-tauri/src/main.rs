// Release 빌드에서 콘솔 창을 띄우지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 작업 스케줄러가 날짜 알림 시각에 실행한 경우 — 창 없이 알림만 처리하고 끝낸다(reminders/runtime.rs).
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = plan_a_memo_lib::reminders::runtime::run_headless(&args) {
        std::process::exit(code);
    }
    plan_a_memo_lib::run()
}
