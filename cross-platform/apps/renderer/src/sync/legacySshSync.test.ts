import type { NotebookDataBundle, Page, PageDocument } from '@notebook/domain'
import { encodeMarkdownRepository, sha256Hex, stripPrivateAttachmentsForSsh } from '@notebook/sync-contract'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { mergeBundles, publicationBundleWithRemoteConflicts, retryRemoteIndexChanges, semanticallyEqualRepositoryJson, synchronizeLegacySsh } from './legacySshSync'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const notebookId = '20000000-0000-4000-8000-000000000001'
const pageId = '30000000-0000-4000-8000-000000000001'
const timestamp = '2026-07-22T00:00:00.000Z'

function page(overrides: Partial<Page> = {}): Page {
  return { id: pageId, workspaceId, kind: 'document', title: '页面', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced', legacyVersion: 1, ...overrides }
}

function document(text: string, updatedAt = timestamp): PageDocument {
  return { pageId, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, updatedAt }
}

function bundle(currentPage?: Page, currentDocument?: PageDocument): NotebookDataBundle {
  return {
    notebooks: [{ id: notebookId, workspaceId, name: '迁移的笔记', sortOrder: 0, createdAt: timestamp, updatedAt: timestamp }],
    sections: [], pages: currentPage ? [currentPage] : [], documents: currentDocument ? [currentDocument] : [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: [], comments: [], tombstones: [],
  }
}

describe('legacy SSH conflict merge', () => {
  test('keeps private SSH attachment bytes local while ordinary attachments still publish', async () => {
    const privatePageId = '30000000-0000-4000-8000-0000000000aa'
    const privateNotebookId = '20000000-0000-4000-8000-0000000000aa'
    const privateBytes = new TextEncoder().encode('PRIVATE ATTACHMENT BYTES')
    const publicBytes = new TextEncoder().encode('PUBLIC ATTACHMENT BYTES')
    const value = bundle(page(), document('public body'))
    value.notebooks.push({ id: privateNotebookId, workspaceId, name: 'Private', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp, locked: true })
    value.pages.push(page({ id: privatePageId, title: 'private title', locked: true }))
    value.documents.push({ ...document('private body'), pageId: privatePageId })
    value.assets.push(
      { id: 'asset-public', pageId, kind: 'file', filename: 'public.txt', mimeType: 'text/plain', createdAt: timestamp },
      { id: 'asset-private', pageId: privatePageId, kind: 'file', filename: 'private.txt', mimeType: 'text/plain', createdAt: timestamp },
    )
    const safe = stripPrivateAttachmentsForSsh(value)
    expect(safe.privateAssetIds).toEqual(new Set(['asset-private']))
    const encoded = await encodeMarkdownRepository(value, new Map([
      ['asset-public', publicBytes],
      ['asset-private', privateBytes],
    ]), 'electron', 'test-password')
    const filenames = [...encoded.files.keys()]
    expect(filenames).toContain(`objects/${sha256Hex(publicBytes).slice(0, 2)}/${sha256Hex(publicBytes)}`)
    expect(filenames).not.toContain(`objects/${sha256Hex(privateBytes).slice(0, 2)}/${sha256Hex(privateBytes)}`)
    const serialized = [...encoded.files.values()].map((bytes) => new TextDecoder().decode(bytes)).join('\n')
    expect(serialized).not.toContain('private.txt')
    expect(serialized).not.toContain('PRIVATE ATTACHMENT BYTES')
  })

  test('re-pulls and retries when another device publishes during the sync window', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'legacySftp:push': Error: 远端索引在同步期间已变化，请重新同步"))
      .mockRejectedValueOnce(new Error('远端索引在拉取期间已变化，请重新同步'))
      .mockResolvedValue('synced')
    const waits: number[] = []

    await expect(retryRemoteIndexChanges(operation, async (milliseconds) => { waits.push(milliseconds) }))
      .resolves.toEqual({ value: 'synced', retryCount: 2 })
    expect(operation).toHaveBeenCalledTimes(3)
    // Exponential backoff with full jitter keeps the same doubling shape.
    expect(waits).toHaveLength(2)
    expect(waits[0]).toBeGreaterThanOrEqual(150)
    expect(waits[0]).toBeLessThan(300)
    expect(waits[1]).toBeGreaterThanOrEqual(300)
    expect(waits[1]).toBeLessThan(450)
  })

  test('retries broken-pipe and connection-reset transport errors', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'legacySftp:push': Error: read ECONNRESET"))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('synced')
    const waits: number[] = []

    await expect(retryRemoteIndexChanges(operation, async (milliseconds) => { waits.push(milliseconds) }))
      .resolves.toEqual({ value: 'synced', retryCount: 2 })
    expect(operation).toHaveBeenCalledTimes(3)
    expect(waits).toHaveLength(2)
  })

  test('does not retry authentication or data errors', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('SSH 密码错误'))
    await expect(retryRemoteIndexChanges(operation, async () => undefined)).rejects.toThrow('SSH 密码错误')
    expect(operation).toHaveBeenCalledOnce()
  })

  test('stops retrying a continuously changing remote index', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('远端索引在同步期间已变化，请重新同步'))
    await expect(retryRemoteIndexChanges(operation, async () => undefined)).rejects.toThrow('远端索引在同步期间已变化')
    expect(operation).toHaveBeenCalledTimes(3)
  })

  test('an empty new device adopts every populated remote page', () => {
    const local = bundle()
    local.sections.push({
      id: '40000000-0000-4000-8000-000000000001',
      notebookId,
      name: '快速记录',
      sortOrder: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const remote = bundle(page({ title: '远端已有笔记', legacyVersion: 8 }), document('existing remote body'))
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.conflicts).toEqual([])
    expect(merged.bundle.pages).toEqual([expect.objectContaining({
      id: pageId,
      title: '远端已有笔记',
      sectionId: '40000000-0000-4000-8000-000000000001',
      syncStatus: 'synced',
    })])
    expect(merged.bundle.documents[0]?.tiptapJson).toEqual(document('existing remote body').tiptapJson)
  })

  test('skips repository metadata that only differs by volatile export fields or array order', () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const remote = encode({ generatedAt: 1, deviceID: 'android', entries: [{ noteID: 'b' }, { noteID: 'a' }] })
    const local = encode({ generatedAt: 2, deviceID: 'electron', entries: [{ noteID: 'a' }, { noteID: 'b' }] })
    expect(semanticallyEqualRepositoryJson('notes/index.json', remote, local)).toBe(true)
    expect(semanticallyEqualRepositoryJson('notes/index.json', remote, encode({ entries: [{ noteID: 'c' }] }))).toBe(false)
  })

  test('keeps a pending local edit when the remote legacy version has not advanced', () => {
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2, title: '本地编辑' }), document('local'))
    const remote = bundle(page({ legacyVersion: 2, title: '远端旧值' }), document('remote'))
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.title).toBe('本地编辑')
    expect(merged.bundle.documents[0]!.tiptapJson).toEqual(document('local').tiptapJson)
  })

  test('a newer history reset discards every older remote revision', () => {
    const resetAt = '2026-07-22T04:00:00.000Z'
    const local = bundle(page({ syncStatus: 'pending', legacyMetadata: { historyResetAt: resetAt } }), document('current'))
    local.revisions.push({
      id: 'new-baseline',
      pageId,
      pageIcon: null,
      document: document('current'),
      createdAt: resetAt,
      reason: 'manual',
    })
    const remote = bundle(page(), document('current'))
    remote.revisions.push(
      { id: 'old-a', pageId, document: document('old A'), createdAt: timestamp, reason: 'import' },
      { id: 'old-b', pageId, document: document('old B'), createdAt: '2026-07-22T01:00:00.000Z', reason: 'import' },
    )

    const merged = mergeBundles(local, remote, new Map(), new Map())

    expect(merged.bundle.revisions.map((item) => item.id)).toEqual(['new-baseline'])
  })

  test('stops on concurrent edits, preserves the local body and archives the remote body', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'revision-id' })
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2, title: '本地编辑' }), document('local'))
    const remote = bundle(page({ legacyVersion: 3, updatedAt: '2026-07-22T01:00:00.000Z', title: 'Android 编辑' }), document('remote', '2026-07-22T01:00:00.000Z'))
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.title).toBe('本地编辑')
    expect(merged.bundle.pages[0]!.syncStatus).toBe('conflict')
    expect(merged.conflicts).toEqual([pageId])
    expect(merged.bundle.revisions).toHaveLength(1)
    expect(merged.bundle.revisions[0]!.document.tiptapJson).toEqual(document('remote', '2026-07-22T01:00:00.000Z').tiptapJson)
    vi.unstubAllGlobals()
  })

  test('treats the next explicit local edit as conflict resolution when the remote baseline is unchanged', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'revision-id' })
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2 }), document('local'))
    const remote = bundle(page({ legacyVersion: 3, updatedAt: '2026-07-22T01:00:00.000Z' }), document('remote', '2026-07-22T01:00:00.000Z'))
    const conflicted = mergeBundles(local, remote, new Map(), new Map())
    const resolvedLocal = { ...conflicted.bundle, pages: conflicted.bundle.pages.map((item) => ({ ...item, syncStatus: 'pending' as const, updatedAt: '2026-07-22T02:00:00.000Z' })) }
    const resolved = mergeBundles(resolvedLocal, remote, new Map(), new Map())
    expect(resolved.conflicts).toEqual([])
    expect(resolved.bundle.documents[0]!.tiptapJson).toEqual(document('local').tiptapJson)
    vi.unstubAllGlobals()
  })

  test('lets a newer restored page supersede an older deletion tombstone', () => {
    const local = bundle(page({ updatedAt: '2026-07-22T03:00:00.000Z', syncStatus: 'pending' }), document('restored', '2026-07-22T03:00:00.000Z'))
    const remote = bundle()
    remote.tombstones.push({ id: `page:${pageId}`, workspaceId, entityType: 'page', entityId: pageId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.deletedAt).toBeUndefined()
    expect(merged.bundle.tombstones).toEqual([])
  })

  test('honors a newer remote tombstone instead of resurrecting a deleted note', () => {
    const local = bundle(page({ updatedAt: '2026-07-22T01:00:00.000Z' }), document('local'))
    const remote = bundle()
    remote.tombstones.push({ id: `page:${pageId}`, workspaceId, entityType: 'page', entityId: pageId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.deletedAt).toBe('2026-07-22T02:00:00.000Z')
    expect(merged.bundle.pages[0]!.syncStatus).toBe('synced')
  })

  test('honors a remote tombstone when an unchanged open editor only refreshed updatedAt', () => {
    const local = bundle(page({
      updatedAt: '2026-07-22T03:00:00.000Z',
      syncStatus: 'pending',
      legacyMetadata: { syncBaselineHash: sha256Hex(JSON.stringify(document('same body').tiptapJson)) },
    }), document('same body'))
    const remote = bundle()
    remote.tombstones.push({ id: `page:${pageId}`, workspaceId, entityType: 'page', entityId: pageId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })

    const merged = mergeBundles(local, remote, new Map(), new Map())

    expect(merged.bundle.pages[0]!.deletedAt).toBe('2026-07-22T02:00:00.000Z')
    expect(merged.bundle.tombstones).toHaveLength(1)
  })

  test('keeps a locally edited page when its content changed after an older remote deletion', () => {
    const local = bundle(page({
      updatedAt: '2026-07-22T03:00:00.000Z',
      syncStatus: 'pending',
      legacyMetadata: { syncBaselineHash: sha256Hex(JSON.stringify(document('old body').tiptapJson)) },
    }), document('locally changed'))
    const remote = bundle()
    remote.tombstones.push({ id: `page:${pageId}`, workspaceId, entityType: 'page', entityId: pageId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })

    const merged = mergeBundles(local, remote, new Map(), new Map())

    expect(merged.bundle.pages[0]!.deletedAt).toBeUndefined()
    expect(merged.bundle.tombstones).toHaveLength(0)
  })

  test('does not resurrect a section deleted with a notebook cascade', () => {
    const sectionId = '40000000-0000-4000-8000-000000000001'
    const local = bundle()
    local.tombstones.push({ id: `section:${sectionId}`, workspaceId, entityType: 'section', entityId: sectionId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'electron' })
    const remote = bundle()
    remote.sections.push({ id: sectionId, notebookId, name: '远端旧分区', sortOrder: 0, createdAt: timestamp, updatedAt: '2026-07-22T01:00:00.000Z' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.sections).toEqual([])
  })

  test('keeps the newest reading position independently from the winning page body', () => {
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2 }), document('local'))
    const remote = bundle(page({ legacyVersion: 1 }), document('remote'))
    local.readingPositions.push({ id: pageId, pageId, anchorUtf16Offset: 10, viewportOffsetFraction: 0.1, updatedAt: '2026-07-22T01:00:00.000Z', deviceId: 'web' })
    remote.readingPositions.push({ id: pageId, pageId, anchorUtf16Offset: 90, viewportOffsetFraction: 0.9, updatedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.documents[0]!.tiptapJson).toEqual(document('local').tiptapJson)
    expect(merged.bundle.readingPositions[0]).toMatchObject({ anchorUtf16Offset: 90, deviceId: 'android' })
  })

  test('does not let a legacy Android body edit flatten a newer Electron page tree', () => {
    const local = bundle(page({
      sectionId: 'section-a',
      parentPageId: 'parent-a',
      sortOrder: 2000,
      treeUpdatedAt: '2026-07-22T02:00:00.000Z',
      syncStatus: 'synced',
      legacyVersion: 1,
    }), document('local'))
    const remote = bundle(page({
      sectionId: 'section-a',
      legacyVersion: 2,
      updatedAt: '2026-07-22T03:00:00.000Z',
    }), document('android edit', '2026-07-22T03:00:00.000Z'))
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.documents[0]!.tiptapJson).toEqual(document('android edit', '2026-07-22T03:00:00.000Z').tiptapJson)
    expect(merged.bundle.pages[0]).toMatchObject({ parentPageId: 'parent-a', sortOrder: 2000, treeUpdatedAt: '2026-07-22T02:00:00.000Z' })
  })

  test('merges a newer remote tree move independently even when the page body conflicts', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'revision-id' })
    const local = bundle(page({
      sectionId: 'section-a',
      parentPageId: 'parent-old',
      treeUpdatedAt: '2026-07-22T01:00:00.000Z',
      syncStatus: 'pending',
      legacyVersion: 2,
    }), document('local edit'))
    const remote = bundle(page({
      sectionId: 'section-b',
      parentPageId: 'parent-new',
      sortOrder: 3000,
      treeUpdatedAt: '2026-07-22T03:00:00.000Z',
      legacyVersion: 3,
      updatedAt: '2026-07-22T03:00:00.000Z',
    }), document('remote edit', '2026-07-22T03:00:00.000Z'))
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.conflicts).toEqual([pageId])
    expect(merged.bundle.pages[0]).toMatchObject({ sectionId: 'section-b', parentPageId: 'parent-new', sortOrder: 3000 })
    vi.unstubAllGlobals()
  })

  test('publishes unrelated edits while leaving a conflicted page at its remote version', () => {
    const otherId = '30000000-0000-4000-8000-000000000099'
    const merged = bundle(page({ syncStatus: 'conflict' }), document('local conflict'))
    merged.pages.push(page({ id: otherId, title: 'unrelated local edit', syncStatus: 'pending' }))
    merged.documents.push({ ...document('unrelated local body'), pageId: otherId })
    const remote = bundle(page({ title: 'remote winner' }), document('remote conflict'))
    const publication = publicationBundleWithRemoteConflicts(merged, remote, new Set([pageId]))
    expect(publication.pages.find((item) => item.id === pageId)?.title).toBe('remote winner')
    expect(publication.documents.find((item) => item.pageId === pageId)?.tiptapJson).toEqual(document('remote conflict').tiptapJson)
    expect(publication.pages.find((item) => item.id === otherId)?.title).toBe('unrelated local edit')
  })

  test('keeps precise block, group and embed backlink identities from a pulled page', () => {
    const remote = bundle(page({ legacyVersion: 2 }), {
      ...document('remote markdown'),
      schemaVersion: 3,
      markdown: '[[page:target#^b-one]]\n\n![[page:target#group:g-one]]',
    })
    remote.pageLinks.push(
      {
        id: `markdown-reference:${pageId}:target:link:block:b-one`,
        workspaceId,
        sourcePageId: pageId,
        targetPageId: 'target',
        kind: 'link',
        excerpt: 'block:b-one',
        createdAt: timestamp,
      },
      {
        id: `markdown-reference:${pageId}:target:embed:group:g-one`,
        workspaceId,
        sourcePageId: pageId,
        targetPageId: 'target',
        kind: 'embed',
        excerpt: 'group:g-one',
        createdAt: timestamp,
      },
    )
    const merged = mergeBundles(bundle(), remote, new Map(), new Map())
    expect(merged.bundle.pageLinks.map((link) => `${link.kind}:${link.excerpt}`)).toEqual([
      'link:block:b-one',
      'embed:group:g-one',
    ])
  })
})

