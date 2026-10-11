//! Windows 쪽 알림 — 작업 스케줄러 작업(앱이 꺼져 있어도 시각에 실행) + Windows 알림(Toast).
//!
//! * 작업: 이 사용자 권한(관리자 권한 없음, 로그온한 동안), 시각마다 `<exe> --plana-reminder --storage <저장 위치> …`.
//!   StartWhenAvailable — PC 가 꺼져 있어 시각을 놓치면 켜진 뒤 한 번 실행한다. 같은 작업이 겹쳐 돌지 않는다.
//!   제거 프로그램이 이 작업을 지운다(windows/installer-hooks.nsh).
//! * 알림: 설치 때 시작 메뉴 바로가기에 등록된 AppUserModelID(= 앱 식별자)로 띄운다. 누르면 `<scheme>://open?date=…`
//!   (protocol 활성화) — Windows 가 앱을 실행하거나 실행 중인 앱으로 넘기고, 앱이 그 날짜 상세를 연다.
//!   앱이 꺼져 있어도 알림 클릭이 동작한다(COM 활성화 서버가 필요 없는 방식).
//! * 개발 실행 파일(설치하지 않음)은 AppUserModelID 가 등록되지 않아 Windows 가 알림을 보이지 않을 수 있다.

use std::path::PathBuf;

use chrono::NaiveDateTime;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct TaskSpec {
    /// 작업 스케줄러 작업 이름(이 앱 환경당 하나)
    pub name: String,
    pub exe: PathBuf,
    pub storage_root: PathBuf,
    /// 알림 주인(AppUserModelID) = 앱 식별자
    pub aumid: String,
    /// 알림을 눌렀을 때 쓰는 scheme(plana-memo 등)
    pub scheme: String,
}

impl TaskSpec {
    pub fn arguments(&self) -> Vec<String> {
        vec![
            HEADLESS_FLAG.to_string(),
            "--storage".into(),
            self.storage_root.display().to_string(),
            "--aumid".into(),
            self.aumid.clone(),
            "--scheme".into(),
            self.scheme.clone(),
            "--task".into(),
            self.name.clone(),
        ]
    }
}

/// 작업 스케줄러가 앱을 '알림 처리' 로 실행할 때의 첫 인자(창을 만들지 않는다).
pub const HEADLESS_FLAG: &str = "--plana-reminder";

pub fn task_name(identifier: &str, isolation: Option<&str>) -> String {
    match isolation {
        Some(tag) => format!("PLAN-A Memo Reminders ({identifier}) {tag}"),
        None => format!("PLAN-A Memo Reminders ({identifier})"),
    }
}

fn xml_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Windows 명령줄 인자 하나(CommandLineToArgvW 규칙).
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(ch);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// 작업 정의(Task Scheduler 1.2 XML). 시각은 로컬 시각(시간대 없음) — PC 의 시간대를 따른다.
pub fn task_xml(spec: &TaskSpec, triggers: &[NaiveDateTime]) -> String {
    let triggers_xml: String = triggers
        .iter()
        .map(|t| {
            format!(
                "    <TimeTrigger>\n      <StartBoundary>{}</StartBoundary>\n      <Enabled>true</Enabled>\n    </TimeTrigger>\n",
                t.format("%Y-%m-%dT%H:%M:%S")
            )
        })
        .collect();
    let arguments = spec.arguments().iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ");
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>PLAN-A Memo</Author>
    <Description>PLAN-A Memo 날짜 알림 — 사용자가 설정한 날짜의 미리 알림을 표시합니다(앱이 꺼져 있어도). 앱을 제거하면 함께 지워집니다.</Description>
  </RegistrationInfo>
  <Triggers>
{triggers_xml}  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        command = xml_escape(&quote_arg(&spec.exe.display().to_string())),
        arguments = xml_escape(&arguments),
    )
}

