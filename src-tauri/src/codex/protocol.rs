use std::{collections::HashMap, sync::Arc};

use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, oneshot};

use super::types::{CodexErrorCode, CodexErrorDto};

pub(crate) type Response = Result<Value, CodexErrorDto>;
pub(crate) type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;

pub(crate) async fn handle_incoming(
    line: &str,
    pending: &PendingMap,
    outbound: &mpsc::UnboundedSender<Value>,
) -> Result<(), CodexErrorDto> {
    let message: Value = serde_json::from_str(line).map_err(|error| {
        CodexErrorDto::new(CodexErrorCode::ProtocolError, "Codex returned invalid JSON")
            .with_details(error.to_string())
    })?;

    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        // Notifications intentionally have no id. This MVP does not subscribe to any.
        return Ok(());
    };

    if message.get("result").is_some() || message.get("error").is_some() {
        if let Some(sender) = pending.lock().await.remove(&id) {
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

    // A message with both method and id is a server-initiated request, not a
    // notification. Board operations should not trigger one, but answer safely.
    if message.get("method").and_then(Value::as_str).is_some() {
        outbound
            .send(json!({
                "id": id,
                "error": { "code": -32601, "message": "Method not supported by Codex Board" }
            }))
            .map_err(|_| {
                CodexErrorDto::new(
                    CodexErrorCode::ProcessExited,
                    "Codex process is unavailable",
                )
            })?;
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
        let (outbound, _rx) = mpsc::unbounded_channel();

        handle_incoming(
            r#"{"id":2,"result":{"value":"second"}}"#,
            &pending,
            &outbound,
        )
        .await
        .unwrap();
        handle_incoming(
            r#"{"id":1,"result":{"value":"first"}}"#,
            &pending,
            &outbound,
        )
        .await
        .unwrap();

        assert_eq!(first_rx.await.unwrap().unwrap()["value"], "first");
        assert_eq!(second_rx.await.unwrap().unwrap()["value"], "second");
    }

    #[tokio::test]
    async fn ignores_interleaved_notifications() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (outbound, _rx) = mpsc::unbounded_channel();
        handle_incoming(
            r#"{"method":"thread/name/updated","params":{}}"#,
            &pending,
            &outbound,
        )
        .await
        .unwrap();
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn invalid_json_is_a_protocol_error() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (outbound, _rx) = mpsc::unbounded_channel();
        let error = handle_incoming("not-json", &pending, &outbound)
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
