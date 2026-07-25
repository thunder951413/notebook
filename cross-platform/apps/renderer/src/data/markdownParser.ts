import { markdownToEditorCache, type MarkdownAssetReference } from '@notebook/sync-contract'

type ParseReply = {
  id: number
  document?: Record<string, unknown>
  error?: string
}

const LARGE_MARKDOWN_THRESHOLD = 200_000
const PARALLEL_CHUNK_TARGET = 90_000
const MAX_PARSER_WORKERS = 4
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+/m
const pending = new Map<number, {
  resolve: (document: Record<string, unknown>) => void
  reject: (cause: Error) => void
}>()
let worker: Worker | undefined
let requestId = 0

function createParserWorker() {
  return new Worker(new URL('./markdownParser.worker.ts', import.meta.url), { type: 'module' })
}

function parserWorker() {
  if (typeof Worker === 'undefined') return undefined
  if (worker) return worker
  worker = createParserWorker()
  worker.addEventListener('message', (event: MessageEvent<ParseReply>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.document) request.resolve(event.data.document)
    else request.reject(new Error(event.data.error ?? 'Markdown 解析失败'))
  })
  worker.addEventListener('error', () => {
    for (const request of pending.values()) request.reject(new Error('Markdown 解析线程不可用'))
    pending.clear()
    worker?.terminate()
    worker = undefined
  })
  return worker
}

function parseWithSharedWorker(markdown: string, assets: MarkdownAssetReference[]) {
  const availableWorker = parserWorker()
  if (!availableWorker) return Promise.resolve(markdownToEditorCache(markdown, assets))
  const id = ++requestId
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    availableWorker.postMessage({ id, markdown, assets })
  })
}

/**
 * Split only at blank Markdown block boundaries outside fenced code/math.
 * Reference-style links can depend on definitions elsewhere in the document,
 * so those documents deliberately stay on the single-parser path.
 */
export function splitMarkdownForParallelParsing(markdown: string, targetSize = PARALLEL_CHUNK_TARGET) {
  if (markdown.length <= targetSize || REFERENCE_DEFINITION.test(markdown)) return [markdown]
  const chunks: string[] = []
  let chunkStart = 0
  let offset = 0
  let fence: { marker: string; length: number } | undefined
  let mathBlock = false

  while (offset < markdown.length) {
    const newline = markdown.indexOf('\n', offset)
    const lineEnd = newline < 0 ? markdown.length : newline
    const nextOffset = newline < 0 ? markdown.length : newline + 1
    const line = markdown.slice(offset, lineEnd)
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!
      const length = fenceMatch[1]!.length
      if (!fence) fence = { marker, length }
      else if (fence.marker === marker && length >= fence.length) fence = undefined
    } else if (!fence && line.trim() === '$$') {
      mathBlock = !mathBlock
    }

    if (!fence && !mathBlock && line.trim() === '' && nextOffset - chunkStart >= targetSize) {
      chunks.push(markdown.slice(chunkStart, nextOffset))
      chunkStart = nextOffset
    }
    offset = nextOffset
  }
  if (chunkStart < markdown.length) chunks.push(markdown.slice(chunkStart))
  return chunks.length > 1 ? chunks : [markdown]
}

function emptyParagraph(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const node = value as { type?: unknown; content?: unknown[] }
  return node.type === 'paragraph' && (!Array.isArray(node.content) || node.content.length === 0)
}

export function mergeParsedMarkdownChunks(documents: Record<string, unknown>[]) {
  if (documents.length === 1) return documents[0]!
  const content: unknown[] = []
  documents.forEach((document, index) => {
    const nodes = Array.isArray(document.content) ? [...document.content] : []
    if (index > 0) while (nodes.length && emptyParagraph(nodes[0])) nodes.shift()
    if (index < documents.length - 1) while (nodes.length && emptyParagraph(nodes[nodes.length - 1])) nodes.pop()
    content.push(...nodes)
  })
  return { ...documents[0], type: 'doc', content }
}

function parseOnDedicatedWorker(
  activeWorker: Worker,
  id: number,
  markdown: string,
  assets: MarkdownAssetReference[],
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (event: MessageEvent<ParseReply>) => {
      cleanup()
      if (event.data.document) resolve(event.data.document)
      else reject(new Error(event.data.error ?? 'Markdown 解析失败'))
    }
    const onError = () => {
      cleanup()
      reject(new Error('Markdown 解析线程不可用'))
    }
    const cleanup = () => {
      activeWorker.removeEventListener('message', onMessage)
      activeWorker.removeEventListener('error', onError)
    }
    activeWorker.addEventListener('message', onMessage)
    activeWorker.addEventListener('error', onError)
    activeWorker.postMessage({ id, markdown, assets })
  })
}

async function parseChunksInParallel(chunks: string[], assets: MarkdownAssetReference[]) {
  const output = Array.from<Record<string, unknown>>({ length: chunks.length })
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(MAX_PARSER_WORKERS, chunks.length) },
    () => createParserWorker(),
  )
  try {
    await Promise.all(workers.map(async (activeWorker) => {
      while (cursor < chunks.length) {
        const index = cursor++
        output[index] = await parseOnDedicatedWorker(activeWorker, index + 1, chunks[index]!, assets)
      }
    }))
    return mergeParsedMarkdownChunks(output)
  } finally {
    workers.forEach((activeWorker) => activeWorker.terminate())
  }
}

export async function parseMarkdownForEditor(markdown: string, assets: MarkdownAssetReference[] = []) {
  if (markdown.length < LARGE_MARKDOWN_THRESHOLD) return markdownToEditorCache(markdown, assets)
  if (typeof Worker === 'undefined') return markdownToEditorCache(markdown, assets)
  const chunks = splitMarkdownForParallelParsing(markdown)
  try {
    return chunks.length > 1
      ? await parseChunksInParallel(chunks, assets)
      : await parseWithSharedWorker(markdown, assets)
  } catch {
    return markdownToEditorCache(markdown, assets)
  }
}
