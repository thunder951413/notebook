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
    model: str = "openai/gpt-4.1-mini"
    messages: list[ChatMessage]
    citations: list[Citation] = Field(default_factory=list)
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=2048, ge=1, le=32768)
