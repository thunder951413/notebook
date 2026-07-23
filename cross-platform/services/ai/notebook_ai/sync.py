from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

from fastapi import Depends, Header, HTTPException
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from sqlalchemy import JSON, DateTime, Integer, LargeBinary, String, UniqueConstraint, delete, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .settings import Settings


class Base(DeclarativeBase):
    pass


class CurrentEntity(Base):
    __tablename__ = "sync_entities"
    workspace_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(40), primary_key=True)
    entity_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(10))
    payload: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SyncEvent(Base):
    __tablename__ = "sync_events"
    __table_args__ = (UniqueConstraint("workspace_id", "operation_id"),)
    cursor: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True)
    operation_id: Mapped[str] = mapped_column(String(128))
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(128))
    version: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(10))
    payload: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AssetBlob(Base):
    __tablename__ = "sync_asset_blobs"
    workspace_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    content: Mapped[bytes] = mapped_column(LargeBinary)
    content_type: Mapped[str] = mapped_column(String(255))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IncomingChange(BaseModel):
    operation_id: str = Field(min_length=1, max_length=128)
    entity_type: Literal["notebook", "section", "page", "document", "revision", "tag", "page_tag", "task_step", "asset", "page_link", "reading_position"]
    entity_id: str = Field(min_length=1, max_length=128)
    expected_version: int = Field(default=0, ge=0)
    operation: Literal["upsert", "delete"]
    payload: dict = Field(default_factory=dict)


class PushRequest(BaseModel):
    workspace_id: str
    changes: list[IncomingChange] = Field(max_length=500)


class AppliedChange(BaseModel):
    operation_id: str
    entity_type: str
    entity_id: str
    version: int
    cursor: int


class Conflict(BaseModel):
    operation_id: str
    entity_type: str
    entity_id: str
    expected_version: int
    current_version: int
    current_payload: dict


class PushResponse(BaseModel):
    applied: list[AppliedChange]
    conflicts: list[Conflict]


class PullChange(BaseModel):
    cursor: int
    entity_type: str
    entity_id: str
    version: int
    operation: str
    payload: dict
    updated_at: datetime


class PullResponse(BaseModel):
    cursor: int
    has_more: bool
    changes: list[PullChange]


class SyncStore:
    def __init__(self, database_url: str):
        self.engine: AsyncEngine = create_async_engine(database_url)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create(self) -> None:
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def close(self) -> None:
        await self.engine.dispose()

    async def push(self, request: PushRequest) -> PushResponse:
        applied: list[AppliedChange] = []
        conflicts: list[Conflict] = []
        async with self.sessions.begin() as session:
            for change in request.changes:
                prior_event = await session.scalar(select(SyncEvent).where(SyncEvent.workspace_id == request.workspace_id, SyncEvent.operation_id == change.operation_id))
                if prior_event:
                    applied.append(AppliedChange(operation_id=change.operation_id, entity_type=prior_event.entity_type, entity_id=prior_event.entity_id, version=prior_event.version, cursor=prior_event.cursor))
                    continue
                key = {"workspace_id": request.workspace_id, "entity_type": change.entity_type, "entity_id": change.entity_id}
                current = await session.get(CurrentEntity, key)
                current_version = current.version if current else 0
                if current_version != change.expected_version:
                    conflicts.append(Conflict(operation_id=change.operation_id, entity_type=change.entity_type, entity_id=change.entity_id, expected_version=change.expected_version, current_version=current_version, current_payload=current.payload if current else {}))
                    continue
                version = current_version + 1
                now = datetime.now(timezone.utc)
                if current:
                    current.version, current.operation, current.payload, current.updated_at = version, change.operation, change.payload, now
                else:
                    session.add(CurrentEntity(**key, version=version, operation=change.operation, payload=change.payload, updated_at=now))
                event = SyncEvent(workspace_id=request.workspace_id, operation_id=change.operation_id, entity_type=change.entity_type, entity_id=change.entity_id, version=version, operation=change.operation, payload=change.payload, updated_at=now)
                session.add(event)
                await session.flush()
                applied.append(AppliedChange(operation_id=change.operation_id, entity_type=change.entity_type, entity_id=change.entity_id, version=version, cursor=event.cursor))
        return PushResponse(applied=applied, conflicts=conflicts)

    async def pull(self, workspace_id: str, cursor: int, limit: int) -> PullResponse:
        async with self.sessions() as session:
            events = list((await session.scalars(select(SyncEvent).where(SyncEvent.workspace_id == workspace_id, SyncEvent.cursor > cursor).order_by(SyncEvent.cursor).limit(limit + 1))).all())
        has_more = len(events) > limit
        events = events[:limit]
        changes = [PullChange(cursor=item.cursor, entity_type=item.entity_type, entity_id=item.entity_id, version=item.version, operation=item.operation, payload=item.payload, updated_at=item.updated_at) for item in events]
        return PullResponse(cursor=changes[-1].cursor if changes else cursor, has_more=has_more, changes=changes)

    async def put_asset(self, workspace_id: str, asset_id: str, content: bytes, content_type: str) -> None:
        async with self.sessions.begin() as session:
            key = {"workspace_id": workspace_id, "asset_id": asset_id}
            current = await session.get(AssetBlob, key)
            if current:
                current.content, current.content_type, current.updated_at = content, content_type, datetime.now(timezone.utc)
            else:
                session.add(AssetBlob(**key, content=content, content_type=content_type, updated_at=datetime.now(timezone.utc)))

    async def get_asset(self, workspace_id: str, asset_id: str) -> tuple[bytes, str] | None:
        async with self.sessions() as session:
            value = await session.get(AssetBlob, {"workspace_id": workspace_id, "asset_id": asset_id})
            return (value.content, value.content_type) if value else None

    async def delete_asset(self, workspace_id: str, asset_id: str) -> None:
        async with self.sessions.begin() as session:
            await session.execute(delete(AssetBlob).where(AssetBlob.workspace_id == workspace_id, AssetBlob.asset_id == asset_id))


def workspace_authorizer(settings: Settings):
    async def authorize(workspace_id: str, authorization: str | None = Header(default=None)) -> None:
        token = authorization.removeprefix("Bearer ") if authorization else ""
        if settings.api_token and token == settings.api_token:
            return
        if not settings.jwt_secret:
            if settings.api_token:
                raise HTTPException(status_code=401, detail="Invalid API token")
            return
        try:
            claims = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], options={"require_sub": True})
        except JWTError as error:
            raise HTTPException(status_code=401, detail="Invalid access token") from error
        if workspace_id not in claims.get("workspaces", []):
            raise HTTPException(status_code=403, detail="Workspace access denied")
    return authorize
