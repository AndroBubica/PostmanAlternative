use api_lantern_lib::workspace::{
    Collection, Environment, RequestAssertion, SavedRequest, Variable,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{header::HeaderName, Method, Url};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Instant, SystemTime},
};

#[derive(Serialize)]
struct TestResult {
    name: String,
    passed: bool,
    message: String,
}

#[derive(Serialize)]
struct RunItem {
    request_id: String,
    name: String,
    method: String,
    url: String,
    status: Option<u16>,
    elapsed_ms: u128,
    tests: Vec<TestResult>,
    error: String,
}

#[derive(Serialize)]
struct RunReport {
    collection: String,
    started_at: u64,
    elapsed_ms: u128,
    passed: usize,
    failed: usize,
    items: Vec<RunItem>,
}

struct Options {
    workspace: PathBuf,
    collection: Option<String>,
    environment: Option<String>,
    report: String,
    output: Option<PathBuf>,
}

fn usage() -> String {
    "Usage: api-lantern-cli --workspace PATH [--collection ID] [--environment ID] [--report json|junit] [--output PATH]".into()
}

fn options() -> Result<Options, String> {
    let mut args = env::args().skip(1);
    let mut workspace = None;
    let mut collection = None;
    let mut environment = None;
    let mut report = "json".to_string();
    let mut output = None;
    while let Some(argument) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("Missing value after {argument}."))
        };
        match argument.as_str() {
            "--workspace" => workspace = Some(PathBuf::from(value()?)),
            "--collection" => collection = Some(value()?),
            "--environment" => environment = Some(value()?),
            "--report" => report = value()?,
            "--output" => output = Some(PathBuf::from(value()?)),
            "--help" | "-h" => return Err(usage()),
            _ => return Err(format!("Unknown option: {argument}\n{}", usage())),
        }
    }
    if !["json", "junit"].contains(&report.as_str()) {
        return Err("--report must be json or junit.".into());
    }
    Ok(Options {
        workspace: workspace.ok_or_else(usage)?,
        collection,
        environment,
        report,
        output,
    })
}

fn read_files<T: for<'de> serde::Deserialize<'de>>(directory: &Path) -> Vec<T> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect()
}

fn resolve(value: &str, variables: &HashMap<String, String>) -> Result<String, String> {
    let mut output = String::new();
    let mut remainder = value;
    while let Some(start) = remainder.find("{{") {
        output.push_str(&remainder[..start]);
        let after = &remainder[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| "Unclosed variable expression.".to_string())?;
        let name = after[..end].trim();
        output.push_str(
            variables
                .get(name)
                .ok_or_else(|| format!("Unresolved variable: {name}"))?,
        );
        remainder = &after[end + 2..];
    }
    output.push_str(remainder);
    Ok(output)
}

fn add_variables(target: &mut HashMap<String, String>, variables: &[Variable]) {
    for variable in variables
        .iter()
        .filter(|variable| variable.enabled && !variable.secret)
    {
        target.insert(variable.name.clone(), variable.value.clone());
    }
}

fn descendants(collections: &[Collection], root: &str) -> HashSet<String> {
    let mut ids = HashSet::from([root.to_string()]);
    loop {
        let before = ids.len();
        for collection in collections {
            if collection
                .parent_id
                .as_ref()
                .is_some_and(|parent| ids.contains(parent))
            {
                ids.insert(collection.id.clone());
            }
        }
        if before == ids.len() {
            return ids;
        }
    }
}

fn compare(assertion: &RequestAssertion, actual: Option<Value>) -> TestResult {
    let actual_text = actual.as_ref().map(|value| match value {
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    });
    let passed = match assertion.operator.as_str() {
        "exists" => actual.is_some() && actual != Some(Value::Null),
        "contains" => actual_text
            .as_deref()
            .unwrap_or("")
            .contains(&assertion.expected),
        "not-equals" => actual_text.as_deref().unwrap_or("") != assertion.expected,
        "less-than" => {
            actual_text
                .as_deref()
                .unwrap_or("")
                .parse::<f64>()
                .unwrap_or(f64::INFINITY)
                < assertion
                    .expected
                    .parse::<f64>()
                    .unwrap_or(f64::NEG_INFINITY)
        }
        _ => actual_text.as_deref().unwrap_or("") == assertion.expected,
    };
    TestResult {
        name: format!("{} {}", assertion.kind, assertion.target),
        passed,
        message: if passed {
            String::new()
        } else {
            format!(
                "Expected {} {}, received {}",
                assertion.operator,
                assertion.expected,
                actual_text.unwrap_or_else(|| "<missing>".into())
            )
        },
    }
}

