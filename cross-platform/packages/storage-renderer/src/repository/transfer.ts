import type { Page, UUID, NotebookDataBundle, PageRevision } from '@notebook/domain'
import { MAX_AUTOSAVE_REVISIONS_PER_PAGE, MAX_PINNED_REVISIONS_PER_PAGE } from '../database'
import { compactRevisionHistory, preserveChangesSinceSnapshot } from '../rebase'
import { SyncRepository } from './sync'

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

/** Import/export bundles, sync snapshots and complete backups. */
export class TransferRepository extends SyncRepository {
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

}
