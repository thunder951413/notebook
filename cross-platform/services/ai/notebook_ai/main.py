import asyncio
import base64
import hmac
import io
import ipaddress
import json
import logging
import zipfile
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .gateway import AIGateway, LiteLLMGateway
from .models import ChatRequest
from .settings import Settings
from .sync import PullResponse, PushRequest, PushResponse, SyncStore, workspace_authorizer
from .retrieval import IndexRequest, RetrievalStore, SemanticHit, SemanticSearchRequest
from .legacy_sftp import PullRequest as LegacyPullRequest, PullResponse as LegacyPullResponse, PushRequest as LegacyPushRequest, PushResponse as LegacyPushResponse, RepositoryFile as LegacyRepositoryFile, SshConnection, pull_repository, push_repository, repository_index_hash
from .legacy_webdav import WebdavObjectRequest, WebdavObjectResponse, WebdavPullRequest, WebdavPullResult, WebdavPushRequest, WebdavPushResult, WebdavTestRequest, WebdavTestResult, get_object, pull_journals, push_repository as push_webdav_repository, test_connection

AI_PROVIDER_MESSAGE = "AI provider unavailable. Configure a provider API key on the Notebook AI service."
SFTP_BRIDGE_MESSAGE = "SSH/SFTP 操作失败。请检查服务器地址、凭证、主机指纹和远端目录；详细原因已写入服务日志。"
WEBDAV_BRIDGE_MESSAGE = "WebDAV 同步操作失败。请检查服务器地址、用户名、应用密码和远端目录；详细原因已写入服务日志。"
MAX_ASSET_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
logger = logging.getLogger(__name__)


def _is_loopback_host(host: str) -> bool:
    normalized = host.strip().strip("[]").lower()
    if normalized in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _safe_read_archive(payload: bytes) -> dict[str, bytes]:
    if len(payload) > MAX_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="Archive exceeds size limit")
    entries: dict[str, bytes] = {}
    total_uncompressed = 0
    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if not name or name.startswith("/") or ".." in name.split("/") or "\\" in name:
                raise ValueError("Unsafe archive entry path")
            total_uncompressed += info.file_size
            if total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                raise HTTPException(status_code=413, detail="Uncompressed archive exceeds size limit")
            data = archive.read(info)
            if len(data) > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                raise HTTPException(status_code=413, detail="Archive entry exceeds size limit")
            entries[name] = data
    return entries