fn assertions(
    items: &[RequestAssertion],
    status: u16,
    elapsed_ms: u128,
    headers: &HashMap<String, String>,
    body: &str,
) -> Vec<TestResult> {
    items
        .iter()
        .filter(|item| item.enabled)
        .map(|item| {
            let actual = match item.kind.as_str() {
                "status" => Some(Value::from(status)),
                "response-time" => Some(Value::from(elapsed_ms as u64)),
                "body" => Some(Value::String(body.into())),
                "header" => headers
                    .get(&item.target.to_lowercase())
                    .cloned()
                    .map(Value::String),
                "json-path" => {
                    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                    item.target
                        .trim_start_matches('$')
                        .trim_start_matches('.')
                        .split('.')
                        .filter(|part| !part.is_empty())
                        .try_fold(&parsed, |value, part| value.get(part))
                        .cloned()
                }
                _ => None,
            };
            compare(item, actual)
        })
        .collect()
}

async fn run_request(
    request: &SavedRequest,
    variables: &HashMap<String, String>,
) -> Result<RunItem, String> {
    if ["multipart", "binary"].contains(&request.body_mode.as_str()) {
        return Err("CLI runner does not yet support multipart or binary request bodies.".into());
    }
    let started = Instant::now();
    let mut url =
        Url::parse(&resolve(&request.url, variables)?).map_err(|error| error.to_string())?;
    for row in request
        .params
        .iter()
        .filter(|row| row.enabled && !row.name.is_empty())
    {
        url.query_pairs_mut().append_pair(
            &resolve(&row.name, variables)?,
            &resolve(&row.value, variables)?,
        );
    }
    if request.auth_type == "api-key"
        && request.auth_fields.get("location").and_then(Value::as_str) == Some("query")
    {
        let key = resolve(
            request
                .auth_fields
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or(""),
            variables,
        )?;
        let value = resolve(
            request
                .auth_fields
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or(""),
            variables,
        )?;
        url.query_pairs_mut().append_pair(&key, &value);
    }
    let client = reqwest::Client::builder()
        .redirect(if request.follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        })
        .timeout(std::time::Duration::from_millis(request.timeout_ms.max(1)))
        .build()
        .map_err(|error| error.to_string())?;
    let method =
        Method::from_bytes(request.method.as_bytes()).map_err(|error| error.to_string())?;
    let mut builder = client.request(method, url.clone());
    for header in request
        .headers
        .iter()
        .filter(|header| header.enabled && !header.name.is_empty())
    {
        builder = builder.header(
            HeaderName::from_bytes(resolve(&header.name, variables)?.as_bytes())
                .map_err(|error| error.to_string())?,
            resolve(&header.value, variables)?,
        );
    }
    if request.auth_type == "basic" {
        let username = resolve(
            request
                .auth_fields
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or(""),
            variables,
        )?;
        let password = resolve(
            request
                .auth_fields
                .get("password")
                .and_then(Value::as_str)
                .unwrap_or(""),
            variables,
        )?;
        builder = builder.header(
            "Authorization",
            format!("Basic {}", BASE64.encode(format!("{username}:{password}"))),
        );
    } else if request.auth_type == "bearer" {
        builder = builder.bearer_auth(resolve(
            request
                .auth_fields
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or(""),
            variables,
        )?);
    } else if request.auth_type == "api-key" {
        let key = resolve(
            request
                .auth_fields
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or(""),
            variables,
        )?;
        let value = resolve(
            request
                .auth_fields
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or(""),
            variables,
        )?;
        if request.auth_fields.get("location").and_then(Value::as_str) != Some("query") {
            builder = builder.header(
                HeaderName::from_bytes(key.as_bytes()).map_err(|error| error.to_string())?,
                value,
            );
        }
    }
    if !["GET", "HEAD"].contains(&request.method.as_str()) {
        let body = if request.body_mode == "form" {
            request
                .form_rows
                .iter()
                .filter(|row| row.enabled && !row.name.is_empty())
                .map(|row| {
                    Ok((
                        resolve(&row.name, variables)?,
                        resolve(&row.value, variables)?,
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .into_iter()
                .collect::<HashMap<_, _>>()
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}={}",
                        urlencoding::encode(&key),
                        urlencoding::encode(&value)
                    )
                })
                .collect::<Vec<_>>()
                .join("&")
        } else {
            resolve(&request.body, variables)?
        };
        builder = builder.body(body);
    }
    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_str().unwrap_or("").to_string()))
        .collect::<HashMap<_, _>>();
    let body = response.text().await.map_err(|error| error.to_string())?;
    let elapsed_ms = started.elapsed().as_millis();
    let mut tests = assertions(&request.assertions, status, elapsed_ms, &headers, &body);
    if request.scripts_enabled
        && (!request.pre_request_script.trim().is_empty()
            || !request.post_response_script.trim().is_empty())
    {
        tests.push(TestResult { name: "JavaScript sandbox".into(), passed: false, message: "The CLI runner does not execute desktop JavaScript sandbox scripts; use friendly assertions for CI runs.".into() });
    }
    Ok(RunItem {
        request_id: request.id.clone(),
        name: request.name.clone(),
        method: request.method.clone(),
        url: url.to_string(),
        status: Some(status),
        elapsed_ms,
        tests,
        error: String::new(),
    })
}