describe('legacy SSH sync orchestration', () => {
  const host = 'example.com'
  const remotePath = '~/notebook_backup'
  const indexBytes = (entries: Array<{ noteID: string; version?: number; contentHash?: string; historyCount?: number }>) => new TextEncoder().encode(JSON.stringify({
    repositoryFormat: { version: 3, noteEncoding: 'gzip', contentFormat: 'markdown-gfm', assetAddressing: 'sha256' },
    entries,
  }))
  const positionsBytes = new TextEncoder().encode(JSON.stringify({ positions: [] }))
  const libraryBytes = new TextEncoder().encode(JSON.stringify({ exportedAt: 1_000_000, deviceID: 'test-server', folders: [], tags: [] }))
  const remoteStateCacheKey = `notebook-ssh-remote-state-v3:${encodeURIComponent(`user@${host}:22:${remotePath}:${workspaceId}`)}`
  const connection = { host, port: 22, username: 'user', remotePath, fingerprint: 'SHA256:test', privateKeyPath: '' }
  const connectionWithPassword = { ...connection, password: 'test-password', privateKeyPassphrase: undefined }
  const remoteState = (indexHash: string, options: { positions?: Uint8Array; library?: Uint8Array; manifest?: Uint8Array; privacy?: Uint8Array } = {}) => ({
    indexHash,
    readingPositionsHash: options.positions ? sha256Hex(options.positions) : '',
    libraryHash: options.library ? sha256Hex(options.library) : '',
    assetsManifestHash: options.manifest ? sha256Hex(options.manifest) : '',
    privacyHash: options.privacy ? sha256Hex(options.privacy) : '',
    signatures: {},
  })

  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.localStorage.setItem('notebook-sync-backend-v1', 'ssh')
    window.localStorage.setItem('notebook-sync-settings-v1', JSON.stringify({ enabled: true, baseUrl: '', workspaceId }))
    window.localStorage.setItem('notebook-legacy-ssh-settings-v1', JSON.stringify(connection))
  })

  const stubDesktop = (legacySftp: Record<string, unknown>) => {
    vi.stubGlobal('notebookDesktop', {
      legacySftp: { test: vi.fn(), pull: vi.fn(), push: vi.fn(), release: vi.fn(), helper: vi.fn(), ...legacySftp },
      secrets: { get: vi.fn(async (key: string) => key === 'legacy-ssh-key-passphrase' ? undefined : 'test-password'), set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    })
  }

  const stubRepository = (overrides: Record<string, unknown> = {}) => ({
    exportData: vi.fn(async () => bundle()),
    exportAssetContents: vi.fn(async () => new Map<string, Uint8Array>()),
    listOutbox: vi.fn(async () => []),
    getAssetContent: vi.fn(async () => undefined),
    importAssetContents: vi.fn(async () => undefined),
    importSyncResult: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as Parameters<typeof synchronizeLegacySsh>[0]

  test('a metadata-only probe short-circuits when nothing changed on either side', async () => {
    const cachedState = remoteState('i1', { positions: positionsBytes, library: libraryBytes })
    window.localStorage.setItem(remoteStateCacheKey, JSON.stringify(cachedState))
    const pull = vi.fn(async () => ({
      files: [{ name: 'library.json', data: libraryBytes }, { name: 'notes/index.json', data: indexBytes([]) }, { name: 'notes/reading_positions.json', data: positionsBytes }],
      indexHash: 'i1',
      fingerprint: 'SHA256:test',
      objectHashes: [],
      reusedObjectCount: 0,
      reusedNoteIds: [],
      sessionId: 's1',
    }))
    const push = vi.fn(async () => ({ fingerprint: 'SHA256:test', sessionId: 's1' }))
    const release = vi.fn(async () => undefined)
    stubDesktop({ pull, push, release })

    const result = await synchronizeLegacySsh(stubRepository(), workspaceId)

    expect(result).toMatchObject({ state: 'synced', skipped: 0, fingerprint: 'SHA256:test' })
    expect(pull).toHaveBeenCalledOnce()
    expect(pull).toHaveBeenCalledWith(connectionWithPassword, expect.objectContaining({ metadataOnly: true }))
    expect(push).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith('s1')
  })

  test('a changed remote state falls through to a full pull and push over the reused session', async () => {
    const cachedState = remoteState('i1')
    window.localStorage.setItem(remoteStateCacheKey, JSON.stringify(cachedState))
    const pull = vi.fn(async () => ({
      files: [
        { name: 'library.json', data: libraryBytes },
        { name: 'notes/index.json', data: indexBytes([]) },
      ],
      indexHash: 'i2',
      fingerprint: 'SHA256:test',
      objectHashes: [],
      reusedObjectCount: 0,
      reusedNoteIds: [],
      sessionId: 's1',
    }))
    const push = vi.fn(async () => ({ fingerprint: 'SHA256:test', sessionId: 's2' }))
    const release = vi.fn(async () => undefined)
    stubDesktop({ pull, push, release })

    const result = await synchronizeLegacySsh(stubRepository(), workspaceId)

    expect(result).toMatchObject({ state: 'synced' })
    // Probe (metadataOnly) then full pull on the same session.
    expect(pull).toHaveBeenCalledTimes(2)
    expect(pull).toHaveBeenNthCalledWith(1, connectionWithPassword, expect.objectContaining({ metadataOnly: true }))
    expect(pull).toHaveBeenNthCalledWith(2, connectionWithPassword, expect.objectContaining({ sessionId: 's1' }))
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith(connectionWithPassword, expect.any(Array), 'i2', expect.objectContaining({ sessionId: 's1' }))
    expect(release).toHaveBeenCalledWith('s1')
  })

  test('a pending outbox skips the fast path and syncs normally', async () => {
    const cachedState = remoteState('i1')
    window.localStorage.setItem(remoteStateCacheKey, JSON.stringify(cachedState))
    const pull = vi.fn(async (_settings: unknown, _options?: { metadataOnly?: boolean; sessionId?: string }) => ({
      files: [{ name: 'library.json', data: libraryBytes }, { name: 'notes/index.json', data: indexBytes([]) }],
      indexHash: 'i1',
      fingerprint: 'SHA256:test',
      objectHashes: [],
      reusedObjectCount: 0,
      reusedNoteIds: [],
      sessionId: 's1',
    }))
    const push = vi.fn(async () => ({ fingerprint: 'SHA256:test', sessionId: 's2' }))
    const release = vi.fn(async () => undefined)
    stubDesktop({ pull, push, release })

    const result = await synchronizeLegacySsh(stubRepository({
      listOutbox: vi.fn(async () => [{ id: 'outbox-1', workspaceId, entityType: 'page', entityId: pageId, operation: 'update', payload: {}, expectedVersion: 1 }]),
    }), workspaceId)

    expect(result).toMatchObject({ state: 'synced' })
    expect(pull).toHaveBeenCalledOnce()
    expect(pull.mock.calls[0]![1]).not.toHaveProperty('metadataOnly')
    expect(push).toHaveBeenCalledTimes(1)
  })

  test('a metadata-only probe falls through when the library changes without an index change', async () => {
    const priorLibrary = new TextEncoder().encode(JSON.stringify({ exportedAt: 1, deviceID: 'test-server', folders: [], tags: [] }))
    const changedLibrary = new TextEncoder().encode(JSON.stringify({ exportedAt: 2, deviceID: 'test-server', folders: [{ id: '40000000-0000-4000-8000-000000000001', name: 'Changed', sortOrder: 0, isSystem: false }], tags: [] }))
    window.localStorage.setItem(remoteStateCacheKey, JSON.stringify(remoteState('i1', { positions: positionsBytes, library: priorLibrary })))
    const pull = vi.fn(async () => ({
      files: [
        { name: 'library.json', data: changedLibrary },
        { name: 'notes/index.json', data: indexBytes([]) },
        { name: 'notes/reading_positions.json', data: positionsBytes },
      ],
      indexHash: 'i1',
      fingerprint: 'SHA256:test',
      objectHashes: [],
      reusedObjectCount: 0,
      reusedNoteIds: [],
      sessionId: 's1',
    }))
    const release = vi.fn(async () => undefined)
    stubDesktop({ pull, push: vi.fn(async () => ({ fingerprint: 'SHA256:test', sessionId: 's1' })), release })

    await synchronizeLegacySsh(stubRepository(), workspaceId)

    expect(pull).toHaveBeenCalledTimes(2)
    expect(pull).toHaveBeenNthCalledWith(1, connectionWithPassword, expect.objectContaining({ metadataOnly: true }))
    expect(pull).toHaveBeenNthCalledWith(2, connectionWithPassword, expect.objectContaining({ sessionId: 's1' }))
    expect(release).toHaveBeenCalledWith('s1')
  })
})
