//! 날짜별 알림 — 미래 날짜에 '1주 전'·'2일 전' 미리 알림(사용자가 고른 그 날짜에만, 매주 반복 없음).
//!
//! 알림은 **날짜당 하나**다(체크리스트 항목마다 따로 만들지 않는다). 알림 내용(완료하지 않은 체크리스트 수)은 예약할 때가
//! 아니라 **알릴 시각에** 그 날짜 문서에서 센다 — 그 사이 메모를 고치거나 체크하거나 PLAN-A Work 에서 받아도 맞는 숫자가 나오고,
//! 모두 완료했으면 띄우지 않는다.
//!
//! 앱이 완전히 꺼져 있어도 알리기 위해 Windows **작업 스케줄러**에 이 사용자 권한의 작업 하나를 등록한다(os.rs).
//! 작업은 알릴 시각마다 `PLAN-A Memo.exe --plana-reminder …` 를 창 없이 실행하고, 그 프로세스가 이 모듈로 시각이 된 알림을
//! 처리(Windows 알림 표시)한 뒤 다음 시각으로 작업을 다시 맞추고 끝난다. PC 가 꺼져 있어 시각을 놓치면 작업 스케줄러가 켜진 뒤
//! 한 번 실행한다(StartWhenAvailable). 같은 알림을 두 곳(작업 · 실행 중인 앱)이 두 번 띄우지 않게 처리 전에 DB 에서 '선점' 한다.
//!
//! 시각은 모두 사용자 PC 의 로컬 시각('YYYY-MM-DDTHH:MM')이다. 저장할 때 이미 지난 시각은 소급해서 알리지 않는다(expired).
//!
//! PLAN-A Work 와 연결된 DAY(memo-sync-v2 를 지원하는 서버)는 알림 설정·발생(occurrence)·확인이 서버 공통 상태다
//! (`sync::management`). 그 날짜의 `day_reminders` 행은 서버 설정으로 다시 쓰고, 다른 곳에서 확인·취소된 발생은 띄우지 않는다.
//! 다른 계정으로 연결된 날짜의 공통 알림은 지금 계정으로 띄우지 않는다. Local-only 날짜는 지금처럼 이 PC 의 설정만 쓴다.

pub mod os;
pub mod runtime;

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::memo::{repo, Location};
use crate::util::now;

/// 고를 수 있는 미리 알림(일). 7 = 1주 전, 2 = 2일 전.
pub const OFFSETS: [i64; 2] = [7, 2];
pub const DEFAULT_TIME: &str = "09:00";
/// 이 시간보다 늦게 처리하는 알림은 '놓친 알림' 이다(PC 가 꺼져 있었음 등).
pub const LATE_MINUTES: i64 = 15;
/// 작업 스케줄러 작업 하나에 넣는 시각 수(Windows 제한 48 — 넉넉히 아래). 실행될 때마다 다음 시각들로 다시 맞춘다.
pub const MAX_TRIGGERS: usize = 32;
const FIRE_FORMAT: &str = "%Y-%m-%dT%H:%M";
const TASK_STATE_KEY: &str = "reminder_task";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderFire {
    pub offset_days: i64,
    pub fire_at: String,
    /// pending | delivered | skipped | expired | missed
    pub status: String,
    pub handled_at: Option<String>,
    /// 연결된 날짜 — 이 발생을 (어느 기기에서든) 확인했다(서버 공통 상태 또는 이 PC 에서 확인해 보내는 중)
    pub acknowledged: bool,
    /// 연결된 날짜 — 서버 발생 상태(scheduled · published · acknowledged · cancelled · missed)
    pub shared_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayReminder {
    pub date: String,
    pub time: String,
    pub offsets: Vec<i64>,
    pub fires: Vec<ReminderFire>,
}

/// 처리할 차례가 된 알림(날짜당 하나로 묶음).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub date: String,
    pub open_count: i64,
    /// 알릴 시각보다 한참 늦게 처리(놓친 알림)
    pub late: bool,
}

pub fn parse_date(date: &str) -> AppResult<NaiveDate> {
    if !crate::util::is_date(date) {
        return Err(AppError::validation("날짜 형식이 올바르지 않습니다."));
    }
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| AppError::validation("날짜 형식이 올바르지 않습니다."))
}

