import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { encodeLegacyRepository, encodeMarkdownRepository, importDocumentMigrationPackage, importLegacyBundle, importLegacyNote, importMarkdownRepository, legacyDocumentToTiptap, legacyTiptapToCanonicalMarkdown, libraryEnvelopeSchema, markdownToEditorCache, migratedDocumentSchema, migrationManifestSchema, noteEnvelopeSchema, noteIndexSchema, normalizeLegacyMarkdownSyntax, readingPositionsSchema, verifyPrivacyKeyCheck, type MarkdownNoteEnvelope, type PrivacyKeyCheck } from './index'
import type { NotebookDataBundle } from '@notebook/domain'

test('parses the shared macOS/Android fixture and preserves identity and rich blocks', async () => {
  const file = resolve(import.meta.dirname, '../../../../SyncContractFixtures/note-envelope.json')
  const parsed = noteEnvelopeSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const imported = importLegacyNote(parsed, 'workspace-fixture')
  expect(imported.page.id).toBe('11111111-1111-4111-8111-111111111111')
  expect(imported.page.title).toBe('Fixture Note')
  expect(imported.page.legacyVersion).toBe(7)
  expect(imported.document).toMatchObject({ schemaVersion: 3, tiptapJson: { type: 'doc', content: [] } })
  expect(imported.document.markdown).toContain('Fixture')
  expect(imported.document.markdown).toContain('notebook-asset:asset-fixture-1')
  expect(imported.assets[0]).toMatchObject({ id: 'asset-fixture-1', kind: 'image' })
  expect(imported.taskSteps[0]).toMatchObject({ text: 'Fixture step', checked: false })
  expect(imported.tagIds).toEqual(['33333333-3333-4333-8333-333333333333'])
})

test('rejects a mismatched envelope identity before import', async () => {
  const file = resolve(import.meta.dirname, '../../../../SyncContractFixtures/note-envelope.json')
  const value = JSON.parse(await readFile(file, 'utf8'))
  value.currentSnapshot.metadata.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const parsed = noteEnvelopeSchema.parse(value)
  expect(() => importLegacyNote(parsed, 'workspace-fixture')).toThrow(/does not match/)
})

test('imports a complete library bundle with folders, tags, links, tombstones and reading positions', async () => {
  const fixture = async (name: string) => JSON.parse(await readFile(resolve(import.meta.dirname, `../../../../SyncContractFixtures/${name}`), 'utf8'))
  const library = libraryEnvelopeSchema.parse(await fixture('library-envelope.json'))
  const note = noteEnvelopeSchema.parse(await fixture('note-envelope.json'))
  note.currentSnapshot.metadata.linkedNoteIDs = ['99999999-9999-4999-8999-999999999999']
  const index = noteIndexSchema.parse(await fixture('note-index.json'))
  const readingPositions = readingPositionsSchema.parse(await fixture('reading-positions.json'))
  const imported = importLegacyBundle({ library, notes: [note], index, readingPositions }, 'workspace-fixture')
  expect(imported.notebook.name).toBe('迁移的笔记')
  expect(imported.sections[0]?.id).toBe('22222222-2222-4222-8222-222222222222')
  expect(imported.tags[0]?.name).toBe('Fixture Tag')
  expect(imported.pages).toHaveLength(1)
  expect(imported.pageLinks).toHaveLength(1)
  expect(imported.readingPositions[0]?.anchorUtf16Offset).toBe(321)
  expect(imported.tombstones.map((item) => item.entityType)).toEqual(['section', 'tag', 'page'])
})

