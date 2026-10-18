//! Rust runner for the shared WebDAV v4 protocol fixtures in
//! `SyncContractFixtures/webdav-v4`. The TypeScript (desktop/renderer) and
//! Kotlin (Android) runners read the very same files.

use std::path::PathBuf;

use notebook_sync::webdav::{self, Entry, JournalHead};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../SyncContractFixtures/webdav-v4").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn cases<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    value[key].as_array().unwrap_or_else(|| panic!("missing {key}"))
}

fn name(case: &Value) -> String {
    case.get("name").or_else(|| case.get("input")).map(|value| value.to_string()).unwrap_or_default()
}

fn entry(value: &Value) -> Entry {
    value.as_object().unwrap().clone()
}

#[test]
fn remote_path() {
    for case in cases(&fixture("remote-path.json"), "cases") {
        let result = webdav::safe_remote_path(case["input"].as_str().unwrap());
        if case.get("error").is_some() {
            assert!(result.is_err(), "{} should be rejected", name(case));
        } else {
            assert_eq!(result.unwrap(), case["expected"].as_str().unwrap(), "{}", name(case));
        }
    }
}

#[test]
fn base_url() {
    for case in cases(&fixture("base-url.json"), "cases") {
        let ok = webdav::validated_base_url(case["input"].as_str().unwrap()).is_ok();
        assert_eq!(ok, case["ok"].as_bool().unwrap(), "{}", name(case));
    }
}

#[test]
fn layout() {
    for case in cases(&fixture("layout.json"), "cases") {
        let (root, device, hash) = (case["root"].as_str().unwrap(), case["deviceId"].as_str().unwrap(), case["hash"].as_str().unwrap());
        assert_eq!(webdav::journal_path(root, device), case["journalPath"].as_str().unwrap());
        assert_eq!(webdav::journal_head_path(root, device), case["headPath"].as_str().unwrap());
        assert_eq!(webdav::object_path(root, hash), case["objectPath"].as_str().unwrap());
    }
}

#[test]
fn journal_parse() {
    for case in cases(&fixture("journal-parse.json"), "cases") {
        let result = webdav::parse_journal(case["text"].as_str().unwrap(), "fixture");
        if case.get("error").is_some() {
            assert!(result.is_err(), "{} should be rejected", name(case));
            continue;
        }
        let entries = result.unwrap_or_else(|error| panic!("{}: {error}", name(case)));
        let expected = cases(case, "expected");
        assert_eq!(entries.len(), expected.len(), "{}", name(case));
        for (actual, expected) in entries.iter().zip(expected) {
            assert_eq!(webdav::entry_seq(actual), expected["seq"].as_u64().unwrap(), "{}", name(case));
            for key in ["op", "type", "id"] {
                assert_eq!(actual[key], expected[key], "{} {key}", name(case));
            }
            assert_eq!(actual.get("ver").and_then(Value::as_u64).unwrap_or(0), expected["ver"].as_u64().unwrap(), "{}", name(case));
            assert_eq!(actual.get("hash").cloned().unwrap_or(Value::Null), expected.get("hash").cloned().unwrap_or(Value::Null), "{}", name(case));
        }
    }
}

#[test]
fn journal_compact() {
    for case in cases(&fixture("journal-compact.json"), "cases") {
        let compacted = webdav::compact_journal(cases(case, "entries").iter().map(entry).collect());
        let seqs: Vec<u64> = compacted.entries.iter().map(webdav::entry_seq).collect();
        let expected: Vec<u64> = cases(case, "expectedSeqs").iter().map(|value| value.as_u64().unwrap()).collect();
        assert_eq!(seqs, expected, "{}", name(case));
        assert_eq!(compacted.state_entries as u64, case["stateEntries"].as_u64().unwrap(), "{}", name(case));
        assert_eq!(compacted.history_entries as u64, case["historyEntries"].as_u64().unwrap(), "{}", name(case));
    }
}

#[test]
fn journal_head() {
    let fixture = fixture("journal-head.json");
    for case in cases(&fixture, "build") {
        let body = case["body"].as_str().unwrap();
        let entries = webdav::parse_journal(body, "fixture").unwrap();
        let head = webdav::build_head(case["deviceId"].as_str().unwrap(), body, &entries, entries.len(), 0);
        assert_eq!(head.last_seq, case["expected"]["lastSeq"].as_u64().unwrap(), "{}", name(case));
        assert_eq!(head.journal_bytes, case["expected"]["journalBytes"].as_u64().unwrap(), "{}", name(case));
        assert_eq!(head.journal_sha256, case["expected"]["journalSha256"].as_str().unwrap(), "{}", name(case));
    }
    for case in cases(&fixture, "parse") {
        let result = webdav::parse_head(case["text"].as_str().unwrap(), case["deviceId"].as_str().unwrap());
        if case.get("error").is_some() {
            assert!(result.is_err(), "{} should be rejected", name(case));
            continue;
        }
        let head = result.unwrap_or_else(|error| panic!("{}: {error}", name(case)));
        let expected = &case["expected"];
        assert_eq!(head.last_seq, expected["lastSeq"].as_u64().unwrap());
        assert_eq!(head.journal_bytes, expected["journalBytes"].as_u64().unwrap());
        assert_eq!(head.journal_sha256, expected["journalSha256"].as_str().unwrap());
        assert_eq!(head.state_entries, expected["stateEntries"].as_u64().unwrap());
        assert_eq!(head.history_entries, expected["historyEntries"].as_u64().unwrap());
    }
}

