import Dexie, { type EntityTable } from 'dexie'
import MiniSearch from 'minisearch'
import type {
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
  KnowledgeEntity,
  KnowledgeRelation,
  Asset,
  NotebookDataBundle,
  PageTag,
  ReadingPosition,
  Tombstone,
  PageRevision,
  PageComment,
} from '@notebook/domain'
import { markdownToEditorCache } from '@notebook/sync-contract'

export interface SyncOutboxItem {
  id: string
  workspaceId: string
  entityType: string
  entityId: string
  expectedVersion: number
  operation: 'upsert' | 'delete'
  payload: Record<string, unknown>
  createdAt: string
}

function compactRevisionHistory(bundle: NotebookDataBundle) {
  const signature = (document: PageDocument) => document.markdown ?? JSON.stringify(document.tiptapJson)
  const currentDocuments = new Map(bundle.documents.map((document) => [document.pageId, signature(document)]))
  const byPage = new Map<string, PageRevision[]>()
  for (const revision of bundle.revisions) {
    const values = byPage.get(revision.pageId) ?? []
    values.push(revision)
    byPage.set(revision.pageId, values)
  }
  return [...byPage.values()].flatMap((values) => {
    let previous: string | undefined
    const compacted = values.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).filter((revision) => {
      const value = signature(revision.document)
      if (value === previous) return false
      previous = value
      return true
    })
    const last = compacted[compacted.length - 1]
    if (last && signature(last.document) === currentDocuments.get(last.pageId)) compacted.pop()
    return compacted
  })
}

export interface RemoteSyncChange {
  cursor: number
  entityType: string
  entityId: string
  version: number
  operation: string
  payload: Record<string, unknown>
}

interface SyncCursor { workspaceId: string; cursor: number }
interface SyncVersion { id: string; version: number }
interface AssetContent { id: string; data: Blob }

export class NotebookWebDatabase extends Dexie {
  notebooks!: EntityTable<Notebook, 'id'>
  sections!: EntityTable<Section, 'id'>
  pages!: EntityTable<Page, 'id'>
  documents!: EntityTable<PageDocument, 'pageId'>
  tags!: EntityTable<Tag, 'id'>
  taskSteps!: EntityTable<TaskStep, 'id'>
  pageLinks!: EntityTable<PageLink, 'id'>
  knowledgeEntities!: EntityTable<KnowledgeEntity, 'id'>
  knowledgeRelations!: EntityTable<KnowledgeRelation, 'id'>
  assets!: EntityTable<Asset, 'id'>
  pageTags!: EntityTable<PageTag>
  readingPositions!: EntityTable<ReadingPosition, 'id'>
  tombstones!: EntityTable<Tombstone, 'id'>
  syncOutbox!: EntityTable<SyncOutboxItem, 'id'>
  syncCursors!: EntityTable<SyncCursor, 'workspaceId'>
  syncVersions!: EntityTable<SyncVersion, 'id'>
  assetContents!: EntityTable<AssetContent, 'id'>
  revisions!: EntityTable<PageRevision, 'id'>
  comments!: EntityTable<PageComment, 'id'>

  constructor(name = 'notebook-next') {
    super(name)
    this.version(1).stores({
      notebooks: 'id, workspaceId, sortOrder, updatedAt, deletedAt',
      sections: 'id, notebookId, parentSectionId, sortOrder, updatedAt, deletedAt',
      pages: 'id, workspaceId, sectionId, kind, updatedAt, deletedAt, syncStatus, *title',
      documents: 'pageId, updatedAt',
      tags: 'id, workspaceId, name, updatedAt, deletedAt',
      taskSteps: 'id, pageId, sortOrder',
    })
    this.version(2).stores({
      pageLinks: 'id, workspaceId, sourcePageId, targetPageId, kind',
      knowledgeEntities: 'id, workspaceId, name, type, *sourcePageIds, updatedAt',
      knowledgeRelations: 'id, workspaceId, sourceEntityId, targetEntityId, type, evidencePageId, updatedAt',
    })
    this.version(3).stores({
      assets: 'id, pageId, kind, checksum',
      pageTags: '[pageId+tagId], pageId, tagId',
      readingPositions: 'id, pageId, updatedAt',
      tombstones: 'id, workspaceId, entityType, entityId, deletedAt',
    })
    this.version(4).stores({
      syncOutbox: 'id, workspaceId, createdAt, [entityType+entityId]',
      syncCursors: 'workspaceId',
      syncVersions: 'id',
    })
    this.version(5).stores({ assetContents: 'id' })
    this.version(6).stores({ revisions: 'id, pageId, createdAt' })
    this.version(7).stores({ comments: 'id, workspaceId, pageId, createdAt, resolvedAt' })
  }
}

