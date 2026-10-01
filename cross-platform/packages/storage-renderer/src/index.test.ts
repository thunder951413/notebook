import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, test, vi } from 'vitest'
import type { Page, PageDocument } from '@notebook/domain'
import { DexieNotebookRepository, MAX_AUTOSAVE_REVISIONS_PER_PAGE, NotebookRendererDatabase } from './index'

const opened: NotebookRendererDatabase[] = []
const makeRepository = () => {
  const db = new NotebookRendererDatabase(`test-${crypto.randomUUID()}`)
  opened.push(db)
  return new DexieNotebookRepository(db)
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (db) => { db.close(); await db.delete() }))
})

const page = (id: string, title: string, sectionId = 'section-a'): Page => ({
  id,
  workspaceId: 'workspace-a',
  sectionId,
  kind: 'document',
  title,
  preview: `${title} preview`,
  favorite: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  syncStatus: 'local',
})

test('unchanged tags, task steps, links and reading positions do not create sync traffic', async () => {
  const repository = makeRepository()
  const value = page('quiet-page', 'Quiet')
  await repository.savePage(value)
  const steps = [0, 1, 2].map((index) => ({ id: `step-${index}`, pageId: value.id, text: `${index}`, checked: false, sortOrder: index, createdAt: value.createdAt }))
  const link = { id: 'link-1', workspaceId: value.workspaceId, sourcePageId: value.id, targetPageId: 'other', kind: 'link' as const, createdAt: value.createdAt }
  const position = { id: value.id, pageId: value.id, anchorUtf16Offset: 0, viewportOffsetFraction: 0.5, updatedAt: value.updatedAt, deviceId: 'device-1' }
  await repository.savePageTags(value.id, ['a', 'b'])
  await repository.saveTaskSteps(value.id, steps)
  await repository.replacePageLinks(value.id, [link])
  await repository.saveReadingPosition(position)
  await repository.db.syncOutbox.clear()
  await repository.savePageTags(value.id, ['b', 'a', 'a'])
  await repository.saveTaskSteps(value.id, steps)
  await repository.replacePageLinks(value.id, [link])
  await repository.saveReadingPosition({ ...position, updatedAt: '2026-09-04T00:00:00.000Z' })
  expect(await repository.hasPendingSyncChanges(value.workspaceId)).toBe(false)
  await repository.savePageTags(value.id, ['b', 'c'])
  await repository.saveTaskSteps(value.id, steps.map((step, index) => index === 1 ? { ...step, checked: true } : step))
  const outgoing = await repository.listOutbox(value.workspaceId)
  expect(outgoing).toHaveLength(3)
  expect(outgoing).toEqual(expect.arrayContaining([
    expect.objectContaining({ entityId: `${value.id}:a`, operation: 'delete' }),
    expect.objectContaining({ entityId: `${value.id}:c`, operation: 'upsert' }),
    expect.objectContaining({ entityId: 'step-1', payload: expect.objectContaining({ checked: true }) }),
  ]))
})

test('identical queued saves keep their id, while an edit during upload survives and uses the acknowledged parent', async () => {
  const repository = makeRepository()
  const value = { ...page('in-flight', 'Initial'), syncStatus: 'pending' as const }
  await repository.savePage(value)
  const [original] = await repository.listOutbox(value.workspaceId)
  await repository.savePage(value)
  expect((await repository.listOutbox(value.workspaceId))[0]?.id).toBe(original!.id)
  await repository.savePage({ ...value, title: 'Edited during upload' })
  const [newer] = await repository.listOutbox(value.workspaceId)
  expect(newer!.id).not.toBe(original!.id)
  await repository.acknowledgeSync(value.workspaceId, [{ operation_id: original!.id, entity_type: 'page', entity_id: value.id, version: 1 }], undefined, true)
  expect(await repository.listOutbox(value.workspaceId)).toEqual([expect.objectContaining({ id: newer!.id, expectedVersion: 1, payload: expect.objectContaining({ title: 'Edited during upload' }) })])
  expect((await repository.getPage(value.id))?.syncStatus).toBe('pending')
})

test('an unchanged editor flush does not publish timestamp-only changes or discard a newer draft', async () => {
  const repository = makeRepository()
  const value = { ...page('no-op-flush', 'Saved'), syncStatus: 'synced' as const }
  const document = { pageId: value.id, schemaVersion: 3, markdown: 'unchanged', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  const flushed = { ...document, updatedAt: '2026-09-04T00:00:00.000Z' }
  await repository.stageDraft(flushed)
  await repository.savePage({ ...value, syncStatus: 'pending', updatedAt: flushed.updatedAt }, flushed)
  expect(await repository.listOutbox(value.workspaceId)).toEqual([])
  expect(await repository.getPage(value.id)).toEqual(value)
  expect(await repository.getPageDocument(value.id)).toEqual(document)
  expect(await repository.db.drafts.get(value.id)).toBeUndefined()
  const newer = { ...document, markdown: 'new unsaved edit', updatedAt: '2026-09-04T01:00:00.000Z' }
  await repository.stageDraft(newer)
  await repository.savePage({ ...value, syncStatus: 'pending', updatedAt: flushed.updatedAt }, flushed)
  expect((await repository.db.drafts.get(value.id))?.document).toEqual(newer)
})

test('explicit WebDAV recovery preserves local content and rebases queued writes beyond all remote parents', async () => {
  const repository = makeRepository()
  const local = { ...page('recover-local', '本机会议记录'), important: true, legacyMetadata: { syncBaselineHash: 'local' } }
  await repository.savePage(local, { pageId: local.id, schemaVersion: 3, markdown: '本机正文', tiptapJson: { type: 'doc', content: [] }, updatedAt: local.updatedAt })
  await repository.db.syncVersions.put({ id: `workspace-a:page:${local.id}`, version: 1 })
  const remote = { ...local, title: '远端旧标题', important: false, legacyMetadata: {} }
  const change = { cursor: 1, entityType: 'page', entityId: local.id, version: 0, operation: 'upsert', payload: remote }
  expect((await repository.applyRemoteChanges('workspace-a', [change], 1, undefined, true)).conflicts).toHaveLength(1)
  const result = await repository.applyRemoteChanges('workspace-a', [change, { ...change, cursor: 2, version: 7 }], 2, undefined, true, true)
  expect(result).toEqual({ cursor: 2, conflicts: [] })
  expect(await repository.getPage(local.id)).toMatchObject({ title: local.title, important: true, legacyMetadata: local.legacyMetadata, syncStatus: 'pending' })
  expect((await repository.getPageDocument(local.id))?.markdown).toBe('本机正文')
  const outgoing = (await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'page')!
  expect(outgoing).toMatchObject({ expectedVersion: 8, payload: { title: local.title, important: true } })
  // Failed transport leaves the choice durable. Successful publication makes
  // the next ordinary change use the resulting (not old legacy) baseline.
  await repository.acknowledgeSync('workspace-a', [{ operation_id: outgoing.id, entity_type: 'page', entity_id: local.id, version: 9 }], undefined, true)
  expect((await repository.applyRemoteChanges('workspace-a', [{ ...change, cursor: 3, version: 9, payload: { ...local, title: '之后的正常远端修改' } }], 3, undefined, true)).conflicts).toEqual([])
  expect((await repository.getPage(local.id))?.title).toBe('之后的正常远端修改')
})

test('WebDAV recovery preserves local deletes, imports remote-only pages, and keeps private data local', async () => {
  const repository = makeRepository()
  await repository.db.syncVersions.put({ id: 'workspace-a:page:deleted-page', version: 4, webdavParentVersion: true })
  await repository.enqueueChange('workspace-a', 'page', 'deleted-page', 'delete', {})
  const privatePage = { ...page('private-page', '不公开'), locked: true }
  await repository.db.pages.put(privatePage)
  const changes = ['deleted-page', 'remote-only', 'private-page'].map((id, index) => ({ cursor: index + 1, entityType: 'page', entityId: id, version: 0, operation: 'upsert', payload: { ...page(id, '远端') } }))
  expect((await repository.applyRemoteChanges('workspace-a', changes, 3, undefined, true, true)).conflicts).toEqual([])
  expect(await repository.getPage('deleted-page')).toBeUndefined()
  expect((await repository.getPage('remote-only'))?.title).toBe('远端')
  expect(await repository.getPage('private-page')).toEqual(privatePage)
  expect(await repository.listOutbox('workspace-a')).toEqual([expect.objectContaining({ entityId: 'deleted-page', operation: 'delete', expectedVersion: 4 })])
})

test('atomically saves and loads a page with its document', async () => {
  const repository = makeRepository()
  const value = page('page-a', 'Knowledge Graph')
  const document: PageDocument = { pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc' }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  expect(await repository.getPage(value.id)).toEqual(value)
  expect(await repository.getPageDocument(value.id)).toEqual(document)
})

test('keeps parsed editor caches local, versioned, and disposable', async () => {
  const repository = makeRepository()
  const value = page('cached-page', 'Large Markdown')
  const document: PageDocument = {
    pageId: value.id,
    schemaVersion: 3,
    markdown: '# Large Markdown',
    tiptapJson: { type: 'doc', content: [] },
    updatedAt: value.updatedAt,
  }
  const parsed = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Large Markdown' }] }] }
  await repository.savePage(value, document)
  await repository.saveEditorCache(value.id, 'version-a', parsed)

  expect(await repository.getEditorCache(value.id, 'version-a')).toEqual(parsed)
  expect((await repository.exportData(value.workspaceId)).documents[0]?.tiptapJson).toEqual(document.tiptapJson)
  expect(await repository.getEditorCache(value.id, 'version-b')).toBeUndefined()
})

test('upgrades legacy rich-text bodies to canonical Markdown with a recovery revision and sync baseline', async () => {
  const name = `legacy-upgrade-${crypto.randomUUID()}`
  const legacy = new Dexie(name)
  legacy.version(9).stores({
    notebooks: 'id, workspaceId, sortOrder, updatedAt, deletedAt',
    sections: 'id, notebookId, parentSectionId, sortOrder, updatedAt, deletedAt',
    pages: 'id, workspaceId, sectionId, kind, updatedAt, deletedAt, syncStatus, *title',
    documents: 'pageId, updatedAt',
    tags: 'id, workspaceId, name, updatedAt, deletedAt',
    taskSteps: 'id, pageId, sortOrder',
    pageLinks: 'id, workspaceId, sourcePageId, targetPageId, kind',
    knowledgeEntities: 'id, workspaceId, name, type, *sourcePageIds, updatedAt',
    knowledgeRelations: 'id, workspaceId, sourceEntityId, targetEntityId, type, evidencePageId, updatedAt',
    assets: 'id, pageId, kind, checksum',
    pageTags: '[pageId+tagId], pageId, tagId',
    readingPositions: 'id, pageId, updatedAt',
    tombstones: 'id, workspaceId, entityType, entityId, deletedAt',
    syncOutbox: 'id, workspaceId, createdAt, [entityType+entityId]',
    syncCursors: 'workspaceId',
    syncVersions: 'id',
    assetContents: 'id',
    revisions: 'id, pageId, createdAt',
    comments: 'id, workspaceId, pageId, createdAt, resolvedAt',
    drafts: 'pageId, createdAt',
  })
  await legacy.open()
  const value = page('legacy-page', 'Legacy body')
  const document: PageDocument = {
    pageId: value.id,
    schemaVersion: 1,
    tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '# 标题\n\n[资料] (https://example.com)' }] }] },
    legacySource: { source: 'NotebookBlockDocument' },
    updatedAt: value.updatedAt,
  }
  await legacy.table('pages').put(value)
  await legacy.table('documents').put(document)
  await legacy.table('revisions').put({
    id: 'legacy-revision',
    pageId: value.id,
    document: {
      ...document,
      tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '较早正文' }] }] },
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    reason: 'autosave',
  })
  legacy.close()

  const db = new NotebookRendererDatabase(name)
  opened.push(db)
  await db.open()
  expect(await db.documents.get(value.id)).toMatchObject({
    schemaVersion: 3,
    markdown: '# 标题\n\n[资料](https://example.com)',
    tiptapJson: { type: 'doc', content: [] },
  })
  const revisions = await db.revisions.where('pageId').equals(value.id).toArray()
  expect(revisions).toHaveLength(1)
  expect(revisions[0]?.document).toMatchObject({
    schemaVersion: 3,
    markdown: '较早正文',
    tiptapJson: { type: 'doc', content: [] },
  })
  expect(await db.pages.get(value.id)).toMatchObject({
    syncStatus: 'pending',
    legacyMetadata: { syncBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
  })
})

