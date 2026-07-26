import { describe, expect, it, vi } from 'vitest'
import { aiProviderCredentialKey, completeAIChat, validatedAIBaseUrl } from './aiProvider'

const request = {
  requestId: 'request-1',
  provider: 'custom' as const,
  baseUrl: 'https://provider.example/v1',
  model: 'model',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

describe('desktop AI provider', () => {
  it('rejects non-HTTPS endpoints before reading credentials', async () => {
    await expect(completeAIChat(
      { ...request, baseUrl: 'http://example.com/v1' },
      vi.fn() as unknown as typeof fetch,
      vi.fn().mockResolvedValue('secret'),
    )).rejects.toThrow('HTTPS')
  })

  it('keeps the API key in the main process and calls an OpenAI-compatible endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content: '完成' } }],
      usage: { prompt_tokens: 12, completion_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    const result = await completeAIChat(
      { ...request, model: 'test-model', messages: [{ role: 'user', content: '整理笔记' }] },
      fetcher,
      async (key) => key === aiProviderCredentialKey('custom', request.baseUrl) ? 'private-key' : undefined,
    )
    expect(result).toEqual({ content: '完成', model: 'test-model', usage: { promptTokens: 12, completionTokens: 2 } })
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toBe('https://provider.example/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer private-key')
    expect(init.body).not.toContain('private-key')
    expect(init.redirect).toBe('error')
  })

  it('fails when the credential has not been configured', async () => {
    await expect(completeAIChat(
      request,
      vi.fn() as unknown as typeof fetch,
      async () => undefined,
    )).rejects.toThrow('API Key')
  })

  it('binds fixed-provider credentials to the official host and custom credentials to the exact URL', () => {
    expect(() => validatedAIBaseUrl('openai', 'https://attacker.example/v1')).toThrow('api.openai.com')
    expect(() => validatedAIBaseUrl('deepseek', 'https://attacker.example')).toThrow('api.deepseek.com')
    expect(() => validatedAIBaseUrl('custom', 'https://user:pass@provider.example/v1')).toThrow('用户名或密码')
    expect(() => validatedAIBaseUrl('custom', 'https://provider.example/v1?token=leak')).toThrow('查询参数')
    expect(aiProviderCredentialKey('custom', 'https://a.example/v1')).not.toBe(aiProviderCredentialKey('custom', 'https://b.example/v1'))
    expect(aiProviderCredentialKey('openai', 'https://api.openai.com/v1')).toBe('ai-provider-key:openai')
  })

  it('limits response size and validates malformed message content before sending', async () => {
    const oversized = new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 })
    await expect(completeAIChat(request, vi.fn(async () => oversized) as unknown as typeof fetch, async () => 'key')).rejects.toThrow('4 MB')
    await expect(completeAIChat(
      { ...request, messages: [{ role: 'user', content: 42 as unknown as string }] },
      vi.fn() as unknown as typeof fetch,
      async () => 'key',
    )).rejects.toThrow('消息格式')
  })

  it('cancels an in-flight request and enforces a timeout', async () => {
    const hanging = vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const controller = new AbortController()
    const cancelled = completeAIChat(request, hanging, async () => 'key', controller.signal, 1_000)
    controller.abort()
    await expect(cancelled).rejects.toThrow('已取消')
    await expect(completeAIChat({ ...request, requestId: 'timeout' }, hanging, async () => 'key', undefined, 5)).rejects.toThrow('超时')
  })

  it('turns opaque fetch failures into actionable network diagnostics', async () => {
    const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
    const fetcher = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause })
    }) as unknown as typeof fetch
    await expect(completeAIChat(request, fetcher, async () => 'key')).rejects.toThrow('连接被服务端或代理重置（ECONNRESET）')
  })
})