const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase()

function remapAssetReferences(value: unknown, assetIds: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let result = value
    for (const [sourceId, targetId] of assetIds) result = result.replaceAll(`notebook-asset:${sourceId}`, `notebook-asset:${targetId}`)
    return assetIds.get(result) ?? result
  }
  if (Array.isArray(value)) return value.map((item) => remapAssetReferences(item, assetIds))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, remapAssetReferences(item, assetIds)]))
}

export class DexieNotebookRepository implements NotebookRepository {
  constructor(readonly db = new NotebookWebDatabase()) {}

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
      : await this.db.pages.toArray()
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
  async saveNotebook(notebook: Notebook) {
    await this.db.notebooks.put(notebook)
    await this.enqueueChange(notebook.workspaceId, 'notebook', notebook.id, 'upsert', { ...notebook })
  }
  async saveSection(section: Section) {
    const notebook = await this.db.notebooks.get(section.notebookId)
    if (!notebook) throw new Error(`Notebook not found: ${section.notebookId}`)
    await this.db.sections.put(section)
    await this.enqueueChange(notebook.workspaceId, 'section', section.id, 'upsert', { ...section })
  }
  async deleteSection(sectionId: UUID, deletedAt: string, deviceId: string) {
    const section = await this.db.sections.get(sectionId)
    if (!section) return
    const notebook = await this.db.notebooks.get(section.notebookId)
    if (!notebook) throw new Error(`Notebook not found: ${section.notebookId}`)
    if (await this.db.pages.where('sectionId').equals(sectionId).count()) throw new Error('分区中仍有页面（含回收站页面），请先移动或永久删除这些页面')
    const tombstone: Tombstone = { id: `section:${sectionId}`, workspaceId: notebook.workspaceId, entityType: 'section', entityId: sectionId, deletedAt, deviceId }
    await this.db.transaction('rw', this.db.sections, this.db.tombstones, async () => {
      await this.db.sections.delete(sectionId)
      await this.db.tombstones.put(tombstone)
    })
    await this.enqueueChange(notebook.workspaceId, 'section', sectionId, 'delete', {})
  }

  async duplicatePage(pageId: UUID, newPageId: UUID, createdAt: string): Promise<Page> {
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
  }
  listPageTags(pageId: UUID) { return this.db.pageTags.where('pageId').equals(pageId).toArray() }
  getReadingPosition(pageId: UUID) { return this.db.readingPositions.where('pageId').equals(pageId).first() }
  async saveReadingPosition(position: ReadingPosition) {
    const page = await this.db.pages.get(position.pageId)
    if (!page || page.deletedAt) return
    await this.db.readingPositions.put(position)
    await this.enqueueChange(page.workspaceId, 'reading_position', position.id, 'upsert', { ...position })
  }
  async savePageTags(pageId: UUID, tagIds: UUID[]) {
    const page = await this.db.pages.get(pageId)
    if (!page) throw new Error(`Page not found: ${pageId}`)
    const previous = await this.db.pageTags.where('pageId').equals(pageId).toArray()
    const next = [...new Set(tagIds)].map((tagId) => ({ pageId, tagId }))
    await this.db.transaction('rw', this.db.tables, async () => {
      await this.db.pageTags.where('pageId').equals(pageId).delete()
      await this.db.pageTags.bulkPut(next)
    })
    const nextIds = new Set(tagIds)
    for (const value of previous.filter((item) => !nextIds.has(item.tagId))) await this.enqueueChange(page.workspaceId, 'page_tag', `${pageId}:${value.tagId}`, 'delete', {})
    for (const value of next) await this.enqueueChange(page.workspaceId, 'page_tag', `${pageId}:${value.tagId}`, 'upsert', value)
  }

