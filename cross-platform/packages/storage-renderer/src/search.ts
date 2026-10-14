import MiniSearch from 'minisearch'
import type { Page } from '@notebook/domain'
import type { NotebookRendererDatabase } from './database'
import { extractText } from './util'

export const SEARCH_INDEX_CHUNK_SIZE = 24
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
  textByPage: Map<string, string>
  index: MiniSearch<{ id: string; title: string; preview: string; content: string }>
}

/**
 * Per-workspace search index. Building the MiniSearch index reads every page
 * and document, so the result is cached and invalidated only when a workspace
 * mutation lands. Pending builds are shared so concurrent queries do not
 * duplicate the work.
 */
export class SearchCache {
  private readonly cache = new Map<string, SearchCacheEntry>()
  private readonly pending = new Map<string, Promise<SearchCacheEntry>>()
  private readonly generations = new Map<string, number>()

  /**
   * Keeps a built index current after one page changed (an autosave), instead
   * of discarding it and re-reading every document on the next query.
   * `text` is the new body; omit it when only page metadata changed.
   */
  upsert(page: Page, text?: string) {
    const workspaceId = page.workspaceId
    if (this.pending.has(workspaceId)) {
      this.invalidate(workspaceId)
      return
    }
    const entry = this.cache.get(workspaceId)
    if (!entry) return
    if (entry.index.has(page.id)) entry.index.discard(page.id)
    const position = entry.pages.findIndex((candidate) => candidate.id === page.id)
    if (page.deletedAt) {
      if (position >= 0) entry.pages.splice(position, 1)
      entry.textByPage.delete(page.id)
      return
    }
    const content = text ?? entry.textByPage.get(page.id) ?? ''
    entry.textByPage.set(page.id, content)
    if (position >= 0) entry.pages[position] = page
    else entry.pages.push(page)
    entry.index.add({ id: page.id, title: page.title, preview: page.preview, content })
  }

  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId)
    this.pending.delete(workspaceId)
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1)
  }

  async get(workspaceId: string, db: NotebookRendererDatabase): Promise<SearchCacheEntry> {
    const cached = this.cache.get(workspaceId)
    if (cached) return cached
    const pending = this.pending.get(workspaceId)
    if (pending) return pending
    const generation = this.generations.get(workspaceId) ?? 0
    const build = (async () => {
      const pages = (await db.pages.where('workspaceId').equals(workspaceId).toArray()).filter((page) => !page.deletedAt)
      const pageIds = new Set(pages.map((page) => page.id))
      const documents = (await db.documents.toArray()).filter((document) => pageIds.has(document.pageId))
      const textByPage = new Map<string, string>()
      for (let offset = 0; offset < documents.length; offset += SEARCH_INDEX_CHUNK_SIZE) {
        for (const document of documents.slice(offset, offset + SEARCH_INDEX_CHUNK_SIZE)) {
          textByPage.set(document.pageId, document.markdown ?? extractText(document.tiptapJson))
        }
        await yieldToEventLoop()
      }
      const index = new MiniSearch<{ id: string; title: string; preview: string; content: string }>({ fields: ['title', 'preview', 'content'], storeFields: ['id'], tokenize: searchTokenize })
      for (let offset = 0; offset < pages.length; offset += SEARCH_INDEX_CHUNK_SIZE) {
        index.addAll(pages.slice(offset, offset + SEARCH_INDEX_CHUNK_SIZE).map((page) => ({
          id: page.id,
          title: page.title,
          preview: page.preview,
          content: textByPage.get(page.id) ?? '',
        })))
        await yieldToEventLoop()
      }
      const result = { pages, textByPage, index }
      if ((this.generations.get(workspaceId) ?? 0) === generation) this.cache.set(workspaceId, result)
      return result
    })()
    this.pending.set(workspaceId, build)
    try {
      return await build
    } finally {
      if (this.pending.get(workspaceId) === build) this.pending.delete(workspaceId)
    }
  }
}

export async function searchWorkspaceWith(db: NotebookRendererDatabase, searchIndex: SearchCache, workspaceId: string, query: string, limit = 50): Promise<Page[]> {
  const { pages, textByPage, index } = await searchIndex.get(workspaceId, db)
  // A Chinese phrase yields both a full token and overlapping CJK bigrams.
  // MiniSearch's default OR combination can otherwise rank pages sharing one
  // common bigram above an exact title match. Keep exact substring matches at
  // the front, then require all query tokens, and use fuzzy OR only as a
  // last-resort completion set.
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim()
  const exactMatches: Page[] = []
  for (let offset = 0; offset < pages.length; offset += SEARCH_INDEX_CHUNK_SIZE) {
    exactMatches.push(...pages.slice(offset, offset + SEARCH_INDEX_CHUNK_SIZE)
      .filter((page) => `${page.title}\n${page.preview}\n${textByPage.get(page.id) ?? ''}`.normalize('NFKC').toLocaleLowerCase().includes(normalizedQuery)))
    await yieldToEventLoop()
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
export async function searchWorkspaceHitsWith(db: NotebookRendererDatabase, searchIndex: SearchCache, workspaceId: string, query: string, limit = 30): Promise<SearchHit[]> {
  const terms = searchQueryTerms(query)
  if (!terms.length) return []
  const pages = await searchWorkspaceWith(db, searchIndex, workspaceId, terms.join(' '), limit)
  const { textByPage } = await searchIndex.get(workspaceId, db)
  return pages.map((page) => {
    const text = markdownToPlainText(textByPage.get(page.id) ?? '')
    const found = matchedTerms(`${page.title}\n${text}`, terms)
    return { page, snippet: found.length ? searchSnippet(text, found) : (page.preview || text.slice(0, 140)), terms: found }
  })
}
