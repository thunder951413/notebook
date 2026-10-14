//! Exercises the transport against a real HTTP endpoint: a minimal in-memory
//! WebDAV server (MKCOL/PUT/GET/PROPFIND), mirroring `webdav.test.ts`.

use super::*;
use std::sync::Arc;

#[derive(Default)]
struct ServerState {
    /// Path → data; `None` marks a directory.
    entries: HashMap<String, Option<Vec<u8>>>,
    log: Vec<(String, String, usize)>,
    propfind_failure: Option<u16>,
    weak_etags: bool,
}

struct TestServer {
    state: Arc<Mutex<ServerState>>,
    base: String,
}

impl TestServer {
    fn start() -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let state = Arc::new(Mutex::new(ServerState::default()));
        let shared = state.clone();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let raw = request.url().split('?').next().unwrap_or("").to_string();
                let path = percent_decode_str(&raw).decode_utf8_lossy().trim_end_matches('/').to_string();
                let method = request.method().as_str().to_string();
                let depth = request.headers().iter().find(|h| h.field.equiv("Depth")).map(|h| h.value.as_str().to_string()).unwrap_or_else(|| "1".into());
                let mut body = Vec::new();
                let _ = request.as_reader().read_to_end(&mut body);
                let mut state = shared.lock().unwrap();
                state.log.push((method.clone(), path.clone(), body.len()));
                let parent = path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
                let parent_exists = parent == "/dav" || state.entries.get(&parent).is_some_and(|e| e.is_none());
                let response = match method.as_str() {
                    "MKCOL" => {
                        if !parent_exists {
                            tiny_http::Response::from_data(Vec::new()).with_status_code(409)
                        } else if state.entries.contains_key(&path) {
                            tiny_http::Response::from_data(Vec::new()).with_status_code(405)
                        } else {
                            state.entries.insert(path.clone(), None);
                            tiny_http::Response::from_data(Vec::new()).with_status_code(201)
                        }
                    }
                    "PUT" => {
                        if !parent_exists {
                            tiny_http::Response::from_data(Vec::new()).with_status_code(409)
                        } else {
                            state.entries.insert(path.clone(), Some(body));
                            tiny_http::Response::from_data(Vec::new()).with_status_code(201)
                        }
                    }
                    "GET" => match state.entries.get(&path) {
                        Some(Some(data)) => {
                            let etag = format!("\"{}\"", sha256_hex(data));
                            tiny_http::Response::from_data(data.clone())
                                .with_status_code(200)
                                .with_header(tiny_http::Header::from_bytes(&b"ETag"[..], etag.as_bytes()).unwrap())
                        }
                        _ => tiny_http::Response::from_data(Vec::new()).with_status_code(404),
                    },
                    "PROPFIND" => {
                        if let Some(code) = state.propfind_failure {
                            tiny_http::Response::from_data(Vec::new()).with_status_code(code)
                        } else if !state.entries.contains_key(&path) {
                            tiny_http::Response::from_data(Vec::new()).with_status_code(404)
                        } else {
                            let mut keys: Vec<&String> = state
                                .entries
                                .keys()
                                .filter(|key| **key == path || (depth == "1" && key.starts_with(&format!("{path}/")) && !key[path.len() + 1..].contains('/')))
                                .collect();
                            keys.sort();
                            let mut xml = String::from(r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">"#);
                            for key in keys {
                                let data = state.entries.get(key).unwrap();
                                let href: String = key.split('/').map(|s| utf8_percent_encode(s, SEGMENT).to_string()).collect::<Vec<_>>().join("/");
                                xml.push_str(&format!("<d:response><d:href>{href}</d:href><d:propstat><d:prop>"));
                                xml.push_str(if data.is_none() { "<d:resourcetype><d:collection/></d:resourcetype>" } else { "<d:resourcetype/>" });
                                if let Some(data) = data {
                                    let prefix = if state.weak_etags { "W/" } else { "" };
                                    xml.push_str(&format!("<d:getetag>{prefix}&quot;{}&quot;</d:getetag>", sha256_hex(data)));
                                }
                                xml.push_str("</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>");
                            }
                            xml.push_str("</d:multistatus>");
                            tiny_http::Response::from_data(xml.into_bytes()).with_status_code(207)
                        }
                    }
                    _ => tiny_http::Response::from_data(Vec::new()).with_status_code(405),
                };
                drop(state);
                let _ = request.respond(response);
            }
        });
        Self { state, base: format!("http://127.0.0.1:{port}/dav/") }
    }

    fn connection(&self, remote: &str) -> Connection {
        Connection { base_url: self.base.clone(), username: "test-user".into(), app_password: "test-app-password".into(), remote_path: remote.into(), sync_password: None }
    }
    fn mark(&self) -> usize {
        self.state.lock().unwrap().log.len()
    }
    fn methods_since(&self, mark: usize) -> Vec<String> {
        self.state.lock().unwrap().log[mark..].iter().map(|(m, _, _)| m.clone()).collect()
    }
    fn requests_since(&self, mark: usize) -> Vec<(String, String, usize)> {
        self.state.lock().unwrap().log[mark..].to_vec()
    }
    fn file(&self, path: &str) -> Option<Vec<u8>> {
        self.state.lock().unwrap().entries.get(path).cloned().flatten()
    }
    fn set_file(&self, path: &str, data: &[u8]) {
        let mut state = self.state.lock().unwrap();
        let mut current = String::new();
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        for part in &parts[..parts.len() - 1] {
            current = format!("{current}/{part}");
            if current != "/dav" {
                state.entries.entry(current.clone()).or_insert(None);
            }
        }
        state.entries.insert(path.to_string(), Some(data.to_vec()));
    }
    fn remove_prefix(&self, prefix: &str) {
        self.state.lock().unwrap().entries.retain(|key, _| !key.starts_with(prefix));
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

fn row(kind: &str, id: &str, ver: u64, payload: Value) -> Entry {
    let value = serde_json::json!({ "ts": "2026-09-04T00:00:00.000Z", "op": "upsert", "type": kind, "id": id, "ver": ver, "payload": payload });
    value.as_object().unwrap().clone()
}

fn line(seq: u64, id: &str) -> String {
    serde_json::json!({ "seq": seq, "ts": "t", "op": "upsert", "type": "page", "id": id, "ver": 0, "payload": {} }).to_string()
}

fn ids(result: &PullResult, device: &str) -> Vec<String> {
    result.entries.iter().filter(|e| text_field(e, "deviceId") == device).map(|e| text_field(e, "id")).collect()
}

const DEV1: &str = "00000000-0000-4000-8000-000000000001";
const DEV2: &str = "00000000-0000-4000-8000-000000000002";

#[test]
fn requires_https_except_loopback() {
    assert!(validated_base_url("https://dav.jianguoyun.com/dav/").is_ok());
    assert!(validated_base_url("http://localhost:8787/dav/").is_ok());
    assert!(validated_base_url("http://127.0.0.1:8787/dav/").is_ok());
    assert!(validated_base_url("http://[::1]:8787/dav/").is_ok());
    assert!(validated_base_url("http://dav.jianguoyun.com/dav/").unwrap_err().message.contains("必须使用 HTTPS"));
    assert!(validated_base_url("http://localhost.example/dav/").unwrap_err().message.contains("必须使用 HTTPS"));
}

#[test]
fn rejects_unsafe_remote_paths() {
    assert_eq!(safe_remote_path(" notebook_backup ").unwrap(), "notebook_backup");
    assert_eq!(safe_remote_path("a/./b/").unwrap(), "a/b");
    assert!(safe_remote_path("../escape").is_err());
    assert!(safe_remote_path("/abs").is_err());
    assert!(safe_remote_path("a/../..").is_err());
    assert!(safe_remote_path("").is_err());
}

#[test]
fn weak_etags_are_not_strong_validators() {
    assert_eq!(strong_etag(Some("\"abc\"")), Some("abc".into()));
    assert_eq!(strong_etag(Some("W/\"abc\"")), None);
    assert_eq!(strong_etag(Some("中文")), Some("中文".into()));
    assert_eq!(strong_etag(None), None);
}

#[tokio::test]
async fn tests_connection_and_empty_repository_reads_only_list() {
    let server = TestServer::start();
    let connection = server.connection("notebook_backup");
    let result = test_connection(&http(), &connection).await;
    assert!(result.ok, "{}", result.message);
    assert!(!result.remote_path_exists);
    let mark = server.mark();
    let pulled = pull_journals(&http(), &connection, &HashMap::new()).await.unwrap();
    assert!(pulled.entries.is_empty());
    assert_eq!(server.methods_since(mark), vec!["PROPFIND"]);
}

#[tokio::test]
async fn appends_with_monotonic_sequences_and_pulls_by_cursor() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    let first = append_journal(&http(), &c, DEV1, vec![row("page", "page-1", 0, serde_json::json!({"title": "a"})), row("page", "page-2", 1, serde_json::json!({"title": "b"}))], 0).await.unwrap();
    assert_eq!((first.first_seq, first.count), (1, 2));
    let mut delete = row("page", "page-1", 2, serde_json::json!({}));
    delete.insert("op".into(), "delete".into());
    let second = append_journal(&http(), &c, DEV1, vec![delete], 0).await.unwrap();
    assert_eq!(second.first_seq, 3);
    let other = append_journal(&http(), &c, DEV2, vec![row("page", "page-3", 0, serde_json::json!({}))], 0).await.unwrap();
    assert_eq!(other.first_seq, 1);

    let pulled = pull_journals(&http(), &c, &HashMap::from([(DEV1.to_string(), 2)])).await.unwrap();
    let summary: Vec<String> = pulled.entries.iter().map(|e| format!("{}:{}:{}", text_field(e, "deviceId"), entry_seq(e), text_field(e, "id"))).collect();
    assert_eq!(summary, vec![format!("{DEV1}:3:page-1"), format!("{DEV2}:1:page-3")]);
    assert_eq!(text_field(&pulled.entries[0], "op"), "delete");
    assert_eq!(pulled.fingerprint, format!("{}|test-user|notebook_backup", server.base));

    // Already consumed: the small head markers make the journals unnecessary.
    let mark = server.mark();
    let again = pull_journals(&http(), &c, &HashMap::from([(DEV1.to_string(), 3), (DEV2.to_string(), 1)])).await.unwrap();
    assert!(again.entries.is_empty());
    assert!(!server.requests_since(mark).iter().any(|(m, p, _)| m == "GET" && p.ends_with(".jsonl")));
}