test('accepts legacy macOS folders without createdAt and tags without updatedAt', () => {
  const exportedAt = 804_000_000
  const folderUpdatedAt = exportedAt - 10
  const tagCreatedAt = exportedAt - 20
  const library = libraryEnvelopeSchema.parse({
    exportedAt,
    deviceID: 'legacy-macos-device',
    folders: [{
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Legacy folder',
      sortOrder: 0,
      isSystem: false,
      folderType: 'noteFolder',
      updatedAt: folderUpdatedAt,
    }],
    tags: [{
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Legacy tag',
      color: '#7c3aed',
      createdAt: tagCreatedAt,
    }],
  })

  const imported = importLegacyBundle({ library, notes: [] }, 'workspace-fixture')
  expect(imported.sections[0]).toMatchObject({
    createdAt: new Date(Date.UTC(2001, 0, 1) + folderUpdatedAt * 1000).toISOString(),
    updatedAt: new Date(Date.UTC(2001, 0, 1) + folderUpdatedAt * 1000).toISOString(),
  })
  expect(imported.tags[0]).toMatchObject({
    createdAt: new Date(Date.UTC(2001, 0, 1) + tagCreatedAt * 1000).toISOString(),
    updatedAt: new Date(Date.UTC(2001, 0, 1) + tagCreatedAt * 1000).toISOString(),
  })
})

test('rebuilds from legacy blocks when an Android edit leaves stale Tiptap content', () => {
  const result = legacyDocumentToTiptap({
    blocks: [
      { type: 'paragraph', text: [{ text: 'Web original' }] },
      { type: 'paragraph', text: [{ text: 'Android edit' }] },
    ],
    notebookNextTiptap: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Web original' }] }] },
  }) as { content: Array<{ content?: Array<{ text?: string }> }> }

  expect(result.content.flatMap((node) => node.content?.map((child) => child.text) ?? [])).toEqual(['Web original', 'Android edit'])
})

test('normalizes unambiguous Markdown pasted into a legacy plain paragraph', () => {
  const markdown = legacyTiptapToCanonicalMarkdown({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: '# 标题\n\n正文和 **重点**\n\n- 第一项\n- 第二项\n\n[资料] (https://example.com)',
      }],
    }],
  })
  expect(markdown).toContain('# 标题')
  expect(markdown).toContain('**重点**')
  expect(markdown).toContain('- 第一项')
  expect(markdown).toContain('[资料](https://example.com)')
})

test('keeps ambiguous dialogue literal and preserves legacy line breaks', () => {
  const markdown = legacyTiptapToCanonicalMarkdown({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: '- 这只是单行对白\n下一行仍属于正文' }],
    }],
  })
  expect(markdown).toContain('\\- 这只是单行对白')
  expect(markdown).not.toContain('\n- 这只是单行对白')
  const rendered = JSON.stringify(markdownToEditorCache(markdown))
  expect(rendered).toContain('hardBreak')
  expect(rendered).toContain('下一行仍属于正文')
})

test('repairs only safe legacy link spellings and removes unsupported underline marks', () => {
  expect(normalizeLegacyMarkdownSyntax('[页面] (https://example.com)')).toBe('[页面](https://example.com)')
  expect(normalizeLegacyMarkdownSyntax('[页面]([https://example.com](https://example.com))')).toBe('[页面](https://example.com)')
  expect(normalizeLegacyMarkdownSyntax('\\[目录\\](#section)')).toBe('[目录](#section)')
  expect(normalizeLegacyMarkdownSyntax('\\[空链接\\](#)')).toBe('[空链接](#)')
  expect(normalizeLegacyMarkdownSyntax('    \\[型号链接\\]("[https://example.com](https://example.com)")')).toBe('[型号链接](https://example.com)')
  expect(normalizeLegacyMarkdownSyntax('正文\n\n\n&nbsp;\n\n下一段')).toBe('正文\n\n下一段')
  expect(normalizeLegacyMarkdownSyntax('```\n\n&nbsp;\n```')).toBe('```\n\n&nbsp;\n```')
  expect(normalizeLegacyMarkdownSyntax('[页面]([https://one.example](https://two.example))')).toContain('[https://one.example]')
  const markdown = legacyTiptapToCanonicalMarkdown({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留正文', marks: [{ type: 'underline' }] }] }],
  })
  expect(markdown).toBe('保留正文')
})

