use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::{CodexClient, CodexErrorCode, CodexErrorDto};
use crate::persistence;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub queued: bool,
    pub message_id: Option<String>,
    pub turn: Option<Value>,
}

#[derive(Default)]
struct ThreadState {
    active: bool,
    queue: VecDeque<QueuedMessage>,
}

pub struct TurnCoordinator {
    client: Arc<CodexClient>,
    threads: Mutex<HashMap<String, ThreadState>>,
    queue_path: PathBuf,
}

impl TurnCoordinator {
    pub fn new(client: Arc<CodexClient>, queue_path: PathBuf) -> Arc<Self> {
        let saved: HashMap<String, VecDeque<QueuedMessage>> =
            persistence::load_json_or_default(&queue_path);
        Arc::new(Self {
            client,
            threads: Mutex::new(
                saved
                    .into_iter()
                    .map(|(id, queue)| {
                        (
                            id,
                            ThreadState {
                                active: false,
                                queue,
                            },
                        )
                    })
                    .collect(),
            ),
            queue_path,
        })
    }

    pub fn start(self: &Arc<Self>) {
        let coordinator = self.clone();
        let mut events = self.client.subscribe_events();
        tauri::async_runtime::spawn(async move {
            while let Ok(event) = events.recv().await {
                let thread_id = event
                    .params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let Some(thread_id) = thread_id else { continue };
                if event.method == "turn/started" {
                    coordinator
                        .threads
                        .lock()
                        .await
                        .entry(thread_id)
                        .or_default()
                        .active = true;
                } else if event.method == "turn/completed" {
                    coordinator.finish_and_continue(thread_id).await;
                }
            }
        });
    }

    pub async fn send(
        &self,
        thread_id: String,
        text: String,
    ) -> Result<SendOutcome, CodexErrorDto> {
        let text = text.trim().to_owned();
        if text.is_empty() {
            return Err(CodexErrorDto::new(
                CodexErrorCode::RequestFailed,
                "Message cannot be empty",
            ));
        }

        let mut threads = self.threads.lock().await;
        let state = threads.entry(thread_id.clone()).or_default();
        if !state.active {
            drop(threads);
            let active_in_codex = self
                .client
                .list_threads()
                .await?
                .into_iter()
                .find(|thread| thread.id == thread_id)
                .and_then(|thread| thread.status)
                .and_then(|status| {
                    status
                        .get("type")
                        .and_then(Value::as_str)
                        .map(|kind| kind == "active")
                })
                .unwrap_or(false);
            threads = self.threads.lock().await;
            threads.entry(thread_id.clone()).or_default().active |= active_in_codex;
        }
        let state = threads.entry(thread_id.clone()).or_default();
        if state.active {
            let message = QueuedMessage {
                id: random_id(),
                text,
            };
            state.queue.push_back(message.clone());
            let snapshot = state.queue.iter().cloned().collect::<Vec<_>>();
            let persisted = queue_snapshot(&threads);
            drop(threads);
            self.persist(persisted);
            self.emit_queue(&thread_id, snapshot).await;
            return Ok(SendOutcome {
                queued: true,
                message_id: Some(message.id),
                turn: None,
            });
        }
        state.active = true;
        drop(threads);
        match self.client.send_message(thread_id.clone(), text).await {
            Ok(response) => Ok(SendOutcome {
                queued: false,
                message_id: None,
                turn: response.get("turn").cloned(),
            }),
            Err(error) => {
                self.threads
                    .lock()
                    .await
                    .entry(thread_id)
                    .or_default()
                    .active = false;
                Err(error)
            }
        }
    }

    pub async fn queues(&self) -> HashMap<String, Vec<QueuedMessage>> {
        self.threads
            .lock()
            .await
            .iter()
            .filter_map(|(id, state)| {
                (!state.queue.is_empty())
                    .then(|| (id.clone(), state.queue.iter().cloned().collect()))
            })
            .collect()
    }

    pub async fn remove(&self, thread_id: &str, message_id: &str) -> bool {
        let mut threads = self.threads.lock().await;
        let Some(state) = threads.get_mut(thread_id) else {
            return false;
        };
        let before = state.queue.len();
        state.queue.retain(|message| message.id != message_id);
        let removed = before != state.queue.len();
        let snapshot = state.queue.iter().cloned().collect::<Vec<_>>();
        let persisted = queue_snapshot(&threads);
        drop(threads);
        if removed {
            self.persist(persisted);
            self.emit_queue(thread_id, snapshot).await;
        }
        removed
    }

    async fn finish_and_continue(&self, thread_id: String) {
        let (next, snapshot, persisted) = {
            let mut threads = self.threads.lock().await;
            let state = threads.entry(thread_id.clone()).or_default();
            state.active = false;
            let next = state.queue.pop_front();
            let snapshot = state.queue.iter().cloned().collect::<Vec<_>>();
            if next.is_some() {
                state.active = true;
            }
            let persisted = queue_snapshot(&threads);
            (next, snapshot, persisted)
        };
        self.persist(persisted);
        self.emit_queue(&thread_id, snapshot).await;
        if let Some(message) = next {
            if let Err(error) = self
                .client
                .send_message(thread_id.clone(), message.text)
                .await
            {
                self.threads
                    .lock()
                    .await
                    .entry(thread_id.clone())
                    .or_default()
                    .active = false;
                self.client
                    .emit_local_event(
                        "board/queue/error",
                        json!({ "threadId": thread_id, "message": error.message }),
                    )
                    .await;
            }
        }
    }

    async fn emit_queue(&self, thread_id: &str, messages: Vec<QueuedMessage>) {
        self.client
            .emit_local_event(
                "board/queue/updated",
                json!({ "threadId": thread_id, "messages": messages }),
            )
            .await;
    }

    fn persist(&self, queues: HashMap<String, VecDeque<QueuedMessage>>) {
        let _ = persistence::write_json(&self.queue_path, &queues);
    }
}

fn queue_snapshot(
    threads: &HashMap<String, ThreadState>,
) -> HashMap<String, VecDeque<QueuedMessage>> {
    threads
        .iter()
        .filter_map(|(id, state)| {
            (!state.queue.is_empty()).then(|| (id.clone(), state.queue.clone()))
        })
        .collect()
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0_u8; 12];
    rand::rng().fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_snapshot_omits_empty_queues() {
        let mut threads = HashMap::new();
        threads.insert("empty".into(), ThreadState::default());
        threads.insert(
            "queued".into(),
            ThreadState {
                active: true,
                queue: VecDeque::from([QueuedMessage {
                    id: "1".into(),
                    text: "next".into(),
                }]),
            },
        );
        let snapshot = queue_snapshot(&threads);
        assert!(!snapshot.contains_key("empty"));
        assert_eq!(snapshot["queued"].front().unwrap().text, "next");
    }
}
