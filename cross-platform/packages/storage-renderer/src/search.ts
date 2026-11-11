import MiniSearch from 'minisearch'
import type { Page } from '@notebook/domain'
import type { NotebookRendererDatabase } from './database'
import { extractText } from './util'

export const SEARCH_INDEX_CHUNK_SIZE = 24
/** Text indexed between two yields while building, so a few book-sized notes do not block input together. */
const SEARCH_INDEX_CHUNK_CHARACTERS = 200_000
/** Past this many changed pages a full rebuild is cheaper than refreshing them one by one. */
const SEARCH_REFRESH_LIMIT = 300
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase()
// Dictionary-based word segmentation (ICU, the jieba-like segmenter built
// into WebKit and V8) when available. Overlapping CJK bigrams keep recall for
// words the dictionary splits differently.
const wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : undefined
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

export const searchTokenize = (value: string) => {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []
  const cjk = [...normalized.matchAll(CJK_RUN)].flatMap((match) => {
    const characters = [...match[0]]
    const bigrams = characters.length === 1 ? characters : characters.slice(0, -1).map((character, index) => character + characters[index + 1])
    if (!wordSegmenter || characters.length < 3) return bigrams
    const segmented = [...wordSegmenter.segment(match[0])]
      .filter((segment) => segment.isWordLike && [...segment.segment].length > 2)
      .map((segment) => segment.segment)
    return [...bigrams, ...segmented]
  })
  return [...words, ...cjk]
}

export interface SearchCacheEntry {
  pages: Page[]
  /** Body text, normalized once for the exact-substring pass and metadata-only updates. */
  haystackByPage: Map<string, string>
  index: MiniSearch<{ id: string; title: string; preview: string; content: string }>
}

const normalizeHaystack = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
const pageHeaderHaystack = (page: Page) => normalizeHaystack(`${page.title}\n${page.preview}`)

/**
 * What the repository needs from full-text search. `SearchCache` keeps the
 * index on the calling thread; `WorkerSearchIndex` (searchWorker.ts) keeps it
 * in a Web Worker, so building it never blocks typing.
 */
export interface SearchIndex {
  upsert(page: Page, text?: string): void
  remove(workspaceId: string, pageId: string): void
  refresh(workspaceId: string, pageIds: Iterable<string>, db: NotebookRendererDatabase): Promise<void>
  invalidate(workspaceId: string): void
  close(): void
  search(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number, signal?: AbortSignal): Promise<Page[]>
  candidates(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number): Promise<Page[]>
  hits(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number, signal?: AbortSignal): Promise<SearchHit[]>
}

type QueuedMutation = (entry: SearchCacheEntry) => Promise<void> | void

/**
 * Per-workspace search index. Building the MiniSearch index reads every page
 * and document, so the result is cached and invalidated only when a workspace
 * mutation lands. Pending builds and refreshes are shared so concurrent queries
 * wait for a consistent index without duplicating work.
 */
export class SearchCache implements SearchIndex {
  private readonly cache = new Map<string, SearchCacheEntry>()
  private readonly pending = new Map<string, Promise<SearchCacheEntry>>()
  private readonly generations = new Map<string, number>()
  /**
   * Edits and refreshes that land while a build or refresh is running. They are
   * applied in arrival order once the in-flight operation completes; discarding
   * the build instead restarted it on every autosave.
   */
  private readonly queued = new Map<string, QueuedMutation[]>()

  private queue(workspaceId: string, apply: QueuedMutation) {
    const list = this.queued.get(workspaceId) ?? []
    list.push(apply)
    this.queued.set(workspaceId, list)
  }

  private async drainQueued(workspaceId: string, entry: SearchCacheEntry, generation: number) {
    while ((this.generations.get(workspaceId) ?? 0) === generation) {
      const list = this.queued.get(workspaceId)
      const next = list?.shift()
      if (!next) {
        this.queued.delete(workspaceId)
        return
      }
      await next(entry)
    }
  }

  private applyUpsert(entry: SearchCacheEntry, page: Page, text?: string) {
    if (entry.index.has(page.id)) entry.index.discard(page.id)
    const position = entry.pages.findIndex((candidate) => candidate.id === page.id)
    if (page.deletedAt) {
      if (position >= 0) entry.pages.splice(position, 1)
      entry.haystackByPage.delete(page.id)
      return
    }
    const content = text !== undefined ? normalizeHaystack(text) : (entry.haystackByPage.get(page.id) ?? '')
    entry.haystackByPage.set(page.id, content)
    if (position >= 0) entry.pages[position] = page
    else entry.pages.push(page)
    entry.index.add({ id: page.id, title: page.title, preview: page.preview, content })
  }