test('imports and re-exports legacy encrypted folders without exposing their pages as ordinary folders', async () => {
  const fixture = async (name: string) => JSON.parse(await readFile(resolve(import.meta.dirname, `../../../../SyncContractFixtures/${name}`), 'utf8'))
  const library = libraryEnvelopeSchema.parse(await fixture('library-envelope.json'))
  const note = noteEnvelopeSchema.parse(await fixture('note-envelope.json'))
  const privateFolderId = '55555555-5555-4555-8555-555555555555'
  library.encryptedData = {
    encryptedFolders: [{ id: privateFolderId, name: 'Private Fixture', order: 0 }],
    encryptedNoteIDs: [note.noteID],
    noteToFolderMapping: { [note.noteID]: privateFolderId },
  }
  const imported = importLegacyBundle({ library, notes: [note] }, 'workspace-fixture')
  expect(imported.privateNotebook).toMatchObject({ name: '隐私笔记本', locked: true })
  expect(imported.sections.find((section) => section.id === privateFolderId)).toMatchObject({ notebookId: imported.privateNotebook?.id, name: 'Private Fixture' })
  expect(imported.pages[0]).toMatchObject({ locked: true, sectionId: privateFolderId })

  const bundle: NotebookDataBundle = {
    notebooks: [imported.notebook, imported.privateNotebook!], sections: imported.sections, pages: imported.pages,
    documents: imported.documents, assets: imported.assets, tags: imported.tags, pageTags: imported.pageTags,
    taskSteps: imported.taskSteps, pageLinks: imported.pageLinks, readingPositions: imported.readingPositions,
    revisions: imported.revisions, tombstones: imported.tombstones, comments: [], knowledgeEntities: [], knowledgeRelations: [],
  }
  const encoded = await encodeLegacyRepository(bundle, new Map(), 'roundtrip-device')
  const exportedLibrary = libraryEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get('library.json'))))
  expect(exportedLibrary.folders.some((folder) => folder.id === privateFolderId)).toBe(false)
  expect(exportedLibrary.encryptedData).toMatchObject({
    encryptedFolders: [{ id: privateFolderId, name: 'Private Fixture', order: 0 }],
    encryptedNoteIDs: [note.noteID],
    noteToFolderMapping: { [note.noteID]: privateFolderId },
  })
})

test('namespaces page-local asset ids in document migration packages', () => {
  const note = (id: string) => ({
    id, title: id, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', folderID: null, folderName: '',
    reminderAt: null, recurrenceRule: '', version: 1, tagIDs: [], viewMode: 'richText', deletedAt: null,
    originalFolderID: null, originalFolderName: null, blockCount: 1, assetCount: 1, documentPath: `Notes/${id}/document.json`,
    itemType: 'note', todoDueAt: null, todoCompletedAt: null, todoIsImportant: false, todoOrder: null, linkedNoteIDs: [],
  })
  const manifest = migrationManifestSchema.parse({
    schemaVersion: '1.0', exportedAt: '2026-01-01T00:00:00Z', notes: [note('11111111-1111-4111-8111-111111111111'), note('22222222-2222-4222-8222-222222222222')],
    folders: [], tags: [], todoSteps: [],
  })
  const document = migratedDocumentSchema.parse({
    schemaVersion: '1.0', source: 'test', blocks: [{
      id: 'block-1', type: 'attachment', text: null, level: null, listStyle: null, order: null, checked: null, indent: null,
      asset: { id: 'asset-1', kind: 'image', filename: 'Assets/image.png', mimeType: 'image/png', width: null, height: null, duration: null, createdAt: null, sidecarFiles: [] }, table: null,
    }],
  })
  const documents = new Map(manifest.notes.map((item) => [item.documentPath, document]))
  const imported = importDocumentMigrationPackage(manifest, documents, 'workspace')
  expect(imported.assets.map((item) => item.id)).toEqual([
    'legacy-asset:11111111-1111-4111-8111-111111111111:asset-1',
    'legacy-asset:22222222-2222-4222-8222-222222222222:asset-1',
  ])
  expect(new Set(imported.assets.map((item) => item.id)).size).toBe(2)
  expect(imported.documents[0]).toMatchObject({ schemaVersion: 3, tiptapJson: { type: 'doc', content: [] } })
  expect(imported.documents[0]?.markdown).toContain(`notebook-asset:${imported.assets[0]?.id}`)
})

