from collections.abc import AsyncIterator

import pydantic
import pytest
from fastapi.testclient import TestClient
from jose import jwt

from notebook_ai.legacy_sftp import PullResponse as LegacyPullResponse
from notebook_ai.legacy_sftp import SshConnection
from notebook_ai.main import create_app
from notebook_ai.models import ChatRequest
from notebook_ai.settings import Settings


class FakeGateway:
    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        return [[1.0, 0.0] if "notes" in text.lower() else [0.0, 1.0] for text in texts]
    async def stream_chat(self, request: ChatRequest) -> AsyncIterator[str]:
        yield "有依据的"
        yield "回答"


class FailingGateway(FakeGateway):
    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        raise RuntimeError("provider secret must not leak")


def test_health_and_authenticated_stream() -> None:
    app = create_app(Settings(api_token="secret"), FakeGateway())
    client = TestClient(app)
    assert client.get("/health").json()["status"] == "ok"
    unauthorized = client.post("/v1/chat/stream", json={"messages": [{"role": "user", "content": "hi"}]})
    assert unauthorized.status_code == 401
    response = client.post(
        "/v1/chat/stream",
        headers={"Authorization": "Bearer secret"},
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    assert "有依据的" in response.text
    assert "event: done" in response.text


def test_local_sftp_bridge_is_disabled_by_default(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("notebook_ai.main.pull_repository", lambda _: LegacyPullResponse(files=[], indexHash="", fingerprint="SHA256:test"))
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'bridge-off.db'}")
    with TestClient(create_app(settings, FakeGateway()), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        response = client.post("/v1/local-sftp/pull", json={"settings": {"host": "server", "port": 22, "username": "user", "password": "password", "remotePath": "~/notebook_backup"}})
        assert response.status_code == 404


def test_local_sftp_bridge_only_accepts_loopback_requests(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("notebook_ai.main.pull_repository", lambda _: LegacyPullResponse(files=[], indexHash="", fingerprint="SHA256:test"))
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'bridge-on.db'}", enable_local_sftp_bridge=True, api_token="secret")
    payload = {"settings": {"host": "server", "port": 22, "username": "user", "password": "password", "remotePath": "~/notebook_backup"}}
    with TestClient(create_app(settings, FakeGateway()), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        assert client.post("/v1/local-sftp/pull", json=payload).status_code == 401
        response = client.post("/v1/local-sftp/pull", headers={"Authorization": "Bearer secret"}, json=payload)
        assert response.status_code == 200
        assert response.json()["fingerprint"] == "SHA256:test"
    with TestClient(create_app(settings, FakeGateway()), base_url="http://127.0.0.1", client=("198.51.100.20", 50000)) as client:
        assert client.post("/v1/local-sftp/pull", headers={"Authorization": "Bearer secret"}, json=payload).status_code == 404


def test_local_sftp_bridge_does_not_leak_backend_errors(monkeypatch, tmp_path) -> None:
    def fail(_):
        raise RuntimeError("password=supersecret /private/server/path")

    monkeypatch.setattr("notebook_ai.main.pull_repository", fail)
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'bridge-error.db'}", enable_local_sftp_bridge=True, api_token="secret")
    payload = {"settings": {"host": "server", "port": 22, "username": "user", "password": "password", "remotePath": "~/notebook_backup"}}
    with TestClient(create_app(settings, FakeGateway()), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        response = client.post("/v1/local-sftp/pull", headers={"Authorization": "Bearer secret"}, json=payload)
        assert response.status_code == 502
        assert "SSH/SFTP" in response.json()["detail"]
        assert "supersecret" not in response.text
        assert "/private/server/path" not in response.text


def test_local_sftp_bridge_accepts_private_key_auth(monkeypatch, tmp_path) -> None:
    """Private-key-only auth (no password) should be accepted by the model and bridge."""
    monkeypatch.setattr("notebook_ai.main.pull_repository", lambda _: LegacyPullResponse(files=[], indexHash="", fingerprint="SHA256:test"))
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'bridge-key.db'}", enable_local_sftp_bridge=True, api_token="secret")
    payload = {"settings": {"host": "server", "port": 22, "username": "user", "privateKeyPath": "/home/user/.ssh/id_ed25519", "remotePath": "~/notebook_backup"}}
    with TestClient(create_app(settings, FakeGateway()), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        response = client.post("/v1/local-sftp/pull", headers={"Authorization": "Bearer secret"}, json=payload)
        assert response.status_code == 200
        assert response.json()["fingerprint"] == "SHA256:test"


def test_ssh_connection_rejects_missing_password_and_private_key(tmp_path) -> None:
    """SshConnection must require at least one of password or privateKeyPath."""
    with pytest.raises(pydantic.ValidationError):
        SshConnection(host="server", port=22, username="user", remotePath="~/notebook_backup")
    # password-only should still work
    SshConnection(host="server", port=22, username="user", password="secret", remotePath="~/notebook_backup")
    # key-only should also work
    SshConnection(host="server", port=22, username="user", privateKeyPath="/home/user/.ssh/id_ed25519", remotePath="~/notebook_backup")


def test_ai_and_embedding_models_are_allowlisted(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'models.db'}")
    with TestClient(create_app(settings, FakeGateway())) as client:
        chat = client.post("/v1/chat/stream", json={"model": "openai/expensive-unknown", "messages": [{"role": "user", "content": "hi"}]})
        assert chat.status_code == 400
        indexed = client.post("/v1/retrieval/index", json={"workspace_id": "workspace-a", "model": "openai/unknown-embedding", "documents": [{"page_id": "page-a", "title": "A", "content": "body"}]})
        assert indexed.status_code == 400


def test_workspace_jwt_cannot_cross_workspace_boundaries(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'jwt.db'}", jwt_secret="jwt-secret")
    token = jwt.encode({"sub": "device-a", "workspaces": ["workspace-a"]}, "jwt-secret", algorithm="HS256")
    headers = {"Authorization": f"Bearer {token}"}
    with TestClient(create_app(settings, FakeGateway())) as client:
        allowed = client.get("/v1/sync/pull", headers=headers, params={"workspace_id": "workspace-a"})
        denied = client.get("/v1/sync/pull", headers=headers, params={"workspace_id": "workspace-b"})
        assert allowed.status_code == 200
        assert denied.status_code == 403


def test_provider_failures_are_safe_and_actionable(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'provider.db'}")
    with TestClient(create_app(settings, FailingGateway())) as client:
        indexed = client.post("/v1/retrieval/index", json={"workspace_id": "workspace-a", "documents": [{"page_id": "page-a", "title": "Notebook", "content": "text"}]})
        assert indexed.status_code == 503
        assert "Configure a provider API key" in indexed.json()["detail"]


def test_metadata_sync_is_idempotent_and_reports_optimistic_conflicts(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'sync.db'}", api_token="test-token")
    with TestClient(create_app(settings=settings, gateway=FakeGateway())) as client:
        headers = {"Authorization": "Bearer test-token"}
        change = {"operation_id": "op-1", "entity_type": "page", "entity_id": "page-1", "expected_version": 0, "operation": "upsert", "payload": {"title": "First"}}
        first = client.post("/v1/sync/push", headers=headers, json={"workspace_id": "workspace-1", "changes": [change]})
        assert first.status_code == 200
        assert first.json()["applied"][0]["version"] == 1
        retry = client.post("/v1/sync/push", headers=headers, json={"workspace_id": "workspace-1", "changes": [change]})
        assert retry.json()["applied"][0]["cursor"] == first.json()["applied"][0]["cursor"]
        conflict = client.post("/v1/sync/push", headers=headers, json={"workspace_id": "workspace-1", "changes": [{**change, "operation_id": "op-2", "payload": {"title": "Stale"}}]})
        assert conflict.json()["conflicts"][0]["current_version"] == 1
        pulled = client.get("/v1/sync/pull", headers=headers, params={"workspace_id": "workspace-1", "cursor": 0})
        assert pulled.json()["changes"][0]["payload"]["title"] == "First"


def test_metadata_sync_carries_documents_deletes_and_paginates(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'sync-complete.db'}", api_token="test-token")
    with TestClient(create_app(settings=settings, gateway=FakeGateway())) as client:
        headers = {"Authorization": "Bearer test-token"}
        changes = [
            {"operation_id": "doc-upsert", "entity_type": "document", "entity_id": "page-1", "expected_version": 0, "operation": "upsert", "payload": {"pageId": "page-1", "tiptapJson": {"type": "doc"}}},
            {"operation_id": "page-delete", "entity_type": "page", "entity_id": "page-1", "expected_version": 0, "operation": "delete", "payload": {}},
        ]
        pushed = client.post("/v1/sync/push", headers=headers, json={"workspace_id": "workspace-1", "changes": changes})
        assert pushed.status_code == 200
        first_page = client.get("/v1/sync/pull", headers=headers, params={"workspace_id": "workspace-1", "cursor": 0, "limit": 1}).json()
        assert first_page["has_more"] is True
        second_page = client.get("/v1/sync/pull", headers=headers, params={"workspace_id": "workspace-1", "cursor": first_page["cursor"], "limit": 1}).json()
        assert second_page["has_more"] is False
        assert {first_page["changes"][0]["entity_type"], second_page["changes"][0]["entity_type"]} == {"document", "page"}
        assert second_page["changes"][0]["operation"] in {"upsert", "delete"}


def test_asset_sync_round_trip_and_delete(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'assets.db'}", api_token="test-token")
    with TestClient(create_app(settings=settings, gateway=FakeGateway())) as client:
        headers = {"Authorization": "Bearer test-token", "Content-Type": "image/png"}
        url = "/v1/sync/assets/asset-1?workspace_id=workspace-1"
        assert client.put(url, headers=headers, content=b"png-bytes").status_code == 204
        downloaded = client.get(url, headers={"Authorization": "Bearer test-token"})
        assert downloaded.status_code == 200
        assert downloaded.content == b"png-bytes"
        assert downloaded.headers["content-type"] == "image/png"
        assert client.delete(url, headers={"Authorization": "Bearer test-token"}).status_code == 204
        assert client.get(url, headers={"Authorization": "Bearer test-token"}).status_code == 404


def test_browser_and_packaged_electron_origins_can_preflight_asset_sync(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'cors.db'}", api_token="test-token")
    with TestClient(create_app(settings=settings, gateway=FakeGateway())) as client:
        for origin in ("http://127.0.0.1:8057", "null"):
            response = client.options(
                "/v1/sync/assets/asset-1?workspace_id=workspace-1",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "PUT",
                    "Access-Control-Request-Headers": "authorization,content-type",
                },
            )
            assert response.status_code == 200
            assert response.headers["access-control-allow-origin"] == origin
            assert response.headers.get("access-control-allow-credentials") != "true"
            assert "PUT" in response.headers["access-control-allow-methods"]


def test_semantic_index_returns_ranked_evidence(tmp_path) -> None:
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'retrieval.db'}", api_token="test-token")
    with TestClient(create_app(settings=settings, gateway=FakeGateway())) as client:
        headers = {"Authorization": "Bearer test-token"}
        indexed = client.post("/v1/retrieval/index", headers=headers, json={"workspace_id": "workspace-1", "documents": [{"page_id": "notes", "title": "Notes", "content": "meeting notes"}, {"page_id": "todo", "title": "Todo", "content": "task list"}]})
        assert indexed.json()["indexed"] == 2
        results = client.post("/v1/retrieval/search", headers=headers, json={"workspace_id": "workspace-1", "query": "notes question"})
        assert results.json()[0]["page_id"] == "notes"
