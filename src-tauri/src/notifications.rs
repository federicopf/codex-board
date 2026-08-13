use crate::{codex::CodexClient, persistence};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
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
}

pub struct NotificationStore {
    items: Mutex<Vec<BoardNotification>>,
    path: PathBuf,
}
impl NotificationStore {
    pub fn new(path: PathBuf, client: Arc<CodexClient>) -> Arc<Self> {
        let items = persistence::load_json_or_default(&path);
        let store = Arc::new(Self {
            items: Mutex::new(items),
            path,
        });
        let worker = store.clone();
        let mut events = client.subscribe_events();
        tauri::async_runtime::spawn(async move {
            while let Ok(event) = events.recv().await {
                if let Some(item) =
                    from_event(&event.method, &event.params, event.request_id.is_some())
                {
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
fn from_event(method: &str, params: &Value, is_request: bool) -> Option<BoardNotification> {
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (kind, title, message) = if is_request {
        (
            "attention",
            "Codex needs you",
            if method.contains("requestUserInput") {
                "A task is waiting for your answer"
            } else {
                "An approval is waiting for review"
            },
        )
    } else {
        match method {
            "turn/completed" => ("done", "Task completed", "Codex finished working"),
            "board/queue/error" => (
                "error",
                "Queued message failed",
                params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The queued instruction could not start"),
            ),
            _ => return None,
        }
    };
    Some(BoardNotification {
        id: random_id(),
        kind: kind.into(),
        title: title.into(),
        message: message.into(),
        thread_id,
        created_at: now_ms(),
        read: false,
    })
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
        let completed = from_event("turn/completed", &json!({ "threadId": "t-1" }), false)
            .expect("completion notification");
        assert_eq!(completed.kind, "done");
        assert_eq!(completed.thread_id.as_deref(), Some("t-1"));

        let request = from_event(
            "item/tool/requestUserInput",
            &json!({ "threadId": "t-2" }),
            true,
        )
        .expect("request notification");
        assert_eq!(request.kind, "attention");
        assert!(request.message.contains("answer"));
    }

    #[test]
    fn unrelated_stream_events_are_ignored() {
        assert!(from_event("item/agentMessage/delta", &json!({}), false).is_none());
    }
}
