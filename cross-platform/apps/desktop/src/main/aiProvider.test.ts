import { describe, expect, it, vi } from 'vitest'
import { completeAIChat } from './aiProvider'

describe('desktop AI provider', () => {
  it('rejects non-HTTPS endpoints before reading credentials', async () => {
    await expect(completeAIChat(
      { provider: 'custom', baseUrl: 'http://example.com/v1', model: 'model', messages: [{ role: 'user', content: 'hello' }] },
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
      { provider: 'custom', baseUrl: 'https://provider.example/v1', model: 'test-model', messages: [{ role: 'user', content: '整理笔记' }] },
      fetcher,
      async (key) => key === 'ai-provider-key:custom' ? 'private-key' : undefined,
    )
    expect(result).toEqual({ content: '完成', model: 'test-model', usage: { promptTokens: 12, completionTokens: 2 } })
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toBe('https://provider.example/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer private-key')
    expect(init.body).not.toContain('private-key')
  })

  it('fails when the credential has not been configured', async () => {
    await expect(completeAIChat(
      { provider: 'custom', baseUrl: 'https://provider.example/v1', model: 'model', messages: [{ role: 'user', content: 'hello' }] },
      vi.fn() as unknown as typeof fetch,
      async () => undefined,
    )).rejects.toThrow('API Key')
  })
})
