import { extractText } from '../util'
import type {
  Notebook,
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
  ReadingPosition,
  Tombstone,
  PageRevision,
} from '@notebook/domain'
import { legacyTiptapToCanonicalMarkdown, markdownToEditorCache, tiptapToMarkdown } from '@notebook/sync-contract'
import { MAX_EDITOR_CACHE_BYTES } from '../database'
import { remapAssetReferences } from '../remotePayload'
import { normalizeSearch } from '../search'
import { RepositoryCore } from './core'

/** Local content: notebooks, sections, pages and documents, tags, task steps, drafts, trash, links, assets and revisions. */
export class ContentRepository extends RepositoryCore {
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
  /** Tags by name, creating (and publishing) the ones that do not exist yet. */
  async ensureTags(workspaceId: UUID, names: string[], now = new Date().toISOString()): Promise<Tag[]> {
    const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    const result: Tag[] = []
    await this.db.transaction('rw', [this.db.tags, this.db.syncOutbox, this.db.syncVersions], async () => {
      const existing = (await this.db.tags.where('workspaceId').equals(workspaceId).toArray()).filter((tag) => !tag.deletedAt)
      for (const name of wanted) {
        const found = existing.find((tag) => tag.name === name)
        if (found) { result.push(found); continue }
        const tag: Tag = { id: crypto.randomUUID(), workspaceId, name, color: 'gray', createdAt: now, updatedAt: now }
        await this.db.tags.put(tag)
        await this.enqueueChange(workspaceId, 'tag', tag.id, 'upsert', { ...tag })
        result.push(tag)
      }
    })
    return result
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
    this.searchIndex.upsert(page, document ? document.markdown ?? extractText(document.tiptapJson) : undefined)
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
    // Drop just this page from a built index; invalidating would make the next
    // lookup re-read every document in the library.
    this.searchIndex.upsert({ ...page, deletedAt, syncStatus: 'pending', updatedAt: deletedAt })
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
    this.searchIndex.upsert({ ...page, deletedAt: effectiveDeletedAt })
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
}
