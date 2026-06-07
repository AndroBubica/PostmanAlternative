mod logging;
mod models;
mod portable_export;

pub use logging::append_log;
use logging::enforce_log_limit;
pub use models::*;
pub use portable_export::export_portable;
#[cfg(test)]
use portable_export::redact_export_bytes;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

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

pub(crate) fn workspace_root(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the application. ({error})"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "Could not locate the application folder.".to_string())?;
    let portable_root = executable_dir
        .ancestors()
        .take(8)
        .find(|path| path.join("portable.flag").exists());
    let root = if let Some(portable_root) = portable_root {
        portable_root.join("workspace")
    } else {
        app.path()
            .app_data_dir()
            .map_err(|error| format!("Could not locate local application data. ({error})"))?
            .join("workspace")
    };
    Ok((root, portable_root.is_some()))
}

fn ensure_workspace(root: &Path) -> Result<(), String> {
    for directory in [
        "collections",
        "requests",
        "environments",
        "history",
        "logs",
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
                parent_id: None,
                variables: vec![],
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
    let settings: WorkspaceSettings = read_json(&root.join("settings.json")).unwrap_or_default();
    let global_variables: Vec<Variable> = read_json(&root.join("globals.json")).unwrap_or_default();
    history.truncate(settings.history_limit);
    Ok(WorkspaceSnapshot {
        root: root.to_string_lossy().into_owned(),
        portable,
        collections,
        requests,
        environments,
        history,
        settings,
        global_variables,
    })
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub fn save_settings(app: &AppHandle, settings: &WorkspaceSettings) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    atomic_json(&root.join("settings.json"), settings)?;
    enforce_log_limit(
        &root.join("logs"),
        settings.log_limit_mb.saturating_mul(1024 * 1024),
    )
}

pub fn save_globals(app: &AppHandle, variables: &[Variable]) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    atomic_json(&root.join("globals.json"), variables)
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

pub fn create_collection(
    app: &AppHandle,
    name: &str,
    parent_id: Option<String>,
) -> Result<Collection, String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let collection = Collection {
        id: unique_id(&slug(name)),
        name: name.trim().to_string(),
        parent_id,
        variables: vec![],
    };
    let collections: Vec<Collection> = read_json_files(&root.join("collections"));
    validate_collection_parent(&collections, &collection)?;
    atomic_json(
        &root
            .join("collections")
            .join(format!("{}.json", collection.id)),
        &collection,
    )?;
    Ok(collection)
}

pub fn save_collection(app: &AppHandle, collection: &Collection) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let collections: Vec<Collection> = read_json_files(&root.join("collections"));
    validate_collection_parent(&collections, collection)?;
    atomic_json(
        &root
            .join("collections")
            .join(format!("{}.json", collection.id)),
        collection,
    )
}

fn collection_descendant_ids(collections: &[Collection], collection_id: &str) -> Vec<String> {
    let mut ids = vec![collection_id.to_string()];
    let mut index = 0;
    while index < ids.len() {
        let parent_id = ids[index].clone();
        for collection in collections {
            if collection.parent_id.as_deref() == Some(&parent_id) && !ids.contains(&collection.id)
            {
                ids.push(collection.id.clone());
            }
        }
        index += 1;
    }
    ids
}

fn validate_collection_parent(
    collections: &[Collection],
    collection: &Collection,
) -> Result<(), String> {
    let Some(parent_id) = collection.parent_id.as_deref() else {
        return Ok(());
    };
    if parent_id == collection.id {
        return Err("A folder cannot be moved into itself.".into());
    }
    if !collections
        .iter()
        .any(|candidate| candidate.id == parent_id)
    {
        return Err("The destination folder no longer exists.".into());
    }
    if collection_descendant_ids(collections, &collection.id)
        .iter()
        .any(|id| id == parent_id)
    {
        return Err("A folder cannot be moved into one of its descendants.".into());
    }
    Ok(())
}

