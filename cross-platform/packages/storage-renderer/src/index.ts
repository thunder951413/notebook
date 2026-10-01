import type {
  AutomationProposal,
  Notebook,
  NotebookRepository,
  Page,
  PageDocument,
  PageListQuery,
  PageListResult,
  Section,
  Tag,
  TaskStep,
  UUID,
  PageLink,
  Asset,
  NotebookDataBundle,
  PageTag,
  ReadingPosition,
  Tombstone,
  PageRevision,
} from '@notebook/domain'
import { legacyTiptapToCanonicalMarkdown, markdownToEditorCache, tiptapToMarkdown } from '@notebook/sync-contract'
import { MAX_AUTOSAVE_REVISIONS_PER_PAGE, MAX_EDITOR_CACHE_BYTES, MAX_PINNED_REVISIONS_PER_PAGE, NotebookRendererDatabase, type SyncOutboxItem } from './database'
import { compactRevisionHistory, preserveChangesSinceSnapshot } from './rebase'
import { parseRemotePayload, remapAssetReferences, type RemoteApplyResult, type RemoteSyncChange } from './remotePayload'
import { normalizeSearch, SearchCache, searchWorkspaceCandidatesWith, searchWorkspaceWith } from './search'

export type { RemoteSyncChange, RemoteApplyResult } from './remotePayload'
export type { SyncOutboxItem } from './database'
export { NotebookRendererDatabase, MAX_AUTOSAVE_REVISIONS_PER_PAGE, MAX_EDITOR_CACHE_BYTES, MAX_PINNED_REVISIONS_PER_PAGE, MAX_REVISIONS_PER_PAGE } from './database'
export { preserveChangesSinceSnapshot } from './rebase'

function boundRevisionHistory(revisions: PageRevision[]): PageRevision[] {
  const grouped = new Map<string, PageRevision[]>()
  for (const revision of revisions) {
    const values = grouped.get(revision.pageId) ?? []
    values.push(revision)
    grouped.set(revision.pageId, values)
  }
  return [...grouped.values()].flatMap((values) => {
    values.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    return [
      ...values.filter((revision) => revision.reason === 'autosave').slice(0, MAX_AUTOSAVE_REVISIONS_PER_PAGE),
      ...values.filter((revision) => revision.reason !== 'autosave').slice(0, MAX_PINNED_REVISIONS_PER_PAGE),
    ]
  })
}

export class DexieNotebookRepository implements NotebookRepository {
  private readonly searchIndex = new SearchCache()

  constructor(readonly db = new NotebookRendererDatabase()) {}

  async listNotebooks(workspaceId: UUID): Promise<Notebook[]> {
    return (await this.db.notebooks.where('workspaceId').equals(workspaceId).toArray())
      .filter((item) => !item.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  }

  async listSections(notebookId: UUID): Promise<Section[]> {
    return (await this.db.sections.where('notebookId').equals(notebookId).toArray())
      .filter((item) => !item.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  }

  async listPages(query: PageListQuery): Promise<PageListResult> {
    let items = query.sectionId
      ? await this.db.pages.where('sectionId').equals(query.sectionId).toArray()
      : await this.db.pages.where('workspaceId').equals(query.workspaceId).toArray()
    // sectionId is globally unique by contract, but retain an explicit
    // workspace boundary so malformed imports cannot leak pages across stores.
    items = items.filter((item) => item.workspaceId === query.workspaceId)
    if (!query.includeDeleted) items = items.filter((item) => !item.deletedAt)
    if (query.kind) items = items.filter((item) => item.kind === query.kind)
    const search = normalizeSearch(query.search ?? '')
    if (search) items = items.filter((item) => `${item.title}\n${item.preview}`.toLocaleLowerCase().includes(search))
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500))
    const page = items.slice(safeOffset, safeOffset + limit)
    return { items: page, nextCursor: safeOffset + limit < items.length ? String(safeOffset + limit) : undefined }
  }

  getPage(id: UUID) { return this.db.pages.get(id) }
  getPageDocument(pageId: UUID) { return this.db.documents.get(pageId) }
  async getEditorCache(pageId: UUID, sourceVersion: string) {
    const cached = await this.db.editorCaches.get(pageId)
    if (!cached) return undefined
    if (cached.sourceVersion !== sourceVersion) {
      await this.db.editorCaches.delete(pageId)
      return undefined
    }
    void this.db.editorCaches.update(pageId, { accessedAt: new Date().toISOString() })
    return cached.tiptapJson
  }
  async saveEditorCache(pageId: UUID, sourceVersion: string, tiptapJson: Record<string, unknown>) {
    const byteSize = new Blob([JSON.stringify(tiptapJson)]).size
    await this.db.editorCaches.put({ pageId, sourceVersion, tiptapJson, byteSize, accessedAt: new Date().toISOString() })
    const records = await this.db.editorCaches.orderBy('accessedAt').toArray()
    let total = records.reduce((sum, item) => sum + item.byteSize, 0)
    const expired: string[] = []
    for (const item of records) {
      if (total <= MAX_EDITOR_CACHE_BYTES) break
      expired.push(item.pageId)
      total -= item.byteSize
    }
    if (expired.length) await this.db.editorCaches.bulkDelete(expired)
  }
  async saveNotebook(notebook: Notebook) {
    await this.db.transaction('rw', [this.db.notebooks, this.db.syncOutbox, this.db.syncVersions], async () => {
      await this.db.notebooks.put(notebook)
      await this.enqueueChange(notebook.workspaceId, 'notebook', notebook.id, 'upsert', { ...notebook })
    })
  }
  async deleteNotebook(notebookId: string, deletedAt: string, deviceId: string) {
    let workspaceId: string | undefined
    await this.db.transaction('rw', this.db.tables, async () => {
      const notebook = await this.db.notebooks.get(notebookId)
      if (!notebook) return
      workspaceId = notebook.workspaceId
      const sections = await this.db.sections.where('notebookId').equals(notebookId).toArray()
      const sectionIds = sections.map((section) => section.id)
      const pages = sectionIds.length ? await this.db.pages.where('sectionId').anyOf(sectionIds).toArray() : []
      for (const page of pages) await this.purgePage(page.id, deletedAt, deviceId)
      for (const section of sections) await this.deleteSection(section.id, deletedAt, deviceId)
      await this.db.notebooks.delete(notebookId)
      await this.enqueueChange(notebook.workspaceId, 'notebook', notebookId, 'delete', { locked: Boolean(notebook.locked) })
    })
    if (workspaceId) this.searchIndex.invalidate(workspaceId)
  }
  async saveSection(section: Section) {
    await this.db.transaction('rw', [this.db.notebooks, this.db.sections, this.db.syncOutbox, this.db.syncVersions], async () => {
      const notebook = await this.db.notebooks.get(section.notebookId)
      if (!notebook) throw new Error(`Notebook not found: ${section.notebookId}`)
      await this.db.sections.put(section)
      await this.enqueueChange(notebook.workspaceId, 'section', section.id, 'upsert', { ...section })
    })
  }
  async deleteSection(sectionId: UUID, deletedAt: string, deviceId: string) {
    let workspaceId: string | undefined
    await this.db.transaction('rw', this.db.tables, async () => {
      const section = await this.db.sections.get(sectionId)
      if (!section) return
      const notebook = await this.db.notebooks.get(section.notebookId)
      if (!notebook) throw new Error(`Notebook not found: ${section.notebookId}`)
      workspaceId = notebook.workspaceId
      const pages = await this.db.pages.where('sectionId').equals(sectionId).toArray()
      for (const page of pages) await this.purgePage(page.id, deletedAt, deviceId)
      if (await this.db.pages.where('sectionId').equals(sectionId).count()) throw new Error('分区内容正在变化，请重试删除')
      const tombstone: Tombstone = { id: `section:${sectionId}`, workspaceId: notebook.workspaceId, entityType: 'section', entityId: sectionId, deletedAt, deviceId }
      await this.db.sections.delete(sectionId)
      await this.db.tombstones.put(tombstone)
      await this.enqueueChange(notebook.workspaceId, 'section', sectionId, 'delete', { notebookId: notebook.id, locked: Boolean(notebook.locked) })
    })
    if (workspaceId) this.searchIndex.invalidate(workspaceId)
  }

