use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{header::HeaderName, multipart, Method};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

mod vault;
pub mod workspace;

#[derive(Default)]
struct RequestState {
    cancellations: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Default)]
struct VaultState {
    unlocked: Mutex<Option<(String, HashMap<String, String>)>>,
}

#[derive(Deserialize)]
struct RequestHeader {
    name: String,
    value: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum MultipartFieldKind {
    Text,
    File,
}

#[derive(Deserialize)]
struct MultipartField {
    name: String,
    value: String,
    enabled: bool,
    kind: MultipartFieldKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum RequestBodyKind {
    Text,
    Multipart,
    Binary,
}

#[derive(Deserialize)]
struct ApiRequest {
    id: String,
    method: String,
    url: String,
    headers: Vec<RequestHeader>,
    body_kind: RequestBodyKind,
    body: Option<String>,
    multipart_fields: Vec<MultipartField>,
    binary_file: Option<String>,
    timeout_ms: u64,
    follow_redirects: bool,
}

#[derive(Serialize)]
struct ResponseHeader {
    name: String,
    value: String,
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    status_text: String,
    elapsed_ms: u128,
    size_bytes: usize,
    headers: Vec<ResponseHeader>,
    body: String,
    body_base64: String,
    content_type: String,
}

fn describe_request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Request timed out. Increase the timeout or check whether the server is responding."
            .to_string()
    } else if error.is_connect() {
        format!("Could not connect to the server. Check the URL, network, DNS, and TLS settings. ({error})")
    } else if error.is_redirect() {
        format!("The request could not follow the server redirect. ({error})")
    } else if error.is_request() {
        format!("The request could not be built or sent. ({error})")
    } else {
        format!("The response could not be read. ({error})")
    }
}

#[tauri::command]
async fn send_request(
    app: tauri::AppHandle,
    request: ApiRequest,
    state: tauri::State<'_, RequestState>,
) -> Result<ApiResponse, String> {
    let log_method = request.method.clone();
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {}", request.method))?;
    let redirect_policy = if request.follow_redirects {
        reqwest::redirect::Policy::limited(10)
    } else {
        reqwest::redirect::Policy::none()
    };
    let client = reqwest::Client::builder()
        .redirect(redirect_policy)
        .timeout(Duration::from_millis(request.timeout_ms.max(1)))
        .build()
        .map_err(|error| error.to_string())?;

    let mut builder = client.request(method, &request.url);
    for header in request.headers.into_iter().filter(|header| header.enabled) {
        let name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|_| format!("Invalid header name: {}", header.name))?;
        builder = builder.header(name, header.value);
    }
    match request.body_kind {
        RequestBodyKind::Multipart => {
            let mut form = multipart::Form::new();
            for field in request
                .multipart_fields
                .into_iter()
                .filter(|field| field.enabled && !field.name.is_empty())
            {
                form = match field.kind {
                    MultipartFieldKind::Text => form.text(field.name, field.value),
                    MultipartFieldKind::File => {
                        let bytes = tokio::fs::read(&field.value).await.map_err(|error| {
                            format!("Could not read multipart file '{}'. ({error})", field.value)
                        })?;
                        let file_name = std::path::Path::new(&field.value)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("file")
                            .to_string();
                        form.part(
                            field.name,
                            multipart::Part::bytes(bytes).file_name(file_name),
                        )
                    }
                };
            }
            builder = builder.multipart(form);
        }
        RequestBodyKind::Binary => {
            let path = request
                .binary_file
                .ok_or_else(|| "Choose a binary file before sending the request.".to_string())?;
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| format!("Could not read binary file '{path}'. ({error})"))?;
            builder = builder.body(bytes);
        }
        RequestBodyKind::Text => {
            if let Some(body) = request.body {
                if !body.is_empty() {
                    builder = builder.body(body);
                }
            }
        }
    }

    let request_id = request.id;
    let (cancel_sender, cancel_receiver) = oneshot::channel();
    state
        .cancellations
        .lock()
        .map_err(|_| "Could not track the request.".to_string())?
        .insert(request_id.clone(), cancel_sender);

    let started = Instant::now();
    let request_future = async {
        let response = builder.send().await.map_err(describe_request_error)?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| ResponseHeader {
                name: name.to_string(),
                value: value.to_str().unwrap_or("<binary value>").to_string(),
            })
            .collect();
        let bytes = response.bytes().await.map_err(describe_request_error)?;
        let body = String::from_utf8_lossy(&bytes).into_owned();
        let body_base64 = BASE64.encode(&bytes);

        Ok(ApiResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("Unknown").to_string(),
            elapsed_ms: started.elapsed().as_millis(),
            size_bytes: bytes.len(),
            headers,
            body,
            body_base64,
            content_type,
        })
    };
    let result = tokio::select! {
        response = request_future => response,
        _ = cancel_receiver => Err("Request cancelled.".to_string()),
    };

    if let Ok(mut cancellations) = state.cancellations.lock() {
        cancellations.remove(&request_id);
    }
    let event = match &result {
        Ok(response) => format!(
            "request method={} status={} elapsed_ms={} response_bytes={}",
            log_method, response.status, response.elapsed_ms, response.size_bytes
        ),
        Err(_) => format!("request method={} error=request_failed", log_method),
    };
    let _ = workspace::append_log(&app, &event);
    result
}

