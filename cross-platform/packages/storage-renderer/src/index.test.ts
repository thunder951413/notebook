import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, test } from 'vitest'
import type { Page, PageDocument } from '@notebook/domain'
import { DexieNotebookRepository, NotebookRendererDatabase } from './index'

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

test('rejects malformed remote payloads and never overwrites a pending local body', async () => {
  const repository = makeRepository()
  const value = { ...page('page-protected', 'Local'), syncStatus: 'pending' as const }
  const document: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: 'local', tiptapJson: { type: 'doc' }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  await repository.applyRemoteChanges('workspace-a', [{
    cursor: 1, entityType: 'document', entityId: value.id, version: 1, operation: 'upsert',
    payload: { ...document, markdown: 'remote' },
  }], 1)
  expect(await repository.getPageDocument(value.id)).toMatchObject({ markdown: 'local' })
  expect(await repository.getPage(value.id)).toMatchObject({ syncStatus: 'conflict' })
  await expect(repository.applyRemoteChanges('workspace-a', [{
    cursor: 2, entityType: 'page', entityId: value.id, version: 2, operation: 'upsert',
    payload: { id: value.id, title: 'broken' },
  }], 2)).rejects.toThrow()
  expect(await repository.getPage(value.id)).toMatchObject({ title: 'Local' })
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

test('searches, soft deletes, restores and purges without leaking children', async () => {
  const repository = makeRepository()
  await repository.savePage(page('page-a', 'Product Notes'))
  await repository.savePage(page('page-b', 'Meeting Notes'))
  expect((await repository.listPages({ search: 'product' })).items.map((item) => item.id)).toEqual(['page-a'])
  await repository.movePageToTrash('page-a', '2026-01-03T00:00:00.000Z')
  expect((await repository.exportData('workspace-a')).tombstones).toContainEqual(expect.objectContaining({ entityId: 'page-a', deletedAt: '2026-01-03T00:00:00.000Z' }))
  expect((await repository.listPages({})).items.map((item) => item.id)).toEqual(['page-b'])
  expect((await repository.listPages({ includeDeleted: true })).items).toHaveLength(2)
  await repository.restorePage('page-a')
  expect((await repository.listPages({})).items).toHaveLength(2)
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

test('never trims imported legacy history while bounding new autosave revisions', async () => {
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
  expect(revisions.filter((item) => item.reason === 'autosave')).toHaveLength(100)
})

test('lazily rebuilds a Markdown revision editor cache only when restoring it', async () => {
  const repository = makeRepository()
  const value = page('page-markdown-history', 'Markdown history')
  const current: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: '当前正文', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.updatedAt }
  const historical: PageDocument = { pageId: value.id, schemaVersion: 3, markdown: '## 历史标题\n\n![图片](notebook-asset:asset-history)', tiptapJson: { type: 'doc', content: [] }, updatedAt: value.createdAt }
  await repository.importData({
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], comments: [], tombstones: [],
    pages: [value], documents: [current],
    assets: [{ id: 'asset-history', pageId: value.id, kind: 'image', filename: 'history.png', mimeType: 'image/png', createdAt: value.createdAt, caption: '历史图片', displayWidth: 360, alignment: 'right' }],
    revisions: [{ id: 'markdown-revision', pageId: value.id, document: historical, createdAt: value.createdAt, reason: 'import' }],
  })
  expect((await repository.listRevisions(value.id))[0]?.document.tiptapJson).toEqual({ type: 'doc', content: [] })
  const restored = await repository.restoreRevision('markdown-revision')
  const cache = JSON.stringify(restored.tiptapJson)
  expect(restored.markdown).toBe(historical.markdown)
  expect(cache).toContain('历史标题')
  expect(cache).toContain('"width":360')
  expect(cache).toContain('"textAlign":"right"')
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
