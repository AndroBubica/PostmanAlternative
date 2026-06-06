use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const HISTORY_LIMIT: usize = 100;

#[derive(Clone, Deserialize, Serialize)]
pub struct KeyValueRow {
    pub id: f64,
    pub name: String,
    pub value: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequest {
    pub id: String,
    pub collection_id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub params: Vec<KeyValueRow>,
    pub headers: Vec<KeyValueRow>,
    pub body: String,
    pub body_mode: String,
    pub form_rows: Vec<KeyValueRow>,
    pub multipart_rows: Vec<KeyValueRow>,
    pub binary_file: String,
    pub auth_type: String,
    pub auth_fields: Value,
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    #[serde(default)]
    pub favorite: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub secret: bool,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub variables: Vec<Variable>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub request_id: Option<String>,
    pub name: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u128>,
    pub created_at: u64,
}

#[derive(Serialize)]
pub struct WorkspaceSnapshot {
    pub root: String,
    pub portable: bool,
    pub collections: Vec<Collection>,
    pub requests: Vec<SavedRequest>,
    pub environments: Vec<Environment>,
    pub history: Vec<HistoryEntry>,
}

#[derive(Serialize)]
pub struct ImportResult {
    pub message: String,
    pub imported_requests: usize,
    pub imported_environments: usize,
}

fn enabled() -> bool {
    true
}

fn slug(value: &str) -> String {
    let result = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if result.is_empty() {
        unique_id("item")
    } else {
        result
    }
}

fn unique_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{nanos}")
}

fn workspace_root(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the application. ({error})"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "Could not locate the application folder.".to_string())?;
    let portable_root = executable_dir
        .parent()
        .filter(|path| path.join("portable.flag").exists())
        .unwrap_or(executable_dir);
    let portable = executable_dir.join("portable.flag").exists()
        || portable_root.join("portable.flag").exists();
    let root = if portable {
        portable_root.join("workspace")
    } else {
        app.path()
            .app_data_dir()
            .map_err(|error| format!("Could not locate local application data. ({error})"))?
            .join("workspace")
    };
    Ok((root, portable))
}

fn ensure_workspace(root: &Path) -> Result<(), String> {
    for directory in [
        "collections",
        "requests",
        "environments",
        "history",
        "private",
    ] {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("Could not create workspace folder. ({error})"))?;
    }
    let manifest = root.join("api-lantern.json");
    if !manifest.exists() {
        atomic_json(
            &manifest,
            &json!({"format": "api-lantern-workspace", "version": 1}),
        )?;
    }
    let default_collection = root.join("collections/default.json");
    if !default_collection.exists() {
        atomic_json(
            &default_collection,
            &Collection {
                id: "default".into(),
                name: "My requests".into(),
            },
        )?;
    }
    Ok(())
}

fn atomic_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid workspace path.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Could not create folder. ({error})"))?;
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not encode workspace data. ({error})"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write workspace data. ({error})"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not finish workspace write. ({error})"))
}

fn read_json_files<T: for<'de> Deserialize<'de>>(directory: &Path) -> Vec<T> {
    let mut values = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect::<Vec<_>>();
    values.shrink_to_fit();
    values
}

pub fn load(app: &AppHandle) -> Result<WorkspaceSnapshot, String> {
    let (root, portable) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let mut collections = read_json_files(&root.join("collections"));
    let mut requests = read_json_files(&root.join("requests"));
    let mut environments = read_json_files(&root.join("environments"));
    let mut history = read_json_files(&root.join("history"));
    collections.sort_by(|a: &Collection, b| a.name.cmp(&b.name));
    requests.sort_by(|a: &SavedRequest, b| a.name.cmp(&b.name));
    environments.sort_by(|a: &Environment, b| a.name.cmp(&b.name));
    history.sort_by(|a: &HistoryEntry, b| b.created_at.cmp(&a.created_at));
    history.truncate(HISTORY_LIMIT);
    Ok(WorkspaceSnapshot {
        root: root.to_string_lossy().into_owned(),
        portable,
        collections,
        requests,
        environments,
        history,
    })
}

pub fn save_request(app: &AppHandle, request: &SavedRequest) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    atomic_json(
        &root.join("requests").join(format!("{}.json", request.id)),
        request,
    )
}

