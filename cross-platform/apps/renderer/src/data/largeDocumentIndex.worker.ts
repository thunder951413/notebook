import { indexLargeMarkdown } from './largeDocumentIndex'

self.addEventListener('message', (event: MessageEvent<string>) => {
  try { self.postMessage({ index: indexLargeMarkdown(event.data) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '无法读取章节' }) }
})
