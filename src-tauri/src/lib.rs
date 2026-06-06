use reqwest::{header::HeaderName, multipart, Method};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[derive(Default)]
struct RequestState {
    cancellations: Mutex<HashMap<String, oneshot::Sender<()>>>,
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
    request: ApiRequest,
    state: tauri::State<'_, RequestState>,
) -> Result<ApiResponse, String> {
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
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| ResponseHeader {
                name: name.to_string(),
                value: value.to_str().unwrap_or("<binary value>").to_string(),
            })
            .collect();
        let body = response.text().await.map_err(describe_request_error)?;

        Ok(ApiResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("Unknown").to_string(),
            elapsed_ms: started.elapsed().as_millis(),
            size_bytes: body.len(),
            headers,
            body,
        })
    };
    let result = tokio::select! {
        response = request_future => response,
        _ = cancel_receiver => Err("Request cancelled.".to_string()),
    };

    if let Ok(mut cancellations) = state.cancellations.lock() {
        cancellations.remove(&request_id);
    }
    result
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RequestState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![send_request, cancel_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
