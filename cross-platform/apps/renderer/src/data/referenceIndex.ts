import type { PageLink } from '@notebook/domain'
import { extractWikiLinks, pageLinksFromNotebookMarkdown, wikiLinkContext } from '@notebook/sync-contract'
import { DEFAULT_WORKSPACE_ID } from '../sync/syncSettings'

/** Maps a `[[title]]` to the page it currently resolves to. */
export type WikiTitleResolver = (title: string) => string | undefined

/**
 * Derived link index for one page: identity references (`[[page:id…]]`) and
 * title links (`[[title]]`) resolved against the current library. The index
 * is local and rebuildable; Markdown stays the only source of truth.
 */
export function pageLinksFromMarkdown(pageId: string, markdown: string, createdAt: string, resolveTitle?: WikiTitleResolver): PageLink[] {
  const links = pageLinksFromNotebookMarkdown(pageId, DEFAULT_WORKSPACE_ID, markdown, createdAt)
  if (!resolveTitle) return links
  const seen = new Set(links.filter((link) => link.kind === 'link' && !link.excerpt).map((link) => link.targetPageId))
  for (const wikiLink of extractWikiLinks(markdown)) {
    const targetPageId = resolveTitle(wikiLink.title)
    if (!targetPageId || targetPageId === pageId || seen.has(targetPageId)) continue
    seen.add(targetPageId)
    links.push({
      id: `markdown-title-link:${pageId}:${targetPageId}`,
      workspaceId: DEFAULT_WORKSPACE_ID,
      sourcePageId: pageId,
      targetPageId,
      kind: 'link',
      excerpt: wikiLinkContext(markdown, wikiLink),
      createdAt,
    })
  }
  return links
}
