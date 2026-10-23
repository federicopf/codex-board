use std::{
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use axum::{
    Json, Router,
    extract::{
        Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};

use crate::{
    automations::{AutomationEnabledInput, AutomationStore, CreateAutomationInput},
    codex::{CodexClient, CodexErrorDto, TurnCoordinator, TurnSettings},
    notifications::NotificationStore,
};

pub const GATEWAY_PORT: u16 = 47_821;
pub const TAILSCALE_SERVE_PORT: u16 = 47_822;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardConfig {
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub customers: Vec<ProjectCustomer>,
    #[serde(default = "default_approval_mode")]
    pub approval_mode: String,
    #[serde(default)]
    pub turn_settings: TurnPreferences,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCustomer {
    pub id: String,
    pub project_cwd: String,
    pub name: String,
    #[serde(default)]
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPreferences {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default = "default_summary")]
    pub summary: String,
    #[serde(default)]
    pub service_tier: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPreferencesPatch {
    #[serde(default)]
    pub initialize_only: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub summary: Option<String>,
    pub service_tier: Option<String>,
}

impl Default for TurnPreferences {
    fn default() -> Self {
        Self { model: String::new(), effort: String::new(), summary: default_summary(), service_tier: String::new() }
    }
}

fn default_summary() -> String { "auto".into() }

fn default_approval_mode() -> String {
    "auto".into()
}

impl Default for BoardConfig {
    fn default() -> Self {
        Self {
            categories: Vec::new(),
            projects: Vec::new(),
            customers: Vec::new(),
            approval_mode: default_approval_mode(),
            turn_settings: TurnPreferences::default(),
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
    automations: Arc<AutomationStore>,
    notifications: Arc<NotificationStore>,
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
#[serde(rename_all = "camelCase")]
struct CreateThreadBody {
    cwd: String,
    category: String,
    title: String,
    prompt: String,
    #[serde(default)]
    image_urls: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkThreadBody {
    category: String,
    title: String,
    last_turn_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageBody {
    text: String,
    image_url: Option<String>,
    image_urls: Option<Vec<String>>,
    settings: Option<TurnSettings>,
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
        let mut config: BoardConfig = crate::persistence::load_json_or_default(&config_path);
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
        config.categories = unique_categories(config.categories)?;
        config.projects = unique_projects(config.projects)?;
        config.customers = unique_customers(config.customers)?;
        if !matches!(config.approval_mode.as_str(), "auto" | "ask") {
            return Err("approvalMode must be auto or ask".into());
        }
        save_board_config(&self.config, &self.config_path, config)
    }

    pub fn delete_customer(&self, customer_id: &str) -> Result<BoardConfig, String> {
        delete_customer_config(&self.config, &self.config_path, customer_id)?
            .ok_or_else(|| "Customer not found".into())
    }

    pub fn set_turn_settings(&self, patch: TurnPreferencesPatch) -> Result<BoardConfig, String> {
        save_turn_settings(&self.config, &self.config_path, patch)
    }

    pub fn start(
        &self,
        client: Arc<CodexClient>,
        coordinator: Arc<TurnCoordinator>,
        automations: Arc<AutomationStore>,
        notifications: Arc<NotificationStore>,
    ) {
        let state = ApiState {
            client,
            coordinator,
            token: self.info().token,
            config: self.config.clone(),
            config_path: self.config_path.clone(),
            pending_requests: self.pending_requests.clone(),
            automations,
            notifications,
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
                .route("/v1/rate-limits", get(rate_limits))
                .route("/v1/models", get(models))
                .route("/v1/threads", get(list_threads))
                .route("/v1/threads/new", post(create_thread).layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)))
                .route("/v1/threads/{id}", get(load_thread))
                .route("/v1/image", get(get_image))
                .route("/v1/threads/{id}/archive", axum::routing::post(archive_thread))
                .route("/v1/threads/{id}/fork", post(fork_thread))
                .route("/v1/threads/{id}/name", put(rename_thread))
                .route("/v1/threads/{id}/messages", post(send_message).layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)))
                .route("/v1/queues", get(message_queues))
                .route(
                    "/v1/threads/{id}/queue/{message_id}",
                    axum::routing::delete(remove_queued_message),
                )
                .route("/v1/threads/{id}/interrupt", post(interrupt_turn))
                .route("/v1/threads/{id}/compact", post(compact_thread))
                .route("/v1/requests/respond", post(respond_to_request))
                .route("/v1/requests", get(pending_requests))
                .route("/v1/board", get(get_board).put(put_board))
                .route("/v1/customers/{id}", delete(delete_customer))
                .route("/v1/turn-settings", put(put_turn_settings))
                .route(
                    "/v1/automations",
                    get(list_automations).post(create_automation),
                )
                .route(
                    "/v1/automations/{id}",
                    put(set_automation_enabled).patch(update_automation).delete(delete_automation),
                )
                .route(
                    "/v1/automations/{id}/retry",
                    post(retry_automation),
                )
                .route(
                    "/v1/notifications",
                    get(list_notifications).delete(clear_notifications),
                )
                .route("/v1/notifications/read", post(mark_notifications_read))
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
    let mut status_command = tokio::process::Command::new(&executable);
    status_command.args(["status", "--json"]);
    hide_console_window(&mut status_command);
    let output = match status_command.output().await
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
    let mut serve_command = tokio::process::Command::new(&executable);
    serve_command.args(["serve", "status", "--json"]);
    hide_console_window(&mut serve_command);
    let serve_output = serve_command.output().await
        .ok();
    let serve_status: Value = serve_output
        .filter(|result| result.status.success())
        .and_then(|result| serde_json::from_slice(&result.stdout).ok())
        .unwrap_or(Value::Null);
    let http_enabled = serve_status
        .pointer(&format!("/TCP/{TAILSCALE_SERVE_PORT}/HTTP"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let base_url = if online && http_enabled {
        dns_name
            .as_ref()
            .map(|name| format!("http://{name}:{TAILSCALE_SERVE_PORT}"))
    } else {
        None
    };
    TailscaleInfo {
        installed: true,
        online,
        dns_name,
        base_url,
        error: None,
    }
}

pub async fn configure_tailscale_serve() -> Result<TailscaleInfo, String> {
    let target = GATEWAY_PORT.to_string();
    let http_port = format!("--http={TAILSCALE_SERVE_PORT}");
    let mut command = tokio::process::Command::new(tailscale_executable());
    command.args([
            "serve",
            "--bg",
            "--yes",
            http_port.as_str(),
            target.as_str(),
        ]);
    hide_console_window(&mut command);
    let output = command.output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(tailscale_status().await)
}

#[cfg(windows)]
fn hide_console_window(command: &mut tokio::process::Command) {
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut tokio::process::Command) {}

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

fn unique_projects(projects: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for value in projects {
        let mut value = value.trim().to_owned();
        while value.ends_with(['/', '\\'])
            && value != "/"
            && !(value.len() == 3 && value.as_bytes().get(1) == Some(&b':'))
        {
            value.pop();
        }
        if value.is_empty() {
            return Err("Invalid project path".into());
        }
        let key = value.replace('\\', "/");
        let duplicate = result.iter().any(|current: &String| {
            let current_key = current.replace('\\', "/");
            if cfg!(windows) { current_key.eq_ignore_ascii_case(&key) } else { current_key == key }
        });
        if !duplicate {
            result.push(value);
        }
    }
    Ok(result)
}

fn unique_customers(customers: Vec<ProjectCustomer>) -> Result<Vec<ProjectCustomer>, String> {
    let mut ids = std::collections::HashSet::new();
    let mut assigned_threads = std::collections::HashSet::new();
    let mut result = Vec::new();
    for mut customer in customers {
        customer.id = customer.id.trim().to_owned();
        customer.project_cwd = customer.project_cwd.trim().to_owned();
        if customer.project_cwd.len() > 3 {
            customer.project_cwd = customer.project_cwd.trim_end_matches(['/', '\\']).to_owned();
        }
        customer.name = customer.name.trim().to_owned();
        if customer.id.is_empty() || customer.name.is_empty() || customer.project_cwd.is_empty() {
            return Err("Customers need an id, name, and project".into());
        }
        if !ids.insert(customer.id.to_lowercase()) {
            return Err("Customer ids must be unique".into());
        }
        customer.thread_ids.retain(|id| !id.trim().is_empty() && assigned_threads.insert(id.clone()));
        result.push(customer);
    }
    Ok(result)
}

fn persist_config(path: &Path, config: &BoardConfig) -> Result<(), String> {
    crate::persistence::write_json(path, config)
}

fn save_board_config(
    state: &Arc<RwLock<BoardConfig>>,
    path: &Path,
    mut config: BoardConfig,
) -> Result<BoardConfig, String> {
    let mut current = state.write().map_err(|error| error.to_string())?;
    if config.customers.is_empty() && !current.customers.is_empty() {
        config.customers = current.customers.clone();
    }
    config.customers = unique_customers(config.customers)?;
    // Board/category writes must never replace a newer model preference.
    config.turn_settings = current.turn_settings.clone();
    config.revision = current.revision.saturating_add(1);
    persist_config(path, &config)?;
    *current = config.clone();
    Ok(config)
}

fn delete_customer_config(
    state: &Arc<RwLock<BoardConfig>>,
    path: &Path,
    customer_id: &str,
) -> Result<Option<BoardConfig>, String> {
    let mut current = state.write().map_err(|error| error.to_string())?;
    if !current.customers.iter().any(|customer| customer.id == customer_id) {
        return Ok(None);
    }
    let mut next = current.clone();
    next.customers.retain(|customer| customer.id != customer_id);
    next.revision = current.revision.saturating_add(1);
    persist_config(path, &next)?;
    *current = next.clone();
    Ok(Some(next))
}

fn save_turn_settings(
    state: &Arc<RwLock<BoardConfig>>,
    path: &Path,
    patch: TurnPreferencesPatch,
) -> Result<BoardConfig, String> {
    let mut current = state.write().map_err(|error| error.to_string())?;
    if patch.initialize_only && !current.turn_settings.model.is_empty() {
        return Ok(current.clone());
    }
    let mut config = current.clone();
    let settings = &mut config.turn_settings;
    if let Some(model) = patch.model { settings.model = model.trim().to_string(); }
    if let Some(effort) = patch.effort { settings.effort = effort; }
    if let Some(summary) = patch.summary { settings.summary = summary; }
    if let Some(tier) = patch.service_tier { settings.service_tier = tier; }
    config.revision = current.revision.saturating_add(1);
    persist_config(path, &config)?;
    *current = config.clone();
    Ok(config)
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

async fn get_image(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, ApiError> {
    authorized(&headers, &state)?;
    let path = query.get("path").ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "Missing image path".into()))?;
    let path = crate::local_paths::resolve_local_path(path)
        .map_err(|_| ApiError(StatusCode::NOT_FOUND, "Image not found".into()))?;
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif",
        "heic" => "image/heic", "heif" => "image/heif", "avif" => "image/avif", "bmp" => "image/bmp", "tiff" => "image/tiff",
        _ => return Err(ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Unsupported image type".into())),
    };
    let metadata = tokio::fs::metadata(&path).await.map_err(|_| ApiError(StatusCode::NOT_FOUND, "Image not found".into()))?;
    if !metadata.is_file() || metadata.len() > 24 * 1024 * 1024 {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "Image is too large".into()));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|_| ApiError(StatusCode::NOT_FOUND, "Image not found".into()))?;
    Ok((StatusCode::OK, [(axum::http::header::CONTENT_TYPE, content_type), (axum::http::header::CACHE_CONTROL, "private, max-age=3600")], bytes).into_response())
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
            if let Some(result) = automatic
                && state
                    .client
                    .respond_to_request(request_id.clone(), result)
                    .await
                    .is_ok()
            {
                state
                    .client
                    .emit_local_event("serverRequest/resolved", json!({ "requestId": request_id }))
                    .await;
                continue;
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
    Query(query): Query<ThreadPageQuery>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    let mut thread = if let (Some(limit), Some("items")) = (query.limit, query.unit.as_deref()) {
        if let Some(page) = state.client.load_thread_message_page(id.clone(), query.before, limit).await? { page }
        else {
            let mut full = state.client.load_thread(id).await?;
            paginate_thread_items(&mut full, query.before, limit)?;
            full
        }
    } else {
        let mut full = state.client.load_thread(id).await?;
        if let Some(limit) = query.limit { paginate_thread(&mut full, query.before, limit)?; }
        full
    };
    // The rollout path is internal to the PC and is not needed by the paired mobile client.
    thread["path"] = Value::Null;
    Ok(Json(thread))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadPageQuery {
    limit: Option<usize>,
    before: Option<usize>,
    unit: Option<String>,
}

fn paginate_thread_items(thread: &mut Value, before: Option<usize>, limit: usize) -> Result<(), ApiError> {
    let turns = thread.get("turns").and_then(Value::as_array)
        .ok_or_else(|| ApiError(StatusCode::BAD_GATEWAY, "Thread history is unavailable".into()))?;
    let total: usize = turns.iter().filter_map(|turn| turn.get("items").and_then(Value::as_array)).map(Vec::len).sum();
    let end = before.unwrap_or(total).min(total);
    let start = end.saturating_sub(limit.clamp(1, 20));
    let mut messages = Vec::with_capacity(end - start);
    let mut index = 0usize;
    let mut active_turn = None;
    for turn in turns {
        let turn_id = turn.get("id").cloned().unwrap_or(Value::Null);
        let status = turn.get("status").cloned().unwrap_or(Value::Null);
        if status.as_str() == Some("inProgress") {
            active_turn = Some(json!({ "id": turn_id, "status": status }));
        }
        if let Some(items) = turn.get("items").and_then(Value::as_array) {
            for item in items {
                if (start..end).contains(&index) {
                    messages.push(json!({ "index": index, "turnId": turn_id, "turnStatus": status, "item": item }));
                }
                index += 1;
            }
        }
    }
    thread["turns"] = json!([]);
    thread["messages"] = json!(messages);
    thread["activeTurn"] = active_turn.unwrap_or(Value::Null);
    thread["pagination"] = json!({ "unit": "items", "start": start, "total": total, "hasOlder": start > 0 });
    Ok(())
}

fn paginate_thread(thread: &mut Value, before: Option<usize>, limit: usize) -> Result<(), ApiError> {
    let turns = thread.get_mut("turns").and_then(Value::as_array_mut)
        .ok_or_else(|| ApiError(StatusCode::BAD_GATEWAY, "Thread history is unavailable".into()))?;
    let total = turns.len();
    let end = before.unwrap_or(total).min(total);
    let start = end.saturating_sub(limit.clamp(1, 20));
    *turns = turns[start..end].to_vec();
    thread["pagination"] = json!({ "start": start, "total": total, "hasOlder": start > 0 });
    Ok(())
}

async fn archive_thread(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    state.client.archive_thread(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rate_limits(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(state.client.rate_limits().await?))
}

async fn models(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(state.client.list_models().await?))
}

async fn create_thread(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<CreateThreadBody>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    let name = if body.category.trim().is_empty() || body.category == "Uncategorized" {
        body.title.trim().to_owned()
    } else {
        format!("{} - {}", body.category.trim(), body.title.trim())
    };
    let thread = state
        .client
        .create_thread(body.cwd, name, body.prompt, body.image_urls)
        .await?;
    serde_json::to_value(thread)
        .map(Json)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

async fn fork_thread(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ForkThreadBody>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    let name = if body.category.trim().is_empty() || body.category == "Uncategorized" {
        body.title.trim().to_owned()
    } else {
        format!("{} - {}", body.category.trim(), body.title.trim())
    };
    let thread = state
        .client
        .fork_thread(id, name, body.last_turn_id)
        .await?;
    serde_json::to_value(thread)
        .map(Json)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
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
    let mut image_urls = body.image_urls.unwrap_or_default();
    if let Some(image_url) = body.image_url { image_urls.insert(0, image_url); }
    Ok(Json(
        serde_json::to_value(state.coordinator.send_with_images(id, body.text, image_urls, body.settings).await?)
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

async fn compact_thread(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    Ok(Json(state.client.compact_thread(id).await?))
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
    config.projects = unique_projects(config.projects)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error))?;
    config.customers = unique_customers(config.customers)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error))?;
    if !matches!(config.approval_mode.as_str(), "auto" | "ask") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "approvalMode must be auto or ask".into(),
        ));
    }
    config = save_board_config(&state.config, &state.config_path, config)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
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

async fn delete_customer(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<BoardConfig>, ApiError> {
    authorized(&headers, &state)?;
    let config = delete_customer_config(&state.config, &state.config_path, &id)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Customer not found".into()))?;
    state.client.emit_local_event(
        "board/config/updated",
        serde_json::to_value(&config)
            .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
    ).await;
    Ok(Json(config))
}

async fn put_turn_settings(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(patch): Json<TurnPreferencesPatch>,
) -> Result<Json<BoardConfig>, ApiError> {
    authorized(&headers, &state)?;
    let config = save_turn_settings(&state.config, &state.config_path, patch)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    state.client.emit_local_event(
        "board/config/updated",
        serde_json::to_value(&config)
            .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?,
    ).await;
    Ok(Json(config))
}

async fn list_automations(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    serde_json::to_value(state.automations.list().await)
        .map(Json)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

async fn create_automation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<CreateAutomationInput>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    let automation = state
        .automations
        .create(input)
        .await
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error))?;
    serde_json::to_value(automation)
        .map(Json)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

async fn retry_automation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    state.automations.retry(&id).await.map_err(|error| ApiError(StatusCode::CONFLICT, error))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_automation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<CreateAutomationInput>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    let automation = state
        .automations
        .update(&id, input)
        .await
        .map_err(|error| {
            ApiError(
                if error == "Automation not found" {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                },
                error,
            )
        })?;
    serde_json::to_value(automation)
        .map(Json)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

async fn set_automation_enabled(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<AutomationEnabledInput>,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    let automation = state
        .automations
        .set_enabled(&id, input.enabled)
        .await
        .map_err(|error| ApiError(StatusCode::NOT_FOUND, error))?;
    serde_json::to_value(automation)
        .map(Json)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

async fn delete_automation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    if state
        .automations
        .delete(&id)
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError(
            StatusCode::NOT_FOUND,
            "Automation not found".into(),
        ))
    }
}

#[derive(Deserialize)]
struct ReadNotificationBody {
    id: Option<String>,
}

async fn list_notifications(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorized(&headers, &state)?;
    serde_json::to_value(state.notifications.list().await)
        .map(Json)
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

async fn mark_notifications_read(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<ReadNotificationBody>,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    state
        .notifications
        .mark_read(body.id.as_deref())
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_notifications(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    authorized(&headers, &state)?;
    state
        .notifications
        .clear()
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(StatusCode::NO_CONTENT)
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
    use std::{
        sync::Barrier,
        time::{SystemTime, UNIX_EPOCH},
    };

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
    fn project_paths_are_trimmed_and_deduplicated() {
        assert_eq!(
            unique_projects(vec![" C:\\work\\demo\\ ".into(), "C:\\work\\demo".into()]).unwrap(),
            vec!["C:\\work\\demo"]
        );
    }

    #[test]
    fn new_board_defaults_to_auto_approval() {
        assert_eq!(BoardConfig::default().approval_mode, "auto");
        assert_eq!(BoardConfig::default().turn_settings.summary, "auto");
    }

    #[test]
    fn legacy_board_config_gets_default_turn_settings() {
        let config: BoardConfig = serde_json::from_value(json!({
            "categories": ["WIP"], "projects": [], "approvalMode": "ask", "revision": 2
        })).unwrap();
        assert!(config.turn_settings.model.is_empty());
        assert_eq!(config.turn_settings.summary, "auto");
        assert!(config.customers.is_empty());
    }

    #[test]
    fn customer_assignments_are_validated_and_unique() {
        let customers = unique_customers(vec![
            ProjectCustomer { id: " client-a ".into(), project_cwd: " C:\\work\\demo\\ ".into(), name: " Acme ".into(), thread_ids: vec!["thread-1".into(), "thread-2".into()] },
            ProjectCustomer { id: "client-b".into(), project_cwd: "C:\\work\\demo".into(), name: "Other".into(), thread_ids: vec!["thread-2".into(), "thread-3".into()] },
        ]).unwrap();
        assert_eq!(customers[0].id, "client-a");
        assert_eq!(customers[0].project_cwd, "C:\\work\\demo");
        assert_eq!(customers[0].name, "Acme");
        assert_eq!(customers[0].thread_ids, vec!["thread-1", "thread-2"]);
        assert_eq!(customers[1].thread_ids, vec!["thread-3"]);
        assert!(unique_customers(vec![ProjectCustomer { id: "".into(), project_cwd: "C:\\work".into(), name: "Acme".into(), thread_ids: vec![] }]).is_err());
    }

    #[test]
    fn thread_pagination_returns_the_last_ten_turns_and_older_windows() {
        let turns: Vec<Value> = (0..27).map(|index| json!({ "id": format!("turn-{index}") })).collect();
        let mut latest = json!({ "turns": turns });
        paginate_thread(&mut latest, None, 10).unwrap();
        assert_eq!(latest["pagination"]["start"], 17);
        assert_eq!(latest["turns"][0]["id"], "turn-17");
        assert_eq!(latest["turns"][9]["id"], "turn-26");
        let mut older = json!({ "turns": (0..27).map(|index| json!({ "id": format!("turn-{index}") })).collect::<Vec<_>>() });
        paginate_thread(&mut older, Some(17), 10).unwrap();
        assert_eq!(older["pagination"]["start"], 7);
        assert_eq!(older["turns"][0]["id"], "turn-7");
        assert_eq!(older["turns"][9]["id"], "turn-16");
    }

    #[test]
    fn mobile_item_pagination_returns_only_ten_timeline_entries_per_page() {
        let turns: Vec<Value> = (0..4).map(|turn| json!({
            "id": format!("turn-{turn}"),
            "status": if turn == 3 { "inProgress" } else { "completed" },
            "items": (0..8).map(|item| json!({ "id": format!("item-{turn}-{item}"), "type": "agentMessage", "text": "x" })).collect::<Vec<_>>()
        })).collect();
        let mut latest = json!({ "turns": turns });
        paginate_thread_items(&mut latest, None, 10).unwrap();
        assert_eq!(latest["messages"].as_array().unwrap().len(), 10);
        assert_eq!(latest["pagination"]["start"], 22);
        assert_eq!(latest["pagination"]["total"], 32);
        assert_eq!(latest["messages"][0]["item"]["id"], "item-2-6");
        assert_eq!(latest["activeTurn"]["id"], "turn-3");
        assert_eq!(latest["turns"].as_array().unwrap().len(), 0);

        let mut older = json!({ "turns": (0..4).map(|turn| json!({
            "id": format!("turn-{turn}"), "status": "completed",
            "items": (0..8).map(|item| json!({ "id": format!("item-{turn}-{item}"), "type": "userMessage" })).collect::<Vec<_>>()
        })).collect::<Vec<_>>() });
        paginate_thread_items(&mut older, Some(22), 10).unwrap();
        assert_eq!(older["pagination"]["start"], 12);
        assert_eq!(older["messages"][0]["item"]["id"], "item-1-4");
        assert_eq!(older["pagination"]["hasOlder"], true);
    }

    #[test]
    fn deleting_last_customer_persists_empty_customer_list() {
        let directory = std::env::temp_dir().join(format!(
            "codex-board-delete-customer-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let gateway = RemoteGateway::prepare(&directory).unwrap();
        let mut config = gateway.board_config();
        config.customers = vec![ProjectCustomer {
            id: "customer-1".into(),
            project_cwd: "C:\\work\\demo".into(),
            name: "Acme".into(),
            thread_ids: vec!["thread-1".into()],
        }];
        gateway.set_board_config(config).unwrap();

        let saved = gateway.delete_customer("customer-1").unwrap();
        assert!(saved.customers.is_empty());
        assert!(gateway.board_config().customers.is_empty());
        let disk: BoardConfig = crate::persistence::load_json_or_default(&directory.join("board-config.json"));
        assert!(disk.customers.is_empty());
        assert!(gateway.delete_customer("customer-1").is_err());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn turn_settings_patches_preserve_board_and_other_preferences() {
        let directory = std::env::temp_dir().join(format!("codex-board-settings-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let gateway = RemoteGateway::prepare(&directory).unwrap();
        let mut stale_board = gateway.board_config();
        stale_board.categories = vec!["Review".into()];
        gateway.set_turn_settings(serde_json::from_value(json!({
            "model": "desktop-model", "effort": "high", "serviceTier": "priority"
        })).unwrap()).unwrap();
        gateway.set_board_config(stale_board).unwrap();
        let saved = gateway.set_turn_settings(serde_json::from_value(json!({ "effort": "", "serviceTier": "" })).unwrap()).unwrap();
        assert_eq!(saved.categories, vec!["Review"]);
        assert_eq!(saved.turn_settings.model, "desktop-model");
        assert_eq!(saved.turn_settings.effort, "");
        assert_eq!(saved.turn_settings.service_tier, "");
        let migrated = gateway.set_turn_settings(serde_json::from_value(json!({
            "initializeOnly": true, "model": "stale-desktop-cache", "effort": "high"
        })).unwrap()).unwrap();
        assert_eq!(migrated.turn_settings.model, "desktop-model");
        assert_eq!(migrated.turn_settings.effort, "");
        let barrier = Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut stale = gateway.board_config();
                stale.categories = vec!["Concurrent review".into()];
                barrier.wait();
                gateway.set_board_config(stale).unwrap();
            });
            scope.spawn(|| {
                barrier.wait();
                gateway.set_turn_settings(serde_json::from_value(json!({ "summary": "concise" })).unwrap()).unwrap();
            });
        });
        let disk: BoardConfig = crate::persistence::load_json_or_default(&directory.join("board-config.json"));
        assert_eq!(disk.turn_settings.model, "desktop-model");
        assert_eq!(disk.categories, vec!["Concurrent review"]);
        assert_eq!(disk.turn_settings.summary, "concise");
        assert_eq!(serde_json::to_value(&disk).unwrap()["turnSettings"]["serviceTier"], "");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn automatic_approval_never_answers_user_questions() {
        assert!(automatic_approval("item/tool/requestUserInput", &json!({})).is_none());
        assert_eq!(
            automatic_approval("item/commandExecution/requestApproval", &json!({})).unwrap()["decision"],
            "acceptForSession"
        );
    }

    #[test]
    fn concurrent_board_updates_share_one_persistence_lock() {
        let directory = std::env::temp_dir().join(format!(
            "codex-board-config-race-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let gateway = Arc::new(RemoteGateway::prepare(&directory).unwrap());
        let barrier = Arc::new(Barrier::new(3));
        let workers = ["WIP", "Done"].map(|category| {
            let gateway = gateway.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                gateway.set_board_config(BoardConfig {
                    categories: vec![category.into()],
                    projects: vec!["C:\\work\\demo".into()],
                    customers: Vec::new(),
                    approval_mode: "auto".into(),
                    turn_settings: TurnPreferences::default(),
                    revision: 0,
                })
            })
        });
        barrier.wait();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert_eq!(gateway.board_config().revision, 2);
        assert_eq!(
            crate::persistence::load_json_or_default::<BoardConfig>(
                &directory.join("board-config.json")
            )
            .revision,
            2
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
