import type { Page, PageDocument, PageLink } from '@notebook/domain'
import type { DexieNotebookRepository } from '@notebook/storage-renderer'
import { extractWikiLinks, normalizeWikiTitle, renameWikiLinks, wikiLinkContext } from '@notebook/sync-contract'
import { DEFAULT_WORKSPACE_ID } from '../sync/syncSettings'
import type { WikiTitleResolver } from './referenceIndex'

/** Title → page, with the same precedence as the editor: notes before to-dos, then most recently updated. */
export function wikiTitleResolver(pages: Page[]): WikiTitleResolver {
  const byTitle = new Map<string, Page>()
  for (const page of pages) {
    if (page.deletedAt) continue
    const key = normalizeWikiTitle(page.title)
    if (!key) continue
    const current = byTitle.get(key)
    const better = !current
      || (current.kind === 'task' && page.kind !== 'task')
      || ((current.kind === 'task') === (page.kind === 'task') && page.updatedAt > current.updatedAt)
    if (better) byTitle.set(key, page)
  }
  return (title) => byTitle.get(normalizeWikiTitle(title))?.id
}

/**
 * Title links pointing at `target`, found by scanning candidate documents.
 * Complements the stored index, which only knows links whose target existed
 * when the source was saved.
 */
export async function findTitleBacklinks(repository: DexieNotebookRepository, target: Page, pages: Page[], isPrivate: (page: Page) => boolean, signal?: AbortSignal): Promise<PageLink[]> {
  const title = target.title.trim()
  if (!title) return []
  const resolve = wikiTitleResolver(pages)
  if (resolve(title) !== target.id) return []
  const key = normalizeWikiTitle(title)
  const eligible = new Map(pages.filter((page) => page.id !== target.id && !page.deletedAt && !isPrivate(page)).map((page) => [page.id, page]))
  const candidates = (await repository.searchWorkspaceCandidates(DEFAULT_WORKSPACE_ID, title, Math.max(50, eligible.size)))
    .filter((page) => eligible.has(page.id))
  const links: PageLink[] = []
  for (let offset = 0; offset < candidates.length; offset += 16) {
    if (signal?.aborted) return []
    const batch = candidates.slice(offset, offset + 16)
    const documents = await Promise.all(batch.map((page) => repository.getPageDocument(page.id)))
    batch.forEach((source, index) => {
      const markdown = documents[index]?.markdown
      if (!markdown) return
      const link = extractWikiLinks(markdown).find((candidate) => normalizeWikiTitle(candidate.title) === key)
      if (!link) return
      links.push({
        id: `markdown-title-link:${source.id}:${target.id}`,
        workspaceId: DEFAULT_WORKSPACE_ID,
        sourcePageId: source.id,
        targetPageId: target.id,
        kind: 'link',
        excerpt: wikiLinkContext(markdown, link),
        createdAt: documents[index]!.updatedAt,
      })
    })
  }
  return links
}

/**
 * After `pageId` was renamed from `oldTitle` to `newTitle`, rewrites every
 * `[[oldTitle]]` that pointed at it. Links are left alone when another page
 * still carries the old title (they keep resolving to that page).
 */
export async function planWikiLinkRename(repository: DexieNotebookRepository, oldTitle: string, newTitle: string, pagesAfterRename: Page[]): Promise<Array<{ page: Page; markdown: string; count: number }>> {
  if (!oldTitle.trim() || oldTitle.trim() === newTitle.trim()) return []
  if (wikiTitleResolver(pagesAfterRename)(oldTitle)) return []
  const documents: PageDocument[] = await repository.db.documents
    .filter((document) => typeof document.markdown === 'string' && document.markdown.includes('[['))
    .toArray()
  const pagesById = new Map(pagesAfterRename.map((page) => [page.id, page]))
  const plan: Array<{ page: Page; markdown: string; count: number }> = []
  for (const document of documents) {
    const page = pagesById.get(document.pageId)
    if (!page || page.deletedAt) continue
    const result = renameWikiLinks(document.markdown!, oldTitle, newTitle)
    if (result.count) plan.push({ page, markdown: result.markdown, count: result.count })
  }
  return plan
}