pub fn delete_collection(
    app: &AppHandle,
    collection_id: &str,
) -> Result<DeletedCollectionSnapshot, String> {
    if collection_id == "default" {
        return Err("The default collection cannot be deleted.".into());
    }
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let collections: Vec<Collection> = read_json_files(&root.join("collections"));
    let delete_ids = collection_descendant_ids(&collections, collection_id);
    let requests: Vec<SavedRequest> = read_json_files(&root.join("requests"));
    let snapshot = DeletedCollectionSnapshot {
        collections: collections
            .into_iter()
            .filter(|collection| delete_ids.contains(&collection.id))
            .collect(),
        requests: requests
            .iter()
            .filter(|request| delete_ids.contains(&request.collection_id))
            .cloned()
            .collect(),
    };
    for request in requests {
        if delete_ids.contains(&request.collection_id) {
            let path = root.join("requests").join(format!("{}.json", request.id));
            fs::remove_file(path)
                .map_err(|error| format!("Could not delete request. ({error})"))?;
        }
    }
    for id in delete_ids {
        let path = root.join("collections").join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("Could not delete collection folder. ({error})"))?;
        }
    }
    Ok(snapshot)
}

pub fn restore_collection(
    app: &AppHandle,
    snapshot: &DeletedCollectionSnapshot,
) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    let mut remaining = snapshot.collections.clone();
    let snapshot_ids = remaining
        .iter()
        .map(|collection| collection.id.clone())
        .collect::<Vec<_>>();
    let mut restored = Vec::new();
    while !remaining.is_empty() {
        let index = remaining
            .iter()
            .position(|collection| {
                collection.parent_id.as_ref().map_or(true, |parent| {
                    !snapshot_ids.contains(parent) || restored.contains(parent)
                })
            })
            .ok_or_else(|| "Could not restore the collection hierarchy.".to_string())?;
        let collection = remaining.remove(index);
        atomic_json(
            &root
                .join("collections")
                .join(format!("{}.json", collection.id)),
            &collection,
        )?;
        restored.push(collection.id);
    }
    for request in &snapshot.requests {
        atomic_json(
            &root.join("requests").join(format!("{}.json", request.id)),
            request,
        )?;
    }
    Ok(())
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

pub fn delete_environment(app: &AppHandle, environment_id: &str) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    let path = root
        .join("environments")
        .join(format!("{environment_id}.json"));
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not delete environment. ({error})"))?;
    }
    Ok(())
}

pub fn add_history(app: &AppHandle, entry: &HistoryEntry) -> Result<(), String> {
    let (root, _) = workspace_root(app)?;
    ensure_workspace(&root)?;
    atomic_json(
        &root.join("history").join(format!("{}.json", entry.id)),
        entry,
    )?;
    let settings: WorkspaceSettings = read_json(&root.join("settings.json")).unwrap_or_default();
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
    let remove_count = files.len().saturating_sub(settings.history_limit);
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
        pre_request_script: String::new(),
        post_response_script: String::new(),
        scripts_enabled: false,
        assertions: vec![],
    }
}

fn postman_auth(auth: Option<&Value>) -> Option<(String, Value)> {
    let auth = auth?;
    let auth_type = auth.get("type").and_then(Value::as_str)?;
    let values = auth
        .get(auth_type)
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some((
                        entry.get("key")?.as_str()?.to_string(),
                        entry
                            .get("value")
                            .cloned()
                            .unwrap_or(Value::String(String::new())),
                    ))
                })
                .collect::<serde_json::Map<String, Value>>()
        })
        .unwrap_or_default();
    match auth_type {
        "basic" => Some((
            "basic".into(),
            json!({
                "username": values.get("username").and_then(Value::as_str).unwrap_or(""),
                "password": values.get("password").and_then(Value::as_str).unwrap_or("")
            }),
        )),
        "bearer" => Some((
            "bearer".into(),
            json!({"token": values.get("token").and_then(Value::as_str).unwrap_or("")}),
        )),
        "apikey" => Some((
            "api-key".into(),
            json!({
                "key": values.get("key").and_then(Value::as_str).unwrap_or(""),
                "value": values.get("value").and_then(Value::as_str).unwrap_or(""),
                "location": match values.get("in").and_then(Value::as_str) {
                    Some("query") => "query",
                    _ => "header"
                }
            }),
        )),
        "noauth" => Some(("none".into(), json!({}))),
        _ => None,
    }
}

