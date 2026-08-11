use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use serde_json::Value;
use tokio::sync::{Mutex, broadcast, oneshot};

use super::types::{CodexErrorCode, CodexErrorDto, CodexEventDto};

pub(crate) type Response = Result<Value, CodexErrorDto>;
pub(crate) type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;
#[derive(Clone)]
pub(crate) struct EventQueue {
    queued: Arc<Mutex<VecDeque<CodexEventDto>>>,
    broadcast: broadcast::Sender<CodexEventDto>,
}

impl EventQueue {
    pub(crate) fn new() -> Self {
        let (broadcast, _) = broadcast::channel(2048);
        Self {
            queued: Arc::new(Mutex::new(VecDeque::new())),
            broadcast,
        }
    }

    pub(crate) async fn push(&self, event: CodexEventDto) {
        self.queued.lock().await.push_back(event.clone());
        let _ = self.broadcast.send(event);
    }

    pub(crate) async fn drain(&self) -> Vec<CodexEventDto> {
        self.queued.lock().await.drain(..).collect()
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<CodexEventDto> {
        self.broadcast.subscribe()
    }

    #[cfg(test)]
    async fn pop_front(&self) -> Option<CodexEventDto> {
        self.queued.lock().await.pop_front()
    }

    #[cfg(test)]
    async fn len(&self) -> usize {
        self.queued.lock().await.len()
    }
}

pub(crate) async fn handle_incoming(
    line: &str,
    pending: &PendingMap,
    events: &EventQueue,
) -> Result<(), CodexErrorDto> {
    let message: Value = serde_json::from_str(line).map_err(|error| {
        CodexErrorDto::new(CodexErrorCode::ProtocolError, "Codex returned invalid JSON")
            .with_details(error.to_string())
    })?;

    let request_id = message.get("id").cloned();
    if request_id.is_none() {
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            events
                .push(CodexEventDto {
                    method: method.to_owned(),
                    params: message.get("params").cloned().unwrap_or(Value::Null),
                    request_id: None,
                })
                .await;
        }
        return Ok(());
    }

    if message.get("result").is_some() || message.get("error").is_some() {
        if let Some(id) = request_id.as_ref().and_then(Value::as_u64)
            && let Some(sender) = pending.lock().await.remove(&id)
        {
            let response = if let Some(error) = message.get("error") {
                let message_text = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex request failed");
                Err(
                    CodexErrorDto::new(CodexErrorCode::RequestFailed, message_text)
                        .with_details(error.to_string()),
                )
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(response);
        }
        return Ok(());
    }

    if let Some(method) = message.get("method").and_then(Value::as_str) {
        events
            .push(CodexEventDto {
                method: method.to_owned(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
                request_id,
            })
            .await;
    }

    Ok(())
}

pub(crate) async fn fail_all(pending: &PendingMap, error: CodexErrorDto) {
    let drained = {
        let mut requests = pending.lock().await;
        requests
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>()
    };
    for sender in drained {
        let _ = sender.send(Err(error.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn matches_out_of_order_responses() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (first_tx, first_rx) = oneshot::channel();
        let (second_tx, second_rx) = oneshot::channel();
        pending.lock().await.insert(1, first_tx);
        pending.lock().await.insert(2, second_tx);
        let events = EventQueue::new();

        handle_incoming(r#"{"id":2,"result":{"value":"second"}}"#, &pending, &events)
            .await
            .unwrap();
        handle_incoming(r#"{"id":1,"result":{"value":"first"}}"#, &pending, &events)
            .await
            .unwrap();

        assert_eq!(first_rx.await.unwrap().unwrap()["value"], "first");
        assert_eq!(second_rx.await.unwrap().unwrap()["value"], "second");
    }

    #[tokio::test]
    async fn ignores_interleaved_notifications() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let events = EventQueue::new();
        handle_incoming(
            r#"{"method":"thread/name/updated","params":{}}"#,
            &pending,
            &events,
        )
        .await
        .unwrap();
        assert!(pending.lock().await.is_empty());
        assert_eq!(events.len().await, 1);
    }

    #[tokio::test]
    async fn queues_server_requests_for_the_ui() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let events = EventQueue::new();
        handle_incoming(
            r#"{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{"threadId":"thr_1"}}"#,
            &pending,
            &events,
        )
        .await
        .unwrap();
        let event = events.pop_front().await.unwrap();
        assert_eq!(event.request_id, Some(serde_json::json!("approval-1")));
    }

    #[tokio::test]
    async fn invalid_json_is_a_protocol_error() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let events = EventQueue::new();
        let error = handle_incoming("not-json", &pending, &events)
            .await
            .unwrap_err();
        assert!(matches!(error.code, CodexErrorCode::ProtocolError));
    }

    #[tokio::test]
    async fn eof_failure_resolves_every_pending_request() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(1, tx);
        fail_all(
            &pending,
            CodexErrorDto::new(CodexErrorCode::ProcessExited, "exited"),
        )
        .await;
        assert!(rx.await.unwrap().is_err());
    }
}
