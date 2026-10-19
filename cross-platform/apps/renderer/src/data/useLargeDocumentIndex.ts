import { useEffect, useState } from 'react'
import { isLargeDocument, type LargeDocument } from './largeDocument'
import { indexLargeMarkdown, type ReadingIndex } from './largeDocumentIndex'

const indexes = new WeakMap<LargeDocument, Promise<ReadingIndex>>()
function loadIndex(document: LargeDocument) {
  const cached = indexes.get(document)
  if (cached) return cached
  const operation = typeof Worker === 'undefined'
    ? Promise.resolve().then(() => indexLargeMarkdown(document.markdown))
    : new Promise<ReadingIndex>((resolve, reject) => {
      const worker = new Worker(new URL('./largeDocumentIndex.worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('message', (event: MessageEvent<{ index?: ReadingIndex; error?: string }>) => {
        worker.terminate()
        if (event.data.index) resolve(event.data.index)
        else reject(new Error(event.data.error ?? '无法读取章节'))
      })
      worker.addEventListener('error', () => { worker.terminate(); reject(new Error('章节加载失败，请重新打开笔记')) })
      worker.postMessage(document.markdown)
    })
  indexes.set(document, operation)
  return operation
}

export function useLargeDocumentIndex(document?: Record<string, unknown>) {
  const [state, setState] = useState<{ document?: Record<string, unknown>; index?: ReadingIndex; error?: string }>({})
  useEffect(() => {
    if (!isLargeDocument(document)) return
    let cancelled = false
    void loadIndex(document).then((index) => { if (!cancelled) setState({ document, index }) })
      .catch((error: Error) => { if (!cancelled) setState({ document, error: error.message }) })
    return () => { cancelled = true }
  }, [document])
  return state
}