test('coalesces repeated pending changes for the same entity', async () => {
  const repository = makeRepository()
  await repository.savePage({ ...page('page-a', 'First'), syncStatus: 'pending' })
  await repository.savePage({ ...page('page-a', 'Latest'), syncStatus: 'pending' })
  const outgoing = await repository.listOutbox('workspace-a')
  expect(outgoing).toHaveLength(1)
  expect(outgoing[0]?.payload.title).toBe('Latest')
  expect(outgoing[0]?.expectedVersion).toBe(0)
  expect(await repository.hasPendingSyncChanges('workspace-a')).toBe(true)
  await repository.acknowledgeSync('workspace-a', outgoing.map((item) => ({ operation_id: item.id, entity_type: item.entityType, entity_id: item.entityId, version: 1 })))
  expect(await repository.hasPendingSyncChanges('workspace-a')).toBe(false)
})

test('publishes only the newest pending autosave per page while retaining local history', async () => {
  const repository = makeRepository()
  const value = { ...page('page-autosave-coalesce', 'Draft'), syncStatus: 'pending' as const }
  const document = (markdown: string, updatedAt: string): PageDocument => ({
    pageId: value.id,
    schemaVersion: 3,
    markdown,
    tiptapJson: { type: 'doc', content: [] },
    updatedAt,
  })
  await repository.savePage(value, document('one', '2026-01-02T00:00:00.000Z'))
  await repository.savePage({ ...value, updatedAt: '2026-01-02T00:00:01.000Z' }, document('two', '2026-01-02T00:00:01.000Z'))
  await repository.savePage({ ...value, updatedAt: '2026-01-02T00:00:02.000Z' }, document('three', '2026-01-02T00:00:02.000Z'))

  const localRevisions = await repository.listRevisions(value.id)
  expect(localRevisions.filter((revision) => revision.reason === 'autosave')).toHaveLength(2)
  const pendingAutosaves = (await repository.listOutbox(value.workspaceId, 100))
    .filter((item) => item.entityType === 'revision' && item.payload.reason === 'autosave')
  expect(pendingAutosaves).toHaveLength(1)
  expect((pendingAutosaves[0]!.payload.document as PageDocument).markdown).toBe('two')

  await repository.createManualRevision(value.id)
  const pendingRevisions = (await repository.listOutbox(value.workspaceId, 100))
    .filter((item) => item.entityType === 'revision')
  expect(pendingRevisions.map((item) => item.payload.reason).sort()).toEqual(['autosave', 'manual'])
})