  async savePage(page: Page, document?: PageDocument): Promise<void> {
    await this.db.transaction('rw', this.db.pages, this.db.documents, this.db.revisions, this.db.syncOutbox, this.db.syncVersions, async () => {
      await this.db.pages.put(page)
      if (document) {
        if (document.pageId !== page.id) throw new Error('Document pageId must match page id')
        const existing = await this.db.documents.get(page.id)
        if (existing && JSON.stringify(existing.tiptapJson) !== JSON.stringify(document.tiptapJson)) {
          const revision: PageRevision = { id: crypto.randomUUID(), pageId: page.id, document: existing, createdAt: document.updatedAt, reason: 'autosave' }
          await this.db.revisions.put(revision)
          if (page.syncStatus === 'pending') await this.enqueueChange(page.workspaceId, 'revision', revision.id, 'upsert', { ...revision, document: { ...revision.document, yjsState: undefined } })
          // Imported legacy versions are archival user data and must never be
          // discarded by a later edit. Bound only versions generated by this
          // client's autosave loop.
          const autosaves = (await this.db.revisions.where('pageId').equals(page.id).sortBy('createdAt')).filter((item) => item.reason === 'autosave')
          if (autosaves.length > 100) await this.db.revisions.bulkDelete(autosaves.slice(0, autosaves.length - 100).map((item) => item.id))
        }
        await this.db.documents.put(document)
        if (page.syncStatus === 'pending') await this.enqueueChange(page.workspaceId, 'document', page.id, 'upsert', { ...document, yjsState: undefined })
      }
      if (page.syncStatus === 'pending') await this.enqueueChange(page.workspaceId, 'page', page.id, 'upsert', { ...page })
    })
  }

  async movePageToTrash(pageId: UUID, deletedAt: string): Promise<void> {
    const page = await this.db.pages.get(pageId)
    if (!page) throw new Error(`Page not found: ${pageId}`)
    await this.savePage({ ...page, deletedAt, syncStatus: 'pending', updatedAt: deletedAt })
  }

  async restorePage(pageId: UUID): Promise<void> {
    const page = await this.db.pages.get(pageId)
    if (!page) throw new Error(`Page not found: ${pageId}`)
    await this.savePage({ ...page, deletedAt: undefined, syncStatus: 'pending', updatedAt: new Date().toISOString() })
  }

