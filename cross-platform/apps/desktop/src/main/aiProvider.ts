import { getStoredSecret } from './platform'
import type { DesktopAIChatRequest, DesktopAIChatResponse } from '../aiContract'
import { createHash } from 'node:crypto'

const MAX_MESSAGES = 40
const MAX_CONTENT_CHARACTERS = 320_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

function networkFailure(error: unknown) {
  if (!(error instanceof TypeError) || !/fetch failed/i.test(error.message)) return undefined
  let value: unknown = error
  let code = ''
  for (let depth = 0; depth < 4 && value && typeof value === 'object'; depth += 1) {
    const candidate = value as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string') {
      code = candidate.code
      break
    }
    value = candidate.cause
  }
  const reason = ({
    ENOTFOUND: '无法解析服务域名',
    EAI_AGAIN: 'DNS 查询暂时失败',
    ECONNREFUSED: '服务拒绝连接',
    ECONNRESET: '连接被服务端或代理重置',
    ETIMEDOUT: '建立连接超时',
    UND_ERR_CONNECT_TIMEOUT: '建立连接超时',
    UND_ERR_SOCKET: '连接在传输过程中中断',
    DEPTH_ZERO_SELF_SIGNED_CERT: '服务使用了不受信任的自签名证书',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务的 TLS 证书',
    CERT_HAS_EXPIRED: '服务的 TLS 证书已过期',
  } as Record<string, string>)[code] ?? '无法建立网络连接'
  return `${reason}${code ? `（${code}）` : ''}。请检查服务地址、网络、代理和证书后重试。`
}

export function validatedAIBaseUrl(provider: DesktopAIChatRequest['provider'], value: string) {
  const base = new URL(value)
  if (base.protocol !== 'https:') throw new Error('AI 服务地址必须使用 HTTPS')
  if (base.username || base.password) throw new Error('AI 服务地址不能包含用户名或密码')
  if (base.search || base.hash) throw new Error('AI 服务地址不能包含查询参数或锚点')
  if (provider === 'openai' && (base.hostname !== 'api.openai.com' || (base.port && base.port !== '443'))) {
    throw new Error('OpenAI Key 只能发送到 api.openai.com；代理服务请选择“OpenAI 兼容服务”')
  }
  if (provider === 'deepseek' && (base.hostname !== 'api.deepseek.com' || (base.port && base.port !== '443'))) {
    throw new Error('DeepSeek Key 只能发送到 api.deepseek.com；代理服务请选择“OpenAI 兼容服务”')
  }
  return base
}

export function aiProviderCredentialKey(provider: DesktopAIChatRequest['provider'], baseUrl: string) {
  const base = validatedAIBaseUrl(provider, baseUrl)
  if (provider !== 'custom') return `ai-provider-key:${provider}`
  const normalized = base.toString().replace(/\/$/, '')
  return `ai-provider-key:custom:${createHash('sha256').update(normalized).digest('hex')}`
}

async function readLimitedJson(response: Response) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('AI 服务响应超过 4 MB 限制')
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('AI 服务响应超过 4 MB 限制')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try { return JSON.parse(new TextDecoder().decode(merged)) as unknown }
  catch { return undefined }
}

export async function completeAIChat(
  request: DesktopAIChatRequest,
  fetcher: typeof fetch = fetch,
  readApiKey: (key: string) => Promise<string | undefined> = getStoredSecret,
  externalSignal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<DesktopAIChatResponse> {
  if (!['openai', 'deepseek', 'custom'].includes(request.provider)) throw new Error('AI 服务商无效')
  if (!request.requestId || request.requestId.length > 100) throw new Error('AI 请求标识无效')
  const base = validatedAIBaseUrl(request.provider, request.baseUrl)
  if (!request.model.trim() || request.model.length > 200) throw new Error('AI 模型名称无效')
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > MAX_MESSAGES) throw new Error('AI 对话消息数量无效')
  if (request.messages.some((message) => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
    throw new Error('AI 对话消息格式无效')
  }
  const totalCharacters = request.messages.reduce((total, message) => total + message.content.length, 0)
  if (totalCharacters > MAX_CONTENT_CHARACTERS) throw new Error('AI 上下文超过 320,000 字符限制')
  const apiKey = await readApiKey(aiProviderCredentialKey(request.provider, request.baseUrl))
  if (!apiKey) throw new Error('尚未在 Notebook 设置中保存 AI API Key')
  const endpoint = new URL('chat/completions', base.toString().endsWith('/') ? base : `${base}/`)
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(new Error('AI 服务响应超时')), Math.max(1, timeoutMs))
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutController.signal]) : timeoutController.signal
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model.trim(),
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        stream: false,
      }),
      redirect: 'error',
      signal,
    })
    const payload = await readLimitedJson(response) as {
      error?: { message?: string }
      model?: string
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    } | undefined
    if (!response.ok) throw new Error(String(payload?.error?.message ?? `AI 服务返回 ${response.status}`).slice(0, 1_000))
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
  } catch (error) {
    if (externalSignal?.aborted) throw new Error('AI 请求已取消', { cause: error })
    if (timeoutController.signal.aborted) throw new Error('AI 服务响应超时', { cause: error })
    const friendlyNetworkError = networkFailure(error)
    if (friendlyNetworkError) throw new Error(friendlyNetworkError, { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
