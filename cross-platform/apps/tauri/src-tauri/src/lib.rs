//! Notebook desktop shell (Tauri 2).
//!
//! The web view runs the shared React renderer; this process provides the
//! `window.notebookDesktop` capabilities the renderer expects: WebDAV sync,
//! keychain secrets, files, notifications, diagnostics and a safe shutdown
//! that always lets the renderer save pending edits first.

mod ai;
mod automation;
mod diagnostics;
mod secrets;
mod sync_commands;
mod updater;
use notebook_sync::webdav;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
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
pub(crate) const MAIN: &str = "main";

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
    /// The user's global shortcut for the AI inbox (None = not bound).
    inbox_shortcut: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>,
    /// Files opened with Notebook (Dock icon, Finder "Open With") not yet taken by the renderer.
    inbox_pending: Mutex<Vec<std::path::PathBuf>>,
}

pub(crate) type CommandResult<T> = Result<T, String>;

pub(crate) fn record(app: &AppHandle, event: EventInput) {
    app.state::<AppState>().diagnostics.record(event);
}

pub(crate) fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
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
        automation::stop(&app);
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

// ---------------------------------------------------------------------------
// AI inbox: a global shortcut and the Dock icon both open a drop window in
// the renderer, which reads files handed to the app here.

fn quick_capture_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    // ⇧⌘N on the Mac; the Windows key is mostly taken by the system, so Ctrl+Alt+Shift+N there.
    let modifiers = if cfg!(target_os = "macos") { Modifiers::SUPER | Modifiers::SHIFT } else { Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT };
    Shortcut::new(Some(modifiers), Code::KeyN)
}

/// `source`: "shortcut" and "menu" also read the clipboard; "open" only takes opened files.
fn open_inbox(app: &AppHandle, source: &str) {
    show_main(app);
    let _ = app.emit_to(MAIN, "notebook:inbox", source);
}

/// Binds (or with `None` unbinds) the inbox shortcut, e.g. "Control+Alt+KeyN".
#[tauri::command]
fn inbox_shortcut_set(app: AppHandle, state: State<'_, AppState>, accelerator: Option<String>) -> CommandResult<()> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let next = match accelerator.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Some(value.parse::<Shortcut>().map_err(|error| format!("无法识别这个快捷键：{error}"))?),
        None => None,
    };
    let mut current = state.inbox_shortcut.lock().unwrap();
    if *current == next {
        return Ok(());
    }
    let shortcuts = app.global_shortcut();
    if let Some(next) = next {
        if next == quick_capture_shortcut() {
            return Err("这个快捷键已经用于快速记录（⇧⌘N）".into());
        }
        shortcuts.register(next).map_err(|error| format!("快捷键无法注册，可能已被其他应用占用：{error}"))?;
    }
    if let Some(previous) = *current {
        let _ = shortcuts.unregister(previous);
    }
    *current = next;
    Ok(())
}

#[cfg(target_os = "macos")]
extern "C" {
    fn notebook_pasteboard_file_paths() -> *mut std::os::raw::c_char;
    fn notebook_pasteboard_string(kind: *const std::os::raw::c_char) -> *mut std::os::raw::c_char;
    fn notebook_pasteboard_change_count() -> std::os::raw::c_long;
    fn notebook_free_string(value: *mut std::os::raw::c_char);
}

#[cfg(target_os = "macos")]
fn take_c_string(pointer: *mut std::os::raw::c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    // SAFETY: the pointer comes from strdup in native/pasteboard.m and is freed exactly once here.
    let value = unsafe { std::ffi::CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
    unsafe { notebook_free_string(pointer) };
    Some(value)
}

/// A stable, non-negative stamp of copied text (stands in for a change counter).
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn text_stamp(text: &str) -> i64 {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    i64::from_be_bytes(digest[..8].try_into().unwrap()) & i64::MAX
}

fn read_paths(paths: Vec<std::path::PathBuf>) -> (Vec<PickedFile>, Vec<String>) {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() && (meta.len() as usize) <= MAX_FILE_BYTES => match std::fs::read(&path) {
                Ok(data) => files.push(PickedFile { name, data_base64: base64::engine::general_purpose::STANDARD.encode(data) }),
                Err(error) => skipped.push(format!("{name}: {error}")),
            },
            Ok(meta) if meta.is_file() => skipped.push(format!("{name}: 超过 100 MB")),
            Ok(_) => skipped.push(format!("{name}: 是文件夹")),
            Err(error) => skipped.push(format!("{name}: {error}")),
        }
    }
    (files, skipped)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardSnapshot {
    /// Changes whenever anything is copied; lets the renderer skip what it already took.
    change_count: i64,
    files: Vec<PickedFile>,
    /// Folders and unreadable files among the copied items.
    skipped: Vec<String>,
    image: Option<ClipboardImage>,
    html: Option<String>,
    text: Option<String>,
}