#[tokio::test]
async fn warm_unchanged_pull_uses_one_listing_and_weak_validators_reread() {
    let server = TestServer::start();
    let c = server.connection("etag-test");
    let device = "00000000-0000-4000-8000-0000000000aa";
    append_journal(&http(), &c, device, vec![row("page", "p", 0, serde_json::json!({"title": "first"}))], 0).await.unwrap();
    pull_journals(&http(), &c, &HashMap::new()).await.unwrap();
    let mark = server.mark();
    let pulled = pull_journals(&http(), &c, &HashMap::from([(device.to_string(), 1)])).await.unwrap();
    assert!(pulled.entries.is_empty());
    assert_eq!(server.methods_since(mark), vec!["PROPFIND"]);
    append_journal(&http(), &c, device, vec![row("page", "p", 1, serde_json::json!({"title": "second"}))], 0).await.unwrap();
    let pulled = pull_journals(&http(), &c, &HashMap::from([(device.to_string(), 1)])).await.unwrap();
    assert_eq!(pulled.entries[0]["payload"]["title"], "second");
    server.state.lock().unwrap().weak_etags = true;
    let mark = server.mark();
    pull_journals(&http(), &c, &HashMap::from([(device.to_string(), 2)])).await.unwrap();
    assert_eq!(server.methods_since(mark), vec!["PROPFIND", "GET"]);
}

