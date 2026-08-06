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
import json
import posixpath
import re
import time
import xml.etree.ElementTree as ET

import requests
from pydantic import BaseModel, Field, field_validator, model_validator

MAX_LOG_BYTES = 4 * 1024 * 1024
MAX_OBJECT_BYTES = 100 * 1024 * 1024
MAX_ENTRIES = 100_000
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
    response = session.request(
        "PROPFIND", _url(settings, f"{root}/journal"), data=PROPFIND_BODY, headers={"Depth": "1"}, timeout=(15, 60),
    )
    if response.status_code == 207:
        names = [posixpath.basename(href) for href in _parse_hrefs(response.text)]
        device_ids = [name[:-len(".jsonl")] for name in names if name.endswith(".jsonl") and DEVICE_ID_PATTERN.match(name[:-len(".jsonl")])]
    entries: list[JournalPullEntry] = []
    for device_id in device_ids:
        response = session.get(_url(settings, f"{root}/journal/{device_id}.jsonl"), timeout=(15, 120))
        if response.status_code == 404:
            continue
        if response.status_code != 200:
            _fail(response, f"下载日志 {device_id}.jsonl 失败")
        text = response.text
        if len(text.encode("utf-8")) > MAX_LOG_BYTES:
            raise RuntimeError(f"远端日志 {device_id}.jsonl 超过 4 MB 上限")
        known = request.knownSeqs.get(device_id, 0)
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            entry = WebdavJournalEntry.model_validate_json(line)
            if entry.seq <= known:
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
    return WebdavObjectResponse(dataBase64=base64.b64encode(data).decode())


def _put_object(session: requests.Session, settings: WebdavConnection, hash_value: str, data: bytes) -> None:
    if not HASH_PATTERN.match(hash_value):
        raise ValueError(f"对象哈希格式不正确：{hash_value}")
    if len(data) > MAX_OBJECT_BYTES:
        raise RuntimeError("对象超过 100 MB 上限")
    root = _safe_remote_path(settings.remotePath)
    _ensure_directory(session, settings, f"{root}/objects/{hash_value[:2]}")
    response = session.put(_url(settings, f"{root}/objects/{hash_value[:2]}/{hash_value}"), data=data, timeout=(15, 600))
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
        existing = [WebdavJournalEntry.model_validate_json(line) for line in response.text.splitlines() if line.strip()]
    else:
        _fail(response, f"读取日志 {device_id}.jsonl 失败")
    if len(existing) + len(entries) > MAX_ENTRIES:
        raise RuntimeError("设备日志条目数超过 10 万，请先压缩日志")
    first_seq = (existing[-1].seq + 1) if existing else 1
    lines = [json.dumps(entry.model_dump(), ensure_ascii=False) for entry in existing]
    lines.extend(
        json.dumps({**entry.model_dump(), "seq": first_seq + index}, ensure_ascii=False)
        for index, entry in enumerate(entries)
    )
    body = ("\n".join(lines) + "\n").encode("utf-8")
    if len(body) > MAX_LOG_BYTES:
        raise RuntimeError("设备日志超过 4 MB 上限")
    response = session.put(_url(settings, path), data=body, timeout=(15, 600))
    if response.status_code not in {200, 201, 204}:
        _fail(response, f"上传日志 {device_id}.jsonl 失败")
    return WebdavPushResult(firstSeq=first_seq, count=len(entries))


def push_repository(request: WebdavPushRequest) -> WebdavPushResult:
    """Objects are published before the journal, mirroring the Electron IPC handler."""
    session = _session(request.settings)
    for obj in request.objects:
        _put_object(session, request.settings, obj.hash, base64.b64decode(obj.dataBase64, validate=True))
    return _append_journal(session, request.settings, request.deviceId, request.entries)
