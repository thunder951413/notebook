import type { Notebook, Page, PageDocument, Section, Tag, TaskStep, PageLink, Asset, PageTag, ReadingPosition, PageRevision } from '@notebook/domain'
import { legacyTiptapToCanonicalMarkdown, markdownToEditorCache } from '@notebook/sync-contract'
import { type SyncOutboxItem } from '../database'
import { parseRemotePayload, remapAssetReferences, type RemoteApplyResult, type RemoteQuarantineInput, type RemoteSyncChange } from '../remotePayload'
import type { QuarantineReason, SyncQuarantineItem } from '../database'
import { ContentRepository } from './content'

/** More open quarantine rows than this stop the pull: setting aside more would hide real trouble. */
export const MAX_QUARANTINE_ITEMS = 1000
const SUPPORTED_ENTITY_TYPES = new Set(['notebook', 'section', 'page', 'document', 'tag', 'task_step', 'asset', 'page_link', 'reading_position', 'revision', 'page_tag'])
export const isSupportedSyncEntityType = (entityType: string) => SUPPORTED_ENTITY_TYPES.has(entityType)

class RecordRejected extends Error {
  constructor(readonly reason: QuarantineReason, message: string) { super(message) }
}

/** Outbox acknowledgement and applying remote changes (WebDAV merge and conflict copies). */
export class SyncRepository extends ContentRepository {
  listQuarantine(): Promise<SyncQuarantineItem[]> { return this.db.syncQuarantine.toArray().then((items) => items.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.seq - b.seq)) }
  countQuarantine(): Promise<number> { return this.db.syncQuarantine.count() }
  /** Permanently drop set-aside records (the user confirmed they are not wanted). */
  async dismissQuarantine(ids: string[]): Promise<void> { await this.db.syncQuarantine.bulkDelete(ids) }

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

  protected async conflictPageIds(change: RemoteSyncChange, payload?: Record<string, unknown>) {
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

  protected async currentRemoteEntity(change: RemoteSyncChange): Promise<Record<string, unknown> | undefined> {
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

  /**
   * Store set-aside records and release the ones that applied. Runs inside the
   * apply transaction, so a record is either applied, set aside or still
   * unread, never lost between the three.
   */
  private async writeQuarantine(workspaceId: string, items: RemoteQuarantineInput[], release: string[]): Promise<void> {
    if (!items.length && !release.length) return
    const now = new Date().toISOString()
    const idOf = (item: RemoteQuarantineInput) => `${item.repository}|${item.deviceId}|${item.seq}`
    const kept = new Set(items.map(idOf))
    const gone = release.filter((id) => !kept.has(id))
    if (gone.length) await this.db.syncQuarantine.bulkDelete(gone)
    const existing = new Map((await this.db.syncQuarantine.bulkGet([...kept])).map((row, index) => [[...kept][index]!, row]))
    const unseen = [...kept].filter((id) => !existing.get(id)).length
    if (unseen && await this.db.syncQuarantine.count() + unseen > MAX_QUARANTINE_ITEMS) {
      throw new Error(`同步问题过多（超过 ${MAX_QUARANTINE_ITEMS} 条），请先在“同步问题”中处理或删除`)
    }
    await this.db.syncQuarantine.bulkPut(items.map((item): SyncQuarantineItem => {
      const id = idOf(item)
      const before = existing.get(id)
      return { ...item, id, workspaceId, attempts: (before?.attempts ?? 0) + 1, firstSeenAt: before?.firstSeenAt ?? now, lastTriedAt: now }
    }))
  }

  /** A tombstone without a live row means the entity (or its page) was permanently deleted. */
  protected async isPermanentlyDeleted(change: RemoteSyncChange, pageIds: string[]): Promise<boolean> {
    if (change.entityType === 'section') {
      return Boolean(await this.db.tombstones.get(`section:${change.entityId}`)) && !await this.db.sections.get(change.entityId)
    }
    // Notebooks and tags have no tombstones; a section/tag change only lists
    // the pages it touches, which says nothing about the entity itself.
    if (change.entityType === 'notebook' || change.entityType === 'tag') return false
    for (const pageId of pageIds) {
      if (await this.db.tombstones.get(`page:${pageId}`) && !await this.db.pages.get(pageId)) return true
    }
    return false
  }

  protected async createConflictCopy(workspaceId: string, pageId: string, remote: Record<string, unknown>): Promise<string> {
    const source = await this.db.pages.get(pageId)
    const now = new Date().toISOString()
    const copyId = crypto.randomUUID()
    const markdown = typeof remote.markdown === 'string' ? remote.markdown : legacyTiptapToCanonicalMarkdown(remote.tiptapJson as Record<string, unknown>)
    const assets = source ? await this.db.assets.where('pageId').equals(pageId).toArray() : []
    const referenced = assets.filter((asset) => markdown.includes(`notebook-asset:${asset.id}`))
    const assetIds = new Map(referenced.map((asset) => [asset.id, crypto.randomUUID()]))
    const date = new Date()
    const stamp = `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    const firstLine = markdown.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean)
    const baseTitle = source?.title?.trim() || firstLine?.slice(0, 60) || '未命名笔记'
    const page: Page = {
      ...(source ?? { workspaceId, kind: 'document' as const, favorite: false }),
      id: copyId,
      workspaceId,
      title: `${baseTitle}（冲突副本 ${stamp}）`,
      preview: markdown.replace(/[#>*_`~[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
      sortOrder: (source?.sortOrder ?? 0) + 0.5,
      treeUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
      legacyVersion: undefined,
      legacyMetadata: undefined,
      syncStatus: 'pending',
    }
    const document: PageDocument = {
      ...(remote as unknown as PageDocument),
      pageId: copyId,
      schemaVersion: Math.max(3, Number(remote.schemaVersion) || 3),
      markdown: remapAssetReferences(markdown, assetIds) as string,
      tiptapJson: markdownToEditorCache(remapAssetReferences(markdown, assetIds) as string) as Record<string, unknown>,
      yjsState: undefined,
      updatedAt: now,
    }
    await this.savePage(page, document)
    for (const asset of referenced) {
      const id = assetIds.get(asset.id)!
      const copied: Asset = { ...asset, id, pageId: copyId, parentAssetId: undefined, createdAt: now }
      const content = await this.getAssetContent(asset.id)
      if (content) await this.saveAsset(copied, content)
    }
    return copyId
  }

  async applyRemoteChanges(workspaceId: string, changes: RemoteSyncChange[], cursor: number, assetContents?: Map<string, Uint8Array>, webdavParentVersion = false, keepLocal = false, options: { autoResolve?: boolean; webdavSeqs?: { key: string; seqs: Record<string, number> }; quarantine?: RemoteQuarantineInput[]; releaseQuarantine?: string[] } = {}): Promise<RemoteApplyResult> {
    if (keepLocal && !webdavParentVersion) throw new Error('Local conflict recovery is only supported for WebDAV')
    const autoResolve = options.autoResolve === true && webdavParentVersion && !keepLocal
    return this.db.transaction('rw', this.db.tables, async () => {
      const previousCursor = await this.getSyncCursor(workspaceId)
      let appliedCursor = cursor
      const conflicts: RemoteApplyResult['conflicts'] = []
      const resolved: NonNullable<RemoteApplyResult['resolved']> = []
      const discarded: NonNullable<RemoteApplyResult['discarded']> = []
      const setAside: RemoteQuarantineInput[] = [...(options.quarantine ?? [])]
      /**
       * Concurrent edits never stop synchronization. Local content stays the
       * visible version and is republished as the successor of the remote
       * branch; a differing remote body becomes a separate conflict copy.
       */
      const settleConflict = async (change: RemoteSyncChange, payload: Record<string, unknown> | undefined, current: Record<string, unknown> | undefined, pending: SyncOutboxItem | undefined, localVersion: { version: number } | undefined, pageIds: string[]) => {
        const version = Math.max(localVersion?.version ?? 0, pending?.expectedVersion ?? 0, change.version + 1)
        await this.db.syncVersions.put({ id: this.versionId(workspaceId, change.entityType, change.entityId), version, webdavParentVersion: true })
        if (pending) await this.db.syncOutbox.update(pending.id, { expectedVersion: version })
        let copyPageId: string | undefined
        if (change.entityType === 'document' && change.operation === 'upsert' && payload) {
          const remoteMarkdown = typeof payload.markdown === 'string' ? payload.markdown : legacyTiptapToCanonicalMarkdown(payload.tiptapJson as Record<string, unknown>)
          const localMarkdown = current ? (typeof current.markdown === 'string' ? current.markdown : legacyTiptapToCanonicalMarkdown(current.tiptapJson as Record<string, unknown>)) : undefined
          if (remoteMarkdown.trim() && remoteMarkdown.trim() !== localMarkdown?.trim()) copyPageId = await this.createConflictCopy(workspaceId, change.entityId, payload)
        }
        if (pageIds.length) await this.db.pages.where('id').anyOf(pageIds).and((page) => page.syncStatus === 'conflict').modify({ syncStatus: 'pending' })
        resolved.push({ entityType: change.entityType, entityId: change.entityId, pageIds, ...(copyPageId ? { copyPageId } : {}) })
      }
      for (const change of changes) {
        // A record this device cannot understand is set aside, not fatal: it
        // would otherwise stop every device on the same entry forever. Callers
        // that cannot say where a record came from keep the old behaviour.
        let payload: Record<string, unknown> | undefined
        try {
          if (!isSupportedSyncEntityType(change.entityType)) throw new RecordRejected('unknown-type', `不支持的记录类型：${change.entityType}`)
          if (!Number.isSafeInteger(change.version) || change.version < 0 || !['upsert', 'delete'].includes(change.operation)) throw new RecordRejected('invalid-payload', `记录版本或操作不正确：${change.entityType}:${change.entityId}`)
          payload = change.operation === 'upsert' ? parseRemotePayload(change) : undefined
          if (payload && typeof payload.workspaceId === 'string' && payload.workspaceId !== workspaceId) throw new RecordRejected('workspace-mismatch', `${change.entityType} 属于其他工作区`)
        } catch (error) {
          const source = change.source
          if (!source) throw error instanceof RecordRejected ? new Error(`Invalid remote change for ${change.entityType}:${change.entityId}: ${error.message}`) : error
          setAside.push({
            ...source, entityType: change.entityType, entityId: change.entityId, version: change.version, operation: change.operation === 'delete' ? 'delete' : 'upsert',
            reason: error instanceof RecordRejected ? error.reason : 'invalid-payload',
            message: error instanceof Error ? error.message.slice(0, 300) : String(error),
            stage: 'apply', raw: change.payload, ...(change.authenticatedPrivate ? { authenticated: true } : {}),
          })
          continue
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
        // Deletion wins: an entity that was permanently deleted here must not
        // be brought back by a peer's older branch. The deletion is re-queued
        // as the successor of that branch so the peer converges too.
        if (change.operation === 'upsert' && await this.isPermanentlyDeleted(change, pageIds)) {
          if (!change.ownDevice) {
            discarded.push({ entityType: change.entityType, entityId: change.entityId })
            if (change.entityType === 'page' || change.entityType === 'section') {
              const known = await this.db.syncVersions.get(this.versionId(workspaceId, change.entityType, change.entityId))
              await this.db.syncVersions.put({ id: this.versionId(workspaceId, change.entityType, change.entityId), version: Math.max(known?.version ?? 0, change.version + 1), webdavParentVersion: true })
              await this.enqueueChange(workspaceId, change.entityType, change.entityId, 'delete', {})
            }
          }
          continue
        }
        const pendingExact = await this.db.syncOutbox.where('[entityType+entityId]').equals([change.entityType, change.entityId]).and((item) => item.workspaceId === workspaceId).first()
        // A metadata-only local edit does not compete with a remote body.
        const pendingPage = change.entityType === 'document' && !autoResolve
          ? await this.db.syncOutbox.where('[entityType+entityId]').equals(['page', change.entityId]).and((item) => item.workspaceId === workspaceId).first()
          : undefined
        const pending = pendingExact ?? pendingPage
        const current = await this.currentRemoteEntity(change)
        const localVersion = await this.db.syncVersions.get(this.versionId(workspaceId, change.entityType, change.entityId))
        // Our own journal only replays work this device already has. A lost
        // read cursor must never turn that replay into a conflict.
        if (change.ownDevice && !keepLocal && (pendingExact || (localVersion && localVersion.version >= change.version + 1))) continue
        // With local edits queued, an entry older than the accepted baseline is
        // an ancestor that this device has already moved past.
        if (autoResolve && pendingExact && localVersion && change.version + 1 < localVersion.version) continue
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
        } else if (pending && autoResolve) {
          await settleConflict(change, payload, current, pending, localVersion, pageIds)
          continue
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
          if (autoResolve) {
            await settleConflict(change, payload, current, undefined, localVersion, pageIds)
            continue
          }
          if (pageIds.length) await this.db.pages.where('id').anyOf(pageIds).modify({ syncStatus: 'conflict' })
          conflicts.push({ entityType: change.entityType, entityId: change.entityId, pageIds })
          appliedCursor = Math.max(previousCursor, change.cursor - 1)
          break
        }
        if (change.operation === 'delete') {
          // A remote delete is a permanent delete (trash is published as an
          // upsert). Record it, and for pages remove everything that belongs
          // to the page. A privacy retraction is only a hidden public copy:
          // the encrypted successor follows, so it must leave no tombstone.
          const retraction = change.payload?.privacyRetraction === true
          if ((change.entityType === 'page' || change.entityType === 'section') && !retraction) {
            await this.db.tombstones.put({ id: `${change.entityType}:${change.entityId}`, workspaceId, entityType: change.entityType, entityId: change.entityId, deletedAt: new Date().toISOString(), deviceId: 'remote' })
          }
          if (change.entityType === 'page' && !retraction) await this.deletePageRows(change.entityId)
          else if (change.entityType === 'page') await this.db.pages.delete(change.entityId)
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
      await this.writeQuarantine(workspaceId, setAside, options.releaseQuarantine ?? [])
      await this.db.syncCursors.put({ workspaceId, cursor: appliedCursor })
      if (options.webdavSeqs && !conflicts.length) await this.db.syncCursors.put({ workspaceId: `webdav:${options.webdavSeqs.key}`, cursor: 0, seqs: options.webdavSeqs.seqs })
      return {
        cursor: appliedCursor, conflicts, ...(resolved.length ? { resolved } : {}), ...(discarded.length ? { discarded } : {}),
        ...(setAside.length ? { quarantined: setAside.map((item) => ({ entityType: item.entityType, entityId: item.entityId, reason: item.reason })) } : {}),
      }
    })
      .then((result) => {
        this.searchIndex.invalidate(workspaceId)
        return result
      })
  }

}
