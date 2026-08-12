use std::{
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use axum::{
    Json, Router,
    extract::{
        Path as AxumPath, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};

use crate::codex::{CodexClient, CodexErrorDto, TurnCoordinator};

pub const GATEWAY_PORT: u16 = 47_821;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardConfig {
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default = "default_approval_mode")]
    pub approval_mode: String,
    #[serde(default)]
    pub revision: u64,
}

fn default_approval_mode() -> String {
    "auto".into()
}

impl Default for BoardConfig {
    fn default() -> Self {
        Self {
            categories: Vec::new(),
            approval_mode: default_approval_mode(),
            revision: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    pub running: bool,
    pub port: u16,
    pub token: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo {
    pub installed: bool,
    pub online: bool,
    pub dns_name: Option<String>,
    pub base_url: Option<String>,
    pub error: Option<String>,
}

pub struct RemoteGateway {
    info: Arc<RwLock<GatewayInfo>>,
    config: Arc<RwLock<BoardConfig>>,
    config_path: PathBuf,
    pending_requests: Arc<Mutex<Vec<PendingRequest>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub request_id: Value,
    pub method: String,
    pub params: Value,
}

#[derive(Clone)]
struct ApiState {
    client: Arc<CodexClient>,
    coordinator: Arc<TurnCoordinator>,
    token: String,
    config: Arc<RwLock<BoardConfig>>,
    config_path: PathBuf,
    pending_requests: Arc<Mutex<Vec<PendingRequest>>>,
}

#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<CodexErrorDto> for ApiError {
    fn from(error: CodexErrorDto) -> Self {
        Self(StatusCode::BAD_GATEWAY, error.message)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameBody {
    new_name: String,
}

#[derive(Deserialize)]
struct MessageBody {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InterruptBody {
    turn_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondBody {
    request_id: Value,
    result: Value,
}

impl RemoteGateway {
    pub fn prepare(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
        let token_path = data_dir.join("remote-token");
        let token = match fs::read_to_string(&token_path) {
            Ok(value) if !value.trim().is_empty() => value.trim().to_owned(),
            _ => {
                let mut bytes = [0_u8; 32];
                rand::rng().fill_bytes(&mut bytes);
                let value = URL_SAFE_NO_PAD.encode(bytes);
                fs::write(&token_path, &value).map_err(|error| error.to_string())?;
                value
            }
        };
        let config_path = data_dir.join("board-config.json");
        let mut config: BoardConfig = fs::read(&config_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        if !matches!(config.approval_mode.as_str(), "auto" | "ask") {
            config.approval_mode = default_approval_mode();
        }
        Ok(Self {
            info: Arc::new(RwLock::new(GatewayInfo {
                running: false,
                port: GATEWAY_PORT,
                token,
                error: None,
            })),
            config: Arc::new(RwLock::new(config)),
            config_path,
            pending_requests: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn info(&self) -> GatewayInfo {
        self.info.read().expect("gateway info poisoned").clone()
    }
    pub fn board_config(&self) -> BoardConfig {
        self.config.read().expect("board config poisoned").clone()
    }

    pub fn set_board_config(&self, mut config: BoardConfig) -> Result<BoardConfig, String> {
        let current_revision = self
            .config
            .read()
            .map_err(|error| error.to_string())?
            .revision;
        config.categories = unique_categories(config.categories)?;
        if !matches!(config.approval_mode.as_str(), "auto" | "ask") {
            return Err("approvalMode must be auto or ask".into());
        }
        config.revision = current_revision.saturating_add(1);
        persist_config(&self.config_path, &config)?;
        *self.config.write().map_err(|error| error.to_string())? = config.clone();
        Ok(config)
    }

    pub fn start(&self, client: Arc<CodexClient>, coordinator: Arc<TurnCoordinator>) {
        let state = ApiState {
            client,
            coordinator,
            token: self.info().token,
            config: self.config.clone(),
            config_path: self.config_path.clone(),
            pending_requests: self.pending_requests.clone(),
        };
        start_request_worker(state.clone());
        let info = self.info.clone();
        tauri::async_runtime::spawn(async move {
            let address = SocketAddr::from(([127, 0, 0, 1], GATEWAY_PORT));
            let listener = match tokio::net::TcpListener::bind(address).await {
                Ok(listener) => listener,
                Err(error) => {
                    let mut current = info.write().expect("gateway info poisoned");
                    current.error = Some(error.to_string());
                    return;
                }
            };
            {
                let mut current = info.write().expect("gateway info poisoned");
                current.running = true;
                current.error = None;
            }
            let app = Router::new()
                .route("/v1/health", get(health))
                .route("/v1/threads", get(list_threads))
                .route("/v1/threads/{id}", get(load_thread))
                .route("/v1/threads/{id}/name", put(rename_thread))
                .route("/v1/threads/{id}/messages", post(send_message))
                .route("/v1/queues", get(message_queues))
                .route(
                    "/v1/threads/{id}/queue/{message_id}",
                    axum::routing::delete(remove_queued_message),
                )
                .route("/v1/threads/{id}/interrupt", post(interrupt_turn))
                .route("/v1/requests/respond", post(respond_to_request))
                .route("/v1/requests", get(pending_requests))
                .route("/v1/board", get(get_board).put(put_board))
                .route("/v1/events", get(events_socket))
                .with_state(state);
            if let Err(error) = axum::serve(listener, app).await {
                let mut current = info.write().expect("gateway info poisoned");
                current.running = false;
                current.error = Some(error.to_string());
            }
        });
    }
}

pub async fn tailscale_status() -> TailscaleInfo {
    let executable = tailscale_executable();
    let output = match tokio::process::Command::new(&executable)
        .args(["status", "--json"])
        .output()
        .await
    {
        Ok(output) => output,
        Err(error) => {
            return TailscaleInfo {
                installed: false,
                online: false,
                dns_name: None,
                base_url: None,
                error: Some(error.to_string()),
            };
        }
    };
    if !output.status.success() {
        return TailscaleInfo {
            installed: true,
            online: false,
            dns_name: None,
            base_url: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_owned()),
        };
    }
    let status: Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => {
            return TailscaleInfo {
                installed: true,
                online: false,
                dns_name: None,
                base_url: None,
                error: Some(error.to_string()),
            };
        }
    };
    let dns_name = status
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('.').to_owned())
        .filter(|value| !value.is_empty());
    let online = status
        .pointer("/Self/Online")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let base_url = dns_name.as_ref().map(|name| format!("https://{name}"));
    TailscaleInfo {
        installed: true,
        online,
        dns_name,
        base_url,
        error: None,
    }
}

pub async fn configure_tailscale_serve() -> Result<TailscaleInfo, String> {
    let target = format!("localhost:{GATEWAY_PORT}");
    let output = tokio::process::Command::new(tailscale_executable())
        .args(["serve", "--bg", target.as_str()])
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(tailscale_status().await)
}

fn tailscale_executable() -> PathBuf {
    if let Some(program_files) = env::var_os("ProgramFiles") {
        let path = PathBuf::from(program_files).join("Tailscale/tailscale.exe");
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from(if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    })
}

fn unique_categories(categories: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for value in categories {
        let value = value.trim().to_owned();
        if value.is_empty() || value.contains(" - ") {
            return Err("Invalid category name".into());
        }
        if !result.contains(&value) {
            result.push(value);
        }
    }
    Ok(result)
}

fn persist_config(path: &Path, config: &BoardConfig) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn authorized(headers: &HeaderMap, state: &ApiState) -> Result<(), ApiError> {
    let expected = format!("Bearer {}", state.token);
    let provided = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    if provided == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Invalid remote credential".into(),
        ))
    }
}

fn start_request_worker(state: ApiState) {
    let mut events = state.client.subscribe_events();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            if event.method == "serverRequest/resolved" {
                if let Some(request_id) = event.params.get("requestId") {
                    state
                        .pending_requests
                        .lock()
                        .await
                        .retain(|request| request.request_id != *request_id);
                }
                continue;
            }
            let Some(request_id) = event.request_id.clone() else {
                continue;
            };
            let request = PendingRequest {
                request_id: request_id.clone(),
                method: event.method.clone(),
                params: event.params.clone(),
            };
            let automatic = state
                .config
                .read()
                .ok()
                .map(|config| config.approval_mode == "auto")
                .unwrap_or(false)
                .then(|| automatic_approval(&event.method, &event.params))
                .flatten();
            if let Some(result) = automatic {
                if state
                    .client
                    .respond_to_request(request_id.clone(), result)
                    .await
                    .is_ok()
                {
                    state
                        .client
                        .emit_local_event(
                            "serverRequest/resolved",
                            json!({ "requestId": request_id }),
                        )
                        .await;
                    continue;
                }
            }
            let mut pending = state.pending_requests.lock().await;
            if !pending
                .iter()
                .any(|item| item.request_id == request.request_id)
            {
                pending.push(request);
            }
        }
    });
}

fn automatic_approval(method: &str, params: &Value) -> Option<Value> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Some(json!({ "decision": "acceptForSession" }))
        }
        "item/permissions/requestApproval" => Some(
            json!({ "permissions": params.get("permissions").cloned().unwrap_or_else(|| json!({})), "scope": "session" }),
        ),
        "applyPatchApproval" | "execCommandApproval" => {
            Some(json!({ "decision": "approved_for_session" }))
        }
        _ => None,
    }
}

