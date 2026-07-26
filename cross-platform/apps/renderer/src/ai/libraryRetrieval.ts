import MiniSearch from 'minisearch'
import type { AIContextBundle, AIContextItem } from '@notebook/sync-contract'
import type { PageSummary } from '../model'
import { documentToMarkdown } from '../editor/extensions'

const DEFAULT_MAX_PAGES = 16
const DEFAULT_MAX_CHUNKS = 8
const DEFAULT_MAX_CHARACTERS = 20_000
const TARGET_CHUNK_CHARACTERS = 1_600

type DocumentNode = {
  type?: string
  attrs?: Record<string, unknown>
  text?: string
  content?: DocumentNode[]
}

export interface NotebookRetrievalChunk {
  id: string
  pageId: string
  pageTitle: string
  headingPath: string[]
  markdown: string
  score: number
  updatedAt?: string
}

export interface NotebookRetrievalResult {
  query: string
  chunks: NotebookRetrievalChunk[]
  totalCharacters: number
  truncated: boolean
  warnings: string[]
}

type RetrievalSearchDocument = NotebookRetrievalChunk & {
  heading: string
}

interface RetrieveNotebookLibraryOptions {
  query: string
  candidatePages: PageSummary[]
  loadDocument(pageId: string): Promise<Record<string, unknown> | undefined>
  maxPages?: number
  maxChunks?: number
  maxCharacters?: number
  signal?: AbortSignal
  documentTimeoutMs?: number
}

function nodeText(node: DocumentNode): string {
  return [node.text, ...(node.content?.map(nodeText) ?? [])].filter(Boolean).join(' ')
}

function headingLevel(node: DocumentNode) {
  const level = Number(node.attrs?.level)
  return node.type === 'heading' && Number.isInteger(level) && level >= 1 && level <= 6 ? level : undefined
}

function serializeNode(node: DocumentNode) {
  try {
    return documentToMarkdown({ type: 'doc', content: [node] }).trim()
  } catch {
    return nodeText(node).trim()
  }
}

/**
 * Splits the editor document by its existing top-level Markdown blocks. This
 * reuses the Tiptap schema and serializer instead of maintaining another
 * Markdown parser. Tables, code blocks, task lists and Notebook references
 * remain atomic whenever they are represented by one top-level node.
 */
export function splitNotebookDocument(
  page: Pick<PageSummary, 'id' | 'title' | 'updatedLabel'>,
  document: Record<string, unknown>,
  targetCharacters = TARGET_CHUNK_CHARACTERS,
): NotebookRetrievalChunk[] {
  const nodes = Array.isArray((document as DocumentNode).content) ? (document as DocumentNode).content! : []
  const headings: string[] = []
  const chunks: NotebookRetrievalChunk[] = []
  let buffer: string[] = []
  let bufferHeading: string[] = []
  const currentHeadingPath = () => headings.filter(Boolean)

  const flush = () => {
    const markdown = buffer.join('\n\n').trim()
    if (markdown) {
      chunks.push({
        id: `${page.id}:chunk:${chunks.length}`,
        pageId: page.id,
        pageTitle: page.title,
        headingPath: bufferHeading,
        markdown,
        score: 0,
      })
    }
    buffer = []
    bufferHeading = currentHeadingPath()
  }

  for (const node of nodes) {
    const level = headingLevel(node)
    if (level) {
      if (buffer.length) flush()
      headings.splice(level - 1)
      headings[level - 1] = nodeText(node).trim() || `H${level}`
      bufferHeading = currentHeadingPath()
    }
    const markdown = serializeNode(node)
    if (!markdown) continue
    const currentLength = buffer.reduce((total, value) => total + value.length + 2, 0)
    if (buffer.length && currentLength + markdown.length > targetCharacters) flush()
    if (!buffer.length) bufferHeading = currentHeadingPath()
    buffer.push(markdown)
    // Large code blocks and tables stay intact, even when they exceed the
    // target. They are bounded later by the total transmission budget.
    if (markdown.length >= targetCharacters) flush()
  }
  flush()
  return chunks
}

function tokenize(value: string) {
  const normalizedValue = value.normalize('NFKC').toLocaleLowerCase()
  const parts = normalizedValue.match(/[a-z0-9_.:/+-]+|[\p{Script=Han}]+/gu) ?? []
  return parts.flatMap((part) => {
    if (!/^\p{Script=Han}+$/u.test(part) || part.length < 2) return [part]
    return [part, ...Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))]
  })
}

function normalized(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
}

