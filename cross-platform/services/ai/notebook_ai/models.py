from typing import Literal

from pydantic import BaseModel, Field


class Citation(BaseModel):
    page_id: str
    title: str
    excerpt: str


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class ChatRequest(BaseModel):
    model: str = Field(default="openai/gpt-4.1-mini", min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._:/-]+$")
    messages: list[ChatMessage]
    citations: list[Citation] = Field(default_factory=list)
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=2048, ge=1, le=32768)