  private applyRemove(entry: SearchCacheEntry, pageId: string) {
    if (entry.index.has(pageId)) entry.index.discard(pageId)
    const position = entry.pages.findIndex((candidate) => candidate.id === pageId)
    if (position >= 0) entry.pages.splice(position, 1)
    entry.haystackByPage.delete(pageId)
  }

  search(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number, signal?: AbortSignal) {
    return searchWorkspaceWith(db, this, workspaceId, query, limit, signal)
  }

  candidates(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number) {
    return searchWorkspaceCandidatesWith(db, this, workspaceId, query, limit)
  }

  hits(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number, signal?: AbortSignal) {
    return searchWorkspaceHitsWith(db, this, workspaceId, query, limit, signal)
  }

  /**
   * Keeps a built index current after one page changed (an autosave), instead
   * of discarding it and re-reading every document on the next query.
   * `text` is the new body; omit it when only page metadata changed.
   */
  upsert(page: Page, text?: string) {
    const workspaceId = page.workspaceId
    if (this.pending.has(workspaceId)) {
      this.queue(workspaceId, (entry) => this.applyUpsert(entry, page, text))
      return
    }
    const entry = this.cache.get(workspaceId)
    if (!entry) return
    this.applyUpsert(entry, page, text)
  }

  /** Drops one page from a built index (the page was purged). */
  remove(workspaceId: string, pageId: string) {
    if (this.pending.has(workspaceId)) {
      this.queue(workspaceId, (entry) => this.applyRemove(entry, pageId))
      return
    }
    const entry = this.cache.get(workspaceId)
    if (!entry) return
    this.applyRemove(entry, pageId)
  }

