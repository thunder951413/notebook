import 'fake-indexeddb/auto'
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
  expect((await repository.listOutbox('workspace-a')).map((item) => item.entityType).sort()).toEqual(['document', 'page'])
  await repository.applyRemoteChanges('workspace-a', [{ cursor: 1, entityType: 'document', entityId: value.id, version: 1, operation: 'upsert', payload: { ...document, tiptapJson: { type: 'doc', content: [] } } }], 1)
  expect((await repository.getPageDocument(value.id))?.tiptapJson).toEqual({ type: 'doc', content: [] })
  await repository.applyRemoteChanges('workspace-a', [{ cursor: 2, entityType: 'document', entityId: value.id, version: 2, operation: 'delete', payload: {} }], 2)
  expect(await repository.getPageDocument(value.id)).toBeUndefined()
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
  const value = { ...page('page-source', 'Source'), kind: 'task' as const, syncStatus: 'pending' as const }
  const document: PageDocument = { pageId: value.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'image', attrs: { src: 'notebook-asset:asset-source', legacyAssetId: 'asset-source' } }] }, updatedAt: value.updatedAt }
  await repository.savePage(value, document)
  await repository.savePageTags(value.id, ['tag-a'])
  await repository.saveTaskSteps(value.id, [{ id: 'step-source', pageId: value.id, text: 'Step', checked: false, sortOrder: 0, createdAt: value.createdAt }])
  await repository.saveAsset({ id: 'asset-source', pageId: value.id, kind: 'image', filename: 'image.png', mimeType: 'image/png', createdAt: value.createdAt }, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))

  const copy = await repository.duplicatePage(value.id, 'page-copy', '2026-01-04T00:00:00.000Z')
  const copiedAssets = await repository.listAssets(copy.id)
  expect(copy.title).toBe('Source 副本')
  expect((await repository.listTaskSteps(copy.id))[0]).toMatchObject({ pageId: copy.id, text: 'Step' })
  expect(await repository.listPageTags(copy.id)).toEqual([{ pageId: copy.id, tagId: 'tag-a' }])
  expect(copiedAssets).toHaveLength(1)
  expect(await repository.getAssetContent(copiedAssets[0]!.id)).toBeInstanceOf(Blob)
  expect(JSON.stringify((await repository.getPageDocument(copy.id))?.tiptapJson)).toContain(`notebook-asset:${copiedAssets[0]!.id}`)
  expect(JSON.stringify((await repository.getPageDocument(copy.id))?.tiptapJson)).not.toContain('asset-source')
})

test('only deletes empty sections and queues a compatible tombstone', async () => {
  const repository = makeRepository()
  const notebook = { id: 'notebook-delete', workspaceId: 'workspace-a', name: 'Delete', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  await repository.saveNotebook(notebook)
  await repository.saveSection({ id: 'section-full', notebookId: notebook.id, name: 'Full', sortOrder: 0, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt })
  await repository.savePage(page('page-in-section', 'Page', 'section-full'))
  await expect(repository.deleteSection('section-full', '2026-01-04T00:00:00.000Z', 'test-device')).rejects.toThrow('仍有页面')
  await repository.purgePage('page-in-section')
  await repository.deleteSection('section-full', '2026-01-04T00:00:00.000Z', 'test-device')
  expect(await repository.listSections(notebook.id)).toEqual([])
  expect((await repository.exportData('workspace-a')).tombstones).toContainEqual(expect.objectContaining({ entityType: 'section', entityId: 'section-full', deviceId: 'test-device' }))
  expect((await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'section')).toMatchObject({ operation: 'delete', entityId: 'section-full' })
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
  expect((await repository.listPages({})).items.map((item) => item.id)).toEqual(['page-b'])
  expect((await repository.listPages({ includeDeleted: true })).items).toHaveLength(2)
  await repository.restorePage('page-a')
  expect((await repository.listPages({})).items).toHaveLength(2)
  await repository.purgePage('page-a')
  expect(await repository.getPage('page-a')).toBeUndefined()
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
  expect((await repository.listRevisions(value.id)).map((item) => (item.document.tiptapJson.content as Array<{ text: string }>)[0]?.text).sort()).toEqual(['A', 'B'])
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

test('ranks an exact Chinese phrase ahead of weak bigram matches', async () => {
  const repository = makeRepository()
  await repository.savePage(page('exact', '小说提示词'))
  await repository.savePage(page('weak-a', '提示与工具'))
  await repository.savePage(page('weak-b', '小说写作'))
  expect((await repository.searchWorkspace('workspace-a', '小说提示词'))[0]?.id).toBe('exact')
})
