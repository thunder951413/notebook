"""WebDAV transport for the v4 append-only journal repository (e.g. 坚果云).

Mirrors apps/desktop/src/main/webdav.ts so browser builds can sync through
this loopback helper instead of the Electron IPC surface. Repository layout:

  journal/<deviceID>.jsonl   per-device append-only change log
  objects/<xx>/<sha256>      content-addressed note/attachment bytes

Each device only ever writes its own journal file (single writer), so the
read-modify-write append below is race-free across devices.
"""
from __future__ import annotations

import base64
import hashlib
import json
import posixpath
import re
import time
import xml.etree.ElementTree as ET

import requests
from pydantic import BaseModel, Field, field_validator, model_validator

MAX_LOG_BYTES = 100 * 1024 * 1024
MAX_OBJECT_BYTES = 100 * 1024 * 1024
MAX_ENTRIES = 100_000
MAX_HEAD_BYTES = 64 * 1024
MAX_REVISION_ENTRIES = 256
MAX_REVISION_BYTES = 2 * 1024 * 1024
DEVICE_ID_PATTERN = re.compile(r"^[0-9a-f-]{36}$", re.I)
HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$", re.I)
PROPFIND_BODY = b'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
DAV_NS = "{DAV:}"


class WebdavConnection(BaseModel):
    baseUrl: str = Field(min_length=1, max_length=2048)
    username: str = Field(min_length=1, max_length=256)
    appPassword: str = Field(min_length=1, max_length=4096, repr=False)
    remotePath: str = Field(min_length=1, max_length=2048)
    syncPassword: str = Field(default="", max_length=4096, repr=False)

    @field_validator("baseUrl")
    @classmethod
    def base_url_is_http(cls, value: str) -> str:
        if not re.match(r"^https?://", value) or any(character.isspace() for character in value):
            raise ValueError("WebDAV 服务器地址不正确")
        return value.strip()

    @model_validator(mode="after")
    def require_credentials(self) -> "WebdavConnection":
        if not self.username or not self.appPassword:
            raise ValueError("请填写 WebDAV 用户名与应用密码")
        return self


class WebdavJournalEntry(BaseModel):
    seq: int = Field(ge=1)
    ts: str
    op: str
    type: str = Field(min_length=1)
    id: str = Field(min_length=1)
    ver: int = Field(ge=0)
    hash: str | None = None
    payload: dict[str, object]

    @field_validator("op")
    @classmethod
    def operation_is_supported(cls, value: str) -> str:
        if value not in {"upsert", "delete"}:
            raise ValueError("远端日志包含非法操作")
        return value


class JournalPushEntry(BaseModel):
    """Entry pushed by the client; the server assigns the sequence number."""

    ts: str
    op: str
    type: str = Field(min_length=1)
    id: str = Field(min_length=1)
    ver: int = Field(ge=0)
    hash: str | None = None
    payload: dict[str, object]


class WebdavJournalHead(BaseModel):
    version: int = Field(ge=1, le=1)
    deviceId: str
    lastSeq: int = Field(ge=0)
    journalBytes: int = Field(ge=0, le=MAX_LOG_BYTES)
    journalSha256: str
    updatedAt: str
    stateEntries: int = Field(ge=0)
    historyEntries: int = Field(ge=0)

    @field_validator("deviceId")
    @classmethod
    def device_id_is_uuid(cls, value: str) -> str:
        if not DEVICE_ID_PATTERN.match(value):
            raise ValueError("远端日志索引设备 ID 不正确")
        return value

    @field_validator("journalSha256")
    @classmethod
    def journal_hash_is_sha256(cls, value: str) -> str:
        if not HASH_PATTERN.match(value):
            raise ValueError("远端日志索引校验值不正确")
        return value.lower()


class JournalPullEntry(WebdavJournalEntry):
    deviceId: str


class WebdavPullRequest(BaseModel):
    settings: WebdavConnection
    knownSeqs: dict[str, int] = {}


class WebdavPullResult(BaseModel):
    entries: list[JournalPullEntry]
    fingerprint: str


class WebdavObjectRequest(BaseModel):
    settings: WebdavConnection
    hash: str


class WebdavObjectResponse(BaseModel):
    dataBase64: str


class PushObject(BaseModel):
    hash: str = Field(min_length=64, max_length=64)
    dataBase64: str