def create_app(settings: Settings | None = None, gateway: AIGateway | None = None) -> FastAPI:
    config = settings or Settings()
    if not _is_loopback_host(config.host) and not config.api_token and not config.jwt_secret:
        raise RuntimeError("NOTEBOOK_AI_API_TOKEN or NOTEBOOK_AI_JWT_SECRET is required when binding outside loopback")
    ai = gateway or LiteLLMGateway()
    store = SyncStore(config.database_url)
    retrieval = RetrievalStore(store.sessions, ai)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await store.create()
        yield
        await store.close()

    app = FastAPI(title="Notebook Application API", version="0.2.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.origins,
        # All protected endpoints use explicit bearer tokens. Cookies are not
        # used, so credentialed CORS (especially with the Electron `null`
        # origin) only expands the attack surface.
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Notebook-Ssh-Settings"],
    )

    async def authorize(authorization: str | None = Header(default=None)) -> None:
        if config.api_token:
            expected = f"Bearer {config.api_token}".encode("utf-8")
            supplied = (authorization or "").encode("utf-8")
            if not hmac.compare_digest(supplied, expected):
                raise HTTPException(status_code=401, detail="Invalid API token")

    def authorize_local_bridge(request: Request) -> None:
        host = (request.url.hostname or "").lower()
        client = request.client.host if request.client else ""
        try:
            client_is_loopback = ipaddress.ip_address(client).is_loopback
        except ValueError:
            client_is_loopback = client == "localhost"
        if not config.enable_local_sftp_bridge or host not in LOOPBACK_HOSTS or not client_is_loopback:
            raise HTTPException(status_code=404, detail="Local SFTP bridge is disabled")
        if not config.api_token:
            raise HTTPException(status_code=403, detail="NOTEBOOK_AI_API_TOKEN is required when local bridge is enabled")

    def bridge_failure(error: Exception, message: str = SFTP_BRIDGE_MESSAGE) -> HTTPException:
        logger.exception("Local sync bridge request failed")
        return HTTPException(status_code=502, detail=message)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "notebook-ai"}

    @app.post("/v1/local-sftp/pull", response_model=LegacyPullResponse, dependencies=[Depends(authorize)])
    async def legacy_sftp_pull(payload: LegacyPullRequest, request: Request) -> LegacyPullResponse:
        authorize_local_bridge(request)
        try:
            return await asyncio.to_thread(pull_repository, payload)
        except Exception as error:
            raise bridge_failure(error) from error

    @app.post("/v1/local-sftp/pull-archive", dependencies=[Depends(authorize)])
    async def legacy_sftp_pull_archive(payload: LegacyPullRequest, request: Request) -> Response:
        """Binary archive transport for large browser repositories.

        The SSH repository format itself is unchanged.  Only the loopback hop
        avoids expanding every attachment into a very large Base64 JSON body.
        """
        authorize_local_bridge(request)
        try:
            result = await asyncio.to_thread(pull_repository, payload)
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                archive.writestr("sync-result.json", json.dumps({"indexHash": result.indexHash, "fingerprint": result.fingerprint}, separators=(",", ":")))
                for item in result.files:
                    archive.writestr(f"repository/{item.name}", base64.b64decode(item.dataBase64, validate=True))
            return Response(content=output.getvalue(), media_type="application/zip")
        except Exception as error:
            raise bridge_failure(error) from error

    @app.post("/v1/local-sftp/push", response_model=LegacyPushResponse, dependencies=[Depends(authorize)])
    async def legacy_sftp_push(payload: LegacyPushRequest, request: Request) -> LegacyPushResponse:
        authorize_local_bridge(request)
        try:
            return await asyncio.to_thread(push_repository, payload)
        except Exception as error:
            raise bridge_failure(error) from error

    @app.post("/v1/local-sftp/push-archive", response_model=LegacyPushResponse, dependencies=[Depends(authorize)])
    async def legacy_sftp_push_archive(request: Request) -> LegacyPushResponse:
        authorize_local_bridge(request)
        try:
            if int(request.headers.get("content-length", "0")) > MAX_ARCHIVE_BYTES:
                raise HTTPException(status_code=413, detail="Archive exceeds size limit")
            archive_entries = _safe_read_archive(await request.body())
            if "sync-request.json" not in archive_entries:
                raise ValueError("Missing sync-request.json")
            request_data = json.loads(archive_entries["sync-request.json"])
            files = [
                {"name": name.removeprefix("repository/"), "dataBase64": base64.b64encode(content).decode()}
                for name, content in archive_entries.items()
                if name.startswith("repository/") and not name.endswith("/")
            ]
            parsed = LegacyPushRequest.model_validate({**request_data, "files": files})
            return await asyncio.to_thread(push_repository, parsed)
        except HTTPException:
            raise
        except Exception as error:
            raise bridge_failure(error) from error

    @app.post("/v1/local-sftp/publish-prepared-archive", response_model=LegacyPushResponse, dependencies=[Depends(authorize)])
    async def legacy_sftp_publish_prepared_archive(request: Request, x_notebook_ssh_settings: str = Header(alias="X-Notebook-Ssh-Settings")) -> LegacyPushResponse:
        authorize_local_bridge(request)
        try:
            if int(request.headers.get("content-length", "0")) > MAX_ARCHIVE_BYTES:
                raise HTTPException(status_code=413, detail="Archive exceeds size limit")
            settings = SshConnection.model_validate_json(base64.b64decode(x_notebook_ssh_settings, validate=True))
            archive_entries = _safe_read_archive(await request.body())
            files = [LegacyRepositoryFile(name=name, dataBase64=base64.b64encode(content).decode()) for name, content in archive_entries.items() if name and not name.endswith("/")]
            expected_hash = await asyncio.to_thread(repository_index_hash, settings)
            prepared = LegacyPushRequest(settings=settings, files=files, expectedIndexHash=expected_hash)
            return await asyncio.to_thread(push_repository, prepared)
        except HTTPException:
            raise
        except Exception as error:
            raise bridge_failure(error) from error

    @app.post("/v1/local-webdav/test", response_model=WebdavTestResult, dependencies=[Depends(authorize)])
    async def legacy_webdav_test(payload: WebdavTestRequest, request: Request) -> WebdavTestResult:
        authorize_local_bridge(request)
        return await asyncio.to_thread(test_connection, payload.settings)

    @app.post("/v1/local-webdav/pull", response_model=WebdavPullResult, dependencies=[Depends(authorize)])
    async def legacy_webdav_pull(payload: WebdavPullRequest, request: Request) -> WebdavPullResult:
        authorize_local_bridge(request)
        try:
            return await asyncio.to_thread(pull_journals, payload)
        except Exception as error:
            raise bridge_failure(error, WEBDAV_BRIDGE_MESSAGE) from error

    @app.post("/v1/local-webdav/object", response_model=WebdavObjectResponse, dependencies=[Depends(authorize)])
    async def legacy_webdav_object(payload: WebdavObjectRequest, request: Request) -> WebdavObjectResponse:
        authorize_local_bridge(request)
        try:
            return await asyncio.to_thread(get_object, payload)
        except Exception as error:
            raise bridge_failure(error, WEBDAV_BRIDGE_MESSAGE) from error

    @app.post("/v1/local-webdav/push", response_model=WebdavPushResult, dependencies=[Depends(authorize)])
    async def legacy_webdav_push(payload: WebdavPushRequest, request: Request) -> WebdavPushResult:
        authorize_local_bridge(request)
        try:
            return await asyncio.to_thread(push_webdav_repository, payload)
        except Exception as error:
            raise bridge_failure(error, WEBDAV_BRIDGE_MESSAGE) from error

    @app.post("/v1/chat/stream", dependencies=[Depends(authorize)])
    async def chat(request: ChatRequest) -> StreamingResponse:
        if request.model not in config.chat_models:
            raise HTTPException(status_code=400, detail="Requested AI model is not allowed")

        async def events() -> AsyncIterator[str]:
            try:
                async for text in ai.stream_chat(request):
                    yield f"event: token\ndata: {json.dumps({'text': text}, ensure_ascii=False)}\n\n"
                yield "event: done\ndata: {}\n\n"
            except Exception as error:
                yield f"event: error\ndata: {json.dumps({'message': AI_PROVIDER_MESSAGE}, ensure_ascii=False)}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    authorize_workspace = workspace_authorizer(config)

    @app.post("/v1/sync/push", response_model=PushResponse)
    async def sync_push(request: PushRequest, authorization: str | None = Header(default=None)) -> PushResponse:
        await authorize_workspace(request.workspace_id, authorization)
        return await store.push(request)

    @app.get("/v1/sync/pull", response_model=PullResponse)
    async def sync_pull(workspace_id: str, cursor: int = 0, limit: int = 200, authorization: str | None = Header(default=None)) -> PullResponse:
        await authorize_workspace(workspace_id, authorization)
        return await store.pull(workspace_id, cursor, min(max(limit, 1), 500))

    @app.put("/v1/sync/assets/{asset_id}", status_code=204)
    async def sync_asset_put(asset_id: str, workspace_id: str, request: Request, authorization: str | None = Header(default=None)) -> Response:
        await authorize_workspace(workspace_id, authorization)
        if int(request.headers.get("content-length", "0")) > MAX_ASSET_BYTES:
            raise HTTPException(status_code=413, detail="Asset exceeds 100 MB")
        content = await request.body()
        if len(content) > MAX_ASSET_BYTES:
            raise HTTPException(status_code=413, detail="Asset exceeds 100 MB")
        await store.put_asset(workspace_id, asset_id, content, request.headers.get("content-type", "application/octet-stream"))
        return Response(status_code=204)

    @app.get("/v1/sync/assets/{asset_id}")
    async def sync_asset_get(asset_id: str, workspace_id: str, authorization: str | None = Header(default=None)) -> Response:
        await authorize_workspace(workspace_id, authorization)
        value = await store.get_asset(workspace_id, asset_id)
        if not value:
            raise HTTPException(status_code=404, detail="Asset not found")
        content, content_type = value
        return Response(content=content, media_type=content_type)

    @app.delete("/v1/sync/assets/{asset_id}", status_code=204)
    async def sync_asset_delete(asset_id: str, workspace_id: str, authorization: str | None = Header(default=None)) -> Response:
        await authorize_workspace(workspace_id, authorization)
        await store.delete_asset(workspace_id, asset_id)
        return Response(status_code=204)

    @app.post("/v1/retrieval/index")
    async def retrieval_index(request: IndexRequest, authorization: str | None = Header(default=None)) -> dict[str, int]:
        await authorize_workspace(request.workspace_id, authorization)
        if request.model not in config.embedding_models:
            raise HTTPException(status_code=400, detail="Requested embedding model is not allowed")
        try:
            return {"indexed": await retrieval.index(request)}
        except Exception as error:
            raise HTTPException(status_code=503, detail=AI_PROVIDER_MESSAGE) from error

    @app.post("/v1/retrieval/search", response_model=list[SemanticHit])
    async def retrieval_search(request: SemanticSearchRequest, authorization: str | None = Header(default=None)) -> list[SemanticHit]:
        await authorize_workspace(request.workspace_id, authorization)
        if request.model not in config.embedding_models:
            raise HTTPException(status_code=400, detail="Requested embedding model is not allowed")
        try:
            return await retrieval.search(request)
        except Exception as error:
            raise HTTPException(status_code=503, detail=AI_PROVIDER_MESSAGE) from error

    return app


app = create_app()
