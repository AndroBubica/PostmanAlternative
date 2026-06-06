use reqwest::{header::HeaderName, Method};
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Deserialize)]
struct RequestHeader {
    name: String,
    value: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct ApiRequest {
    method: String,
    url: String,
    headers: Vec<RequestHeader>,
    body: Option<String>,
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

#[tauri::command]
async fn send_request(request: ApiRequest) -> Result<ApiResponse, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {}", request.method))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| error.to_string())?;

    let mut builder = client.request(method, &request.url);
    for header in request.headers.into_iter().filter(|header| header.enabled) {
        let name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|_| format!("Invalid header name: {}", header.name))?;
        builder = builder.header(name, header.value);
    }
    if let Some(body) = request.body {
        if !body.is_empty() {
            builder = builder.body(body);
        }
    }

    let started = Instant::now();
    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| ResponseHeader {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<binary value>").to_string(),
        })
        .collect();
    let body = response.text().await.map_err(|error| error.to_string())?;

    Ok(ApiResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("Unknown").to_string(),
        elapsed_ms: started.elapsed().as_millis(),
        size_bytes: body.len(),
        headers,
        body,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![send_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