async fn health(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(
        json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }),
    ))
}

async fn list_threads(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(
        serde_json::to_value(state.client.list_threads().await?)
            .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
    ))
}

async fn load_thread(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(state.client.load_thread(id).await?))
}

async fn rename_thread(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<RenameBody>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(
        serde_json::to_value(state.client.rename_thread(id, body.new_name).await?)
            .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
    ))
}

async fn send_message(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<MessageBody>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(
        serde_json::to_value(state.coordinator.send(id, body.text).await?)
            .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
    ))
}

async fn message_queues(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(
        serde_json::to_value(state.coordinator.queues().await)
            .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
    ))
}

async fn remove_queued_message(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath((id, message_id)): AxumPath<(String, String)>,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    if state.coordinator.remove(&id, &message_id).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError(
            StatusCode::NOT_FOUND,
            "Queued message not found".into(),
        ))
    }
}

async fn interrupt_turn(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<InterruptBody>,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    state.client.interrupt_turn(id, body.turn_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn respond_to_request(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<RespondBody>,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    state
        .client
        .respond_to_request(body.request_id.clone(), body.result)
        .await?;
    state
        .pending_requests
        .lock()
        .await
        .retain(|request| request.request_id != body.request_id);
    state
        .client
        .emit_local_event(
            "serverRequest/resolved",
            json!({ "requestId": body.request_id }),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn pending_requests(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PendingRequest>>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(state.pending_requests.lock().await.clone()))
}

async fn get_board(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<BoardConfig>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(
        state
            .config
            .read()
            .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .clone(),
    ))
}

async fn put_board(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut config): Json<BoardConfig>,
) -> Result<Json<BoardConfig>, ApiError> {
    authorized(&headers, &state)?;
    config.categories = unique_categories(config.categories)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error))?;
    if !matches!(config.approval_mode.as_str(), "auto" | "ask") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "approvalMode must be auto or ask".into(),
        ));
    }
    let revision = state
        .config
        .read()
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .revision;
    config.revision = revision.saturating_add(1);
    persist_config(&state.config_path, &config)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    *state
        .config
        .write()
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))? =
        config.clone();
    state
        .client
        .emit_local_event(
            "board/config/updated",
            serde_json::to_value(&config)
                .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
        )
        .await;
    Ok(Json(config))
}

