from __future__ import annotations

import base64
import hashlib
import json
import posixpath
import time
import uuid
from dataclasses import dataclass

import paramiko
from pydantic import BaseModel, Field, field_validator

MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_REPOSITORY_BYTES = 512 * 1024 * 1024
UUID_PATTERN = __import__("re").compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", __import__("re").I)


class SshConnection(BaseModel):
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(ge=1, le=65535)
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=4096, repr=False)
    remotePath: str = Field(min_length=1, max_length=2048)
    fingerprint: str = Field(default="", max_length=256)

    @field_validator("host")
    @classmethod
    def host_is_plain(cls, value: str) -> str:
        if any(character.isspace() or character == "/" for character in value):
            raise ValueError("SSH host is invalid")
        return value.strip()


class RepositoryFile(BaseModel):
    name: str = Field(min_length=1, max_length=4096)
    dataBase64: str


class PullRequest(BaseModel):
    settings: SshConnection


class PushRequest(BaseModel):
    settings: SshConnection
    files: list[RepositoryFile]
    expectedIndexHash: str = Field(default="", max_length=128)


class PullResponse(BaseModel):
    files: list[RepositoryFile]
    indexHash: str
    fingerprint: str


class PushResponse(BaseModel):
    fingerprint: str


def _fingerprint(key: paramiko.PKey) -> str:
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


class _PinnedHostPolicy(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected: str):
        self.expected = expected
        self.presented = ""

    def missing_host_key(self, client: paramiko.SSHClient, hostname: str, key: paramiko.PKey) -> None:
        del client, hostname
        self.presented = _fingerprint(key)
        if self.expected and self.presented != self.expected:
            raise paramiko.SSHException(f"SSH 主机指纹已变化|{self.expected}|{self.presented}")


def _safe_relative(value: str) -> str:
    normalized = posixpath.normpath(value.replace("\\", "/")).removeprefix("./")
    if not normalized or normalized.startswith("/") or normalized == ".." or normalized.startswith("../"):
        raise ValueError(f"远端仓库包含不安全路径：{value}")
    return normalized


def _allowed_file(value: str) -> bool:
    name = _safe_relative(value)
    if name in {"library.json", "notes/index.json", "notes/reading_positions.json", "notes/assets_manifest.json"}:
        return True
    if name.startswith("notes/") and name.endswith(".json"):
        return bool(UUID_PATTERN.fullmatch(name[len("notes/") : -len(".json")]))
    return name.startswith("attachments/") and len(name) > len("attachments/")


def _mkdirs(sftp: paramiko.SFTPClient, path: str) -> None:
    current = "/" if path.startswith("/") else ""
    for part in path.split("/"):
        if not part:
            continue
        current = posixpath.join(current, part)
        try:
            sftp.mkdir(current)
        except OSError:
            pass


def _read_optional(sftp: paramiko.SFTPClient, path: str) -> bytes | None:
    try:
        attributes = sftp.stat(path)
        if attributes.st_size and attributes.st_size > MAX_FILE_BYTES:
            raise ValueError(f"远端文件超过 100 MB：{posixpath.basename(path)}")
        with sftp.open(path, "rb") as source:
            content = source.read(MAX_FILE_BYTES + 1)
        if len(content) > MAX_FILE_BYTES:
            raise ValueError(f"远端文件超过 100 MB：{posixpath.basename(path)}")
        return content
    except FileNotFoundError:
        return None
    except OSError as error:
        if getattr(error, "errno", None) == 2:
            return None
        raise


@dataclass
class _Session:
    ssh: paramiko.SSHClient
    sftp: paramiko.SFTPClient
    root: str
    fingerprint: str


