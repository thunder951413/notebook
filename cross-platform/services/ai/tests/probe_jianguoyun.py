#!/usr/bin/env python3
"""Real 坚果云 WebDAV probe for the v4 journal protocol.

Exercises the exact transport implementation shared by all three clients
(services/ai/notebook_ai/legacy_webdav.py) against the live server:

  1. connection probe (auth + MKCOL + PROPFIND semantics)
  2. device A publishes journal entries + a content-addressed object
  3. device B pulls them, downloads the object, publishes its own changes
  4. incremental pull with per-device cursors (no duplicates)
  5. a few-MB object round trip and UTF-8 payloads
  6. cleanup of the isolated test directory

Credentials come from the environment, never from files or arguments:
  NOTEBOOK_JIANGUOYUN_USER / NOTEBOOK_JIANGUOYUN_APP_PASSWORD

Run: .venv/bin/python tests/probe_jianguoyun.py
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import uuid
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402
from notebook_ai.legacy_webdav import (  # noqa: E402
    WebdavConnection,
    WebdavObjectRequest,
    WebdavPullRequest,
    WebdavPushRequest,
    JournalPushEntry,
    PushObject,
    get_object,
    pull_journals,
    push_repository,
    test_connection,
)

USER = os.environ.get("NOTEBOOK_JIANGUOYUN_USER", "")
PASSWORD = os.environ.get("NOTEBOOK_JIANGUOYUN_APP_PASSWORD", "")
if not USER or not PASSWORD:
    sys.exit("set NOTEBOOK_JIANGUOYUN_USER and NOTEBOOK_JIANGUOYUN_APP_PASSWORD first")

BASE = "https://dav.jianguoyun.com/dav/"
ROOT = f"notebook-v4-probe-{uuid.uuid4().hex[:8]}"
DEVICE_A = "00000000-0000-4000-8000-00000000000a"
DEVICE_B = "00000000-0000-4000-8000-00000000000b"

failures: list[str] = []
DAV_NS = "{DAV:}"


def _delete_tree(session: requests.Session, base: str, path: str) -> None:
    """Delete a collection recursively; files first, empty collections last."""
    response = session.request("PROPFIND", f"{base}{path}", headers={"Depth": "1"}, timeout=(15, 60))
    if response.status_code != 207:
        session.request("DELETE", f"{base}{path}", timeout=(15, 60))
        return
    root = ET.fromstring(response.text)
    for item in root.iter(f"{DAV_NS}response"):
        href = item.findtext(f"{DAV_NS}href", "").strip()
        relative = href.removeprefix("/dav/").strip("/")
        if not relative or relative == path.strip("/"):
            continue
        is_collection = item.find(f"{DAV_NS}propstat/{DAV_NS}prop/{DAV_NS}resourcetype/{DAV_NS}collection") is not None
        if is_collection:
            _delete_tree(session, base, relative)
        else:
            session.request("DELETE", f"{base}{relative}", timeout=(15, 60))
    session.request("DELETE", f"{base}{path}", timeout=(15, 60))


def check(name: str, fn) -> None:
    try:
        fn()
        print(f"  PASS {name}")
    except Exception as error:  # noqa: BLE001
        failures.append(name)
        print(f"  FAIL {name}: {type(error).__name__}: {error}")


def settings() -> WebdavConnection:
    return WebdavConnection(baseUrl=BASE, username=USER, appPassword=PASSWORD, remotePath=ROOT)


def main() -> None:
    print(f"probe root: {ROOT} (device A={DEVICE_A}, device B={DEVICE_B})")

    def probe_connection() -> None:
        result = test_connection(settings())
        assert result.ok, result.message
        assert result.remotePathExists is False, "fresh root should have no journal/ yet"

    def create_directory_semantics() -> None:
        # MKCOL on an existing directory is idempotent (201 on 坚果云) or 405/409;
        # PROPFIND on a missing path must be 404.
        session = requests.Session()
        session.auth = (USER, PASSWORD)
        response = session.request("MKCOL", f"{BASE}{ROOT}", timeout=(15, 60))
        assert response.status_code in {201, 405, 409}, f"MKCOL fresh root -> {response.status_code}"
        response = session.request("MKCOL", f"{BASE}{ROOT}", timeout=(15, 60))
        assert response.status_code in {201, 405, 409, 301, 302}, f"MKCOL existing -> {response.status_code} (client tolerates all of these)"
        response = session.request("PROPFIND", f"{BASE}{ROOT}/missing", headers={"Depth": "0"}, timeout=(15, 60))
        assert response.status_code == 404, f"PROPFIND missing -> {response.status_code}"
        # Nested MKCOL without the parent must be 409 (the client creates
        # every segment from the root down instead).
        response = session.request("MKCOL", f"{BASE}{ROOT}/nested/deep", timeout=(15, 60))
        assert response.status_code == 409, f"MKCOL nested without parent -> {response.status_code}"

    def device_a_publishes_journal_and_object() -> None:
        body = "坚果云协议验证 " + "x" * 3000
        tiptap = json.dumps({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": body}]}]}, ensure_ascii=False)
        doc_hash = hashlib.sha256(tiptap.encode("utf-8")).hexdigest()
        pushed = push_repository(WebdavPushRequest(
            settings=settings(),
            deviceId=DEVICE_A,
            entries=[
                JournalPushEntry(ts="2026-08-04T00:00:00Z", op="upsert", type="page", id="page-0001", ver=0, payload={"id": "page-0001", "title": "坚果云页面", "kind": "document"}),
                JournalPushEntry(ts="2026-08-04T00:00:01Z", op="upsert", type="document", id="page-0001", ver=0, hash=doc_hash, payload={"pageId": "page-0001", "schemaVersion": 1, "tiptapJson": {"$object": doc_hash}}),
            ],
            objects=[PushObject(hash=doc_hash, dataBase64=base64.b64encode(tiptap.encode("utf-8")).decode())],
        ))
        assert pushed.firstSeq == 1 and pushed.count == 2, pushed

    def device_b_pulls_and_publishes() -> None:
        pulled = pull_journals(WebdavPullRequest(settings=settings(), knownSeqs={}))
        by_device = {(entry.deviceId, entry.seq): entry for entry in pulled.entries}
        assert (DEVICE_A, 1) in by_device and (DEVICE_A, 2) in by_device, [e.seq for e in pulled.entries]
        assert by_device[(DEVICE_A, 2)].hash, "externalized document entry must carry the object hash"
        assert by_device[(DEVICE_A, 1)].payload["title"] == "坚果云页面"
        doc = get_object(WebdavObjectRequest(settings=settings(), hash=by_device[(DEVICE_A, 2)].hash))
        assert "坚果云协议验证" in base64.b64decode(doc.dataBase64).decode("utf-8")
        # Device B publishes its own journal and must see A's entries too.
        pushed = push_repository(WebdavPushRequest(
            settings=settings(),
            deviceId=DEVICE_B,
            entries=[JournalPushEntry(ts="2026-08-04T00:00:02Z", op="upsert", type="page", id="page-0002", ver=0, payload={"id": "page-0002", "title": "设备 B 页面"})],
        ))
        assert pushed.firstSeq == 1 and pushed.count == 1, pushed

    def incremental_pull_with_cursors() -> None:
        # Device A already consumed its own two entries.
        pulled = pull_journals(WebdavPullRequest(settings=settings(), knownSeqs={DEVICE_A: 2}))
        assert [(e.deviceId, e.seq) for e in pulled.entries] == [(DEVICE_B, 1)], pulled.entries
        again = pull_journals(WebdavPullRequest(settings=settings(), knownSeqs={DEVICE_A: 2, DEVICE_B: 1}))
        assert again.entries == [], again.entries

    def large_object_round_trip() -> None:
        blob = os.urandom(4 * 1024 * 1024)  # 4 MiB
        big_hash = hashlib.sha256(blob).hexdigest()
        push_repository(WebdavPushRequest(
            settings=settings(),
            deviceId=DEVICE_A,
            entries=[JournalPushEntry(ts="2026-08-04T00:00:03Z", op="upsert", type="asset", id="asset-0001", ver=0, hash=big_hash, payload={"id": "asset-0001", "pageId": "page-0001", "kind": "file", "filename": "blob.bin", "objectHash": big_hash})],
            objects=[PushObject(hash=big_hash, dataBase64=base64.b64encode(blob).decode())],
        ))
        fetched = get_object(WebdavObjectRequest(settings=settings(), hash=big_hash))
        assert base64.b64decode(fetched.dataBase64) == blob, "4 MiB object round trip mismatch"

    for name, fn in [
        ("connection probe on a fresh root", probe_connection),
        ("MKCOL/PROPFIND server semantics", create_directory_semantics),
        ("device A publishes journal + object", device_a_publishes_journal_and_object),
        ("device B pulls, downloads object, publishes", device_b_pulls_and_publishes),
        ("incremental pull with per-device cursors", incremental_pull_with_cursors),
        ("4 MiB object round trip", large_object_round_trip),
    ]:
        check(name, fn)

    # Cleanup: remove the isolated probe directory recursively (files first,
    # then empty collections; 坚果云 rejects DELETE on non-empty collections).
    session = requests.Session()
    session.auth = (USER, PASSWORD)
    _delete_tree(session, BASE, ROOT)
    print(f"cleanup: removed {ROOT}")

    if failures:
        print(f"\n{len(failures)} check(s) failed: {', '.join(failures)}")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
