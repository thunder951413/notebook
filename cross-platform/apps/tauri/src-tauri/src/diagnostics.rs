//! Local diagnostics log (JSON Lines, two rotating 2 MiB files), compatible
//! with the Electron log format so the settings page can read both.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TEXT: usize = 500;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub level: String,
    pub category: String,
    pub action: String,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub resource: Option<Resource>,
    #[serde(default)]
    pub error_type: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub stack: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Resource {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
}

impl EventInput {
    pub fn new(level: &str, category: &str, action: &str, status: &str) -> Self {
        Self { level: level.into(), category: category.into(), action: action.into(), status: status.into(), ..Default::default() }
    }
    pub fn message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
    pub fn operation(mut self, id: &str) -> Self {
        self.operation_id = Some(id.into());
        self
    }
    pub fn duration(mut self, ms: u128) -> Self {
        self.duration_ms = Some(ms as f64);
        self
    }
}

static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^\s]+").unwrap());
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n\t]+").unwrap());
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(password|passphrase|token|secret|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+").unwrap());
static QUERY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)([?&](?:password|token|secret|key|authorization)=)[^&\s]+").unwrap());
static KEYS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(sk-[a-z0-9_-]{8,}|github_pat_[a-z0-9_]+|gh[opusr]_[a-z0-9_]+)\b").unwrap());
static UNSAFE_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[^a-z0-9._-]").unwrap());

pub fn sanitize(value: &str) -> String {
    let text = URL.replace_all(value, "${1}[redacted]");
    let text = WHITESPACE.replace_all(&text, " ");
    let text = ASSIGNMENT.replace_all(&text, "${1}=[redacted]");
    let text = QUERY.replace_all(&text, "${1}[redacted]");
    let text = KEYS.replace_all(&text, "[redacted]");
    text.trim().chars().take(MAX_TEXT).collect()
}

fn token(value: &str, fallback: &str, maximum: usize) -> String {
    let normalized: String = UNSAFE_TOKEN.replace_all(value.trim(), "-").chars().take(maximum).collect();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

pub struct Diagnostics {
    path: PathBuf,
    session_id: String,
    version: String,
    lock: Mutex<()>,
}

impl Diagnostics {
    pub fn new(directory: PathBuf, version: String) -> Self {
        Self { path: directory.join("notebook-diagnostics.jsonl"), session_id: uuid::Uuid::new_v4().to_string(), version, lock: Mutex::new(()) }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    fn normalize(&self, input: &EventInput) -> Map<String, Value> {
        let level = if matches!(input.level.as_str(), "info" | "warning" | "error") { input.level.as_str() } else { "info" };
        let status = if matches!(input.status.as_str(), "started" | "success" | "failed" | "cancelled" | "info") { input.status.as_str() } else { "info" };
        let mut entry = Map::new();
        entry.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
        entry.insert("timestamp".into(), json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
        entry.insert("sessionId".into(), json!(self.session_id));
        entry.insert("appVersion".into(), json!(self.version));
        entry.insert("platform".into(), json!(std::env::consts::OS.replace("macos", "darwin")));
        entry.insert("arch".into(), json!(std::env::consts::ARCH.replace("aarch64", "arm64").replace("x86_64", "x64")));
        entry.insert("level".into(), json!(level));
        entry.insert("category".into(), json!(token(&input.category, "app", 64)));
        entry.insert("action".into(), json!(token(&input.action, "unknown", 64)));
        entry.insert("status".into(), json!(status));
        if let Some(message) = input.message.as_deref().map(sanitize).filter(|m| !m.is_empty()) {
            entry.insert("message".into(), json!(message));
        }
        if let Some(duration) = input.duration_ms.filter(|d| d.is_finite()) {
            entry.insert("durationMs".into(), json!(duration.max(0.0).round() as u64));
        }
        if let Some(id) = &input.operation_id {
            entry.insert("operationId".into(), json!(token(id, "unknown", 96)));
        }
        if let Some(resource) = &input.resource {
            let mut value = Map::new();
            value.insert("type".into(), json!(token(&resource.kind, "resource", 64)));
            if let Some(id) = &resource.id {
                value.insert("id".into(), json!(token(id, "unknown", 96)));
            }
            entry.insert("resource".into(), Value::Object(value));
        }
        if let Some(kind) = &input.error_type {
            entry.insert("errorType".into(), json!(token(kind, "Error", 64)));
        }
        if let Some(code) = &input.error_code {
            entry.insert("errorCode".into(), json!(token(code, "unknown", 64)));
        }
        if let Some(stack) = input.stack.as_ref().filter(|s| !s.is_empty()) {
            let frames: Vec<String> = stack.iter().take(5).map(|f| sanitize(f).chars().take(240).collect()).filter(|f: &String| !f.is_empty()).collect();
            entry.insert("stack".into(), json!(frames));
        }
        entry
    }

    /// Observational only: a broken log directory never blocks anything.
    pub fn record(&self, input: EventInput) {
        let entry = self.normalize(&input);
        let line = format!("{}\n", Value::Object(entry));
        if line.len() as u64 > MAX_LOG_BYTES {
            return;
        }
        let _guard = self.lock.lock().unwrap();
        let _ = (|| -> std::io::Result<()> {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            let size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
            if size + line.len() as u64 > MAX_LOG_BYTES {
                let previous = self.path.with_extension("jsonl.1");
                let _ = fs::remove_file(&previous);
                let _ = fs::rename(&self.path, &previous);
            }
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&self.path)?.write_all(line.as_bytes())
        })();
    }

    pub fn all(&self) -> Vec<Value> {
        let _guard = self.lock.lock().unwrap();
        let mut entries = Vec::new();
        for path in [self.path.with_extension("jsonl.1"), self.path.clone()] {
            let Ok(text) = fs::read_to_string(&path) else { continue };
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    let valid = ["timestamp", "category", "action", "status"].iter().all(|key| value.get(key).is_some());
                    if valid {
                        entries.push(value);
                    }
                }
            }
        }
        entries
    }

    pub fn list(&self, limit: Option<f64>) -> Vec<Value> {
        let limit = limit.unwrap_or(100.0).round().clamp(1.0, 500.0) as usize;
        let entries = self.all();
        let start = entries.len().saturating_sub(limit);
        entries[start..].to_vec()
    }
}