  async duplicatePage(pageId: UUID, newPageId: UUID, createdAt: string): Promise<Page> {
    return this.db.transaction('rw', this.db.tables, async () => {
      const source = await this.db.pages.get(pageId)
      if (!source || source.deletedAt) throw new Error('找不到要复制的页面')
      const [document, pageTags, taskSteps, assets] = await Promise.all([
        this.db.documents.get(pageId),
        this.db.pageTags.where('pageId').equals(pageId).toArray(),
        this.db.taskSteps.where('pageId').equals(pageId).toArray(),
        this.db.assets.where('pageId').equals(pageId).toArray(),
      ])
      const assetIds = new Map(assets.map((asset) => [asset.id, crypto.randomUUID()]))
      const copy: Page = {
        ...source,
        id: newPageId,
        title: `${source.title} 副本`,
        sortOrder: (source.sortOrder ?? 0) + 1,
        treeUpdatedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
        deletedAt: undefined,
        legacyVersion: undefined,
        syncStatus: 'pending',
      }
      const copiedDocument = document ? {
        ...document,
        pageId: newPageId,
        tiptapJson: remapAssetReferences(document.tiptapJson, assetIds) as Record<string, unknown>,
        updatedAt: createdAt,
      } : undefined
      await this.savePage(copy, copiedDocument)
      if (pageTags.length) await this.savePageTags(newPageId, pageTags.map((item) => item.tagId))
      if (taskSteps.length) await this.saveTaskSteps(newPageId, taskSteps.map((step) => ({ ...step, id: crypto.randomUUID(), pageId: newPageId, createdAt })))
      for (const asset of assets) {
        const id = assetIds.get(asset.id)!
        const copiedAsset: Asset = { ...asset, id, pageId: newPageId, parentAssetId: asset.parentAssetId ? assetIds.get(asset.parentAssetId) : undefined, createdAt }
        const content = await this.getAssetContent(asset.id)
        if (content) await this.saveAsset(copiedAsset, content)
        else {
          await this.db.assets.put(copiedAsset)
          await this.enqueueChange(copy.workspaceId, 'asset', id, 'upsert', { ...copiedAsset, localPath: undefined })
        }
      }
      return copy
    })
  }
  listPageTags(pageId: UUID) { return this.db.pageTags.where('pageId').equals(pageId).toArray() }
  getReadingPosition(pageId: UUID) { return this.db.readingPositions.where('pageId').equals(pageId).first() }
  async saveReadingPosition(position: ReadingPosition) {
    await this.db.transaction('rw', [this.db.pages, this.db.readingPositions, this.db.syncOutbox, this.db.syncVersions], async () => {
      const page = await this.db.pages.get(position.pageId)
      if (!page || page.deletedAt) return
      const previous = await this.db.readingPositions.get(position.id)
      if (previous?.pageId === position.pageId && previous.anchorUtf16Offset === position.anchorUtf16Offset
        && previous.viewportOffsetFraction === position.viewportOffsetFraction && previous.deviceId === position.deviceId) return
      await this.db.readingPositions.put(position)
      await this.enqueueChange(page.workspaceId, 'reading_position', position.id, 'upsert', { ...position })
    })
  }
  async savePageTags(pageId: UUID, tagIds: UUID[]) {
    const next = [...new Set(tagIds)].map((tagId) => ({ pageId, tagId }))
    await this.db.transaction('rw', this.db.tables, async () => {
      const page = await this.db.pages.get(pageId)
      if (!page) throw new Error(`Page not found: ${pageId}`)
      const previous = await this.db.pageTags.where('pageId').equals(pageId).toArray()
      const previousIds = new Set(previous.map((item) => item.tagId))
      if (next.length === previous.length && next.every((item) => previousIds.has(item.tagId))) return
      await this.db.pageTags.where('pageId').equals(pageId).delete()
      await this.db.pageTags.bulkPut(next)
      const nextIds = new Set(tagIds)
      for (const value of previous.filter((item) => !nextIds.has(item.tagId))) await this.enqueueChange(page.workspaceId, 'page_tag', `${pageId}:${value.tagId}`, 'delete', {})
      for (const value of next.filter((item) => !previousIds.has(item.tagId))) await this.enqueueChange(page.workspaceId, 'page_tag', `${pageId}:${value.tagId}`, 'upsert', value)
    })
  }

  async savePage(page: Page, document?: PageDocument): Promise<void> {
    await this.db.transaction('rw', this.db.tables, async () => {
      const previousPage = await this.db.pages.get(page.id)
      const previousDocument = document ? await this.db.documents.get(page.id) : undefined
      // Editor lifecycle flushes also run when nothing was typed. Do not
      // manufacture a document/page update merely because the flush supplies
      // a new timestamp; retain the durable saved version and pending state.
      if (page.syncStatus === 'pending' && document && previousPage && previousDocument
        && this.sameRemoteEntity({ ...previousPage, updatedAt: page.updatedAt }, page)
        && this.sameRemoteEntity({ ...previousDocument, updatedAt: document.updatedAt }, document)) {
        if (document.pageId !== page.id) throw new Error('Document pageId must match page id')
        const draft = await this.db.drafts.get(page.id)
        if (draft && draft.document.updatedAt <= document.updatedAt) await this.db.drafts.delete(page.id)
        return
      }
      await this.db.pages.put(page)
      if (document) {
        if (document.pageId !== page.id) throw new Error('Document pageId must match page id')
        const existing = previousDocument
        const existingMarkdown = existing?.markdown ?? (existing ? legacyTiptapToCanonicalMarkdown(existing.tiptapJson) : undefined)
        const nextMarkdown = document.markdown ?? legacyTiptapToCanonicalMarkdown(document.tiptapJson)
        if (existing && existingMarkdown !== nextMarkdown) {
          const revision: PageRevision = {
            id: crypto.randomUUID(),
            pageId: page.id,
            pageIcon: page.icon ?? null,
            document: { ...existing, markdown: existing.markdown ?? legacyTiptapToCanonicalMarkdown(existing.tiptapJson), tiptapJson: { type: 'doc', content: [] }, yjsState: undefined },
            createdAt: document.updatedAt,
            reason: 'autosave',
          }
          await this.db.revisions.put(revision)
          if (page.syncStatus === 'pending') {
            await this.coalescePendingAutosaveRevision(page.workspaceId, page.id)
            await this.enqueueChange(page.workspaceId, 'revision', revision.id, 'upsert', { ...revision, document: { ...revision.document, yjsState: undefined } })
          }
          await this.pruneRevisionRing(page.workspaceId, page.id)
        }
        await this.db.documents.put(document)
        const draft = await this.db.drafts.get(page.id)
        if (draft && draft.document.updatedAt <= document.updatedAt) await this.db.drafts.delete(page.id)
        if (page.syncStatus === 'pending') await this.enqueueChange(page.workspaceId, 'document', page.id, 'upsert', { ...document, yjsState: undefined })
      }
      if (page.syncStatus === 'pending') await this.enqueueChange(page.workspaceId, 'page', page.id, 'upsert', { ...page })
      if (page.syncStatus === 'pending' && page.locked && previousPage && !previousPage.locked) {
        await this.retractPublicPageForPrivacy(page.workspaceId, page.id)
      }
    })
    this.searchIndex.invalidate(page.workspaceId)
  }

  async stageDraft(document: PageDocument): Promise<void> {
    await this.db.drafts.put({ pageId: document.pageId, document, createdAt: new Date().toISOString() })
  }

  async recoverDrafts(): Promise<string[]> {
    const recovered: string[] = []
    for (const draft of await this.db.drafts.toArray()) {
      const [page, stored] = await Promise.all([this.db.pages.get(draft.pageId), this.db.documents.get(draft.pageId)])
      if (!page) { await this.db.drafts.delete(draft.pageId); continue }
      if (!stored || draft.document.updatedAt > stored.updatedAt) {
        await this.savePage({ ...page, updatedAt: draft.document.updatedAt, syncStatus: 'pending' }, draft.document)
        recovered.push(draft.pageId)
      } else await this.db.drafts.delete(draft.pageId)
    }
    return recovered
  }

  async movePageToTrash(pageId: UUID, deletedAt: string, deviceId = 'electron'): Promise<void> {
    const page = await this.db.pages.get(pageId)
    if (!page) throw new Error(`Page not found: ${pageId}`)
    const tombstone: Tombstone = { id: `page:${pageId}`, workspaceId: page.workspaceId, entityType: 'page', entityId: pageId, deletedAt, deviceId }
    await this.db.transaction('rw', this.db.pages, this.db.tombstones, this.db.syncOutbox, this.db.syncVersions, async () => {
      await this.db.pages.put({ ...page, deletedAt, syncStatus: 'pending', updatedAt: deletedAt })
      await this.db.tombstones.put(tombstone)
      await this.enqueueChange(page.workspaceId, 'page', pageId, 'delete', {})
    })
    this.searchIndex.invalidate(page.workspaceId)
  }