/// What is copied right now: Finder files, an image, HTML and/or text.
#[tauri::command]
async fn clipboard_snapshot(app: AppHandle) -> CommandResult<ClipboardSnapshot> {
    #[cfg(target_os = "macos")]
    let (change_count, paths, html, text) = tauri::async_runtime::spawn_blocking(|| unsafe {
        let paths = take_c_string(notebook_pasteboard_file_paths()).map(|value| value.lines().map(std::path::PathBuf::from).collect::<Vec<_>>()).unwrap_or_default();
        let html = take_c_string(notebook_pasteboard_string(c"public.html".as_ptr()));
        let text = take_c_string(notebook_pasteboard_string(c"public.utf8-plain-text".as_ptr()));
        (notebook_pasteboard_change_count() as i64, paths, html, text)
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let (change_count, paths, html, text): (i64, Vec<std::path::PathBuf>, Option<String>, Option<String>) = {
        // No pasteboard change counter here: the text itself stands in for it, so
        // the shortcut does not offer the same copied text again.
        let text = app.clipboard().read_text().ok();
        let change_count = text.as_deref().map_or(0, text_stamp);
        (change_count, Vec::new(), None, text)
    };
    let (files, skipped) = if paths.is_empty() { (Vec::new(), Vec::new()) } else { tauri::async_runtime::spawn_blocking(move || read_paths(paths)).await.map_err(|e| e.to_string())? };
    // Copied files also put their names on the pasteboard as text; the files are what matters.
    let copied_files = !files.is_empty() || !skipped.is_empty();
    let image = if copied_files { None } else { clipboard_read_image(app.clone()) };
    Ok(ClipboardSnapshot {
        change_count,
        files,
        skipped,
        image,
        html: if copied_files { None } else { html.filter(|value| !value.trim().is_empty() && value.len() <= MAX_FILE_BYTES) },
        text: if copied_files { None } else { text.filter(|value| !value.trim().is_empty() && value.len() <= MAX_FILE_BYTES) },
    })
}

/// Files opened with the app since the last call (read once, then forgotten).
#[tauri::command]
async fn inbox_take(app: AppHandle) -> CommandResult<Vec<PickedFile>> {
    let paths: Vec<std::path::PathBuf> = std::mem::take(&mut *app.state::<AppState>().inbox_pending.lock().unwrap());
    let read = tauri::async_runtime::spawn_blocking(move || read_paths(paths))
    .await
    .map_err(|e| e.to_string())?;
    if !read.1.is_empty() {
        record(&app, EventInput::new("warning", "data", "inbox-open", "failed").message(read.1.join("; ")));
    }
    Ok(read.0)
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
    #[cfg(target_os = "macos")]
    let path = {
        let identifier = app.config().identifier.clone();
        app.path().home_dir().map(|home| home.join("Library/WebKit").join(identifier)).unwrap_or_default()
    };
    #[cfg(not(target_os = "macos"))]
    let path = app.path().app_local_data_dir().map(|dir| dir.join("EBWebView")).unwrap_or_default();
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

pub(crate) async fn blocking<T: Send + 'static>(app: &AppHandle, job: impl FnOnce(&AppState) -> CommandResult<T> + Send + 'static) -> CommandResult<T> {
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

#[cfg(target_os = "macos")]
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
            &MenuItem::with_id(app, "inbox", "AI 收纳文件…", true, None::<&str>)?,
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

/// Windows and Linux: a small menu bar. No predefined edit items (the web view
/// handles copy, paste and undo itself, and a menu accelerator for them would
/// swallow the keys), and no accelerators the vim-mode editor needs (Ctrl+P, Ctrl+R, Ctrl+W).
#[cfg(not(target_os = "macos"))]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let separator = || PredefinedMenuItem::separator(app);
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "quick-capture", "快速记录（Ctrl+Alt+Shift+N）", true, None::<&str>)?,
            &MenuItem::with_id(app, "inbox", "AI 收纳文件…", true, None::<&str>)?,
            &MenuItem::with_id(app, "command-palette", "命令面板…", true, None::<&str>)?,
            &separator()?,
            &MenuItem::with_id(app, "check-updates", "检查更新…", true, None::<&str>)?,
            &separator()?,
            &MenuItem::with_id(app, "close-window", "关闭窗口", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "退出 Notebook", true, Some("CmdOrCtrl+Q"))?,
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
            &MenuItem::with_id(app, "reload", "重新载入", true, Some("F5"))?,
            &MenuItem::with_id(app, "devtools", "开发者工具", true, Some("CmdOrCtrl+Alt+I"))?,
        ],
    )?;
    Menu::with_items(app, &[&file_menu, &view_menu])
}

