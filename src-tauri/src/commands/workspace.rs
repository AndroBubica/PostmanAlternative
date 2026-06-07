use crate::workspace;

#[tauri::command]
pub fn load_workspace(app: tauri::AppHandle) -> Result<workspace::WorkspaceSnapshot, String> {
    workspace::load(&app)
}

#[tauri::command]
pub fn save_workspace_request(
    app: tauri::AppHandle,
    request: workspace::SavedRequest,
) -> Result<(), String> {
    workspace::save_request(&app, &request)
}

#[tauri::command]
pub fn delete_workspace_request(app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    workspace::delete_request(&app, &request_id)
}

#[tauri::command]
pub fn create_workspace_collection(
    app: tauri::AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<workspace::Collection, String> {
    workspace::create_collection(&app, &name, parent_id)
}

#[tauri::command]
pub fn save_workspace_collection(
    app: tauri::AppHandle,
    collection: workspace::Collection,
) -> Result<(), String> {
    workspace::save_collection(&app, &collection)
}

#[tauri::command]
pub fn delete_workspace_collection(
    app: tauri::AppHandle,
    collection_id: String,
) -> Result<workspace::DeletedCollectionSnapshot, String> {
    workspace::delete_collection(&app, &collection_id)
}

#[tauri::command]
pub fn restore_workspace_collection(
    app: tauri::AppHandle,
    snapshot: workspace::DeletedCollectionSnapshot,
) -> Result<(), String> {
    workspace::restore_collection(&app, &snapshot)
}

#[tauri::command]
pub fn save_workspace_environment(
    app: tauri::AppHandle,
    environment: workspace::Environment,
) -> Result<(), String> {
    workspace::save_environment(&app, &environment)
}

#[tauri::command]
pub fn delete_workspace_environment(
    app: tauri::AppHandle,
    environment_id: String,
) -> Result<(), String> {
    workspace::delete_environment(&app, &environment_id)
}

#[tauri::command]
pub fn save_workspace_settings(
    app: tauri::AppHandle,
    settings: workspace::WorkspaceSettings,
) -> Result<(), String> {
    workspace::save_settings(&app, &settings)
}

#[tauri::command]
pub fn save_workspace_globals(
    app: tauri::AppHandle,
    variables: Vec<workspace::Variable>,
) -> Result<(), String> {
    workspace::save_globals(&app, &variables)
}

#[tauri::command]
pub fn add_workspace_history(
    app: tauri::AppHandle,
    entry: workspace::HistoryEntry,
) -> Result<(), String> {
    workspace::add_history(&app, &entry)
}

#[tauri::command]
pub fn import_workspace_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<workspace::ImportResult, String> {
    workspace::import_file(&app, &path)
}

#[tauri::command]
pub fn export_portable_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    workspace::export_portable(&app, &path)
}