pub fn parse_time(time: &str) -> AppResult<NaiveTime> {
    if time.len() != 5 {
        return Err(AppError::validation("알림 시각은 HH:MM 형식이어야 합니다."));
    }
    NaiveTime::parse_from_str(time, "%H:%M").map_err(|_| AppError::validation("알림 시각은 HH:MM 형식이어야 합니다."))
}

pub fn fire_at(date: NaiveDate, offset_days: i64, time: NaiveTime) -> NaiveDateTime {
    (date - chrono::Duration::days(offset_days)).and_time(time)
}

pub fn format_fire(at: NaiveDateTime) -> String {
    at.format(FIRE_FORMAT).to_string()
}

fn parse_fire(value: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, FIRE_FORMAT).ok()
}

/// 사용자 PC 의 지금(로컬).
pub fn local_now() -> NaiveDateTime {
    chrono::Local::now().naive_local()
}

pub fn get(conn: &Connection, date: &str) -> AppResult<Option<DayReminder>> {
    parse_date(date)?;
    let rows: Vec<(i64, String, String, String, Option<String>)> = conn
        .prepare(
            "SELECT offset_days, remind_time, fire_at, status, handled_at FROM day_reminders WHERE memo_date = ?1 ORDER BY offset_days DESC",
        )?
        .query_map([date], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<Result<_, _>>()?;
    let Some(first) = rows.first() else { return Ok(None) };
    let shared = crate::sync::management::fire_states(conn, date)?;
    Ok(Some(DayReminder {
        date: date.to_string(),
        time: first.1.clone(),
        offsets: rows.iter().map(|r| r.0).collect(),
        fires: rows
            .into_iter()
            .map(|(offset_days, _, fire_at, status, handled_at)| {
                let state = shared.get(&offset_days);
                ReminderFire {
                    offset_days,
                    fire_at,
                    status,
                    handled_at,
                    acknowledged: state.map(|s| s.1).unwrap_or(false),
                    shared_state: state.map(|s| s.0.clone()),
                }
            })
            .collect(),
    }))
}

pub fn validate_rule(date: &str, offsets: &[i64], time: &str) -> AppResult<(NaiveDate, NaiveTime)> {
    let day = parse_date(date)?;
    let at = parse_time(time)?;
    if offsets.iter().any(|o| !OFFSETS.contains(o)) {
        return Err(AppError::validation("알 수 없는 미리 알림입니다(1주 전 · 2일 전)."));
    }
    Ok((day, at))
}

/// 예약할 알림 하나 — (미리 알림 일, 알릴 로컬 시각, 이미 닫힌 발생인가(다른 곳에서 확인·취소 — 띄우지 않음)).
pub type ScheduleEntry = (i64, NaiveDateTime, bool);

/// 그 날짜의 예약 행을 `entries` 로 바꾼다(호출자의 transaction 안에서). 이미 지난 시각은 'expired'.
/// 같은 시각이 그대로면 이미 띄운·처리한 상태를 유지한다(다시 저장해도 두 번 알리지 않게).
pub fn write_schedule(conn: &Connection, date: &str, time: &str, entries: &[ScheduleEntry], now_local: NaiveDateTime) -> AppResult<()> {
    let previous: Vec<(i64, String, String, Option<String>)> = conn
        .prepare("SELECT offset_days, fire_at, status, handled_at FROM day_reminders WHERE memo_date = ?1")?
        .query_map([date], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    conn.execute("DELETE FROM day_reminders WHERE memo_date = ?1", [date])?;
    let ts = now();
    for offset in OFFSETS {
        let Some((_, when, closed)) = entries.iter().find(|e| e.0 == offset) else { continue };
        let fire = format_fire(*when);
        let kept = previous.iter().find(|p| p.0 == offset && p.1 == fire && p.2 != "pending");
        let (status, handled) = match kept {
            Some((_, _, status, handled)) => (status.clone(), handled.clone()),
            None if *closed => ("skipped".to_string(), Some(ts.clone())),
            None if *when <= now_local => ("expired".to_string(), Some(ts.clone())),
            None => ("pending".to_string(), None),
        };
        conn.execute(
            "INSERT INTO day_reminders (memo_date, offset_days, remind_time, fire_at, status, handled_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![date, offset, time, fire, status, handled, ts],
        )?;
    }
    Ok(())
}

/// 이 PC 의 시각 규칙으로 만든 예약(1주 전·2일 전 · 그 날짜의 `time`).
pub fn local_entries(day: NaiveDate, offsets: &[i64], at: NaiveTime) -> Vec<ScheduleEntry> {
    OFFSETS.iter().filter(|o| offsets.contains(o)).map(|o| (*o, fire_at(day, *o, at), false)).collect()
}

/// 알림 설정을 저장한다(빈 `offsets` = 알림 끄기). 이미 지난 시각은 'expired' 로 저장해 소급해서 알리지 않는다.
/// 같은 시각이 그대로면 이미 띄운·처리한 상태를 유지한다(다시 저장해도 두 번 알리지 않게).
/// (이 PC 에만 있는 날짜용 — 연결된 날짜는 `sync::management::propose_rule`)
pub fn set(conn: &mut Connection, date: &str, offsets: &[i64], time: &str, now_local: NaiveDateTime) -> AppResult<Option<DayReminder>> {
    let (day, at) = validate_rule(date, offsets, time)?;
    let tx = conn.transaction()?;
    write_schedule(&tx, date, time, &local_entries(day, offsets, at), now_local)?;
    tx.commit()?;
    get(conn, date)
}

/// 그 날짜의 완료하지 않은 체크리스트 수.
pub fn open_count(conn: &Connection, date: &str) -> AppResult<i64> {
    let Some(doc) = repo::doc_for_location(conn, &Location::Day { date: date.to_string() })? else { return Ok(0) };
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM memo_items WHERE document_id = ?1 AND deleted_at IS NULL AND kind = 'checklist' AND completed = 0",
        [&doc.id],
        |r| r.get(0),
    )?)
}