/// 알림 XML(ToastGeneric) — 누르면 그 날짜 상세(protocol 활성화).
pub fn toast_xml(title: &str, body: &str, launch_uri: &str) -> String {
    let uri = xml_escape(launch_uri);
    format!(
        r#"<toast launch="{uri}" activationType="protocol"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text><text placement="attribution">눌러서 메모 확인</text></binding></visual><actions><action content="메모 열기" activationType="protocol" arguments="{uri}"/></actions></toast>"#,
        xml_escape(title),
        xml_escape(body),
    )
}

pub fn open_day_uri(scheme: &str, date: &str) -> String {
    format!("{scheme}://open?date={date}")
}

// ── Windows ─────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager};

    use super::*;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn schtasks(args: &[&str]) -> AppResult<std::process::Output> {
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        Command::new(system.join("System32").join("schtasks.exe"))
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| AppError::new("reminder_os", format!("작업 스케줄러를 실행하지 못했습니다: {e}")))
    }

    fn output_text(out: &std::process::Output) -> String {
        // schtasks 출력은 시스템 코드 페이지(CP949) — 깨져도 기록용으로만 쓴다.
        let mut text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if text.is_empty() {
            text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        text
    }

    pub fn register_task(spec: &TaskSpec, triggers: &[NaiveDateTime]) -> AppResult<()> {
        let xml = task_xml(spec, triggers);
        let file = std::env::temp_dir().join(format!("plana-reminder-{}.xml", crate::util::new_id()));
        // schtasks /XML 은 UTF-16(BOM) 파일을 읽는다.
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&file, bytes)?;
        let path = file.display().to_string();
        let out = schtasks(&["/Create", "/TN", &spec.name, "/XML", &path, "/F"]);
        let _ = std::fs::remove_file(&file);
        let out = out?;
        if out.status.success() {
            Ok(())
        } else {
            Err(AppError::new("reminder_os", format!("Windows 작업 스케줄러에 알림을 등록하지 못했습니다({}).", output_text(&out))))
        }
    }

    pub fn delete_task(name: &str) -> AppResult<()> {
        if !task_exists(name) {
            return Ok(());
        }
        let out = schtasks(&["/Delete", "/TN", name, "/F"])?;
        if out.status.success() || !task_exists(name) {
            Ok(())
        } else {
            Err(AppError::new("reminder_os", format!("예약 알림을 지우지 못했습니다({}).", output_text(&out))))
        }
    }

    pub fn task_exists(name: &str) -> bool {
        schtasks(&["/Query", "/TN", name]).map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn show_toast(aumid: &str, title: &str, body: &str, launch_uri: &str, tag: &str) -> AppResult<()> {
        let fail =
            |e: windows::core::Error| AppError::new("reminder_toast", format!("Windows 알림을 표시하지 못했습니다({})", e.message()));
        let doc = XmlDocument::new().map_err(fail)?;
        doc.LoadXml(&HSTRING::from(toast_xml(title, body, launch_uri))).map_err(fail)?;
        let toast = ToastNotification::CreateToastNotification(&doc).map_err(fail)?;
        let _ = toast.SetTag(&HSTRING::from(tag));
        let _ = toast.SetGroup(&HSTRING::from("plana-reminder"));
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid)).map_err(fail)?;
        notifier.Show(&toast).map_err(fail)
    }

    fn hkcu_u32(path: &str, name: &str) -> Option<u32> {
        windows_registry::CURRENT_USER.open(path).ok()?.get_u32(name).ok()
    }

    /// Windows 알림을 보일 수 있는가.
    /// 사용자가 끈 스위치(정책 · 전체 알림 · 이 앱 알림 — Windows 설정이 쓰는 레지스트리 값)를 먼저 본다 —
    /// `ToastNotifier.Setting` 은 이 값을 곧바로 반영하지 않을 때가 있고, 패키지가 아닌(설치 프로그램) 앱은 알림을 한 번
    /// 띄우기 전까지 'Element not found'(0x80070490)로 실패한다.
    pub fn notification_setting(aumid: &str, installed: bool) -> &'static str {
        if hkcu_u32(r"Software\Policies\Microsoft\Windows\CurrentVersion\PushNotifications", "NoToastApplicationNotification") == Some(1) {
            return "disabled_policy";
        }
        if hkcu_u32(r"Software\Microsoft\Windows\CurrentVersion\PushNotifications", "ToastEnabled") == Some(0) {
            return "disabled_user";
        }
        if hkcu_u32(&format!(r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{aumid}"), "Enabled") == Some(0) {
            return "disabled_app";
        }
        if let Ok(notifier) = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid)) {
            match notifier.Setting() {
                Ok(NotificationSetting::Enabled) => return "enabled",
                Ok(NotificationSetting::DisabledForApplication) => return "disabled_app",
                Ok(NotificationSetting::DisabledForUser) => return "disabled_user",
                Ok(NotificationSetting::DisabledByGroupPolicy) => return "disabled_policy",
                Ok(NotificationSetting::DisabledByManifest) => return "disabled_manifest",
                _ => {}
            }
        }
        // 설치하지 않은 개발 실행 파일 — 이 식별자로 등록된 시작 메뉴 바로가기가 없어 Windows 가 알림을 보이지 않을 수 있다.
        if installed {
            "enabled"
        } else {
            "unregistered"
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn register_task(_spec: &TaskSpec, _triggers: &[NaiveDateTime]) -> AppResult<()> {
        Err(AppError::new("reminder_unsupported", "이 운영체제에서는 예약 알림을 지원하지 않습니다."))
    }
    pub fn delete_task(_name: &str) -> AppResult<()> {
        Ok(())
    }
    pub fn task_exists(_name: &str) -> bool {
        false
    }
    pub fn show_toast(_aumid: &str, _title: &str, _body: &str, _launch_uri: &str, _tag: &str) -> AppResult<()> {
        Err(AppError::new("reminder_unsupported", "이 운영체제에서는 알림을 지원하지 않습니다."))
    }
    pub fn notification_setting(_aumid: &str, _installed: bool) -> &'static str {
        "unsupported"
    }
}