async fn events_socket(
    State(state): State<ApiState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    authorized(&headers, &state)?;
    let receiver = state.client.subscribe_events();
    Ok(upgrade
        .on_upgrade(move |socket| stream_events(socket, receiver))
        .into_response())
}

async fn stream_events(
    socket: WebSocket,
    mut receiver: broadcast::Receiver<crate::codex::CodexEventDto>,
) {
    let (mut sender, mut incoming) = socket.split();
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Ok(event) => {
                    let Ok(encoded) = serde_json::to_string(&event) else { continue };
                    if sender.send(Message::Text(encoded.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            message = incoming.next() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_are_trimmed_and_deduplicated() {
        assert_eq!(
            unique_categories(vec![" WIP ".into(), "WIP".into(), "Done".into()]).unwrap(),
            vec!["WIP", "Done"]
        );
    }

    #[test]
    fn category_separator_is_rejected() {
        assert!(unique_categories(vec!["Bad - Name".into()]).is_err());
    }

    #[test]
    fn new_board_defaults_to_auto_approval() {
        assert_eq!(BoardConfig::default().approval_mode, "auto");
    }

    #[test]
    fn automatic_approval_never_answers_user_questions() {
        assert!(automatic_approval("item/tool/requestUserInput", &json!({})).is_none());
        assert_eq!(
            automatic_approval("item/commandExecution/requestApproval", &json!({})).unwrap()["decision"],
            "acceptForSession"
        );
    }
}
