//! Local automation API for external AI tools (port of the Electron
//! `automationServer.ts`).
//!
//! A loopback-only HTTP server (`127.0.0.1`) authenticated with a bearer
//! token. Each accepted request is forwarded to the renderer as an
//! [`BridgeRequest`]; the renderer answers through [`AutomationServer::respond`].
//! The Tauri shell supplies the [`Forwarder`] (an event to the main window)
//! and the [`TokenStore`] (the keychain); everything else lives here so it
//! can be tested without a window system.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const LOOPBACK_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 47831;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_PENDING_REQUESTS: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeRequest {
    pub id: String,
    pub operation: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeResponse {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationState {
    pub enabled: bool,
    pub port: u16,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub renderer_ready: bool,
}

/// Delivers a request to the renderer. `ready` reports whether a renderer is
/// currently able to answer.
pub trait Forwarder: Send + Sync + 'static {
    fn ready(&self) -> bool;
    fn forward(&self, request: &BridgeRequest) -> Result<(), String>;
}

/// Persistent, protected storage for the bearer token.
pub trait TokenStore: Send + Sync + 'static {
    fn get(&self) -> Option<String>;
    fn set(&self, token: &str) -> Result<(), String>;
}

/// Diagnostic sink: (level, action, status, message).
pub type Recorder = Arc<dyn Fn(&str, &str, &str, String) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredConfig {
    enabled: bool,
    port: u16,
}

struct Running {
    server: Arc<tiny_http::Server>,
    port: u16,
    thread: Option<JoinHandle<()>>,
}

type Pending = Arc<Mutex<HashMap<String, SyncSender<BridgeResponse>>>>;

pub struct AutomationServer {
    config_path: PathBuf,
    config: Mutex<StoredConfig>,
    token: Arc<Mutex<String>>,
    running: Mutex<Option<Running>>,
    pending: Pending,
    forwarder: Arc<dyn Forwarder>,
    tokens: Arc<dyn TokenStore>,
    recorder: Recorder,
}

pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Ports below 1024 or invalid values fall back to the default; 0 (any free
/// port) is accepted for tests.
pub fn valid_port(value: i64) -> u16 {
    if value == 0 || (1024..=65_535).contains(&value) { value as u16 } else { DEFAULT_PORT }
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Maps an HTTP request to a renderer operation (same routes as Electron).
pub fn route(method: &str, raw_url: &str) -> Option<(&'static str, Value)> {
    let url = url::Url::parse(&format!("http://{LOOPBACK_HOST}{raw_url}")).ok()?;
    let path = url.path();
    let query = |key: &str| url.query_pairs().find(|(name, _)| name == key).map(|(_, value)| value.into_owned());
    let decode = |segment: &str| percent_decode(segment);
    match (method, path) {
        ("GET", "/v1/guide") => Some(("guide", json!({}))),
        ("GET", "/v1/openapi.json") => Some(("openapi", json!({}))),
        ("GET", "/v1/pages") => {
            let limit = query("limit").and_then(|value| value.parse::<f64>().ok()).unwrap_or(100.0);
            let mut payload = json!({ "query": query("query").unwrap_or_default(), "limit": limit });
            if let Some(cursor) = query("cursor") {
                payload["cursor"] = Value::String(cursor);
            }
            Some(("list-pages", payload))
        }
        ("POST", "/v1/proposals") => Some(("create-proposal", Value::Null)),
        ("GET", "/v1/proposals") => Some(("list-proposals", json!({}))),
        ("GET", _) => {
            if let Some(id) = path.strip_prefix("/v1/pages/").filter(|id| !id.is_empty() && !id.contains('/')) {
                return Some(("get-page", json!({ "pageId": decode(id) })));
            }
            if let Some(id) = path.strip_prefix("/v1/proposals/").filter(|id| !id.is_empty() && !id.contains('/')) {
                return Some(("get-proposal", json!({ "proposalId": decode(id) })));
            }
            None
        }
        _ => None,
    }
}

fn percent_decode(value: &str) -> String {
    percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned()
}

/// HTTP status and JSON body for a failure.
fn failure(status: u16, code: &str, message: &str) -> (u16, Value) {
    (status, json!({ "error": { "code": code, "message": message } }))
}

impl AutomationServer {
    pub fn new(config_path: PathBuf, forwarder: Arc<dyn Forwarder>, tokens: Arc<dyn TokenStore>, recorder: Recorder) -> Self {
        let config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| StoredConfig {
                enabled: value["enabled"].as_bool().unwrap_or(false),
                port: valid_port(value["port"].as_i64().unwrap_or(DEFAULT_PORT as i64)),
            })
            .unwrap_or(StoredConfig { enabled: false, port: DEFAULT_PORT });
        let token = tokens.get().filter(|token| token.len() >= 32).unwrap_or_else(new_token);
        let _ = tokens.set(&token);
        Self {
            config_path,
            config: Mutex::new(config),
            token: Arc::new(Mutex::new(token)),
            running: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            forwarder,
            tokens,
            recorder,
        }
    }

    /// Starts the server when it was enabled in a previous session.
    pub fn initialize(&self) -> Result<(), String> {
        if self.config.lock().unwrap().enabled {
            self.start()?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let config = self.config.lock().unwrap().clone();
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = self.config_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, serde_json::to_vec(&config).unwrap()).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &self.config_path).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            error.to_string()
        })
    }

    pub fn state(&self, include_token: bool) -> AutomationState {
        let running = self.running.lock().unwrap();
        let port = running.as_ref().map(|running| running.port).unwrap_or_else(|| self.config.lock().unwrap().port);
        AutomationState {
            enabled: running.is_some(),
            port,
            base_url: format!("http://{LOOPBACK_HOST}:{port}"),
            token: include_token.then(|| self.token.lock().unwrap().clone()),
            renderer_ready: self.forwarder.ready(),
        }
    }

    pub fn configure(&self, enabled: bool, port: i64) -> Result<AutomationState, String> {
        let port = valid_port(port);
        let changed_port = {
            let mut config = self.config.lock().unwrap();
            let changed = config.port != port;
            *config = StoredConfig { enabled, port };
            changed
        };
        self.persist()?;
        let running = self.running.lock().unwrap().is_some();
        if !enabled {
            self.stop();
        } else if changed_port && running {
            self.stop();
            self.start()?;
        } else if !running {
            self.start()?;
        }
        Ok(self.state(true))
    }

    pub fn regenerate_token(&self) -> Result<AutomationState, String> {
        let token = new_token();
        self.tokens.set(&token)?;
        *self.token.lock().unwrap() = token;
        (self.recorder)("warning", "token-regenerated", "success", String::new());
        Ok(self.state(true))
    }

    /// Delivers the renderer's answer to the waiting HTTP request.
    pub fn respond(&self, response: BridgeResponse) {
        if let Some(sender) = self.pending.lock().unwrap().remove(&response.id) {
            let _ = sender.try_send(response);
        }
    }

    pub fn stop(&self) {
        let running = self.running.lock().unwrap().take();
        // Waiting requests fail with 503 rather than hanging until timeout.
        for (id, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.try_send(BridgeResponse { id, ok: false, result: None, error: Some(BridgeError { code: "stopped".into(), message: "Notebook 自动化接口已停止".into() }) });
        }
        if let Some(mut running) = running {
            running.server.unblock();
            if let Some(thread) = running.thread.take() {
                let _ = thread.join();
            }
            (self.recorder)("info", "server-stop", "success", String::new());
        }
    }

    fn start(&self) -> Result<(), String> {
        let port = self.config.lock().unwrap().port;
        let server = Arc::new(tiny_http::Server::http((LOOPBACK_HOST, port)).map_err(|error| format!("无法在 {LOOPBACK_HOST}:{port} 启动自动化接口：{error}"))?);
        let actual = server.server_addr().to_ip().map(|address| address.port()).unwrap_or(port);
        let context = RequestContext { token: self.token.clone(), pending: self.pending.clone(), forwarder: self.forwarder.clone(), recorder: self.recorder.clone() };
        let listener = server.clone();
        let thread = std::thread::Builder::new()
            .name("notebook-automation".into())
            .spawn(move || {
                for request in listener.incoming_requests() {
                    let context = context.clone();
                    std::thread::spawn(move || context.handle(request));
                }
            })
            .map_err(|error| error.to_string())?;
        *self.running.lock().unwrap() = Some(Running { server, port: actual, thread: Some(thread) });
        (self.recorder)("info", "server-start", "success", format!("{LOOPBACK_HOST}:{actual}"));
        Ok(())
    }
}

impl Drop for AutomationServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
struct RequestContext {
    token: Arc<Mutex<String>>,
    pending: Pending,
    forwarder: Arc<dyn Forwarder>,
    recorder: Recorder,
}