pub fn delete_request(app: &AppHandle, request_id: &str) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    let path = root.join("requests").join(format!("{request_id}.json"));
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("Could not delete request. ({error})"))?;
    }
    Ok(())
}

pub fn create_collection(app: &AppHandle, name: &str) -> Result<Collection, String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let collection = Collection {
        id: unique_id(&slug(name)),
        name: name.trim().to_string(),
    };
    atomic_json(
        &root
            .join("collections")
            .join(format!("{}.json", collection.id)),
        &collection,
    )?;
    Ok(collection)
}

pub fn save_environment(app: &AppHandle, environment: &Environment) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    atomic_json(
        &root
            .join("environments")
            .join(format!("{}.json", environment.id)),
        environment,
    )
}

pub fn add_history(app: &AppHandle, entry: &HistoryEntry) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    atomic_json(
        &root.join("history").join(format!("{}.json", entry.id)),
        entry,
    )?;
    let mut files = fs::read_dir(root.join("history"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(modified, _)| *modified);
    let remove_count = files.len().saturating_sub(HISTORY_LIMIT);
    for (_, path) in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn row(name: &str, value: &str) -> KeyValueRow {
    KeyValueRow {
        id: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as f64,
        name: name.into(),
        value: value.into(),
        enabled: true,
        kind: None,
    }
}

fn imported_request(
    collection_id: &str,
    name: &str,
    method: &str,
    url: &str,
    headers: Vec<KeyValueRow>,
    body: String,
) -> SavedRequest {
    SavedRequest {
        id: unique_id(&slug(name)),
        collection_id: collection_id.into(),
        name: name.into(),
        method: method.into(),
        url: url.into(),
        params: vec![],
        headers,
        body,
        body_mode: "json".into(),
        form_rows: vec![],
        multipart_rows: vec![],
        binary_file: String::new(),
        auth_type: "none".into(),
        auth_fields: json!({}),
        timeout_ms: 30000,
        follow_redirects: true,
        favorite: false,
    }
}

fn import_postman_items(items: &[Value], collection_id: &str, requests: &mut Vec<SavedRequest>) {
    for item in items {
        if let Some(children) = item.get("item").and_then(Value::as_array) {
            import_postman_items(children, collection_id, requests);
            continue;
        }
        let Some(request) = item.get("request") else {
            continue;
        };
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Imported request");
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("GET");
        let url = request
            .get("url")
            .and_then(|url| {
                url.get("raw")
                    .and_then(Value::as_str)
                    .or_else(|| url.as_str())
            })
            .unwrap_or("");
        let headers = request
            .get("header")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|header| {
                row(
                    header.get("key").and_then(Value::as_str).unwrap_or(""),
                    header.get("value").and_then(Value::as_str).unwrap_or(""),
                )
            })
            .collect();
        let body = request
            .get("body")
            .and_then(|body| body.get("raw"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        requests.push(imported_request(
            collection_id,
            name,
            method,
            url,
            headers,
            body,
        ));
    }
}

pub fn import_file(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let bytes = fs::read(path).map_err(|error| format!("Could not read import file. ({error})"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Import files must be JSON. ({error})"))?;
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;

    if value.get("values").and_then(Value::as_array).is_some() {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Imported");
        let environment = Environment {
            id: unique_id(&slug(name)),
            name: name.into(),
            variables: value["values"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|variable| Variable {
                    name: variable
                        .get("key")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    value: variable
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    secret: false,
                    enabled: variable
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                })
                .collect(),
        };
        save_environment(app, &environment)?;
        return Ok(ImportResult {
            message: format!("Imported environment '{}'.", environment.name),
            imported_requests: 0,
            imported_environments: 1,
        });
    }

    let collection_name = value
        .pointer("/info/name")
        .or_else(|| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Imported API");
    let collection = create_collection(app, collection_name)?;
    let mut requests = vec![];
    if let Some(items) = value.get("item").and_then(Value::as_array) {
        import_postman_items(items, &collection.id, &mut requests);
    } else if let Some(paths) = value.get("paths").and_then(Value::as_object) {
        for (path_name, methods) in paths {
            let Some(methods) = methods.as_object() else {
                continue;
            };
            for (method, operation) in methods {
                if !["get", "post", "put", "patch", "delete", "head", "options"]
                    .contains(&method.as_str())
                {
                    continue;
                }
                let name = operation
                    .get("summary")
                    .or_else(|| operation.get("operationId"))
                    .and_then(Value::as_str)
                    .unwrap_or(path_name);
                requests.push(imported_request(
                    &collection.id,
                    name,
                    &method.to_uppercase(),
                    path_name,
                    vec![],
                    String::new(),
                ));
            }
        }
    } else {
        return Err("This is not a supported Postman collection, Postman environment, or OpenAPI 3 JSON file.".into());
    }
    for request in &requests {
        save_request(app, request)?;
    }
    Ok(ImportResult {
        message: format!(
            "Imported {} requests into '{}'.",
            requests.len(),
            collection.name
        ),
        imported_requests: requests.len(),
        imported_environments: 0,
    })
}

fn add_directory_to_zip(
    zip: &mut ZipWriter<fs::File>,
    root: &Path,
    directory: &Path,
    prefix: &str,
) -> Result<(), String> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.starts_with(root.join("private")) {
            continue;
        }
        if path.is_dir() {
            add_directory_to_zip(zip, root, &path, prefix)?;
        } else {
            let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
            let archive_path = Path::new(prefix)
                .join(relative)
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(archive_path, options)
                .map_err(|error| format!("Could not create ZIP entry. ({error})"))?;
            let bytes = redact_export_bytes(
                relative,
                fs::read(&path).map_err(|error| error.to_string())?,
            )?;
            zip.write_all(&bytes).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn redact_export_bytes(relative: &Path, mut bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if relative.starts_with("environments") {
        if let Ok(mut environment) = serde_json::from_slice::<Environment>(&bytes) {
            for variable in &mut environment.variables {
                if variable.secret {
                    variable.value.clear();
                }
            }
            bytes = serde_json::to_vec_pretty(&environment)
                .map_err(|error| format!("Could not redact environment secrets. ({error})"))?;
        }
    } else if relative.starts_with("requests") {
        if let Ok(mut request) = serde_json::from_slice::<SavedRequest>(&bytes) {
            if let Some(fields) = request.auth_fields.as_object_mut() {
                for key in ["password", "token", "value"] {
                    if fields.contains_key(key) {
                        fields.insert(key.into(), Value::String(String::new()));
                    }
                }
            }
            bytes = serde_json::to_vec_pretty(&request)
                .map_err(|error| format!("Could not redact request secrets. ({error})"))?;
        }
    }
    Ok(bytes)
}

pub fn export_portable(app: &AppHandle, path: &str) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let file = fs::File::create(path)
        .map_err(|error| format!("Could not create portable workspace ZIP. ({error})"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("README.txt", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(b"API Lantern portable workspace\n\nPlace this workspace folder beside an API Lantern portable release. Secrets are intentionally excluded.\n")
        .map_err(|error| error.to_string())?;
    zip.start_file("portable.flag", options)
        .map_err(|error| error.to_string())?;
    add_directory_to_zip(&mut zip, &root, &root, "workspace")?;
    zip.finish()
        .map_err(|error| format!("Could not finish portable workspace ZIP. ({error})"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_creates_portable_file_names() {
        assert_eq!(slug("Users API / Staging"), "users-api-staging");
        assert_eq!(slug("  My Request  "), "my-request");
    }

    #[test]
    fn postman_nested_items_become_requests() {
        let source = json!([{
            "name": "Folder",
            "item": [{
                "name": "Create user",
                "request": {
                    "method": "POST",
                    "url": {"raw": "https://example.test/users"},
                    "header": [{"key": "Accept", "value": "application/json"}],
                    "body": {"raw": "{\"name\":\"Ada\"}"}
                }
            }]
        }]);
        let mut requests = vec![];
        import_postman_items(source.as_array().unwrap(), "users", &mut requests);
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].collection_id, "users");
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].headers[0].name, "Accept");
    }

    #[test]
    fn portable_exports_clear_secret_environment_values() {
        let environment = Environment {
            id: "local".into(),
            name: "Local".into(),
            variables: vec![Variable {
                name: "token".into(),
                value: "do-not-export".into(),
                secret: true,
                enabled: true,
            }],
        };
        let bytes = redact_export_bytes(
            Path::new("environments/local.json"),
            serde_json::to_vec(&environment).unwrap(),
        )
        .unwrap();
        let exported: Environment = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(exported.variables[0].value, "");
    }
}