pub use imp::{delete_task, notification_setting, register_task, show_toast, task_exists};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_xml_quotes_paths_and_lists_local_triggers() {
        let spec = TaskSpec {
            name: task_name("com.plana.memo", None),
            exe: PathBuf::from(r"C:\Users\송명숙\AppData\Local\PLAN-A Memo\PLAN-A Memo.exe"),
            storage_root: PathBuf::from(r"C:\Users\송명숙\PLAN-A Memo"),
            aumid: "com.plana.memo".into(),
            scheme: "plana-memo".into(),
        };
        let at = chrono::NaiveDate::from_ymd_opt(2026, 10, 17).unwrap().and_hms_opt(9, 0, 0).unwrap();
        let xml = task_xml(&spec, &[at]);
        assert!(xml.contains("<StartBoundary>2026-10-17T09:00:00</StartBoundary>"));
        assert!(xml.contains("<StartWhenAvailable>true</StartWhenAvailable>"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains(r#"<Command>&quot;C:\Users\송명숙\AppData\Local\PLAN-A Memo\PLAN-A Memo.exe&quot;</Command>"#));
        assert!(xml.contains(r#"--plana-reminder --storage &quot;C:\Users\송명숙\PLAN-A Memo&quot; --aumid com.plana.memo"#));
        assert!(xml.contains(r#"--task &quot;PLAN-A Memo Reminders (com.plana.memo)&quot;"#));
    }

    #[test]
    fn quote_arg_follows_windows_rules() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
    }

    #[test]
    fn toast_xml_escapes_text_and_opens_day() {
        let xml = toast_xml("토요일에 할 일이 있어요", "A & <B>", &open_day_uri("plana-memo", "2026-10-24"));
        assert!(xml.contains(r#"launch="plana-memo://open?date=2026-10-24" activationType="protocol""#));
        assert!(xml.contains("A &amp; &lt;B&gt;"));
    }
}