  async restorePage(pageId: UUID, restoredAt = new Date().toISOString()): Promise<void> {
    const page = await this.db.pages.get(pageId)
    if (!page) throw new Error(`Page not found: ${pageId}`)
    await this.db.transaction('rw', this.db.pages, this.db.tombstones, this.db.syncOutbox, this.db.syncVersions, async () => {
      const restored = { ...page, deletedAt: undefined, syncStatus: 'pending' as const, updatedAt: restoredAt }
      await this.db.pages.put(restored)
      await this.db.tombstones.delete(`page:${pageId}`)
      await this.enqueueChange(page.workspaceId, 'page', pageId, 'upsert', restored)
    })
    this.searchIndex.invalidate(page.workspaceId)
  }

  async purgePage(pageId: UUID, deletedAt = new Date().toISOString(), deviceId = 'electron'): Promise<void> {
    const page = await this.db.pages.get(pageId)
    if (!page) return
    const effectiveDeletedAt = page.deletedAt && page.deletedAt > deletedAt ? page.deletedAt : deletedAt
    const tombstone: Tombstone = { id: `page:${pageId}`, workspaceId: page.workspaceId, entityType: 'page', entityId: pageId, deletedAt: effectiveDeletedAt, deviceId }
    const steps = await this.db.taskSteps.where('pageId').equals(pageId).toArray()
    const assets = await this.db.assets.where('pageId').equals(pageId).toArray()
    const links = await this.db.pageLinks.where('sourcePageId').equals(pageId).toArray()
    await this.db.transaction('rw', this.db.tables, async () => {
      const localOnly = { pageId, locked: Boolean(page.locked) }
      for (const item of steps) await this.enqueueChange(page.workspaceId, 'task_step', item.id, 'delete', localOnly)
      for (const item of assets) await this.enqueueChange(page.workspaceId, 'asset', item.id, 'delete', localOnly)
      for (const item of links) await this.enqueueChange(page.workspaceId, 'page_link', item.id, 'delete', { ...localOnly, sourcePageId: pageId })
      await this.enqueueChange(page.workspaceId, 'document', pageId, 'delete', localOnly)
      await this.enqueueChange(page.workspaceId, 'page', pageId, 'delete', localOnly)
      await this.db.tombstones.put(tombstone)
      await Promise.all([
        this.db.pages.delete(pageId),
        this.db.documents.delete(pageId),
        this.db.taskSteps.where('pageId').equals(pageId).delete(),
        this.db.assets.where('pageId').equals(pageId).delete(),
        this.db.pageLinks.where('sourcePageId').equals(pageId).delete(),
        this.db.pageTags.where('pageId').equals(pageId).delete(),
        this.db.readingPositions.where('pageId').equals(pageId).delete(),
        this.db.revisions.where('pageId').equals(pageId).delete(),
        this.db.comments.where('pageId').equals(pageId).delete(),
        this.db.drafts.delete(pageId),
        this.db.editorCaches.delete(pageId),
      ])
      await this.db.assetContents.bulkDelete(assets.map((item) => item.id))
    })
    this.searchIndex.invalidate(page.workspaceId)
  }