#[tokio::test]
async fn successive_batches_reuse_provisioned_directories_and_recover_removed_ones() {
    let server = TestServer::start();
    let c = server.connection("mkdir-test/nested");
    let device = "00000000-0000-4000-8000-0000000000bb";
    append_journal(&http(), &c, device, vec![row("page", "x", 0, serde_json::json!({}))], 0).await.unwrap();
    let mark = server.mark();
    append_journal(&http(), &c, device, vec![row("page", "x", 1, serde_json::json!({}))], 0).await.unwrap();
    assert_eq!(server.methods_since(mark), vec!["GET", "PUT", "PUT"]);

    server.remove_prefix("/dav/mkdir-test/nested/journal");
    let mark = server.mark();
    append_journal(&http(), &c, device, vec![row("page", "x", 2, serde_json::json!({}))], 0).await.unwrap();
    let requests = server.requests_since(mark);
    assert_eq!(requests.iter().filter(|(m, p, _)| m == "PUT" && p.ends_with(".jsonl")).count(), 2);
    assert!(server.file(&format!("/dav/mkdir-test/nested/journal/{device}.jsonl")).is_some());
}

#[tokio::test]
async fn compacts_before_appending_and_keeps_sequence_values() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    let device = "00000000-0000-4000-8000-00000000000a";
    let big: String = (1..=8000u64)
        .map(|seq| serde_json::json!({ "seq": seq, "ts": "t", "op": "upsert", "type": "page", "id": "page-1", "ver": seq - 1, "payload": { "body": "x".repeat(500) } }).to_string() + "\n")
        .collect();
    server.set_file(&format!("/dav/notebook_backup/journal/{device}.jsonl"), big.as_bytes());
    let pushed = append_journal(&http(), &c, device, vec![row("page", "page-2", 0, serde_json::json!({}))], 0).await.unwrap();
    assert_eq!(pushed.first_seq, 8001);
    let stored = String::from_utf8(server.file(&format!("/dav/notebook_backup/journal/{device}.jsonl")).unwrap()).unwrap();
    let seqs: Vec<(u64, String)> = stored.trim().split('\n').map(|l| serde_json::from_str::<Entry>(l).unwrap()).map(|e| (entry_seq(&e), text_field(&e, "id"))).collect();
    assert_eq!(seqs, vec![(8000, "page-1".to_string()), (8001, "page-2".to_string())]);
}