fn junit(report: &RunReport) -> String {
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('"', "&quot;")
    };
    let cases = report
        .items
        .iter()
        .map(|item| {
            let failure = if item.error.is_empty() {
                item.tests
                    .iter()
                    .find(|test| !test.passed)
                    .map(|test| test.message.clone())
            } else {
                Some(item.error.clone())
            };
            format!(
                "  <testcase name=\"{}\" classname=\"{}\" time=\"{}\">{}</testcase>",
                escape(&item.name),
                escape(&report.collection),
                item.elapsed_ms as f64 / 1000.0,
                failure
                    .map(|message| format!("<failure message=\"{}\"/>", escape(&message)))
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuite name=\"{}\" tests=\"{}\" failures=\"{}\" time=\"{}\">\n{}\n</testsuite>\n", escape(&report.collection), report.items.len(), report.failed, report.elapsed_ms as f64 / 1000.0, cases)
}

#[tokio::main]
async fn main() -> ExitCode {
    let options = match options() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if !options.workspace.join("api-lantern.json").exists() {
        eprintln!("The workspace does not contain api-lantern.json.");
        return ExitCode::from(2);
    }
    let collections: Vec<Collection> = read_files(&options.workspace.join("collections"));
    let requests: Vec<SavedRequest> = read_files(&options.workspace.join("requests"));
    let environments: Vec<Environment> = read_files(&options.workspace.join("environments"));
    let globals: Vec<Variable> = fs::read(options.workspace.join("globals.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let selected = options
        .collection
        .as_ref()
        .and_then(|id| collections.iter().find(|collection| &collection.id == id));
    if options.collection.is_some() && selected.is_none() {
        eprintln!("The selected collection does not exist.");
        return ExitCode::from(2);
    }
    let ids = selected.map(|collection| descendants(&collections, &collection.id));
    let mut base_variables = HashMap::new();
    add_variables(&mut base_variables, &globals);
    let selected_environment = options.environment.as_ref().and_then(|id| {
        environments
            .iter()
            .find(|environment| &environment.id == id)
    });
    if options.environment.is_some() && selected_environment.is_none() {
        eprintln!("The selected environment does not exist.");
        return ExitCode::from(2);
    }
    if let Some(environment) = selected_environment {
        add_variables(&mut base_variables, &environment.variables);
    }
    let started = Instant::now();
    let mut items = Vec::new();
    for request in requests.iter().filter(|request| {
        ids.as_ref()
            .map_or(true, |ids| ids.contains(&request.collection_id))
    }) {
        let mut variables = base_variables.clone();
        if let Some(collection) = collections
            .iter()
            .find(|collection| collection.id == request.collection_id)
        {
            add_variables(&mut variables, &collection.variables);
        }
        match run_request(request, &variables).await {
            Ok(item) => items.push(item),
            Err(error) => items.push(RunItem {
                request_id: request.id.clone(),
                name: request.name.clone(),
                method: request.method.clone(),
                url: request.url.clone(),
                status: None,
                elapsed_ms: 0,
                tests: vec![],
                error,
            }),
        }
    }
    let passed = items
        .iter()
        .filter(|item| item.error.is_empty() && item.tests.iter().all(|test| test.passed))
        .count();
    let report = RunReport {
        collection: selected
            .map(|collection| collection.name.clone())
            .unwrap_or_else(|| "All requests".into()),
        started_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        elapsed_ms: started.elapsed().as_millis(),
        failed: items.len() - passed,
        passed,
        items,
    };
    let contents = if options.report == "junit" {
        junit(&report)
    } else {
        serde_json::to_string_pretty(&report).unwrap()
    };
    if let Some(path) = options.output {
        if let Err(error) = fs::write(path, contents) {
            eprintln!("Could not write report: {error}");
            return ExitCode::from(2);
        }
    } else {
        println!("{contents}");
    }
    if report.failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_workspace_variables() {
        let variables = HashMap::from([
            ("host".into(), "example.test".into()),
            ("id".into(), "42".into()),
        ]);
        assert_eq!(
            resolve("https://{{host}}/users/{{id}}", &variables).unwrap(),
            "https://example.test/users/42"
        );
        assert!(resolve("{{missing}}", &variables).is_err());
    }

    #[test]
    fn evaluates_status_assertion() {
        let assertion = RequestAssertion {
            id: "status".into(),
            kind: "status".into(),
            operator: "equals".into(),
            target: String::new(),
            expected: "200".into(),
            enabled: true,
        };
        assert!(compare(&assertion, Some(Value::from(200))).passed);
        assert!(!compare(&assertion, Some(Value::from(500))).passed);
    }
}
