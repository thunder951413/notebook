//! Notebook desktop shell (Tauri 2).
//!
//! The web view runs the shared React renderer; this process provides the
//! `window.notebookDesktop` capabilities the renderer expects: WebDAV sync,
//! keychain secrets, files, notifications, diagnostics and a safe shutdown
//! that always lets the renderer save pending edits first.

mod ai;
mod diagnostics;
mod secrets;
mod updater;
use notebook_sync::webdav;

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use diagnostics::{Diagnostics, EventInput};
use secrets::Secrets;

const MAX_FILE_BYTES: usize = 100 * 1024 * 1024;
const MAIN: &str = "main";

static REQUEST_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f-]{36}$").unwrap());

pub struct AppState {
    http: reqwest::Client,
    ai_http: reqwest::Client,
    secrets: Secrets,
    diagnostics: Diagnostics,
    webdav_requests: Mutex<HashMap<String, CancellationToken>>,
    ai_requests: Mutex<HashMap<String, CancellationToken>>,
    flushes: Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>,
    quitting: AtomicBool,
    quit_in_progress: AtomicBool,
    zoom: Mutex<f64>,
    updater: updater::Updater,
}

type CommandResult<T> = Result<T, String>;

fn record(app: &AppHandle, event: EventInput) {
    app.state::<AppState>().diagnostics.record(event);
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Renderer flush handshake: the renderer saves drafts, reading positions and
// runs a bounded sync before the window hides, reloads or the app quits.

async fn flush_renderer(app: &AppHandle, timeout: Duration) -> Result<(), String> {
    let state = app.state::<AppState>();
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state.flushes.lock().unwrap().insert(id.clone(), sender);
    let started = Instant::now();
    if app.emit_to(MAIN, "notebook:flush-request", &id).is_err() {
        state.flushes.lock().unwrap().remove(&id);
        return Ok(());
    }
    let result = match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Ok(()),
        Err(_) => {
            state.flushes.lock().unwrap().remove(&id);
            Err("保存编辑内容超时".to_string())
        }
    };
    let event = match &result {
        Ok(()) => EventInput::new("info", "storage", "renderer-flush", "success"),
        Err(message) => EventInput::new("error", "storage", "renderer-flush", "failed").message(message.clone()),
    };
    state.diagnostics.record(event.operation(&id).duration(started.elapsed().as_millis()));
    result
}

#[tauri::command]
fn renderer_flush_complete(state: State<'_, AppState>, request_id: String, error: Option<String>) {
    if let Some(sender) = state.flushes.lock().unwrap().remove(&request_id) {
        let _ = sender.send(match error {
            Some(message) => Err(message),
            None => Ok(()),
        });
    }
}

fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.quit_in_progress.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let flushed = flush_renderer(&app, Duration::from_secs(8)).await;
        if let Err(message) = flushed {
            let dialog_app = app.clone();
            let quit_anyway = tauri::async_runtime::spawn_blocking(move || {
                dialog_app
                    .dialog()
                    .message(format!("编辑内容可能尚未保存（{message}）。\n\n建议先取消，等同步完成后再退出。"))
                    .title("无法确认已保存")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom("仍然退出".into(), "取消".into()))
                    .blocking_show()
            })
            .await
            .unwrap_or(false);
            if !quit_anyway {
                app.state::<AppState>().quit_in_progress.store(false, Ordering::SeqCst);
                return;
            }
        }
        record(&app, EventInput::new("info", "app", "stopped", "success"));
        app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

fn hide_after_flush(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Hiding keeps everything in memory, so even a failed flush loses nothing.
        let _ = flush_renderer(&app, Duration::from_secs(8)).await;
        if let Some(window) = main_window(&app) {
            if window.is_fullscreen().unwrap_or(false) {
                let _ = window.set_fullscreen(false);
                tokio::time::sleep(Duration::from_millis(700)).await;
            }
            let _ = window.hide();
        }
    });
}

