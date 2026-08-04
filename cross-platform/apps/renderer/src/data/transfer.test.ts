import { expect, test, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { build as buildPlist } from 'plist'
import type { NotebookDataBundle } from '@notebook/domain'
import { sha256Hex } from '@notebook/sync-contract'
import { decodeImport, encodeExport } from './transfer'

test('accepts a v3 incremental repository snapshot without downloaded note envelopes', async () => {
  const decoded = await decodeImport([
    {
      name: 'library.json',
      data: strToU8(JSON.stringify({
        exportedAt: 1,
        deviceID: 'desktop-test',
        folders: [],
        tags: [],
        deletedFolders: [],
        deletedTags: [],
      })),
    },
    {
      name: 'notes/index.json',
      data: strToU8(JSON.stringify({
        generatedAt: 1,
        deviceID: 'desktop-test',
        repositoryFormat: {
          version: 3,
          noteEncoding: 'gzip',
          contentFormat: 'markdown-gfm',
          assetAddressing: 'sha256',
        },
        entries: [],
        deletedEntries: [],
      })),
    },
  ], 'workspace-test')

  expect(decoded.bundle.pages).toEqual([])
  expect(decoded.bundle.documents).toEqual([])
})

test('loads an omitted v3 resource by content hash when its local asset id differs', async () => {
  const noteId = '11111111-1111-4111-8111-111111111111'
  const remoteAssetId = 'remote-asset-id'
  const bytes = new Uint8Array([7, 8, 9])
  const objectHash = sha256Hex(bytes)
  const markdown = '# Resource test'
  const contentHash = sha256Hex(markdown)
  const loader = vi.fn(async (assetId: string, hash?: string) => assetId === remoteAssetId && hash === objectHash ? bytes : undefined)
  const now = '2026-07-22T00:00:00.000Z'

  const decoded = await decodeImport([
    { name: 'library.json', data: strToU8(JSON.stringify({ exportedAt: 1, deviceID: 'desktop-test', folders: [], tags: [], deletedFolders: [], deletedTags: [] })) },
    {
      name: 'notes/index.json',
      data: strToU8(JSON.stringify({
        generatedAt: 1,
        deviceID: 'desktop-test',
        repositoryFormat: { version: 3, noteEncoding: 'gzip', contentFormat: 'markdown-gfm', assetAddressing: 'sha256' },
        entries: [{ noteID: noteId, version: 1, contentHash, historyCount: 0 }],
        deletedEntries: [],
      })),
    },
    {
      name: `notes/${noteId}.json`,
      data: strToU8(JSON.stringify({
        schemaVersion: 3,
        noteID: noteId,
        metadata: { id: noteId, workspaceId: 'remote', kind: 'document', title: 'Resource test', preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'synced' },
        currentContentHash: contentHash,
        contentObjects: { [contentHash]: markdown },
        history: [],
        assets: [{ id: remoteAssetId, pageId: noteId, kind: 'file', filename: 'shared.bin', mimeType: 'application/octet-stream', byteSize: bytes.byteLength, checksum: objectHash, objectHash, localPath: `objects/${objectHash.slice(0, 2)}/${objectHash}`, createdAt: now }],
        taskSteps: [], tagIDs: [], linkedPageIDs: [],
      })),
    },
  ], 'workspace-test', undefined, loader)

  expect(loader).toHaveBeenCalledWith(remoteAssetId, objectHash)
  expect(decoded.assetContents.get(remoteAssetId)).toEqual(bytes)
})

test('imports the macOS document migration package as canonical Markdown without dropping assets', async () => {
  const noteId = '11111111-1111-4111-8111-111111111111'
  const folderId = '22222222-2222-4222-8222-222222222222'
  const tagId = '33333333-3333-4333-8333-333333333333'
  const stepId = '44444444-4444-4444-8444-444444444444'
  const documentPath = `Notes/${noteId}/document.json`
  const assetPath = `Notes/${noteId}/Assets/image_photo.png`
  const manifest = {
    schemaVersion: '7.0', exportedAt: '2026-07-21T10:00:00Z',
    folders: [{ id: folderId, name: 'Work', sortOrder: 0, isSystem: false, createdAt: '2026-01-01T00:00:00Z', folderType: 'noteFolder' }],
    tags: [{ id: tagId, name: 'Important', color: '#f00', createdAt: '2026-01-01T00:00:00Z' }],
    notes: [{ id: noteId, title: 'Legacy', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z', folderID: folderId, folderName: 'Work', reminderAt: null, recurrenceRule: 'none', version: 9, tagIDs: [tagId], viewMode: 'text', deletedAt: null, originalFolderID: null, originalFolderName: null, blockCount: 2, assetCount: 1, documentPath, itemType: 'todo', todoDueAt: '2026-07-30T00:00:00Z', todoCompletedAt: null, todoIsImportant: true, todoOrder: 3, linkedNoteIDs: [] }],
    todoSteps: [{ id: stepId, noteID: noteId, text: 'Ship', checked: false, order: 0, createdAt: '2026-07-20T00:00:00Z' }],
  }
  const document = { schemaVersion: '1.0', source: 'NotebookBlockDocument', blocks: [
    { id: 'text-1', type: 'paragraph', text: [{ text: 'Styled', bold: true, italic: false, underline: false, strikethrough: false, textColor: '#123456', backgroundColor: null, link: null, fontFamily: 'Avenir', fontSize: 15, kern: 1, baselineOffset: 0, paragraphStyle: { alignment: 1, lineSpacing: 2, paragraphSpacing: 4, paragraphSpacingBefore: 0, firstLineHeadIndent: 0, headIndent: 0, tailIndent: 0 } }] },
    { id: 'asset-1', type: 'attachment', asset: { id: 'image', kind: 'image', filename: 'Assets/image_photo.png', mimeType: 'image/png', width: 120, height: 80, duration: null, createdAt: '2026-07-20T00:00:00Z', sidecarFiles: [] } },
  ] }
  const zip = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [documentPath]: strToU8(JSON.stringify(document)), [assetPath]: new Uint8Array([1, 2, 3]) })
  const decoded = await decodeImport([{ name: 'legacy.zip', data: zip }], 'workspace-a')
  const migratedAssetId = `legacy-asset:${noteId}:image`
  expect(decoded.bundle.pages[0]).toMatchObject({ id: noteId, kind: 'task', dueAt: '2026-07-30T00:00:00Z', important: true, legacyVersion: 9 })
  expect(decoded.bundle.documents[0]).toMatchObject({ schemaVersion: 3, tiptapJson: { type: 'doc', content: [] } })
  expect(decoded.bundle.documents[0]?.markdown).toContain('**Styled**')
  expect(decoded.bundle.documents[0]?.markdown).toContain(`notebook-asset:${migratedAssetId}`)
  expect(decoded.bundle.documents[0]?.legacySource).toBeUndefined()
  expect(decoded.bundle.assets[0]).toMatchObject({ id: migratedAssetId, filename: 'image_photo.png', width: 120 })
  expect(decoded.assetContents.get(migratedAssetId)).toEqual(new Uint8Array([1, 2, 3]))
  expect(decoded.bundle.taskSteps[0]?.id).toBe(stepId)
})

test('restores privacy mappings from the old macOS configuration files', async () => {
  const noteId = '11111111-1111-4111-8111-111111111111'
  const folderId = '22222222-2222-4222-8222-222222222222'
  const documentPath = `Notes/${noteId}/document.json`
  const manifest = {
    schemaVersion: '1.0', exportedAt: '2026-07-21T10:00:00Z', folders: [], tags: [], todoSteps: [],
    notes: [{ id: noteId, title: 'Private', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z', folderID: null, folderName: '', reminderAt: null, recurrenceRule: 'none', version: 1, tagIDs: [], viewMode: 'text', deletedAt: null, originalFolderID: null, originalFolderName: null, blockCount: 1, assetCount: 0, documentPath, itemType: 'note', todoDueAt: null, todoCompletedAt: null, todoIsImportant: false, todoOrder: null, linkedNoteIDs: [] }],
  }
  const document = { schemaVersion: '1.0', source: 'NotebookBlockDocument', blocks: [{ id: 'text-1', type: 'paragraph', text: [{ text: 'Hidden', bold: false, italic: false, underline: false, strikethrough: false, textColor: null, backgroundColor: null, link: null, fontFamily: null, fontSize: null, kern: null, baselineOffset: null, paragraphStyle: null }] }] }
  const foldersData = btoa(JSON.stringify([{ id: folderId, name: 'Private Folder', order: 0 }]))
  const zip = zipSync({
    'Notes/manifest.json': strToU8(JSON.stringify(manifest)),
    [documentPath]: strToU8(JSON.stringify(document)),
    'Config/EncryptedData.plist': strToU8(buildPlist({ encryptedNoteIDs: [noteId], noteToFolderMapping: { [noteId]: folderId } })),
    'Config/EncryptedFolders.plist': strToU8(buildPlist({ foldersData })),
  })
  const decoded = await decodeImport([{ name: 'legacy-private.zip', data: zip }], 'workspace-a')
  expect(decoded.bundle.notebooks.find((notebook) => notebook.locked)).toMatchObject({ name: '隐私笔记本' })
  expect(decoded.bundle.sections.find((section) => section.id === folderId)).toMatchObject({ name: 'Private Folder' })
  expect(decoded.bundle.pages[0]).toMatchObject({ id: noteId, sectionId: folderId, locked: true })
})

test('complete backup restore canonicalizes legacy bodies and preserves history tombstones privacy and attachment bytes', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  const notebookId = '10000000-0000-4000-8000-000000000001'
  const sectionId = '20000000-0000-4000-8000-000000000001'
  const pageId = '30000000-0000-4000-8000-000000000001'
  const assetId = '40000000-0000-4000-8000-000000000001'
  const now = '2026-07-22T00:00:00.000Z'
  const document = { pageId, schemaVersion: 1 as const, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '当前正文' }] }] }, updatedAt: now }
  const revisionDocument = { ...document, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '历史正文' }] }] }, updatedAt: '2026-07-21T00:00:00.000Z' }
  const bundle: NotebookDataBundle = {
    notebooks: [{ id: notebookId, workspaceId, name: '隐私笔记本', sortOrder: 0, createdAt: now, updatedAt: now, locked: true }],
    sections: [{ id: sectionId, notebookId, name: '隐私分区', sortOrder: 0, createdAt: now, updatedAt: now }],
    pages: [{ id: pageId, workspaceId, sectionId, kind: 'document', title: '私密笔记', preview: '当前正文', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'synced', locked: true }],
    documents: [document], tags: [], pageTags: [], taskSteps: [], pageLinks: [], readingPositions: [],
    assets: [{ id: assetId, pageId, kind: 'image', filename: 'image.png', mimeType: 'image/png', byteSize: 4, createdAt: now }],
    revisions: [{ id: '50000000-0000-4000-8000-000000000001', pageId, document: revisionDocument, createdAt: revisionDocument.updatedAt, reason: 'import' }],
    tombstones: [{ id: 'page:60000000-0000-4000-8000-000000000001', workspaceId, entityType: 'page', entityId: '60000000-0000-4000-8000-000000000001', deletedAt: now, deviceId: 'device' }],
    knowledgeEntities: [], knowledgeRelations: [], comments: [],
  }
  const bytes = new Uint8Array([137, 80, 78, 71])
  const archive = encodeExport(bundle, new Map([[assetId, bytes]]))
  const decoded = await decodeImport([{ name: 'backup.zip', data: archive }], workspaceId)
  expect(decoded.bundle).toMatchObject({
    notebooks: bundle.notebooks,
    sections: bundle.sections,
    assets: bundle.assets,
    tombstones: bundle.tombstones,
  })
  expect(decoded.bundle.pages[0]).toMatchObject({ id: pageId, locked: true, syncStatus: 'pending' })
  expect(decoded.bundle.documents[0]).toMatchObject({
    pageId,
    schemaVersion: 3,
    markdown: '当前正文',
    tiptapJson: { type: 'doc', content: [] },
  })
  expect(decoded.bundle.revisions[0]?.document).toMatchObject({
    schemaVersion: 3,
    markdown: '历史正文',
    tiptapJson: { type: 'doc', content: [] },
  })
  expect(decoded.assetContents.get(assetId)).toEqual(bytes)
})

test('rejects an attachment whose bytes do not match its declared SHA-256', async () => {
  const now = '2026-07-22T00:00:00.000Z'
  const bundle: NotebookDataBundle = {
    notebooks: [], sections: [], pages: [{ id: 'page', workspaceId: 'workspace', kind: 'document', title: 'x', preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'synced' }], documents: [],
    assets: [{ id: 'asset', pageId: 'page', kind: 'file', filename: 'damaged.bin', mimeType: 'application/octet-stream', checksum: '0'.repeat(64), byteSize: 3, createdAt: now }],
    tags: [], pageTags: [], taskSteps: [], pageLinks: [], readingPositions: [], revisions: [], tombstones: [], knowledgeEntities: [], knowledgeRelations: [], comments: [],
  }
  const archive = encodeExport(bundle, new Map([['asset', new Uint8Array([1, 2, 3])]]))
  await expect(decodeImport([{ name: 'damaged.zip', data: archive }], 'workspace')).rejects.toThrow(/SHA-256/)
})
