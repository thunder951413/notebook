//! WebDAV transport for the v4 append-only journal repository (e.g. 坚果云).
//!
//! A faithful port of `apps/desktop/src/main/webdav.ts`; the protocol must stay
//! byte-compatible with the Electron and Android clients.
//!
//! Repository layout under `remotePath`:
//!   journal/<deviceID>.jsonl       per-device append-only change log
//!   journal/<deviceID>.head.json   commit marker written after the journal
//!   objects/<xx>/<sha256>          content-addressed note/attachment bytes
//!
//! Each device only ever writes its own journal file (single writer), so the
//! read-modify-write append below is race-free across devices.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub type Entry = Map<String, Value>;

const MAX_LOG_BYTES: usize = 100 * 1024 * 1024;
const MAX_OBJECT_BYTES: usize = 100 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_REVISION_ENTRIES: usize = MAX_ENTRIES;
const MAX_REVISION_BYTES: usize = MAX_LOG_BYTES;

static DEVICE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f-]{36}$").unwrap());
static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{64}$").unwrap());
static HEX64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{64}$").unwrap());

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub username: String,
    pub app_password: String,
    pub remote_path: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub sync_password: Option<String>,
}

/// Error carrying the HTTP status when there is one, so callers can tell a
/// missing file (404) apart from an authentication or server failure.
#[derive(Debug, Clone)]
pub struct DavError {
    pub status: Option<u16>,
    pub message: String,
}

impl DavError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { status: None, message: message.into() }
    }
    fn http(status: StatusCode) -> Self {
        Self {
            status: Some(status.as_u16()),
            message: format!("Invalid response: {} {}", status.as_u16(), status.canonical_reason().unwrap_or("")).trim_end().to_string(),
        }
    }
    fn is(&self, code: u16) -> bool {
        self.status == Some(code)
    }
}

impl fmt::Display for DavError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DavError {}

/// Wording matched by the renderer's `describeSyncError` ("network", "超时").
fn describe_reqwest(detail: &str, timeout: bool) -> String {
    if timeout {
        format!("网络请求超时（network timeout）：{detail}")
    } else {
        format!("网络请求失败（network）：{detail}")
    }
}

pub type DavResult<T> = Result<T, DavError>;

/// Full cause chain of a reqwest error without the request URL.
pub fn reqwest_error_text(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !parts.iter().any(|part| part.contains(&text)) {
            parts.push(text);
        }
        source = cause.source();
    }
    parts.join(": ")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub remote_path_exists: bool,
    pub latency_ms: u64,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub entries: Vec<Entry>,
    pub fingerprint: String,
    pub devices: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reset_devices: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub first_seq: u64,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct JournalHead {
    version: u64,
    device_id: String,
    last_seq: u64,
    journal_bytes: u64,
    journal_sha256: String,
    updated_at: String,
    state_entries: u64,
    history_entries: u64,
}

// ---------------------------------------------------------------------------
// Small helpers

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn entry_seq(entry: &Entry) -> u64 {
    match entry.get("seq") {
        Some(value) => value.as_u64().or_else(|| value.as_f64().filter(|v| *v >= 0.0).map(|v| v as u64)).unwrap_or(0),
        None => 0,
    }
}

fn text_field(entry: &Entry, key: &str) -> String {
    match entry.get(key) {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => "undefined".to_string(),
        Some(other) => other.to_string(),
    }
}

/// Bounded, short-lived caches; credentials are part of the opaque namespace.
struct SyncCache<T: Clone> {
    values: HashMap<String, (T, Instant, u64)>,
    limit: usize,
    counter: u64,
}

impl<T: Clone> SyncCache<T> {
    fn new(limit: usize) -> Self {
        Self { values: HashMap::new(), limit, counter: 0 }
    }
    fn get(&mut self, key: &str) -> Option<T> {
        let (value, expires, _) = self.values.get(key)?.clone();
        if expires <= Instant::now() {
            self.values.remove(key);
            return None;
        }
        self.counter += 1;
        self.values.insert(key.to_string(), (value.clone(), expires, self.counter));
        Some(value)
    }
    fn set(&mut self, key: String, value: T) {
        self.counter += 1;
        self.values.insert(key, (value, Instant::now() + Duration::from_secs(300), self.counter));
        if self.values.len() > self.limit {
            if let Some(oldest) = self.values.iter().min_by_key(|(_, (_, _, order))| *order).map(|(key, _)| key.clone()) {
                self.values.remove(&oldest);
            }
        }
    }
    fn invalidate(&mut self, prefix: &str) {
        self.values.retain(|key, _| !key.starts_with(prefix));
    }
}