def _connect(settings: SshConnection) -> _Session:
    policy = _PinnedHostPolicy(settings.fingerprint.strip())
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(policy)
    try:
        ssh.connect(settings.host, port=settings.port, username=settings.username, password=settings.password, timeout=15, banner_timeout=15, auth_timeout=15, look_for_keys=False, allow_agent=False)
        sftp = ssh.open_sftp()
    except Exception:
        ssh.close()
        raise
    if not policy.presented:
        transport = ssh.get_transport()
        key = transport.get_remote_server_key() if transport else None
        policy.presented = _fingerprint(key) if key else ""
    if not policy.presented:
        sftp.close()
        ssh.close()
        raise RuntimeError("服务器没有提供可校验的 SSH 主机密钥")
    home = sftp.normalize(".")
    configured = settings.remotePath.strip()
    root = home if configured == "~" else posixpath.join(home, configured[2:]) if configured.startswith("~/") else posixpath.normpath(configured) if configured.startswith("/") else posixpath.join(home, configured)
    return _Session(ssh, sftp, root, policy.presented)


def _acquire_lock(sftp: paramiko.SFTPClient, root: str) -> tuple[str, str, str]:
    _mkdirs(sftp, posixpath.join(root, "notes"))
    lock = posixpath.join(root, "notes/.index-write.lock")
    owner_path = posixpath.join(lock, "owner")
    owner = str(uuid.uuid4())
    for attempt in range(30):
        try:
            sftp.mkdir(lock)
            with sftp.open(owner_path, "wb") as target:
                target.write(f"{owner}\n".encode())
            return lock, owner_path, owner
        except OSError:
            try:
                directory_modified_at = sftp.stat(lock).st_mtime or 0
                try:
                    owner_modified_at = sftp.stat(owner_path).st_mtime or 0
                except OSError:
                    owner_modified_at = 0
                modified_at = max(directory_modified_at, owner_modified_at)
            except OSError:
                modified_at = 0
            if modified_at and time.time() - modified_at > 1800:
                quarantine = f"{lock}.stale-{owner}"
                try:
                    sftp.rename(lock, quarantine)
                    try:
                        sftp.remove(posixpath.join(quarantine, "owner"))
                    except OSError:
                        pass
                    try:
                        sftp.rmdir(quarantine)
                    except OSError:
                        pass
                except OSError:
                    pass
                continue
            if attempt == 29:
                current_owner = _read_optional(sftp, owner_path)
                owner_hint = current_owner.decode(errors="replace").strip()[:8] if current_owner else ""
                age = max(0, int(time.time() - modified_at)) if modified_at else None
                detail = f"（锁 {owner_hint}）" if owner_hint else ""
                duration = f"，已持续约 {age} 秒" if age is not None else ""
                raise RuntimeError(f"远端仓库正在由其他设备同步{detail}{duration}；应用会在锁超过 30 分钟且确认陈旧后自动恢复，请稍后重试")
            time.sleep(1)
    raise RuntimeError("无法取得远端同步锁")


def _refresh_lock(sftp: paramiko.SFTPClient, lock: tuple[str, str, str]) -> None:
    current_owner = _read_optional(sftp, lock[1])
    if current_owner is None or current_owner.decode(errors="replace").strip() != lock[2]:
        raise RuntimeError("远端发布锁所有权已变化，已停止同步")
    now = time.time()
    sftp.utime(lock[0], (now, now))


def _release_lock(sftp: paramiko.SFTPClient, lock: tuple[str, str, str] | None) -> None:
    if not lock:
        return
    current_owner = _read_optional(sftp, lock[1])
    if current_owner is None or current_owner.decode(errors="replace").strip() != lock[2]:
        return
    try:
        sftp.remove(lock[1])
    except OSError:
        pass
    try:
        sftp.rmdir(lock[0])
    except OSError:
        pass


def _atomic_write(sftp: paramiko.SFTPClient, path: str, data: bytes) -> None:
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(f"文件超过 100 MB：{posixpath.basename(path)}")
    _mkdirs(sftp, posixpath.dirname(path))
    temporary = f"{path}.tmp.notebook-next.{uuid.uuid4()}"
    try:
        with sftp.open(temporary, "wb") as target:
            target.write(data)
        check = _read_optional(sftp, temporary)
        if check is None or hashlib.sha256(check).digest() != hashlib.sha256(data).digest():
            raise RuntimeError(f"远端临时文件校验失败：{posixpath.basename(path)}")
        try:
            sftp.posix_rename(temporary, path)
        except OSError:
            try:
                sftp.remove(path)
            except OSError:
                pass
            sftp.rename(temporary, path)
    except Exception:
        try:
            sftp.remove(temporary)
        except OSError:
            pass
        raise