export async function retrieveNotebookLibrary({
  query,
  candidatePages,
  loadDocument,
  maxPages = DEFAULT_MAX_PAGES,
  maxChunks = DEFAULT_MAX_CHUNKS,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
  signal,
  documentTimeoutMs = 3_000,
}: RetrieveNotebookLibraryOptions): Promise<NotebookRetrievalResult> {
  const safePages = candidatePages.filter((page) => !page.locked && page.kind !== 'task').slice(0, Math.max(1, maxPages))
  const chunks: NotebookRetrievalChunk[] = []
  const warnings: string[] = []
  for (const page of safePages) {
    signal?.throwIfAborted()
    try {
      const document = await boundedPromise(loadDocument(page.id), documentTimeoutMs, signal)
      if (!document) {
        warnings.push(`无法读取“${page.title}”`)
        continue
      }
      chunks.push(...splitNotebookDocument(page, document))
    } catch {
      signal?.throwIfAborted()
      warnings.push(`无法读取“${page.title}”`)
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }

  const index = new MiniSearch<RetrievalSearchDocument>({
    idField: 'id',
    fields: ['pageTitle', 'heading', 'markdown'],
    storeFields: ['id'],
    tokenize,
    searchOptions: {
      prefix: true,
      fuzzy: 0.12,
      boost: { pageTitle: 5, heading: 3, markdown: 1 },
    },
  })
  index.addAll(chunks.map((chunk) => ({ ...chunk, heading: chunk.headingPath.join(' › ') })))
  const pageRank = new Map(safePages.map((page, rank) => [page.id, rank]))
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const normalizedQuery = normalized(query)
  const ranked = index.search(query).flatMap((hit) => {
    const chunk = chunkById.get(String(hit.id))
    if (!chunk) return []
    const pagePosition = pageRank.get(chunk.pageId) ?? safePages.length
    const haystack = normalized(`${chunk.pageTitle}\n${chunk.headingPath.join(' ')}\n${chunk.markdown}`)
    const exactBoost = normalizedQuery && haystack.includes(normalizedQuery) ? 10 : 0
    return [{ ...chunk, score: hit.score + exactBoost + 4 / (pagePosition + 1) }]
  }).sort((left, right) => right.score - left.score)

  // The page-level index already returned these pages in relevance order. If
  // chunk tokenization produces no result, retain the first non-empty blocks
  // instead of silently answering without notebook evidence.
  const candidates = ranked.length
    ? ranked
    : chunks.map((chunk) => ({ ...chunk, score: 1 / ((pageRank.get(chunk.pageId) ?? safePages.length) + 1) }))

  const selected: NotebookRetrievalChunk[] = []
  let totalCharacters = 0
  let truncated = false
  for (const chunk of candidates) {
    if (selected.length >= maxChunks) {
      truncated = true
      break
    }
    const remaining = maxCharacters - totalCharacters
    if (remaining <= 0) {
      truncated = true
      break
    }
    const markdown = chunk.markdown.length > remaining ? chunk.markdown.slice(0, remaining) : chunk.markdown
    selected.push({ ...chunk, markdown })
    totalCharacters += markdown.length
    if (markdown.length < chunk.markdown.length) {
      truncated = true
      break
    }
  }
  return { query, chunks: selected, totalCharacters, truncated, warnings }
}

function boundedPromise<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    const timer = window.setTimeout(() => finish(() => reject(new Error('读取笔记超时'))), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
  })
}

export function retrievalResultToAIContext(result: NotebookRetrievalResult): AIContextBundle {
  const rootPageId = result.chunks[0]?.pageId ?? 'notebook-library-search'
  const items: AIContextItem[] = result.chunks.map((chunk) => ({
    key: `retrieval:${chunk.id}`,
    relationship: 'retrieved',
    depth: 0,
    target: { kind: 'page', pageId: chunk.pageId },
    pageId: chunk.pageId,
    title: chunk.headingPath.length ? `${chunk.pageTitle} › ${chunk.headingPath.join(' › ')}` : chunk.pageTitle,
    markdown: chunk.markdown,
    updatedAt: chunk.updatedAt,
    truncated: false,
  }))
  return {
    version: 1,
    root: { kind: 'page', pageId: rootPageId },
    expansion: 'embeds',
    items,
    markdown: items.map((item) => [
      `<!-- notebook-ai-source:start key="${item.key}" relation="retrieved" -->`,
      `检索来源：${item.title}（${item.pageId}）`,
      '',
      item.markdown,
      `<!-- notebook-ai-source:end key="${item.key}" -->`,
    ].join('\n')).join('\n\n'),
    warnings: [],
    totalCharacters: result.totalCharacters,
    truncated: result.truncated,
  }
}
