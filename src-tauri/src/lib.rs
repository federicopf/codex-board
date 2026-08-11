mod codex;

use codex::{CodexClient, CodexErrorDto, CodexEventDto, ThreadDto};
use serde_json::Value;
use tauri::Manager;

#[tauri::command]
async fn list_threads(
    client: tauri::State<'_, CodexClient>,
) -> Result<Vec<ThreadDto>, CodexErrorDto> {
    client.list_threads().await
}

#[tauri::command]
async fn rename_thread(
    client: tauri::State<'_, CodexClient>,
    thread_id: String,
    new_name: String,
) -> Result<ThreadDto, CodexErrorDto> {
    client.rename_thread(thread_id, new_name).await
}

#[tauri::command]
async fn load_thread(
    client: tauri::State<'_, CodexClient>,
    thread_id: String,
) -> Result<Value, CodexErrorDto> {
    client.load_thread(thread_id).await
}

#[tauri::command]
async fn send_message(
    client: tauri::State<'_, CodexClient>,
    thread_id: String,
    text: String,
) -> Result<Value, CodexErrorDto> {
    client.send_message(thread_id, text).await
}

#[tauri::command]
async fn interrupt_turn(
    client: tauri::State<'_, CodexClient>,
    thread_id: String,
    turn_id: String,
) -> Result<(), CodexErrorDto> {
    client.interrupt_turn(thread_id, turn_id).await
}

#[tauri::command]
async fn drain_codex_events(
    client: tauri::State<'_, CodexClient>,
) -> Result<Vec<CodexEventDto>, CodexErrorDto> {
    Ok(client.drain_events().await)
}

#[tauri::command]
async fn respond_to_codex_request(
    client: tauri::State<'_, CodexClient>,
    request_id: Value,
    result: Value,
) -> Result<(), CodexErrorDto> {
    client.respond_to_request(request_id, result).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(CodexClient::new())
        .invoke_handler(tauri::generate_handler![
            list_threads,
            rename_thread,
            load_thread,
            send_message,
            interrupt_turn,
            drain_codex_events,
            respond_to_codex_request
        ])
        .build(tauri::generate_context!())
        .expect("error while building Codex Board");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            app_handle.state::<CodexClient>().shutdown_best_effort();
        }
    });
}
