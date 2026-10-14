//! Tauri glue for the local automation API (crate `notebook-automation`):
//! requests reach the renderer as `notebook:automation-request` events and
//! come back through the `automation_respond` command. The bearer token is
//! kept in the keychain item shared with the other secrets.

use std::sync::{Arc, OnceLock};

use notebook_automation::{AutomationServer, AutomationState, BridgeRequest, BridgeResponse, Forwarder, TokenStore};
use tauri::{AppHandle, Emitter, Manager};

use crate::diagnostics::EventInput;
use crate::{blocking, main_window, record, AppState, CommandResult, MAIN};

const TOKEN_KEY: &str = "automation-api-token";

struct WindowForwarder(AppHandle);

impl Forwarder for WindowForwarder {
    fn ready(&self) -> bool {
        main_window(&self.0).is_some()
    }
    fn forward(&self, request: &BridgeRequest) -> Result<(), String> {
        self.0.emit_to(MAIN, "notebook:automation-request", request).map_err(|error| error.to_string())
    }
}

struct KeychainTokens(AppHandle);

impl TokenStore for KeychainTokens {
    fn get(&self) -> Option<String> {
        self.0.state::<AppState>().secrets.get(TOKEN_KEY).ok().flatten()
    }
    fn set(&self, token: &str) -> Result<(), String> {
        self.0.state::<AppState>().secrets.set(TOKEN_KEY, token)
    }
}

#[derive(Default)]
pub struct Automation(OnceLock<Arc<AutomationServer>>);

/// Created on first use (or at startup in the background) so reading the
/// keychain never blocks window creation.
fn server(app: &AppHandle) -> Arc<AutomationServer> {
    app.state::<Automation>()
        .0
        .get_or_init(|| {
            let config = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir()).join("automation-api.v1.json");
            let recorder_app = app.clone();
            Arc::new(AutomationServer::new(
                config,
                Arc::new(WindowForwarder(app.clone())),
                Arc::new(KeychainTokens(app.clone())),
                Arc::new(move |level: &str, action: &str, status: &str, message: String| {
                    let event = EventInput::new(level, "automation", action, status);
                    record(&recorder_app, if message.is_empty() { event } else { event.message(message) });
                }),
            ))
        })
        .clone()
}

/// Starts the API in the background when it was enabled last time.
pub fn initialize(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = server(&app).initialize() {
            record(&app, EventInput::new("error", "automation", "server-start", "failed").message(error));
        }
    });
}

pub fn stop(app: &AppHandle) {
    if let Some(server) = app.state::<Automation>().0.get() {
        server.stop();
    }
}

#[tauri::command]
pub async fn automation_state(app: AppHandle) -> CommandResult<AutomationState> {
    let handle = app.clone();
    blocking(&app, move |_| Ok(server(&handle).state(true))).await
}

#[tauri::command]
pub async fn automation_configure(app: AppHandle, enabled: bool, port: f64) -> CommandResult<AutomationState> {
    let handle = app.clone();
    blocking(&app, move |_| server(&handle).configure(enabled, port as i64)).await
}

#[tauri::command]
pub async fn automation_regenerate_token(app: AppHandle) -> CommandResult<AutomationState> {
    let handle = app.clone();
    blocking(&app, move |_| server(&handle).regenerate_token()).await
}

#[tauri::command]
pub fn automation_respond(app: AppHandle, response: BridgeResponse) {
    if let Some(server) = app.state::<Automation>().0.get() {
        server.respond(response);
    }
}