test('exports Notebook Next data as an Android-compatible SSH repository without losing Tiptap content', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  const notebookId = '10000000-0000-4000-8000-000000000001'
  const sectionId = '20000000-0000-4000-8000-000000000001'
  const pageId = '30000000-0000-4000-8000-000000000001'
  const assetId = 'asset-image'
  const now = '2026-07-22T05:00:00.000Z'
  const tiptapJson = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '混排页面' }] }, { type: 'image', attrs: { src: `notebook-asset:${assetId}`, legacyAssetId: assetId, alt: '图' } }] }
  const revisions = Array.from({ length: 120 }, (_, index) => ({
    id: `50000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, pageId,
    document: { pageId, schemaVersion: 1 as const, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `历史 ${index}` }] }] }, updatedAt: new Date(Date.parse(now) - (120 - index) * 1000).toISOString() },
    createdAt: new Date(Date.parse(now) - (120 - index) * 1000).toISOString(), reason: 'import' as const,
  }))
  const bundle: NotebookDataBundle = {
    notebooks: [{ id: notebookId, workspaceId, name: '测试', sortOrder: 0, createdAt: now, updatedAt: now }],
    sections: [{ id: sectionId, notebookId, name: '分区', sortOrder: 0, createdAt: now, updatedAt: now }],
    pages: [{ id: pageId, workspaceId, sectionId, kind: 'document', title: '测试笔记', preview: '混排页面', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending' }],
    documents: [{ pageId, schemaVersion: 1, tiptapJson, updatedAt: now }],
    assets: [{ id: assetId, pageId, kind: 'image', filename: 'image.png', mimeType: 'image/png', createdAt: now }],
    tags: [], pageTags: [], taskSteps: [], pageLinks: [], readingPositions: [], revisions, tombstones: [], knowledgeEntities: [], knowledgeRelations: [], comments: [],
  }
  const encoded = await encodeLegacyRepository(bundle, new Map([[assetId, new Uint8Array([1, 2, 3])]]), 'web-device')
  const envelope = noteEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get(`notes/${pageId}.json`))))
  const imported = importLegacyNote(envelope, workspaceId)
  expect(imported.document).toMatchObject({ schemaVersion: 3, tiptapJson: { type: 'doc', content: [] } })
  expect(imported.document.markdown).toContain('## 混排页面')
  expect(imported.document.markdown).toContain(`notebook-asset:${assetId}`)
  expect(envelope.history).toHaveLength(120)
  const firstHistory = envelope.history[0]
  expect(firstHistory).toBeDefined()
  expect((firstHistory!.snapshot as { document: { notebookNextTiptap: unknown } }).document.notebookNextTiptap).toEqual(revisions[0]?.document.tiptapJson)
  expect(encoded.files.get(`attachments/${pageId}/${assetId}-image.png`)).toEqual(new Uint8Array([1, 2, 3]))
  expect(noteIndexSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get('notes/index.json')))).entries[0]?.noteID).toBe(pageId)
})

test('compacts consecutive duplicate recovery points and removes a trailing current snapshot', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  const pageId = '30000000-0000-4000-8000-000000000002'
  const now = '2026-07-22T05:00:00.000Z'
  const document = (text: string, offset: number) => ({ pageId, schemaVersion: 1 as const, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, updatedAt: new Date(Date.parse(now) + offset).toISOString() })
  const values = ['A', 'A', 'B', 'current'].map((text, index) => ({ id: `50000000-0000-4000-8000-${index.toString().padStart(12, '0')}`, pageId, document: document(text, index), createdAt: new Date(Date.parse(now) + index).toISOString(), reason: 'import' as const }))
  const bundle: NotebookDataBundle = {
    notebooks: [], sections: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], readingPositions: [], tombstones: [], knowledgeEntities: [], knowledgeRelations: [], comments: [],
    pages: [{ id: pageId, workspaceId, kind: 'document', title: '历史压缩', preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending' }],
    documents: [document('current', 4)], revisions: values,
  }
  const encoded = await encodeLegacyRepository(bundle, new Map(), 'web-device')
  const envelope = noteEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get(`notes/${pageId}.json`))))
  expect(envelope.history.map((item) => ((item.snapshot as { document: { blocks: Array<{ text?: Array<{ text: string }> }> } }).document.blocks[0]?.text?.[0]?.text))).toEqual(['A', 'B'])
})

test('stores one canonical GFM body, hash-only history, and content-addressed assets in repository v3', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  const notebookId = '10000000-0000-4000-8000-000000000001'
  const sectionId = '20000000-0000-4000-8000-000000000001'
  const pageId = '30000000-0000-4000-8000-000000000003'
  const assetId = 'asset-v3-image'
  const now = '2026-07-22T05:00:00.000Z'
  const markdown = '# 标题\n\n- [x] 任务\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![图](notebook-asset:asset-v3-image "说明")\n\n[[page:target-page]]\n\n![[page:target-page#^b-one]]\n\n[[page:target-page#group:g-one]]'
  const document = { pageId, schemaVersion: 3, markdown, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '缓存不应同步' }] }] }, updatedAt: now }
  const bundle: NotebookDataBundle = {
    notebooks: [{ id: notebookId, workspaceId, name: '测试', sortOrder: 0, createdAt: now, updatedAt: now }], sections: [{ id: sectionId, notebookId, name: '分区', sortOrder: 0, createdAt: now, updatedAt: now }],
    pages: [{ id: pageId, workspaceId, sectionId, icon: '🚀', kind: 'document', title: '混合 Markdown', preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending' }], documents: [document],
    assets: [{ id: assetId, pageId, kind: 'image', filename: 'image.png', mimeType: 'image/png', createdAt: now, caption: '说明', displayWidth: 480, alignment: 'center' }], revisions: [
      { id: '50000000-0000-4000-8000-000000000001', pageId, pageIcon: '📝', document: { ...document, markdown: '历史正文' }, createdAt: '2026-07-22T04:00:00.000Z', reason: 'import' },
      { id: '50000000-0000-4000-8000-000000000002', pageId, pageIcon: '📌', document: { ...document, markdown: '历史正文' }, createdAt: now, reason: 'manual' },
    ],
    tags: [], pageTags: [], taskSteps: [], pageLinks: [],
    readingPositions: [{
      id: pageId,
      pageId,
      anchorUtf16Offset: 321,
      viewportOffsetFraction: 0.35,
      updatedAt: now,
      deviceId: 'electron',
    }],
    tombstones: [{
      id: 'page:migration',
      workspaceId,
      entityType: 'page',
      entityId: 'migration',
      deletedAt: now,
      deviceId: 'legacy-seed',
    }], knowledgeEntities: [], knowledgeRelations: [], comments: [],
  }
  const encoded = await encodeMarkdownRepository(bundle, new Map([[assetId, new Uint8Array([1, 2, 3])]]), 'electron')
  const note = JSON.parse(new TextDecoder().decode(encoded.files.get(`notes/${pageId}.json`))) as MarkdownNoteEnvelope
  const index = noteIndexSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get('notes/index.json'))))
  expect(note.schemaVersion).toBe(3)
  expect(note.contentObjects[note.currentContentHash]).toBe(markdown)
  expect(JSON.stringify(note)).not.toContain('缓存不应同步')
  expect(note.history[0]).not.toHaveProperty('snapshot')
  expect(note.metadata.icon).toBe('🚀')
  expect(note.history[0]?.pageIcon).toBe('📝')
  expect(note.history[1]?.pageIcon).toBe('📌')
  expect(note.history[0]?.contentHash).toHaveLength(64)
  expect(note.assets[0]?.objectHash).toHaveLength(64)
  expect(note.linkedPageIDs).toEqual(['target-page'])
  expect(index.deletedEntries).toEqual([])
  expect([...encoded.files.keys()]).toContain(`objects/${note.assets[0]?.objectHash?.slice(0, 2)}/${note.assets[0]?.objectHash}`)
  const library = libraryEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get('library.json'))))
  const readingPositions = readingPositionsSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get('notes/reading_positions.json'))))
  const imported = await importMarkdownRepository({ library, notes: [note], index, readingPositions }, workspaceId)
  expect(imported.documents[0]?.markdown).toBe(markdown)
  expect(imported.documents[0]?.tiptapJson).toEqual({ type: 'doc', content: [] })
  expect(imported.revisions[0]?.document.markdown).toBe('历史正文')
  expect(imported.pages[0]?.icon).toBe('🚀')
  expect(imported.revisions[0]?.pageIcon).toBe('📝')
  expect(imported.revisions[1]?.pageIcon).toBe('📌')
  expect(imported.readingPositions).toEqual([{
    id: pageId,
    pageId,
    anchorUtf16Offset: 321,
    viewportOffsetFraction: 0.35,
    updatedAt: now,
    deviceId: 'electron',
  }])
  expect(imported.revisions[0]?.document.tiptapJson).toEqual({ type: 'doc', content: [] })
  expect(imported.pageLinks.map((link) => `${link.kind}:${link.excerpt ?? 'page'}`)).toEqual([
    'link:page',
    'embed:block:b-one',
    'link:group:g-one',
  ])
  expect(JSON.stringify(markdownToEditorCache(markdown, note.assets))).toContain('标题')
  expect(JSON.stringify(markdownToEditorCache(markdown, note.assets))).toContain('"width":480')
  expect(JSON.stringify(markdownToEditorCache(markdown, note.assets))).toContain('"textAlign":"center"')
  const entry = index.entries[0]!
  const reused = await encodeMarkdownRepository(
    { ...bundle, pages: bundle.pages.map((page) => ({ ...page, syncStatus: 'synced' as const })) },
    new Map([[assetId, new Uint8Array([1, 2, 3])]]),
    'electron',
    undefined,
    new Map([[pageId, `${entry.version}:${entry.contentHash}:${entry.historyCount}:gzip`]]),
  )
  expect(reused.files.has(`notes/${pageId}.json`)).toBe(false)
  expect(reused.files.has(`objects/${note.assets[0]?.objectHash?.slice(0, 2)}/${note.assets[0]?.objectHash}`)).toBe(true)
  expect(noteIndexSchema.parse(JSON.parse(new TextDecoder().decode(reused.files.get('notes/index.json')))).entries).toEqual(index.entries)
})

test('rejects missing or corrupted current and historical Markdown objects', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  const pageId = '30000000-0000-4000-8000-000000000004'
  const now = '2026-07-22T05:00:00.000Z'
  const library = libraryEnvelopeSchema.parse({ exportedAt: 1, deviceID: 'device', folders: [], tags: [], deletedFolders: [], deletedTags: [] })
  const note: MarkdownNoteEnvelope = {
    schemaVersion: 3, noteID: pageId,
    metadata: { id: pageId, workspaceId, kind: 'document', title: '损坏', preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'synced' },
    currentContentHash: '0'.repeat(64), contentObjects: { ['0'.repeat(64)]: 'not matching' }, history: [], assets: [], taskSteps: [], tagIDs: [], linkedPageIDs: [],
  }
  await expect(importMarkdownRepository({ library, notes: [note] }, workspaceId)).rejects.toThrow(/已损坏/)
  const missing = { ...note, contentObjects: {} }
  await expect(importMarkdownRepository({ library, notes: [missing] }, workspaceId)).rejects.toThrow(/缺少当前正文/)
})

test('encrypts private note metadata, body and history with the SSH secret', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  const notebookId = '10000000-0000-4000-8000-000000000001'
  const pageId = '30000000-0000-4000-8000-000000000005'
  const now = '2026-07-22T05:00:00.000Z'
  const bundle: NotebookDataBundle = {
    notebooks: [{ id: notebookId, workspaceId, name: '隐私笔记本', sortOrder: 0, createdAt: now, updatedAt: now, locked: true }], sections: [],
    pages: [{ id: pageId, workspaceId, kind: 'document', title: '不能泄露的标题', preview: '不能泄露的摘要', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending', locked: true }],
    documents: [{ pageId, schemaVersion: 3, markdown: '绝密正文', tiptapJson: { type: 'doc' }, updatedAt: now }],
    revisions: [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], readingPositions: [], tombstones: [], knowledgeEntities: [], knowledgeRelations: [], comments: [],
  }
  const encoded = await encodeMarkdownRepository(bundle, new Map(), 'electron', 'strong ssh password')
  const storedText = new TextDecoder().decode(encoded.files.get(`notes/${pageId}.json`))
  expect(storedText).not.toContain('不能泄露的标题')
  expect(storedText).not.toContain('绝密正文')
  const stored = JSON.parse(storedText)
  const privacyCheck = JSON.parse(new TextDecoder().decode(encoded.files.get('notes/privacy.json'))) as PrivacyKeyCheck
  await expect(verifyPrivacyKeyCheck(privacyCheck, 'strong ssh password')).resolves.toBeUndefined()
  await expect(verifyPrivacyKeyCheck(privacyCheck, 'wrong password')).rejects.toThrow(/未修改任何笔记/)
  const library = libraryEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get('library.json'))))
  const imported = await importMarkdownRepository({ library, notes: [stored], privacySecret: 'strong ssh password' }, workspaceId)
  expect(imported.pages[0]?.title).toBe('不能泄露的标题')
  expect(imported.documents[0]?.markdown).toBe('绝密正文')
  await expect(importMarkdownRepository({ library, notes: [stored], privacySecret: 'wrong password' }, workspaceId)).rejects.toThrow(/解密失败/)
})

test('retains tombstoned note envelopes and history without exposing them as active index entries', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  const notebookId = '10000000-0000-4000-8000-000000000001'
  const sectionId = '20000000-0000-4000-8000-000000000001'
  const pageId = '30000000-0000-4000-8000-000000000009'
  const now = '2026-07-22T05:00:00.000Z'
  const document = { pageId, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '已删除的历史' }] }] }, updatedAt: now }
  const bundle: NotebookDataBundle = {
    notebooks: [{ id: notebookId, workspaceId, name: '测试', sortOrder: 0, createdAt: now, updatedAt: now }],
    sections: [{ id: sectionId, notebookId, name: '分区', sortOrder: 0, createdAt: now, updatedAt: now }],
    pages: [{ id: pageId, workspaceId, sectionId, kind: 'document', title: '已删除', preview: '', favorite: false, createdAt: now, updatedAt: now, deletedAt: now, syncStatus: 'pending' }],
    documents: [document], assets: [], tags: [], pageTags: [], taskSteps: [], pageLinks: [], readingPositions: [],
    revisions: [{ id: '50000000-0000-4000-8000-000000000009', pageId, document, createdAt: now, reason: 'import' }],
    tombstones: [{ id: `page:${pageId}`, workspaceId, entityType: 'page', entityId: pageId, deletedAt: now, deviceId: 'web-device' }],
    knowledgeEntities: [], knowledgeRelations: [], comments: [],
  }
  const encoded = await encodeLegacyRepository(bundle, new Map(), 'web-device')
  const envelope = noteEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get(`notes/${pageId}.json`))))
  const index = noteIndexSchema.parse(JSON.parse(new TextDecoder().decode(encoded.files.get('notes/index.json'))))
  expect(envelope.history).toHaveLength(1)
  expect(index.entries).toEqual([])
  expect(index.deletedEntries[0]?.noteID).toBe(pageId)
})
