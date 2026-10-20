use crate::{automation_result, codex::CodexClient, persistence};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardNotification {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub thread_id: Option<String>,
    pub created_at: i64,
    pub read: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation: Option<AutomationResultDetails>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResultDetails {
    pub id: String,
    pub name: String,
    pub result: String,
    pub status: String,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone)]
struct PendingAutomation {
    id: String,
    name: String,
    final_text: Option<String>,
}

pub struct NotificationStore {
    items: Mutex<Vec<BoardNotification>>,
    pending_automations: Mutex<HashMap<String, PendingAutomation>>,
    path: PathBuf,
}
impl NotificationStore {
    pub fn new(path: PathBuf, client: Arc<CodexClient>) -> Arc<Self> {
        let items = persistence::load_json_or_default(&path);
        let store = Arc::new(Self {
            items: Mutex::new(items),
            pending_automations: Mutex::new(HashMap::new()),
            path,
        });
        let worker = store.clone();
        let mut events = client.subscribe_events();
        tauri::async_runtime::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let pending = worker.pending_automations.lock().await.drain().collect::<Vec<_>>();
                        for (thread_id, pending) in pending {
                            client.emit_local_event("board/automation/completed", json!({
                                "threadId": thread_id, "automationId": pending.id, "automationName": pending.name,
                                "status": "unknown", "result": "Esito non verificabile: alcuni eventi dell'esecuzione sono andati persi."
                            })).await;
                        }
                        continue;
                    }
                    Err(_) => break,
                };
                let thread_id = event.params.get("threadId").and_then(Value::as_str);
                if event.method == "board/automation/submitting" {
                    if let (Some(thread_id), Some(id), Some(name)) = (
                        thread_id,
                        event.params.get("automationId").and_then(Value::as_str),
                        event.params.get("automationName").and_then(Value::as_str),
                    ) {
                        worker.pending_automations.lock().await.insert(thread_id.to_owned(),
                            PendingAutomation { id: id.into(), name: name.into(), final_text: None });
                    }
                    continue;
                }
                if event.method == "board/automation/submission-cancelled" {
                    if let Some(thread_id) = thread_id { worker.pending_automations.lock().await.remove(thread_id); }
                    continue;
                }
                if event.method == "item/completed" {
                    if let (Some(thread_id), Some(item)) = (thread_id, event.params.get("item")) {
                        if let Some(text) = automation_result::final_message(std::slice::from_ref(item)) {
                            if let Some(pending) = worker.pending_automations.lock().await.get_mut(thread_id) {
                                // Bound malformed streams; parsing refuses oversized/truncated JSON.
                                pending.final_text = Some(text.chars().take(16_000).collect());
                            }
                        }
                    }
                    continue;
                }
                let automation = if event.method == "turn/completed" {
                    match thread_id {
                        Some(id) => worker.pending_automations.lock().await.remove(id),
                        None => None,
                    }
                } else { None };
                if let Some(pending) = automation.as_ref() {
                    let item = from_event(&event.method, &event.params, false, Some(pending)).unwrap();
                    let result = item.automation.unwrap();
                    client.emit_local_event("board/automation/completed", json!({
                        "threadId": thread_id, "automationId": result.id, "automationName": result.name,
                        "status": result.status, "result": result.result, "durationMs": result.duration_ms,
                        "finishedAt": item.created_at
                    })).await;
                    continue;
                }
                if let Some(item) = from_event(
                    &event.method,
                    &event.params,
                    event.request_id.is_some(),
                    automation.as_ref(),
                ) {
                    worker.push(item).await;
                }
            }
        });
        store
    }
    pub async fn list(&self) -> Vec<BoardNotification> {
        self.items.lock().await.clone()
    }
    pub async fn mark_read(&self, id: Option<&str>) -> Result<(), String> {
        let mut items = self.items.lock().await;
        for item in items
            .iter_mut()
            .filter(|item| id.is_none() || Some(item.id.as_str()) == id)
        {
            item.read = true;
        }
        self.persist(&items)
    }
    pub async fn clear(&self) -> Result<(), String> {
        let mut items = self.items.lock().await;
        items.clear();
        self.persist(&items)
    }
    async fn push(&self, item: BoardNotification) {
        let mut items = self.items.lock().await;
        items.insert(0, item);
        items.truncate(200);
        let _ = self.persist(&items);
    }
    fn persist(&self, items: &[BoardNotification]) -> Result<(), String> {
        persistence::write_json(&self.path, items)
    }
}
fn from_event(
    method: &str,
    params: &Value,
    is_request: bool,
    pending_automation: Option<&PendingAutomation>,
) -> Option<BoardNotification> {
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (kind, title, message, automation) = if method == "board/automation/completed" {
        let name = params
            .get("automationName")
            .and_then(Value::as_str)
            .unwrap_or("Automation");
        let status = params
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let status = if status == "completed" { "success" } else { status };
        let result = params
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("Automation finished.");
        (
            "automation",
            outcome_title(status),
            format!("{name}: {}", outcome_title(status)),
            Some(AutomationResultDetails {
                id: params
                    .get("automationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name: name.to_owned(),
                result: truncate(result, 2_000),
                status: status.to_owned(),
                duration_ms: params.get("durationMs").and_then(Value::as_i64),
            }),
        )
    } else if let Some(pending) = pending_automation {
        let turn = params.get("turn").unwrap_or(&Value::Null);
        let text = turn.get("items").and_then(Value::as_array)
            .and_then(|items| automation_result::final_message(items))
            .or(pending.final_text.as_deref());
        let report = automation_result::resolve(turn, text, now_ms());
        (
            "automation",
            outcome_title(&report.status),
            format!("{}: {}", pending.name, outcome_title(&report.status)),
            Some(AutomationResultDetails {
                id: pending.id.clone(),
                name: pending.name.clone(),
                result: report.summary,
                status: report.status,
                duration_ms: turn.get("durationMs").and_then(Value::as_i64),
            }),
        )
    } else if is_request {
        (
            "attention",
            "Codex needs you",
            (if method.contains("requestUserInput") {
                "A task is waiting for your answer"
            } else {
                "An approval is waiting for review"
            })
            .to_owned(),
            None,
        )
    } else {
        match method {
            "turn/completed" => (
                "done",
                "Task completed",
                "Codex finished working".to_owned(),
                None,
            ),
            "board/queue/error" => (
                "error",
                "Queued message failed",
                params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The queued instruction could not start")
                    .to_owned(),
                None,
            ),
            _ => return None,
        }
    };
    Some(BoardNotification {
        id: random_id(),
        kind: kind.into(),
        title: title.into(),
        message,
        thread_id,
        created_at: now_ms(),
        read: false,
        automation,
    })
}

fn outcome_title(status: &str) -> &'static str {
    match status {
        "success" => "Automation succeeded",
        "failed" | "interrupted" => "Automation failed",
        _ => "Automation outcome unverified",
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.trim().chars();
    let result = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{result}…")
    } else {
        result
    }
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn random_id() -> String {
    let mut bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completion_and_requests_become_actionable_notifications() {
        let completed = from_event("turn/completed", &json!({ "threadId": "t-1" }), false, None)
            .expect("completion notification");
        assert_eq!(completed.kind, "done");
        assert_eq!(completed.thread_id.as_deref(), Some("t-1"));

        let request = from_event(
            "item/tool/requestUserInput",
            &json!({ "threadId": "t-2" }),
            true,
            None,
        )
        .expect("request notification");
        assert_eq!(request.kind, "attention");
        assert!(request.message.contains("answer"));
    }

    #[test]
    fn unrelated_stream_events_are_ignored() {
        assert!(from_event("item/agentMessage/delta", &json!({}), false, None).is_none());
    }

    #[test]
    fn automation_completion_contains_the_concise_agent_result() {
        let pending = PendingAutomation {
            id: "a-1".into(),
            name: "Daily report".into(),
            final_text: None,
        };
        let notification = from_event(
            "turn/completed",
            &json!({
                "threadId": "t-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed",
                    "durationMs": 1500,
                    "items": [
                        { "type": "userMessage", "text": "Run" },
                        { "type": "agentMessage", "text": r#"{"status":"success","summary":"Found 3 records. Updated the report."}"# }
                    ]
                }
            }),
            false,
            Some(&pending),
        )
        .expect("automation notification");
        assert_eq!(notification.kind, "automation");
        let result = notification.automation.expect("automation details");
        assert_eq!(result.name, "Daily report");
        assert_eq!(result.result, "Found 3 records. Updated the report.");
        assert_eq!(result.duration_ms, Some(1500));
    }

    #[test]
    fn empty_completed_turn_uses_captured_final_message_not_commentary() {
        let pending = PendingAutomation { id: "a".into(), name: "Review".into(),
            final_text: Some(r#"{"status":"failed","summary":"Test non superati."}"#.into()) };
        let item = from_event("turn/completed", &json!({
            "threadId":"t", "turn": {"id":"turn", "status":"completed", "items":[]}
        }), false, Some(&pending)).unwrap();
        let result = item.automation.unwrap();
        assert_eq!(result.status, "failed");
        assert_eq!(result.result, "Test non superati.");
        assert_eq!(item.title, "Automation failed");
    }

    #[tokio::test]
    async fn automation_stream_is_correlated_before_turn_start_response_and_emits_one_result() {
        let directory = std::env::temp_dir().join(format!("board-result-test-{}", random_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let client = Arc::new(CodexClient::new());
        let store = NotificationStore::new(directory.join("notifications.json"), client.clone());
        // Synthetic local events only: no Codex process, task or model turn is started.
        client.emit_local_event("board/automation/submitting", json!({"threadId":"t","automationId":"a","automationName":"Review"})).await;
        client.emit_local_event("item/completed", json!({"threadId":"t","item":{"type":"agentMessage","phase":"commentary","text":"Working..."}})).await;
        client.emit_local_event("item/completed", json!({"threadId":"t","item":{"type":"agentMessage","phase":"final_answer","text":r#"{"status":"success","summary":"Tutto verificato."}"#}})).await;
        client.emit_local_event("turn/completed", json!({"threadId":"t","turn":{"id":"fast","status":"completed","items":[]}})).await;
        client.emit_local_event("board/automation/turn-started", json!({"threadId":"t","turnId":"fast","automationId":"a","automationName":"Review"})).await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let items = store.list().await;
                if !items.is_empty() {
                    assert_eq!(items.len(), 1);
                    assert_eq!(items[0].automation.as_ref().unwrap().status, "success");
                    assert_eq!(items[0].automation.as_ref().unwrap().result, "Tutto verificato.");
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
