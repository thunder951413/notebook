import { MAX_AUTOSAVE_REVISIONS_PER_PAGE, MAX_PINNED_REVISIONS_PER_PAGE, NotebookRendererDatabase } from '../database'
import type { SyncOutboxItem } from '../database'
import { SearchCache } from '../search'

/** Publication order: containers before what they contain. Deletes run in reverse. */
const SYNC_DEPENDENCY_RANK: Record<string, number> = {
  notebook: 10, section: 20, tag: 25, page: 30, document: 40, page_tag: 45, task_step: 50,
  asset: 50, page_link: 55, reading_position: 60, revision: 70,
}

/**
 * Shared state and the primitives every repository layer uses: the Dexie
 * database, the search cache, entity versions, the sync outbox, revision
 * rings and privacy retraction.
 * Layers: core → content → sync → transfer → DexieNotebookRepository.
 */
export class RepositoryCore {
  protected readonly searchIndex = new SearchCache()

  constructor(readonly db = new NotebookRendererDatabase()) {}

  protected versionId(workspaceId: string, entityType: string, entityId: string) { return `${workspaceId}:${entityType}:${entityId}` }

  protected async pruneRevisionRing(workspaceId: string, pageId: string): Promise<void> {
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
  protected async coalescePendingAutosaveRevision(workspaceId: string, pageId: string): Promise<void> {
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

  /**
   * Oldest-first, parents before children. IndexedDB returns equal index keys
   * in random primary-key (UUID) order, so a bare `workspaceId` read could hand
   * a document to the journal before its page. Rows queued within the same
   * millisecond are never split across two batches.
   */
  async listOutbox(workspaceId: string, limit = 200) {
    const items = await this.db.syncOutbox.where('[workspaceId+createdAt]').between([workspaceId, ''], [workspaceId, '\uffff']).limit(limit).toArray()
    const last = items[items.length - 1]
    if (items.length >= limit && last) {
      const ids = new Set(items.map((item) => item.id))
      const ties = await this.db.syncOutbox.where('[workspaceId+createdAt]').equals([workspaceId, last.createdAt]).toArray()
      items.push(...ties.filter((item) => !ids.has(item.id)))
    }
    const rank = (item: SyncOutboxItem) => {
      const value = SYNC_DEPENDENCY_RANK[item.entityType] ?? 50
      return item.operation === 'delete' ? 200 - value : value
    }
    return items.sort((left, right) => rank(left) - rank(right) || left.createdAt.localeCompare(right.createdAt))
  }
  async hasPendingSyncChanges(workspaceId: string) { return Boolean(await this.db.syncOutbox.where('workspaceId').equals(workspaceId).first()) }
  getSyncCursor(workspaceId: string) { return this.db.syncCursors.get(workspaceId).then((value) => value?.cursor ?? 0) }

  /** Private entities use encrypted publication when a sync key is configured;
   * otherwise the transport keeps them local. */
  protected async isPrivatePage(pageId: string): Promise<boolean> {
    const page = await this.db.pages.get(pageId)
    if (!page) return false
    if (page.locked) return true
    if (!page.sectionId) return false
    const section = await this.db.sections.get(page.sectionId)
    return Boolean(section && (await this.db.notebooks.get(section.notebookId))?.locked)
  }

  protected sameRemoteEntity(left: object | undefined, right: object | undefined): boolean {
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

  protected async queuePrivacyRetractionIfPublished(workspaceId: string, entityType: string, entityId: string) {
    if (!await this.db.syncVersions.get(this.versionId(workspaceId, entityType, entityId))) return
    await this.enqueueChange(workspaceId, entityType, entityId, 'delete', { privacyRetraction: true })
  }

  /** A section turned private: retract it and every page that was still public. */
  protected async retractPublicSectionForPrivacy(workspaceId: string, sectionId: string) {
    await this.queuePrivacyRetractionIfPublished(workspaceId, 'section', sectionId)
    for (const page of await this.db.pages.where('sectionId').equals(sectionId).toArray()) {
      if (!page.locked) await this.retractPublicPageForPrivacy(workspaceId, page.id)
    }
  }

  protected async retractPublicPageForPrivacy(workspaceId: string, pageId: string) {
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

  /** WebDAV per-device read positions (stored next to the generic cursor so they commit with applied data). */
  async getWebdavSeqs(key: string): Promise<Record<string, number> | undefined> {
    return (await this.db.syncCursors.get(`webdav:${key}`))?.seqs
  }

  async saveWebdavSeqs(key: string, seqs: Record<string, number>): Promise<void> {
    await this.db.syncCursors.put({ workspaceId: `webdav:${key}`, cursor: 0, seqs })
  }

  /**
   * Preserve the other device's body as a new page next to the original. The
   * copy is an ordinary pending page, so every device receives it and nothing
   * is lost even when nobody looks at the conflict right away.
   */
}