  async purgePage(pageId: UUID): Promise<void> {
    const page = await this.db.pages.get(pageId)
    if (!page) return
    const steps = await this.db.taskSteps.where('pageId').equals(pageId).toArray()
    const assets = await this.db.assets.where('pageId').equals(pageId).toArray()
    const links = await this.db.pageLinks.where('sourcePageId').equals(pageId).toArray()
    for (const item of steps) await this.enqueueChange(page.workspaceId, 'task_step', item.id, 'delete', {})
    for (const item of assets) await this.enqueueChange(page.workspaceId, 'asset', item.id, 'delete', {})
    for (const item of links) await this.enqueueChange(page.workspaceId, 'page_link', item.id, 'delete', {})
    await this.enqueueChange(page.workspaceId, 'document', pageId, 'delete', {})
    await this.enqueueChange(page.workspaceId, 'page', pageId, 'delete', {})
    await this.db.transaction('rw', this.db.tables, async () => {
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
      ])
      await this.db.assetContents.bulkDelete(assets.map((item) => item.id))
    })
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
    const page = await this.db.pages.get(pageId)
    if (!page) throw new Error(`Page not found: ${pageId}`)
    const previous = await this.db.taskSteps.where('pageId').equals(pageId).toArray()
    await this.db.transaction('rw', this.db.taskSteps, async () => {
      await this.db.taskSteps.where('pageId').equals(pageId).delete()
      await this.db.taskSteps.bulkPut(steps)
    })
    const nextIds = new Set(steps.map((step) => step.id))
    for (const removed of previous.filter((step) => !nextIds.has(step.id))) await this.enqueueChange(page.workspaceId, 'task_step', removed.id, 'delete', { ...removed })
    for (const step of steps) await this.enqueueChange(page.workspaceId, 'task_step', step.id, 'upsert', { ...step })
  }

  private versionId(workspaceId: string, entityType: string, entityId: string) { return `${workspaceId}:${entityType}:${entityId}` }

  async enqueueChange(workspaceId: string, entityType: string, entityId: string, operation: 'upsert' | 'delete', payload: Record<string, unknown>): Promise<void> {
    const version = await this.db.syncVersions.get(this.versionId(workspaceId, entityType, entityId))
    // Keep only the latest unsent mutation for an entity. Multiple autosaves made
    // before a sync tick share the same expected version and would otherwise
    // conflict with each other after the first mutation is accepted remotely.
    await this.db.syncOutbox.where('[entityType+entityId]').equals([entityType, entityId]).and((item) => item.workspaceId === workspaceId).delete()
    await this.db.syncOutbox.put({ id: crypto.randomUUID(), workspaceId, entityType, entityId, expectedVersion: version?.version ?? 0, operation, payload, createdAt: new Date().toISOString() })
  }

  listOutbox(workspaceId: string, limit = 200) { return this.db.syncOutbox.where('workspaceId').equals(workspaceId).limit(limit).toArray() }
  clearOutbox(workspaceId: string) { return this.db.syncOutbox.where('workspaceId').equals(workspaceId).delete() }
  getSyncCursor(workspaceId: string) { return this.db.syncCursors.get(workspaceId).then((value) => value?.cursor ?? 0) }

  async acknowledgeSync(workspaceId: string, applied: Array<{ operation_id: string; entity_type: string; entity_id: string; version: number }>, cursor?: number) {
    await this.db.transaction('rw', this.db.syncOutbox, this.db.syncVersions, this.db.syncCursors, this.db.pages, async () => {
      for (const item of applied) {
        await this.db.syncOutbox.delete(item.operation_id)
        await this.db.syncVersions.put({ id: this.versionId(workspaceId, item.entity_type, item.entity_id), version: item.version })
        if (item.entity_type === 'page') await this.db.pages.update(item.entity_id, { syncStatus: 'synced' })
      }
      if (cursor !== undefined) await this.db.syncCursors.put({ workspaceId, cursor })
    })
  }

  async markSyncConflicts(entityIds: string[]) {
    await this.db.pages.where('id').anyOf(entityIds).modify({ syncStatus: 'conflict' })
  }

  async applyRemoteChanges(workspaceId: string, changes: RemoteSyncChange[], cursor: number) {
    await this.db.transaction('rw', this.db.tables, async () => {
      for (const change of changes) {
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
          await this.db.pages.put({ ...(change.payload as unknown as Page), syncStatus: 'synced' })
        } else if (change.entityType === 'notebook') await this.db.notebooks.put(change.payload as unknown as Notebook)
        else if (change.entityType === 'document') await this.db.documents.put(change.payload as unknown as PageDocument)
        else if (change.entityType === 'section') await this.db.sections.put(change.payload as unknown as Section)
        else if (change.entityType === 'tag') await this.db.tags.put(change.payload as unknown as Tag)
        else if (change.entityType === 'task_step') await this.db.taskSteps.put(change.payload as unknown as TaskStep)
        else if (change.entityType === 'asset') await this.db.assets.put(change.payload as unknown as Asset)
        else if (change.entityType === 'page_link') await this.db.pageLinks.put(change.payload as unknown as PageLink)
        else if (change.entityType === 'reading_position') await this.db.readingPositions.put(change.payload as unknown as ReadingPosition)
        else if (change.entityType === 'revision') await this.db.revisions.put(change.payload as unknown as PageRevision)
        else if (change.entityType === 'page_tag') await this.db.pageTags.put(change.payload as unknown as PageTag)
        await this.db.syncVersions.put({ id: this.versionId(workspaceId, change.entityType, change.entityId), version: change.version })
      }
      await this.db.syncCursors.put({ workspaceId, cursor })
    })
  }

  listPageLinks(pageId: UUID) { return this.db.pageLinks.where('sourcePageId').equals(pageId).toArray() }

  async replacePageLinks(pageId: UUID, links: PageLink[]): Promise<void> {
    if (links.some((link) => link.sourcePageId !== pageId)) throw new Error('All links must originate from the requested page')
    await this.db.transaction('rw', this.db.pageLinks, async () => {
      await this.db.pageLinks.where('sourcePageId').equals(pageId).delete()
      await this.db.pageLinks.bulkPut(links)
    })
  }

  async importData(bundle: NotebookDataBundle): Promise<void> {
    const compactedRevisions = compactRevisionHistory(bundle)
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
  }

  /**
   * Publishes an imported bundle through the normal versioned outbox. Importing
   * and publishing are deliberately separate so callers can persist attachment
   * bytes before the background synchronizer is allowed to upload metadata.
   */
  async queueImportedData(bundle: NotebookDataBundle): Promise<void> {
    const notebookWorkspace = new Map(bundle.notebooks.map((item) => [item.id, item.workspaceId]))
    const pageWorkspace = new Map(bundle.pages.map((item) => [item.id, item.workspaceId]))
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
    for (const item of bundle.revisions) await queue(pageWorkspace.get(item.pageId), 'revision', item.id, { ...item, document: { ...item.document, yjsState: undefined } })
    // Tombstones are last so an imported deletion wins if an archive contains a
    // historical live row as well as its later tombstone.
    for (const item of bundle.tombstones) await this.enqueueChange(item.workspaceId, item.entityType, item.entityId, 'delete', {})
  }

  async importAssetContents(contents: Map<string, Uint8Array>) {
    await this.db.assetContents.bulkPut([...contents].map(([id, data]) => ({ id, data: new Blob([data as BlobPart]) })))
  }

  async exportAssetContents(pageIds: Set<string>) {
    const assets = (await this.db.assets.toArray()).filter((asset) => pageIds.has(asset.pageId))
    const result = new Map<string, Uint8Array>()
    for (const asset of assets) {
      const content = await this.db.assetContents.get(asset.id)
      if (content) result.set(asset.id, new Uint8Array(await content.data.arrayBuffer()))
    }
    return result
  }

  async exportData(workspaceId: UUID): Promise<NotebookDataBundle> {
    const notebooks = await this.db.notebooks.where('workspaceId').equals(workspaceId).toArray()
    const notebookIds = new Set(notebooks.map((item) => item.id))
    const sections = (await this.db.sections.toArray()).filter((item) => notebookIds.has(item.notebookId))
    const pages = await this.db.pages.where('workspaceId').equals(workspaceId).toArray()
    const pageIds = new Set(pages.map((item) => item.id))
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
      tombstones: await this.db.tombstones.where('workspaceId').equals(workspaceId).toArray(),
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
  async restoreRevision(revisionId: UUID) {
    const revision = await this.db.revisions.get(revisionId)
    if (!revision) throw new Error('版本不存在')
    const page = await this.db.pages.get(revision.pageId)
    if (!page) throw new Error('页面不存在')
    const now = new Date().toISOString()
    const assets = await this.db.assets.where('pageId').equals(revision.pageId).toArray()
    const document = { ...revision.document, ...(revision.document.markdown !== undefined ? { tiptapJson: markdownToEditorCache(revision.document.markdown, assets) } : {}), updatedAt: now }
    await this.savePage({ ...page, updatedAt: now, syncStatus: 'pending' }, document)
    return document
  }
  async searchWorkspace(workspaceId: UUID, query: string, limit = 50): Promise<Page[]> {
    const pages = (await this.db.pages.where('workspaceId').equals(workspaceId).toArray()).filter((page) => !page.deletedAt)
    const pageIds = new Set(pages.map((page) => page.id))
    const documents = (await this.db.documents.toArray()).filter((document) => pageIds.has(document.pageId))
    const textByPage = new Map(documents.map((document) => [document.pageId, extractText(document.tiptapJson)]))
    const tokenize = (value: string) => {
      const normalized = value.normalize('NFKC').toLocaleLowerCase()
      const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []
      const cjk = [...normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)].flatMap((match) => {
        const characters = [...match[0]]
        return characters.length === 1 ? characters : characters.slice(0, -1).map((character, index) => character + characters[index + 1])
      })
      return [...words, ...cjk]
    }
    const index = new MiniSearch<{ id: string; title: string; preview: string; content: string }>({ fields: ['title', 'preview', 'content'], storeFields: ['id'], tokenize })
    index.addAll(pages.map((page) => ({ id: page.id, title: page.title, preview: page.preview, content: textByPage.get(page.id) ?? '' })))
    // A Chinese phrase yields both a full token and overlapping CJK bigrams.
    // MiniSearch's default OR combination can otherwise rank pages sharing one
    // common bigram above an exact title match. Keep exact substring matches at
    // the front, then require all query tokens, and use fuzzy OR only as a
    // last-resort completion set.
    const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim()
    const exactIds = pages
      .filter((page) => `${page.title}\n${page.preview}\n${textByPage.get(page.id) ?? ''}`.normalize('NFKC').toLocaleLowerCase().includes(normalizedQuery))
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
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(extractText).filter(Boolean).join(' ')
}