  /**
   * Brings a built index up to date for pages whose page or document record
   * was written outside the editor (a sync). Only those pages are re-read,
   * so a pull no longer forces the next search to rebuild the whole index on
   * the main thread. Without a built index there is nothing to keep current.
   */
  async refresh(workspaceId: string, pageIds: Iterable<string>, db: NotebookRendererDatabase) {
    const ids = [...new Set(pageIds)]
    if (!ids.length || (!this.cache.has(workspaceId) && !this.pending.has(workspaceId))) return
    if (ids.length > SEARCH_REFRESH_LIMIT) {
      this.invalidate(workspaceId)
      return
    }
    const generation = this.generations.get(workspaceId) ?? 0
    const step = async (entry: SearchCacheEntry) => {
      const pages = await db.pages.bulkGet(ids)
      const documents = await db.documents.bulkGet(ids)
      // The index was rebuilt or dropped while reading: it is already current or will be.
      if ((this.generations.get(workspaceId) ?? 0) !== generation || this.cache.get(workspaceId) !== entry) return
      ids.forEach((pageId, position) => {
        const page = pages[position]
        if (!page || page.workspaceId !== workspaceId) { this.applyRemove(entry, pageId); return }
        const document = documents[position]
        this.applyUpsert(entry, page, document ? document.markdown ?? extractText(document.tiptapJson) : '')
      })
    }
    const existing = this.pending.get(workspaceId)
    if (existing) {
      let stepError: unknown
      this.queue(workspaceId, async (entry) => {
        try {
          await step(entry)
        } catch (error) {
          stepError = error
          this.invalidate(workspaceId)
        }
      })
      await existing
      if (stepError !== undefined) throw stepError
      return
    }
    const entry = this.cache.get(workspaceId)
    if (!entry) return
    let refreshError: unknown
    let run: Promise<SearchCacheEntry> | undefined
    run = (async () => {
      try {
        await step(entry)
        await this.drainQueued(workspaceId, entry, generation)
        return entry
      } catch (error) {
        refreshError = error
        this.invalidate(workspaceId)
        return entry
      }
    })().finally(() => {
      if (this.pending.get(workspaceId) === run) {
        this.pending.delete(workspaceId)
      }
    })
    this.pending.set(workspaceId, run)
    await run
    if (refreshError !== undefined) throw refreshError
  }

  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId)
    this.pending.delete(workspaceId)
    this.queued.delete(workspaceId)
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1)
  }

  close() {
    for (const workspaceId of new Set([...this.cache.keys(), ...this.pending.keys(), ...this.queued.keys()])) {
      this.invalidate(workspaceId)
    }
    this.cache.clear()
    this.pending.clear()
    this.queued.clear()
    this.generations.clear()
  }

  async get(workspaceId: string, db: NotebookRendererDatabase): Promise<SearchCacheEntry> {
    const pending = this.pending.get(workspaceId)
    if (pending) return pending
    const cached = this.cache.get(workspaceId)
    if (cached) return cached
    const generation = this.generations.get(workspaceId) ?? 0
    let build: Promise<SearchCacheEntry> | undefined
    build = (async () => {
      const pages = (await db.pages.where('workspaceId').equals(workspaceId).toArray()).filter((page) => !page.deletedAt)
      const pageIds = new Set(pages.map((page) => page.id))
      const documents = (await db.documents.toArray()).filter((document) => pageIds.has(document.pageId))
      const haystackByPage = new Map<string, string>()
      for (let offset = 0; offset < documents.length; offset += SEARCH_INDEX_CHUNK_SIZE) {
        for (const document of documents.slice(offset, offset + SEARCH_INDEX_CHUNK_SIZE)) {
          haystackByPage.set(document.pageId, normalizeHaystack(document.markdown ?? extractText(document.tiptapJson)))
        }
        await yieldToEventLoop()
      }
      documents.length = 0
      const index = new MiniSearch<{ id: string; title: string; preview: string; content: string }>({ fields: ['title', 'preview', 'content'], storeFields: ['id'], tokenize: searchTokenize })
      // Yield after a number of pages or an amount of text, whichever comes
      // first: tokenizing is proportional to text, and one imported book can
      // outweigh thousands of ordinary notes.
      let pagesSinceYield = 0
      let charactersSinceYield = 0
      for (const page of pages) {
        const content = haystackByPage.get(page.id) ?? ''
        index.add({ id: page.id, title: page.title, preview: page.preview, content })
        pagesSinceYield += 1
        charactersSinceYield += content.length
        if (pagesSinceYield >= SEARCH_INDEX_CHUNK_SIZE || charactersSinceYield >= SEARCH_INDEX_CHUNK_CHARACTERS) {
          await yieldToEventLoop()
          pagesSinceYield = 0
          charactersSinceYield = 0
        }
      }
      const result = { pages, haystackByPage, index }
      if ((this.generations.get(workspaceId) ?? 0) === generation) {
        this.cache.set(workspaceId, result)
        await this.drainQueued(workspaceId, result, generation)
      }
      return result
    })().finally(() => {
      if (this.pending.get(workspaceId) === build) {
        this.pending.delete(workspaceId)
      }
    })
    this.pending.set(workspaceId, build)
    return build
  }
}

/**
 * `signal` stops a superseded query (the user kept typing or deleting) at the
 * next chunk instead of letting every stale full scan run to completion.
 */
