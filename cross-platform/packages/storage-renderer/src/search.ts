import MiniSearch from 'minisearch'
import type { Page } from '@notebook/domain'
import type { NotebookRendererDatabase } from './database'
import { extractText } from './util'

export const SEARCH_INDEX_CHUNK_SIZE = 24
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase()
export const searchTokenize = (value: string) => {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []
  const cjk = [...normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)].flatMap((match) => {
    const characters = [...match[0]]
    return characters.length === 1 ? characters : characters.slice(0, -1).map((character, index) => character + characters[index + 1])
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
      return Number(rightTitle === normalizedQuery) - Number(leftTitle === normalizedQuery) || right.updatedAt.localeCompare(left.updatedAt)
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