fn postman_script(item: &Value, event_name: &str) -> String {
    item.get("event")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|event| event.get("listen").and_then(Value::as_str) == Some(event_name))
        .and_then(|event| event.pointer("/script/exec").and_then(Value::as_array))
        .map(|lines| {
            lines
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn import_postman_items(
    items: &[Value],
    collection_id: &str,
    inherited_auth: Option<&(String, Value)>,
    collections: &mut Vec<Collection>,
    requests: &mut Vec<SavedRequest>,
) {
    for item in items {
        if let Some(children) = item.get("item").and_then(Value::as_array) {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Imported folder");
            let folder = Collection {
                id: unique_id(&slug(name)),
                name: name.into(),
                parent_id: Some(collection_id.into()),
                variables: vec![],
            };
            let folder_auth = postman_auth(item.get("auth")).or_else(|| inherited_auth.cloned());
            collections.push(folder.clone());
            import_postman_items(
                children,
                &folder.id,
                folder_auth.as_ref(),
                collections,
                requests,
            );
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
                let mut value = row(
                    header.get("key").and_then(Value::as_str).unwrap_or(""),
                    header.get("value").and_then(Value::as_str).unwrap_or(""),
                );
                value.enabled = !header
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                value
            })
            .collect();
        let body_value = request.get("body");
        let body = body_value
            .and_then(|body| body.get("raw"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut imported = imported_request(collection_id, name, method, url, headers, body);
        imported.params = request
            .pointer("/url/query")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|parameter| {
                let mut value = row(
                    parameter.get("key").and_then(Value::as_str).unwrap_or(""),
                    parameter.get("value").and_then(Value::as_str).unwrap_or(""),
                );
                value.enabled = !parameter
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                value
            })
            .collect();
        if let Some(mode) = body_value
            .and_then(|body| body.get("mode"))
            .and_then(Value::as_str)
        {
            imported.body_mode = match mode {
                "urlencoded" => "form",
                "formdata" => "multipart",
                "file" => "binary",
                _ => body_value
                    .and_then(|body| body.pointer("/options/raw/language"))
                    .and_then(Value::as_str)
                    .unwrap_or("text"),
            }
            .into();
        }
        imported.form_rows = body_value
            .and_then(|body| body.get("urlencoded"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|field| {
                row(
                    field.get("key").and_then(Value::as_str).unwrap_or(""),
                    field.get("value").and_then(Value::as_str).unwrap_or(""),
                )
            })
            .collect();
        imported.multipart_rows = body_value
            .and_then(|body| body.get("formdata"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|field| {
                let mut value = row(
                    field.get("key").and_then(Value::as_str).unwrap_or(""),
                    field
                        .get("value")
                        .or_else(|| field.get("src"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                );
                value.kind = Some(
                    if field.get("type").and_then(Value::as_str) == Some("file") {
                        "file"
                    } else {
                        "text"
                    }
                    .into(),
                );
                value
            })
            .collect();
        if let Some((auth_type, auth_fields)) =
            postman_auth(request.get("auth")).or_else(|| inherited_auth.cloned())
        {
            imported.auth_type = auth_type;
            imported.auth_fields = auth_fields;
        }
        imported.pre_request_script = postman_script(item, "prerequest");
        imported.post_response_script = postman_script(item, "test");
        imported.scripts_enabled = false;
        requests.push(imported);
    }
}

pub fn import_file(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let bytes = fs::read(path).map_err(|error| format!("Could not read import file. ({error})"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .or_else(|_| serde_yaml::from_slice::<Value>(&bytes))
        .map_err(|error| format!("Import files must be JSON or YAML. ({error})"))?;
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
    let collection = create_collection(app, collection_name, None)?;
    let mut requests = vec![];
    let mut collections = vec![];
    if let Some(items) = value.get("item").and_then(Value::as_array) {
        let collection_auth = postman_auth(value.get("auth"));
        import_postman_items(
            items,
            &collection.id,
            collection_auth.as_ref(),
            &mut collections,
            &mut requests,
        );
    } else if let Some(paths) = value.get("paths").and_then(Value::as_object) {
        let base_url = value
            .pointer("/servers/0/url")
            .and_then(Value::as_str)
            .unwrap_or("");
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
                let parameters = operation
                    .get("parameters")
                    .and_then(Value::as_array)
                    .or_else(|| methods.get("parameters").and_then(Value::as_array));
                let mut headers = vec![];
                let mut query = vec![];
                for parameter in parameters.into_iter().flatten() {
                    let name = parameter.get("name").and_then(Value::as_str).unwrap_or("");
                    let sample = parameter
                        .pointer("/example")
                        .or_else(|| parameter.pointer("/schema/example"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    match parameter.get("in").and_then(Value::as_str) {
                        Some("header") => headers.push(row(name, sample)),
                        Some("query") => query.push(row(name, sample)),
                        _ => {}
                    }
                }
                let mut imported = imported_request(
                    &collection.id,
                    name,
                    &method.to_uppercase(),
                    &format!("{base_url}{path_name}"),
                    headers,
                    String::new(),
                );
                imported.params = query;
                requests.push(imported);
            }
        }
    } else {
        return Err("This is not a supported Postman collection, Postman environment, or OpenAPI 3 JSON/YAML file.".into());
    }
    for folder in &collections {
        save_collection(app, folder)?;
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
        let mut collections = vec![];
        import_postman_items(
            source.as_array().unwrap(),
            "users",
            None,
            &mut collections,
            &mut requests,
        );
        assert_eq!(requests.len(), 1);
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].parent_id.as_deref(), Some("users"));
        assert_eq!(requests[0].collection_id, collections[0].id);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].headers[0].name, "Accept");
    }

    #[test]
    fn postman_auth_values_and_folder_inheritance_are_imported() {
        let source = json!([{
            "name": "Secured",
            "auth": {"type": "apikey", "apikey": [
                {"key": "key", "value": "X-API-Key"},
                {"key": "value", "value": "{{apiKey}}"},
                {"key": "in", "value": "header"}
            ]},
            "item": [{
                "name": "List users",
                "request": {"method": "GET", "url": "https://example.test/users"}
            }]
        }]);
        let mut collections = vec![];
        let mut requests = vec![];
        import_postman_items(
            source.as_array().unwrap(),
            "root",
            None,
            &mut collections,
            &mut requests,
        );
        assert_eq!(requests[0].auth_type, "api-key");
        assert_eq!(requests[0].auth_fields["key"], "X-API-Key");
        assert_eq!(requests[0].auth_fields["value"], "{{apiKey}}");
        assert_eq!(requests[0].auth_fields["location"], "header");
    }

    #[test]
    fn postman_basic_bearer_and_noauth_values_are_imported() {
        let source = json!([
            {
                "name": "Basic",
                "request": {
                    "method": "GET",
                    "url": "https://example.test/basic",
                    "auth": {"type": "basic", "basic": [
                        {"key": "username", "value": "ada"},
                        {"key": "password", "value": "{{password}}"}
                    ]}
                }
            },
            {
                "name": "Bearer",
                "request": {
                    "method": "GET",
                    "url": "https://example.test/bearer",
                    "auth": {"type": "bearer", "bearer": [
                        {"key": "token", "value": "{{token}}"}
                    ]}
                }
            },
            {
                "name": "Public",
                "request": {
                    "method": "GET",
                    "url": "https://example.test/public",
                    "auth": {"type": "noauth"}
                }
            }
        ]);
        let inherited = ("bearer".into(), json!({"token": "inherited"}));
        let mut collections = vec![];
        let mut requests = vec![];
        import_postman_items(
            source.as_array().unwrap(),
            "root",
            Some(&inherited),
            &mut collections,
            &mut requests,
        );
        assert_eq!(requests[0].auth_type, "basic");
        assert_eq!(requests[0].auth_fields["username"], "ada");
        assert_eq!(requests[0].auth_fields["password"], "{{password}}");
        assert_eq!(requests[1].auth_type, "bearer");
        assert_eq!(requests[1].auth_fields["token"], "{{token}}");
        assert_eq!(requests[2].auth_type, "none");
        assert_eq!(requests[2].auth_fields, json!({}));
    }

    #[test]
    fn postman_scripts_are_imported_but_disabled() {
        let source = json!([{
            "name": "Scripted",
            "event": [
                {"listen": "prerequest", "script": {"exec": ["lantern.setVariable('run', 'yes');"]}},
                {"listen": "test", "script": {"exec": ["lantern.test('ok', () => {});"]}}
            ],
            "request": {"method": "GET", "url": "https://example.test"}
        }]);
        let mut collections = vec![];
        let mut requests = vec![];
        import_postman_items(
            source.as_array().unwrap(),
            "root",
            None,
            &mut collections,
            &mut requests,
        );
        assert!(!requests[0].scripts_enabled);
        assert!(requests[0].pre_request_script.contains("setVariable"));
        assert!(requests[0].post_response_script.contains("lantern.test"));
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

    #[test]
    fn collection_parent_is_optional_for_existing_workspace_files() {
        let collection: Collection =
            serde_json::from_value(json!({"id": "users", "name": "Users"})).unwrap();
        assert_eq!(collection.parent_id, None);
    }

    #[test]
    fn collection_descendants_include_nested_folders() {
        let collections = vec![
            Collection {
                id: "root".into(),
                name: "Root".into(),
                parent_id: None,
                variables: vec![],
            },
            Collection {
                id: "child".into(),
                name: "Child".into(),
                parent_id: Some("root".into()),
                variables: vec![],
            },
            Collection {
                id: "grandchild".into(),
                name: "Grandchild".into(),
                parent_id: Some("child".into()),
                variables: vec![],
            },
        ];
        assert_eq!(
            collection_descendant_ids(&collections, "root"),
            vec!["root", "child", "grandchild"]
        );
    }

    #[test]
    fn collection_parent_validation_rejects_descendant_cycles() {
        let collections = vec![
            Collection {
                id: "root".into(),
                name: "Root".into(),
                parent_id: None,
                variables: vec![],
            },
            Collection {
                id: "child".into(),
                name: "Child".into(),
                parent_id: Some("root".into()),
                variables: vec![],
            },
        ];
        let moved = Collection {
            parent_id: Some("child".into()),
            ..collections[0].clone()
        };
        assert!(validate_collection_parent(&collections, &moved).is_err());
    }

    #[test]
    fn log_limit_removes_old_files_and_trims_active_file() {
        let directory = std::env::temp_dir().join(unique_id("api-lantern-log-test"));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("old.log"), vec![b'a'; 8]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(directory.join("new.log"), vec![b'b'; 8]).unwrap();
        enforce_log_limit(&directory, 10).unwrap();
        let total = fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .map(|entry| entry.metadata().unwrap().len())
            .sum::<u64>();
        assert!(total <= 10);
        let _ = fs::remove_dir_all(directory);
    }
}
