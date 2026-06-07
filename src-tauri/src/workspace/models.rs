use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_HISTORY_LIMIT: usize = 100;
const DEFAULT_LOG_LIMIT_MB: usize = 10;

fn enabled() -> bool {
    true
}

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
    #[serde(default)]
    pub pre_request_script: String,
    #[serde(default)]
    pub post_response_script: String,
    #[serde(default)]
    pub scripts_enabled: bool,
    #[serde(default)]
    pub assertions: Vec<RequestAssertion>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAssertion {
    pub id: String,
    pub kind: String,
    pub operator: String,
    pub target: String,
    pub expected: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub variables: Vec<Variable>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_snapshot: Option<SavedRequest>,
}

#[derive(Serialize)]
pub struct WorkspaceSnapshot {
    pub root: String,
    pub portable: bool,
    pub collections: Vec<Collection>,
    pub requests: Vec<SavedRequest>,
    pub environments: Vec<Environment>,
    pub history: Vec<HistoryEntry>,
    pub settings: WorkspaceSettings,
    pub global_variables: Vec<Variable>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct DeletedCollectionSnapshot {
    pub collections: Vec<Collection>,
    pub requests: Vec<SavedRequest>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    #[serde(default = "default_history_limit")]
    pub history_limit: usize,
    #[serde(default = "default_log_limit_mb")]
    pub log_limit_mb: usize,
    #[serde(default = "enabled")]
    pub autosave: bool,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            history_limit: default_history_limit(),
            log_limit_mb: default_log_limit_mb(),
            autosave: true,
        }
    }
}

fn default_history_limit() -> usize {
    DEFAULT_HISTORY_LIMIT
}

fn default_log_limit_mb() -> usize {
    DEFAULT_LOG_LIMIT_MB
}

#[derive(Serialize)]
pub struct ImportResult {
    pub message: String,
    pub imported_requests: usize,
    pub imported_environments: usize,
}