class WebdavPushRequest(BaseModel):
    settings: WebdavConnection
    deviceId: str
    entries: list[JournalPushEntry] = []
    objects: list[PushObject] = []

    @field_validator("deviceId")
    @classmethod
    def device_id_is_uuid(cls, value: str) -> str:
        if not DEVICE_ID_PATTERN.match(value):
            raise ValueError(f"设备 ID 不正确：{value}")
        return value


class WebdavPushResult(BaseModel):
    firstSeq: int
    count: int


class WebdavTestRequest(BaseModel):
    settings: WebdavConnection


class WebdavTestResult(BaseModel):
    ok: bool
    remotePathExists: bool
    latencyMs: int
    message: str


def _safe_remote_path(value: str) -> str:
    normalized = posixpath.normpath(value.strip().replace("\\", "/"))
    if (
        not normalized
        or normalized.startswith("/")
        or normalized == ".."
        or normalized.startswith("../")
        or "\x00" in normalized
        or any(segment in {"", ".", ".."} for segment in normalized.split("/"))
    ):
        raise ValueError(f"远端同步目录不安全：{value}")
    return normalized


def _base_url(settings: WebdavConnection) -> str:
    return settings.baseUrl.strip().rstrip("/")


def _url(settings: WebdavConnection, path: str) -> str:
    return f"{_base_url(settings)}/{path}"


def _session(settings: WebdavConnection) -> requests.Session:
    session = requests.Session()
    session.auth = (settings.username.strip(), settings.appPassword)
    return session


def _fail(response: requests.Response, context: str) -> None:
    detail = response.text.strip()[:300]
    suffix = f"（HTTP {response.status_code}）" if not detail else f"（HTTP {response.status_code}：{detail}）"
    raise RuntimeError(f"{context}{suffix}")


def _ensure_directory(session: requests.Session, settings: WebdavConnection, path: str) -> None:
    # 坚果云 rejects nested MKCOL with 409 when the parent is missing, so every
    # segment is created from the root down. 201 (idempotent create) and the
    # usual already-exists codes (405/409/301/302) are both tolerated.
    current = ""
    for segment in path.split("/"):
        if not segment:
            continue
        current = f"{current}/{segment}" if current else segment
        response = session.request("MKCOL", _url(settings, current), timeout=(15, 60))
        if response.status_code not in {200, 201, 204, 405, 409, 301, 302}:
            _fail(response, f"创建远端目录 {current} 失败")


def _parse_hrefs(text: str) -> list[str]:
    root = ET.fromstring(text)
    return [item.text.strip() for item in root.iter(f"{DAV_NS}href") if item.text and item.text.strip()]


def _exists(session: requests.Session, settings: WebdavConnection, path: str) -> bool:
    response = session.request("PROPFIND", _url(settings, path), data=PROPFIND_BODY, headers={"Depth": "0"}, timeout=(15, 60))
    if response.status_code == 404:
        return False
    if response.status_code != 207:
        _fail(response, f"检查远端目录 {path} 失败")
    return bool(_parse_hrefs(response.text))


def _journal_head_path(root: str, device_id: str) -> str:
    return f"{root}/journal/{device_id}.head.json"


def _parse_head(data: bytes, device_id: str) -> WebdavJournalHead:
    if len(data) > MAX_HEAD_BYTES:
        raise RuntimeError(f"远端日志 {device_id}.head.json 超过 64 KiB 上限")
    try:
        head = WebdavJournalHead.model_validate_json(data)
    except Exception as error:
        raise RuntimeError(f"远端日志 {device_id}.head.json 内容不正确") from error
    if head.deviceId != device_id:
        raise RuntimeError(f"远端日志 {device_id}.head.json 设备 ID 不匹配")
    return head