static OBJECT_PRESENCE: LazyLock<Mutex<SyncCache<bool>>> = LazyLock::new(|| Mutex::new(SyncCache::new(4096)));
static DIRECTORIES: LazyLock<Mutex<SyncCache<bool>>> = LazyLock::new(|| Mutex::new(SyncCache::new(1024)));
static HEADS: LazyLock<Mutex<SyncCache<(String, JournalHead)>>> = LazyLock::new(|| Mutex::new(SyncCache::new(256)));

fn invalidate_all(namespace: &str) {
    DIRECTORIES.lock().unwrap().invalidate(namespace);
    OBJECT_PRESENCE.lock().unwrap().invalidate(namespace);
    HEADS.lock().unwrap().invalidate(namespace);
}

pub fn safe_remote_path(value: &str) -> DavResult<String> {
    let unsafe_path = || DavError::new(format!("远端同步目录不安全：{value}"));
    let normalized = value.trim().replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains('\0') {
        return Err(unsafe_path());
    }
    let mut parts: Vec<&str> = Vec::new();
    for segment in normalized.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                if parts.pop().is_none() {
                    return Err(unsafe_path());
                }
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(unsafe_path());
    }
    Ok(parts.join("/"))
}

pub fn validated_base_url(value: &str) -> DavResult<url::Url> {
    let base = url::Url::parse(value.trim()).map_err(|_| DavError::new("WebDAV 服务器地址不正确"))?;
    if base.scheme() == "https" {
        return Ok(base);
    }
    // HTTP is only useful for a local development/test endpoint. Requiring TLS
    // everywhere else keeps the app password and journal off clear-text links.
    let host = base.host_str().unwrap_or("").to_ascii_lowercase();
    if base.scheme() == "http" && matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return Ok(base);
    }
    Err(DavError::new("WebDAV 服务器必须使用 HTTPS；仅 localhost 可使用 HTTP"))
}

fn cache_namespace(connection: &Connection) -> String {
    let root = safe_remote_path(&connection.remote_path).unwrap_or_default();
    let key = serde_json::to_string(&[connection.base_url.trim(), connection.username.trim(), connection.app_password.as_str(), root.as_str()]).unwrap_or_default();
    format!("{}:", sha256_hex(key.as_bytes()))
}

/// The webdav npm client strips quotes from ETags. Weak validators must never
/// authorize reuse of a commit marker whose content may have changed.
fn strong_etag(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.get(..2).is_some_and(|prefix| prefix.eq_ignore_ascii_case("w/")) {
        return None;
    }
    Some(value.replace('"', ""))
}

const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

fn journal_path(root: &str, device: &str) -> String {
    format!("{root}/journal/{device}.jsonl")
}
fn journal_head_path(root: &str, device: &str) -> String {
    format!("{root}/journal/{device}.head.json")
}
fn object_path(root: &str, hash: &str) -> String {
    format!("{root}/objects/{}/{hash}", &hash[..2])
}
fn dirname(path: &str) -> &str {
    path.rsplit_once('/').map(|(head, _)| head).unwrap_or("")
}

// ---------------------------------------------------------------------------
// Request accounting: 坚果云 limits requests per 30 minutes across devices,
// so the renderer keeps automatic syncs inside this device's share.

const REQUEST_WINDOW: Duration = Duration::from_secs(30 * 60);
static REQUEST_TIMES: LazyLock<Mutex<std::collections::VecDeque<Instant>>> = LazyLock::new(|| Mutex::new(std::collections::VecDeque::new()));

fn record_request() {
    let now = Instant::now();
    let mut times = REQUEST_TIMES.lock().unwrap();
    times.push_back(now);
    while times.front().is_some_and(|first| now.duration_since(*first) > REQUEST_WINDOW) {
        times.pop_front();
    }
}

/// WebDAV requests sent in the last 30 minutes.
pub fn recent_request_count() -> usize {
    let now = Instant::now();
    REQUEST_TIMES.lock().unwrap().iter().filter(|time| now.duration_since(**time) <= REQUEST_WINDOW).count()
}

// ---------------------------------------------------------------------------
// Minimal WebDAV client

