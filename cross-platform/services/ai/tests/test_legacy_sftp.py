import gzip
import io
import json
from types import SimpleNamespace

import paramiko
import pytest

from notebook_ai.legacy_sftp import (
    _PinnedHostPolicy,
    _allowed_file,
    _atomic_write,
    _fingerprint,
    _prepare_repository_files,
    _safe_relative,
    _uses_compressed_notes,
)


NOTE_ID = "30000000-0000-4000-8000-000000000001"
OBJECT_HASH = "a" * 64


class FakeKey:
    def asbytes(self) -> bytes:
        return b"stable-host-key"


class MemorySftp:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}

    def mkdir(self, _: str) -> None:
        return

    def stat(self, path: str) -> SimpleNamespace:
        if path not in self.files:
            raise FileNotFoundError(path)
        return SimpleNamespace(st_size=len(self.files[path]))

    def open(self, path: str, mode: str):
        if "w" not in mode:
            return io.BytesIO(self.files[path])
        target = self

        class Writer(io.BytesIO):
            def close(self) -> None:
                target.files[path] = self.getvalue()
                super().close()

        return Writer()

    def posix_rename(self, source: str, target: str) -> None:
        self.files[target] = self.files.pop(source)

    def rename(self, source: str, target: str) -> None:
        self.posix_rename(source, target)

    def remove(self, path: str) -> None:
        self.files.pop(path, None)


def test_repository_path_allowlist_covers_v3_without_allowing_traversal() -> None:
    assert _allowed_file(f"notes/{NOTE_ID}.json")
    assert _allowed_file(f"notes/{NOTE_ID}.json.gz")
    assert _allowed_file("notes/privacy.json")
    assert _allowed_file(f"objects/aa/{OBJECT_HASH}")
    assert not _allowed_file("notes/not-a-uuid.json.gz")
    with pytest.raises(ValueError):
        _safe_relative("../outside")
    assert _uses_compressed_notes(b'{"repositoryFormat":{"version":2,"noteEncoding":"gzip"}}')
    assert _uses_compressed_notes(b'{"repositoryFormat":{"version":3,"noteEncoding":"gzip"}}')


def test_v3_publication_compresses_notes_and_keeps_content_addressed_objects() -> None:
    index = json.dumps({
        "entries": [{"noteID": NOTE_ID, "version": 2, "contentHash": "new", "historyCount": 1}],
    }).encode()
    note = json.dumps({"schemaVersion": 3, "noteID": NOTE_ID, "contentObjects": {"new": "body"}}, indent=2).encode()
    prepared = dict(_prepare_repository_files([
        (f"notes/{NOTE_ID}.json", note),
        ("notes/index.json", index),
        (f"objects/aa/{OBJECT_HASH}", b"asset"),
    ], None))
    assert f"notes/{NOTE_ID}.json" not in prepared
    assert json.loads(gzip.decompress(prepared[f"notes/{NOTE_ID}.json.gz"]))["noteID"] == NOTE_ID
    assert json.loads(prepared["notes/index.json"])["repositoryFormat"] == {
        "version": 3,
        "noteEncoding": "gzip",
        "contentFormat": "markdown-gfm",
        "assetAddressing": "sha256",
    }
    assert prepared[f"objects/aa/{OBJECT_HASH}"] == b"asset"


def test_v3_publication_skips_an_unchanged_note() -> None:
    index = json.dumps({
        "entries": [{"noteID": NOTE_ID, "version": 2, "contentHash": "same", "historyCount": 1}],
    }).encode()
    prepared = dict(_prepare_repository_files([
        (f"notes/{NOTE_ID}.json", b"{}"),
        ("notes/index.json", index),
    ], index))
    assert f"notes/{NOTE_ID}.json.gz" not in prepared
    assert "notes/index.json" in prepared


def test_host_key_policy_rejects_a_changed_fingerprint() -> None:
    key = FakeKey()
    expected = _fingerprint(key)  # type: ignore[arg-type]
    accepted = _PinnedHostPolicy(expected)
    accepted.missing_host_key(None, "server", key)  # type: ignore[arg-type]
    assert accepted.presented == expected
    with pytest.raises(paramiko.SSHException):
        _PinnedHostPolicy("SHA256:different").missing_host_key(None, "server", key)  # type: ignore[arg-type]


def test_atomic_write_verifies_then_renames() -> None:
    sftp = MemorySftp()
    _atomic_write(sftp, "/repository/notes/index.json", b'{"schemaVersion":3}')  # type: ignore[arg-type]
    assert sftp.files["/repository/notes/index.json"] == b'{"schemaVersion":3}'
    assert not any(".tmp.notebook-next." in path for path in sftp.files)