def _compact_journal(entries: list[WebdavJournalEntry]) -> tuple[list[WebdavJournalEntry], int, int]:
    state: dict[tuple[str, str], WebdavJournalEntry] = {}
    revisions: dict[tuple[str, str], WebdavJournalEntry] = {}
    for entry in entries:
        target = revisions if entry.type == "revision" else state
        key = (entry.type, entry.id)
        previous = target.get(key)
        if previous is None or entry.seq > previous.seq:
            target[key] = entry
    history: list[WebdavJournalEntry] = []
    history_bytes = 0
    for entry in sorted(revisions.values(), key=lambda item: item.seq, reverse=True):
        if len(history) >= MAX_REVISION_ENTRIES:
            break
        size = len(json.dumps(entry.model_dump(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        if history and history_bytes + size > MAX_REVISION_BYTES:
            break
        history.append(entry)
        history_bytes += size
    compacted = sorted([*state.values(), *history], key=lambda item: item.seq)
    return compacted, len(state), len(history)


def test_connection(settings: WebdavConnection) -> WebdavTestResult:
    started = time.monotonic()
    try:
        session = _session(settings)
        root = _safe_remote_path(settings.remotePath)
        _ensure_directory(session, settings, root)
        exists = _exists(session, settings, f"{root}/journal")
        return WebdavTestResult(
            ok=True,
            remotePathExists=exists,
            latencyMs=int((time.monotonic() - started) * 1000),
            message="",
        )
    except Exception as error:
        return WebdavTestResult(
            ok=False,
            remotePathExists=False,
            latencyMs=int((time.monotonic() - started) * 1000),
            message=str(error),
        )


def pull_journals(request: WebdavPullRequest) -> WebdavPullResult:
    settings = request.settings
    session = _session(settings)
    root = _safe_remote_path(settings.remotePath)
    _ensure_directory(session, settings, f"{root}/journal")
    device_ids: list[str] = []
    devices_with_heads: set[str] = set()
    response = session.request(
        "PROPFIND", _url(settings, f"{root}/journal"), data=PROPFIND_BODY, headers={"Depth": "1"}, timeout=(15, 60),
    )
    if response.status_code == 207:
        names = [posixpath.basename(href) for href in _parse_hrefs(response.text)]
        device_ids = [name[:-len(".jsonl")] for name in names if name.endswith(".jsonl") and DEVICE_ID_PATTERN.match(name[:-len(".jsonl")])]
        devices_with_heads = {
            name[:-len(".head.json")] for name in names
            if name.endswith(".head.json") and DEVICE_ID_PATTERN.match(name[:-len(".head.json")])
        }
    elif response.status_code != 404:
        _fail(response, f"列出远端日志目录 {root}/journal 失败")
    entries: list[JournalPullEntry] = []
    for device_id in device_ids:
        known = request.knownSeqs.get(device_id, 0)
        head: WebdavJournalHead | None = None
        if device_id in devices_with_heads:
            head_response = session.get(_url(settings, _journal_head_path(root, device_id)), timeout=(15, 60))
            if head_response.status_code == 200:
                head = _parse_head(head_response.content, device_id)
            elif head_response.status_code != 404:
                _fail(head_response, f"下载日志索引 {device_id}.head.json 失败")
            if head is not None and known >= head.lastSeq:
                continue
        response = session.get(_url(settings, f"{root}/journal/{device_id}.jsonl"), timeout=(15, 120))
        if response.status_code == 404:
            continue
        if response.status_code != 200:
            _fail(response, f"下载日志 {device_id}.jsonl 失败")
        text = response.content.decode("utf-8")
        # Long-lived devices may already exceed the legacy 4 MB failure limit;
        # 100 MB is only a recovery/abuse guard until v5 segments the log.
        if len(text.encode("utf-8")) > MAX_LOG_BYTES:
            raise RuntimeError(f"远端日志 {device_id}.jsonl 超过 100 MB 上限")
        journal: list[WebdavJournalEntry] = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            entry = WebdavJournalEntry.model_validate_json(line)
            journal.append(entry)
        if head is not None:
            committed = response.content[:head.journalBytes]
            journal_last_seq = max((entry.seq for entry in journal), default=0)
            matches = len(response.content) == head.journalBytes and hashlib.sha256(response.content).hexdigest() == head.journalSha256
            prefix_matches = len(response.content) >= head.journalBytes and hashlib.sha256(committed).hexdigest() == head.journalSha256
            if not matches and not (journal_last_seq > head.lastSeq and prefix_matches):
                raise RuntimeError(f"远端日志 {device_id}.jsonl 与提交标记不一致")
        for entry in journal:
            if entry.seq <= known or (head is not None and entry.seq > head.lastSeq):
                continue
            entries.append(JournalPullEntry(**entry.model_dump(), deviceId=device_id))
    entries.sort(key=lambda item: (item.deviceId, item.seq))
    return WebdavPullResult(
        entries=entries,
        fingerprint=f"{_base_url(settings)}|{settings.username.strip()}|{root}",
    )


def get_object(request: WebdavObjectRequest) -> WebdavObjectResponse:
    settings = request.settings
    if not HASH_PATTERN.match(request.hash):
        raise ValueError(f"对象哈希格式不正确：{request.hash}")
    session = _session(settings)
    root = _safe_remote_path(settings.remotePath)
    response = session.get(_url(settings, f"{root}/objects/{request.hash[:2]}/{request.hash}"), timeout=(15, 120))
    if response.status_code == 404:
        raise RuntimeError(f"远端对象 {request.hash} 不存在")
    if response.status_code != 200:
        _fail(response, f"下载对象 {request.hash} 失败")
    data = response.content
    if len(data) > MAX_OBJECT_BYTES:
        raise RuntimeError("远端对象超过 100 MB 上限")
    if hashlib.sha256(data).hexdigest() != request.hash.lower():
        raise RuntimeError(f"远端对象 {request.hash} 的 SHA-256 校验失败")
    return WebdavObjectResponse(dataBase64=base64.b64encode(data).decode())


def _put_object(session: requests.Session, settings: WebdavConnection, hash_value: str, data: bytes) -> None:
    if not HASH_PATTERN.match(hash_value):
        raise ValueError(f"对象哈希格式不正确：{hash_value}")
    if len(data) > MAX_OBJECT_BYTES:
        raise RuntimeError("对象超过 100 MB 上限")
    root = _safe_remote_path(settings.remotePath)
    target = f"{root}/objects/{hash_value[:2]}/{hash_value}"
    if _exists(session, settings, target):
        return
    _ensure_directory(session, settings, f"{root}/objects/{hash_value[:2]}")
    response = session.put(_url(settings, target), data=data, timeout=(15, 600))
    if response.status_code not in {200, 201, 204}:
        _fail(response, f"上传对象 {hash_value} 失败")


def _append_journal(session: requests.Session, settings: WebdavConnection, device_id: str, entries: list[JournalPushEntry]) -> WebdavPushResult:
    root = _safe_remote_path(settings.remotePath)
    path = f"{root}/journal/{device_id}.jsonl"
    _ensure_directory(session, settings, f"{root}/journal")
    existing: list[WebdavJournalEntry] = []
    response = session.get(_url(settings, path), timeout=(15, 120))
    if response.status_code == 404:
        pass
    elif response.status_code == 200:
        text = response.text
        if len(text.encode("utf-8")) > MAX_LOG_BYTES:
            raise RuntimeError(f"远端日志 {device_id}.jsonl 超过 100 MB 上限")
        existing = [WebdavJournalEntry.model_validate_json(line) for line in text.splitlines() if line.strip()]
    else:
        _fail(response, f"读取日志 {device_id}.jsonl 失败")
    first_seq = max((entry.seq for entry in existing), default=0) + 1
    journal_entries: list[WebdavJournalEntry] = [*existing]
    journal_entries.extend(WebdavJournalEntry(**entry.model_dump(), seq=first_seq + index) for index, entry in enumerate(entries))
    journal_entries, state_entries, history_entries = _compact_journal(journal_entries)
    lines = [json.dumps(entry.model_dump(), ensure_ascii=False, separators=(",", ":")) for entry in journal_entries]
    body = ("\n".join(lines) + "\n").encode("utf-8")
    if len(journal_entries) > MAX_ENTRIES:
        raise RuntimeError("设备日志条目数超过 10 万，请先压缩日志")
    if len(body) > MAX_LOG_BYTES:
        raise RuntimeError("设备日志压缩后超过 100 MB 上限")
    response = session.put(_url(settings, path), data=body, timeout=(15, 600))
    if response.status_code not in {200, 201, 204}:
        _fail(response, f"上传日志 {device_id}.jsonl 失败")
    head = WebdavJournalHead(
        version=1,
        deviceId=device_id,
        lastSeq=max((entry.seq for entry in journal_entries), default=0),
        journalBytes=len(body),
        journalSha256=hashlib.sha256(body).hexdigest(),
        updatedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        stateEntries=state_entries,
        historyEntries=history_entries,
    )
    response = session.put(
        _url(settings, _journal_head_path(root, device_id)),
        data=head.model_dump_json().encode("utf-8"),
        timeout=(15, 60),
    )
    if response.status_code not in {200, 201, 204}:
        _fail(response, f"上传日志索引 {device_id}.head.json 失败")
    return WebdavPushResult(firstSeq=first_seq, count=len(entries))


def push_repository(request: WebdavPushRequest) -> WebdavPushResult:
    """Objects are published before the journal, mirroring the Electron IPC handler."""
    session = _session(request.settings)
    for obj in request.objects:
        _put_object(session, request.settings, obj.hash, base64.b64decode(obj.dataBase64, validate=True))
    return _append_journal(session, request.settings, request.deviceId, request.entries)