test('keeps revision history as a bounded per-page ring while preserving current content', async () => {
  const repository = makeRepository()
  const value = page('page-history-ring', 'Current')
  const current: PageDocument = {
    pageId: value.id,
    schemaVersion: 3,
    markdown: 'current body',
    tiptapJson: { type: 'doc' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  await repository.savePage(value, current)
  const changes = Array.from({ length: MAX_AUTOSAVE_REVISIONS_PER_PAGE + 5 }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    const id = `revision-${String(index).padStart(3, '0')}`
    return {
      cursor: index + 1,
      entityType: 'revision',
      entityId: id,
      version: 0,
      operation: 'upsert',
      payload: {
        id,
        pageId: value.id,
        document: { ...current, markdown: `history ${index}`, updatedAt: createdAt },
        createdAt,
        reason: 'autosave',
      },
    }
  })

  await repository.applyRemoteChanges('workspace-a', changes, changes.length)

  const revisions = await repository.listRevisions(value.id)
  expect(revisions).toHaveLength(MAX_AUTOSAVE_REVISIONS_PER_PAGE)
  expect(revisions.map((revision) => revision.id)).not.toContain('revision-000')
  expect(revisions.map((revision) => revision.id)).toContain(`revision-${String(MAX_AUTOSAVE_REVISIONS_PER_PAGE + 4).padStart(3, '0')}`)
  expect(await repository.getPageDocument(value.id)).toEqual(current)
})

test('queues page bodies and applies remote body updates and deletes', async () => {
  const repository = makeRepository()
  const value = { ...page('page-body', 'Body'), syncStatus: 'pending' as const }
  const document: PageDocument = { pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph' }] }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  const queued = await repository.listOutbox('workspace-a')
  expect(queued.map((item) => item.entityType).sort()).toEqual(['document', 'page'])
  await repository.acknowledgeSync('workspace-a', queued.map((item, index) => ({ operation_id: item.id, entity_type: item.entityType, entity_id: item.entityId, version: index + 1 })))
  await repository.applyRemoteChanges('workspace-a', [{ cursor: 1, entityType: 'document', entityId: value.id, version: 1, operation: 'upsert', payload: { ...document, tiptapJson: { type: 'doc', content: [] } } }], 1)
  expect((await repository.getPageDocument(value.id))?.tiptapJson).toEqual({ type: 'doc', content: [] })
  await repository.applyRemoteChanges('workspace-a', [{ cursor: 2, entityType: 'document', entityId: value.id, version: 2, operation: 'delete', payload: {} }], 2)
  expect(await repository.getPageDocument(value.id)).toBeUndefined()
})

test('keeps HTTP API resulting-version semantics separate from WebDAV parent versions', async () => {
  const repository = makeRepository()
  const value = { ...page('page-api-version', 'API result'), syncStatus: 'synced' as const }
  await repository.applyRemoteChanges('workspace-a', [{ cursor: 1, entityType: 'page', entityId: value.id, version: 7, operation: 'upsert', payload: value }], 1)
  expect(await repository.db.syncVersions.get(`workspace-a:page:${value.id}`)).toEqual({ id: `workspace-a:page:${value.id}`, version: 7 })
  await repository.savePage({ ...(await repository.getPage(value.id))!, title: 'next API edit', syncStatus: 'pending' })
  expect((await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'page')?.expectedVersion).toBe(7)
})

test('rejects malformed remote payloads and never overwrites a pending local body', async () => {
  const repository = makeRepository()
  const value = { ...page('page-protected', 'Local'), syncStatus: 'pending' as const }
  const document: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: 'local', tiptapJson: { type: 'doc' }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  await repository.applyRemoteChanges('workspace-a', [{
    cursor: 1, entityType: 'document', entityId: value.id, version: 1, operation: 'upsert',
    payload: { ...document, markdown: 'remote' },
  }], 1, undefined, true)
  expect(await repository.getPageDocument(value.id)).toMatchObject({ markdown: 'local' })
  expect(await repository.getPage(value.id)).toMatchObject({ syncStatus: 'conflict' })
  await expect(repository.applyRemoteChanges('workspace-a', [{
    cursor: 2, entityType: 'page', entityId: value.id, version: 2, operation: 'upsert',
    payload: { id: value.id, title: 'broken' },
  }], 2)).rejects.toThrow()
  expect(await repository.getPage(value.id)).toMatchObject({ title: 'Local' })
})

test('keeps a conflicted child entity pullable instead of advancing the cursor', async () => {
  const repository = makeRepository()
  const value = { ...page('page-asset-conflict', 'Local asset'), syncStatus: 'synced' as const }
  await repository.savePage(value)
  const localAsset = {
    id: 'asset-conflict',
    pageId: value.id,
    kind: 'image' as const,
    filename: 'local.png',
    mimeType: 'image/png',
    createdAt: value.createdAt,
  }
  await repository.saveAsset(localAsset, new Blob([new Uint8Array([1])], { type: 'image/png' }))
  const applied = await repository.applyRemoteChanges('workspace-a', [{
    cursor: 1,
    entityType: 'asset',
    entityId: localAsset.id,
    version: 1,
    operation: 'upsert',
    payload: { ...localAsset, filename: 'remote.png' },
  }], 1, undefined, true)

  expect(applied).toEqual({
    cursor: 0,
    conflicts: [{ entityType: 'asset', entityId: localAsset.id, pageIds: [value.id] }],
  })
  expect(await repository.getSyncCursor('workspace-a')).toBe(0)
  expect(await repository.db.assets.get(localAsset.id)).toMatchObject({ filename: 'local.png' })
  expect(await repository.getPage(value.id)).toMatchObject({ syncStatus: 'conflict' })
})

test('treats WebDAV ver as a parent version and preserves concurrent siblings as a visible conflict', async () => {
  const repository = makeRepository()
  const value = { ...page('page-parent-version', 'Remote one'), syncStatus: 'synced' as const }
  const first = await repository.applyRemoteChanges('workspace-a', [{
    cursor: 1, entityType: 'page', entityId: value.id, version: 0, operation: 'upsert', payload: value,
  }], 1, undefined, true)
  expect(first).toEqual({ cursor: 1, conflicts: [] })
  expect(await repository.db.syncVersions.get('workspace-a:page:page-parent-version')).toMatchObject({ version: 1, webdavParentVersion: true })

  // A duplicate journal row remains harmless and can be consumed.
  await expect(repository.applyRemoteChanges('workspace-a', [{
    cursor: 2, entityType: 'page', entityId: value.id, version: 0, operation: 'upsert', payload: value,
  }], 2, undefined, true)).resolves.toEqual({ cursor: 2, conflicts: [] })

  // A different record with the same parent version is a sibling concurrent
  // write; stopping before it prevents a deterministic-but-silent overwrite.
  const sibling = await repository.applyRemoteChanges('workspace-a', [{
    cursor: 3, entityType: 'page', entityId: value.id, version: 0, operation: 'upsert', payload: { ...value, title: 'Other device' },
  }], 3, undefined, true)
  expect(sibling).toEqual({ cursor: 2, conflicts: [{ entityType: 'page', entityId: value.id, pageIds: [value.id] }] })
  expect(await repository.getPage(value.id)).toMatchObject({ title: 'Remote one', syncStatus: 'conflict' })

  await repository.savePage({ ...(await repository.getPage(value.id))!, title: 'Local follow-up', syncStatus: 'pending' })
  expect((await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'page')?.expectedVersion).toBe(1)
})

test('consumes legacy directory bootstrap replays without losing richer local metadata', async () => {
  const repository = makeRepository()
  const local = { id: 'legacy-section', notebookId: 'personal', name: 'demux', color: '#7c3aed', sortOrder: 1, createdAt: '2026-07-24T07:54:48.994Z', updatedAt: '2026-07-24T07:55:01.172Z' }
  await repository.db.sections.put(local)
  await repository.db.syncVersions.put({ id: 'workspace-a:section:legacy-section', version: 1 })
  const { color: _color, ...snapshot } = local
  const replay = { cursor: 1, entityType: 'section', entityId: local.id, version: 0, operation: 'upsert' as const, payload: { ...snapshot, createdAt: local.updatedAt } }

  await expect(repository.applyRemoteChanges('workspace-a', [replay], 1, undefined, true)).resolves.toEqual({ cursor: 1, conflicts: [] })
  expect(await repository.db.sections.get(local.id)).toEqual(local)

  // Renames and explicit color changes still need conflict resolution.
  for (const patch of [{ name: 'Another name' }, { color: '#ffffff' }, { notebookId: 'another-notebook' }]) {
    const result = await repository.applyRemoteChanges('workspace-a', [{ ...replay, cursor: 2, payload: { ...replay.payload, ...patch } }], 2, undefined, true)
    expect(result.cursor).toBe(1)
    expect(result.conflicts).toHaveLength(1)
    expect(await repository.db.sections.get(local.id)).toEqual(local)
  }
  await repository.db.syncVersions.put({ id: 'workspace-a:section:legacy-section', version: 1, webdavParentVersion: true })
  expect((await repository.applyRemoteChanges('workspace-a', [{ ...replay, cursor: 2 }], 2, undefined, true)).conflicts).toHaveLength(1)
})

test('retains page placement when replaying a sparse legacy bootstrap snapshot', async () => {
  const repository = makeRepository()
  const local = { ...page('legacy-page', 'Original title'), sectionId: 'current-section', sortOrder: 3, syncStatus: 'synced' as const }
  await repository.db.pages.put(local)
  await repository.db.syncVersions.put({ id: 'workspace-a:page:legacy-page', version: 1 })
  const { sectionId: _section, sortOrder: _order, ...payload } = local
  const replay = { cursor: 1, entityType: 'page', entityId: local.id, version: 0, operation: 'upsert' as const, payload }
  await expect(repository.applyRemoteChanges('workspace-a', [replay], 1, undefined, true)).resolves.toEqual({ cursor: 1, conflicts: [] })
  expect(await repository.db.pages.get(local.id)).toEqual(local)
  const renamed = { ...replay, cursor: 2, payload: { ...payload, title: 'Remote rename' } }
  expect((await repository.applyRemoteChanges('workspace-a', [renamed], 2, undefined, true)).conflicts).toHaveLength(1)
  expect((await repository.getPage(local.id))?.title).toBe(local.title)
})

test('recognizes a legacy rich-text bootstrap only when its canonical body is identical', async () => {
  const repository = makeRepository()
  const localPage = { ...page('legacy-document', 'Same body'), syncStatus: 'conflict' as const }
  const local: PageDocument = { pageId: localPage.id, schemaVersion: 3, markdown: 'Same body', tiptapJson: { type: 'doc', content: [] }, updatedAt: localPage.updatedAt }
  await repository.db.pages.put(localPage)
  await repository.db.documents.put(local)
  await repository.db.syncVersions.put({ id: 'workspace-a:document:legacy-document', version: 1 })
  const payload = { pageId: localPage.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Same body' }] }] }, updatedAt: '2026-07-24T05:45:08.167Z' }
  const replay = { cursor: 1, entityType: 'document', entityId: localPage.id, version: 0, operation: 'upsert' as const, payload }
  await expect(repository.applyRemoteChanges('workspace-a', [replay], 1, undefined, true)).resolves.toEqual({ cursor: 1, conflicts: [] })
  expect(await repository.db.documents.get(localPage.id)).toEqual(local)
  expect((await repository.getPage(localPage.id))?.syncStatus).toBe('synced')
  const changed = { ...payload, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Different body' }] }] } }
  expect((await repository.applyRemoteChanges('workspace-a', [{ ...replay, cursor: 2, payload: changed }], 2, undefined, true)).conflicts).toHaveLength(1)
  expect(await repository.db.documents.get(localPage.id)).toEqual(local)
})

test('retracts previously published page data before keeping private edits local-only', async () => {
  const repository = makeRepository()
  const value = { ...page('page-private-retract', 'Public'), syncStatus: 'pending' as const }
  const document: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: 'public', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  const initial = await repository.listOutbox('workspace-a')
  await repository.acknowledgeSync('workspace-a', initial.map((item) => ({ operation_id: item.id, entity_type: item.entityType, entity_id: item.entityId, version: 1 })))
  const asset = { id: 'asset-private-retract', pageId: value.id, kind: 'image' as const, filename: 'public.png', mimeType: 'image/png', createdAt: value.createdAt }
  await repository.saveAsset(asset, new Blob([new Uint8Array([7])]))
  const pendingAsset = (await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'asset')!
  await repository.acknowledgeSync('workspace-a', [{ operation_id: pendingAsset.id, entity_type: 'asset', entity_id: asset.id, version: 1 }])

  await repository.savePage({ ...(await repository.getPage(value.id))!, locked: true, syncStatus: 'pending' }, { ...document, markdown: 'private', updatedAt: '2026-01-03T00:00:00.000Z' })
  const retractions = await repository.listOutbox('workspace-a')
  expect(retractions.filter((item) => item.payload.privacyRetraction).map((item) => `${item.operation}:${item.entityType}`).sort()).toEqual(['delete:asset', 'delete:document', 'delete:page'])
  const retractionFlags = await Promise.all(retractions.map((item) => repository.isPrivateSyncItem(item)))
  expect(retractions.map((item, index) => item.payload.privacyRetraction ? retractionFlags[index] : undefined).filter((flag) => flag !== undefined)).toEqual([false, false, false])

  // Subsequent changes cannot replace the public tombstone with a private
  // upsert, and stale remote history cannot reopen the page.
  await repository.savePage({ ...(await repository.getPage(value.id))!, title: 'Still private', locked: true, syncStatus: 'pending' })
  expect((await repository.listOutbox('workspace-a')).filter((item) => item.entityType === 'page')).toEqual([
    expect.objectContaining({ operation: 'delete', payload: { privacyRetraction: true } }),
  ])
  await repository.applyRemoteChanges('workspace-a', [{ cursor: 1, entityType: 'page', entityId: value.id, version: 1, operation: 'upsert', payload: { ...value, title: 'Old public copy', syncStatus: 'synced' } }], 1)
  expect(await repository.getPage(value.id)).toMatchObject({ title: 'Still private', locked: true })

  // Once encrypted publication is enabled, the retraction acknowledgement
  // durably queues the latest private data beyond the acknowledged parent.
  await repository.acknowledgeSync('workspace-a', retractions.map((item) => ({ operation_id: item.id, entity_type: item.entityType, entity_id: item.entityId, version: 2 })), undefined, true, true)
  const republished = await repository.listOutbox('workspace-a')
  expect(republished.find(item => item.entityType === 'page')).toMatchObject({ operation: 'upsert', expectedVersion: 2, payload: { title: 'Still private', locked: true } })
  expect(republished.find(item => item.entityType === 'document')).toMatchObject({ operation: 'upsert', expectedVersion: 2, payload: { markdown: 'private' } })
  expect(republished.find(item => item.entityType === 'asset')).toMatchObject({ operation: 'upsert', expectedVersion: 2, entityId: asset.id })
  expect(await Promise.all(republished.filter(item => ['page', 'document', 'asset'].includes(item.entityType)).map(item => repository.isPrivateSyncItem(item)))).toEqual([true, true, true])
  expect((await repository.getPage(value.id))?.syncStatus).toBe('pending')
})

test('applies remote asset metadata bytes and cursor atomically', async () => {
  const repository = makeRepository()
  const asset = { id: 'asset-atomic-remote', pageId: 'page-atomic-remote', kind: 'file' as const, filename: 'remote.bin', mimeType: 'application/octet-stream', createdAt: '2026-01-01T00:00:00.000Z' }
  const bytes = new Uint8Array([1, 2, 3])
  await repository.applyRemoteChanges('workspace-a', [{ cursor: 1, entityType: 'asset', entityId: asset.id, version: 0, operation: 'upsert', payload: asset }], 1, new Map([[asset.id, bytes]]))
  expect(await repository.db.assets.get(asset.id)).toMatchObject(asset)
  expect(new Uint8Array(await (await repository.getAssetContent(asset.id))!.arrayBuffer())).toEqual(bytes)
  expect(await repository.getSyncCursor('workspace-a')).toBe(1)
})

test('queues notebook hierarchy and task steps for cross-device sync', async () => {
  const repository = makeRepository()
  const notebook = { id: 'notebook-a', workspaceId: 'workspace-a', name: 'Synced', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  await repository.saveNotebook(notebook)
  await repository.saveSection({ id: 'section-a', notebookId: notebook.id, name: 'Section', sortOrder: 0, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt })
  await repository.savePage({ ...page('task-a', 'Task', 'section-a'), kind: 'task' })
  const step = { id: 'step-a', pageId: 'task-a', text: 'Do it', checked: false, sortOrder: 0, createdAt: notebook.createdAt }
  await repository.saveTaskSteps('task-a', [step])
  await repository.saveTaskSteps('task-a', [])
  const outgoing = await repository.listOutbox('workspace-a')
  expect(outgoing.map((item) => `${item.entityType}:${item.operation}`).sort()).toEqual(['notebook:upsert', 'section:upsert', 'task_step:delete'])
})

test('duplicates a page with its body, task steps, tags and attachment references', async () => {
  const repository = makeRepository()
  const value = { ...page('page-source', 'Source'), parentPageId: 'parent-page', sortOrder: 2000, treeUpdatedAt: '2026-01-02T00:00:00.000Z', kind: 'task' as const, syncStatus: 'pending' as const }
  const document: PageDocument = { pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'image', attrs: { src: 'notebook-asset:asset-source', legacyAssetId: 'asset-source' } }] }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  await repository.savePageTags(value.id, ['tag-a'])
  await repository.saveTaskSteps(value.id, [{ id: 'step-source', pageId: value.id, text: 'Step', checked: false, sortOrder: 0, createdAt: value.createdAt }])
  await repository.saveAsset({ id: 'asset-source', pageId: value.id, kind: 'image', filename: 'image.png', mimeType: 'image/png', createdAt: value.createdAt }, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))

  const copy = await repository.duplicatePage(value.id, 'page-copy', '2026-01-04T00:00:00.000Z')
  const copiedAssets = await repository.listAssets(copy.id)
  expect(copy.title).toBe('Source 副本')
  expect(copy).toMatchObject({ parentPageId: 'parent-page', sortOrder: 2001, treeUpdatedAt: '2026-01-04T00:00:00.000Z' })
  expect((await repository.listTaskSteps(copy.id))[0]).toMatchObject({ pageId: copy.id, text: 'Step' })
  expect(await repository.listPageTags(copy.id)).toEqual([{ pageId: copy.id, tagId: 'tag-a' }])
  expect(copiedAssets).toHaveLength(1)
  expect(await repository.getAssetContent(copiedAssets[0]!.id)).toBeInstanceOf(Blob)
  expect(JSON.stringify((await repository.getPageDocument(copy.id))?.tiptapJson)).toContain(`notebook-asset:${copiedAssets[0]!.id}`)
  expect(JSON.stringify((await repository.getPageDocument(copy.id))?.tiptapJson)).not.toContain('asset-source')
})

test('rolls back every copied entity when page duplication fails midway', async () => {
  const repository = makeRepository()
  const value = { ...page('page-copy-source', 'Source'), syncStatus: 'pending' as const }
  await repository.savePage(value, { pageId: value.id, schemaVersion: 3, markdown: 'Body', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt })
  await repository.savePageTags(value.id, ['tag-a'])
  await repository.saveTaskSteps(value.id, [{ id: 'step-source', pageId: value.id, text: 'Step', checked: false, sortOrder: 0, createdAt: value.createdAt }])
  await repository.saveAsset({ id: 'asset-copy-source', pageId: value.id, kind: 'file', filename: 'file.txt', mimeType: 'text/plain', createdAt: value.createdAt }, new Blob(['content']))
  const saveAsset = vi.spyOn(repository, 'saveAsset').mockRejectedValueOnce(new Error('injected copy failure'))

  await expect(repository.duplicatePage(value.id, 'page-copy-failed', '2026-01-04T00:00:00.000Z')).rejects.toThrow(/injected/)
  saveAsset.mockRestore()

  expect(await repository.getPage('page-copy-failed')).toBeUndefined()
  expect(await repository.getPageDocument('page-copy-failed')).toBeUndefined()
  expect(await repository.listTaskSteps('page-copy-failed')).toEqual([])
  expect(await repository.listPageTags('page-copy-failed')).toEqual([])
  expect(await repository.listAssets('page-copy-failed')).toEqual([])
  expect((await repository.listOutbox('workspace-a')).some((item) =>
    item.entityId === 'page-copy-failed' || item.payload.pageId === 'page-copy-failed')).toBe(false)
})

test('deletes a non-empty section with all page data and queues compatible tombstones', async () => {
  const repository = makeRepository()
  const notebook = { id: 'notebook-delete', workspaceId: 'workspace-a', name: 'Delete', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  await repository.saveNotebook(notebook)
  await repository.saveSection({ id: 'section-full', notebookId: notebook.id, name: 'Full', sortOrder: 0, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt })
  const sectionPage = page('page-in-section', 'Page', 'section-full')
  await repository.savePage(sectionPage, { pageId: sectionPage.id, schemaVersion: 3, markdown: 'Body', tiptapJson: { type: 'doc', content: [] }, updatedAt: sectionPage.updatedAt })
  await repository.saveAsset({ id: 'section-asset', pageId: sectionPage.id, kind: 'file', filename: 'file.txt', mimeType: 'text/plain', createdAt: notebook.createdAt }, new Blob(['content']))
  await repository.saveEditorCache(sectionPage.id, 'version-a', { type: 'doc', content: [{ type: 'paragraph' }] })
  await repository.deleteSection('section-full', '2026-01-04T00:00:00.000Z', 'test-device')

  expect(await repository.listSections(notebook.id)).toEqual([])
  expect(await repository.getPage(sectionPage.id)).toBeUndefined()
  expect(await repository.getPageDocument(sectionPage.id)).toBeUndefined()
  expect(await repository.listAssets(sectionPage.id)).toEqual([])
  expect(await repository.getEditorCache(sectionPage.id, 'version-a')).toBeUndefined()
  const tombstones = (await repository.exportData('workspace-a')).tombstones
  expect(tombstones).toContainEqual(expect.objectContaining({ entityType: 'page', entityId: sectionPage.id, deviceId: 'test-device' }))
  expect(tombstones).toContainEqual(expect.objectContaining({ entityType: 'section', entityId: 'section-full', deviceId: 'test-device' }))
  expect((await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'section')).toMatchObject({ operation: 'delete', entityId: 'section-full' })
})

test('rolls back a section cascade when a nested page purge fails', async () => {
  const repository = makeRepository()
  const notebook = { id: 'notebook-rollback', workspaceId: 'workspace-a', name: 'Rollback', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  await repository.saveNotebook(notebook)
  await repository.saveSection({ id: 'section-rollback', notebookId: notebook.id, name: 'Full', sortOrder: 0, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt })
  const sectionPage = page('page-rollback', 'Page', 'section-rollback')
  await repository.savePage(sectionPage, { pageId: sectionPage.id, schemaVersion: 3, markdown: 'Body', tiptapJson: { type: 'doc', content: [] }, updatedAt: sectionPage.updatedAt })
  const originalPurge = repository.purgePage.bind(repository)
  const purge = vi.spyOn(repository, 'purgePage').mockImplementationOnce(async (...args) => {
    await originalPurge(...args)
    throw new Error('injected cascade failure')
  })

  await expect(repository.deleteSection('section-rollback', '2026-01-04T00:00:00.000Z', 'test-device')).rejects.toThrow(/injected/)
  purge.mockRestore()

  expect((await repository.listSections(notebook.id)).map((section) => section.id)).toContain('section-rollback')
  expect(await repository.getPage(sectionPage.id)).toBeDefined()
  expect(await repository.getPageDocument(sectionPage.id)).toBeDefined()
  expect((await repository.exportData('workspace-a')).tombstones).not.toContainEqual(expect.objectContaining({ entityId: sectionPage.id }))
})

test('deletes a notebook together with non-empty sections and all page data', async () => {
  const repository = makeRepository()
  const notebook = { id: 'notebook-cascade', workspaceId: 'workspace-a', name: 'Cascade', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  await repository.saveNotebook(notebook)
  await repository.saveSection({ id: 'section-cascade', notebookId: notebook.id, name: 'Full', sortOrder: 0, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt })
  const cascadePage = page('page-cascade', 'Page', 'section-cascade')
  await repository.savePage(cascadePage, { pageId: cascadePage.id, schemaVersion: 3, markdown: 'Body', tiptapJson: { type: 'doc', content: [] }, updatedAt: cascadePage.updatedAt })
  await repository.saveAsset({ id: 'asset-cascade', pageId: 'page-cascade', kind: 'file', filename: 'file.txt', mimeType: 'text/plain', createdAt: notebook.createdAt }, new Blob(['content']))

  await repository.deleteNotebook(notebook.id, '2026-01-04T00:00:00.000Z', 'test-device')

  expect(await repository.listNotebooks('workspace-a')).toEqual([])
  expect(await repository.listSections(notebook.id)).toEqual([])
  expect(await repository.getPage('page-cascade')).toBeUndefined()
  expect(await repository.getPageDocument('page-cascade')).toBeUndefined()
  expect(await repository.listAssets('page-cascade')).toEqual([])
  const exported = await repository.exportData('workspace-a')
  expect(exported.tombstones).toEqual(expect.arrayContaining([
    expect.objectContaining({ entityType: 'page', entityId: 'page-cascade' }),
    expect.objectContaining({ entityType: 'section', entityId: 'section-cascade' }),
  ]))
  expect((await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'notebook')).toMatchObject({ operation: 'delete', entityId: notebook.id })
})

test('synchronizes page-tag membership as composite entities', async () => {
  const repository = makeRepository()
  await repository.savePage(page('page-tags', 'Tagged'))
  await repository.savePageTags('page-tags', ['tag-a', 'tag-b'])
  await repository.savePageTags('page-tags', ['tag-b'])
  const outgoing = await repository.listOutbox('workspace-a')
  expect(outgoing.filter((item) => item.entityType === 'page_tag').map((item) => `${item.entityId}:${item.operation}`).sort()).toEqual([
    'page-tags:tag-a:delete', 'page-tags:tag-b:upsert',
  ])
})

test('stores reading progress without creating a page revision', async () => {
  const repository = makeRepository()
  await repository.savePage(page('page-reading', 'Long note'))
  const position = { id: 'page-reading', pageId: 'page-reading', anchorUtf16Offset: 321, viewportOffsetFraction: 0.75, updatedAt: '2026-01-03T00:00:00.000Z', deviceId: 'web' }
  await repository.saveReadingPosition(position)
  expect(await repository.getReadingPosition('page-reading')).toEqual(position)
  expect(await repository.listRevisions('page-reading')).toHaveLength(0)
  expect((await repository.listOutbox('workspace-a')).filter((item) => item.entityType === 'reading_position')).toHaveLength(1)
})

test('creates history only when canonical Markdown changes', async () => {
  const repository = makeRepository()
  const value = { ...page('page-markdown-history', 'History'), syncStatus: 'pending' as const }
  const initial: PageDocument = {
    pageId: value.id,
    schemaVersion: 3,
    markdown: 'same body',
    tiptapJson: { type: 'doc', content: [{ type: 'paragraph', attrs: { normalized: false } }] },
    updatedAt: value.updatedAt,
  }
  await repository.savePage(value, initial)
  await repository.savePage({ ...value, updatedAt: '2026-01-03T00:00:00.000Z' }, {
    ...initial,
    tiptapJson: { type: 'doc', content: [{ type: 'paragraph', attrs: { normalized: true } }] },
    updatedAt: '2026-01-03T00:00:00.000Z',
  })
  expect(await repository.listRevisions(value.id)).toEqual([])

  await repository.savePage({ ...value, updatedAt: '2026-01-04T00:00:00.000Z' }, {
    ...initial,
    markdown: 'changed body',
    updatedAt: '2026-01-04T00:00:00.000Z',
  })
  expect(await repository.listRevisions(value.id)).toEqual([
    expect.objectContaining({ reason: 'autosave', document: expect.objectContaining({ markdown: 'same body' }) }),
  ])
})

test('keeps page listing inside the requested workspace', async () => {
  const repository = makeRepository()
  await repository.savePage(page('page-workspace-a', 'Workspace A'))
  await repository.savePage({ ...page('page-workspace-b', 'Workspace B'), workspaceId: 'workspace-b' })

  expect((await repository.listPages({ workspaceId: 'workspace-a' })).items.map((item) => item.id)).toEqual(['page-workspace-a'])
  expect((await repository.listPages({ workspaceId: 'workspace-b' })).items.map((item) => item.id)).toEqual(['page-workspace-b'])
  expect((await repository.listPages({ workspaceId: 'workspace-a', sectionId: 'section-a' })).items.map((item) => item.id)).toEqual(['page-workspace-a'])
})

test('searches, soft deletes, restores and purges without leaking children', async () => {
  const repository = makeRepository()
  await repository.savePage(page('page-a', 'Product Notes'))
  await repository.savePage(page('page-b', 'Meeting Notes'))
  expect((await repository.listPages({ workspaceId: 'workspace-a', search: 'product' })).items.map((item) => item.id)).toEqual(['page-a'])
  await repository.movePageToTrash('page-a', '2026-01-03T00:00:00.000Z')
  expect((await repository.exportData('workspace-a')).tombstones).toContainEqual(expect.objectContaining({ entityId: 'page-a', deletedAt: '2026-01-03T00:00:00.000Z' }))
  expect((await repository.listPages({ workspaceId: 'workspace-a' })).items.map((item) => item.id)).toEqual(['page-b'])
  expect((await repository.listPages({ workspaceId: 'workspace-a', includeDeleted: true })).items).toHaveLength(2)
  await repository.restorePage('page-a')
  expect((await repository.listPages({ workspaceId: 'workspace-a' })).items).toHaveLength(2)
  expect((await repository.exportData('workspace-a')).tombstones).not.toContainEqual(expect.objectContaining({ entityId: 'page-a' }))
  await repository.purgePage('page-a')
  expect(await repository.getPage('page-a')).toBeUndefined()
  expect((await repository.exportData('workspace-a')).tombstones).toContainEqual(expect.objectContaining({ entityId: 'page-a' }))
})

test('reuses the search index and invalidates it after a canonical Markdown edit', async () => {
  const repository = makeRepository()
  const value = { ...page('page-search-cache', 'Search cache'), syncStatus: 'pending' as const }
  const document: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: 'alpha-only phrase', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  expect((await repository.searchWorkspace('workspace-a', 'alpha-only')).map((item) => item.id)).toEqual([value.id])
  await repository.savePage({ ...value, updatedAt: '2026-01-03T00:00:00.000Z' }, { ...document, markdown: 'beta-only phrase', updatedAt: '2026-01-03T00:00:00.000Z' })
  expect(await repository.searchWorkspace('workspace-a', 'alpha-only')).toEqual([])
  expect((await repository.searchWorkspace('workspace-a', 'beta-only')).map((item) => item.id)).toEqual([value.id])
})

test('recovers a newer staged draft after an interrupted save and clears it after commit', async () => {
  const repository = makeRepository()
  const value = page('page-draft', 'Draft')
  const oldDocument: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: 'old', tiptapJson: { type: 'doc' }, updatedAt: value.updatedAt }
  await repository.savePage(value, oldDocument)
  const draft: PageDocument = { ...oldDocument, markdown: 'recovered', updatedAt: '2026-01-03T00:00:00.000Z' }
  await repository.stageDraft(draft)
  expect(await repository.recoverDrafts()).toEqual([value.id])
  expect((await repository.getPageDocument(value.id))?.markdown).toBe('recovered')
  expect(await repository.recoverDrafts()).toEqual([])
})

test('preserves edits made while an SSH publication is in flight', async () => {
  const repository = makeRepository()
  const snapshotPage = { ...page('page-sync-window', 'Before sync'), syncStatus: 'pending' as const }
  const snapshotDocument: PageDocument = { pageId: snapshotPage.id, schemaVersion: 3, markdown: 'before', tiptapJson: { type: 'doc' }, updatedAt: snapshotPage.updatedAt }
  await repository.savePage(snapshotPage, snapshotDocument)
  const snapshot = await repository.exportData('workspace-a')

  const editTime = '2026-01-03T00:00:00.000Z'
  await repository.savePage(
    { ...snapshotPage, title: 'Edited during sync', updatedAt: editTime, syncStatus: 'pending' },
    { ...snapshotDocument, markdown: 'edited during sync', updatedAt: editTime },
  )

  const published = {
    ...snapshot,
    pages: snapshot.pages.map((item) => ({ ...item, title: 'Published snapshot', syncStatus: 'synced' as const })),
  }
  await repository.importSyncResult(published, snapshot)
  expect(await repository.getPage(snapshotPage.id)).toMatchObject({ title: 'Edited during sync', syncStatus: 'pending' })
  expect(await repository.getPageDocument(snapshotPage.id)).toMatchObject({ markdown: 'edited during sync' })
  expect((await repository.listOutbox('workspace-a')).some((item) => item.entityId === snapshotPage.id)).toBe(true)
})

test('rebases pages created and deleted while an SSH publication is in flight', async () => {
  const repository = makeRepository()
  const existing = { ...page('page-existing', 'Existing'), syncStatus: 'pending' as const }
  const existingDocument: PageDocument = { pageId: existing.id, schemaVersion: 3, markdown: 'existing', tiptapJson: { type: 'doc' }, updatedAt: existing.updatedAt }
  await repository.savePage(existing, existingDocument)
  const snapshot = await repository.exportData('workspace-a')

  const created = { ...page('page-created-during-sync', 'Created during sync'), syncStatus: 'pending' as const }
  await repository.savePage(created, { pageId: created.id, schemaVersion: 3, markdown: 'new body', tiptapJson: { type: 'doc' }, updatedAt: created.updatedAt })
  await repository.movePageToTrash(existing.id, '2026-01-04T00:00:00.000Z')

  const published = {
    ...snapshot,
    pages: snapshot.pages.map((item) => ({ ...item, syncStatus: 'synced' as const })),
  }
  await repository.importSyncResult(published, snapshot)

  expect(await repository.getPage(created.id)).toMatchObject({ title: 'Created during sync', syncStatus: 'pending' })
  expect(await repository.getPageDocument(created.id)).toMatchObject({ markdown: 'new body' })
  expect(await repository.getPage(existing.id)).toMatchObject({ deletedAt: '2026-01-04T00:00:00.000Z' })
  expect((await repository.exportData('workspace-a')).tombstones).toContainEqual(expect.objectContaining({ entityId: existing.id }))
})

test('imports and exports a versioned workspace bundle without losing metadata', async () => {
  const repository = makeRepository()
  const value = page('page-imported', 'Imported')
  await repository.importData({
    notebooks: [{ id: 'notebook-a', workspaceId: 'workspace-a', name: 'Imported', sortOrder: 0, createdAt: value.createdAt, updatedAt: value.updatedAt }],
    sections: [{ id: 'section-a', notebookId: 'notebook-a', name: 'Notes', sortOrder: 0, createdAt: value.createdAt, updatedAt: value.updatedAt }],
    pages: [value], documents: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: [], comments: [],
    tombstones: [{ id: 'page:deleted', workspaceId: 'workspace-a', entityType: 'page', entityId: 'deleted', deletedAt: value.updatedAt, deviceId: 'test' }],
  })
  const exported = await repository.exportData('workspace-a')
  expect(exported.pages[0]?.id).toBe('page-imported')
  expect(exported.tombstones[0]?.entityId).toBe('deleted')
})

test('keeps imported history while bounding new autosave revisions', async () => {
  const repository = makeRepository()
  const value = { ...page('page-history', 'History'), syncStatus: 'pending' as const }
  const importedDocument: PageDocument = { pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'text', text: 'imported' }] }, updatedAt: value.updatedAt }
  const importedRevisions = [0, 1].map((index) => ({ id: `imported-${index}`, pageId: value.id, document: { ...importedDocument, tiptapJson: { type: 'doc', content: [{ type: 'text', text: `legacy-${index}` }] } }, createdAt: `2025-01-0${index + 1}T00:00:00.000Z`, reason: 'import' as const }))
  await repository.importData({
    notebooks: [{ id: 'notebook-history', workspaceId: 'workspace-a', name: 'History', sortOrder: 0, createdAt: value.createdAt, updatedAt: value.updatedAt }],
    sections: [{ id: 'section-a', notebookId: 'notebook-history', name: 'Notes', sortOrder: 0, createdAt: value.createdAt, updatedAt: value.updatedAt }],
    pages: [value], documents: [importedDocument], revisions: importedRevisions,
    tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
  })
  for (let index = 0; index < 105; index += 1) {
    await repository.savePage({ ...value, updatedAt: new Date(2026, 0, 3, 0, 0, index).toISOString() }, { ...importedDocument, tiptapJson: { type: 'doc', content: [{ type: 'text', text: `edit-${index}` }] }, updatedAt: new Date(2026, 0, 3, 0, 0, index).toISOString() })
  }
  const revisions = await repository.listRevisions(value.id)
  expect(revisions.filter((item) => item.reason === 'import').map((item) => item.id).sort()).toEqual(['imported-0', 'imported-1'])
  expect(revisions.filter((item) => item.reason === 'autosave')).toHaveLength(MAX_AUTOSAVE_REVISIONS_PER_PAGE)
})

test('lazily rebuilds a Markdown revision editor cache only when restoring it', async () => {
  const repository = makeRepository()
  const value = { ...page('page-markdown-history', 'Markdown history'), icon: '🚀' }
  const current: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: '当前正文', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt }
  const historical: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: '## 历史标题\n\n![图片](notebook-asset:asset-history)', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.createdAt }
  await repository.importData({
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
    pages: [value], documents: [current],
    assets: [{ id: 'asset-history', pageId: value.id, kind: 'image', filename: 'history.png', mimeType: 'image/png', createdAt: value.createdAt, caption: '历史图片', displayWidth: 360, alignment: 'right' }],
    revisions: [{ id: 'markdown-revision', pageId: value.id, pageIcon: '📝', document: historical, createdAt: value.createdAt, reason: 'import' }],
  })
  expect((await repository.listRevisions(value.id))[0]?.document.tiptapJson).toEqual({ type: 'doc', content: [] })
  const restored = await repository.restoreRevision('markdown-revision')
  const cache = JSON.stringify(restored.tiptapJson)
  expect(restored.markdown).toBe(historical.markdown)
  expect((await repository.getPage(value.id))?.icon).toBe('📝')
  expect(cache).toContain('历史标题')
  expect(cache).toContain('"width":360')
  expect(cache).toContain('"textAlign":"right"')
})