def pull_repository(request: PullRequest) -> PullResponse:
    session = _connect(request.settings)
    lock: tuple[str, str, str] | None = None
    try:
        _mkdirs(session.sftp, session.root)
        _mkdirs(session.sftp, posixpath.join(session.root, "attachments"))
        lock = _acquire_lock(session.sftp, session.root)
        files: dict[str, bytes] = {}
        total_bytes = 0

        def add(name: str) -> None:
            nonlocal total_bytes
            if name in files:
                return
            content = _read_optional(session.sftp, posixpath.join(session.root, name))
            if content is not None:
                total_bytes += len(content)
                if total_bytes > MAX_REPOSITORY_BYTES:
                    raise ValueError("远端同步仓库超过 512 MB 单次传输上限；请清理无用附件或拆分仓库后重试")
                files[name] = content
            _refresh_lock(session.sftp, lock)

        for name in ("library.json", "notes/index.json", "notes/reading_positions.json", "notes/assets_manifest.json"):
            add(name)
        if index := files.get("notes/index.json"):
            for entry in json.loads(index).get("entries", []):
                note_id = entry.get("noteID", "")
                if UUID_PATTERN.fullmatch(note_id):
                    add(f"notes/{note_id}.json")
        if manifest := files.get("notes/assets_manifest.json"):
            for entry in json.loads(manifest).get("entries", []):
                if isinstance(entry.get("relativePath"), str):
                    add(f"attachments/{_safe_relative(entry['relativePath'])}")
        return PullResponse(files=[RepositoryFile(name=name, dataBase64=base64.b64encode(data).decode()) for name, data in files.items()], indexHash=hashlib.sha256(files.get("notes/index.json", b"")).hexdigest() if "notes/index.json" in files else "", fingerprint=session.fingerprint)
    finally:
        _release_lock(session.sftp, lock)
        session.sftp.close()
        session.ssh.close()


def push_repository(request: PushRequest) -> PushResponse:
    decoded = [(_safe_relative(item.name), base64.b64decode(item.dataBase64, validate=True)) for item in request.files]
    if any(not _allowed_file(name) for name, _ in decoded):
        raise ValueError("同步请求包含不允许的远端路径")
    if sum(len(data) for _, data in decoded) > MAX_REPOSITORY_BYTES:
        raise ValueError("待上传同步仓库超过 512 MB 单次传输上限")
    session = _connect(request.settings)
    lock: tuple[str, str, str] | None = None
    try:
        _mkdirs(session.sftp, session.root)
        lock = _acquire_lock(session.sftp, session.root)
        current = _read_optional(session.sftp, posixpath.join(session.root, "notes/index.json"))
        current_hash = hashlib.sha256(current).hexdigest() if current is not None else ""
        if current_hash != request.expectedIndexHash:
            raise RuntimeError("远端索引在同步期间已变化，请重新同步")

        def priority(name: str) -> tuple[int, str]:
            value = 0 if name == "library.json" else 1 if name.startswith("attachments/") else 2 if name == "notes/assets_manifest.json" else 3 if name.startswith("notes/") and name not in {"notes/index.json", "notes/reading_positions.json"} else 4 if name == "notes/reading_positions.json" else 5
            return value, name

        for name, data in sorted(decoded, key=lambda item: priority(item[0])):
            _atomic_write(session.sftp, posixpath.join(session.root, name), data)
            _refresh_lock(session.sftp, lock)
        return PushResponse(fingerprint=session.fingerprint)
    finally:
        _release_lock(session.sftp, lock)
        session.sftp.close()
        session.ssh.close()


def repository_index_hash(settings: SshConnection) -> str:
    """Read only the publication index for an optimistic migration publish."""
    session = _connect(settings)
    lock: tuple[str, str, str] | None = None
    try:
        _mkdirs(session.sftp, session.root)
        lock = _acquire_lock(session.sftp, session.root)
        current = _read_optional(session.sftp, posixpath.join(session.root, "notes/index.json"))
        return hashlib.sha256(current).hexdigest() if current is not None else ""
    finally:
        _release_lock(session.sftp, lock)
        session.sftp.close()
        session.ssh.close()