pub struct DavItem {
    pub name: String,
    pub etag: Option<String>,
}

pub struct Dav {
    http: reqwest::Client,
    base: String,
    authorization: String,
}

impl Dav {
    pub fn new(http: &reqwest::Client, connection: &Connection) -> DavResult<Self> {
        let base = validated_base_url(&connection.base_url)?;
        if connection.username.trim().is_empty() {
            return Err(DavError::new("请填写 WebDAV 用户名"));
        }
        if connection.app_password.is_empty() {
            return Err(DavError::new("请填写 WebDAV 应用密码"));
        }
        safe_remote_path(&connection.remote_path)?;
        let credentials = format!("{}:{}", connection.username.trim(), connection.app_password);
        Ok(Self {
            http: http.clone(),
            base: base.as_str().trim_end_matches('/').to_string(),
            authorization: format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(credentials)),
        })
    }

    fn url(&self, path: &str, collection: bool) -> String {
        let encoded: Vec<String> = path.split('/').filter(|s| !s.is_empty()).map(|s| utf8_percent_encode(s, SEGMENT).to_string()).collect();
        format!("{}/{}{}", self.base, encoded.join("/"), if collection { "/" } else { "" })
    }

    async fn send(&self, method: Method, url: String, depth: Option<&str>, body: Option<Vec<u8>>, content_type: Option<&str>) -> DavResult<reqwest::Response> {
        record_request();
        let mut request = self
            .http
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, &self.authorization)
            .header(reqwest::header::CACHE_CONTROL, "no-cache");
        if let Some(depth) = depth {
            request = request.header("Depth", depth);
        }
        if let Some(content_type) = content_type {
            request = request.header(reqwest::header::CONTENT_TYPE, content_type);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        request.send().await.map_err(|error| {
            let timeout = error.is_timeout();
            DavError::new(describe_reqwest(&reqwest_error_text(&error.without_url()), timeout))
        })
    }

    pub async fn mkcol(&self, path: &str) -> DavResult<()> {
        let response = self.send(Method::from_bytes(b"MKCOL").unwrap(), self.url(path, false), None, None, None).await?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(DavError::http(response.status()))
    }

    pub async fn put(&self, path: &str, data: Vec<u8>) -> DavResult<()> {
        let response = self.send(Method::PUT, self.url(path, false), None, Some(data), Some("application/octet-stream")).await?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(DavError::http(response.status()))
    }

    /// GET returning the body and the response ETag.
    pub async fn get(&self, path: &str, limit: usize) -> DavResult<(Vec<u8>, Option<String>)> {
        let response = self.send(Method::GET, self.url(path, false), None, None, None).await?;
        if !response.status().is_success() {
            return Err(DavError::http(response.status()));
        }
        if response.content_length().is_some_and(|length| length as usize > limit) {
            return Err(DavError::new("远端文件超过大小上限"));
        }
        let etag = response.headers().get(reqwest::header::ETAG).and_then(|value| value.to_str().ok()).map(str::to_string);
        let bytes = response.bytes().await.map_err(|error| DavError::new(describe_reqwest(&reqwest_error_text(&error.without_url()), false)))?;
        Ok((bytes.to_vec(), etag))
    }

    pub async fn get_text(&self, path: &str, limit: usize) -> DavResult<(String, Option<String>)> {
        let (bytes, etag) = self.get(path, limit).await?;
        Ok((String::from_utf8_lossy(&bytes).into_owned(), etag))
    }

    pub async fn exists(&self, path: &str) -> DavResult<bool> {
        let response = self.send(Method::from_bytes(b"PROPFIND").unwrap(), self.url(path, false), Some("0"), Some(PROPFIND_BODY.as_bytes().to_vec()), Some("application/xml; charset=utf-8")).await?;
        match response.status().as_u16() {
            200 | 207 => Ok(true),
            404 => Ok(false),
            _ => Err(DavError::http(response.status())),
        }
    }

    pub async fn list(&self, path: &str) -> DavResult<Vec<DavItem>> {
        let response = self.send(Method::from_bytes(b"PROPFIND").unwrap(), self.url(path, true), Some("1"), Some(PROPFIND_BODY.as_bytes().to_vec()), Some("application/xml; charset=utf-8")).await?;
        if !response.status().is_success() {
            return Err(DavError::http(response.status()));
        }
        let text = response.text().await.map_err(|error| DavError::new(describe_reqwest(&reqwest_error_text(&error.without_url()), false)))?;
        parse_multistatus(&text)
    }
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