test('creates a compact manual revision and enqueues it for synchronization', async () => {
  const repository = makeRepository()
  const value = { ...page('page-manual-history', 'Manual history'), icon: '📌' }
  const document: PageDocument = {
    pageId: value.id,
    schemaVersion: 3,
    markdown: '# 当前正文',
    tiptapJson: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '当前正文' }] }] },
    updatedAt: value.updatedAt,
  }
  await repository.savePage(value, document)
  const revision = await repository.createManualRevision(value.id)
  expect(revision.reason).toBe('manual')
  expect(revision.pageIcon).toBe('📌')
  expect(revision.document.markdown).toBe('# 当前正文')
  expect(revision.document.tiptapJson).toEqual({ type: 'doc', content: [] })
  expect((await repository.listOutbox(value.workspaceId)).some((item) => item.entityType === 'revision' && item.entityId === revision.id)).toBe(true)
})

test('persists external AI proposals without putting proposed content in the sync outbox', async () => {
  const repository = makeRepository()
  const proposal = {
    id: 'proposal-a',
    workspaceId: 'workspace-a',
    title: '整理页面',
    explanation: '测试提案',
    source: 'test-agent',
    status: 'pending' as const,
    createdAt: '2026-07-25T00:00:00.000Z',
    changes: [{
      id: 'change-a',
      type: 'update-page' as const,
      before: { pageId: 'page-a', title: '原题', markdown: '原文', updatedAt: '2026-07-25T00:00:00.000Z' },
      after: { pageId: 'page-a', title: '新题', markdown: '新文', updatedAt: '2026-07-25T00:01:00.000Z' },
    }],
  }
  await repository.saveAutomationProposal(proposal)
  expect(await repository.getAutomationProposal(proposal.id)).toEqual(proposal)
  expect(await repository.listAutomationProposals(proposal.workspaceId)).toEqual([proposal])
  expect(await repository.listOutbox(proposal.workspaceId)).toEqual([])

  await repository.updateAutomationProposalStatus(proposal.id, 'rejected')
  expect(await repository.getAutomationProposal(proposal.id)).toMatchObject({ status: 'rejected' })
})

