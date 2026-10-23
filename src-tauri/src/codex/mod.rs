mod coordinator;
mod process;
mod protocol;
mod types;

use std::sync::Arc;
use std::{fs::File, io::{Read, Seek, SeekFrom}, path::Path};

use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};

pub use coordinator::{QueuedMessage, SendOutcome, TurnCoordinator, TurnSettings};
use process::RunningClient;
use protocol::EventQueue;
use types::{CodexErrorCode, ThreadListResponse, ThreadReadResponse};
pub use types::{CodexErrorDto, CodexEventDto, ThreadDto};

pub struct CodexClient {
    running: Mutex<Option<Arc<RunningClient>>>,
    events: EventQueue,
}


fn turn_input(text: &str, image_urls: Vec<String>) -> Vec<Value> {
    let mut input = Vec::new();
    if !text.trim().is_empty() { input.push(json!({ "type": "text", "text": text })); }
    for url in image_urls { input.push(json!({ "type": "image", "url": url })); }
    input
}

fn collaboration_mode(mode: String, model: Value, reasoning_effort: Value) -> Value {
    json!({ "mode": mode, "settings": { "model": model, "reasoningEffort": reasoning_effort, "developerInstructions": null } })
}

fn fork_params(thread_id: &str, last_turn_id: Option<&str>) -> Value {
    let mut params = json!({ "threadId": thread_id });
    if let Some(last_turn_id) = last_turn_id.filter(|value| !value.trim().is_empty()) {
        params["lastTurnId"] = json!(last_turn_id);
    }
    params
}

fn is_empty_rollout_error(error: &CodexErrorDto) -> bool {
    let message = error.message.to_ascii_lowercase();
    let details = error.details.as_deref().unwrap_or("").to_ascii_lowercase();
    (message.contains("rollout") && message.contains("is empty"))
        || (details.contains("rollout") && details.contains("is empty"))
}

fn windows_cwd_from_wsl(cwd: &str) -> Option<String> {
    let normalized = cwd.replace('\\', "/");
    let mounted = normalized.strip_prefix("/mnt/")?;
    let (drive, path) = mounted.split_once('/').unwrap_or((mounted, ""));
    if drive.len() != 1 || !drive.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let separator = if path.is_empty() { "" } else { "\\" };
    Some(format!(
        "{}:{separator}{}",
        drive.to_ascii_uppercase(),
        path.replace('/', "\\")
    ))
}

fn native_cwd(cwd: &str) -> String {
    #[cfg(windows)]
    if let Some(converted) = windows_cwd_from_wsl(cwd) {
        return converted;
    }
    cwd.to_owned()
}

fn camelize_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(camelize_keys).collect()),
        Value::Object(object) => {
            let mut normalized = serde_json::Map::new();
            for (key, value) in object {
                let mut key_camel = String::with_capacity(key.len());
                let mut uppercase_next = false;
                for character in key.chars() {
                    if character == '_' { uppercase_next = true; }
                    else if uppercase_next { key_camel.extend(character.to_uppercase()); uppercase_next = false; }
                    else { key_camel.push(character); }
                }
                normalized.insert(key_camel, camelize_keys(value));
            }
            Value::Object(normalized)
        }
        _ => value.clone(),
    }
}