fn parse_multistatus(text: &str) -> DavResult<Vec<DavItem>> {
    let document = roxmltree::Document::parse(text).map_err(|error| DavError::new(format!("WebDAV 目录响应无法解析：{error}")))?;
    let mut items = Vec::new();
    for response in document.descendants().filter(|node| node.is_element() && node.tag_name().name() == "response") {
        let Some(href) = response.descendants().find(|node| node.is_element() && node.tag_name().name() == "href").and_then(|node| node.text()) else { continue };
        let decoded = percent_decode_str(href.trim()).decode_utf8_lossy().into_owned();
        let Some(name) = decoded.trim_end_matches('/').rsplit('/').next().map(str::to_string) else { continue };
        if name.is_empty() {
            continue;
        }
        let etag = response
            .descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "getetag")
            .and_then(|node| node.text())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        items.push(DavItem { name, etag });
    }
    Ok(items)
}

async fn ensure_directory(dav: &Dav, path: &str, namespace: &str) -> DavResult<()> {
    // 坚果云 rejects nested MKCOL with 409 when the parent is missing, so every
    // segment is created from the root down. 201 and the usual already-exists
    // codes are both tolerated.
    let mut current = String::new();
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        if current.is_empty() {
            current = segment.to_string();
        } else {
            current = format!("{current}/{segment}");
        }
        if !namespace.is_empty() && DIRECTORIES.lock().unwrap().get(&format!("{namespace}{current}")).is_some() {
            continue;
        }
        if let Err(error) = dav.mkcol(&current).await {
            // 409 is a missing parent, not evidence that this directory exists.
            if !(error.is(405) || error.is(301) || error.is(302)) {
                return Err(error);
            }
        }
        if !namespace.is_empty() {
            DIRECTORIES.lock().unwrap().set(format!("{namespace}{current}"), true);
        }
    }
    Ok(())
}

async fn put_with_directory(dav: &Dav, connection: &Connection, path: &str, data: Vec<u8>) -> DavResult<()> {
    let namespace = cache_namespace(connection);
    let first = match ensure_directory(dav, dirname(path), &namespace).await {
        Ok(()) => dav.put(path, data.clone()).await,
        Err(error) => Err(error),
    };
    match first {
        Ok(()) => Ok(()),
        Err(error) if error.is(404) || error.is(409) => {
            // A directory removed on another device invalidates cached provisioning.
            DIRECTORIES.lock().unwrap().invalidate(&namespace);
            OBJECT_PRESENCE.lock().unwrap().invalidate(&namespace);
            ensure_directory(dav, dirname(path), &namespace).await?;
            dav.put(path, data).await
        }
        Err(error) => Err(error),
    }
}

// ---------------------------------------------------------------------------
// Journal format

/// Parse a journal file body into entries, tolerating a trailing newline.
fn parse_journal(text: &str, device: &str) -> DavResult<Vec<Entry>> {
    let mut entries = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: Entry = serde_json::from_str(trimmed).map_err(|error| DavError::new(format!("远端日志 {device}.jsonl 第 {} 行格式不正确：{error}", index + 1)))?;
        entries.push(entry);
    }
    Ok(entries)
}

struct Compacted {
    entries: Vec<Entry>,
    state_entries: usize,
    history_entries: usize,
}

/// Keep only the latest record per entity, preserving original seq values, so
/// other devices' per-device read cursors stay valid after the file shrinks.
fn compact_journal(entries: Vec<Entry>) -> Compacted {
    let mut state: HashMap<String, Entry> = HashMap::new();
    let mut revisions: HashMap<String, Entry> = HashMap::new();
    for entry in entries {
        let kind = text_field(&entry, "type");
        let key = format!("{kind}:{}", text_field(&entry, "id"));
        let target = if kind == "revision" { &mut revisions } else { &mut state };
        let replace = target.get(&key).map_or(true, |previous| entry_seq(&entry) > entry_seq(previous));
        if replace {
            target.insert(key, entry);
        }
    }
    let mut newest_revisions: Vec<Entry> = revisions.into_values().collect();
    newest_revisions.sort_by(|left, right| entry_seq(right).cmp(&entry_seq(left)));
    let mut history = Vec::new();
    let mut history_bytes = 0usize;
    for entry in newest_revisions {
        if history.len() >= MAX_REVISION_ENTRIES {
            break;
        }
        let serialized = serde_json::to_string(&entry).map(|text| text.len()).unwrap_or(0) + 1;
        if !history.is_empty() && history_bytes + serialized > MAX_REVISION_BYTES {
            break;
        }
        history_bytes += serialized;
        history.push(entry);
    }
    let state_entries = state.len();
    let history_entries = history.len();
    let mut all: Vec<Entry> = state.into_values().chain(history).collect();
    all.sort_by_key(entry_seq);
    Compacted { entries: all, state_entries, history_entries }
}

