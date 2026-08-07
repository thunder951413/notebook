import type { NotebookDataBundle } from '@notebook/domain'
import type { DexieNotebookRepository } from '@notebook/storage-renderer'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { migrateSshToWebdav, synchronizeWebdav } from './webdavSync'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const notebookId = '20000000-0000-4000-8000-000000000001'
const pageId = '30000000-0000-4000-8000-000000000001'
const deviceId = 'device-0001'
const appPassword = 'test-app-password'
const timestamp = '2026-08-04T00:00:00.000Z'

const connection = { baseUrl: 'https://dav.jianguoyun.com/dav/', username: 'jianguoyun', remotePath: 'notebook_backup', appPassword, syncPassword: undefined }

/** Persist the WebDAV settings exactly as the settings page would. */
function seedWebdavSettings() {
  window.localStorage.setItem('notebook-webdav-settings-v1', JSON.stringify({ baseUrl: connection.baseUrl, username: connection.username, remotePath: connection.remotePath }))
  window.localStorage.setItem('notebook-legacy-device-id-v1', deviceId)
}

function remoteEntry(overrides: Partial<{ seq: number; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown>; deviceId: string }> = {}) {
  return {
    seq: 1, ts: timestamp, op: 'upsert' as const, type: 'page', id: pageId, ver: 0,
    payload: { id: pageId, workspaceId, kind: 'document', title: '远端笔记', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' },
    deviceId,
    ...overrides,
  }
}

/** Repository double recording every call made by the sync engine. */
function repository() {
  const calls = {
    applyChanges: [] as Array<{ changes: unknown[]; cursor: number }>,
    acknowledge: [] as Array<unknown>,
    importedAssets: [] as Array<[string, Uint8Array]>,
  }
  let repo: DexieNotebookRepository
  repo = {
    getSyncCursor: vi.fn(async () => 0),
    applyRemoteChanges: vi.fn(async (_workspaceId: string, changes: unknown[], cursor: number) => {
      calls.applyChanges.push({ changes, cursor })
      return { cursor, conflicts: [] }
    }),
    importAssetContents: vi.fn(async (contents: Map<string, Uint8Array>) => {
      for (const [id, data] of contents) calls.importedAssets.push([id, data])
    }),
    listOutbox: vi.fn(async () => []),
    hasPendingSyncChanges: vi.fn(async () => (await repo.listOutbox(workspaceId)).length > 0),
    isPrivateSyncItem: vi.fn(async () => false),
    acknowledgeLocalOnlySync: vi.fn(async () => undefined),
    acknowledgeSync: vi.fn(async (_workspaceId: string, applied: unknown[]) => { calls.acknowledge.push(applied) }),
    getAssetContent: vi.fn(async () => undefined),
    exportData: vi.fn(async () => bundle()),
  } as unknown as DexieNotebookRepository
  return { repo, calls }
}

function bundle(): NotebookDataBundle {
  return {
    notebooks: [{ id: notebookId, workspaceId, name: '迁移的笔记', sortOrder: 0, createdAt: timestamp, updatedAt: timestamp }],
    sections: [],
    pages: [{ id: pageId, workspaceId, kind: 'document', title: '迁移的页面', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' }],
    documents: [{ pageId, schemaVersion: 1, tiptapJson: { type: 'doc', content: [] }, updatedAt: timestamp }],
    tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: [], comments: [], tombstones: [],
  }
}

function installDesktopMock() {
  type PullResult = { entries: Array<ReturnType<typeof remoteEntry>>; fingerprint: string }
  const webdav = {
    test: vi.fn(async () => ({ ok: true, remotePathExists: true, latencyMs: 12, message: 'ok' })),
    pull: vi.fn(async (): Promise<PullResult> => ({ entries: [], fingerprint: 'fp' })),
    objectGet: vi.fn(async (_settings: unknown, hash: string) => new TextEncoder().encode(`content-of-${hash}`)),
    push: vi.fn(async () => ({ firstSeq: 1, count: 0 })),
  }
  const secrets = {
    get: vi.fn(async (key: string) => key === 'webdav-app-password' ? appPassword : undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  }
  Object.defineProperty(window, 'notebookDesktop', {
    configurable: true,
    value: { webdav, secrets, legacySftp: { pull: vi.fn(async () => { throw new Error('unused') }), push: vi.fn(), release: vi.fn() } },
  })
  return { webdav, secrets }
}

describe('synchronizeWebdav', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    delete (window as unknown as Record<string, unknown>).notebookDesktop
  })

  test('returns offline before the repository is configured', async () => {
    const { repo } = repository()
    await expect(synchronizeWebdav(repo, workspaceId)).resolves.toEqual({ state: 'offline', skipped: 0, conflicts: 0 })
    await expect(synchronizeWebdav(repo, workspaceId)).resolves.toEqual({ state: 'offline', skipped: 0, conflicts: 0 })
  })

  test('pulls remote entries, materializes externalized documents and advances cursors', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const externalizedJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '外部化正文' }] }] })
    const externalizedHash = 'abcdef0123456789'
    webdav.pull.mockResolvedValue({
      entries: [
        remoteEntry({ seq: 1, type: 'document', id: pageId, hash: externalizedHash, payload: { pageId, schemaVersion: 1, tiptapJson: { $object: externalizedHash }, updatedAt: timestamp } }),
        remoteEntry({ seq: 2, type: 'page', id: pageId, ver: 1, payload: { id: pageId, workspaceId, kind: 'document', title: '远端笔记', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' } }),
      ],
      fingerprint: 'fp',
    })
    webdav.objectGet.mockImplementation(async (_settings: unknown, hash: string) => new TextEncoder().encode(hash === externalizedHash ? externalizedJson : ''))

    const result = await synchronizeWebdav(repo, workspaceId)

    expect(result).toEqual({ state: 'synced', skipped: 0, conflicts: 0 })
    expect(webdav.objectGet).toHaveBeenCalledWith(connection, externalizedHash)
    expect(calls.applyChanges).toHaveLength(1)
    const { changes, cursor } = calls.applyChanges[0]!
    expect(cursor).toBe(2)
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({ cursor: 1, entityType: 'document', entityId: pageId, version: 0, operation: 'upsert' })
    expect((changes[0] as { payload: { tiptapJson: unknown } }).payload.tiptapJson).toEqual(JSON.parse(externalizedJson))
    expect(changes[1]).toMatchObject({ cursor: 2, entityType: 'page', entityId: pageId, version: 1 })
    // Read cursors persisted per device so the same entries are not re-applied.
    expect(JSON.parse(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup') ?? '{}')).toEqual({ 'device-0001': 2 })
  })

  test('materializes the full document payload marker used by new clients', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const hash = 'full-document-hash'
    const payload = { pageId, schemaVersion: 3, markdown: '完整 Markdown 正文', tiptapJson: { type: 'doc' }, updatedAt: timestamp }
    webdav.pull.mockResolvedValue({ entries: [remoteEntry({ type: 'document', id: pageId, hash, payload: { $payloadObject: hash } })], fingerprint: 'fp' })
    webdav.objectGet.mockResolvedValue(new TextEncoder().encode(JSON.stringify(payload)))

    await synchronizeWebdav(repo, workspaceId)

    expect(calls.applyChanges[0]!.changes[0]).toMatchObject({ entityType: 'document', payload })
  })

  test('downloads asset bytes by hash and imports them locally', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const bytes = new TextEncoder().encode('attachment-bytes')
    const hash = 'deadbeef'
    webdav.pull.mockResolvedValue({
      entries: [remoteEntry({ seq: 1, type: 'asset', id: 'asset-1', hash, payload: { id: 'asset-1', pageId, kind: 'image', filename: 'a.png', mimeType: 'image/png', createdAt: timestamp, byteSize: bytes.byteLength, objectHash: hash } })],
      fingerprint: 'fp',
    })
    webdav.objectGet.mockResolvedValue(bytes)

    const result = await synchronizeWebdav(repo, workspaceId)

    expect(result.state).toBe('synced')
    expect(calls.importedAssets).toEqual([['asset-1', bytes]])
  })

  test('pushes pending local changes into this device journal and acknowledges them', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const outboxItem = {
      id: 'op-1', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 3,
      payload: { id: pageId, workspaceId, kind: 'document', title: '本地修改', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending' },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])
    webdav.push.mockResolvedValue({ firstSeq: 7, count: 1 })

    const result = await synchronizeWebdav(repo, workspaceId)

    expect(result.state).toBe('synced')
    expect(webdav.push).toHaveBeenCalledWith(connection, deviceId, [
      expect.objectContaining({ op: 'upsert', type: 'page', id: pageId, ver: 3 }),
    ], [])
    expect(calls.acknowledge).toEqual([[{ operation_id: 'op-1', entity_type: 'page', entity_id: pageId, version: 4 }]])
    // Own journal read cursor advanced past the appended entries.
    expect(JSON.parse(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup') ?? '{}')).toEqual({ 'device-0001': 7 })
  })

  test('keeps private note relations local instead of publishing plaintext', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const privateItems = [
      { id: 'private-page-op', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0, payload: { id: pageId, locked: true, title: 'PRIVATE TITLE' } },
      { id: 'private-asset-op', workspaceId, entityType: 'asset', entityId: 'private-asset', operation: 'upsert' as const, expectedVersion: 0, payload: { pageId, filename: 'PRIVATE FILE' } },
      { id: 'private-position-op', workspaceId, entityType: 'reading_position', entityId: `${pageId}:device`, operation: 'upsert' as const, expectedVersion: 0, payload: { pageId, anchorUtf16Offset: 3 } },
    ]
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue(privateItems)
    ;(repo.isPrivateSyncItem as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const result = await synchronizeWebdav(repo, workspaceId)

    expect(result.state).toBe('synced')
    expect(repo.acknowledgeLocalOnlySync).toHaveBeenCalledWith(privateItems)
    expect(webdav.push).not.toHaveBeenCalled()
    expect(repo.getAssetContent).not.toHaveBeenCalled()
  })

  test('externalizes large document bodies into content-addressed objects', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const bigText = 'x'.repeat(3000)
    const outboxItem = {
      id: 'op-2', workspaceId, entityType: 'document', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
      payload: { pageId, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: bigText }] }] }, updatedAt: timestamp },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 1 })

    await synchronizeWebdav(repo, workspaceId)

    const [pushedEntries, pushedObjects] = (webdav.push as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(2) as [Array<{ hash: string; payload: { $payloadObject: string } }>, Array<{ hash: string; data: Uint8Array }>]
    expect(pushedEntries[0]!.payload).toEqual({ $payloadObject: expect.any(String) })
    expect(pushedObjects).toHaveLength(1)
    // The object holds the original body and its hash matches the marker.
    const object = pushedObjects[0]!
    expect(object.hash).toBe(pushedEntries[0]!.payload.$payloadObject)
    expect(new TextDecoder().decode(object.data)).toContain(bigText)
  })

  test('hashes asset bytes and refuses to publish when local content is missing', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const outboxItem = {
      id: 'op-3', workspaceId, entityType: 'asset', entityId: 'asset-1', operation: 'upsert' as const, expectedVersion: 0,
      payload: { id: 'asset-1', pageId, kind: 'image', filename: 'a.png', mimeType: 'image/png', createdAt: timestamp, byteSize: 4 },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])
    ;(repo.getAssetContent as ReturnType<typeof vi.fn>).mockResolvedValue(new Blob(['data'], { type: 'application/octet-stream' }))
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 1 })

    await synchronizeWebdav(repo, workspaceId)

    const [pushedEntries, pushedObjects] = (webdav.push as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(2) as [Array<{ hash?: string; payload: { objectHash?: string; byteSize?: number } }>, Array<{ hash: string; data: Uint8Array }>]
    expect(pushedEntries[0]!.hash).toBe(pushedObjects[0]!.hash)
    expect(pushedEntries[0]!.payload.objectHash).toBe(pushedObjects[0]!.hash)
    expect(pushedEntries[0]!.payload.byteSize).toBe(4)
    expect(new TextDecoder().decode(pushedObjects[0]!.data)).toBe('data')

    // A broken local store must not silently publish a truncated attachment.
    ;(repo.getAssetContent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await expect(synchronizeWebdav(repo, workspaceId)).rejects.toThrow('缺少本地内容')
  })

  test('keeps conflicted entities queued and reports the conflict state', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    ;(repo.applyRemoteChanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      // The shared repository stops immediately before the conflicting row.
      cursor: 0,
      conflicts: [{ entityType: 'page', entityId: pageId, pageIds: [pageId] }],
    })
    webdav.pull.mockResolvedValue({ entries: [remoteEntry({ seq: 1 })], fingerprint: 'fp' })
    const outboxItem = {
      id: 'op-4', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
      payload: { id: pageId, workspaceId, kind: 'document', title: '本地修改', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'conflict' },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])

    const result = await synchronizeWebdav(repo, workspaceId)

    expect(result).toEqual({ state: 'conflict', skipped: 0, conflicts: 1 })
    expect(webdav.push).not.toHaveBeenCalled()
    expect(calls.acknowledge).toHaveLength(0)
    // The unapplied conflicting row must remain pullable on the next round.
    expect(JSON.parse(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup') ?? '{}')).toEqual({})
  })

  test('advances WebDAV cursors only through the prefix committed before a conflict', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const laterDevice = 'device-0002'
    ;(repo.applyRemoteChanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      // Row 1 committed; row 2 conflicted, so rows 2 and 3 were not applied.
      cursor: 1,
      conflicts: [{ entityType: 'page', entityId: pageId, pageIds: [pageId] }],
    })
    webdav.pull.mockResolvedValue({
      entries: [
        remoteEntry({ seq: 4, deviceId: 'device-0001', id: 'first-page' }),
        remoteEntry({ seq: 5, deviceId: 'device-0001', id: pageId }),
        remoteEntry({ seq: 9, deviceId: laterDevice, id: 'later-page' }),
      ],
      fingerprint: 'fp',
    })

    const result = await synchronizeWebdav(repo, workspaceId)

    expect(result.state).toBe('conflict')
    expect(JSON.parse(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup') ?? '{}')).toEqual({ 'device-0001': 4 })
  })

  test('scoped sync (opening a note) pushes only that note and leaves other notes queued', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const otherPageId = '40000000-0000-4000-8000-000000000001'
    const focusedStep = {
      id: 'op-step', workspaceId, entityType: 'task_step', entityId: 'step-1', operation: 'upsert' as const, expectedVersion: 0,
      payload: { id: 'step-1', pageId, text: '做 A', checked: false, sortOrder: 0, createdAt: timestamp },
    }
    const otherPageItem = {
      id: 'op-other-page', workspaceId, entityType: 'page', entityId: otherPageId, operation: 'upsert' as const, expectedVersion: 2,
      payload: { id: otherPageId, workspaceId, kind: 'document', title: '别的笔记', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending' },
    }
    const otherStep = {
      id: 'op-other-step', workspaceId, entityType: 'task_step', entityId: 'step-2', operation: 'upsert' as const, expectedVersion: 0,
      payload: { id: 'step-2', pageId: otherPageId, text: '做 B', checked: false, sortOrder: 0, createdAt: timestamp },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([focusedStep, otherPageItem, otherStep])
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 1 })

    const result = await synchronizeWebdav(repo, workspaceId, undefined, { pageId })

    expect(result.state).toBe('synced')
    const entries = (webdav.push as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Array<{ type: string; id: string }>
    // task_step matches through payload.pageId; the other note's page and step stay queued.
    expect(entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual(['task_step:step-1'])
    expect(calls.acknowledge).toEqual([[{ operation_id: 'op-step', entity_type: 'task_step', entity_id: 'step-1', version: 1 }]])
  })

  test('pulls again right after pushing, catching concurrent publications', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const otherPageId = '40000000-0000-4000-8000-000000000001'
    const outboxItem = {
      id: 'op-1', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
      payload: { id: pageId, workspaceId, kind: 'document', title: '本地修改', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending' },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 1 })
    // First pull: nothing new. Second pull: another device published a page
    // while we were pushing — it must be applied in the same sync round.
    webdav.pull
      .mockResolvedValueOnce({ entries: [], fingerprint: 'fp' })
      .mockResolvedValueOnce({ entries: [remoteEntry({ seq: 1, id: otherPageId, ver: 1, payload: { id: otherPageId, workspaceId, kind: 'document', title: '并发笔记', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced' } })], fingerprint: 'fp2' })

    const result = await synchronizeWebdav(repo, workspaceId)

    expect(result.state).toBe('synced')
    expect(webdav.pull).toHaveBeenCalledTimes(2)
    expect(calls.applyChanges).toHaveLength(1)
    expect(calls.applyChanges[0]!.changes).toHaveLength(1)
    expect(calls.applyChanges[0]!.changes[0]).toMatchObject({ entityType: 'page', entityId: otherPageId, cursor: 1 })
  })

  test('does not pull twice when there is nothing to push', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()

    await synchronizeWebdav(repo, workspaceId)

    expect(webdav.pull).toHaveBeenCalledTimes(1)
    expect(webdav.push).not.toHaveBeenCalled()
  })
})

describe('browser bridge transport', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    delete (window as unknown as Record<string, unknown>).notebookDesktop
    window.sessionStorage.setItem('notebook-webdav-app-password', appPassword)
    window.localStorage.setItem('notebook-webdav-settings-v1', JSON.stringify({ baseUrl: connection.baseUrl, username: connection.username, remotePath: connection.remotePath }))
    window.localStorage.setItem('notebook-legacy-device-id-v1', deviceId)
  })

  test('syncs through the local Python helper when the desktop bridge is absent', async () => {
    const { repo, calls } = repository()
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace('http://127.0.0.1:8787', '')
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requests.push({ path, body })
      if (path === '/v1/local-webdav/pull') {
        // The Python helper filters by the per-device read cursors it is sent.
        const knownSeqs = body.knownSeqs as Record<string, number> | undefined
        const entries = (knownSeqs?.[deviceId] ?? 0) >= 1 ? [] : [remoteEntry({ seq: 1, type: 'page', id: pageId, ver: 0 })]
        return new Response(JSON.stringify({ entries, fingerprint: 'fp' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (path === '/v1/local-webdav/push') {
        return new Response(JSON.stringify({ firstSeq: 5, count: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const outboxItem = {
        id: 'op-bridge', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
        payload: { id: pageId, workspaceId, kind: 'document', title: '浏览器修改', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending' },
      }
      ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])

      const result = await synchronizeWebdav(repo, workspaceId)

      expect(result.state).toBe('synced')
      expect(calls.applyChanges).toHaveLength(1)
      const pullBody = requests.find((request) => request.path === '/v1/local-webdav/pull')!.body as { settings: Record<string, unknown>; knownSeqs: Record<string, number> }
      expect(pullBody.settings).toMatchObject({ baseUrl: connection.baseUrl, username: connection.username, remotePath: connection.remotePath, appPassword })
      expect(pullBody.knownSeqs).toEqual({})
      const pushBody = requests.find((request) => request.path === '/v1/local-webdav/push')!.body as { deviceId: string; entries: Array<{ type: string }>; objects: Array<{ hash: string; dataBase64: string }> }
      expect(pushBody.deviceId).toBe(deviceId)
      expect(pushBody.entries.some((entry) => entry.type === 'page')).toBe(true)
      expect(JSON.parse(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup') ?? '{}')).toEqual({ 'device-0001': 5 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('encodes externalized objects as base64 for the bridge', async () => {
    const { repo } = repository()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input).replace('http://127.0.0.1:8787', '')
      if (path === '/v1/local-webdav/pull') return new Response(JSON.stringify({ entries: [], fingerprint: 'fp' }), { status: 200 })
      if (path === '/v1/local-webdav/push') return new Response(JSON.stringify({ firstSeq: 1, count: 1 }), { status: 200 })
      throw new Error(`unexpected bridge path ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([{
        id: 'op-object', workspaceId, entityType: 'document', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
        payload: { pageId, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(3000) }] }] }, updatedAt: timestamp },
      }])
      await synchronizeWebdav(repo, workspaceId)
      // The large document body was externalized and sent base64-encoded.
      const fetchCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls
      const pushCall = fetchCalls.find((call) => String(call[0]).includes('/v1/local-webdav/push'))
      const body = JSON.parse(String((pushCall![1] as RequestInit).body)) as { objects: Array<{ dataBase64: string }> }
      expect(body.objects).toHaveLength(1)
      expect(atob(body.objects[0]!.dataBase64)).toContain('x'.repeat(3000))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('migrateSshToWebdav', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test('requires configured WebDAV credentials before starting', async () => {
    const { repo } = repository()
    await expect(migrateSshToWebdav(repo, workspaceId)).rejects.toThrow('请先完整填写并保存坚果云 WebDAV 设置')
  })

  test('publishes a full v4 snapshot of the local bundle', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 10 })

    const result = await migrateSshToWebdav(repo, workspaceId)

    expect(result.published).toBeGreaterThanOrEqual(2)
    const [pushedConnection, pushedDeviceId, entries] = (webdav.push as ReturnType<typeof vi.fn>).mock.calls[0]! as [unknown, string, Array<{ op: string; type: string; ver: number }>]
    expect(pushedConnection).toEqual(connection)
    expect(pushedDeviceId).toBe(deviceId)
    expect(entries.every((entry) => entry.op === 'upsert' && entry.ver === 0)).toBe(true)
    expect(entries.some((entry) => entry.type === 'notebook')).toBe(true)
    expect(entries.some((entry) => entry.type === 'page')).toBe(true)
    expect(entries.some((entry) => entry.type === 'document')).toBe(true)
    expect(JSON.parse(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup') ?? '{}')).toEqual({ 'device-0001': 10 })
  })

  test('omits private notebooks and all related payloads from SSH migration', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const source=bundle()
    const privateNotebookId='90000000-0000-4000-8000-000000000001'
    const privatePageId='90000000-0000-4000-8000-000000000002'
    source.notebooks.push({ id:privateNotebookId,workspaceId,name:'PRIVATE NOTEBOOK',sortOrder:9,createdAt:timestamp,updatedAt:timestamp,locked:true })
    source.pages.push({ id:privatePageId,workspaceId,kind:'document',title:'PRIVATE TITLE',preview:'PRIVATE BODY',favorite:false,createdAt:timestamp,updatedAt:timestamp,syncStatus:'synced',locked:true })
    source.documents.push({ pageId:privatePageId,schemaVersion:1,tiptapJson:{type:'doc',content:[{type:'text',text:'PRIVATE BODY'}]},updatedAt:timestamp })
    ;(repo.exportData as ReturnType<typeof vi.fn>).mockResolvedValue(source)
    webdav.push.mockResolvedValue({ firstSeq:1,count:3 })

    await migrateSshToWebdav(repo,workspaceId)

    const serialized=JSON.stringify((webdav.push as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(2))
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain(privateNotebookId)
    expect(serialized).not.toContain(privatePageId)
  })
})
