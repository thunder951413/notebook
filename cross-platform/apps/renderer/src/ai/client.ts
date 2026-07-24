import { createParser } from 'eventsource-parser'
import type { AIContextBundle } from '@notebook/sync-contract'

export interface AIContextPage { id: string; title: string; excerpt: string }

const aiBaseUrl = () => import.meta.env.VITE_NOTEBOOK_AI_URL ?? 'http://127.0.0.1:8787'

async function requestHeaders() {
  const token = await window.notebookDesktop?.secrets.get('sync-token')
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

export async function streamNotebookAnswer(
  prompt: string,
  context: AIContextBundle,
  onToken: (token: string) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${aiBaseUrl()}/v1/chat/stream`, {
    method: 'POST',
    headers: await requestHeaders(),
    credentials: 'include',
    signal,
    body: JSON.stringify({
      messages: [{ role: 'user', content: `${context.markdown}\n\n用户请求：${prompt}` }],
      citations: context.items.map((item) => ({
        page_id: item.pageId,
        title: item.title,
        excerpt: item.markdown.slice(0, 4_000),
        relationship: item.relationship,
        depth: item.depth,
      })),
      context_warnings: context.warnings,
    }),
  })
  if (!response.ok) throw new Error(`AI 服务返回 ${response.status}`)
  if (!response.body) throw new Error('AI 服务没有返回流')

  let serverError: string | undefined
  const parser = createParser({
    onEvent(event) {
      if (event.event === 'token') {
        const payload = JSON.parse(event.data) as { text?: string }
        if (payload.text) onToken(payload.text)
      } else if (event.event === 'error') {
        const payload = JSON.parse(event.data) as { message?: string }
        serverError = payload.message ?? 'AI 请求失败'
      }
    },
  })
  const decoder = new TextDecoder()
  for await (const chunk of response.body) parser.feed(decoder.decode(chunk, { stream: true }))
  parser.feed(decoder.decode())
  if (serverError) throw new Error(serverError)
}

export interface SemanticHit extends AIContextPage { score: number }

export async function indexPageForRetrieval(workspaceId: string, pageId: string, title: string, content: string) {
  if (!import.meta.env.VITE_NOTEBOOK_AI_URL) return
  const response = await fetch(`${aiBaseUrl()}/v1/retrieval/index`, { method: 'POST', headers: await requestHeaders(), credentials: 'include', body: JSON.stringify({ workspace_id: workspaceId, documents: [{ page_id: pageId, title, content }] }) })
  if (!response.ok) throw new Error(`语义索引失败：${response.status}`)
}

export async function semanticSearch(workspaceId: string, query: string, limit = 5): Promise<SemanticHit[]> {
  if (!import.meta.env.VITE_NOTEBOOK_AI_URL) return []
  const response = await fetch(`${aiBaseUrl()}/v1/retrieval/search`, { method: 'POST', headers: await requestHeaders(), credentials: 'include', body: JSON.stringify({ workspace_id: workspaceId, query, limit }) })
  if (!response.ok) return []
  const result = await response.json() as Array<{ page_id: string; title: string; excerpt: string; score: number }>
  return result.map((item) => ({ id: item.page_id, title: item.title, excerpt: item.excerpt, score: item.score }))
}
