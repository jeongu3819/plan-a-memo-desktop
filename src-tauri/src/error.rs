//! 앱 공통 오류. 화면(React)에는 `{ code, message }` 로만 전달한다 — 경로·본문·토큰을 담지 않는다.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("데이터베이스 오류: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("파일 오류: {0}")]
    Io(#[from] std::io::Error),
    #[error("데이터 형식 오류: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{message}")]
    Coded { code: &'static str, message: String },
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        AppError::Coded { code, message: message.into() }
    }

    pub fn code(&self) -> &'static str {
        match self {
            AppError::Db(_) => "db_error",
            AppError::Io(_) => "io_error",
            AppError::Json(_) => "invalid_data",
            AppError::Coded { code, .. } => code,
        }
    }

    pub fn not_found(what: &str) -> Self {
        Self::new("not_found", format!("{what}을(를) 찾을 수 없습니다."))
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("validation", message)
    }
}

impl From<zip::result::ZipError> for AppError {
    fn from(error: zip::result::ZipError) -> Self {
        AppError::new("export_failed", format!("ZIP 생성 오류: {error}"))
    }
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorBody { code: self.code(), message: self.to_string() }.serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;
