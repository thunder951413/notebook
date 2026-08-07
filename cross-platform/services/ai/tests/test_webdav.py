"""WebDAV v4 journal transport and loopback bridge tests."""

import base64
import hashlib
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import pytest
from fastapi.testclient import TestClient

import notebook_ai.legacy_webdav as legacy_webdav
from notebook_ai.legacy_webdav import (
    WebdavConnection,
    WebdavObjectRequest,
    WebdavObjectResponse,
    WebdavPullRequest,
    WebdavPushRequest,
    WebdavPushResult,
    JournalPushEntry,
    PushObject,
    get_object,
    pull_journals,
    push_repository,
    test_connection as probe_connection,
)
from notebook_ai.main import create_app
from notebook_ai.settings import Settings


class FakeGateway:
    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        return [[1.0, 0.0]] * len(texts)
    async def stream_chat(self, request, **_) -> Iterator[str]:
        yield "ok"


class FakeWebdavServer:
    """In-memory WebDAV endpoint (MKCOL/PUT/GET/PROPFIND) for transport tests."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.dirs: set[str] = set()
        self.gets: list[str] = []
        self.puts: list[str] = []
        self.propfind_failure_status: int | None = None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler_factory())

    def _handler_factory(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # silence
                return

            def _path(self) -> str:
                return unquote(urlparse(self.path).path).removeprefix("/dav/")

            def _send(self, code: int, body: bytes = b"", content_type: str = "application/octet-stream") -> None:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_MKCOL(self) -> None:
                path = self._path()
                if path in owner.dirs or path in owner.files or any(item.startswith(f"{path}/") for item in owner.dirs | owner.files.keys()):
                    self._send(405)
                    return
                owner.dirs.add(path)
                self._send(201)

            def do_PUT(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                path = self._path()
                owner.puts.append(path)
                owner.files[path] = self.rfile.read(length)
                self._send(201)

            def do_GET(self) -> None:
                path = self._path()
                owner.gets.append(path)
                data = owner.files.get(path)
                if data is None:
                    self._send(404)
                    return
                self._send(200, data)

            def do_PROPFIND(self) -> None:
                if owner.propfind_failure_status is not None:
                    self._send(owner.propfind_failure_status)
                    return
                path = self._path()
                depth = self.headers.get("Depth", "1")
                if not (path in owner.dirs or path in owner.files or any(item.startswith(f"{path}/") for item in owner.dirs | owner.files.keys())):
                    self._send(404)
                    return
                children: list[str] = []
                if depth == "0":
                    if path in owner.dirs or path in owner.files:
                        children.append(path)
                else:
                    for item in owner.dirs | owner.files.keys():
                        rest = item.removeprefix(f"{path}/")
                        if item != path and rest and "/" not in rest:
                            children.append(item if item in owner.files else f"{item}/")
                responses = "\n".join(
                    f'  <d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop>'
                    f'<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
                    for href in children
                )
                body = f'<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">\n{responses}\n</d:multistatus>'.encode()
                self._send(207, body, "application/xml")

            def do_OPTIONS(self) -> None:
                self._send(200, b"", "text/plain")

        return Handler

    def __enter__(self) -> "FakeWebdavServer":
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    def journal(self, device_id: str) -> str | None:
        data = self.files.get(f"notebook_backup/journal/{device_id}.jsonl")
        return data.decode() if data is not None else None

    def put_journal(self, device_id: str, lines: list[str]) -> None:
        self.files[f"notebook_backup/journal/{device_id}.jsonl"] = ("\n".join(lines) + "\n").encode()
        self.dirs.add("notebook_backup/journal")

    def put_object(self, hash_value: str, data: bytes) -> None:
        self.files[f"notebook_backup/objects/{hash_value[:2]}/{hash_value}"] = data
        self.dirs.add(f"notebook_backup/objects/{hash_value[:2]}")


DEVICE_A = "00000000-0000-4000-8000-000000000001"
DEVICE_B = "00000000-0000-4000-8000-000000000002"


@pytest.fixture()
def webdav_server() -> Iterator[FakeWebdavServer]:
    with FakeWebdavServer() as server:
        yield server


def connection(webdav_server: FakeWebdavServer) -> WebdavConnection:
    return WebdavConnection(
        baseUrl=f"http://127.0.0.1:{webdav_server.port}/dav/",
        username="user",
        appPassword="app-password",
        remotePath="notebook_backup",
    )


def test_connection_probe_and_append_pull_round_trip(webdav_server: FakeWebdavServer) -> None:
    settings = connection(webdav_server)
    assert probe_connection(settings).ok is True
    # journal/ does not exist until a pull creates it.
    assert probe_connection(settings).remotePathExists is False

    first = push_repository(WebdavPushRequest(
        settings=settings,
        deviceId=DEVICE_A,
        entries=[
            JournalPushEntry(ts="2026-08-04T00:00:00Z", op="upsert", type="page", id="page-1", ver=0, payload={"title": "a"}),
            JournalPushEntry(ts="2026-08-04T00:00:01Z", op="upsert", type="page", id="page-2", ver=1, payload={"title": "b"}),
        ],
    ))
    assert first == WebdavPushResult(firstSeq=1, count=2)
    assert probe_connection(settings).remotePathExists is True
    second = push_repository(WebdavPushRequest(
        settings=settings,
        deviceId=DEVICE_A,
        entries=[JournalPushEntry(ts="2026-08-04T00:00:02Z", op="delete", type="page", id="page-1", ver=2, payload={})],
    ))
    assert second == WebdavPushResult(firstSeq=3, count=1)
    # A second device starts its own journal at seq 1.
    push_repository(WebdavPushRequest(
        settings=settings,
        deviceId=DEVICE_B,
        entries=[JournalPushEntry(ts="2026-08-04T00:00:03Z", op="upsert", type="page", id="page-3", ver=0, payload={"title": "c"})],
    ))

    pulled = pull_journals(WebdavPullRequest(settings=settings, knownSeqs={DEVICE_A: 2}))
    assert [(item.deviceId, item.seq, item.type, item.id) for item in pulled.entries] == [
        (DEVICE_A, 3, "page", "page-1"),
        (DEVICE_B, 1, "page", "page-3"),
    ]
    assert pulled.fingerprint == f"http://127.0.0.1:{webdav_server.port}/dav|user|notebook_backup"
    webdav_server.gets.clear()
    assert pull_journals(WebdavPullRequest(settings=settings, knownSeqs={DEVICE_A: 3, DEVICE_B: 1})).entries == []
    assert all(not path.endswith(".jsonl") for path in webdav_server.gets)
    assert sum(path.endswith(".head.json") for path in webdav_server.gets) == 2


def test_push_publishes_objects_before_the_journal(webdav_server: FakeWebdavServer) -> None:
    settings = connection(webdav_server)
    object_bytes = b"\x00\x01\xfe\xff"
    hash_value = hashlib.sha256(object_bytes).hexdigest()
    result = push_repository(WebdavPushRequest(
        settings=settings,
        deviceId=DEVICE_A,
        entries=[JournalPushEntry(ts="t", op="upsert", type="document", id="page-1", ver=0, hash=hash_value, payload={"tiptapJson": {"$object": hash_value}})],
        objects=[PushObject(hash=hash_value, dataBase64=base64.b64encode(object_bytes).decode())],
    ))
    assert result == WebdavPushResult(firstSeq=1, count=1)
    stored = get_object(WebdavObjectRequest(settings=settings, hash=hash_value))
    assert base64.b64decode(stored.dataBase64) == object_bytes
    with pytest.raises(RuntimeError, match="不存在"):
        get_object(WebdavObjectRequest(settings=settings, hash="cd" * 32))
    object_path = f"notebook_backup/objects/{hash_value[:2]}/{hash_value}"
    before = webdav_server.puts.count(object_path)
    push_repository(WebdavPushRequest(settings=settings, deviceId=DEVICE_A, entries=[], objects=[PushObject(hash=hash_value, dataBase64=base64.b64encode(b"different").decode())]))
    assert webdav_server.puts.count(object_path) == before


def test_head_checksum_and_bounded_revision_ring(webdav_server: FakeWebdavServer, monkeypatch) -> None:
    monkeypatch.setattr(legacy_webdav, "MAX_REVISION_ENTRIES", 2)
    settings = connection(webdav_server)
    push_repository(WebdavPushRequest(
        settings=settings,
        deviceId=DEVICE_A,
        entries=[
            JournalPushEntry(ts="t0", op="delete", type="page", id="page-current", ver=1, payload={}),
            *[JournalPushEntry(ts=f"t{index + 1}", op="upsert", type="revision", id=f"revision-{index}", ver=0, payload={"body": str(index)}) for index in range(3)],
        ],
    ))
    journal = [json.loads(line) for line in webdav_server.journal(DEVICE_A).splitlines()]
    assert [entry["id"] for entry in journal if entry["type"] == "revision"] == ["revision-1", "revision-2"]
    assert next(entry for entry in journal if entry["type"] == "page")["op"] == "delete"
    head_path = f"notebook_backup/journal/{DEVICE_A}.head.json"
    head = json.loads(webdav_server.files[head_path])
    assert head["historyEntries"] == 2
    head["journalSha256"] = "0" * 64
    webdav_server.files[head_path] = json.dumps(head).encode()
    with pytest.raises(RuntimeError, match="提交标记不一致"):
        pull_journals(WebdavPullRequest(settings=settings, knownSeqs={}))


def test_push_compacts_an_entry_count_overflow_and_preserves_tail_sequence(webdav_server: FakeWebdavServer, monkeypatch) -> None:
    monkeypatch.setattr(legacy_webdav, "MAX_ENTRIES", 2)
    settings = connection(webdav_server)
    initial = push_repository(WebdavPushRequest(
        settings=settings,
        deviceId=DEVICE_A,
        entries=[
            JournalPushEntry(ts="t1", op="upsert", type="page", id="page-1", ver=0, payload={}),
            JournalPushEntry(ts="t2", op="upsert", type="page", id="page-1", ver=1, payload={}),
        ],
    ))
    assert initial == WebdavPushResult(firstSeq=1, count=2)
    appended = push_repository(WebdavPushRequest(
        settings=settings,
        deviceId=DEVICE_A,
        entries=[JournalPushEntry(ts="t3", op="upsert", type="page", id="page-2", ver=0, payload={})],
    ))
    assert appended == WebdavPushResult(firstSeq=3, count=1)
    assert [json.loads(line)["seq"] for line in webdav_server.journal(DEVICE_A).splitlines()] == [2, 3]


def test_journal_caps_are_utf8_byte_accurate_and_recovery_reads_are_bounded(webdav_server: FakeWebdavServer, monkeypatch) -> None:
    settings = connection(webdav_server)
    entry = JournalPushEntry(ts="t", op="upsert", type="page", id="page-1", ver=0, payload={"body": "中" * 30})
    body = json.dumps({**entry.model_dump(), "seq": 1}, ensure_ascii=False, separators=(",", ":")) + "\n"
    assert len(body) < len(body.encode("utf-8"))
    monkeypatch.setattr(legacy_webdav, "MAX_LOG_BYTES", len(body.encode("utf-8")) - 1)
    with pytest.raises(RuntimeError, match="设备日志.*超过"):
        push_repository(WebdavPushRequest(settings=settings, deviceId=DEVICE_A, entries=[entry]))

    monkeypatch.setattr(legacy_webdav, "MAX_LOG_BYTES", 100)
    webdav_server.files[f"notebook_backup/journal/{DEVICE_A}.jsonl"] = b"x" * 101
    webdav_server.dirs.add("notebook_backup/journal")
    with pytest.raises(RuntimeError, match="远端日志.*100 MB"):
        pull_journals(WebdavPullRequest(settings=settings, knownSeqs={}))
    with pytest.raises(RuntimeError, match="远端日志.*100 MB"):
        push_repository(WebdavPushRequest(settings=settings, deviceId=DEVICE_A, entries=[]))


def test_pull_ignores_invalid_filenames_but_surfaces_propfind_errors(webdav_server: FakeWebdavServer) -> None:
    settings = connection(webdav_server)
    webdav_server.put_journal("not-a-device", ["{not json}"])
    assert pull_journals(WebdavPullRequest(settings=settings, knownSeqs={})).entries == []
    webdav_server.propfind_failure_status = 401
    with pytest.raises(RuntimeError, match="HTTP 401"):
        pull_journals(WebdavPullRequest(settings=settings, knownSeqs={}))


def test_connection_rejects_unsafe_paths(webdav_server: FakeWebdavServer) -> None:
    settings = WebdavConnection(
        baseUrl=f"http://127.0.0.1:{webdav_server.port}/dav/",
        username="user",
        appPassword="pw",
        remotePath="../escape",
    )
    result = probe_connection(settings)
    assert result.ok is False
    assert "远端同步目录不安全" in result.message


class FakeGatewayBridge:
    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        return [[1.0, 0.0]] * len(texts)
    async def stream_chat(self, request, **_) -> Iterator[str]:
        yield "ok"


def _loopback_client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings, FakeGatewayBridge()), base_url="http://127.0.0.1", client=("127.0.0.1", 50000))


def test_local_webdav_bridge_is_disabled_by_default(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("notebook_ai.main.pull_journals", lambda _: None)
    with TestClient(create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'off.db'}"), FakeGatewayBridge())) as client:
        response = client.post("/v1/local-webdav/pull", json={"settings": {"baseUrl": "https://dav.jianguoyun.com/dav/", "username": "u", "appPassword": "p", "remotePath": "notebook_backup"}, "knownSeqs": {}})
        assert response.status_code == 404


def test_local_webdav_bridge_routes(monkeypatch, tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'bridge.db'}", enable_local_sftp_bridge=True, api_token="secret")
    monkeypatch.setattr("notebook_ai.main.test_connection", lambda _: type("R", (), {"ok": True, "remotePathExists": True, "latencyMs": 3, "message": ""})())
    monkeypatch.setattr("notebook_ai.main.pull_journals", lambda _: type("R", (), {"entries": [], "fingerprint": "fp"})())
    monkeypatch.setattr("notebook_ai.main.get_object", lambda _: WebdavObjectResponse(dataBase64="AQI="))
    monkeypatch.setattr("notebook_ai.main.push_webdav_repository", lambda _: WebdavPushResult(firstSeq=1, count=1))
    payload = {"settings": {"baseUrl": "https://dav.jianguoyun.com/dav/", "username": "u", "appPassword": "p", "remotePath": "notebook_backup"}}
    with _loopback_client(settings) as client:
        assert client.post("/v1/local-webdav/test", json=payload).status_code == 401
        headers = {"Authorization": "Bearer secret"}
        assert client.post("/v1/local-webdav/test", headers=headers, json=payload).json()["ok"] is True
        assert client.post("/v1/local-webdav/pull", headers=headers, json={**payload, "knownSeqs": {}}).json()["fingerprint"] == "fp"
        assert client.post("/v1/local-webdav/object", headers=headers, json={**payload, "hash": "ab" * 32}).json()["dataBase64"] == "AQI="
        pushed = client.post("/v1/local-webdav/push", headers=headers, json={
            **payload,
            "deviceId": DEVICE_A,
            "entries": [{"ts": "t", "op": "upsert", "type": "page", "id": "page-1", "ver": 0, "payload": {}}],
        })
        assert pushed.status_code == 200
        assert pushed.json() == {"firstSeq": 1, "count": 1}
    with TestClient(create_app(settings, FakeGatewayBridge()), base_url="http://127.0.0.1", client=("198.51.100.20", 50000)) as client:
        assert client.post("/v1/local-webdav/pull", headers=headers, json=payload).status_code == 404


def test_local_webdav_bridge_does_not_leak_backend_errors(monkeypatch, tmp_path) -> None:
    def fail(_):
        raise RuntimeError("appPassword=supersecret https://dav.jianguoyun.com/dav/secret")

    monkeypatch.setattr("notebook_ai.main.pull_journals", fail)
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'bridge-error.db'}", enable_local_sftp_bridge=True, api_token="secret")
    payload = {"settings": {"baseUrl": "https://dav.jianguoyun.com/dav/", "username": "u", "appPassword": "p", "remotePath": "notebook_backup"}, "knownSeqs": {}}
    with _loopback_client(settings) as client:
        response = client.post("/v1/local-webdav/pull", headers={"Authorization": "Bearer secret"}, json=payload)
        assert response.status_code == 502
        assert "WebDAV" in response.json()["detail"]
        assert "supersecret" not in response.text