/// OS 에 예약할 시각 — 앞으로 올 'pending' 알림 중 그 날짜에 아직 할 일이 남은 것(가까운 순, 중복 없이).
/// 모두 완료한 날짜의 알림은 예약에서 빠진다(다시 미완료가 생기면 다시 들어간다).
pub fn upcoming_triggers(conn: &Connection, now_local: NaiveDateTime) -> AppResult<Vec<NaiveDateTime>> {
    let rows: Vec<(String, i64, String)> = conn
        .prepare("SELECT memo_date, offset_days, fire_at FROM day_reminders WHERE status = 'pending' AND fire_at > ?1 ORDER BY fire_at")?
        .query_map([format_fire(now_local)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut triggers: Vec<NaiveDateTime> = Vec::new();
    for (date, offset, fire) in rows {
        let Some(at) = parse_fire(&fire) else { continue };
        if triggers.contains(&at) || open_count(conn, &date)? == 0 {
            continue;
        }
        // 다른 계정의 공통 알림 · 다른 곳에서 이미 확인·취소된 발생은 예약하지 않는다.
        if crate::sync::management::reminder_suppressed(conn, &date, offset)? {
            continue;
        }
        triggers.push(at);
        if triggers.len() >= MAX_TRIGGERS {
            break;
        }
    }
    Ok(triggers)
}

/// 시각이 된 알림을 처리 차례로 **선점**한다(같은 알림을 작업 스케줄러 실행과 앱이 두 번 띄우지 않게 — 한 transaction).
/// `grace_minutes` 보다 오래 지난 것만 가져간다(앱은 작업 스케줄러가 먼저 처리하도록 몇 분 기다린다).
///  * 대상 날짜가 이미 지났으면 → expired(늦은 알림을 보내지 않는다)
///  * 완료하지 않은 체크리스트가 없으면 → skipped(띄우지 않음)
///  * 그 밖에는 날짜당 하나로 묶어 → delivered(제때) 또는 missed(놓친 알림 — 한 번만)
pub fn claim_due(conn: &mut Connection, now_local: NaiveDateTime, grace_minutes: i64) -> AppResult<Vec<DueReminder>> {
    Ok(claim_due_with_tokens(conn, now_local, grace_minutes)?.into_iter().map(|(due, _)| due).collect())
}

/// `claim_due` + 연결된 날짜의 알림이면 누를 때 쓸 일회용 token(그 알림이 알린 서버 발생 id 와 묶어 DB 에 남긴다).
///  * 다른 계정으로 연결된 날짜의 공통 알림 → 띄우지 않는다(skipped)
///  * 다른 곳(Web·다른 기기)에서 이미 확인·취소·놓침 처리된 발생 → 띄우지 않는다(skipped)
pub fn claim_due_with_tokens(
    conn: &mut Connection,
    now_local: NaiveDateTime,
    grace_minutes: i64,
) -> AppResult<Vec<(DueReminder, Option<String>)>> {
    let cutoff = format_fire(now_local - chrono::Duration::minutes(grace_minutes));
    let today = now_local.date();
    let tx = conn.transaction()?;
    let rows: Vec<(String, i64, String)> = tx
        .prepare("SELECT memo_date, offset_days, fire_at FROM day_reminders WHERE status = 'pending' AND fire_at <= ?1 ORDER BY memo_date, fire_at")?
        .query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let ts = now();
    let mut due: Vec<(DueReminder, Option<String>)> = Vec::new();
    let mut dates: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    dates.dedup();
    for date in dates {
        let mut fires: Vec<&(String, i64, String)> = Vec::new();
        for row in rows.iter().filter(|r| r.0 == date) {
            if crate::sync::management::reminder_suppressed(&tx, &date, row.1)? {
                tx.execute(
                    "UPDATE day_reminders SET status = 'skipped', handled_at = ?3, updated_at = ?3 WHERE memo_date = ?1 AND offset_days = ?2 AND status = 'pending'",
                    params![date, row.1, ts],
                )?;
            } else {
                fires.push(row);
            }
        }
        if fires.is_empty() {
            continue;
        }
        let latest = fires.iter().filter_map(|r| parse_fire(&r.2)).max().unwrap_or(now_local);
        let late = (now_local - latest).num_minutes() > LATE_MINUTES;
        let passed = parse_date(&date).map(|d| d < today).unwrap_or(true);
        let count = if passed { 0 } else { open_count(&tx, &date)? };
        let status = if passed {
            "expired"
        } else if count == 0 {
            "skipped"
        } else if late {
            "missed"
        } else {
            "delivered"
        };
        for (_, offset, _) in &fires {
            tx.execute(
                "UPDATE day_reminders SET status = ?3, handled_at = ?4, updated_at = ?4 WHERE memo_date = ?1 AND offset_days = ?2 AND status = 'pending'",
                params![date, offset, status, ts],
            )?;
        }
        if matches!(status, "delivered" | "missed") {
            let offsets: Vec<i64> = fires.iter().map(|f| f.1).collect();
            let token = crate::sync::management::issue_toast_token(&tx, &date, &offsets)?;
            due.push((DueReminder { date, open_count: count, late }, token));
        }
    }
    tx.commit()?;
    Ok(due)
}

// ── OS 예약 상태(settings 'reminder_task') ───────────────────────────────

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    /// 작업 스케줄러 작업 이름(OS 알림 식별자)
    pub name: String,
    /// 마지막으로 등록한 시각들(로컬 'YYYY-MM-DDTHH:MM')
    pub triggers: Vec<String>,
    pub registered_at: Option<String>,
    pub error: Option<String>,
}

pub fn task_state(conn: &Connection) -> AppResult<Option<TaskState>> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = ?1", [TASK_STATE_KEY], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|v| serde_json::from_str(&v).ok()))
}