/// The Mac menu bar wants a black "template" glyph; the Windows tray needs the coloured app icon.
#[cfg(target_os = "macos")]
const TRAY_ICON: &[u8] = include_bytes!("../../../renderer/public/notebook-trayTemplate@2x.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// Menu bar icon (as in the Electron app): quick capture, open, check for
/// updates, quit. Menu events go through the global `on_menu` handler.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "quick-capture", "快速记录", true, None::<&str>)?,
            &MenuItem::with_id(app, "inbox", "AI 收纳剪贴板…", true, None::<&str>)?,
            &MenuItem::with_id(app, "open-main", "打开 Notebook", true, None::<&str>)?,
            &MenuItem::with_id(app, "check-updates", "检查更新…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("notebook-tray")
        .icon(tauri::image::Image::from_bytes(TRAY_ICON)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Notebook")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
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
        "open-main" => show_main(app),
        "close-window" => hide_after_flush(app),
        "quick-capture" => {
            show_main(app);
            let _ = app.emit_to(MAIN, "notebook:quick-capture", ());
        }
        "inbox" => open_inbox(app, "menu"),
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
            app.manage(automation::Automation::default());
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
                inbox_shortcut: Mutex::new(None),
                inbox_pending: Mutex::new(Vec::new()),
            });
            record(&handle, EventInput::new("info", "app", "started", "success").message(format!("Notebook {version} · Tauri {} · {} {}", tauri::VERSION, std::env::consts::OS, std::env::consts::ARCH)));

            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));

            // Global quick capture, as in the Electron app.
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                let capture = quick_capture_shortcut();
                handle.plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            if *shortcut == capture {
                                on_menu(app, "quick-capture");
                            } else if *app.state::<AppState>().inbox_shortcut.lock().unwrap() == Some(*shortcut) {
                                open_inbox(app, "shortcut");
                            }
                        })
                        .build(),
                )?;
                if let Err(error) = handle.global_shortcut().register(capture) {
                    record(&handle, EventInput::new("warning", "app", "global-shortcut", "failed").message(error.to_string()));
                }
            }

            updater::start_background(handle.clone());
            automation::initialize(&handle);
            build_tray(&handle)?;

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
            sync_commands::webdav_test,
            sync_commands::webdav_pull,
            sync_commands::webdav_object_get,
            sync_commands::webdav_push,
            sync_commands::webdav_rebuild_journal,
            sync_commands::webdav_cancel,
            sync_commands::webdav_recent_requests,
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
            automation::automation_state,
            automation::automation_configure,
            automation::automation_regenerate_token,
            automation::automation_respond,
            inbox_shortcut_set,
            inbox_take,
            clipboard_snapshot,
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
        // Files dropped on the Dock icon or opened with Notebook go to the AI inbox.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            let paths: Vec<_> = urls.iter().filter_map(|url| url.to_file_path().ok()).collect();
            if !paths.is_empty() {
                app.state::<AppState>().inbox_pending.lock().unwrap().extend(paths);
                open_inbox(app, "open");
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

#[cfg(test)]
mod tests {
    use super::text_stamp;

    #[test]
    fn text_stamp_is_stable_and_not_negative() {
        assert_eq!(text_stamp("hello"), text_stamp("hello"));
        assert_ne!(text_stamp("hello"), text_stamp("hello!"));
        assert!(text_stamp("任意文字") >= 0);
    }
}