  async listTags(workspaceId: UUID): Promise<Tag[]> {
    return (await this.db.tags.where('workspaceId').equals(workspaceId).toArray())
      .filter((item) => !item.deletedAt)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async listTaskSteps(pageId: UUID): Promise<TaskStep[]> {
    return (await this.db.taskSteps.where('pageId').equals(pageId).toArray())
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  }

  async saveTaskSteps(pageId: UUID, steps: TaskStep[]): Promise<void> {
    if (steps.some((step) => step.pageId !== pageId)) throw new Error('All task steps must belong to the requested page')
    await this.db.transaction('rw', [this.db.pages, this.db.taskSteps, this.db.syncOutbox, this.db.syncVersions], async () => {
      const page = await this.db.pages.get(pageId)
      if (!page) throw new Error(`Page not found: ${pageId}`)
      const previous = await this.db.taskSteps.where('pageId').equals(pageId).toArray()
      const previousById = new Map(previous.map((step) => [step.id, step]))
      const changed = steps.filter((step) => !this.sameRemoteEntity(previousById.get(step.id), step))
      if (changed.length === 0 && previous.length === steps.length) return
      await this.db.taskSteps.where('pageId').equals(pageId).delete()
      await this.db.taskSteps.bulkPut(steps)
      const nextIds = new Set(steps.map((step) => step.id))
      for (const removed of previous.filter((step) => !nextIds.has(step.id))) await this.enqueueChange(page.workspaceId, 'task_step', removed.id, 'delete', { ...removed })
      for (const step of changed) await this.enqueueChange(page.workspaceId, 'task_step', step.id, 'upsert', { ...step })
    })
  }

  private versionId(workspaceId: string, entityType: string, entityId: string) { return `${workspaceId}:${entityType}:${entityId}` }

  private async pruneRevisionRing(workspaceId: string, pageId: string): Promise<void> {
    const revisions = await this.db.revisions.where('pageId').equals(pageId).toArray()
    revisions.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    const staleIds = [
      ...revisions.filter((revision) => revision.reason === 'autosave').slice(MAX_AUTOSAVE_REVISIONS_PER_PAGE),
      ...revisions.filter((revision) => revision.reason !== 'autosave').slice(MAX_PINNED_REVISIONS_PER_PAGE),
    ].map((revision) => revision.id)
    if (!staleIds.length) return
    const stale = new Set(staleIds)
    const staleOutboxIds = (await this.db.syncOutbox.where('workspaceId').equals(workspaceId).toArray())
      .filter((item) => item.entityType === 'revision' && stale.has(item.entityId))
      .map((item) => item.id)
    await this.db.revisions.bulkDelete(staleIds)
    if (staleOutboxIds.length) await this.db.syncOutbox.bulkDelete(staleOutboxIds)
  }

  /** Keep local history rich while publishing at most one pending autosave per page. */
  private async coalescePendingAutosaveRevision(workspaceId: string, pageId: string): Promise<void> {
    const staleOutboxIds = (await this.db.syncOutbox.where('workspaceId').equals(workspaceId).toArray())
      .filter((item) => item.entityType === 'revision' && item.operation === 'upsert' && item.payload.reason === 'autosave' && item.payload.pageId === pageId)
      .map((item) => item.id)
    if (staleOutboxIds.length) await this.db.syncOutbox.bulkDelete(staleOutboxIds)
  }

  async enqueueChange(workspaceId: string, entityType: string, entityId: string, operation: 'upsert' | 'delete', payload: Record<string, unknown>): Promise<void> {
    const version = await this.db.syncVersions.get(this.versionId(workspaceId, entityType, entityId))
    const existing = await this.db.syncOutbox.where('[entityType+entityId]').equals([entityType, entityId]).and((item) => item.workspaceId === workspaceId).first()
    // A privacy retraction must reach the remote journal even when later local
    // edits keep changing the now-private entity. Those later edits are local
    // only, so replacing the delete here would leak the old remote copy.
    if (existing?.payload.privacyRetraction === true && payload.privacyRetraction !== true) return
    // Preserve the operation id for an identical save. A real edit must still
    // receive a new id so an in-flight acknowledgement cannot delete it.
    if (existing?.operation === operation && existing.expectedVersion === (version?.version ?? 0)
      && this.sameRemoteEntity(existing.payload, payload)) return
    // Keep only the latest unsent mutation for an entity. Multiple autosaves made
    // before a sync tick share the same expected version and would otherwise
    // conflict with each other after the first mutation is accepted remotely.
    await this.db.syncOutbox.where('[entityType+entityId]').equals([entityType, entityId]).and((item) => item.workspaceId === workspaceId).delete()
    await this.db.syncOutbox.put({ id: crypto.randomUUID(), workspaceId, entityType, entityId, expectedVersion: version?.version ?? 0, operation, payload, createdAt: new Date().toISOString() })
  }

  listOutbox(workspaceId: string, limit = 200) { return this.db.syncOutbox.where('workspaceId').equals(workspaceId).limit(limit).toArray() }
  async hasPendingSyncChanges(workspaceId: string) { return Boolean(await this.db.syncOutbox.where('workspaceId').equals(workspaceId).first()) }
  getSyncCursor(workspaceId: string) { return this.db.syncCursors.get(workspaceId).then((value) => value?.cursor ?? 0) }

  /** Private entities use encrypted publication when a sync key is configured;
   * otherwise the transport keeps them local. */
  async isPrivateSyncItem(item: SyncOutboxItem): Promise<boolean> {
    // A privacy retraction is deliberately public: it deletes the previous
    // remote representation before later private edits are encrypted.
    if (item.payload.privacyRetraction === true) return false
    if (item.payload.locked === true) return true
    if (item.entityType === 'page_link' && typeof item.payload.targetPageId === 'string' && await this.isPrivatePage(item.payload.targetPageId)) return true
    if (item.entityType === 'notebook') return Boolean((await this.db.notebooks.get(item.entityId))?.locked)
    if (item.entityType === 'section') {
      const section = await this.db.sections.get(item.entityId)
      const notebookId = typeof item.payload.notebookId === 'string' ? item.payload.notebookId : section?.notebookId
      return notebookId ? Boolean((await this.db.notebooks.get(notebookId))?.locked) : false
    }
    const payloadPageId = typeof item.payload.pageId === 'string' ? item.payload.pageId : undefined
    const sourcePageId = typeof item.payload.sourcePageId === 'string' ? item.payload.sourcePageId : undefined
    const pageId = item.entityType === 'page' || item.entityType === 'document'
      ? item.entityId
      : payloadPageId ?? sourcePageId ?? (item.entityType === 'page_tag' ? item.entityId.split(':')[0] : undefined)
    return pageId ? this.isPrivatePage(pageId) : false
  }

  private async isPrivatePage(pageId: string): Promise<boolean> {
    const page = await this.db.pages.get(pageId)
    if (!page) return false
    if (page.locked) return true
    if (!page.sectionId) return false
    const section = await this.db.sections.get(page.sectionId)
    return Boolean(section && (await this.db.notebooks.get(section.notebookId))?.locked)
  }

  async acknowledgeLocalOnlySync(items: SyncOutboxItem[]): Promise<void> {
    if (!items.length) return
    await this.db.transaction('rw', [this.db.syncOutbox, this.db.pages], async () => {
      await this.db.syncOutbox.bulkDelete(items.map((item) => item.id))
      const pageIds = items.filter((item) => item.entityType === 'page').map((item) => item.entityId)
      if (pageIds.length) await this.db.pages.where('id').anyOf(pageIds).modify({ syncStatus: 'synced' })
    })
  }

  async acknowledgeSync(workspaceId: string, applied: Array<{ operation_id: string; entity_type: string; entity_id: string; version: number }>, cursor?: number, webdavParentVersion = false, republishPrivacyRetractions = false) {
    const tables = republishPrivacyRetractions ? this.db.tables : [this.db.syncOutbox, this.db.syncVersions, this.db.syncCursors, this.db.pages]
    await this.db.transaction('rw', tables, async () => {
      for (const item of applied) {
        const retraction = republishPrivacyRetractions ? await this.db.syncOutbox.get(item.operation_id) : undefined
        await this.db.syncOutbox.delete(item.operation_id)
        await this.db.syncVersions.put({
          id: this.versionId(workspaceId, item.entity_type, item.entity_id),
          version: item.version,
          ...(webdavParentVersion ? { webdavParentVersion: true as const } : {}),
        })
        const newer = await this.db.syncOutbox.where('[entityType+entityId]').equals([item.entity_type, item.entity_id])
          .and((pending) => pending.workspaceId === workspaceId).first()
        // A save while the old snapshot was uploading is its successor, not
        // a competing branch. Only rebase the exact acknowledged parent.
        if (webdavParentVersion && newer?.expectedVersion === item.version - 1) {
          await this.db.syncOutbox.update(newer.id, { expectedVersion: item.version })
        }
        if (item.entity_type === 'page') await this.db.pages.update(item.entity_id, { syncStatus: newer ? 'pending' : 'synced' })
        // An encrypted library must publish the current private state after
        // retracting its old public representation. Queue it in this same
        // transaction so a crash cannot strand edits made during retraction.
        if (retraction?.payload.privacyRetraction === true) {
          const current = await this.currentRemoteEntity({ cursor: 0, entityType: item.entity_type, entityId: item.entity_id, version: item.version, operation: 'upsert', payload: {} })
          if (current) {
            await this.enqueueChange(workspaceId, item.entity_type, item.entity_id, 'upsert', current)
            if (item.entity_type === 'page') await this.db.pages.update(item.entity_id, { syncStatus: 'pending' })
          }
        }
      }
      if (cursor !== undefined) await this.db.syncCursors.put({ workspaceId, cursor })
    })
  }

  async markSyncConflicts(entityIds: string[]) {
    await this.db.pages.where('id').anyOf(entityIds).modify({ syncStatus: 'conflict' })
  }

  private async conflictPageIds(change: RemoteSyncChange, payload?: Record<string, unknown>) {
    if (change.entityType === 'page' || change.entityType === 'document') return [change.entityId]
    const directPageId = typeof payload?.pageId === 'string' ? payload.pageId : undefined
    if (directPageId) return [directPageId]
    if (change.entityType === 'page_link') {
      const link = payload ?? await this.db.pageLinks.get(change.entityId)
      return typeof link?.sourcePageId === 'string' ? [link.sourcePageId] : []
    }
    if (change.entityType === 'page_tag') {
      const pageId = typeof payload?.pageId === 'string' ? payload.pageId : change.entityId.split(':')[0]
      return pageId ? [pageId] : []
    }
    if (change.entityType === 'task_step') {
      const step = await this.db.taskSteps.get(change.entityId)
      return step ? [step.pageId] : []
    }
    if (change.entityType === 'asset') {
      const asset = await this.db.assets.get(change.entityId)
      return asset ? [asset.pageId] : []
    }
    if (change.entityType === 'reading_position') {
      const position = await this.db.readingPositions.get(change.entityId)
      return position ? [position.pageId] : []
    }
    if (change.entityType === 'revision') {
      const revision = await this.db.revisions.get(change.entityId)
      return revision ? [revision.pageId] : []
    }
    if (change.entityType === 'tag') {
      return [...new Set((await this.db.pageTags.where('tagId').equals(change.entityId).toArray()).map((item) => item.pageId))]
    }
    if (change.entityType === 'section') {
      return (await this.db.pages.where('sectionId').equals(change.entityId).toArray()).map((page) => page.id)
    }
    if (change.entityType === 'notebook') {
      const sectionIds = (await this.db.sections.where('notebookId').equals(change.entityId).toArray()).map((section) => section.id)
      return sectionIds.length ? (await this.db.pages.where('sectionId').anyOf(sectionIds).toArray()).map((page) => page.id) : []
    }
    return []
  }

  private async currentRemoteEntity(change: RemoteSyncChange): Promise<Record<string, unknown> | undefined> {
    if (change.entityType === 'page') return await this.db.pages.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'document') return await this.db.documents.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'notebook') return await this.db.notebooks.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'section') return await this.db.sections.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'tag') return await this.db.tags.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'task_step') return await this.db.taskSteps.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'asset') return await this.db.assets.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'page_link') return await this.db.pageLinks.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'reading_position') return await this.db.readingPositions.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'revision') return await this.db.revisions.get(change.entityId) as Record<string, unknown> | undefined
    if (change.entityType === 'page_tag') {
      const [pageId, tagId] = change.entityId.split(':')
      return pageId && tagId ? await this.db.pageTags.where('[pageId+tagId]').equals([pageId, tagId]).first() as Record<string, unknown> | undefined : undefined
    }
    return undefined
  }

  private sameRemoteEntity(left: object | undefined, right: object | undefined): boolean {
    if (!left || !right) return false
    const normalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalize)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .filter(([key, item]) => key !== 'syncStatus' && key !== 'localPath' && item !== undefined)
          .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
          .map(([key, item]) => [key, normalize(item)]))
      }
      return value
    }
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
  }

  private async queuePrivacyRetractionIfPublished(workspaceId: string, entityType: string, entityId: string) {
    if (!await this.db.syncVersions.get(this.versionId(workspaceId, entityType, entityId))) return
    await this.enqueueChange(workspaceId, entityType, entityId, 'delete', { privacyRetraction: true })
  }

  private async retractPublicPageForPrivacy(workspaceId: string, pageId: string) {
    await this.queuePrivacyRetractionIfPublished(workspaceId, 'page', pageId)
    await this.queuePrivacyRetractionIfPublished(workspaceId, 'document', pageId)
    const [steps, assets, positions, revisions, pageTags, sourceLinks, targetLinks] = await Promise.all([
      this.db.taskSteps.where('pageId').equals(pageId).toArray(),
      this.db.assets.where('pageId').equals(pageId).toArray(),
      this.db.readingPositions.where('pageId').equals(pageId).toArray(),
      this.db.revisions.where('pageId').equals(pageId).toArray(),
      this.db.pageTags.where('pageId').equals(pageId).toArray(),
      this.db.pageLinks.where('sourcePageId').equals(pageId).toArray(),
      this.db.pageLinks.where('targetPageId').equals(pageId).toArray(),
    ])
    for (const item of steps) await this.queuePrivacyRetractionIfPublished(workspaceId, 'task_step', item.id)
    for (const item of assets) await this.queuePrivacyRetractionIfPublished(workspaceId, 'asset', item.id)
    for (const item of positions) await this.queuePrivacyRetractionIfPublished(workspaceId, 'reading_position', item.id)
    for (const item of revisions) await this.queuePrivacyRetractionIfPublished(workspaceId, 'revision', item.id)
    for (const item of pageTags) await this.queuePrivacyRetractionIfPublished(workspaceId, 'page_tag', `${item.pageId}:${item.tagId}`)
    for (const item of new Map([...sourceLinks, ...targetLinks].map((link) => [link.id, link])).values()) await this.queuePrivacyRetractionIfPublished(workspaceId, 'page_link', item.id)
  }

  async applyRemoteChanges(workspaceId: string, changes: RemoteSyncChange[], cursor: number, assetContents?: Map<string, Uint8Array>, webdavParentVersion = false, keepLocal = false): Promise<RemoteApplyResult> {
    if (keepLocal && !webdavParentVersion) throw new Error('Local conflict recovery is only supported for WebDAV')
    return this.db.transaction('rw', this.db.tables, async () => {
      const previousCursor = await this.getSyncCursor(workspaceId)
      let appliedCursor = cursor
      const conflicts: RemoteApplyResult['conflicts'] = []
      for (const change of changes) {
        const supportedEntityTypes = new Set(['notebook', 'section', 'page', 'document', 'tag', 'task_step', 'asset', 'page_link', 'reading_position', 'revision', 'page_tag'])
        if (!supportedEntityTypes.has(change.entityType) || !Number.isSafeInteger(change.version) || change.version < 0 || !['upsert', 'delete'].includes(change.operation)) {
          throw new Error(`Invalid remote change for ${change.entityType}:${change.entityId}`)
        }
        const payload = change.operation === 'upsert' ? parseRemotePayload(change) : undefined
        if (payload && typeof payload.workspaceId === 'string' && payload.workspaceId !== workspaceId) {
          throw new Error(`Remote ${change.entityType} belongs to another workspace`)
        }
        const pageIds = await this.conflictPageIds(change, payload)
        // Once local data has moved into a private notebook, remote history is
        // never allowed to make it public again. Consume the stale entry but
        // retain the local private state; the explicit retraction is queued
        // separately while the page is still public.
        let privatePage = false
        for (const pageId of pageIds) {
          if (await this.isPrivatePage(pageId)) { privatePage = true; break }
        }
        if (privatePage && !change.authenticatedPrivate) continue
        const pendingExact = await this.db.syncOutbox.where('[entityType+entityId]').equals([change.entityType, change.entityId]).and((item) => item.workspaceId === workspaceId).first()
        const pendingPage = change.entityType === 'document'
          ? await this.db.syncOutbox.where('[entityType+entityId]').equals(['page', change.entityId]).and((item) => item.workspaceId === workspaceId).first()
          : undefined
        const pending = pendingExact ?? pendingPage
        const current = await this.currentRemoteEntity(change)
        const localVersion = await this.db.syncVersions.get(this.versionId(workspaceId, change.entityType, change.entityId))
        // Explicit, one-shot user choice, never the automatic merge policy.
        // Keep the current record (not a stale outbox payload), and publish it
        // as a successor of every observed remote branch. Queue + baseline +
        // cursor are atomic: failed uploads remain durable pending work.
        // Unknown remote entities still flow through the normal import path.
        if (keepLocal && (current || pendingExact || localVersion)) {
          const version = Math.max(localVersion?.version ?? 0, pendingExact?.expectedVersion ?? 0, change.version + 1)
          await this.db.syncVersions.put({ id: this.versionId(workspaceId, change.entityType, change.entityId), version, webdavParentVersion: true })
          const operation = pendingExact?.operation === 'delete' || !current ? 'delete' : 'upsert'
          const equivalent = operation === change.operation && (operation === 'delete' || this.sameRemoteEntity(current, payload))
          if (pendingExact || !equivalent) {
            await this.enqueueChange(workspaceId, change.entityType, change.entityId, operation,
              operation === 'delete' ? pendingExact?.payload ?? {} : current!)
            if (pageIds.length) await this.db.pages.where('id').anyOf(pageIds).modify({ syncStatus: 'pending' })
          } else if (change.entityType === 'page') {
            await this.db.pages.update(change.entityId, { syncStatus: 'synced' })
          }
          continue
        }
        const equivalentPending = pending && change.version === pending.expectedVersion && change.operation === pending.operation && (
          change.operation === 'delete' || this.sameRemoteEntity(current ?? pending.payload, payload ?? pending.payload)
        )
        if (equivalentPending) {
          await this.db.syncOutbox.delete(pending.id)
          if (change.entityType === 'page') await this.db.pages.update(change.entityId, { syncStatus: 'synced' })
        } else if (pending) {
          if (pageIds.length) await this.db.pages.where('id').anyOf(pageIds).modify({ syncStatus: 'conflict' })
          conflicts.push({ entityType: change.entityType, entityId: change.entityId, pageIds })
          // The skipped change must remain pullable. Stop at the first conflict
          // and retain the cursor immediately before it instead of silently
          // acknowledging data that was never applied.
          appliedCursor = Math.max(previousCursor, change.cursor - 1)
          break
        }
        const compatibleLegacyAdvance = webdavParentVersion
          && localVersion !== undefined
          && localVersion.webdavParentVersion !== true
          && change.version === localVersion.version + 1
        // Compacted journals retain old peer snapshots alongside successors.
        // A clean replica consumes ancestors and may jump across remote-only
        // versions. Equal-parent siblings still require conflict resolution.
        if (webdavParentVersion && localVersion && !pending && change.version + 1 < localVersion.version) continue
        const compactedAdvance = webdavParentVersion && !pending && localVersion !== undefined && change.version > localVersion.version
        if (webdavParentVersion && localVersion && change.version !== localVersion.version && !compatibleLegacyAdvance && !compactedAdvance) {
          // Older clients stored a received journal's parent version rather
          // than its resulting version. An identical stale entry is harmless;
          // any different payload is a real concurrent update and must never
          // silently overwrite current data.
          const duplicate = change.operation === 'upsert'
            ? this.sameRemoteEntity(current, payload)
            : current === undefined
          // Legacy bootstrap journals omitted optional metadata properties
          // (such as color and page placement) and could synthesize createdAt during import. A
          // replay of that initial snapshot is not a concurrent rename/move.
          // Keep the richer local record only when every supplied mutable
          // field, including updatedAt, still matches. Pending writes have
          // already been handled above; modern siblings keep strict checks.
          const legacyMetadataSnapshot = localVersion.webdavParentVersion !== true
            && localVersion.version === 1 && change.version === 0
            && ['section', 'notebook', 'page'].includes(change.entityType)
            && change.operation === 'upsert' && current !== undefined && payload !== undefined
            && this.sameRemoteEntity(current, { ...current, ...payload, createdAt: current.createdAt })
          const legacyDocumentSnapshot = localVersion.webdavParentVersion !== true
            && localVersion.version === 1 && change.version === 0
            && change.entityType === 'document' && change.operation === 'upsert'
            && current !== undefined && payload !== undefined
            && Number(payload.schemaVersion) < 3 && typeof current.markdown === 'string'
            && current.markdown === legacyTiptapToCanonicalMarkdown(payload.tiptapJson as Record<string, unknown>)
          if ((duplicate || legacyMetadataSnapshot || legacyDocumentSnapshot) && change.version < localVersion.version) {
            // This document was previously flagged only because its imported
            // rich-text representation differed from the migrated Markdown.
            if (legacyDocumentSnapshot) await this.db.pages.update(change.entityId, { syncStatus: 'synced' })
            continue
          }
          if (pageIds.length) await this.db.pages.where('id').anyOf(pageIds).modify({ syncStatus: 'conflict' })
          conflicts.push({ entityType: change.entityType, entityId: change.entityId, pageIds })
          appliedCursor = Math.max(previousCursor, change.cursor - 1)
          break
        }
        if (change.operation === 'delete') {
          if (change.entityType === 'page') await this.db.pages.delete(change.entityId)
          else if (change.entityType === 'document') await this.db.documents.delete(change.entityId)
          else if (change.entityType === 'notebook') await this.db.notebooks.delete(change.entityId)
          else if (change.entityType === 'section') await this.db.sections.delete(change.entityId)
          else if (change.entityType === 'tag') await this.db.tags.delete(change.entityId)
          else if (change.entityType === 'task_step') await this.db.taskSteps.delete(change.entityId)
          else if (change.entityType === 'asset') { await this.db.assets.delete(change.entityId); await this.db.assetContents.delete(change.entityId) }
          else if (change.entityType === 'page_link') await this.db.pageLinks.delete(change.entityId)
          else if (change.entityType === 'reading_position') await this.db.readingPositions.delete(change.entityId)
          else if (change.entityType === 'revision') await this.db.revisions.delete(change.entityId)
          else if (change.entityType === 'page_tag') {
            const [pageId, tagId] = change.entityId.split(':')
            if (pageId && tagId) await this.db.pageTags.where('[pageId+tagId]').equals([pageId, tagId]).delete()
          }
        } else if (change.entityType === 'page') {
          await this.db.pages.put({ ...(payload as unknown as Page), syncStatus: 'synced' })
        } else if (change.entityType === 'notebook') await this.db.notebooks.put(payload as unknown as Notebook)
        else if (change.entityType === 'document') await this.db.documents.put(payload as unknown as PageDocument)
        else if (change.entityType === 'section') await this.db.sections.put(payload as unknown as Section)
        else if (change.entityType === 'tag') await this.db.tags.put(payload as unknown as Tag)
        else if (change.entityType === 'task_step') await this.db.taskSteps.put(payload as unknown as TaskStep)
        else if (change.entityType === 'asset') {
          await this.db.assets.put(payload as unknown as Asset)
          const content = assetContents?.get(change.entityId)
          if (content) await this.db.assetContents.put({ id: change.entityId, data: new Blob([content as BlobPart]) })
        }
        else if (change.entityType === 'page_link') await this.db.pageLinks.put(payload as unknown as PageLink)
        else if (change.entityType === 'reading_position') await this.db.readingPositions.put(payload as unknown as ReadingPosition)
        else if (change.entityType === 'revision') {
          const revision = payload as unknown as PageRevision
          await this.db.revisions.put(revision)
          await this.pruneRevisionRing(workspaceId, revision.pageId)
        }
        else if (change.entityType === 'page_tag') await this.db.pageTags.put(payload as unknown as PageTag)
        // WebDAV v4 `ver` is a parent; the HTTP API returns a resulting
        // version. Keep their persistence semantics explicit per backend.
        await this.db.syncVersions.put({
          id: this.versionId(workspaceId, change.entityType, change.entityId),
          version: webdavParentVersion ? change.version + 1 : change.version,
          ...(webdavParentVersion ? { webdavParentVersion: true as const } : {}),
        })
      }
      await this.db.syncCursors.put({ workspaceId, cursor: appliedCursor })
      return { cursor: appliedCursor, conflicts }
    })
      .then((result) => {
        this.searchIndex.invalidate(workspaceId)
        return result
      })
  }

  listPageLinks(pageId: UUID) { return this.db.pageLinks.where('sourcePageId').equals(pageId).toArray() }
  listBacklinks(pageId: UUID) { return this.db.pageLinks.where('targetPageId').equals(pageId).toArray() }

  async replacePageLinks(pageId: UUID, links: PageLink[]): Promise<void> {
    if (links.some((link) => link.sourcePageId !== pageId)) throw new Error('All links must originate from the requested page')
    await this.db.transaction('rw', [this.db.pages, this.db.pageLinks, this.db.syncOutbox, this.db.syncVersions], async () => {
      const page = await this.db.pages.get(pageId)
      if (!page) throw new Error(`Page not found: ${pageId}`)
      const previous = await this.db.pageLinks.where('sourcePageId').equals(pageId).toArray()
      const previousById = new Map(previous.map((link) => [link.id, link]))
      const changed = links.filter((link) => !this.sameRemoteEntity(previousById.get(link.id), link))
      if (changed.length === 0 && previous.length === links.length) return
      await this.db.pageLinks.where('sourcePageId').equals(pageId).delete()
      await this.db.pageLinks.bulkPut(links)
      const nextIds = new Set(links.map((link) => link.id))
      for (const removed of previous.filter((link) => !nextIds.has(link.id))) await this.enqueueChange(page.workspaceId, 'page_link', removed.id, 'delete', {})
      for (const link of changed) await this.enqueueChange(page.workspaceId, 'page_link', link.id, 'upsert', { ...link })
    })
  }

  async replaceDerivedPageLinks(pageId: UUID, links: PageLink[]): Promise<void> {
    if (links.some((link) => link.sourcePageId !== pageId)) throw new Error('All links must originate from the requested page')
    await this.db.transaction('rw', this.db.pageLinks, async () => {
      await this.db.pageLinks.where('sourcePageId').equals(pageId).delete()
      await this.db.pageLinks.bulkPut(links)
    })
  }

  async importData(bundle: NotebookDataBundle): Promise<void> {
    const compactedRevisions = boundRevisionHistory(compactRevisionHistory(bundle))
    await this.db.transaction('rw', this.db.tables, async () => {
      // A bundle is authoritative for children of the pages it contains. This
      // also removes records produced by older importers when an upstream
      // format used page-local (rather than globally unique) attachment ids.
      const importedPageIds = new Set(bundle.pages.map((item) => item.id))
      const importedAssetIds = new Set(bundle.assets.map((item) => item.id))
      const importedDocumentIds = new Set(bundle.documents.map((item) => item.pageId))
      const staleAssetIds = importedPageIds.size === 0 ? [] : (await this.db.assets.toArray())
        .filter((item) => importedPageIds.has(item.pageId) && !importedAssetIds.has(item.id))
        .map((item) => item.id)
      const staleDocumentIds = importedPageIds.size === 0 ? [] : (await this.db.documents.toArray())
        .filter((item) => importedPageIds.has(item.pageId) && !importedDocumentIds.has(item.pageId))
        .map((item) => item.pageId)
      if (staleAssetIds.length) await Promise.all([
        this.db.assets.bulkDelete(staleAssetIds),
        this.db.assetContents.bulkDelete(staleAssetIds),
      ])
      if (staleDocumentIds.length) await this.db.documents.bulkDelete(staleDocumentIds)
      // Backup restore and legacy migration packages are authoritative for the
      // page-local records they contain. Clear those children before inserting
      // the package so repeated imports cannot accumulate ghost revisions,
      // stale tags, task steps, links, or reading positions.
      if (importedPageIds.size) {
        const ids = [...importedPageIds]
        await Promise.all([
          this.db.pageTags.where('pageId').anyOf(ids).delete(),
          this.db.taskSteps.where('pageId').anyOf(ids).delete(),
          this.db.pageLinks.where('sourcePageId').anyOf(ids).delete(),
          this.db.readingPositions.where('pageId').anyOf(ids).delete(),
          this.db.revisions.where('pageId').anyOf(ids).delete(),
          this.db.comments.where('pageId').anyOf(ids).delete(),
        ])
      }
      await Promise.all([
        this.db.notebooks.bulkPut(bundle.notebooks), this.db.sections.bulkPut(bundle.sections),
        this.db.pages.bulkPut(bundle.pages), this.db.documents.bulkPut(bundle.documents),
        this.db.tags.bulkPut(bundle.tags), this.db.pageTags.bulkPut(bundle.pageTags),
        this.db.taskSteps.bulkPut(bundle.taskSteps), this.db.assets.bulkPut(bundle.assets),
        this.db.pageLinks.bulkPut(bundle.pageLinks), this.db.readingPositions.bulkPut(bundle.readingPositions),
        this.db.tombstones.bulkPut(bundle.tombstones),
        this.db.revisions.bulkPut(compactedRevisions),
      ])
    })
    for (const workspaceId of new Set([...bundle.notebooks.map((item) => item.workspaceId), ...bundle.pages.map((item) => item.workspaceId)])) this.searchIndex.invalidate(workspaceId)
  }

  async importSyncResult(bundle: NotebookDataBundle, snapshot: NotebookDataBundle): Promise<NotebookDataBundle> {
    const workspaceId = snapshot.notebooks[0]?.workspaceId ?? snapshot.pages[0]?.workspaceId ?? bundle.notebooks[0]?.workspaceId ?? bundle.pages[0]?.workspaceId
    if (!workspaceId) throw new Error('Cannot determine workspace for synchronized bundle')
    return this.db.transaction('rw', this.db.tables, async () => {
      const current = await this.exportData(workspaceId)
      const rebased = preserveChangesSinceSnapshot(bundle, snapshot, current)
      await this.importData(rebased)
      return rebased
    })
  }

  /**
   * Publishes an imported bundle through the normal versioned outbox. Importing
   * and publishing are deliberately separate so callers can persist attachment
   * bytes before the background synchronizer is allowed to upload metadata.
   */
  async queueImportedData(bundle: NotebookDataBundle): Promise<void> {
    const notebookWorkspace = new Map(bundle.notebooks.map((item) => [item.id, item.workspaceId]))
    const pageWorkspace = new Map(bundle.pages.map((item) => [item.id, item.workspaceId]))
    await this.db.transaction('rw', [this.db.pages, this.db.syncOutbox, this.db.syncVersions], async () => {
      const queue = (workspaceId: string | undefined, entityType: string, entityId: string, payload: Record<string, unknown>) => {
        if (!workspaceId) throw new Error(`Cannot resolve workspace for imported ${entityType} ${entityId}`)
        return this.enqueueChange(workspaceId, entityType, entityId, 'upsert', payload)
      }

      // Parent and metadata records are queued first. The server retains order in
      // its change log, which lets a newly connected client apply dependencies as
      // they arrive without manufacturing placeholder records.
      for (const item of bundle.notebooks) await queue(item.workspaceId, 'notebook', item.id, { ...item })
      for (const item of bundle.sections) await queue(notebookWorkspace.get(item.notebookId), 'section', item.id, { ...item })
      for (const item of bundle.pages) {
        const value: Page = { ...item, syncStatus: 'pending' }
        await this.db.pages.put(value)
        await queue(item.workspaceId, 'page', item.id, { ...value })
      }
      for (const item of bundle.documents) await queue(pageWorkspace.get(item.pageId), 'document', item.pageId, { ...item, yjsState: undefined })
      for (const item of bundle.tags) await queue(item.workspaceId, 'tag', item.id, { ...item })
      for (const item of bundle.pageTags) await queue(pageWorkspace.get(item.pageId), 'page_tag', `${item.pageId}:${item.tagId}`, { ...item })
      for (const item of bundle.taskSteps) await queue(pageWorkspace.get(item.pageId), 'task_step', item.id, { ...item })
      for (const item of bundle.assets) await queue(pageWorkspace.get(item.pageId), 'asset', item.id, { ...item, localPath: undefined })
      for (const item of bundle.pageLinks) await queue(item.workspaceId, 'page_link', item.id, { ...item })
      for (const item of bundle.readingPositions) await queue(pageWorkspace.get(item.pageId), 'reading_position', item.id, { ...item })
      for (const item of boundRevisionHistory(bundle.revisions)) await queue(pageWorkspace.get(item.pageId), 'revision', item.id, { ...item, document: { ...item.document, yjsState: undefined } })
      // Tombstones are last so an imported deletion wins if an archive contains a
      // historical live row as well as its later tombstone.
      for (const item of bundle.tombstones) await this.enqueueChange(item.workspaceId, item.entityType, item.entityId, 'delete', {})
    })
  }

  async importAssetContents(contents: Map<string, Uint8Array>) {
    await this.db.assetContents.bulkPut([...contents].map(([id, data]) => ({ id, data: new Blob([data as BlobPart]) })))
  }

  /**
   * Restores a complete backup as one database commit. Metadata, attachment
   * bytes and the publication outbox must never become visible separately:
   * otherwise a failed restore can leave dangling attachment rows or publish a
   * half-imported workspace on the next background sync.
   */
  async restoreCompleteBackup(bundle: NotebookDataBundle, contents: Map<string, Uint8Array>) {
    const expectedAssetIds = new Set(bundle.assets.map((asset) => asset.id))
    if (contents.size !== expectedAssetIds.size || [...expectedAssetIds].some((id) => !contents.has(id))) {
      throw new Error('完整备份的附件清单与内容对象不一致，已中止恢复')
    }
    await this.db.transaction('rw', this.db.tables, async () => {
      await this.importData(bundle)
      await this.importAssetContents(contents)
      await this.queueImportedData(bundle)
    })
  }

  async exportAssetContentsByIds(assetIds: Set<string>) {
    const result = new Map<string, Uint8Array>()
    for (const id of assetIds) {
      const content = await this.db.assetContents.get(id)
      if (content) result.set(id, new Uint8Array(await content.data.arrayBuffer()))
    }
    return result
  }

  async exportAssetContents(pageIds: Set<string>) {
    const assets = (await this.db.assets.toArray()).filter((asset) => pageIds.has(asset.pageId))
    return this.exportAssetContentsByIds(new Set(assets.map((asset) => asset.id)))
  }

  async exportData(workspaceId: UUID): Promise<NotebookDataBundle> {
    const notebooks = await this.db.notebooks.where('workspaceId').equals(workspaceId).toArray()
    const notebookIds = new Set(notebooks.map((item) => item.id))
    const sections = (await this.db.sections.toArray()).filter((item) => notebookIds.has(item.notebookId))
    const pages = await this.db.pages.where('workspaceId').equals(workspaceId).toArray()
    const pageIds = new Set(pages.map((item) => item.id))
    const tombstones = await this.db.tombstones.where('workspaceId').equals(workspaceId).toArray()
    const activeTombstones = tombstones.filter((item) => {
      if (item.entityType !== 'page') return true
      const page = pages.find((candidate) => candidate.id === item.entityId)
      return !page || Boolean(page.deletedAt) || item.deletedAt >= page.updatedAt
    })
    return {
      notebooks, sections, pages,
      documents: (await this.db.documents.toArray()).filter((item) => pageIds.has(item.pageId)),
      tags: await this.db.tags.where('workspaceId').equals(workspaceId).toArray(),
      pageTags: (await this.db.pageTags.toArray()).filter((item) => pageIds.has(item.pageId)),
      taskSteps: (await this.db.taskSteps.toArray()).filter((item) => pageIds.has(item.pageId)),
      assets: (await this.db.assets.toArray()).filter((item) => pageIds.has(item.pageId)),
      pageLinks: await this.db.pageLinks.where('workspaceId').equals(workspaceId).toArray(),
      knowledgeEntities: [],
      knowledgeRelations: [],
      readingPositions: (await this.db.readingPositions.toArray()).filter((item) => pageIds.has(item.pageId)),
      revisions: (await this.db.revisions.toArray()).filter((item) => pageIds.has(item.pageId)),
      comments: [],
      tombstones: activeTombstones,
    }
  }

  async listAssets(pageId: UUID) { return (await this.db.assets.where('pageId').equals(pageId).sortBy('createdAt')).filter((asset) => !asset.parentAssetId) }

  async saveAsset(asset: Asset, data: Blob) {
    if (data.size > 100 * 1024 * 1024) throw new Error('单个附件不能超过 100 MB')
    await this.db.transaction('rw', this.db.pages, this.db.assets, this.db.assetContents, this.db.syncOutbox, this.db.syncVersions, async () => {
      await this.db.assets.put(asset)
      await this.db.assetContents.put({ id: asset.id, data })
      const page = await this.db.pages.get(asset.pageId)
      if (page) await this.enqueueChange(page.workspaceId, 'asset', asset.id, 'upsert', { ...asset, localPath: undefined })
    })
  }

  getAssetContent(id: UUID) { return this.db.assetContents.get(id).then((value) => value?.data) }
  listRevisions(pageId: UUID) { return this.db.revisions.where('pageId').equals(pageId).reverse().sortBy('createdAt') }
  saveAutomationProposal(proposal: AutomationProposal) { return this.db.automationProposals.put(proposal) }
  getAutomationProposal(id: UUID) { return this.db.automationProposals.get(id) }
  listAutomationProposals(workspaceId: UUID) {
    return this.db.automationProposals.where('workspaceId').equals(workspaceId).reverse().sortBy('createdAt')
  }
  async updateAutomationProposalStatus(id: UUID, status: AutomationProposal['status']) {
    const proposal = await this.db.automationProposals.get(id)
    if (!proposal) throw new Error('AI 修改提案不存在')
    await this.db.automationProposals.put({ ...proposal, status, reviewedAt: new Date().toISOString() })
  }
  async applyAutomationProposal(
    proposalId: UUID,
    prepared: Array<{ page: Page; document?: PageDocument; previousPageId?: UUID; delete?: boolean; deviceId?: string }>,
    acceptedChangeIds?: UUID[],
  ) {
    return this.db.transaction('rw', [this.db.automationProposals, this.db.pages, this.db.documents, this.db.revisions, this.db.tombstones, this.db.syncOutbox, this.db.syncVersions, this.db.drafts], async () => {
      const proposal = await this.db.automationProposals.get(proposalId)
      if (!proposal || proposal.status !== 'pending') throw new Error('AI 修改提案不存在或已经审阅')
      const acceptedIds = new Set(acceptedChangeIds ?? proposal.changes.map((change) => change.id))
      const acceptedChanges = proposal.changes.filter((change) => acceptedIds.has(change.id))
      if (!acceptedChanges.length) throw new Error('至少需要接受一项 AI 修改')
      for (const change of acceptedChanges) {
        if (!change.before) continue
        const current = await this.db.pages.get(change.before.pageId)
        if (!current || current.updatedAt !== change.before.updatedAt) throw Object.assign(new Error(`“${change.before.title}”在提案生成后已变化`), { code: 'stale' })
      }
      for (const value of prepared) {
        const existing = value.previousPageId ? await this.db.pages.get(value.previousPageId) : undefined
        const existingDocument = value.previousPageId ? await this.db.documents.get(value.previousPageId) : undefined
        if (existing && existingDocument) {
          const revision: PageRevision = {
            id: crypto.randomUUID(),
            pageId: existing.id,
            pageIcon: existing.icon ?? null,
            document: {
              ...existingDocument,
              markdown: existingDocument.markdown ?? legacyTiptapToCanonicalMarkdown(existingDocument.tiptapJson),
              tiptapJson: { type: 'doc', content: [] },
              yjsState: undefined,
            },
            createdAt: value.document?.updatedAt ?? value.page.updatedAt,
            reason: 'manual',
          }
          await this.db.revisions.put(revision)
          await this.enqueueChange(existing.workspaceId, 'revision', revision.id, 'upsert', revision as unknown as Record<string, unknown>)
          await this.pruneRevisionRing(existing.workspaceId, existing.id)
        }
        if (value.delete) {
          const deletedAt = value.page.deletedAt ?? value.page.updatedAt
          const tombstone: Tombstone = {
            id: `page:${value.page.id}`,
            workspaceId: value.page.workspaceId,
            entityType: 'page',
            entityId: value.page.id,
            deletedAt,
            deviceId: value.deviceId ?? 'electron-ai',
          }
          await this.db.pages.put({ ...value.page, deletedAt, syncStatus: 'pending', updatedAt: deletedAt })
          await this.db.tombstones.put(tombstone)
          await this.db.drafts.delete(value.page.id)
          await this.enqueueChange(value.page.workspaceId, 'page', value.page.id, 'delete', {})
          continue
        }
        if (!value.document) throw new Error(`AI 修改缺少页面正文：${value.page.title}`)
        await this.db.pages.put(value.page)
        await this.db.documents.put(value.document)
        await this.db.drafts.delete(value.page.id)
        await this.enqueueChange(value.page.workspaceId, 'page', value.page.id, 'upsert', value.page as unknown as Record<string, unknown>)
        await this.enqueueChange(value.page.workspaceId, 'document', value.page.id, 'upsert', { ...value.document, yjsState: undefined })
      }
      await this.db.automationProposals.put({
        ...proposal,
        status: 'applied',
        acceptedChangeIds: acceptedChanges.map((change) => change.id),
        rejectedChangeIds: proposal.changes.filter((change) => !acceptedIds.has(change.id)).map((change) => change.id),
        reviewedAt: new Date().toISOString(),
      })
    }).finally(() => this.searchIndex.invalidate(prepared[0]?.page.workspaceId ?? ''))
  }
  async resetRevisionHistory(workspaceId: UUID): Promise<{ pageCount: number; removedRevisionCount: number }> {
    return this.db.transaction('rw', this.db.pages, this.db.documents, this.db.revisions, this.db.syncOutbox, this.db.syncVersions, async () => {
      const pages = await this.db.pages.where('workspaceId').equals(workspaceId).toArray()
      const pageIds = new Set(pages.map((page) => page.id))
      const documents = (await this.db.documents.toArray()).filter((document) => pageIds.has(document.pageId))
      const previousRevisions = (await this.db.revisions.toArray()).filter((revision) => pageIds.has(revision.pageId))
      const staleRevisionOutboxIds = (await this.db.syncOutbox.where('workspaceId').equals(workspaceId).toArray())
        .filter((item) => item.entityType === 'revision')
        .map((item) => item.id)
      const resetAt = new Date().toISOString()
      const documentsByPage = new Map(documents.map((document) => [document.pageId, document]))
      const documentMarkdown = (document: PageDocument) => document.markdown ?? tiptapToMarkdown(document.tiptapJson)
      const pagesWithHistoryOnlyContent = pages.filter((page) => {
        const current = documentsByPage.get(page.id)
        if (current && documentMarkdown(current).trim()) return false
        return previousRevisions.some((revision) => revision.pageId === page.id && documentMarkdown(revision.document).trim())
      })
      if (pagesWithHistoryOnlyContent.length) {
        const titles = pagesWithHistoryOnlyContent.slice(0, 5).map((page) => `“${page.title || '无标题页面'}”`).join('、')
        const remaining = pagesWithHistoryOnlyContent.length > 5 ? `等 ${pagesWithHistoryOnlyContent.length} 篇页面` : ''
        throw new Error(`已停止清理：${titles}${remaining}当前正文为空，但历史版本仍有内容。请先在“版本”中恢复需要保留的内容，再重试。`)
      }

      await this.db.revisions.bulkDelete(previousRevisions.map((revision) => revision.id))
      if (staleRevisionOutboxIds.length) await this.db.syncOutbox.bulkDelete(staleRevisionOutboxIds)

      const baselines: PageRevision[] = []
      for (const page of pages) {
        const document = documentsByPage.get(page.id) ?? {
          pageId: page.id,
          schemaVersion: 3,
          markdown: '',
          tiptapJson: { type: 'doc', content: [] },
          updatedAt: resetAt,
        }
        if (!documentsByPage.has(page.id)) await this.db.documents.put(document)
        const markdown = document.markdown ?? tiptapToMarkdown(document.tiptapJson)
        const baseline: PageRevision = {
          id: crypto.randomUUID(),
          pageId: page.id,
          pageIcon: page.icon ?? null,
          document: {
            ...document,
            schemaVersion: Math.max(3, document.schemaVersion),
            markdown,
            tiptapJson: { type: 'doc', content: [] },
            yjsState: undefined,
          },
          createdAt: resetAt,
          reason: 'manual',
        }
        const updatedPage: Page = {
          ...page,
          updatedAt: resetAt,
          legacyVersion: Math.max((page.legacyVersion ?? 0) + 1, Date.parse(resetAt)),
          syncStatus: 'pending',
          legacyMetadata: { ...page.legacyMetadata, historyResetAt: resetAt },
        }
        baselines.push(baseline)
        await this.db.pages.put(updatedPage)
        await this.enqueueChange(workspaceId, 'page', page.id, 'upsert', { ...updatedPage })
        await this.enqueueChange(workspaceId, 'revision', baseline.id, 'upsert', { ...baseline })
      }
      if (baselines.length) await this.db.revisions.bulkPut(baselines)
      return { pageCount: baselines.length, removedRevisionCount: previousRevisions.length }
    })
  }
  async createManualRevision(pageId: UUID): Promise<PageRevision> {
    return this.db.transaction('rw', this.db.pages, this.db.documents, this.db.revisions, this.db.syncOutbox, this.db.syncVersions, async () => {
      const page = await this.db.pages.get(pageId)
      const document = await this.db.documents.get(pageId)
      if (!page || !document) throw new Error('页面内容不存在')
      const markdown = document.markdown ?? tiptapToMarkdown(document.tiptapJson)
      const createdAt = new Date().toISOString()
      const revision: PageRevision = {
        id: crypto.randomUUID(),
        pageId,
        pageIcon: page.icon ?? null,
        document: {
          ...document,
          schemaVersion: Math.max(3, document.schemaVersion),
          markdown,
          tiptapJson: { type: 'doc', content: [] },
          yjsState: undefined,
        },
        createdAt,
        reason: 'manual',
      }
      await this.db.revisions.add(revision)
      await this.enqueueChange(page.workspaceId, 'revision', revision.id, 'upsert', { ...revision })
      await this.pruneRevisionRing(page.workspaceId, pageId)
      return revision
    })
  }
  async restoreRevision(revisionId: UUID) {
    const revision = await this.db.revisions.get(revisionId)
    if (!revision) throw new Error('版本不存在')
    const page = await this.db.pages.get(revision.pageId)
    if (!page) throw new Error('页面不存在')
    const now = new Date().toISOString()
    const assets = await this.db.assets.where('pageId').equals(revision.pageId).toArray()
    const document = { ...revision.document, ...(revision.document.markdown !== undefined ? { tiptapJson: markdownToEditorCache(revision.document.markdown, assets) } : {}), updatedAt: now }
    await this.savePage({
      ...page,
      ...(revision.pageIcon !== undefined ? { icon: revision.pageIcon ?? undefined } : {}),
      updatedAt: now,
      syncStatus: 'pending',
    }, document)
    return document
  }
  async searchWorkspace(workspaceId: UUID, query: string, limit = 50): Promise<Page[]> {
    return searchWorkspaceWith(this.db, this.searchIndex, workspaceId, query, limit)
  }

  /**
   * Returns a high-recall candidate set using only the cached inverted index.
   * Unlike the user-facing search ranking above, this deliberately avoids the
   * O(page count) exact-substring pass. Callers must verify the small result
   * set before presenting an exact semantic such as an unlinked mention.
   */
  async searchWorkspaceCandidates(workspaceId: UUID, query: string, limit = 200): Promise<Page[]> {
    return searchWorkspaceCandidatesWith(this.db, this.searchIndex, workspaceId, query, limit)
  }
}
