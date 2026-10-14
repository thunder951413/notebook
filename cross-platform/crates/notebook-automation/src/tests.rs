use super::*;
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};

/// Answers every forwarded request from a background thread, like the renderer.
struct EchoRenderer {
    ready: AtomicBool,
    sender: Mutex<mpsc::Sender<BridgeRequest>>,
}

impl Forwarder for EchoRenderer {
    fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    fn forward(&self, request: &BridgeRequest) -> Result<(), String> {
        self.sender.lock().unwrap().send(request.clone()).map_err(|error| error.to_string())
    }
}

#[derive(Default)]
struct MemoryTokens(Mutex<Option<String>>);
impl TokenStore for MemoryTokens {
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    fn set(&self, token: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(token.to_string());
        Ok(())
    }
}

struct Harness {
    server: Arc<AutomationServer>,
    renderer: Arc<EchoRenderer>,
    seen: Arc<Mutex<Vec<BridgeRequest>>>,
    directory: PathBuf,
}

impl Harness {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("notebook-automation-{}", uuid::Uuid::new_v4()));
        let (sender, receiver) = mpsc::channel::<BridgeRequest>();
        let renderer = Arc::new(EchoRenderer { ready: AtomicBool::new(true), sender: Mutex::new(sender) });
        let server = Arc::new(AutomationServer::new(directory.join("automation-api.v1.json"), renderer.clone(), Arc::new(MemoryTokens::default()), Arc::new(|_: &str, _: &str, _: &str, _: String| {})));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let responder = Arc::downgrade(&server);
        let log = seen.clone();
        std::thread::spawn(move || {
            for request in receiver {
                log.lock().unwrap().push(request.clone());
                let Some(server) = responder.upgrade() else { break };
                let response = match request.operation.as_str() {
                    "get-page" if request.payload["pageId"] == "missing" => BridgeResponse { id: request.id, ok: false, result: None, error: Some(BridgeError { code: "not_found".into(), message: "页面不存在".into() }) },
                    "list-proposals" => BridgeResponse { id: request.id, ok: false, result: None, error: Some(BridgeError { code: "boom".into(), message: "secret stack trace".into() }) },
                    "guide" => continue, // never answered: exercises the timeout path when needed
                    _ => BridgeResponse { id: request.id, ok: true, result: Some(json!({ "operation": request.operation, "payload": request.payload })), error: None },
                };
                server.respond(response);
            }
        });
        Self { server, renderer, seen, directory }
    }

    fn port(&self) -> u16 {
        self.server.state(false).port
    }

    fn token(&self) -> String {
        self.server.state(true).token.unwrap()
    }

    /// Minimal HTTP/1.1 client: returns (status, JSON body).
    fn call(&self, method: &str, path: &str, headers: &[(&str, String)], body: &str) -> (u16, Value) {
        let mut stream = TcpStream::connect((LOOPBACK_HOST, self.port())).unwrap();
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {LOOPBACK_HOST}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        request.push_str(body);
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let status = response.split(' ').nth(1).unwrap().parse().unwrap();
        let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn authorized(&self) -> Vec<(&'static str, String)> {
        vec![("Authorization", format!("Bearer {}", self.token()))]
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.stop();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn routes_match_the_electron_api() {
    assert_eq!(route("GET", "/v1/guide").unwrap().0, "guide");
    assert_eq!(route("GET", "/v1/openapi.json").unwrap().0, "openapi");
    let (operation, payload) = route("GET", "/v1/pages?query=%E4%BC%9A%E8%AE%AE&limit=5&cursor=c1").unwrap();
    assert_eq!(operation, "list-pages");
    assert_eq!(payload, json!({ "query": "会议", "limit": 5.0, "cursor": "c1" }));
    assert_eq!(route("GET", "/v1/pages/a%2Fb").unwrap().1, json!({ "pageId": "a/b" }));
    assert_eq!(route("GET", "/v1/proposals/p-1").unwrap(), ("get-proposal", json!({ "proposalId": "p-1" })));
    assert_eq!(route("POST", "/v1/proposals").unwrap().0, "create-proposal");
    assert!(route("DELETE", "/v1/pages/x").is_none());
    assert!(route("GET", "/v1/pages/a/b").is_none());
    assert!(route("GET", "/admin").is_none());
}

#[test]
fn ports_and_tokens() {
    assert_eq!(valid_port(80), DEFAULT_PORT);
    assert_eq!(valid_port(70_000), DEFAULT_PORT);
    assert_eq!(valid_port(48_000), 48_000);
    let (first, second) = (new_token(), new_token());
    assert!(first.len() >= 43 && first != second);
    assert!(constant_time_equal("abc", "abc") && !constant_time_equal("abc", "abd") && !constant_time_equal("abc", "ab"));
}

#[test]
fn forwards_authenticated_requests_and_maps_renderer_errors() {
    let harness = Harness::new();
    let state = harness.server.configure(true, 0).unwrap();
    assert!(state.enabled && state.renderer_ready && state.token.is_some());
    assert_ne!(harness.port(), 0);

    let (status, body) = harness.call("GET", "/v1/pages?query=x", &harness.authorized(), "");
    assert_eq!(status, 200);
    assert_eq!(body["operation"], "list-pages");

    let (status, body) = harness.call("POST", "/v1/proposals", &harness.authorized(), r#"{"title":"改写"}"#);
    assert_eq!((status, body["payload"]["title"].as_str()), (201, Some("改写")));
    assert_eq!(harness.call("POST", "/v1/proposals", &harness.authorized(), "{oops").0, 400);

    let (status, body) = harness.call("GET", "/v1/pages/missing", &harness.authorized(), "");
    assert_eq!((status, body["error"]["code"].as_str()), (404, Some("not_found")));
    let (status, body) = harness.call("GET", "/v1/proposals", &harness.authorized(), "");
    assert_eq!(status, 500);
    assert_eq!(body["error"]["message"], "Notebook 内部处理失败");
    assert!(!body.to_string().contains("secret"));
    assert_eq!(harness.call("GET", "/v1/unknown", &harness.authorized(), "").0, 404);
    assert!(harness.seen.lock().unwrap().iter().all(|request| request.operation != "unknown"));
}

#[test]
fn rejects_missing_tokens_browsers_and_unready_renderers() {
    let harness = Harness::new();
    harness.server.configure(true, 0).unwrap();
    assert_eq!(harness.call("GET", "/v1/pages", &[], "").0, 401);
    assert_eq!(harness.call("GET", "/v1/pages", &[("Authorization", "Bearer wrong".into())], "").0, 401);
    let mut browser = harness.authorized();
    browser.push(("Origin", "https://evil.example".into()));
    assert_eq!(harness.call("GET", "/v1/pages", &browser, "").0, 403);
    harness.renderer.ready.store(false, Ordering::SeqCst);
    assert_eq!(harness.call("GET", "/v1/pages", &harness.authorized(), "").0, 503);
    assert!(harness.seen.lock().unwrap().is_empty(), "rejected requests never reach the renderer");
}

#[test]
fn regenerated_token_replaces_the_old_one_and_config_persists() {
    let harness = Harness::new();
    harness.server.configure(true, 0).unwrap();
    let old = harness.token();
    harness.server.regenerate_token().unwrap();
    assert_eq!(harness.call("GET", "/v1/pages", &[("Authorization", format!("Bearer {old}"))], "").0, 401);
    assert_eq!(harness.call("GET", "/v1/pages", &harness.authorized(), "").0, 200);
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(harness.directory.join("automation-api.v1.json")).unwrap()).unwrap();
    assert_eq!(stored, json!({ "enabled": true, "port": 0 }));
    assert!(!stored.to_string().contains(&harness.token()), "the token lives in the token store, never in the config file");
    harness.server.configure(false, 0).unwrap();
    assert!(!harness.server.state(false).enabled);
    assert!(TcpStream::connect((LOOPBACK_HOST, harness.port())).is_err() || harness.port() == 0);
}