test('atomically applies an AI proposal with a manual recovery revision and stale protection', async () => {
  const repository = makeRepository()
  const originalPage = page('page-ai-apply', '原题')
  const originalDocument: PageDocument = { pageId: originalPage.id, schemaVersion: 3, markdown: '原文', tiptapJson: { type: 'doc', content: [] }, updatedAt: originalPage.updatedAt }
  await repository.savePage(originalPage, originalDocument)
  const proposal = {
    id: 'proposal-apply',
    workspaceId: originalPage.workspaceId,
    title: 'AI 整理',
    source: 'test-agent',
    status: 'pending' as const,
    createdAt: '2026-07-25T00:00:00.000Z',
    changes: [{
      id: 'change-apply',
      type: 'update-page' as const,
      before: { pageId: originalPage.id, title: originalPage.title, markdown: '原文', sectionId: originalPage.sectionId, updatedAt: originalPage.updatedAt },
      after: { pageId: originalPage.id, title: '新题', markdown: '新文', sectionId: originalPage.sectionId, updatedAt: '2026-07-25T00:01:00.000Z' },
    }],
  }
  await repository.saveAutomationProposal(proposal)
  const updatedPage = { ...originalPage, title: '新题', updatedAt: '2026-07-25T00:01:00.000Z', syncStatus: 'pending' as const }
  const updatedDocument: PageDocument = { ...originalDocument, markdown: '新文', updatedAt: updatedPage.updatedAt }
  await repository.applyAutomationProposal(proposal.id, [{ page: updatedPage, document: updatedDocument, previousPageId: originalPage.id }])

  expect(await repository.getAutomationProposal(proposal.id)).toMatchObject({ status: 'applied' })
  expect(await repository.getPage(originalPage.id)).toMatchObject({ title: '新题' })
  expect((await repository.listRevisions(originalPage.id)).some((revision) => revision.reason === 'manual' && revision.document.markdown === '原文')).toBe(true)
  expect((await repository.listOutbox(originalPage.workspaceId)).some((item) => item.entityType === 'document' && item.entityId === originalPage.id)).toBe(true)

  const staleProposal = { ...proposal, id: 'proposal-stale', status: 'pending' as const }
  await repository.saveAutomationProposal(staleProposal)
  await expect(repository.applyAutomationProposal(staleProposal.id, [{ page: updatedPage, document: updatedDocument, previousPageId: originalPage.id }])).rejects.toMatchObject({ code: 'stale' })
  expect(await repository.getAutomationProposal(staleProposal.id)).toMatchObject({ status: 'pending' })
})