fn reload_renderer(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match flush_renderer(&app, Duration::from_secs(8)).await {
            Ok(()) => {
                if let Some(window) = main_window(&app) {
                    let _ = window.eval("location.reload()");
                }
            }
            Err(message) => {
                app.dialog().message(format!("无法安全重新载入：{message}")).kind(MessageDialogKind::Error).show(|_| {});
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Window lifecycle

#[tauri::command]
fn app_ready(app: AppHandle) {
    show_main(&app);
}

/// Dock badge: actionable todos (overdue + due today); 0 clears it.
#[tauri::command]
fn set_badge(app: AppHandle, count: i64) {
    if let Some(window) = main_window(&app) {
        let _ = window.set_badge_count(if count > 0 { Some(count.min(999)) } else { None });
    }
}

#[tauri::command]
fn app_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "tauri": tauri::VERSION,
        "platform": std::env::consts::OS.replace("macos", "darwin"),
        "arch": std::env::consts::ARCH,
    })
}

// ---------------------------------------------------------------------------
// Platform commands

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> bool {
    let title: String = title.chars().take(160).collect();
    let body: String = body.chars().take(2000).collect();
    app.notification().builder().title(title).body(body).show().is_ok()
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> CommandResult<()> {
    let parsed = url::Url::parse(&url).map_err(|_| "链接格式不正确".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只能在浏览器中打开 HTTP(S) 链接".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
extern "C" {
    fn notebook_select_abc_input_source() -> i32;
}

#[tauri::command]
async fn input_source_use_abc(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = oneshot::channel();
        // Text Input Sources must be switched on the main thread.
        let scheduled = app.run_on_main_thread(move || {
            let result = unsafe { notebook_select_abc_input_source() };
            let _ = sender.send(result == 0);
        });
        if scheduled.is_err() {
            return false;
        }
        return tokio::time::timeout(Duration::from_millis(1500), receiver).await.ok().and_then(Result::ok).unwrap_or(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    name: String,
    data_base64: String,
}

#[tauri::command]
async fn files_pick_open(app: AppHandle) -> CommandResult<Vec<PickedFile>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Notebook 可导入文件", &["md", "markdown", "txt", "html", "htm", "json", "zip", "nbx"])
            .add_filter("所有文件", &["*"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for file in picked.unwrap_or_default() {
        let path = file.into_path().map_err(|e| e.to_string())?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let data = std::fs::read(&path).map_err(|e| format!("无法读取 {name}：{e}"))?;
        if data.len() > MAX_FILE_BYTES {
            return Err(format!("{name} 超过 100 MB 导入上限"));
        }
        files.push(PickedFile { name, data_base64: base64::engine::general_purpose::STANDARD.encode(data) });
    }
    Ok(files)
}

fn atomic_write(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = path.with_file_name(format!(".{}.{}.tmp", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
async fn files_pick_save(app: AppHandle, suggested_name: String, data_base64: String) -> CommandResult<bool> {
    let data = base64::engine::general_purpose::STANDARD.decode(data_base64).map_err(|_| "导出数据格式不正确".to_string())?;
    if data.len() > MAX_FILE_BYTES {
        return Err("导出文件超过 100 MB 上限".into());
    }
    let target = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(suggested_name).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(target) = target else { return Ok(false) };
    let path = target.into_path().map_err(|e| e.to_string())?;
    atomic_write(&path, &data).map_err(|e| format!("无法保存文件：{e}"))?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardImage {
    name: String,
    mime_type: String,
    data_base64: String,
}

#[tauri::command]
fn clipboard_read_image(app: AppHandle) -> Option<ClipboardImage> {
    let image = app.clipboard().read_image().ok()?;
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        return None;
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(image.rgba()).ok()?;
    }
    if png_bytes.is_empty() || png_bytes.len() > MAX_FILE_BYTES {
        return None;
    }
    let stamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true).replace(':', "-");
    Some(ClipboardImage { name: format!("粘贴图片-{stamp}.png"), mime_type: "image/png".into(), data_base64: base64::engine::general_purpose::STANDARD.encode(png_bytes) })
}

#[tauri::command]
fn storage_info(app: AppHandle) -> serde_json::Value {
    let identifier = app.config().identifier.clone();
    let path = app.path().home_dir().map(|home| home.join("Library/WebKit").join(identifier)).unwrap_or_default();
    serde_json::json!({ "path": path.to_string_lossy(), "source": "default" })
}

// ---------------------------------------------------------------------------
// Secrets. AI keys never return to the web view.

fn guard_secret_key(key: &str) -> CommandResult<()> {
    if key.starts_with("ai-provider-key:") {
        return Err("AI API Key 只能通过专用安全接口访问".into());
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(app: &AppHandle, job: impl FnOnce(&AppState) -> CommandResult<T> + Send + 'static) -> CommandResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || job(app.state::<AppState>().inner())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn secrets_get(app: AppHandle, key: String) -> CommandResult<Option<String>> {
    guard_secret_key(&key)?;
    blocking(&app, move |state| state.secrets.get(&key)).await
}

#[tauri::command]
async fn secrets_set(app: AppHandle, key: String, value: String) -> CommandResult<()> {
    guard_secret_key(&key)?;
    blocking(&app, move |state| state.secrets.set(&key, &value)).await
}

#[tauri::command]
async fn secrets_delete(app: AppHandle, key: String) -> CommandResult<()> {
    guard_secret_key(&key)?;
    blocking(&app, move |state| state.secrets.delete(&key)).await
}

// ---------------------------------------------------------------------------
// Diagnostics

#[tauri::command]
fn diagnostics_record(state: State<'_, AppState>, event: EventInput) {
    state.diagnostics.record(event);
}

#[tauri::command]
fn diagnostics_list(state: State<'_, AppState>, limit: Option<f64>) -> Vec<serde_json::Value> {
    state.diagnostics.list(limit)
}

#[tauri::command]
async fn diagnostics_export(app: AppHandle) -> CommandResult<Option<String>> {
    let name = format!("notebook-diagnostics-{}.jsonl", chrono::Utc::now().format("%Y-%m-%d"));
    let dialog_app = app.clone();
    let target = tauri::async_runtime::spawn_blocking(move || dialog_app.dialog().file().set_title("导出 Notebook 诊断日志").set_file_name(name).add_filter("JSON Lines", &["jsonl"]).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(target) = target else { return Ok(None) };
    let path = target.into_path().map_err(|e| e.to_string())?;
    let body: String = app.state::<AppState>().diagnostics.all().iter().map(|entry| format!("{entry}\n")).collect();
    atomic_write(&path, body.as_bytes()).map_err(|e| format!("无法保存诊断日志：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn diagnostics_reveal(app: AppHandle) -> CommandResult<()> {
    let state = app.state::<AppState>();
    state.diagnostics.record(EventInput::new("info", "diagnostics", "reveal-log", "success"));
    let path = state.diagnostics.path().clone();
    if !path.exists() {
        return app.opener().open_path(path.parent().unwrap_or(&path).to_string_lossy(), None::<&str>).map_err(|e| e.to_string());
    }
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// WebDAV sync

fn check_request_id(id: &str) -> CommandResult<()> {
    if REQUEST_ID.is_match(id) {
        Ok(())
    } else {
        Err("WebDAV 请求标识无效".into())
    }
}

/// Runs one WebDAV operation with a deadline, renderer cancellation and a
/// diagnostics record (started → success/failed) under the request id.
async fn webdav_operation<T, F>(app: &AppHandle, action: &str, request_id: &str, deadline: Duration, summarize: impl Fn(&T) -> String, operation: F) -> CommandResult<T>
where
    F: Future<Output = webdav::DavResult<T>>,
{
    check_request_id(request_id)?;
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    {
        let mut requests = state.webdav_requests.lock().unwrap();
        if requests.contains_key(request_id) {
            return Err("WebDAV 请求标识重复".into());
        }
        requests.insert(request_id.to_string(), token.clone());
    }
    let started = Instant::now();
    state.diagnostics.record(EventInput::new("info", "sync", action, "started").operation(request_id));
    let result = tokio::select! {
        outcome = tokio::time::timeout(deadline, operation) => match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error.message),
            Err(_) => Err(format!("WebDAV 操作超时（{} 秒）", deadline.as_secs())),
        },
        _ = token.cancelled() => Err("WebDAV 操作已取消".to_string()),
    };
    state.webdav_requests.lock().unwrap().remove(request_id);
    let elapsed = started.elapsed().as_millis();
    let event = match &result {
        Ok(value) => EventInput::new("info", "sync", action, "success").message(summarize(value)),
        Err(message) if message.contains("已取消") => EventInput::new("info", "sync", action, "cancelled").message(message.clone()),
        Err(message) => EventInput::new("error", "sync", action, "failed").message(message.clone()),
    };
    state.diagnostics.record(event.operation(request_id).duration(elapsed));
    result
}

const WEBDAV_DEADLINE: Duration = Duration::from_secs(60);

#[tauri::command]
async fn webdav_test(app: AppHandle, settings: webdav::Connection, request_id: String) -> CommandResult<webdav::TestResult> {
    let http = app.state::<AppState>().http.clone();
    webdav_operation(&app, "webdav-test", &request_id, WEBDAV_DEADLINE, |r: &webdav::TestResult| if r.ok { format!("{} ms", r.latency_ms) } else { r.message.clone() }, async move {
        Ok(webdav::test_connection(&http, &settings).await)
    })
    .await
}

#[tauri::command]
async fn webdav_pull(app: AppHandle, settings: webdav::Connection, known_seqs: HashMap<String, f64>, request_id: String) -> CommandResult<webdav::PullResult> {
    let http = app.state::<AppState>().http.clone();
    let known: HashMap<String, u64> = known_seqs.into_iter().filter(|(_, v)| v.is_finite() && *v >= 0.0).map(|(k, v)| (k, v as u64)).collect();
    webdav_operation(&app, "webdav-pull", &request_id, WEBDAV_DEADLINE, |r: &webdav::PullResult| format!("{} entries", r.entries.len()), async move {
        webdav::pull_journals(&http, &settings, &known).await
    })
    .await
}

#[tauri::command]
async fn webdav_object_get(app: AppHandle, settings: webdav::Connection, hash: String, request_id: String) -> CommandResult<tauri::ipc::Response> {
    let http = app.state::<AppState>().http.clone();
    let bytes = webdav_operation(&app, "webdav-object-get", &request_id, WEBDAV_DEADLINE, |b: &Vec<u8>| format!("{} bytes", b.len()), async move {
        webdav::get_object(&http, &settings, &hash).await
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObjectUpload {
    hash: String,
    data_base64: String,
}

#[tauri::command]
async fn webdav_push(app: AppHandle, settings: webdav::Connection, device_id: String, entries: Vec<webdav::Entry>, objects: Vec<ObjectUpload>, request_id: String, min_seq: Option<f64>) -> CommandResult<webdav::PushResult> {
    let http = app.state::<AppState>().http.clone();
    let mut decoded = Vec::with_capacity(objects.len());
    for object in objects {
        let data = base64::engine::general_purpose::STANDARD.decode(object.data_base64).map_err(|_| "对象数据格式不正确".to_string())?;
        decoded.push((object.hash, data));
    }
    let object_count = decoded.len();
    let floor = min_seq.filter(|v| v.is_finite() && *v > 0.0).map(|v| v as u64).unwrap_or(0);
    // Large first uploads carry many objects; allow time per object.
    let deadline = (WEBDAV_DEADLINE + Duration::from_secs(5 * object_count as u64)).min(Duration::from_secs(900));
    webdav_operation(&app, "webdav-push", &request_id, deadline, move |r: &webdav::PushResult| format!("{} entries · {object_count} objects", r.count), async move {
        for (hash, data) in decoded {
            webdav::put_object(&http, &settings, &hash, data).await?;
        }
        webdav::append_journal(&http, &settings, &device_id, entries, floor).await
    })
    .await
}

// ---------------------------------------------------------------------------
// Updates

#[tauri::command]
fn update_state(state: State<'_, AppState>) -> updater::UpdateState {
    state.updater.snapshot()
}

#[tauri::command]
async fn update_check(app: AppHandle) -> updater::UpdateState {
    updater::check(&app).await
}

#[tauri::command]
async fn update_download(app: AppHandle) -> updater::UpdateState {
    updater::download(&app).await
}

/// Swaps in the downloaded version after a normal, saving quit.
#[tauri::command]
fn update_install(app: AppHandle) -> CommandResult<bool> {
    updater::prepare_install(&app)?;
    record(&app, EventInput::new("info", "update", "install", "started"));
    request_quit(&app);
    Ok(true)
}

#[tauri::command]
fn update_open_release(app: AppHandle) -> CommandResult<()> {
    let url = app.state::<AppState>().updater.snapshot().release_url;
    open_external(app, url)
}

/// One-time hand-over from the Electron app: a 0600 JSON file written by the
/// migration script. It is read once and deleted immediately.
#[tauri::command]
fn legacy_import_take(app: AppHandle) -> Option<serde_json::Value> {
    let path = app.path().app_data_dir().ok()?.join("legacy-import.json");
    let text = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    let value: serde_json::Value = serde_json::from_str(&text?).ok()?;
    record(&app, EventInput::new("info", "migration", "legacy-import", "success"));
    Some(value)
}

#[tauri::command]
fn webdav_recent_requests() -> usize {
    webdav::recent_request_count()
}

#[tauri::command]
fn webdav_cancel(state: State<'_, AppState>, request_id: String) -> CommandResult<()> {
    check_request_id(&request_id)?;
    if let Some(token) = state.webdav_requests.lock().unwrap().get(&request_id) {
        token.cancel();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// AI

#[tauri::command]
async fn ai_complete(app: AppHandle, request: ai::ChatRequest) -> CommandResult<ai::ChatResponse> {
    let state = app.state::<AppState>();
    let id = request.request_id.clone();
    let token = CancellationToken::new();
    {
        let mut requests = state.ai_requests.lock().unwrap();
        if id.is_empty() || requests.contains_key(&id) {
            return Err("AI 请求标识无效或重复".into());
        }
        requests.insert(id.clone(), token.clone());
    }
    let started = Instant::now();
    let provider: String = request.provider.chars().take(30).collect();
    let model: String = request.model.chars().take(100).collect();
    let result = tokio::select! {
        outcome = ai::complete(&state.ai_http, &state.secrets, request) => outcome,
        _ = token.cancelled() => Err("AI 请求已取消".to_string()),
    };
    state.ai_requests.lock().unwrap().remove(&id);
    let event = match &result {
        Ok(response) => EventInput::new("info", "ai", "complete", "success").message(format!("模型 {}", response.model.clone().unwrap_or(model))),
        Err(message) if message.contains("已取消") => EventInput::new("info", "ai", "complete", "cancelled").message(format!("服务商 {provider} · 模型 {model}")),
        Err(_) => EventInput::new("error", "ai", "complete", "failed").message(format!("服务商 {provider} · 模型 {model}")),
    };
    state.diagnostics.record(event.duration(started.elapsed().as_millis()));
    result
}

#[tauri::command]
fn ai_cancel(state: State<'_, AppState>, request_id: String) {
    if let Some(token) = state.ai_requests.lock().unwrap().get(&request_id) {
        token.cancel();
    }
}

#[tauri::command]
async fn ai_key_set(app: AppHandle, provider: String, base_url: String, value: String) -> CommandResult<()> {
    let secret = value.trim().to_string();
    if secret.is_empty() || secret.len() > 20_000 {
        return Err("AI API Key 无效".into());
    }
    let key = ai::credential_key(&provider, &base_url)?;
    blocking(&app, move |state| state.secrets.set(&key, &secret)).await
}

#[tauri::command]
async fn ai_key_has(app: AppHandle, provider: String, base_url: String) -> CommandResult<bool> {
    let key = ai::credential_key(&provider, &base_url)?;
    blocking(&app, move |state| Ok(state.secrets.get(&key)?.is_some())).await
}

#[tauri::command]
async fn ai_key_delete(app: AppHandle, provider: String, base_url: String) -> CommandResult<()> {
    let key = ai::credential_key(&provider, &base_url)?;
    blocking(&app, move |state| state.secrets.delete(&key)).await
}

// ---------------------------------------------------------------------------
// Menu

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let separator = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Notebook",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 Notebook"), None)?,
            &MenuItem::with_id(app, "check-updates", "检查更新…", true, None::<&str>)?,
            &separator()?,
            &MenuItem::with_id(app, "command-palette", "命令面板…", true, Some("CmdOrCtrl+P"))?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some("隐藏 Notebook"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &separator()?,
            &MenuItem::with_id(app, "quit", "退出 Notebook", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "quick-capture", "快速记录（⇧⌘N）", true, None::<&str>)?,
            &separator()?,
            &MenuItem::with_id(app, "close-window", "关闭窗口", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;
    // WKWebView only receives copy/paste/undo shortcuts through these items.
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &MenuItem::with_id(app, "zoom-reset", "实际大小", true, Some("CmdOrCtrl+0"))?,
            &MenuItem::with_id(app, "zoom-in", "放大", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "zoom-out", "缩小", true, Some("CmdOrCtrl+-"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?,
            &separator()?,
            &MenuItem::with_id(app, "reload", "重新载入", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, "devtools", "开发者工具", true, Some("CmdOrCtrl+Alt+I"))?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[&PredefinedMenuItem::minimize(app, Some("最小化"))?, &PredefinedMenuItem::maximize(app, Some("缩放"))?],
    )?;
    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}

fn set_zoom(app: &AppHandle, change: Option<f64>) {
    let state = app.state::<AppState>();
    let mut zoom = state.zoom.lock().unwrap();
    *zoom = match change {
        Some(step) => (*zoom + step).clamp(0.6, 2.0),
        None => 1.0,
    };
    if let Some(window) = main_window(app) {
        let _ = window.set_zoom(*zoom);
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => request_quit(app),
        "close-window" => hide_after_flush(app),
        "quick-capture" => {
            show_main(app);
            let _ = app.emit_to(MAIN, "notebook:quick-capture", ());
        }
        "command-palette" => {
            show_main(app);
            let _ = app.emit_to(MAIN, "notebook:command-palette", ());
        }
        "check-updates" => {
            show_main(app);
            let _ = app.emit_to(MAIN, "notebook:update-center", ());
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                updater::check(&app).await;
            });
        }
        "reload" => reload_renderer(app),
        "devtools" => {
            if let Some(window) = main_window(app) {
                window.open_devtools();
            }
        }
        "zoom-in" => set_zoom(app, Some(0.1)),
        "zoom-out" => set_zoom(app, Some(-0.1)),
        "zoom-reset" => set_zoom(app, None),
        _ => {}
    }
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let version = app.package_info().version.to_string();
            let log_dir = app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir());
            let user_agent = format!("Notebook/{version}");
            let http = reqwest::Client::builder()
                .user_agent(&user_agent)
                .connect_timeout(Duration::from_secs(20))
                .pool_idle_timeout(Duration::from_secs(60))
                .build()?;
            let ai_http = reqwest::Client::builder()
                .user_agent(&user_agent)
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(120))
                .redirect(reqwest::redirect::Policy::none())
                .build()?;
            app.manage(AppState {
                http,
                ai_http,
                secrets: Secrets::default(),
                diagnostics: Diagnostics::new(log_dir, version.clone()),
                webdav_requests: Mutex::new(HashMap::new()),
                ai_requests: Mutex::new(HashMap::new()),
                flushes: Mutex::new(HashMap::new()),
                quitting: AtomicBool::new(false),
                quit_in_progress: AtomicBool::new(false),
                zoom: Mutex::new(1.0),
                updater: updater::Updater::new(version.clone()),
            });
            record(&handle, EventInput::new("info", "app", "started", "success").message(format!("Notebook {version} · Tauri {} · {} {}", tauri::VERSION, std::env::consts::OS, std::env::consts::ARCH)));

            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));

            // Global quick capture, as in the Electron app.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let capture = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyN);
                handle.plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if event.state() == ShortcutState::Pressed && *shortcut == capture {
                                on_menu(app, "quick-capture");
                            }
                        })
                        .build(),
                )?;
                if let Err(error) = handle.global_shortcut().register(capture) {
                    record(&handle, EventInput::new("warning", "app", "global-shortcut", "failed").message(error.to_string()));
                }
            }

            updater::start_background(handle.clone());

            // The window starts hidden and is shown once the renderer painted
            // (app_ready); this fallback covers a renderer that never reports.
            let fallback = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if let Some(window) = main_window(&fallback) {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing hides the window: sync keeps running and reopening is instant.
                api.prevent_close();
                hide_after_flush(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            set_badge,
            app_info,
            renderer_flush_complete,
            notify,
            open_external,
            input_source_use_abc,
            files_pick_open,
            files_pick_save,
            clipboard_read_image,
            storage_info,
            secrets_get,
            secrets_set,
            secrets_delete,
            diagnostics_record,
            diagnostics_list,
            diagnostics_export,
            diagnostics_reveal,
            webdav_test,
            webdav_pull,
            webdav_object_get,
            webdav_push,
            webdav_cancel,
            webdav_recent_requests,
            legacy_import_take,
            update_state,
            update_check,
            update_download,
            update_install,
            update_open_release,
            ai_complete,
            ai_cancel,
            ai_key_set,
            ai_key_has,
            ai_key_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Notebook");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // Quit from the Dock or the system: save first, then exit.
            if code.is_none() && !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows, .. } => {
            if !has_visible_windows {
                show_main(app);
            }
        }
        _ => {}
    });
}
