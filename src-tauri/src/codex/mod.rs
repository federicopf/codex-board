mod process;
mod protocol;
mod types;

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};

use process::RunningClient;
use protocol::EventQueue;
use types::{CodexErrorCode, ThreadListResponse, ThreadReadResponse};
pub use types::{CodexErrorDto, CodexEventDto, ThreadDto};

pub struct CodexClient {
    running: Mutex<Option<Arc<RunningClient>>>,
    events: EventQueue,
}

impl CodexClient {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            events: EventQueue::new(),
        }
    }

    async fn ensure_running(&self) -> Result<Arc<RunningClient>, CodexErrorDto> {
        let mut running = self.running.lock().await;
        if let Some(client) = running.as_ref().filter(|client| client.is_alive()) {
            return Ok(client.clone());
        }

        let client = RunningClient::spawn(self.events.clone()).await?;
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
    ) -> Result<ThreadDto, CodexErrorDto> {
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
        let read_result = client
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        let read: ThreadReadResponse =
            serde_json::from_value(read_result.clone()).map_err(|error| {
                CodexErrorDto::new(
                    CodexErrorCode::ProtocolError,
                    "Unexpected thread/read response after rename",
                )
                .with_details(format!("{error}: {read_result}"))
            })?;
        if read.thread.name.as_deref() != Some(new_name.as_str()) {
            return Err(CodexErrorDto::new(
                CodexErrorCode::RequestFailed,
                "Codex did not persist the new thread title",
            )
            .with_details(format!(
                "Expected {:?}, received {:?}",
                new_name, read.thread.name
            )));
        }
        Ok(ThreadDto::from(read.thread))
    }

    pub async fn load_thread(&self, thread_id: String) -> Result<Value, CodexErrorDto> {
        let client = self.ensure_running().await?;
        let result = client
            .request("thread/resume", json!({ "threadId": thread_id }))
            .await?;
        result.get("thread").cloned().ok_or_else(|| {
            CodexErrorDto::new(
                CodexErrorCode::ProtocolError,
                "Unexpected thread/resume response",
            )
            .with_details(result.to_string())
        })
    }

    pub async fn send_message(
        &self,
        thread_id: String,
        text: String,
    ) -> Result<Value, CodexErrorDto> {
        if text.trim().is_empty() {
            return Err(CodexErrorDto::new(
                CodexErrorCode::RequestFailed,
                "Message cannot be empty",
            ));
        }
        let client = self.ensure_running().await?;
        client
            .request("thread/resume", json!({ "threadId": thread_id }))
            .await?;
        client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": text }]
                }),
            )
            .await
    }

    pub async fn interrupt_turn(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> Result<(), CodexErrorDto> {
        let client = self.ensure_running().await?;
        client
            .request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await?;
        Ok(())
    }

    pub async fn drain_events(&self) -> Vec<CodexEventDto> {
        self.events.drain().await
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<CodexEventDto> {
        self.events.subscribe()
    }

    pub async fn emit_local_event(&self, method: &str, params: Value) {
        self.events
            .push(CodexEventDto {
                method: method.to_owned(),
                params,
                request_id: None,
            })
            .await;
    }

    pub async fn respond_to_request(
        &self,
        request_id: Value,
        result: Value,
    ) -> Result<(), CodexErrorDto> {
        self.ensure_running().await?.respond(request_id, result)
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
