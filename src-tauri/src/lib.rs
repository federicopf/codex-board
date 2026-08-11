mod codex;

use codex::{CodexClient, CodexErrorDto, ThreadDto};
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
) -> Result<(), CodexErrorDto> {
    client.rename_thread(thread_id, new_name).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(CodexClient::new())
        .invoke_handler(tauri::generate_handler![list_threads, rename_thread])
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
