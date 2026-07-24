import { markdownToEditorCache, type MarkdownAssetReference } from '@notebook/sync-contract'

type ParseRequest = {
  id: number
  markdown: string
  assets: MarkdownAssetReference[]
}

type ParseReply = {
  id: number
  document?: Record<string, unknown>
  error?: string
}

self.addEventListener('message', (event: MessageEvent<ParseRequest>) => {
  const { id, markdown, assets } = event.data
  try {
    const reply: ParseReply = { id, document: markdownToEditorCache(markdown, assets) }
    self.postMessage(reply)
  } catch (cause) {
    const reply: ParseReply = { id, error: cause instanceof Error ? cause.message : 'Markdown 解析失败' }
    self.postMessage(reply)
  }
})
