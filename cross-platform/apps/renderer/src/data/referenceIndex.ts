import type { PageLink } from '@notebook/domain'
import { pageLinksFromNotebookMarkdown } from '@notebook/sync-contract'
import { DEFAULT_WORKSPACE_ID } from '../sync/syncSettings'

export function pageLinksFromMarkdown(pageId: string, markdown: string, createdAt: string): PageLink[] {
  return pageLinksFromNotebookMarkdown(pageId, DEFAULT_WORKSPACE_ID, markdown, createdAt)
}
