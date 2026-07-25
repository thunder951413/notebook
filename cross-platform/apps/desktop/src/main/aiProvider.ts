import { getStoredSecret } from './platform'
import type { DesktopAIChatRequest, DesktopAIChatResponse } from '../aiContract'

const MAX_MESSAGES = 40
const MAX_CONTENT_CHARACTERS = 320_000

export async function completeAIChat(
  request: DesktopAIChatRequest,
  fetcher: typeof fetch = fetch,
  readApiKey: (key: string) => Promise<string | undefined> = getStoredSecret,
): Promise<DesktopAIChatResponse> {
  const base = new URL(request.baseUrl)
  if (base.protocol !== 'https:') throw new Error('AI 服务地址必须使用 HTTPS')
  if (!['openai', 'deepseek', 'custom'].includes(request.provider)) throw new Error('AI 服务商无效')
  if (!request.model.trim() || request.model.length > 200) throw new Error('AI 模型名称无效')
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > MAX_MESSAGES) throw new Error('AI 对话消息数量无效')
  if (request.messages.some((message) => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
    throw new Error('AI 对话消息格式无效')
  }
  const totalCharacters = request.messages.reduce((total, message) => total + message.content.length, 0)
  if (totalCharacters > MAX_CONTENT_CHARACTERS) throw new Error('AI 上下文超过 320,000 字符限制')
  const apiKey = await readApiKey(`ai-provider-key:${request.provider}`)
  if (!apiKey) throw new Error('尚未在 Notebook 设置中保存 AI API Key')
  const endpoint = new URL('chat/completions', base.toString().endsWith('/') ? base : `${base}/`)
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model.trim(),
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      stream: false,
    }),
  })
  const payload = await response.json().catch(() => undefined) as {
    error?: { message?: string }
    model?: string
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  } | undefined
  if (!response.ok) throw new Error(payload?.error?.message ?? `AI 服务返回 ${response.status}`)
  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 服务没有返回正文')
  return {
    content,
    model: payload?.model,
    usage: {
      promptTokens: payload?.usage?.prompt_tokens,
      completionTokens: payload?.usage?.completion_tokens,
    },
  }
}
