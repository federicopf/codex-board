use std::{
    collections::HashMap,
    io,
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot},
    time::{sleep, timeout},
};

use super::{
    protocol::{PendingMap, fail_all, handle_incoming},
    types::{CodexErrorCode, CodexErrorDto},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) struct RunningClient {
    outbound: mpsc::UnboundedSender<Value>,
    pending: PendingMap,
    child: Arc<StdMutex<Child>>,
    alive: Arc<AtomicBool>,
    next_id: AtomicU64,
}

impl RunningClient {
    pub(crate) async fn spawn() -> Result<Arc<Self>, CodexErrorDto> {
        let mut command = Command::new("codex");
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command.spawn().map_err(classify_spawn_error)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            CodexErrorDto::new(CodexErrorCode::StartFailed, "Could not open Codex stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CodexErrorDto::new(CodexErrorCode::StartFailed, "Could not open Codex stdout")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            CodexErrorDto::new(CodexErrorCode::StartFailed, "Could not open Codex stderr")
        })?;

        let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<Value>();
        let pending: PendingMap = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let child = Arc::new(StdMutex::new(child));

        let writer_pending = pending.clone();
        let writer_alive = alive.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(message) = outbound_rx.recv().await {
                let mut encoded = match serde_json::to_vec(&message) {
                    Ok(encoded) => encoded,
                    Err(error) => {
                        fail_all(
                            &writer_pending,
                            CodexErrorDto::new(
                                CodexErrorCode::ProtocolError,
                                "Could not encode Codex request",
                            )
                            .with_details(error.to_string()),
                        )
                        .await;
                        break;
                    }
                };
                encoded.push(b'\n');
                if let Err(error) = stdin.write_all(&encoded).await {
                    writer_alive.store(false, Ordering::Release);
                    fail_all(
                        &writer_pending,
                        CodexErrorDto::new(
                            CodexErrorCode::ProcessExited,
                            "Could not write to Codex",
                        )
                        .with_details(error.to_string()),
                    )
                    .await;
                    break;
                }
            }
        });

        let reader_pending = pending.clone();
        let reader_outbound = outbound.clone();
        let reader_alive = alive.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if let Err(error) =
                            handle_incoming(&line, &reader_pending, &reader_outbound).await
                        {
                            reader_alive.store(false, Ordering::Release);
                            fail_all(&reader_pending, error).await;
                            break;
                        }
                    }
                    Ok(None) => {
                        reader_alive.store(false, Ordering::Release);
                        fail_all(
                            &reader_pending,
                            CodexErrorDto::new(
                                CodexErrorCode::ProcessExited,
                                "Codex closed its output stream",
                            ),
                        )
                        .await;
                        break;
                    }
                    Err(error) => {
                        reader_alive.store(false, Ordering::Release);
                        fail_all(
                            &reader_pending,
                            CodexErrorDto::new(
                                CodexErrorCode::ProcessExited,
                                "Could not read Codex output",
                            )
                            .with_details(error.to_string()),
                        )
                        .await;
                        break;
                    }
                }
            }
        });

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("codex app-server: {line}");
            }
        });

        let monitor_child = child.clone();
        let monitor_pending = pending.clone();
        let monitor_alive = alive.clone();
        tokio::spawn(async move {
            loop {
                let status = monitor_child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok())
                    .flatten();
                if let Some(status) = status {
                    monitor_alive.store(false, Ordering::Release);
                    fail_all(
                        &monitor_pending,
                        CodexErrorDto::new(CodexErrorCode::ProcessExited, "Codex process exited")
                            .with_details(status.to_string()),
                    )
                    .await;
                    break;
                }
                if !monitor_alive.load(Ordering::Acquire) {
                    break;
                }
                sleep(Duration::from_millis(250)).await;
            }
        });

        Ok(Arc::new(Self {
            outbound,
            pending,
            child,
            alive,
            next_id: AtomicU64::new(1),
        }))
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub(crate) async fn initialize(&self) -> Result<(), CodexErrorDto> {
        self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "codex_board",
                    "title": "Codex Board",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await
        .map_err(|error| CodexErrorDto {
            code: CodexErrorCode::HandshakeFailed,
            message: "Codex app-server handshake failed".into(),
            details: Some(format!(
                "{}: {}",
                error.message,
                error.details.unwrap_or_default()
            )),
        })?;
        self.notify("initialized", json!({}))?;
        Ok(())
    }

    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, CodexErrorDto> {
        if !self.is_alive() {
            return Err(CodexErrorDto::new(
                CodexErrorCode::ProcessExited,
                "Codex process is not running",
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if self
            .outbound
            .send(json!({ "method": method, "id": id, "params": params }))
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err(CodexErrorDto::new(
                CodexErrorCode::ProcessExited,
                "Codex process is unavailable",
            ));
        }

        match timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err(CodexErrorDto::new(
                CodexErrorCode::ProcessExited,
                "Codex response channel closed",
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(CodexErrorDto::new(
                    CodexErrorCode::RequestFailed,
                    "Codex request timed out",
                ))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), CodexErrorDto> {
        self.outbound
            .send(json!({ "method": method, "params": params }))
            .map_err(|_| {
                CodexErrorDto::new(
                    CodexErrorCode::ProcessExited,
                    "Codex process is unavailable",
                )
            })
    }

    pub(crate) fn shutdown_now(&self) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
    }
}

impl Drop for RunningClient {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}

fn classify_spawn_error(error: io::Error) -> CodexErrorDto {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => CodexErrorDto::new(
            CodexErrorCode::CliNotFound,
            "Codex CLI not found. Install the standalone Windows CLI and add it to PATH.",
        )
        .with_details(error.to_string()),
        _ => CodexErrorDto::new(CodexErrorCode::StartFailed, "Could not start Codex CLI")
            .with_details(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_cli_has_a_stable_error_code() {
        let error = classify_spawn_error(io::Error::from(io::ErrorKind::NotFound));
        assert!(matches!(error.code, CodexErrorCode::CliNotFound));
    }
}
