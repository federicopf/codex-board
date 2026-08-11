mod process;
mod protocol;
mod types;

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use process::RunningClient;
use types::{CodexErrorCode, ThreadListResponse};
pub use types::{CodexErrorDto, ThreadDto};

pub struct CodexClient {
    running: Mutex<Option<Arc<RunningClient>>>,
}

impl CodexClient {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
        }
    }

    async fn ensure_running(&self) -> Result<Arc<RunningClient>, CodexErrorDto> {
        let mut running = self.running.lock().await;
        if let Some(client) = running.as_ref().filter(|client| client.is_alive()) {
            return Ok(client.clone());
        }

        let client = RunningClient::spawn().await?;
        if let Err(error) = client.initialize().await {
            client.shutdown_now();
            return Err(error);
        }
        *running = Some(client.clone());
        Ok(client)
    }

    pub async fn list_threads(&self) -> Result<Vec<ThreadDto>, CodexErrorDto> {
        let client = self.ensure_running().await?;
        let mut cursor: Option<String> = None;
        let mut threads = Vec::new();

        loop {
            let result = client
                .request(
                    "thread/list",
                    json!({
                        "cursor": cursor,
                        "limit": 100,
                        "sortKey": "recency_at",
                        "sortDirection": "desc",
                        "sourceKinds": ["cli", "vscode", "appServer"],
                        "archived": false
                    }),
                )
                .await?;
            let page: ThreadListResponse = serde_json::from_value(result).map_err(|error| {
                CodexErrorDto::new(
                    CodexErrorCode::ProtocolError,
                    "Unexpected thread/list response",
                )
                .with_details(error.to_string())
            })?;
            threads.extend(page.data.into_iter().map(ThreadDto::from));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok(threads)
    }

    pub async fn rename_thread(
        &self,
        thread_id: String,
        new_name: String,
    ) -> Result<(), CodexErrorDto> {
        let client = self.ensure_running().await?;
        let result = client
            .request(
                "thread/name/set",
                json!({ "threadId": thread_id, "name": new_name }),
            )
            .await?;
        if result != json!({}) && result != Value::Null {
            return Err(CodexErrorDto::new(
                CodexErrorCode::ProtocolError,
                "Unexpected thread/name/set response",
            )
            .with_details(result.to_string()));
        }
        Ok(())
    }

    pub fn shutdown_best_effort(&self) {
        if let Ok(mut running) = self.running.try_lock() {
            if let Some(client) = running.take() {
                client.shutdown_now();
            }
        }
    }
}

impl Default for CodexClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_paginated_thread_data() {
        let page: ThreadListResponse = serde_json::from_value(json!({
            "data": [{
                "id": "thr_1",
                "name": "To Plan - Test",
                "preview": "Test",
                "cwd": "C:\\work",
                "updatedAt": 42
            }],
            "nextCursor": "next"
        }))
        .unwrap();
        assert_eq!(page.data.len(), 1);
        assert_eq!(page.next_cursor.as_deref(), Some("next"));
    }
}