fn build_head(device: &str, body: &str, entries: &[Entry], state_entries: usize, history_entries: usize) -> JournalHead {
    JournalHead {
        version: 1,
        device_id: device.to_string(),
        last_seq: entries.iter().map(entry_seq).max().unwrap_or(0),
        journal_bytes: body.len() as u64,
        journal_sha256: sha256_hex(body.as_bytes()),
        updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        state_entries: state_entries as u64,
        history_entries: history_entries as u64,
    }
}

fn parse_head(text: &str, device: &str) -> DavResult<JournalHead> {
    if text.len() > MAX_HEAD_BYTES {
        return Err(DavError::new(format!("远端日志 {device}.head.json 超过 64 KiB 上限")));
    }
    let value: Value = serde_json::from_str(text).map_err(|_| DavError::new(format!("远端日志 {device}.head.json 格式不正确")))?;
    let invalid = || DavError::new(format!("远端日志 {device}.head.json 内容不正确"));
    let object = value.as_object().ok_or_else(invalid)?;
    let integer = |key: &str| object.get(key).and_then(Value::as_u64).filter(|value| *value <= 9_007_199_254_740_991);
    let text_value = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
    let head = JournalHead {
        version: integer("version").ok_or_else(invalid)?,
        device_id: text_value("deviceId").ok_or_else(invalid)?,
        last_seq: integer("lastSeq").ok_or_else(invalid)?,
        journal_bytes: integer("journalBytes").ok_or_else(invalid)?,
        journal_sha256: text_value("journalSha256").ok_or_else(invalid)?,
        updated_at: text_value("updatedAt").ok_or_else(invalid)?,
        state_entries: integer("stateEntries").ok_or_else(invalid)?,
        history_entries: integer("historyEntries").ok_or_else(invalid)?,
    };
    if head.version != 1 || head.device_id != device || head.journal_bytes as usize > MAX_LOG_BYTES || !HEX64.is_match(&head.journal_sha256) {
        return Err(invalid());
    }
    Ok(head)
}

// ---------------------------------------------------------------------------
// Operations

pub async fn test_connection(http: &reqwest::Client, connection: &Connection) -> TestResult {
    let started = Instant::now();
    let result: DavResult<bool> = async {
        let dav = Dav::new(http, connection)?;
        let root = safe_remote_path(&connection.remote_path)?;
        ensure_directory(&dav, &root, &cache_namespace(connection)).await?;
        dav.exists(&format!("{root}/journal")).await
    }
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(exists) => TestResult { ok: true, remote_path_exists: exists, latency_ms, message: String::new() },
        Err(error) => TestResult { ok: false, remote_path_exists: false, latency_ms, message: error.message },
    }
}