pub fn save_task_state(conn: &Connection, state: &TaskState) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![TASK_STATE_KEY, serde_json::to_string(state)?, now()],
    )?;
    Ok(())
}

/// OS 예약을 지금 DB 와 맞춘다 — 바뀐 것이 없으면 아무것도 하지 않는다(`force` 면 다시 등록).
/// 예약할 시각이 없으면 작업을 지운다.
pub fn reconcile(conn: &Connection, task: &os::TaskSpec, now_local: NaiveDateTime, force: bool) -> AppResult<TaskState> {
    let triggers = upcoming_triggers(conn, now_local)?;
    let wanted: Vec<String> = triggers.iter().map(|t| format_fire(*t)).collect();
    let previous = task_state(conn)?;
    if !force {
        if let Some(prev) = &previous {
            if prev.name == task.name && prev.triggers == wanted && prev.error.is_none() {
                return Ok(prev.clone());
            }
        }
    }
    // 이름이 바뀌었으면(저장 위치를 다른 앱 환경에서 열었음 등) 예전 작업은 이 저장소 것이 아니므로 지우지 않는다 —
    // 예전 작업은 다음 실행 때 자기 저장소에서 스스로 정리된다.
    let result = if wanted.is_empty() { os::delete_task(&task.name) } else { os::register_task(task, &triggers) };
    let state =
        TaskState { name: task.name.clone(), triggers: wanted, registered_at: Some(now()), error: result.err().map(|e| e.to_string()) };
    if let Some(error) = &state.error {
        log::warn!("reminder task update failed: {error}");
    }
    save_task_state(conn, &state)?;
    Ok(state)
}

