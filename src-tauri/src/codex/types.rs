use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CodexErrorCode {
    CliNotFound,
    StartFailed,
    HandshakeFailed,
    ProtocolError,
    RequestFailed,
    ProcessExited,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexErrorDto {
    pub code: CodexErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl CodexErrorDto {
    pub fn new(code: CodexErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDto {
    pub id: String,
    pub name: Option<String>,
    pub preview: Option<String>,
    pub cwd: Option<String>,
    pub updated_at: Option<i64>,
    pub status: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexEventDto {
    pub method: String,
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadListResponse {
    #[serde(default)]
    pub data: Vec<RawThread>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ThreadReadResponse {
    pub thread: RawThread,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawThread {
    pub id: String,
    pub name: Option<String>,
    pub preview: Option<String>,
    pub cwd: Option<String>,
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub status: Option<Value>,
}

impl From<RawThread> for ThreadDto {
    fn from(thread: RawThread) -> Self {
        Self {
            id: thread.id,
            name: thread.name,
            preview: thread.preview,
            cwd: thread.cwd,
            updated_at: thread.updated_at,
            status: thread.status,
        }
    }
}
