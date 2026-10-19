//! WebDAV sync commands: each runs on the Rust side with a deadline,
//! renderer cancellation and a diagnostics record under its request id.

use std::collections::HashMap;
use std::future::Future;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use base64::Engine;
use notebook_sync::webdav;
use regex::Regex;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::diagnostics::EventInput;
use crate::{AppState, CommandResult};

static REQUEST_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f-]{36}$").unwrap());

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
pub(crate) async fn webdav_test(app: AppHandle, settings: webdav::Connection, request_id: String) -> CommandResult<webdav::TestResult> {
    let http = app.state::<AppState>().http.clone();
    webdav_operation(&app, "webdav-test", &request_id, WEBDAV_DEADLINE, |r: &webdav::TestResult| if r.ok { format!("{} ms", r.latency_ms) } else { r.message.clone() }, async move {
        Ok(webdav::test_connection(&http, &settings).await)
    })
    .await
}

#[tauri::command]
pub(crate) async fn webdav_pull(app: AppHandle, settings: webdav::Connection, known_seqs: HashMap<String, f64>, request_id: String) -> CommandResult<webdav::PullResult> {
    let http = app.state::<AppState>().http.clone();
    let known: HashMap<String, u64> = known_seqs.into_iter().filter(|(_, v)| v.is_finite() && *v >= 0.0).map(|(k, v)| (k, v as u64)).collect();
    webdav_operation(&app, "webdav-pull", &request_id, WEBDAV_DEADLINE, |r: &webdav::PullResult| format!("{} entries", r.entries.len()), async move {
        webdav::pull_journals(&http, &settings, &known).await
    })
    .await
}

#[tauri::command]
pub(crate) async fn webdav_object_get(app: AppHandle, settings: webdav::Connection, hash: String, request_id: String) -> CommandResult<tauri::ipc::Response> {
    let http = app.state::<AppState>().http.clone();
    let bytes = webdav_operation(&app, "webdav-object-get", &request_id, WEBDAV_DEADLINE, |b: &Vec<u8>| format!("{} bytes", b.len()), async move {
        webdav::get_object(&http, &settings, &hash).await
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObjectUpload {
    hash: String,
    data_base64: String,
}

#[tauri::command]
pub(crate) async fn webdav_push(app: AppHandle, settings: webdav::Connection, device_id: String, entries: Vec<webdav::Entry>, objects: Vec<ObjectUpload>, request_id: String, min_seq: Option<f64>) -> CommandResult<webdav::PushResult> {
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

#[tauri::command]
pub(crate) async fn webdav_rebuild_journal(app: AppHandle, settings: webdav::Connection, device_id: String, request_id: String) -> CommandResult<webdav::RebuildResult> {
    let http = app.state::<AppState>().http.clone();
    webdav_operation(&app, "webdav-rebuild-journal", &request_id, WEBDAV_DEADLINE, |r: &webdav::RebuildResult| format!("floor {}{}", r.floor_seq, if r.backup.is_some() { " · backed up" } else { "" }), async move {
        webdav::rebuild_journal(&http, &settings, &device_id).await
    })
    .await
}


#[tauri::command]
pub(crate) fn webdav_recent_requests() -> usize {
    webdav::recent_request_count()
}

#[tauri::command]
pub(crate) fn webdav_cancel(state: State<'_, AppState>, request_id: String) -> CommandResult<()> {
    check_request_id(&request_id)?;
    if let Some(token) = state.webdav_requests.lock().unwrap().get(&request_id) {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_must_be_uuids() {
        assert!(check_request_id("123e4567-e89b-12d3-a456-426614174000").is_ok());
        for bad in ["", "abc", "../../etc/passwd", "123e4567-e89b-12d3-a456-42661417400g", "123e4567-e89b-12d3-a456-4266141740000"] {
            assert!(check_request_id(bad).is_err(), "{bad:?} must be rejected");
        }
    }
}