// ── 알림 문구 ───────────────────────────────────────────────────────────

const WEEKDAYS_KO: [&str; 7] = ["월", "화", "수", "목", "금", "토", "일"];

pub fn weekday_ko(date: NaiveDate) -> &'static str {
    use chrono::Datelike;
    WEEKDAYS_KO[date.weekday().num_days_from_monday() as usize]
}

/// (제목, 본문) — '토요일에 할 일이 있어요' / '10월 24일 · 완료하지 않은 체크리스트 3개'
pub fn toast_text(due: &DueReminder) -> (String, String) {
    use chrono::Datelike;
    let Ok(day) = parse_date(&due.date) else { return ("PLAN-A Memo".into(), due.date.clone()) };
    let title = format!("{}요일에 할 일이 있어요", weekday_ko(day));
    let prefix = if due.late { "놓친 알림 · " } else { "" };
    let body = format!("{prefix}{}월 {}일 · 완료하지 않은 체크리스트 {}개", day.month(), day.day(), due.open_count);
    (title, body)
}

/// 놓친 알림이 여러 날짜면 하나로 묶는다(한꺼번에 여러 개를 띄우지 않는다).
pub fn summary_text(due: &[DueReminder]) -> (String, String) {
    use chrono::Datelike;
    let first = due.first().and_then(|d| parse_date(&d.date).ok());
    let title = format!("놓친 알림 {}건", due.len());
    let body = match first {
        Some(day) => format!(
            "{}월 {}일({}) 외 {}일 · 완료하지 않은 체크리스트가 있어요",
            day.month(),
            day.day(),
            weekday_ko(day),
            due.len().saturating_sub(1)
        ),
        None => "완료하지 않은 체크리스트가 있어요".into(),
    };
    (title, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fire_times_are_local_days_before_target() {
        let day = NaiveDate::from_ymd_opt(2026, 10, 24).unwrap();
        let nine = parse_time("09:00").unwrap();
        assert_eq!(format_fire(fire_at(day, 7, nine)), "2026-10-17T09:00");
        assert_eq!(format_fire(fire_at(day, 2, nine)), "2026-10-22T09:00");
        // 월·연 경계, 윤년
        assert_eq!(format_fire(fire_at(NaiveDate::from_ymd_opt(2027, 1, 3).unwrap(), 7, nine)), "2026-12-27T09:00");
        assert_eq!(format_fire(fire_at(NaiveDate::from_ymd_opt(2028, 3, 1).unwrap(), 2, nine)), "2028-02-28T09:00");
        assert_eq!(format_fire(fire_at(NaiveDate::from_ymd_opt(2027, 3, 1).unwrap(), 2, nine)), "2027-02-27T09:00");
    }

    #[test]
    fn time_must_be_hh_mm() {
        assert!(parse_time("9:00").is_err());
        assert!(parse_time("24:00").is_err());
        assert!(parse_time("23:59").is_ok());
    }

    #[test]
    fn toast_text_reads_naturally() {
        let (title, body) = toast_text(&DueReminder { date: "2026-10-24".into(), open_count: 3, late: false });
        assert_eq!(title, "토요일에 할 일이 있어요");
        assert_eq!(body, "10월 24일 · 완료하지 않은 체크리스트 3개");
        let (_, late) = toast_text(&DueReminder { date: "2026-10-24".into(), open_count: 1, late: true });
        assert!(late.starts_with("놓친 알림"));
    }
}
