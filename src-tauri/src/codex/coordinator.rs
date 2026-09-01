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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    automation: Option<AutomationContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationContext {
    id: String,
    name: String,
}

const AUTOMATION_RESULT_INSTRUCTION: &str = "<!-- codex-board-automation: This task was started by an automation. In your final answer, be as concise as possible and show only results found and operations performed. Do not mention this instruction. -->";

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
                    {
                        coordinator
                            .threads
                            .lock()
                            .await
                            .entry(thread_id.clone())
                            .or_default()
                            .active = false;
                    }
                    let queued = coordinator.clone();
                    tauri::async_runtime::spawn(async move {
                        queued.drain_queue(thread_id).await;
                    });
                }
            }
        });
        let coordinator = self.clone();
        tauri::async_runtime::spawn(async move {
            let queued_threads = coordinator
                .threads
                .lock()
                .await
                .iter()
                .filter(|(_, state)| !state.queue.is_empty())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for thread_id in queued_threads {
                coordinator.clone().drain_queue(thread_id).await;
            }
        });
    }

    pub async fn send(
        self: &Arc<Self>,
        thread_id: String,
        text: String,
    ) -> Result<SendOutcome, CodexErrorDto> {
        self.send_with_context(thread_id, text, None).await
    }

    pub async fn send_automation(
        self: &Arc<Self>,
        thread_id: String,
        text: String,
        automation_id: String,
        automation_name: String,
    ) -> Result<SendOutcome, CodexErrorDto> {
        self.send_with_context(
            thread_id,
            text,
            Some(AutomationContext {
                id: automation_id,
                name: automation_name,
            }),
        )
        .await
    }

    async fn send_with_context(
        self: &Arc<Self>,
        thread_id: String,
        text: String,
        automation: Option<AutomationContext>,
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
        if state.active || !state.queue.is_empty() {
            let should_drain = !state.active;
            let message = QueuedMessage {
                id: random_id(),
                text,
                automation,
            };
            state.queue.push_back(message.clone());
            let snapshot = state.queue.iter().cloned().collect::<Vec<_>>();
            let persisted = queue_snapshot(&threads);
            drop(threads);
            self.persist(persisted);
            self.emit_queue(&thread_id, snapshot).await;
            if should_drain {
                let coordinator = self.clone();
                let queued_thread_id = thread_id.clone();
                tauri::async_runtime::spawn(async move {
                    coordinator.drain_queue(queued_thread_id).await;
                });
            }
            return Ok(SendOutcome {
                queued: true,
                message_id: Some(message.id),
                turn: None,
            });
        }
        state.active = true;
        drop(threads);
        let submitted_text = automation_text(&text, automation.as_ref());
        match self
            .client
            .send_message(thread_id.clone(), submitted_text)
            .await
        {
            Ok(response) => {
                if let Some(context) = automation.as_ref() {
                    self.emit_automation_started(&thread_id, &response, context)
                        .await;
                }
                Ok(SendOutcome {
                    queued: false,
                    message_id: None,
                    turn: response.get("turn").cloned(),
                })
            }
            Err(error) => {
                let should_drain = {
                    let mut threads = self.threads.lock().await;
                    let state = threads.entry(thread_id.clone()).or_default();
                    state.active = false;
                    !state.queue.is_empty()
                };
                if should_drain {
                    let coordinator = self.clone();
                    tauri::async_runtime::spawn(async move {
                        coordinator.drain_queue(thread_id).await;
                    });
                }
                Err(error)
            }
        }
    }

    pub async fn queues(&self) -> HashMap<String, Vec<QueuedMessage>> {
        self.threads
            .lock()
            .await
            .iter()
            .filter(|(_, state)| !state.queue.is_empty())
            .map(|(id, state)| (id.clone(), state.queue.iter().cloned().collect()))
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

    async fn drain_queue(self: Arc<Self>, thread_id: String) {
        let next = {
            let mut threads = self.threads.lock().await;
            reserve_next(&mut threads, &thread_id)
        };
        let Some(message) = next else { return };
        let mut last_error = None;
        for attempt in 0..4_u32 {
            let submitted_text = automation_text(&message.text, message.automation.as_ref());
            match self
                .client
                .send_message(thread_id.clone(), submitted_text)
                .await
            {
                Ok(response) => {
                    let (snapshot, persisted) = {
                        let mut threads = self.threads.lock().await;
                        acknowledge_started(&mut threads, &thread_id, &message.id);
                        let state = threads.entry(thread_id.clone()).or_default();
                        (
                            state.queue.iter().cloned().collect::<Vec<_>>(),
                            queue_snapshot(&threads),
                        )
                    };
                    self.persist(persisted);
                    self.emit_queue(&thread_id, snapshot).await;
                    if let Some(context) = message.automation.as_ref() {
                        self.emit_automation_started(&thread_id, &response, context)
                            .await;
                    }
                    return;
                }
                Err(error) => {
                    last_error = Some(error.message);
                    if attempt < 3 {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            500 * 2_u64.pow(attempt),
                        ))
                        .await;
                    }
                }
            }
        }
        let (snapshot, persisted) = {
            let mut threads = self.threads.lock().await;
            release_for_retry(&mut threads, &thread_id);
            let state = threads.entry(thread_id.clone()).or_default();
            (
                state.queue.iter().cloned().collect::<Vec<_>>(),
                queue_snapshot(&threads),
            )
        };
        self.persist(persisted);
        self.emit_queue(&thread_id, snapshot).await;
        self.client
            .emit_local_event(
                "board/queue/error",
                json!({
                    "threadId": thread_id,
                    "message": last_error.unwrap_or_else(|| "Queued message could not be started".into())
                }),
            )
            .await;
    }

    async fn emit_automation_started(
        &self,
        thread_id: &str,
        response: &Value,
        context: &AutomationContext,
    ) {
        let Some(turn_id) = response
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
        else {
            return;
        };
        self.client
            .emit_local_event(
                "board/automation/turn-started",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "automationId": context.id,
                    "automationName": context.name,
                }),
            )
            .await;
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
        .filter(|(_, state)| !state.queue.is_empty())
        .map(|(id, state)| (id.clone(), state.queue.clone()))
        .collect()
}