/// Pull all journal entries newer than the per-device sequence numbers the
/// client already consumed.
pub async fn pull_journals(http: &reqwest::Client, connection: &Connection, known_seqs: &HashMap<String, u64>) -> DavResult<PullResult> {
    let dav = Dav::new(http, connection)?;
    let root = safe_remote_path(&connection.remote_path)?;
    let namespace = cache_namespace(connection);
    let mut device_ids: Vec<String> = Vec::new();
    let mut devices_with_heads: HashSet<String> = HashSet::new();
    let mut head_etags: HashMap<String, String> = HashMap::new();
    match dav.list(&format!("{root}/journal")).await {
        Ok(items) => {
            for item in &items {
                if let Some(device) = item.name.strip_suffix(".jsonl") {
                    if DEVICE_ID.is_match(device) && !device_ids.iter().any(|known| known == device) {
                        device_ids.push(device.to_string());
                    }
                }
                if let Some(device) = item.name.strip_suffix(".head.json") {
                    if DEVICE_ID.is_match(device) {
                        devices_with_heads.insert(device.to_string());
                    }
                    if let Some(etag) = strong_etag(item.etag.as_deref()) {
                        head_etags.insert(device.to_string(), etag);
                    }
                }
            }
        }
        // A missing journal directory means an empty repository. Authentication
        // and server failures must remain visible to the caller.
        Err(error) if error.is(404) => invalidate_all(&namespace),
        Err(error) => return Err(error),
    }

    let mut entries: Vec<Entry> = Vec::new();
    let mut reset_devices: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for device in &device_ids {
        let mut known = known_seqs.get(device).copied().unwrap_or(0);
        let mut head: Option<JournalHead> = None;
        if devices_with_heads.contains(device) {
            let key = format!("{namespace}{device}");
            let etag = head_etags.get(device).cloned();
            let cached = etag.as_ref().and_then(|_| HEADS.lock().unwrap().get(&key));
            match cached {
                Some((cached_etag, cached_head)) if Some(&cached_etag) == etag.as_ref() => head = Some(cached_head),
                _ => match dav.get_text(&journal_head_path(&root, device), MAX_HEAD_BYTES * 2).await {
                    Ok((text, response_etag)) => {
                        let parsed = parse_head(&text, device)?;
                        // Only bind the body to the listing validator if GET
                        // confirms it; a concurrent writer may have changed it.
                        if let Some(etag) = &etag {
                            if strong_etag(response_etag.as_deref()).as_ref() == Some(etag) {
                                HEADS.lock().unwrap().set(key, (etag.clone(), parsed.clone()));
                            }
                        }
                        head = Some(parsed);
                    }
                    Err(error) if error.is(404) => {}
                    Err(error) => return Err(error),
                },
            }
            // A marker behind our cursor means the journal was deleted and
            // recreated; skipping it would hide every new record, so re-read.
            if let Some(head) = &head {
                if head.last_seq < known {
                    reset_devices.push(device.clone());
                    warnings.push(format!("{device} 的远端序号从 {known} 回退到 {}，已重新读取", head.last_seq));
                    known = 0;
                }
                // The marker is the commit point: never fetch the large journal
                // merely to confirm a sequence we already consumed.
                if known >= head.last_seq {
                    continue;
                }
            }
        }
        let text = match dav.get_text(&journal_path(&root, device), MAX_LOG_BYTES + 1).await {
            Ok((text, _)) => text,
            Err(error) if error.is(404) => continue,
            Err(error) => return Err(error),
        };
        if text.len() > MAX_LOG_BYTES {
            return Err(DavError::new(format!("远端日志 {device}.jsonl 超过 100 MB 上限")));
        }
        let journal = parse_journal(&text, device)?;
        let journal_last_seq = journal.iter().map(entry_seq).max().unwrap_or(0);
        if head.is_none() && journal_last_seq < known {
            reset_devices.push(device.clone());
            warnings.push(format!("{device} 的远端日志序号从 {known} 回退到 {journal_last_seq}，已重新读取"));
            known = 0;
        }
        if let Some(head) = &head {
            if text.len() as u64 != head.journal_bytes || sha256_hex(text.as_bytes()) != head.journal_sha256 {
                // The journal PUT succeeded but its marker PUT did not. Every row
                // is still a complete record, so only the committed range is used.
                warnings.push(format!("{device} 的日志与提交标记不一致（日志序号 {journal_last_seq}，标记 {}），仅读取已提交部分", head.last_seq));
            }
        }
        for mut entry in journal {
            let seq = entry_seq(&entry);
            if seq <= known || head.as_ref().is_some_and(|head| seq > head.last_seq) {
                continue;
            }
            entry.insert("deviceId".to_string(), Value::String(device.clone()));
            entries.push(entry);
        }
    }
    entries.sort_by(|left, right| {
        let left_device = text_field(left, "deviceId");
        let right_device = text_field(right, "deviceId");
        left_device.cmp(&right_device).then_with(|| entry_seq(left).cmp(&entry_seq(right)))
    });
    Ok(PullResult {
        entries,
        fingerprint: format!("{}|{}|{}", connection.base_url.trim(), connection.username.trim(), root),
        devices: device_ids,
        reset_devices,
        warnings,
    })
}