test('records partial AI review decisions and only applies accepted pages', async () => {
  const repository = makeRepository()
  const first = page('page-ai-first', 'First')
  const second = page('page-ai-second', 'Second')
  const firstDocument: PageDocument = { pageId: first.id, schemaVersion: 3, markdown: 'first', tiptapJson: { type: 'doc', content: [] }, updatedAt: first.updatedAt }
  const secondDocument: PageDocument = { pageId: second.id, schemaVersion: 3, markdown: 'second', tiptapJson: { type: 'doc', content: [] }, updatedAt: second.updatedAt }
  await repository.savePage(first, firstDocument)
  await repository.savePage(second, secondDocument)
  const proposal = {
    id: 'proposal-partial',
    workspaceId: first.workspaceId,
    title: 'Partial',
    source: 'test',
    status: 'pending' as const,
    createdAt: first.updatedAt,
    changes: [
      { id: 'accept', type: 'update-page' as const, before: { pageId: first.id, title: first.title, markdown: 'first', sectionId: first.sectionId, updatedAt: first.updatedAt }, after: { pageId: first.id, title: 'Accepted', markdown: 'accepted', sectionId: first.sectionId, updatedAt: '2026-07-25T00:01:00.000Z' } },
      { id: 'reject', type: 'update-page' as const, before: { pageId: second.id, title: second.title, markdown: 'second', sectionId: second.sectionId, updatedAt: second.updatedAt }, after: { pageId: second.id, title: 'Rejected', markdown: 'rejected', sectionId: second.sectionId, updatedAt: '2026-07-25T00:01:00.000Z' } },
    ],
  }
  await repository.saveAutomationProposal(proposal)
  const acceptedPage = { ...first, title: 'Accepted', updatedAt: '2026-07-25T00:01:00.000Z', syncStatus: 'pending' as const }
  await repository.applyAutomationProposal(proposal.id, [{
    page: acceptedPage,
    document: { ...firstDocument, markdown: 'accepted', updatedAt: acceptedPage.updatedAt },
    previousPageId: first.id,
  }], ['accept'])
  expect(await repository.getPage(first.id)).toMatchObject({ title: 'Accepted' })
  expect(await repository.getPage(second.id)).toMatchObject({ title: 'Second' })
  expect(await repository.getAutomationProposal(proposal.id)).toMatchObject({
    status: 'applied',
    acceptedChangeIds: ['accept'],
    rejectedChangeIds: ['reject'],
  })
})

