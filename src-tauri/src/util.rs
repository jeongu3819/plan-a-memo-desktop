use chrono::{SecondsFormat, Utc};

/// UTC ISO-8601 (밀리초). DB 의 모든 시각 형식.
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 화면이 만든 id(UUID)만 받는다 — 임의 문자열이 키가 되지 않게.
pub fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}

pub fn is_date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok() && value.len() == 10
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// 파일 이름에 쓸 시각(로컬 시간이 아니라 UTC — 정렬과 중복 방지용).
pub fn file_stamp() -> String {
    Utc::now().format("%Y%m%d-%H%M%S").to_string()
}