#[tokio::test]
async fn preserves_unknown_fields_and_retained_history() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    let device = "00000000-0000-4000-8000-0000000000e3";
    let mut first = row("page", "page-1", 0, serde_json::json!({"title": "old"}));
    first.insert("hash".into(), "f".repeat(64).into());
    first.insert("futureField".into(), serde_json::json!({"keep": true}));
    let mut tomb = row("page", "page-1", 1, serde_json::json!({}));
    tomb.insert("op".into(), "delete".into());
    let mut rows = vec![first.clone()];
    rows.extend((0..30).map(|i| row("revision", &format!("revision-{i}"), 0, serde_json::json!({"body": "x"}))));
    append_journal(&http(), &c, device, rows, 0).await.unwrap();
    let stored = String::from_utf8(server.file(&format!("/dav/notebook_backup/journal/{device}.jsonl")).unwrap()).unwrap();
    let page: Entry = stored.lines().map(|l| serde_json::from_str::<Entry>(l).unwrap()).find(|e| text_field(e, "type") == "page").unwrap();
    assert_eq!(page["futureField"]["keep"], true);
    assert_eq!(page["hash"], "f".repeat(64));
    append_journal(&http(), &c, device, vec![tomb], 0).await.unwrap();
    let stored = String::from_utf8(server.file(&format!("/dav/notebook_backup/journal/{device}.jsonl")).unwrap()).unwrap();
    let entries: Vec<Entry> = stored.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(entries.iter().filter(|e| text_field(e, "type") == "revision").count(), 30);
    let page = entries.iter().find(|e| text_field(e, "type") == "page").unwrap();
    assert_eq!((text_field(page, "op"), entry_seq(page)), ("delete".to_string(), 32));
    let head: Value = serde_json::from_slice(&server.file(&format!("/dav/notebook_backup/journal/{device}.head.json")).unwrap()).unwrap();
    assert_eq!(head["stateEntries"], 1);
    assert_eq!(head["historyEntries"], 30);
}