export async function searchWorkspaceWith(db: NotebookRendererDatabase, searchIndex: SearchCache, workspaceId: string, query: string, limit = 50, signal?: AbortSignal): Promise<Page[]> {
  const { pages, haystackByPage, index } = await searchIndex.get(workspaceId, db)
  signal?.throwIfAborted()
  // A Chinese phrase yields both a full token and overlapping CJK bigrams.
  // MiniSearch's default OR combination can otherwise rank pages sharing one
  // common bigram above an exact title match. Keep exact substring matches at
  // the front, then require all query tokens, and use fuzzy OR only as a
  // last-resort completion set.
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim()
  const exactMatches: Page[] = []
  for (let offset = 0; offset < pages.length; offset += SEARCH_INDEX_CHUNK_SIZE) {
    exactMatches.push(...pages.slice(offset, offset + SEARCH_INDEX_CHUNK_SIZE)
      .filter((page) => pageHeaderHaystack(page).includes(normalizedQuery) || Boolean(haystackByPage.get(page.id)?.includes(normalizedQuery))))
    await yieldToEventLoop()
    signal?.throwIfAborted()
  }
  const exactIds = exactMatches
    .sort((left, right) => {
      const leftTitle = left.title.normalize('NFKC').toLocaleLowerCase()
      const rightTitle = right.title.normalize('NFKC').toLocaleLowerCase()
      // Exact title, then titles containing the query, then body-only matches.
      const rank = (title: string) => title === normalizedQuery ? 2 : title.includes(normalizedQuery) ? 1 : 0
      return rank(rightTitle) - rank(leftTitle) || right.updatedAt.localeCompare(left.updatedAt)
    })
    .map((page) => page.id)
  const strictIds = index.search(query, { prefix: true, fuzzy: 0.15, combineWith: 'AND' }).map((result) => String(result.id))
  const fallbackIds = index.search(query, { prefix: true, fuzzy: 0.15 }).map((result) => String(result.id))
  const ids = [...new Set([...exactIds, ...strictIds, ...fallbackIds])].slice(0, limit)
  const byId = new Map(pages.map((page) => [page.id, page]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/**
 * Returns a high-recall candidate set using only the cached inverted index.
 * Unlike the user-facing search ranking above, this deliberately avoids the
 * O(page count) exact-substring pass. Callers must verify the small result
 * set before presenting an exact semantic such as an unlinked mention.
 */
export async function searchWorkspaceCandidatesWith(db: NotebookRendererDatabase, searchIndex: SearchCache, workspaceId: string, query: string, limit = 200): Promise<Page[]> {
  const { pages, index } = await searchIndex.get(workspaceId, db)
  const strictIds = index.search(query, { prefix: true, fuzzy: false, combineWith: 'AND' }).map((result) => String(result.id))
  const fallbackIds = strictIds.length
    ? []
    : index.search(query, { prefix: true, fuzzy: 0.15 }).map((result) => String(result.id))
  const ids = [...new Set([...strictIds, ...fallbackIds])].slice(0, limit)
  const byId = new Map(pages.map((page) => [page.id, page]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

export interface SearchHit {
  page: Page
  /** Plain-text excerpt around the first match (or the preview). */
  snippet: string
  /** Strings to highlight in the title and snippet. */
  terms: string[]
}

/** Readable text of canonical Markdown for excerpts (links show their labels). */
export function markdownToPlainText(markdown: string) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^```[^\n]*$/gm, ' ')
    .replace(/!?\[\[page:[^\]|]*\|((?:\\.|[^\]\\])+)\]\]/g, '$1')
    .replace(/!?\[\[page:[^\]]*\]\]/g, ' ')
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]|\n]+)\]\]/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+\^[A-Za-z0-9][A-Za-z0-9._:-]*[ \t]*$/gm, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Query words; quotes group a phrase. */
export function searchQueryTerms(query: string) {
  const terms: string[] = []
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? '').trim()
    if (term) terms.push(term)
  }
  return terms
}

function locate(haystack: string, term: string) {
  return haystack.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())
}

/** Terms present in `text`; long CJK terms fall back to their bigrams. */
export function matchedTerms(text: string, terms: string[]) {
  const found: string[] = []
  for (const term of terms) {
    if (locate(text, term) >= 0) { found.push(term); continue }
    const characters = [...term]
    if (characters.length > 2 && /\p{Script=Han}/u.test(term)) {
      for (let index = 0; index < characters.length - 1; index += 1) {
        const bigram = characters[index]! + characters[index + 1]!
        if (locate(text, bigram) >= 0 && !found.includes(bigram)) found.push(bigram)
      }
    }
  }
  return found
}

export function searchSnippet(text: string, terms: string[], radius = 48) {
  let first = -1
  let length = 0
  for (const term of terms) {
    const index = locate(text, term)
    if (index >= 0 && (first < 0 || index < first)) { first = index; length = term.length }
  }
  if (first < 0) return text.slice(0, radius * 3)
  const start = Math.max(0, first - radius)
  const end = Math.min(text.length, first + length + radius * 2)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Ranked full-text hits with highlighted excerpts. */
export async function searchWorkspaceHitsWith(db: NotebookRendererDatabase, searchIndex: SearchCache, workspaceId: string, query: string, limit = 30, signal?: AbortSignal): Promise<SearchHit[]> {
  const terms = searchQueryTerms(query)
  if (!terms.length) return []
  const pages = await searchWorkspaceWith(db, searchIndex, workspaceId, terms.join(' '), limit, signal)
  if (!pages.length) return []
  const { haystackByPage } = await searchIndex.get(workspaceId, db)
  const documents = await db.documents.bulkGet(pages.map((page) => page.id))
  signal?.throwIfAborted()
  return pages.map((page, index) => {
    const document = documents[index]
    const raw = document ? (document.markdown ?? extractText(document.tiptapJson)) : (haystackByPage.get(page.id) ?? '')
    const text = markdownToPlainText(raw)
    const found = matchedTerms(`${page.title}\n${text}`, terms)
    return { page, snippet: found.length ? searchSnippet(text, found) : (page.preview || text.slice(0, 140)), terms: found }
  })
}
