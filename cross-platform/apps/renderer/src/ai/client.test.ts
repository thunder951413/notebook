import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { parseNotebookProposal, requestNotebookProposal, streamNotebookAnswer, validatedAIServiceUrl } from './client'
import { saveAIProviderSettings } from './providerSettings'

const originalDesktop = window.notebookDesktop

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  Object.defineProperty(window, 'notebookDesktop', { configurable: true, value: originalDesktop })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('sends only the prepared @ context through the desktop provider bridge', async () => {
  saveAIProviderSettings({ enabled: true, provider: 'custom', baseUrl: 'https://provider.example/v1', model: 'note-model' })
  const complete = vi.fn().mockResolvedValue({ content: '整理结果', model: 'note-model' })
  Object.defineProperty(window, 'notebookDesktop', {
    configurable: true,
    value: { ai: { complete } },
  })
  const tokens: string[] = []
  await streamNotebookAnswer('改写', {
    version: 1,
    root: { kind: 'page', pageId: 'page-a' },
    expansion: 'embeds',
    items: [{
      key: 'page:page-a',
      target: { kind: 'page', pageId: 'page-a' },
      pageId: 'page-a',
      title: '指定页面',
      markdown: '允许发送的正文',
      relationship: 'root',
      depth: 0,
      truncated: false,
    }],
    markdown: '来源：指定页面\n\n允许发送的正文',
    warnings: [],
    totalCharacters: 7,
    truncated: false,
  }, (token) => tokens.push(token))
  expect(tokens).toEqual(['整理结果'])
  expect(complete).toHaveBeenCalledOnce()
  const request = complete.mock.calls[0]![0]
  expect(request.requestId).toEqual(expect.any(String))
  expect(request.baseUrl).toBe('https://provider.example/v1')
  expect(request.messages.at(-1)?.content).toContain('允许发送的正文')
})

test('parses a structured proposal while enforcing the @ page whitelist', async () => {
  saveAIProviderSettings({ enabled: true, provider: 'custom', baseUrl: 'https://provider.example/v1', model: 'note-model' })
  const complete = vi.fn().mockResolvedValue({
    content: '```json\n{"title":"整理","operations":[{"type":"update-page","pageId":"page-a","title":"新标题"}]}\n```',
  })
  Object.defineProperty(window, 'notebookDesktop', { configurable: true, value: { ai: { complete } } })
  const context = {
    version: 1 as const,
    root: { kind: 'page' as const, pageId: 'page-a' },
    expansion: 'embeds' as const,
    items: [],
    markdown: '允许正文',
    warnings: [],
    totalCharacters: 4,
    truncated: false,
  }
  const proposal = await requestNotebookProposal('改名', context, {
    notebooks: [{ id: 'book', name: '笔记本', sections: [{ id: 'section', name: '分区' }] }],
    pages: [{ id: 'page-a', title: '旧标题', sectionId: 'section' }],
  }, ['page-a'])
  expect(proposal.operations).toEqual([{ type: 'update-page', pageId: 'page-a', title: '新标题' }])
  expect(parseNotebookProposal('说明前缀 {"title":"A","operations":[]} 说明后缀').title).toBe('A')

  complete.mockResolvedValueOnce({
    content: '{"title":"越权","operations":[{"type":"delete-page","pageId":"page-b"}]}',
  })
  await expect(requestNotebookProposal('删除', context, {
    notebooks: [],
    pages: [{ id: 'page-b', title: '未授权', sectionId: 'section' }],
  }, ['page-a'])).rejects.toThrow('@ 授权')
})

test('forwards user cancellation to the desktop AI request', async () => {
  saveAIProviderSettings({ enabled: true, provider: 'custom', baseUrl: 'https://provider.example/v1', model: 'note-model' })
  let rejectRequest: ((error: Error) => void) | undefined
  const complete = vi.fn((_request: { requestId: string }) => new Promise((_resolve, reject) => { rejectRequest = reject }))
  const cancel = vi.fn(async () => { rejectRequest?.(new Error('cancelled')) })
  Object.defineProperty(window, 'notebookDesktop', { configurable: true, value: { ai: { complete, cancel } } })
  const controller = new AbortController()
  const pending = streamNotebookAnswer('测试取消', {
    version: 1,
    root: { kind: 'page', pageId: 'page-a' },
    expansion: 'embeds',
    items: [],
    markdown: '正文',
    warnings: [],
    totalCharacters: 2,
    truncated: false,
  }, vi.fn(), controller.signal)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
  const requestId = complete.mock.calls[0]![0].requestId
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(cancel).toHaveBeenCalledWith(requestId)
})

test('only permits secure or loopback AI service endpoints', () => {
  expect(validatedAIServiceUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  expect(validatedAIServiceUrl('https://ai.example/v1')).toBe('https://ai.example/v1')
  expect(() => validatedAIServiceUrl('http://ai.example/v1')).toThrow('HTTPS')
  expect(() => validatedAIServiceUrl('https://token@ai.example/v1')).toThrow('凭据')
})

test('rejects malformed and oversized local AI streams', async () => {
  vi.stubEnv('VITE_NOTEBOOK_AI_URL', 'http://127.0.0.1:8787')
  Object.defineProperty(window, 'notebookDesktop', { configurable: true, value: undefined })
  const context = {
    version: 1 as const,
    root: { kind: 'page' as const, pageId: 'page-a' },
    expansion: 'embeds' as const,
    items: [],
    markdown: '正文',
    warnings: [],
    totalCharacters: 2,
    truncated: false,
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response('event: token\ndata: not-json\n\n', { status: 200 })))
  await expect(streamNotebookAnswer('测试', context, vi.fn())).rejects.toThrow('无效的流事件')

  vi.stubGlobal('fetch', vi.fn(async () => new Response(`event: token\ndata: ${JSON.stringify({ text: 'x'.repeat(2_000_001) })}\n\n`, { status: 200 })))
  await expect(streamNotebookAnswer('测试', context, vi.fn())).rejects.toThrow('2,000,000')
})

test('does not silently fall back to an undeployed localhost service when desktop AI is disabled', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(streamNotebookAnswer('测试', {
    version: 1,
    root: { kind: 'page', pageId: 'page-a' },
    expansion: 'embeds',
    items: [],
    markdown: '正文',
    warnings: [],
    totalCharacters: 2,
    truncated: false,
  }, vi.fn())).rejects.toThrow('尚未启用')
  expect(fetcher).not.toHaveBeenCalled()
})
