mod automations;
mod codex;
mod notifications;
mod persistence;
mod remote;

use automations::{Automation, AutomationEnabledInput, AutomationStore, CreateAutomationInput};
use codex::{
    CodexClient, CodexErrorDto, CodexEventDto, QueuedMessage, SendOutcome, ThreadDto,
    TurnCoordinator,
};
use notifications::{BoardNotification, NotificationStore};
use remote::{BoardConfig, GatewayInfo, RemoteGateway, TailscaleInfo};
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
async fn list_threads(
    client: tauri::State<'_, Arc<CodexClient>>,
) -> Result<Vec<ThreadDto>, CodexErrorDto> {
    client.list_threads().await
}

#[tauri::command]
async fn rename_thread(
    client: tauri::State<'_, Arc<CodexClient>>,
    thread_id: String,
    new_name: String,
) -> Result<ThreadDto, CodexErrorDto> {
    client.rename_thread(thread_id, new_name).await
}

#[tauri::command]
async fn create_thread(
    client: tauri::State<'_, Arc<CodexClient>>,
    cwd: String,
    category: String,
    title: String,
    prompt: String,
) -> Result<ThreadDto, CodexErrorDto> {
    let name = if category.trim().is_empty() || category == "Uncategorized" {
        title.trim().to_owned()
    } else {
        format!("{} - {}", category.trim(), title.trim())
    };
    client.create_thread(cwd, name, prompt).await
}

#[tauri::command]
async fn load_thread(
    client: tauri::State<'_, Arc<CodexClient>>,
    thread_id: String,
) -> Result<Value, CodexErrorDto> {
    client.load_thread(thread_id).await
}

#[tauri::command]
async fn send_message(
    coordinator: tauri::State<'_, Arc<TurnCoordinator>>,
    thread_id: String,
    text: String,
) -> Result<SendOutcome, CodexErrorDto> {
    coordinator.send(thread_id, text).await
}

#[tauri::command]
async fn message_queues(
    coordinator: tauri::State<'_, Arc<TurnCoordinator>>,
) -> Result<std::collections::HashMap<String, Vec<QueuedMessage>>, String> {
    Ok(coordinator.queues().await)
}

#[tauri::command]
async fn remove_queued_message(
    coordinator: tauri::State<'_, Arc<TurnCoordinator>>,
    thread_id: String,
    message_id: String,
) -> Result<bool, String> {
    Ok(coordinator.remove(&thread_id, &message_id).await)
}

#[tauri::command]
async fn interrupt_turn(
    client: tauri::State<'_, Arc<CodexClient>>,
    thread_id: String,
    turn_id: String,
) -> Result<(), CodexErrorDto> {
    client.interrupt_turn(thread_id, turn_id).await
}

#[tauri::command]
async fn drain_codex_events(
    client: tauri::State<'_, Arc<CodexClient>>,
) -> Result<Vec<CodexEventDto>, CodexErrorDto> {
    Ok(client.drain_events().await)
}

#[tauri::command]
async fn respond_to_codex_request(
    client: tauri::State<'_, Arc<CodexClient>>,
    request_id: Value,
    result: Value,
) -> Result<(), CodexErrorDto> {
    client.respond_to_request(request_id, result).await
}

#[tauri::command]
fn gateway_info(gateway: tauri::State<'_, RemoteGateway>) -> GatewayInfo {
    gateway.info()
}

#[tauri::command]
fn get_board_config(gateway: tauri::State<'_, RemoteGateway>) -> BoardConfig {
    gateway.board_config()
}

#[tauri::command]
async fn set_board_config(
    gateway: tauri::State<'_, RemoteGateway>,
    client: tauri::State<'_, Arc<CodexClient>>,
    config: BoardConfig,
) -> Result<BoardConfig, String> {
    let saved = gateway.set_board_config(config)?;
    client
        .emit_local_event(
            "board/config/updated",
            serde_json::to_value(&saved).map_err(|error| error.to_string())?,
        )
        .await;
    Ok(saved)
}

#[tauri::command]
async fn tailscale_status() -> TailscaleInfo {
    remote::tailscale_status().await
}

#[tauri::command]
async fn configure_tailscale_serve() -> Result<TailscaleInfo, String> {
    remote::configure_tailscale_serve().await
}

#[tauri::command]
async fn list_automations(
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<Vec<Automation>, String> {
    Ok(store.list().await)
}

#[tauri::command]
async fn create_automation(
    store: tauri::State<'_, Arc<AutomationStore>>,
    input: CreateAutomationInput,
) -> Result<Automation, String> {
    store.create(input).await
}

#[tauri::command]
async fn set_automation_enabled(
    store: tauri::State<'_, Arc<AutomationStore>>,
    id: String,
    input: AutomationEnabledInput,
) -> Result<Automation, String> {
    store.set_enabled(&id, input.enabled).await
}

#[tauri::command]
async fn delete_automation(
    store: tauri::State<'_, Arc<AutomationStore>>,
    id: String,
) -> Result<bool, String> {
    store.delete(&id).await
}

#[tauri::command]
async fn list_notifications(
    store: tauri::State<'_, Arc<NotificationStore>>,
) -> Result<Vec<BoardNotification>, String> {
    Ok(store.list().await)
}
#[tauri::command]
async fn mark_notifications_read(
    store: tauri::State<'_, Arc<NotificationStore>>,
    id: Option<String>,
) -> Result<(), String> {
    store.mark_read(id.as_deref()).await
}
#[tauri::command]
async fn clear_notifications(
    store: tauri::State<'_, Arc<NotificationStore>>,
) -> Result<(), String> {
    store.clear().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = Arc::new(CodexClient::new());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(client.clone())
        .setup(move |app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let coordinator =
                TurnCoordinator::new(client.clone(), directory.join("message-queues.json"));
            coordinator.start();
            let automations = AutomationStore::new(
                directory.join("automations.json"),
                client.clone(),
                coordinator.clone(),
            );
            automations.start();
            let notifications =
                NotificationStore::new(directory.join("notifications.json"), client.clone());
            let gateway = RemoteGateway::prepare(&directory).map_err(|error| {
                std::io::Error::other(format!("Could not prepare remote gateway: {error}"))
            })?;
            gateway.start(
                client.clone(),
                coordinator.clone(),
                automations.clone(),
                notifications.clone(),
            );
            app.manage(coordinator);
            app.manage(automations);
            app.manage(notifications);
            app.manage(gateway);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_threads,
            rename_thread,
            create_thread,
            load_thread,
            send_message,
            message_queues,
            remove_queued_message,
            interrupt_turn,
            drain_codex_events,
            respond_to_codex_request,
            gateway_info,
            get_board_config,
            set_board_config,
            tailscale_status,
            configure_tailscale_serve,
            list_automations,
            create_automation,
            set_automation_enabled,
            delete_automation,
            list_notifications,
            mark_notifications_read,
            clear_notifications
        ])
        .build(tauri::generate_context!())
        .expect("error while building Codex Board");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            app_handle
                .state::<Arc<CodexClient>>()
                .shutdown_best_effort();
        }
    });
}