#[tokio::test]
async fn commits_head_after_journal_with_matching_metadata() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    let device = "00000000-0000-4000-8000-0000000000e4";
    let mark = server.mark();
    append_journal(&http(), &c, device, vec![row("page", "page-1", 0, serde_json::json!({"t": "中文"}))], 0).await.unwrap();
    let puts: Vec<String> = server.requests_since(mark).into_iter().filter(|(m, _, _)| m == "PUT").map(|(_, p, _)| p).collect();
    assert_eq!(puts[puts.len() - 2..], [format!("/dav/notebook_backup/journal/{device}.jsonl"), format!("/dav/notebook_backup/journal/{device}.head.json")]);
    let journal = server.file(&format!("/dav/notebook_backup/journal/{device}.jsonl")).unwrap();
    let head: Value = serde_json::from_slice(&server.file(&format!("/dav/notebook_backup/journal/{device}.head.json")).unwrap()).unwrap();
    assert_eq!(head["version"], 1);
    assert_eq!(head["deviceId"], device);
    assert_eq!(head["lastSeq"], 1);
    assert_eq!(head["journalBytes"], journal.len() as u64);
    assert_eq!(head["journalSha256"], sha256_hex(&journal));
    assert!(head["updatedAt"].as_str().unwrap().ends_with('Z'));
    // The Electron/Android head parser must accept what we wrote.
    parse_head(&serde_json::to_string(&head).unwrap(), device).unwrap();
}

#[tokio::test]
async fn reads_legacy_journals_without_heads_and_hides_uncommitted_tails() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    let legacy = "00000000-0000-4000-8000-0000000000e1";
    server.set_file(&format!("/dav/notebook_backup/journal/{legacy}.jsonl"), format!("{}\n", line(1, "legacy")).as_bytes());
    let pulled = pull_journals(&http(), &c, &HashMap::new()).await.unwrap();
    assert_eq!(ids(&pulled, legacy), vec!["legacy"]);

    let device = "00000000-0000-4000-8000-0000000000e5";
    let committed = format!("{}\n", line(1, "committed"));
    let journal = format!("{committed}{}\n", line(2, "uncommitted"));
    server.set_file(&format!("/dav/notebook_backup/journal/{device}.jsonl"), journal.as_bytes());
    let head = serde_json::json!({ "version": 1, "deviceId": device, "lastSeq": 1, "journalBytes": committed.len(), "journalSha256": sha256_hex(committed.as_bytes()), "updatedAt": "2026-08-07T00:00:00.000Z", "stateEntries": 1, "historyEntries": 0 });
    server.set_file(&format!("/dav/notebook_backup/journal/{device}.head.json"), head.to_string().as_bytes());
    let pulled = pull_journals(&http(), &c, &HashMap::new()).await.unwrap();
    assert_eq!(ids(&pulled, device), vec!["committed"]);
    assert!(pulled.warnings.iter().any(|w| w.contains(device)));
    assert_eq!(ids(&pulled, legacy), vec!["legacy"], "a mismatched writer must not block other devices");
}

#[tokio::test]
async fn rereads_a_journal_whose_sequence_went_backwards_and_respects_floor() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    let device = "00000000-0000-4000-8000-0000000000e9";
    let first = append_journal(&http(), &c, device, vec![row("page", "after-reset", 0, serde_json::json!({}))], 40).await.unwrap();
    assert_eq!(first.first_seq, 41);
    server.remove_prefix(&format!("/dav/notebook_backup/journal/{device}"));
    append_journal(&http(), &c, device, vec![row("page", "restarted", 0, serde_json::json!({}))], 0).await.unwrap();
    let pulled = pull_journals(&http(), &c, &HashMap::from([(device.to_string(), 40)])).await.unwrap();
    assert_eq!(pulled.reset_devices, vec![device.to_string()]);
    assert_eq!(ids(&pulled, device), vec!["restarted"]);
    assert!(pulled.devices.contains(&device.to_string()));
}

