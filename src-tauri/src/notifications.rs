use crate::{codex::CodexClient, persistence};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
            while let Ok(event) = events.recv().await {
                if event.method == "board/automation/turn-started" {
                    if let (Some(turn_id), Some(id), Some(name)) = (
                        event.params.get("turnId").and_then(Value::as_str),
                        event.params.get("automationId").and_then(Value::as_str),
                        event.params.get("automationName").and_then(Value::as_str),
                    ) {
                        worker.pending_automations.lock().await.insert(
                            turn_id.to_owned(),
                            PendingAutomation {
                                id: id.to_owned(),
                                name: name.to_owned(),
                            },
                        );
                    }
                    continue;
                }
                let automation = if event.method == "turn/completed" {
                    let turn_id = event
                        .params
                        .get("turn")
                        .and_then(|turn| turn.get("id"))
                        .and_then(Value::as_str);
                    match turn_id {
                        Some(id) => worker.pending_automations.lock().await.remove(id),
                        None => None,
                    }
                } else {
                    None
                };
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
            .unwrap_or("completed");
        let result = params
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("Automation finished.");
        (
            "automation",
            "Automation completed",
            format!("{name} finished"),
            Some(AutomationResultDetails {
                id: params
                    .get("automationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name: name.to_owned(),
                result: result.to_owned(),
                status: status.to_owned(),
                duration_ms: params.get("durationMs").and_then(Value::as_i64),
            }),
        )
    } else if let Some(pending) = pending_automation {
        let turn = params.get("turn").unwrap_or(&Value::Null);
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let result = automation_result(turn, status);
        (
            "automation",
            "Automation completed",
            format!("{} finished", pending.name),
            Some(AutomationResultDetails {
                id: pending.id.clone(),
                name: pending.name.clone(),
                result,
                status: status.to_owned(),
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

fn automation_result(turn: &Value, status: &str) -> String {
    if status == "failed" {
        return turn
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("The automation ended with an error.")
            .to_owned();
    }
    let result = turn
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().rev().find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                    .then(|| item.get("text").and_then(Value::as_str))
                    .flatten()
            })
        })
        .unwrap_or(if status == "interrupted" {
            "Automation interrupted."
        } else {
            "Automation completed without a written result."
        });
    truncate(result, 2_000)
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
                        { "type": "agentMessage", "text": "Found 3 records. Updated the report." }
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
}