fn normalize_rollout_item(value: &Value) -> Option<Value> {
    let mut item = camelize_keys(value);
    let name = item.get("type")?.as_str()?;
    let normalized = match name {
        "UserMessage" => "userMessage",
        "AgentMessage" => "agentMessage",
        "ImageView" => "imageView",
        "ImageGeneration" => "imageGeneration",
        "Plan" => "plan",
        "Reasoning" => "reasoning",
        "CommandExecution" => "commandExecution",
        "FileChange" => "fileChange",
        "McpToolCall" => "mcpToolCall",
        "DynamicToolCall" => "dynamicToolCall",
        "WebSearch" => "webSearch",
        other => other,
    };
    if !matches!(normalized, "userMessage" | "agentMessage" | "imageView" | "imageGeneration" | "plan" | "reasoning" | "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "webSearch") { return None; }
    item["type"] = json!(normalized);
    Some(item)
}

fn previous_jsonl_line(file: &mut File, cursor: &mut u64) -> std::io::Result<Option<(u64, Vec<u8>)>> {
    if *cursor == 0 { return Ok(None); }
    let mut end = *cursor;
    let mut segments = Vec::<Vec<u8>>::new();
    loop {
        let start = end.saturating_sub(8192);
        let mut block = vec![0; (end - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut block)?;
        if let Some(separator) = block.iter().rposition(|byte| *byte == b'\n') {
            if separator + 1 < block.len() { segments.push(block[separator + 1..].to_vec()); }
            let mut line = Vec::new();
            for segment in segments.iter().rev() { line.extend_from_slice(segment); }
            *cursor = start + separator as u64;
            return Ok(Some((start + separator as u64 + 1, line)));
        }
        if !block.is_empty() { segments.push(block); }
        if start == 0 {
            let mut line = Vec::new();
            for segment in segments.iter().rev() { line.extend_from_slice(segment); }
            *cursor = 0;
            return Ok(Some((0, line)));
        }
        end = start;
    }
}

fn read_rollout_page(path: &Path, before: Option<usize>, limit: usize) -> std::io::Result<(Vec<Value>, usize, usize, Option<String>)> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let need_active_turn = before.is_none();
    let mut cursor = (before.unwrap_or(file_len as usize) as u64).min(file_len);
    let mut messages = Vec::with_capacity(limit.clamp(1, 20));
    let mut active_turn: Option<Option<String>> = None;
    while let Some((offset, line)) = previous_jsonl_line(&mut file, &mut cursor)? {
        if line.is_empty() { continue; }
        let Ok(row) = serde_json::from_slice::<Value>(&line) else { continue; };
        let payload = &row["payload"];
        let event_type = payload["type"].as_str().unwrap_or_default();
        if need_active_turn && active_turn.is_none() {
            match event_type {
                "task_started" | "turn_started" => active_turn = Some(payload["turn_id"].as_str().map(str::to_owned)),
                "task_complete" | "turn_completed" => active_turn = Some(None),
                _ => {}
            }
        }
        if row["type"].as_str() == Some("event_msg") && event_type == "item_completed" {
            if let Some(item) = normalize_rollout_item(&payload["item"]) {
                messages.push(json!({ "index": offset, "turnId": payload["turn_id"], "item": item }));
            }
        }
        if messages.len() >= limit.clamp(1, 20) && (!need_active_turn || active_turn.is_some()) { break; }
        if cursor == 0 { break; }
    }
    messages.reverse();
    let start = messages.first().and_then(|item| item["index"].as_u64()).unwrap_or(0) as usize;
    let active_turn = active_turn.flatten();
    Ok((messages, start, file_len as usize, active_turn))
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
            let mut attempt = 0_u32;
            let result = loop {
                let request = client
                    .request(
                        "thread/list",
                        json!({
                            "cursor": cursor.clone(),
                            "limit": 100,
                            "sortKey": "recency_at",
                            "sortDirection": "desc",
                            "sourceKinds": ["cli", "vscode", "appServer"],
                            "archived": false
                        }),
                    )
                    .await;
                match request {
                    Ok(result) => break result,
                    Err(error) if attempt < 8 && is_empty_rollout_error(&error) => {
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(
                            150 * u64::from(attempt),
                        ))
                        .await;
                    }
                    Err(error) => return Err(error),
                }
            };
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

    pub async fn rate_limits(&self) -> Result<Value, CodexErrorDto> {
        let client = self.ensure_running().await?;
        client.request("account/rateLimits/read", json!({})).await
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

    pub async fn archive_thread(&self, thread_id: String) -> Result<(), CodexErrorDto> {
        if thread_id.trim().is_empty() {
            return Err(CodexErrorDto::new(
                CodexErrorCode::RequestFailed,
                "Thread id is required",
            ));
        }
        let client = self.ensure_running().await?;
        let result = client
            .request("thread/archive", json!({ "threadId": thread_id }))
            .await?;
        if result != json!({}) && result != Value::Null {
            return Err(CodexErrorDto::new(
                CodexErrorCode::ProtocolError,
                "Unexpected thread/archive response",
            )
            .with_details(result.to_string()));
        }
        Ok(())
    }
    pub async fn create_thread(
        &self,
        cwd: String,
        name: String,
        prompt: String,
        image_urls: Vec<String>,
    ) -> Result<ThreadDto, CodexErrorDto> {
        if cwd.trim().is_empty() || name.trim().is_empty() || prompt.trim().is_empty() {
            return Err(CodexErrorDto::new(
                CodexErrorCode::RequestFailed,
                "Project, title and first message are required",
            ));
        }
        let client = self.ensure_running().await?;
        let cwd = native_cwd(&cwd);
        let result = client
            .request("thread/start", json!({ "cwd": cwd }))
            .await?;
        let thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                CodexErrorDto::new(
                    CodexErrorCode::ProtocolError,
                    "Unexpected thread/start response",
                )
                .with_details(result.to_string())
            })?;
        client
            .request(
                "thread/name/set",
                json!({ "threadId": thread_id, "name": name }),
            )
            .await?;
        let input = turn_input(&prompt, image_urls);
        client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": input
                }),
            )
            .await?;
        // Codex can acknowledge `turn/start` before the rollout JSONL has
        // received its first record. Wait for the session metadata to become
        // readable instead of surfacing the transient "rollout is empty" error.
        let mut attempt = 0_u32;
        let read = loop {
            match client
                .request(
                    "thread/read",
                    json!({ "threadId": thread_id, "includeTurns": false }),
                )
                .await
            {
                Ok(read) => break read,
                Err(error) if attempt < 10 && is_empty_rollout_error(&error) => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        200 * u64::from(attempt),
                    ))
                    .await;
                }
                Err(error) => return Err(error),
            }
        };
        let parsed: ThreadReadResponse = serde_json::from_value(read.clone()).map_err(|error| {
            CodexErrorDto::new(
                CodexErrorCode::ProtocolError,
                "Unexpected new thread response",
            )
            .with_details(format!("{error}: {read}"))
        })?;
        Ok(ThreadDto::from(parsed.thread))
    }

    pub async fn fork_thread(
        &self,
        thread_id: String,
        new_name: String,
        last_turn_id: Option<String>,
    ) -> Result<ThreadDto, CodexErrorDto> {
        if thread_id.trim().is_empty() || new_name.trim().is_empty() {
            return Err(CodexErrorDto::new(
                CodexErrorCode::RequestFailed,
                "Source thread and title are required",
            ));
        }
        let client = self.ensure_running().await?;
        let params = fork_params(&thread_id, last_turn_id.as_deref());
        let result = client.request("thread/fork", params).await?;
        let forked_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                CodexErrorDto::new(
                    CodexErrorCode::ProtocolError,
                    "Unexpected thread/fork response",
                )
                .with_details(result.to_string())
            })?;
        self.rename_thread(forked_id, new_name).await
    }

    pub async fn load_thread(&self, thread_id: String) -> Result<Value, CodexErrorDto> {
        let client = self.ensure_running().await?;
        let mut attempt = 0_u32;
        let result = loop {
            match client
                .request(
                    "thread/read",
                    json!({ "threadId": thread_id, "includeTurns": true }),
                )
                .await
            {
                Ok(result) => break result,
                Err(error) if attempt < 8 && is_empty_rollout_error(&error) => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        200 * u64::from(attempt),
                    ))
                    .await;
                }
                Err(error) => return Err(error),
            }
        };
        result.get("thread").cloned().ok_or_else(|| {
            CodexErrorDto::new(
                CodexErrorCode::ProtocolError,
                "Unexpected thread/read response",
            )
            .with_details(result.to_string())
        })
    }

    pub async fn load_thread_message_page(
        &self,
        thread_id: String,
        before: Option<usize>,
        limit: usize,
    ) -> Result<Option<Value>, CodexErrorDto> {
        let client = self.ensure_running().await?;
        let result = client.request("thread/read", json!({ "threadId": thread_id, "includeTurns": false })).await?;
        let Some(mut thread) = result.get("thread").cloned() else {
            return Err(CodexErrorDto::new(CodexErrorCode::ProtocolError, "Unexpected thread/read response")
                .with_details(result.to_string()));
        };
        let Some(path) = thread.get("path").and_then(Value::as_str).map(str::to_owned) else { return Ok(None); };
        let rollout = crate::local_paths::resolve_local_path(&path)
            .map_err(|error| CodexErrorDto::new(CodexErrorCode::RequestFailed, "Could not locate conversation history")
                .with_details(error))?;
        if !rollout.is_file() { return Ok(None); }
        let page = tokio::task::spawn_blocking(move || read_rollout_page(&rollout, before, limit)).await
            .map_err(|error| CodexErrorDto::new(CodexErrorCode::RequestFailed, "Could not read conversation history")
                .with_details(error.to_string()))?
            .map_err(|error| CodexErrorDto::new(CodexErrorCode::RequestFailed, "Could not read conversation history")
                .with_details(error.to_string()))?;
        let (messages, start, total, active_turn) = page;
        thread["turns"] = json!([]);
        thread["messages"] = json!(messages);
        if before.is_none() {
            thread["activeTurn"] = active_turn.map(|id| json!({ "id": id, "status": "inProgress" })).unwrap_or(Value::Null);
        }
        thread["pagination"] = json!({ "unit": "items", "start": start, "total": total, "hasOlder": start > 0 });
        Ok(Some(thread))
    }

    pub async fn list_models(&self) -> Result<Value, CodexErrorDto> {
        let client = self.ensure_running().await?;
        client.request("model/list", json!({ "includeHidden": false })).await
    }

    pub async fn send_message(
        &self,
        thread_id: String,
        text: String,
        image_urls: Vec<String>,
        settings: Option<TurnSettings>,
        output_schema: Option<Value>,
    ) -> Result<Value, CodexErrorDto> {
        if text.trim().is_empty() && image_urls.is_empty() {
            return Err(CodexErrorDto::new(
                CodexErrorCode::RequestFailed,
                "Message cannot be empty",
            ));
        }
        let client = self.ensure_running().await?;
        let thread = client
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        let mut resume_params = json!({ "threadId": thread_id });
        if let Some(cwd) = thread.pointer("/thread/cwd").and_then(Value::as_str) {
            resume_params["cwd"] = json!(native_cwd(cwd));
        }
        if let Err(error) = client
            .request("thread/resume", resume_params)
            .await
        {
            let technical = format!(
                "{} {}",
                error.message,
                error.details.as_deref().unwrap_or_default()
            );
            if technical.to_ascii_lowercase().contains("active writer") {
                return Err(CodexErrorDto::new(
                    CodexErrorCode::RequestFailed,
                    "This thread is currently open in Codex Desktop. Close Codex Desktop, then send again from Codex Board.",
                )
                .with_details(technical));
            }
            return Err(error);
        }
        let input = turn_input(&text, image_urls);
        let mut params = json!({ "threadId": thread_id, "input": input });
        if let Some(settings) = settings {
            if let Some(object) = params.as_object_mut() {
                if let Some(model) = settings.model.filter(|value| !value.trim().is_empty()) { object.insert("model".into(), json!(model)); }
                if let Some(effort) = settings.effort.filter(|value| !value.trim().is_empty()) { object.insert("effort".into(), json!(effort)); }
                if let Some(summary) = settings.summary.filter(|value| !value.trim().is_empty()) { object.insert("summary".into(), json!(summary)); }
                if let Some(service_tier) = settings.service_tier.filter(|value| !value.trim().is_empty()) { object.insert("serviceTier".into(), json!(service_tier)); }
                if let Some(mode) = settings.mode.filter(|value| matches!(value.as_str(), "default" | "plan")) {
                    let model = object.get("model").cloned().unwrap_or_else(|| json!(""));
                    let reasoning_effort = object.get("effort").cloned().unwrap_or(Value::Null);
                    object.insert("collaborationMode".into(), collaboration_mode(mode, model, reasoning_effort));
                }
            }
        }
        if let Some(schema) = output_schema { params["outputSchema"] = schema; }
        client.request("turn/start", params)
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

    pub async fn compact_thread(&self, thread_id: String) -> Result<Value, CodexErrorDto> {
        let client = self.ensure_running().await?;
        client.request("thread/compact/start", json!({ "threadId": thread_id })).await
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
        if let Ok(mut running) = self.running.try_lock()
            && let Some(client) = running.take()
        {
            client.shutdown_now();
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
    #[test]
    fn collaboration_mode_request_uses_codex_v2_turn_shape() {
        assert_eq!(super::collaboration_mode("plan".into(), serde_json::json!("gpt-fixture"), serde_json::json!("high")), serde_json::json!({
            "mode": "plan",
            "settings": { "model": "gpt-fixture", "reasoningEffort": "high", "developerInstructions": null }
        }));
    }

    #[test]
    fn image_inputs_match_codex_v2_schema_for_new_existing_and_queued_turns() {
        let data = "data:image/jpeg;base64,/9j/AA==";
        assert_eq!(super::turn_input("Look", vec![data.into(), "https://example.test/picture.png".into()]),
            serde_json::json!([
                {"type":"text","text":"Look"},
                {"type":"image","url":data},
                {"type":"image","url":"https://example.test/picture.png"}
            ]).as_array().unwrap().to_vec());
        assert_eq!(super::turn_input("", vec![data.into()]), serde_json::json!([{"type":"image","url":data}]).as_array().unwrap().to_vec());
        assert!(super::turn_input("Text", vec![])[0].get("image").is_none());
    }
    use super::*;

    #[test]
    fn parses_paginated_thread_data() {
        let page: ThreadListResponse = serde_json::from_value(json!({
            "data": [{
                "id": "thr_1",
                "name": "To Plan - Test",
                "preview": "Test",
                "cwd": "C:\\work",
                "updatedAt": 42,
                "forkedFromId": "thr_parent"
            }],
            "nextCursor": "next"
        }))
        .unwrap();
        assert_eq!(page.data.len(), 1);
        assert_eq!(page.next_cursor.as_deref(), Some("next"));
        assert_eq!(page.data[0].forked_from_id.as_deref(), Some("thr_parent"));
    }

    #[test]
    fn detects_transient_empty_rollout_errors() {
        let matching = CodexErrorDto::new(
            CodexErrorCode::RequestFailed,
            "failed to read session metadata: rollout at C:\\sessions\\new.jsonl is empty",
        );
        assert!(is_empty_rollout_error(&matching));

        let unrelated = CodexErrorDto::new(CodexErrorCode::RequestFailed, "permission denied");
        assert!(!is_empty_rollout_error(&unrelated));
    }

    #[test]
    fn fork_params_support_full_and_partial_history() {
        assert_eq!(fork_params("thr_1", None), json!({ "threadId": "thr_1" }));
        assert_eq!(
            fork_params("thr_1", Some("turn_3")),
            json!({ "threadId": "thr_1", "lastTurnId": "turn_3" })
        );
        assert_eq!(
            fork_params("thr_1", Some("  ")),
            json!({ "threadId": "thr_1" })
        );
    }


    #[test]
    fn converts_wsl_mount_paths_for_the_windows_runner() {
        assert_eq!(
            windows_cwd_from_wsl("/mnt/c/Users/Asus/Desktop/codex-board"),
            Some("C:\\Users\\Asus\\Desktop\\codex-board".into())
        );
        assert_eq!(windows_cwd_from_wsl("C:\\work\\project"), None);
        assert_eq!(windows_cwd_from_wsl("/home/user/project"), None);
    }

    #[test]
    fn rollout_message_pages_read_newest_items_then_older_items() {
        let path = std::env::temp_dir().join(format!(
            "codex-board-rollout-page-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = concat!(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"t1\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"turn_id\":\"t1\",\"item\":{\"type\":\"UserMessage\",\"id\":\"u1\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"turn_id\":\"t1\",\"item\":{\"type\":\"AgentMessage\",\"id\":\"a1\",\"text\":\"world\"}}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"t1\"}}\n"
        );
        std::fs::write(&path, content).unwrap();

        let (latest, latest_start, total, active) = read_rollout_page(&path, None, 1).unwrap();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0]["item"]["type"], "agentMessage");
        assert_eq!(latest[0]["item"]["id"], "a1");
        assert_eq!(latest[0]["turnId"], "t1");
        assert_eq!(latest_start, latest[0]["index"].as_u64().unwrap() as usize);
        assert_eq!(total, content.len());
        assert_eq!(active, None);

        let (older, _, _, _) = read_rollout_page(&path, Some(latest_start), 1).unwrap();
        assert_eq!(older.len(), 1);
        assert_eq!(older[0]["item"]["type"], "userMessage");
        assert_eq!(older[0]["item"]["content"][0]["text"], "hello");

        std::fs::remove_file(path).unwrap();
    }
}
