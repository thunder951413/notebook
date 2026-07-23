from collections.abc import AsyncIterator
from typing import Protocol

from litellm import acompletion, aembedding

from .models import ChatRequest


class AIGateway(Protocol):
    async def stream_chat(self, request: ChatRequest) -> AsyncIterator[str]: ...
    async def embed(self, texts: list[str], model: str) -> list[list[float]]: ...


def _messages(request: ChatRequest) -> list[dict[str, str]]:
    messages = [message.model_dump() for message in request.messages]
    if request.citations:
        context = "\n\n".join(
            f"[page:{item.page_id}] {item.title}\n{item.excerpt}" for item in request.citations
        )
        messages.insert(0, {
            "role": "system",
            "content": (
                "Use the supplied Notebook context as evidence. Cite sources with [page:<id>]. "
                "Do not claim unsupported facts.\n\n" + context
            ),
        })
    return messages


class LiteLLMGateway:
    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        response = await aembedding(model=model, input=texts)
        return [list(item["embedding"]) for item in response.data]

    async def stream_chat(self, request: ChatRequest) -> AsyncIterator[str]:
        response = await acompletion(
            model=request.model,
            messages=_messages(request),
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            stream=True,
        )
        async for chunk in response:
            text = chunk.choices[0].delta.content
            if text:
                yield text