#[test]
fn committed_view() {
    let fixture = fixture("committed-view.json");
    let text = fixture["journal"].as_str().unwrap();
    let journal = webdav::parse_journal(text, "fixture").unwrap();
    for case in cases(&fixture, "cases") {
        let head = case["head"].as_object().map(|head| JournalHead {
            version: 1,
            device_id: "fixture".into(),
            last_seq: head["lastSeq"].as_u64().unwrap(),
            journal_bytes: head["journalBytes"].as_u64().unwrap(),
            journal_sha256: head["journalSha256"].as_str().unwrap().into(),
            updated_at: String::new(),
            state_entries: 0,
            history_entries: 0,
        });
        let expected = &case["expected"];
        let (known, marker_reset, fetch) = webdav::plan_journal_read(head.as_ref(), case["known"].as_u64().unwrap());
        assert_eq!(fetch, expected["fetch"].as_bool().unwrap(), "{}", name(case));
        if !fetch {
            assert!(cases(expected, "seqs").is_empty());
            continue;
        }
        let view = webdav::committed_view(&journal, text, head.as_ref(), known);
        let expected_seqs: Vec<u64> = cases(expected, "seqs").iter().map(|value| value.as_u64().unwrap()).collect();
        assert_eq!(view.seqs, expected_seqs, "{}", name(case));
        assert_eq!(marker_reset || view.reset, expected["reset"].as_bool().unwrap(), "{}", name(case));
        assert_eq!(view.mismatch, expected["mismatch"].as_bool().unwrap(), "{}", name(case));
    }
}

#[test]
fn pull_isolation() {
    let fixture = fixture("pull-isolation.json");
    let device = fixture["deviceId"].as_str().unwrap();
    for case in cases(&fixture, "cases") {
        let expected = &case["expected"];
        let (known, listed) = (case["known"].as_u64().unwrap(), case["listedBytes"].as_u64());
        let (blocked, fetch, seqs, reset) = match case["headText"].as_str().map(|text| webdav::parse_head(text, device)) {
            Some(Err(_)) => (Some(webdav::BlockCode::HeadCorrupt), false, Vec::new(), false),
            parsed => {
                let head = parsed.map(Result::unwrap);
                let (planned, marker_reset, fetch) = webdav::plan_journal_read_sized(head.as_ref(), known, listed);
                if fetch {
                    let assessment = webdav::assess_journal(device, case["journalText"].as_str(), head.as_ref(), planned);
                    (assessment.blocked, true, assessment.seqs, marker_reset || assessment.reset)
                } else {
                    (None, false, Vec::new(), marker_reset)
                }
            }
        };
        assert_eq!(fetch, expected["fetch"].as_bool().unwrap(), "{}", name(case));
        assert_eq!(blocked.map(webdav::BlockCode::as_str), expected["blocked"].as_str(), "{}", name(case));
        let expected_seqs: Vec<u64> = cases(expected, "seqs").iter().map(|value| value.as_u64().unwrap()).collect();
        assert_eq!(seqs, expected_seqs, "{}", name(case));
        assert_eq!(reset, expected["reset"].as_bool().unwrap(), "{}", name(case));
    }
}

#[test]
fn journal_rebuild() {
    for case in cases(&fixture("journal-rebuild.json"), "cases") {
        let floor = webdav::rebuild_floor(case["journalText"].as_str(), case["headText"].as_str());
        assert_eq!(floor, case["expectedFloor"].as_u64().unwrap(), "{}", name(case));
    }
}

#[test]
fn pull_order() {
    let fixture = fixture("pull-order.json");
    let mut entries: Vec<Entry> = cases(&fixture, "entries").iter().map(entry).collect();
    webdav::sort_pulled_entries(&mut entries);
    let expected: Vec<Entry> = cases(&fixture, "expected").iter().map(entry).collect();
    assert_eq!(entries, expected);
}

#[test]
fn propfind_listing() {
    for case in cases(&fixture("propfind-listing.json"), "cases") {
        let names = webdav::listing_names(case["text"].as_str().unwrap()).unwrap();
        let expected: Vec<String> = cases(case, "names").iter().map(|value| value.as_str().unwrap().to_string()).collect();
        assert_eq!(names, expected, "{}", name(case));
    }
}

/// The Tauri shell only transports these envelopes (the renderer encrypts), so
/// Rust checks the structural contract the transport relies on: the marker key
/// and the fixed algorithm parameters survive a JSON round trip untouched.
#[test]
fn privacy_envelope_shape() {
    let fixture = fixture("privacy-envelope.json");
    for case in cases(&fixture, "cases") {
        let envelope = &case["envelope"]["$encrypted"];
        assert_eq!(envelope["version"], 1);
        assert_eq!(envelope["algorithm"], "AES-256-GCM");
        assert_eq!(envelope["kdf"], "PBKDF2-SHA256");
        assert_eq!(envelope["iterations"], 310_000);
        let round_trip: Value = serde_json::from_str(&serde_json::to_string(&case["envelope"]).unwrap()).unwrap();
        assert_eq!(round_trip, case["envelope"]);
    }
}
