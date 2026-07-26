import { createParser } from 'eventsource-parser'
import type { AIContextBundle } from '@notebook/sync-contract'
import { readAIProviderSettings } from './providerSettings'
import type { NotebookAgentProposalInput } from '../automation/automationBridge'

export interface AIContextPage { id: string; title: string; excerpt: string }

export function validatedAIServiceUrl(value = import.meta.env.VITE_NOTEBOOK_AI_URL ?? 'http://127.0.0.1:8787') {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('AI 服务必须使用 HTTPS；只有本机回环地址允许 HTTP')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('AI 服务地址不能包含凭据、查询参数或锚点')
  return url.toString().replace(/\/$/, '')
}

const aiBaseUrl = () => validatedAIServiceUrl()
const MAX_STREAM_CHARACTERS = 2_000_000
const LOCAL_AI_TIMEOUT_MS = 120_000

function hasConfiguredLocalAIService() {
  return Boolean(import.meta.env.VITE_NOTEBOOK_AI_URL?.trim())
}

async function requestHeaders() {
  const token = await window.notebookDesktop?.secrets.get('sync-token')
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function completeWithDesktopAI(
  request: Omit<Parameters<NonNullable<typeof window.notebookDesktop>['ai']['complete']>[0], 'requestId'>,
  signal?: AbortSignal,
) {
  const ai = window.notebookDesktop?.ai
  if (!ai) throw new Error('Electron AI 桥不可用')
  const requestId = crypto.randomUUID()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const cancel = () => { void ai.cancel(requestId) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await ai.complete({ ...request, requestId })
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

export async function streamNotebookAnswer(
  prompt: string,
  context: AIContextBundle,
  onToken: (token: string) => void,
  signal?: AbortSignal,
) {
  const provider = readAIProviderSettings()
  if (provider.enabled) {
    if (!window.notebookDesktop?.ai) throw new Error('内置 AI 仅能在 Electron 桌面版中使用')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const result = await completeWithDesktopAI({
      provider: provider.provider,
      baseUrl: provider.baseUrl,
      model: provider.model,
      messages: [
        {
          role: 'system',
          content: [
            '你是 Notebook 的内置 AI 助手。',
            '上下文由用户通过 @ 指定的页面，以及 Notebook 在本机检索出的少量相关片段组成；只能依据下方提供的上下文回答，不要假装读取其他页面。',
            '回答中的关键事实尽量用【笔记标题 › 标题路径】标明来源；没有足够证据时要明确说未找到。',
            '正文的唯一规范格式是 Markdown/GFM。保留标题、链接、代码、表格、任务列表、引用和 notebook 资源引用。',
            '你不能直接修改、移动或删除笔记。用户可将你的 Markdown 回答暂存为修改提案，再逐页审阅并批准。',
            '如果依据不足或上下文被截断，要明确说明。',
          ].join('\n'),
        },
        { role: 'user', content: `${context.markdown}\n\n上下文提示：${context.warnings.join('；') || '无'}\n\n用户请求：${prompt}` },
      ],
    }, signal)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onToken(result.content)
    return
  }
  if (!hasConfiguredLocalAIService()) {
    throw new Error('内置 AI 对话尚未启用。请在“设置 → AI 与自动化”中打开开关并保存配置。')
  }
  const timeoutController = new AbortController()
  const timer = window.setTimeout(() => timeoutController.abort(), LOCAL_AI_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
  try {
    const response = await fetch(`${aiBaseUrl()}/v1/chat/stream`, {
      method: 'POST',
      headers: await requestHeaders(),
      credentials: 'omit',
      signal: requestSignal,
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
    let receivedCharacters = 0
    const parser = createParser({
      onEvent(event) {
        let payload: { text?: string; message?: string }
        try { payload = JSON.parse(event.data) as { text?: string; message?: string } }
        catch { throw new Error('AI 服务返回了无效的流事件') }
        if (event.event === 'token' && payload.text) {
          receivedCharacters += payload.text.length
          if (receivedCharacters > MAX_STREAM_CHARACTERS) throw new Error('AI 输出超过 2,000,000 字符限制')
          onToken(payload.text)
        } else if (event.event === 'error') {
          serverError = String(payload.message ?? 'AI 请求失败').slice(0, 1_000)
        }
      },
    })
    const decoder = new TextDecoder()
    for await (const chunk of response.body) parser.feed(decoder.decode(chunk, { stream: true }))
    parser.feed(decoder.decode())
    if (serverError) throw new Error(serverError)
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (timeoutController.signal.aborted) throw new Error('本地 AI 服务响应超时', { cause: error })
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

export interface NotebookAgentTopology {
  notebooks: Array<{ id: string; name: string; sections: Array<{ id: string; name: string }> }>
  pages: Array<{ id: string; title: string; sectionId: string; parentPageId?: string }>
}

export async function requestNotebookProposal(
  prompt: string,
  context: AIContextBundle,
  topology: NotebookAgentTopology,
  allowedPageIds: string[],
  signal?: AbortSignal,
): Promise<NotebookAgentProposalInput> {
  const provider = readAIProviderSettings()
  if (!provider.enabled || !window.notebookDesktop?.ai) {
    throw new Error('生成结构化修改提案需要先在“设置 → AI 与自动化”中启用内置 AI 模型')
  }
  const result = await completeWithDesktopAI({
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    model: provider.model,
    messages: [
      {
        role: 'system',
        content: [
          '你是 Notebook 的结构化笔记整理 Agent。只输出一个 JSON 对象，不要 Markdown 代码围栏或解释。',
          'JSON 格式：{"title":"提案标题","explanation":"说明","operations":[...]}。',
          '已有页面仅可使用 update-page 或 delete-page，且 pageId 必须在 allowedPageIds 中。',
          'update-page 可包含 title、markdown、sectionId、parentPageId、sortOrder；至少提供一个变化字段。',
          'create-page 必须包含 title、markdown、sectionId，可包含 parentPageId、sortOrder。',
          'delete-page 只包含 type 与 pageId；它仅代表移到回收站，不能永久删除。',
          '只能使用 topology 中真实存在的 sectionId 和 parentPageId，不能形成父子循环。',
          'Markdown/GFM 是唯一正文格式。保留 notebook-asset: 资源引用、双链与嵌入语法，不要生成 HTML 脚本、data: URL 或追踪图片。',
          '不要修改上下文未授权的现有页面。信息不足时宁可减少操作。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `allowedPageIds=${JSON.stringify(allowedPageIds)}`,
          `topology=${JSON.stringify(topology)}`,
          context.markdown,
          `用户要求：${prompt}`,
        ].join('\n\n'),
      },
    ],
  }, signal)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const proposal = parseNotebookProposal(result.content)
  const allowed = new Set(allowedPageIds)
  for (const operation of proposal.operations) {
    if (operation.type !== 'create-page' && !allowed.has(operation.pageId)) {
      throw new Error(`AI 尝试修改未通过 @ 授权的页面：${operation.pageId}`)
    }
  }
  return proposal
}

export function parseNotebookProposal(content: string): NotebookAgentProposalInput {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 没有返回可解析的修改提案')
  let value: unknown
  try {
    value = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    throw new Error('AI 返回的修改提案不是有效 JSON，请重试或缩小要求')
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { operations?: unknown }).operations)) {
    throw new Error('AI 返回的修改提案缺少 operations')
  }
  return value as NotebookAgentProposalInput
}

export interface SemanticHit extends AIContextPage { score: number }

export async function indexPageForRetrieval(workspaceId: string, pageId: string, title: string, content: string) {
  if (!import.meta.env.VITE_NOTEBOOK_AI_URL) return
  const response = await fetch(`${aiBaseUrl()}/v1/retrieval/index`, { method: 'POST', headers: await requestHeaders(), credentials: 'omit', body: JSON.stringify({ workspace_id: workspaceId, documents: [{ page_id: pageId, title, content }] }) })
  if (!response.ok) throw new Error(`语义索引失败：${response.status}`)
}

export async function semanticSearch(workspaceId: string, query: string, limit = 5): Promise<SemanticHit[]> {
  if (!import.meta.env.VITE_NOTEBOOK_AI_URL) return []
  const response = await fetch(`${aiBaseUrl()}/v1/retrieval/search`, { method: 'POST', headers: await requestHeaders(), credentials: 'omit', body: JSON.stringify({ workspace_id: workspaceId, query, limit }) })
  if (!response.ok) return []
  const result = await response.json() as Array<{ page_id: string; title: string; excerpt: string; score: number }>
  return result.map((item) => ({ id: item.page_id, title: item.title, excerpt: item.excerpt, score: item.score }))
}
