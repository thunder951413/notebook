import math

from pydantic import BaseModel, Field
from sqlalchemy import JSON, String, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import Mapped, mapped_column

from .gateway import AIGateway
from .sync import Base


class EmbeddingRecord(Base):
    __tablename__ = "page_embeddings"
    workspace_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    page_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    title: Mapped[str] = mapped_column(String(500))
    excerpt: Mapped[str] = mapped_column(String(4000))
    vector: Mapped[list[float]] = mapped_column(JSON)


class IndexDocument(BaseModel):
    page_id: str
    title: str
    content: str = Field(max_length=500_000)


class IndexRequest(BaseModel):
    workspace_id: str
    model: str = Field(default="openai/text-embedding-3-small", min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._:/-]+$")
    documents: list[IndexDocument] = Field(min_length=1, max_length=100)


class SemanticSearchRequest(BaseModel):
    workspace_id: str
    query: str = Field(min_length=1, max_length=20_000)
    model: str = Field(default="openai/text-embedding-3-small", min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._:/-]+$")
    limit: int = Field(default=8, ge=1, le=50)


class SemanticHit(BaseModel):
    page_id: str
    title: str
    excerpt: str
    score: float


class RetrievalStore:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], gateway: AIGateway):
        self.sessions = sessions
        self.gateway = gateway

    async def index(self, request: IndexRequest) -> int:
        vectors = await self.gateway.embed([document.content for document in request.documents], request.model)
        async with self.sessions.begin() as session:
            for document, vector in zip(request.documents, vectors, strict=True):
                record = await session.get(EmbeddingRecord, {"workspace_id": request.workspace_id, "page_id": document.page_id})
                values = {"title": document.title, "excerpt": document.content[:4000], "vector": vector}
                if record:
                    record.title, record.excerpt, record.vector = values["title"], values["excerpt"], values["vector"]
                else:
                    session.add(EmbeddingRecord(workspace_id=request.workspace_id, page_id=document.page_id, **values))
        return len(request.documents)

    async def search(self, request: SemanticSearchRequest) -> list[SemanticHit]:
        query_vector = (await self.gateway.embed([request.query], request.model))[0]
        async with self.sessions() as session:
            records = list((await session.scalars(select(EmbeddingRecord).where(EmbeddingRecord.workspace_id == request.workspace_id))).all())
        def cosine(vector: list[float]) -> float:
            numerator = sum(left * right for left, right in zip(query_vector, vector))
            denominator = math.sqrt(sum(value * value for value in query_vector)) * math.sqrt(sum(value * value for value in vector))
            return numerator / denominator if denominator else 0
        ranked = sorted(((record, cosine(record.vector)) for record in records), key=lambda item: item[1], reverse=True)[:request.limit]
        return [SemanticHit(page_id=record.page_id, title=record.title, excerpt=record.excerpt, score=score) for record, score in ranked]