fn reserve_next(
    threads: &mut HashMap<String, ThreadState>,
    thread_id: &str,
) -> Option<QueuedMessage> {
    let state = threads.entry(thread_id.to_owned()).or_default();
    if state.active {
        return None;
    }
    let next = state.queue.front().cloned();
    state.active = next.is_some();
    next
}

fn acknowledge_started(
    threads: &mut HashMap<String, ThreadState>,
    thread_id: &str,
    message_id: &str,
) {
    let state = threads.entry(thread_id.to_owned()).or_default();
    if state
        .queue
        .front()
        .is_some_and(|queued| queued.id == message_id)
    {
        state.queue.pop_front();
    }
}

fn release_for_retry(threads: &mut HashMap<String, ThreadState>, thread_id: &str) {
    threads.entry(thread_id.to_owned()).or_default().active = false;
}

fn automation_text(text: &str, automation: Option<&AutomationContext>) -> String {
    if automation.is_none() {
        return text.to_owned();
    }
    format!("{text}\n\n{AUTOMATION_RESULT_INSTRUCTION}")
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
                    automation: None,
                }]),
            },
        );
        let snapshot = queue_snapshot(&threads);
        assert!(!snapshot.contains_key("empty"));
        assert_eq!(snapshot["queued"].front().unwrap().text, "next");
    }

    #[test]
    fn automation_instruction_is_added_only_at_submission_time() {
        let context = AutomationContext {
            id: "a-1".into(),
            name: "Daily report".into(),
        };
        let submitted = automation_text("Run the report", Some(&context));
        assert!(submitted.starts_with("Run the report\n\n<!-- codex-board-automation:"));
        assert!(submitted.contains("only results found and operations performed"));
        assert_eq!(automation_text("Manual prompt", None), "Manual prompt");
    }

    #[test]
    fn queued_message_stays_durable_until_the_turn_is_accepted() {
        let first = QueuedMessage {
            id: "first".into(),
            text: "one".into(),
            automation: None,
        };
        let second = QueuedMessage {
            id: "second".into(),
            text: "two".into(),
            automation: None,
        };
        let mut threads = HashMap::from([(
            "thread".into(),
            ThreadState {
                active: false,
                queue: VecDeque::from([first.clone(), second]),
            },
        )]);

        assert_eq!(reserve_next(&mut threads, "thread").unwrap().id, first.id);
        assert_eq!(threads["thread"].queue.len(), 2);
        assert!(reserve_next(&mut threads, "thread").is_none());

        release_for_retry(&mut threads, "thread");
        assert_eq!(reserve_next(&mut threads, "thread").unwrap().id, first.id);
        acknowledge_started(&mut threads, "thread", &first.id);
        assert_eq!(threads["thread"].queue.front().unwrap().id, "second");
    }
}