#[tokio::test]
async fn ignores_invalid_filenames_and_surfaces_listing_failures() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    append_journal(&http(), &c, DEV1, vec![row("page", "a", 0, serde_json::json!({}))], 0).await.unwrap();
    server.set_file("/dav/notebook_backup/journal/not-a-device.jsonl", b"{not json}\n");
    let pulled = pull_journals(&http(), &c, &HashMap::new()).await.unwrap();
    assert_eq!(pulled.devices, vec![DEV1.to_string()]);
    server.state.lock().unwrap().propfind_failure = Some(401);
    let error = pull_journals(&http(), &c, &HashMap::new()).await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert!(error.message.contains("401"));
}

#[tokio::test]
async fn round_trips_objects_and_skips_existing_uploads() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    let data = vec![0u8, 1, 2, 250, 251, 255];
    let hash = sha256_hex(&data);
    put_object(&http(), &c, &hash, data.clone()).await.unwrap();
    assert_eq!(get_object(&http(), &c, &hash).await.unwrap(), data);
    put_object(&http(), &c, &hash, data.clone()).await.unwrap();
    assert!(get_object(&http(), &c, "not-a-hash").await.unwrap_err().message.contains("对象哈希格式不正确"));

    let existing = b"already-there".to_vec();
    let existing_hash = sha256_hex(&existing);
    let target = format!("/dav/notebook_backup/objects/{}/{existing_hash}", &existing_hash[..2]);
    server.set_file(&target, &existing);
    let mark = server.mark();
    put_object(&http(), &c, &existing_hash, existing).await.unwrap();
    assert!(!server.requests_since(mark).iter().any(|(m, p, _)| m == "PUT" && *p == target));
    assert!(put_object(&http(), &c, &existing_hash, vec![1, 2, 3]).await.unwrap_err().message.contains("本地对象 SHA-256 校验失败"));
    // Tampered remote bytes are refused.
    server.set_file(&target, b"tampered");
    assert!(get_object(&http(), &c, &existing_hash).await.unwrap_err().message.contains("校验失败"));
}

#[tokio::test]
async fn new_child_after_remote_removal_recovers_from_missing_parent() {
    let server = TestServer::start();
    let c = server.connection("missing-ancestor");
    append_journal(&http(), &c, "00000000-0000-4000-8000-0000000000ee", vec![row("page", "gone", 0, serde_json::json!({}))], 0).await.unwrap();
    server.remove_prefix("/dav/missing-ancestor");
    let data = b"new attachment after remote directory removal".to_vec();
    let hash = sha256_hex(&data);
    put_object(&http(), &c, &hash, data.clone()).await.unwrap();
    assert_eq!(get_object(&http(), &c, &hash).await.unwrap(), data);
}

#[tokio::test]
async fn rejects_bad_device_ids_and_paths() {
    let server = TestServer::start();
    let c = server.connection("notebook_backup");
    assert!(append_journal(&http(), &c, "../escape", vec![], 0).await.unwrap_err().message.contains("设备 ID 不正确"));
    let bad = server.connection("../escape");
    assert!(append_journal(&http(), &bad, DEV1, vec![], 0).await.unwrap_err().message.contains("远端同步目录不安全"));
}

#[test]
fn parses_chinese_hrefs_and_etags_from_multistatus() {
    let xml = r#"<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/%E7%AC%94%E8%AE%B0/journal/</D:href></D:response><D:response><D:href>/dav/%E7%AC%94%E8%AE%B0/journal/00000000-0000-4000-8000-000000000001.head.json</D:href><D:propstat><D:prop><D:getetag>"abc"</D:getetag></D:prop></D:propstat></D:response></D:multistatus>"#;
    let items = parse_multistatus(xml).unwrap();
    assert_eq!(items[0].name, "journal");
    assert_eq!(items[1].name, "00000000-0000-4000-8000-000000000001.head.json");
    assert_eq!(strong_etag(items[1].etag.as_deref()), Some("abc".into()));
}