test('applies an AI delete as a recoverable trash move with history and a tombstone outbox entry', async () => {
  const repository = makeRepository()
  const original = page('page-ai-delete', 'Delete me')
  const document: PageDocument = { pageId: original.id, schemaVersion: 3, markdown: 'recoverable', tiptapJson: { type: 'doc', content: [] }, updatedAt: original.updatedAt }
  await repository.savePage(original, document)
  const deletedAt = '2026-07-25T00:02:00.000Z'
  const proposal = {
    id: 'proposal-delete',
    workspaceId: original.workspaceId,
    title: 'Delete',
    source: 'test',
    status: 'pending' as const,
    createdAt: original.updatedAt,
    changes: [{
      id: 'delete',
      type: 'delete-page' as const,
      before: { pageId: original.id, title: original.title, markdown: 'recoverable', sectionId: original.sectionId, updatedAt: original.updatedAt },
      after: { pageId: original.id, title: original.title, markdown: 'recoverable', sectionId: original.sectionId, deletedAt, updatedAt: deletedAt },
    }],
  }
  await repository.saveAutomationProposal(proposal)
  await repository.applyAutomationProposal(proposal.id, [{
    page: { ...original, deletedAt, updatedAt: deletedAt, syncStatus: 'pending' },
    previousPageId: original.id,
    delete: true,
  }])
  expect(await repository.getPage(original.id)).toMatchObject({ deletedAt })
  expect((await repository.listRevisions(original.id)).some((revision) => revision.document.markdown === 'recoverable')).toBe(true)
  expect((await repository.listOutbox(original.workspaceId)).some((item) => item.entityType === 'page' && item.entityId === original.id && item.operation === 'delete')).toBe(true)
})

test('resets every page to one current-content baseline revision', async () => {
  const repository = makeRepository()
  const first = page('page-reset-first', 'First')
  const second = page('page-reset-second', 'Second')
  const empty = page('page-reset-empty', 'Empty')
  const document = (value: typeof first, markdown: string): PageDocument => ({
    pageId: value.id,
    schemaVersion: 3,
    markdown,
    tiptapJson: { type: 'doc', content: [] },
    updatedAt: value.updatedAt,
  })
  await repository.importData({
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
    pages: [first, second, empty],
    documents: [document(first, 'current first'), document(second, 'current second')],
    revisions: [
      { id: 'old-first-a', pageId: first.id, document: document(first, 'old A'), createdAt: first.createdAt, reason: 'import' },
      { id: 'old-first-b', pageId: first.id, document: document(first, 'old B'), createdAt: first.updatedAt, reason: 'import' },
      { id: 'old-second', pageId: second.id, document: document(second, 'old second'), createdAt: second.createdAt, reason: 'import' },
    ],
  })

  const result = await repository.resetRevisionHistory(first.workspaceId)

  expect(result).toEqual({ pageCount: 3, removedRevisionCount: 3 })
  const exported = await repository.exportData(first.workspaceId)
  expect(exported.revisions).toHaveLength(3)
  expect(exported.revisions.map((item) => item.document.markdown).sort()).toEqual(['', 'current first', 'current second'])
  expect(exported.pages.every((item) => item.syncStatus === 'pending' && typeof item.legacyMetadata?.historyResetAt === 'string')).toBe(true)
})

test('removes consecutive duplicate imported revisions and a revision identical to the current body', async () => {
  const repository = makeRepository()
  const value = page('page-compact-history', 'Compact history')
  const document = (text: string, index: number): PageDocument => ({ pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'text', text }] }, updatedAt: `2026-01-01T00:00:0${index}.000Z` })
  const revisions = ['A', 'A', 'B', 'current'].map((text, index) => ({ id: `revision-${index}`, pageId: value.id, document: document(text, index), createdAt: document(text, index).updatedAt, reason: 'import' as const }))
  await repository.importData({
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
    pages: [value], documents: [document('current', 5)], revisions,
  })
  expect((await repository.listRevisions(value.id)).map((item) => item.document.markdown).sort()).toEqual(['A', 'B'])
})

test('refuses to erase the only non-empty copy of a page from revision history', async () => {
  const repository = makeRepository()
  const value = page('page-history-only-content', 'Recover me')
  const blank: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: '', tiptapJson: { type: 'doc', content: [{ type: 'paragraph' }] }, updatedAt: value.updatedAt }
  const original: PageDocument = { ...blank, markdown: 'irreplaceable original content' }
  await repository.importData({
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
    pages: [value],
    documents: [blank],
    revisions: [{ id: 'only-original', pageId: value.id, document: original, createdAt: value.createdAt, reason: 'import' }],
  })

  await expect(repository.resetRevisionHistory(value.workspaceId)).rejects.toThrow(/Recover me.*历史版本仍有内容/)
  const exported = await repository.exportData(value.workspaceId)
  expect(exported.revisions).toHaveLength(1)
  expect(exported.revisions[0]?.document.markdown).toBe('irreplaceable original content')
})

test('history compaction is idempotent when revisions share a timestamp', async () => {
  const repository = makeRepository()
  const value = page('page-same-time-history', 'Same timestamp')
  const document = (text: string): PageDocument => ({ pageId: value.id, schemaVersion: 3, markdown: text, tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt })
  const revisions = [
    { id: 'revision-z', text: 'A' },
    { id: 'revision-a', text: 'A' },
    { id: 'revision-y', text: 'B' },
    { id: 'revision-b', text: 'current' },
  ].map(({ id, text }) => ({ id, pageId: value.id, document: document(text), createdAt: value.updatedAt, reason: 'import' as const }))
  const bundle = {
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
    pages: [value], documents: [document('current')], revisions,
  }
  await repository.importData(bundle)
  const first = await repository.exportData(value.workspaceId)
  await repository.importData(first)
  expect((await repository.listRevisions(value.id)).map((item) => item.id).sort()).toEqual(first.revisions.map((item) => item.id).sort())
})