#[tauri::command]
async fn save_response(path: String, body_base64: String) -> Result<(), String> {
    let bytes = BASE64
        .decode(body_base64)
        .map_err(|error| format!("Could not decode the response body. ({error})"))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| format!("Could not save the response to '{path}'. ({error})"))
}

#[tauri::command]
async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|error| format!("Could not save the report to '{path}'. ({error})"))
}

#[tauri::command]
fn cancel_request(request_id: String, state: tauri::State<'_, RequestState>) -> Result<(), String> {
    let sender = state
        .cancellations
        .lock()
        .map_err(|_| "Could not cancel the request.".to_string())?
        .remove(&request_id);
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
fn load_workspace(app: tauri::AppHandle) -> Result<workspace::WorkspaceSnapshot, String> {
    workspace::load(&app)
}

#[tauri::command]
fn save_workspace_request(
    app: tauri::AppHandle,
    request: workspace::SavedRequest,
) -> Result<(), String> {
    workspace::save_request(&app, &request)
}

#[tauri::command]
fn delete_workspace_request(app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    workspace::delete_request(&app, &request_id)
}

#[tauri::command]
fn create_workspace_collection(
    app: tauri::AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<workspace::Collection, String> {
    workspace::create_collection(&app, &name, parent_id)
}

#[tauri::command]
fn save_workspace_collection(
    app: tauri::AppHandle,
    collection: workspace::Collection,
) -> Result<(), String> {
    workspace::save_collection(&app, &collection)
}

#[tauri::command]
fn delete_workspace_collection(app: tauri::AppHandle, collection_id: String) -> Result<(), String> {
    workspace::delete_collection(&app, &collection_id)
}

#[tauri::command]
fn save_workspace_environment(
    app: tauri::AppHandle,
    environment: workspace::Environment,
) -> Result<(), String> {
    workspace::save_environment(&app, &environment)
}

#[tauri::command]
fn save_workspace_settings(
    app: tauri::AppHandle,
    settings: workspace::WorkspaceSettings,
) -> Result<(), String> {
    workspace::save_settings(&app, &settings)
}

#[tauri::command]
fn save_workspace_globals(
    app: tauri::AppHandle,
    variables: Vec<workspace::Variable>,
) -> Result<(), String> {
    workspace::save_globals(&app, &variables)
}

fn vault_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(workspace::workspace_root(app)?
        .0
        .join("private/secrets.enc"))
}

#[tauri::command]
fn unlock_vault(
    app: tauri::AppHandle,
    password: String,
    state: tauri::State<'_, VaultState>,
) -> Result<HashMap<String, String>, String> {
    let entries = vault::load(&vault_path(&app)?, &password)?;
    *state
        .unlocked
        .lock()
        .map_err(|_| "Could not unlock vault.".to_string())? = Some((password, entries.clone()));
    Ok(entries)
}

#[tauri::command]
fn save_vault(
    app: tauri::AppHandle,
    entries: HashMap<String, String>,
    state: tauri::State<'_, VaultState>,
) -> Result<(), String> {
    let mut unlocked = state
        .unlocked
        .lock()
        .map_err(|_| "Could not save vault.".to_string())?;
    let password = unlocked
        .as_ref()
        .map(|value| value.0.clone())
        .ok_or("Unlock the vault first.")?;
    vault::save(&vault_path(&app)?, &password, &entries)?;
    *unlocked = Some((password, entries));
    Ok(())
}

#[tauri::command]
fn lock_vault(state: tauri::State<'_, VaultState>) -> Result<(), String> {
    *state
        .unlocked
        .lock()
        .map_err(|_| "Could not lock vault.".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn add_workspace_history(
    app: tauri::AppHandle,
    entry: workspace::HistoryEntry,
) -> Result<(), String> {
    workspace::add_history(&app, &entry)
}

#[tauri::command]
fn import_workspace_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<workspace::ImportResult, String> {
    workspace::import_file(&app, &path)
}

#[tauri::command]
fn export_portable_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    workspace::export_portable(&app, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RequestState::default())
        .manage(VaultState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            send_request,
            cancel_request,
            save_response,
            save_text_file,
            load_workspace,
            save_workspace_request,
            delete_workspace_request,
            create_workspace_collection,
            save_workspace_collection,
            delete_workspace_collection,
            save_workspace_environment,
            save_workspace_settings,
            save_workspace_globals,
            unlock_vault,
            save_vault,
            lock_vault,
            add_workspace_history,
            import_workspace_file,
            export_portable_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
