import type { Asset, Page, PageDocument } from '@notebook/domain'
import { documentToMarkdown } from '../editor/extensions'
import { DexieNotebookRepository, NotebookRendererDatabase } from '@notebook/storage-renderer'
import { DEFAULT_WORKSPACE_ID } from '../sync/syncSettings'
import { repairDocumentStructure } from '@notebook/sync-contract'
import { parseMarkdownForEditor } from './markdownParser'
import { pageLinksFromMarkdown } from './referenceIndex'
import { wikiTitleResolver } from './wikiLinkMaintenance'
import { planNotebookPageRootMigration } from './notebookPageRoots'
import { recordDiagnosticEvent, rendererErrorDetails } from '../diagnostics/diagnostics'
import { planPagePrivacyNormalization } from './privacyPlacement'

/**
 * The renderer's single repository instance and the library-wide maintenance
 * it needs (page-root and privacy migrations, editor-cache restore, reference
 * index rebuild, per-page mutation queue). Shared by useWorkspaceData and its
 * sub-hooks.
 */
export const WORKSPACE_ID = DEFAULT_WORKSPACE_ID
// A fresh install opens on the bundled sample workspace so the first screen has
// content. These IDs seed the database below and are the single source of truth
// for the app shell's initial selection.
export const STARTUP_NOTEBOOK_ID = 'team'
export const STARTUP_SECTION_ID = 'product'
export const STARTUP_PAGE_ID = 'vision'
export const db = new NotebookRendererDatabase(import.meta.env.VITE_NOTEBOOK_DATABASE_NAME ?? 'notebook-next')
export const repository = new DexieNotebookRepository(db)
export const automationRepository = repository
const pageMutationQueues = new Map<string, Promise<unknown>>()
export const documentLoadPromises = new Map<string, Promise<Record<string, unknown> | undefined>>()
export const isEmptyEditorCache = (value: Record<string, unknown>) => value.type === 'doc' && Array.isArray(value.content) && value.content.length === 0
export const REFERENCE_INDEX_VERSION_KEY = 'notebook-reference-index-version'
export const emptyEditorDocument = () => ({ type: 'doc', content: [{ type: 'paragraph' }] })
let notebookRootMigration: Promise<void> | undefined
let pagePrivacyNormalization: Promise<void> | undefined
const documentFailureDiagnostics = new Map<string, number>()
export function recordDocumentFailure(action: 'autosave' | 'draft-stage', error: unknown, startedAt: number) {
  const now = Date.now()
  if (now - (documentFailureDiagnostics.get(action) ?? 0) < 30_000) return
  documentFailureDiagnostics.set(action, now)
  recordDiagnosticEvent({ level: 'error', category: 'page', action, status: 'failed', durationMs: now - startedAt, operationId: crypto.randomUUID(), ...rendererErrorDetails(error) })
}

export async function ensureNotebookPageRoots() {
  if (notebookRootMigration) return notebookRootMigration
  notebookRootMigration = (async () => {
    const notebooks = await repository.listNotebooks(WORKSPACE_ID)
    const sections = (await Promise.all(notebooks.map((notebook) => repository.listSections(notebook.id)))).flat()
    const pages: Page[] = []
    let cursor: string | undefined
    do {
      const batch = await repository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: true, limit: 500, cursor })
      pages.push(...batch.items)
      cursor = batch.nextCursor
    } while (cursor)
    const now = new Date().toISOString()
    const migration = planNotebookPageRootMigration(sections, pages, WORKSPACE_ID, now, () => crypto.randomUUID())
    for (const root of migration.roots) {
      await repository.savePage(root, {
        pageId: root.id,
        schemaVersion: 3,
        markdown: '',
        tiptapJson: emptyEditorDocument(),
        updatedAt: now,
      })
    }
    for (const page of migration.reparented) await repository.savePage(page)
  })().finally(() => { notebookRootMigration = undefined })
  return notebookRootMigration
}

export async function ensurePagePrivacyMatchesNotebook() {
  if (pagePrivacyNormalization) return pagePrivacyNormalization
  pagePrivacyNormalization = (async () => {
    const notebooks = await repository.listNotebooks(WORKSPACE_ID)
    const sections = (await Promise.all(notebooks.map((notebook) => repository.listSections(notebook.id)))).flat()
    const pages: Page[] = []
    let cursor: string | undefined
    do {
      const batch = await repository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: true, limit: 500, cursor })
      pages.push(...batch.items)
      cursor = batch.nextCursor
    } while (cursor)
    const changedAt = new Date().toISOString()
    const changed = planPagePrivacyNormalization(pages, sections, notebooks, changedAt)
    for (const page of changed) await repository.savePage(page)
    if (changed.length) recordDiagnosticEvent({ level: 'info', category: 'privacy', action: 'normalize-page-placement', status: 'success', message: `${changed.length} pages` })
  })().finally(() => { pagePrivacyNormalization = undefined })
  return pagePrivacyNormalization
}

export function editorCacheVersion(document: PageDocument, assets: Asset[]) {
  const assetVersion = assets
    .map((asset) => `${asset.id}:${asset.checksum}`)
    .sort()
    .join('|')
  return `${document.updatedAt}:${document.markdown?.length ?? 0}:${assetVersion}`
}

export async function editorDocumentFromStorage(document: PageDocument, assets: Asset[]) {
  // Stored documents and editor caches written before the empty-list-item
  // repair may still contain list items without children.
  if (document.markdown === undefined || !isEmptyEditorCache(document.tiptapJson)) return repairDocumentStructure(document.tiptapJson)
  const version = editorCacheVersion(document, assets)
  const cached = await repository.getEditorCache(document.pageId, version)
  if (cached) return repairDocumentStructure(cached)
  const parsed = await parseMarkdownForEditor(document.markdown, assets)
  void repository.saveEditorCache(document.pageId, version, parsed)
  return parsed
}

export async function rebuildReferenceIndex() {
  const pages = await repository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: false, limit: 10_000 })
  const resolveTitle = wikiTitleResolver(pages.items)
  for (const page of pages.items) {
    const document = await repository.getPageDocument(page.id)
    if (!document) continue
    const markdown = document.markdown ?? documentToMarkdown(document.tiptapJson)
    await repository.replaceDerivedPageLinks(page.id, pageLinksFromMarkdown(page.id, markdown, document.updatedAt, resolveTitle))
  }
}

export function enqueuePageMutation<T>(pageId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = pageMutationQueues.get(pageId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(mutation)
  pageMutationQueues.set(pageId, operation)
  return operation.finally(() => {
    if (pageMutationQueues.get(pageId) === operation) pageMutationQueues.delete(pageId)
  })
}


export function treePageIds(records: Page[], rootId: string) {
  const result: string[] = []
  const queue = [rootId]
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...records.filter((page) => page.parentPageId === id).map((page) => page.id))
  }
  return result
}