impl RequestContext {
    fn handle(&self, mut request: tiny_http::Request) {
        let started = std::time::Instant::now();
        let (status, body, operation) = match self.process(&mut request) {
            Ok((status, body, operation)) => (status, body, Some(operation)),
            Err((status, body)) => (status, body, None),
        };
        let level = if status >= 500 { "error" } else if status >= 400 { "warning" } else { "info" };
        let action = operation.unwrap_or("request");
        (self.recorder)(level, action, if status < 400 { "success" } else { "failed" }, format!("HTTP {status} · {} ms", started.elapsed().as_millis()));
        let text = body.to_string();
        let headers = [
            tiny_http::Header::from_bytes("content-type", "application/json; charset=utf-8").unwrap(),
            tiny_http::Header::from_bytes("cache-control", "no-store").unwrap(),
            tiny_http::Header::from_bytes("x-content-type-options", "nosniff").unwrap(),
        ];
        let mut response = tiny_http::Response::from_string(text).with_status_code(status);
        for header in headers {
            response.add_header(header);
        }
        let _ = request.respond(response);
    }

    fn header(request: &tiny_http::Request, name: &'static str) -> Option<String> {
        request.headers().iter().find(|header| header.field.equiv(name)).map(|header| header.value.as_str().to_string())
    }

    fn process(&self, request: &mut tiny_http::Request) -> Result<(u16, Value, &'static str), (u16, Value)> {
        // Browsers always send Origin on cross-site requests; a local tool never needs it.
        if Self::header(request, "Origin").is_some() {
            return Err(failure(403, "forbidden", "浏览器跨站请求不被允许"));
        }
        let authorization = Self::header(request, "Authorization").unwrap_or_default();
        let presented = authorization.strip_prefix("Bearer ").unwrap_or("");
        if presented.is_empty() || !constant_time_equal(presented, &self.token.lock().unwrap()) {
            return Err(failure(401, "unauthorized", "缺少或无效的 Bearer Token"));
        }
        let method = request.method().as_str().to_ascii_uppercase();
        let (operation, mut payload) = route(&method, request.url()).ok_or_else(|| failure(404, "not_found", "接口不存在"))?;
        if operation == "create-proposal" {
            let mut body = Vec::new();
            request.as_reader().take(MAX_BODY_BYTES as u64 + 1).read_to_end(&mut body).map_err(|_| failure(400, "request_error", "无法读取请求正文"))?;
            if body.len() > MAX_BODY_BYTES {
                return Err(failure(413, "request_error", "请求正文超过 2 MB 限制"));
            }
            payload = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).map_err(|_| failure(400, "request_error", "请求正文不是有效 JSON"))? };
        }
        let result = self.forward(operation, payload)?;
        Ok((if operation == "create-proposal" { 201 } else { 200 }, result, operation))
    }

    fn forward(&self, operation: &str, payload: Value) -> Result<Value, (u16, Value)> {
        if !self.forwarder.ready() {
            return Err(failure(503, "unavailable", "Notebook 界面尚未就绪"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver): (SyncSender<BridgeResponse>, Receiver<BridgeResponse>) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(failure(429, "busy", "自动化请求过多，请稍后重试"));
            }
            pending.insert(id.clone(), sender);
        }
        let request = BridgeRequest { id: id.clone(), operation: operation.to_string(), payload };
        if let Err(error) = self.forwarder.forward(&request) {
            self.pending.lock().unwrap().remove(&id);
            return Err(failure(503, "unavailable", &error));
        }
        let response = match receiver.recv_timeout(REQUEST_TIMEOUT) {
            Ok(response) => response,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(failure(504, "timeout", "Notebook 处理自动化请求超时"));
            }
        };
        if response.ok {
            return Ok(response.result.unwrap_or(Value::Null));
        }
        let error = response.error.unwrap_or(BridgeError { code: "renderer_error".into(), message: "自动化请求失败".into() });
        let status = match error.code.as_str() {
            "stale" => 409,
            "not_found" => 404,
            "validation_error" | "request_error" => 400,
            "stopped" => 503,
            _ => 500,
        };
        // Internal failures never leak renderer details to the caller.
        let message = if status == 500 { "Notebook 内部处理失败".to_string() } else { error.message };
        let code = if status == 500 { "internal_error".to_string() } else { error.code };
        Err(failure(status, &code, &message))
    }
}

#[cfg(test)]
mod tests;