pub async fn get_object(http: &reqwest::Client, connection: &Connection, hash: &str) -> DavResult<Vec<u8>> {
    if !HASH.is_match(hash) {
        return Err(DavError::new(format!("对象哈希格式不正确：{hash}")));
    }
    let dav = Dav::new(http, connection)?;
    let root = safe_remote_path(&connection.remote_path)?;
    let (bytes, _) = dav.get(&object_path(&root, hash), MAX_OBJECT_BYTES + 1).await?;
    if bytes.len() > MAX_OBJECT_BYTES {
        return Err(DavError::new("远端对象超过 100 MB 上限"));
    }
    if sha256_hex(&bytes) != hash {
        return Err(DavError::new(format!("远端对象 {hash} 的 SHA-256 校验失败")));
    }
    Ok(bytes)
}

pub async fn put_object(http: &reqwest::Client, connection: &Connection, hash: &str, data: Vec<u8>) -> DavResult<()> {
    if !HASH.is_match(hash) {
        return Err(DavError::new(format!("对象哈希格式不正确：{hash}")));
    }
    if data.len() > MAX_OBJECT_BYTES {
        return Err(DavError::new("对象超过 100 MB 上限"));
    }
    if sha256_hex(&data) != hash {
        return Err(DavError::new("本地对象 SHA-256 校验失败"));
    }
    let dav = Dav::new(http, connection)?;
    let root = safe_remote_path(&connection.remote_path)?;
    let target = object_path(&root, hash);
    let cache_key = format!("{}{hash}", cache_namespace(connection));
    if OBJECT_PRESENCE.lock().unwrap().get(&cache_key).is_some() {
        return Ok(());
    }
    if dav.exists(&target).await? {
        OBJECT_PRESENCE.lock().unwrap().set(cache_key, true);
        return Ok(());
    }
    put_with_directory(&dav, connection, &target, data).await?;
    OBJECT_PRESENCE.lock().unwrap().set(cache_key, true);
    Ok(())
}

/// Append entries to this device's journal. WebDAV has no append primitive, so
/// the journal is fetched, extended locally and written back; this is safe
/// because only one device ever writes a given journal file.
pub async fn append_journal(http: &reqwest::Client, connection: &Connection, device: &str, new_entries: Vec<Entry>, min_seq: u64) -> DavResult<PushResult> {
    if !DEVICE_ID.is_match(device) {
        return Err(DavError::new(format!("设备 ID 不正确：{device}")));
    }
    let dav = Dav::new(http, connection)?;
    let root = safe_remote_path(&connection.remote_path)?;
    let path = journal_path(&root, device);
    let existing = match dav.get_text(&path, MAX_LOG_BYTES + 1).await {
        Ok((text, _)) => {
            if text.len() > MAX_LOG_BYTES {
                return Err(DavError::new(format!("远端日志 {device}.jsonl 超过 100 MB 上限")));
            }
            parse_journal(&text, device)?
        }
        Err(error) if error.is(404) => Vec::new(),
        Err(error) => return Err(error),
    };
    // Sequence numbers must never move backwards, even when the remote journal
    // was deleted: other devices filter by their last consumed sequence.
    let first_seq = existing.iter().map(entry_seq).max().unwrap_or(0).max(min_seq) + 1;
    let count = new_entries.len();
    let mut journal = existing;
    for (index, mut entry) in new_entries.into_iter().enumerate() {
        entry.remove("seq");
        entry.insert("seq".to_string(), Value::from(first_seq + index as u64));
        journal.push(entry);
    }
    let compacted = compact_journal(journal);
    if compacted.entries.len() > MAX_ENTRIES {
        return Err(DavError::new("设备日志条目数超过 10 万，请先压缩日志"));
    }
    let mut body = String::new();
    for entry in &compacted.entries {
        body.push_str(&serde_json::to_string(entry).map_err(|error| DavError::new(error.to_string()))?);
        body.push('\n');
    }
    if body.len() > MAX_LOG_BYTES {
        return Err(DavError::new("设备日志压缩后超过 100 MB 上限"));
    }
    let head = build_head(device, &body, &compacted.entries, compacted.state_entries, compacted.history_entries);
    put_with_directory(&dav, connection, &path, body.into_bytes()).await?;
    // Commit only after the journal bytes are durable. A failed marker PUT keeps
    // readers on the previous committed view rather than exposing this write.
    dav.put(&journal_head_path(&root, device), serde_json::to_vec(&head).map_err(|error| DavError::new(error.to_string()))?).await?;
    Ok(PushResult { first_seq, count })
}

#[cfg(test)]
mod tests;