test('keeps icon-only history without duplicating the canonical body', async () => {
  const repository = makeRepository()
  const value = { ...page('page-icon-history', 'Icon history'), icon: '🚀' }
  const document: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: 'same body', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt }
  await repository.importData({
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
    pages: [value], documents: [document], revisions: [
      { id: 'icon-default', pageId: value.id, pageIcon: null, document, createdAt: '2026-01-01T00:00:00.000Z', reason: 'manual' },
      { id: 'icon-pin', pageId: value.id, pageIcon: '📌', document, createdAt: '2026-01-02T00:00:00.000Z', reason: 'manual' },
    ],
  })
  expect((await repository.exportData(value.workspaceId)).revisions.map((item) => item.pageIcon)).toEqual([null, '📌'])
})

test('re-import replaces stale attachment children for imported pages', async () => {
  const repository = makeRepository()
  const value = page('page-imported', 'Imported')
  const empty = { notebooks: [], sections: [], documents: [], tags: [], pageTags: [], taskSteps: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: [], comments: [], tombstones: [] }
  await repository.importData({
    ...empty, pages: [value], assets: [{ id: 'asset-local-id', pageId: value.id, kind: 'image', filename: 'old.png', mimeType: 'image/png', createdAt: value.createdAt }],
  })
  await repository.importAssetContents(new Map([['asset-local-id', new Uint8Array([1])]]))
  await repository.importData({
    ...empty, pages: [value], assets: [{ id: 'legacy-asset:page-imported:asset-local-id', pageId: value.id, kind: 'image', filename: 'old.png', mimeType: 'image/png', createdAt: value.createdAt }],
  })
  expect((await repository.listAssets(value.id)).map((item) => item.id)).toEqual(['legacy-asset:page-imported:asset-local-id'])
  expect(await repository.getAssetContent('asset-local-id')).toBeUndefined()
})

test('re-import replaces stale page-local metadata and history', async () => {
  const repository = makeRepository()
  const value = page('page-reimport', 'Imported twice')
  const base = { notebooks: [], sections: [], pages: [value], documents: [], tags: [], assets: [], knowledgeEntities: [], knowledgeRelations: [], comments: [], tombstones: [] }
  const oldRevision = { id: 'old-revision', pageId: value.id, document: { pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc' }, updatedAt: value.updatedAt }, createdAt: value.updatedAt, reason: 'import' as const }
  await repository.importData({ ...base, pageTags: [{ pageId: value.id, tagId: 'old-tag' }], taskSteps: [], pageLinks: [], readingPositions: [], revisions: [oldRevision] })
  const newRevision = { ...oldRevision, id: 'new-revision' }
  await repository.importData({ ...base, pageTags: [], taskSteps: [], pageLinks: [], readingPositions: [], revisions: [newRevision] })
  expect(await repository.listPageTags(value.id)).toEqual([])
  expect((await repository.listRevisions(value.id)).map((item) => item.id)).toEqual(['new-revision'])
})

test('queues a complete imported bundle for first publication after attachment bytes are stored', async () => {
  const repository = makeRepository()
  const value = page('page-imported', 'Imported')
  const bundle = {
    notebooks: [{ id: 'notebook-a', workspaceId: 'workspace-a', name: 'Imported', sortOrder: 0, createdAt: value.createdAt, updatedAt: value.updatedAt }],
    sections: [{ id: 'section-a', notebookId: 'notebook-a', name: 'Notes', sortOrder: 0, createdAt: value.createdAt, updatedAt: value.updatedAt }],
    pages: [value],
    documents: [{ pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc' }, updatedAt: value.updatedAt }],
    tags: [{ id: 'tag-a', workspaceId: 'workspace-a', name: 'Migrated', color: 'blue', createdAt: value.createdAt, updatedAt: value.updatedAt }],
    pageTags: [{ pageId: value.id, tagId: 'tag-a' }],
    taskSteps: [],
    assets: [{ id: 'asset-a', pageId: value.id, kind: 'file' as const, filename: 'old.pdf', mimeType: 'application/pdf', createdAt: value.createdAt }],
    pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: [], comments: [],
    tombstones: [{ id: 'page:deleted', workspaceId: 'workspace-a', entityType: 'page' as const, entityId: 'deleted', deletedAt: value.updatedAt, deviceId: 'test' }],
  }
  await repository.importData(bundle)
  expect(await repository.listOutbox('workspace-a')).toHaveLength(0)
  await repository.importAssetContents(new Map([['asset-a', new Uint8Array([1, 2, 3])]]))
  await repository.queueImportedData(bundle)
  const outgoing = await repository.listOutbox('workspace-a')
  expect(outgoing.map((item) => `${item.entityType}:${item.operation}`).sort()).toEqual([
    'asset:upsert', 'document:upsert', 'notebook:upsert', 'page:delete', 'page:upsert',
    'page_tag:upsert', 'section:upsert', 'tag:upsert',
  ])
  expect((await repository.getPage(value.id))?.syncStatus).toBe('pending')
})

test('restores complete backup metadata bytes and outbox in one transaction', async () => {
  const repository = makeRepository()
  const value = page('page-atomic-restore', 'Atomic restore')
  const bundle = {
    notebooks: [{ id: 'notebook-atomic', workspaceId: 'workspace-a', name: 'Imported', sortOrder: 0, createdAt: value.createdAt, updatedAt: value.updatedAt }],
    sections: [], pages: [value], documents: [], tags: [], pageTags: [], taskSteps: [],
    assets: [{ id: 'asset-atomic', pageId: value.id, kind: 'file' as const, filename: 'atomic.bin', mimeType: 'application/octet-stream', createdAt: value.createdAt }],
    pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: [], comments: [], tombstones: [],
  }
  await expect(repository.restoreCompleteBackup(bundle, new Map())).rejects.toThrow(/附件清单/)
  expect(await repository.getPage(value.id)).toBeUndefined()
  expect(await repository.listOutbox('workspace-a')).toHaveLength(0)

  await repository.restoreCompleteBackup(bundle, new Map([['asset-atomic', new Uint8Array([1, 2, 3])]]))
  expect(await repository.getPage(value.id)).toMatchObject({ syncStatus: 'pending' })
  expect(new Uint8Array(await (await repository.getAssetContent('asset-atomic'))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  expect((await repository.listOutbox('workspace-a')).map((item) => item.entityType)).toEqual(expect.arrayContaining(['notebook', 'page', 'asset']))
})

test('indexes document bodies for Latin and CJK full-text search', async () => {
  const repository = makeRepository()
  const first = page('page-search', 'Design')
  await repository.savePage(first, { pageId: first.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '会议笔记 connects evidence' }] }] }, updatedAt: first.updatedAt })
  expect((await repository.searchWorkspace('workspace-a', '会议笔记')).map((item) => item.id)).toEqual(['page-search'])
  expect((await repository.searchWorkspace('workspace-a', 'evidence')).map((item) => item.id)).toEqual(['page-search'])
})

test('finds an exact unlinked mention in the inverted-index candidate set', async () => {
  const repository = makeRepository()
  const source = page('mention-source', '普通标题')
  await repository.savePage(source, {
    pageId: source.id,
    schemaVersion: 3,
    markdown: '正文中提到了目标页面标题，但还没有创建双链。',
    tiptapJson: { type: 'doc', content: [] },
    updatedAt: source.updatedAt,
  })
  await repository.savePage(page('unrelated', '无关页面'))
  expect((await repository.searchWorkspaceCandidates('workspace-a', '目标页面标题')).map((item) => item.id)).toContain('mention-source')
})

test('ranks an exact Chinese phrase ahead of weak bigram matches', async () => {
  const repository = makeRepository()
  await repository.savePage(page('exact', '小说提示词'))
  await repository.savePage(page('weak-a', '提示与工具'))
  await repository.savePage(page('weak-b', '小说写作'))
  expect((await repository.searchWorkspace('workspace-a', '小说提示词'))[0]?.id).toBe('exact')
})

test('classifies private notebook entities and related page records as local-only sync', async () => {
  const repository = makeRepository()
  const notebook = { id: 'private-notebook', workspaceId: 'workspace-a', name: 'Private', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', locked: true }
  const section = { id: 'private-section', notebookId: notebook.id, name: 'Private section', sortOrder: 0, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt }
  const privatePage = { ...page('private-page', 'Private page', section.id), locked: true, syncStatus: 'pending' as const }
  await repository.saveNotebook(notebook)
  await repository.saveSection(section)
  await repository.savePage(privatePage, { pageId: privatePage.id, schemaVersion: 3, markdown: 'secret', tiptapJson: { type: 'doc', content: [] }, updatedAt: privatePage.updatedAt })
  await repository.saveTaskSteps(privatePage.id, [{ id: 'private-step', pageId: privatePage.id, text: 'secret task', checked: false, sortOrder: 0, createdAt: privatePage.createdAt }])

  const outgoing = await repository.listOutbox('workspace-a')
  expect(outgoing.length).toBeGreaterThanOrEqual(5)
  await expect(Promise.all(outgoing.map((item) => repository.isPrivateSyncItem(item)))).resolves.toEqual(outgoing.map(() => true))

  await repository.acknowledgeLocalOnlySync(outgoing)
  expect(await repository.listOutbox('workspace-a')).toEqual([])
  expect((await repository.getPage(privatePage.id))?.syncStatus).toBe('synced')
})
