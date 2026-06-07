use crate::workspace::RequestAssertion;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Serialize)]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    pub message: String,
}

#[derive(Serialize)]
pub struct RunItem {
    pub request_id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub elapsed_ms: u128,
    pub tests: Vec<TestResult>,
    pub error: String,
}

#[derive(Serialize)]
pub struct RunReport {
    pub collection: String,
    pub started_at: u64,
    pub elapsed_ms: u128,
    pub passed: usize,
    pub failed: usize,
    pub items: Vec<RunItem>,
}

pub fn compare(assertion: &RequestAssertion, actual: Option<Value>) -> TestResult {
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

pub fn json_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    let mut token = String::new();
    let mut chars = path
        .trim_start_matches('$')
        .trim_start_matches('.')
        .chars()
        .peekable();
    while let Some(character) = chars.next() {
        match character {
            '.' => {
                if !token.is_empty() {
                    current = current.get(&token)?;
                    token.clear();
                }
            }
            '[' => {
                if !token.is_empty() {
                    current = current.get(&token)?;
                    token.clear();
                }
                let mut index = String::new();
                for character in chars.by_ref() {
                    if character == ']' {
                        break;
                    }
                    index.push(character);
                }
                current = current.get(index.parse::<usize>().ok()?)?;
            }
            _ => token.push(character),
        }
    }
    if !token.is_empty() {
        current = current.get(&token)?;
    }
    Some(current)
}

pub fn assertion_results(
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
                    json_path(&parsed, &item.target).cloned()
                }
                _ => None,
            };
            compare(item, actual)
        })
        .collect()
}

pub fn junit(report: &RunReport) -> String {
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
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
