//! 빌드 환경 검사 — 환경(PLANA_ENV)·서버 주소·업데이트 채널·앱 식별자가 서로 맞지 않는 Installer 를 만들지 않는다.
//!
//! * `PLANA_ENV` 만 읽는다. 흔한 오타 `PLAN_A_ENV` 를 주면 조용히 production 이 되던 문제를 막으려고 빌드를 멈춘다.
//! * staging 은 `com.plana.memo.staging`(따로 설치·공존), production 은 `com.plana.memo`(기존 설치와 같은 앱)여야 한다.
//!   Tauri CLI 는 `--config` 로 덮은 값을 `TAURI_CONFIG` 로 넘긴다.

use std::env;

fn main() {
    for key in ["PLANA_ENV", "PLAN_A_ENV", "PLANA_SERVER_ORIGIN", "PLANA_UPDATE_ENDPOINT", "PLANA_UPDATER_PUBKEY", "TAURI_CONFIG"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let plana_env = env::var("PLANA_ENV").ok().filter(|v| !v.trim().is_empty());
    if plana_env.is_none() && env::var("PLAN_A_ENV").is_ok_and(|v| !v.trim().is_empty()) {
        panic!(
            "\n\nPLAN_A_ENV 는 읽지 않습니다 — 환경 변수 이름은 PLANA_ENV 입니다(밑줄 없음).\n\
             이대로 빌드하면 release 빌드는 production 이 됩니다.\n\
             예: npm run dist:staging  또는  $env:PLANA_ENV=\"staging\"; npm run dist\n\n"
        );
    }
    if let Some(value) = &plana_env {
        if !matches!(value.as_str(), "development" | "staging" | "production") {
            panic!("\n\nPLANA_ENV='{value}' 는 알 수 없는 값입니다(development · staging · production).\n\n");
        }
        let identifier = effective_identifier();
        let expected = match value.as_str() {
            "production" => Some("com.plana.memo"),
            "staging" => Some("com.plana.memo.staging"),
            _ => None,
        };
        if let (Some(expected), Some(identifier)) = (expected, identifier.as_deref()) {
            if identifier != expected {
                panic!(
                    "\n\nPLANA_ENV={value} 인데 앱 식별자가 '{identifier}' 입니다(기대: {expected}).\n\
                     staging 은 src-tauri/tauri.staging.conf.json 을 덮어 빌드해야 운영 설치를 덮어쓰지 않습니다.\n\
                     npm run dist:staging / npm run dist:production 을 쓰세요.\n\n"
                );
            }
        }
    }

    tauri_build::build()
}

/// tauri.conf.json 의 identifier — CLI 가 `--config` 로 덮었으면(TAURI_CONFIG) 그 값.
fn effective_identifier() -> Option<String> {
    let overlay = env::var("TAURI_CONFIG")
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("identifier").and_then(|i| i.as_str()).map(str::to_string));
    overlay.or_else(|| {
        let raw = std::fs::read_to_string("tauri.conf.json").ok()?;
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        value.get("identifier")?.as_str().map(str::to_string)
    })
}
