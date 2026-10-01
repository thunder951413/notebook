import { Blob as NodeBlob } from 'node:buffer'
import type { NotebookDataBundle } from '@notebook/domain'
import type { DexieNotebookRepository } from '@notebook/storage-renderer'
import { DexieNotebookRepository as RealRepository, NotebookRendererDatabase } from '@notebook/storage-renderer'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { migrateSshToWebdav, synchronizeWebdav, WEBDAV_OPERATION_TIMEOUT_MS, WEBDAV_SYNC_TIMEOUT_MS } from './webdavSync'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'
import { synchronizeLegacySsh } from './legacySshSync'

vi.mock('../diagnostics/diagnostics', () => ({ recordDiagnosticEvent: vi.fn() }))
vi.mock('./legacySshSync', () => ({ synchronizeLegacySsh: vi.fn(async () => ({ state: 'synced', skipped: 0, fingerprint: 'ssh-test', retryCount: 0 })) }))

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
    push: vi.fn(async (_settings: unknown, _deviceId: string, _entries: Array<Omit<ReturnType<typeof remoteEntry>, 'seq' | 'deviceId'>>, _objects: Array<{ hash: string; data: Uint8Array }>) => ({ firstSeq: 1, count: 0 })),
    cancel: vi.fn(async () => undefined),
  }
  const secrets = {
    get: vi.fn(async (key: string): Promise<string | undefined> => key === 'webdav-app-password' ? appPassword : undefined),
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

  test('private publication encrypts every payload and attachment and a fresh replica restores authenticated records', async () => {
    const { webdav, secrets } = installDesktopMock()
    const secret = 'private-library-test-key'
    secrets.get.mockImplementation(async key => key === 'webdav-app-password' ? appPassword : secret)
    webdav.push.mockImplementation(async (_settings, _device, entries) => ({ firstSeq: 1, count: entries.length }))
    seedWebdavSettings()
    const { repo } = repository()
    const items = [
      { entityType: 'page', entityId: pageId, payload: { id: pageId, locked: true, title: 'PRIVATE TITLE' } },
      { entityType: 'document', entityId: pageId, payload: { pageId, schemaVersion: 3, markdown: 'PRIVATE BODY\n'.repeat(1000), tiptapJson: { type: 'doc', content: [] } } },
      { entityType: 'asset', entityId: 'private-asset', payload: { pageId, filename: 'PRIVATE FILE'.repeat(300), mimeType: 'text/plain' } },
    ].map((item, index) => ({ ...item, id: `op-${index}`, workspaceId, operation: 'upsert' as const, expectedVersion: 0, createdAt: timestamp }))
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue(items)
    ;(repo.isPrivateSyncItem as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    ;(repo.getAssetContent as ReturnType<typeof vi.fn>).mockResolvedValue(new NodeBlob(['PRIVATE BYTES']))
    expect((await synchronizeWebdav(repo, workspaceId)).state).toBe('synced')
    expect(repo.acknowledgeSync).toHaveBeenCalledWith(workspaceId, expect.any(Array), undefined, true, true)
    const pushed = webdav.push.mock.calls.flatMap(call => call[2])
    const objects = new Map(webdav.push.mock.calls.flatMap(call => call[3]).map(object => [object.hash, object.data]))
    expect(JSON.stringify(pushed)).not.toContain('PRIVATE')
    for (const bytes of objects.values()) expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE')
    const assetEntry = pushed.find(entry => entry.type === 'asset')!
    expect(objects.has(assetEntry.payload.$assetObject as string)).toBe(true)
    webdav.objectGet.mockImplementation(async (_connection, hash) => Uint8Array.from(objects.get(hash)!))
    const received = repository()
    webdav.pull.mockResolvedValueOnce({ entries: pushed.map((entry, index) => ({ ...entry, seq: index + 1, deviceId: 'peer-private' })), fingerprint: 'fp' })
    expect((await synchronizeWebdav(received.repo, workspaceId)).state).toBe('synced')
    const changes = received.calls.applyChanges[0]!.changes as Array<{ authenticatedPrivate?: boolean; payload: Record<string, unknown> }>
    expect(changes.every(change => change.authenticatedPrivate)).toBe(true)
    expect(changes.find(change => change.payload.markdown)?.payload.markdown).toBe(items[1]!.payload.markdown)
    expect(new TextDecoder().decode(received.calls.importedAssets[0]![1])).toBe('PRIVATE BYTES')
    secrets.get.mockImplementation(async key => key === 'webdav-app-password' ? appPassword : 'wrong-key')
    webdav.pull.mockResolvedValueOnce({ entries: [{ ...pushed[0]!, seq: 10, deviceId: 'peer-private' }], fingerprint: 'fp' })
    const wrong = repository()
    await expect(synchronizeWebdav(wrong.repo, workspaceId)).rejects.toThrow('密钥')
    expect(wrong.calls.applyChanges).toEqual([])
  })

  test('push recovery re-reads remote heads and explicitly preserves local content; pull mode never publishes', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    webdav.pull.mockResolvedValueOnce({ entries: [remoteEntry()], fingerprint: 'fp' })
    await synchronizeWebdav(repo, workspaceId, undefined, undefined, 'push')
    expect(webdav.pull).toHaveBeenCalledWith(expect.any(Object), {}, expect.any(String))
    expect(repo.applyRemoteChanges).toHaveBeenCalledWith(workspaceId, expect.any(Array), 1, expect.any(Map), true, true)
    ;(repo.hasPendingSyncChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    await synchronizeWebdav(repo, workspaceId, undefined, undefined, 'pull')
    expect(webdav.push).not.toHaveBeenCalled()
  })

  test('does not push any remaining entities when the incoming prefix is blocked by a conflict', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    webdav.pull.mockResolvedValue({ entries: [remoteEntry()], fingerprint: 'fp' })
    ;(repo.hasPendingSyncChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    ;(repo.applyRemoteChanges as ReturnType<typeof vi.fn>).mockResolvedValue({ cursor: 0, conflicts: [{ entityType: 'page', entityId: pageId, pageIds: [pageId] }] })
    expect((await synchronizeWebdav(repo, workspaceId)).state).toBe('conflict')
    expect(webdav.push).not.toHaveBeenCalled()
    expect(repo.listOutbox).not.toHaveBeenCalled()
  })

  test('real repository recovers legacy conflicts, survives a failed upload, and stays synced on subsequent pulls', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const db = new NotebookRendererDatabase(`webdav-recovery-${crypto.randomUUID()}`)
    const repo = new RealRepository(db)
    try {
      const local = { ...bundle().pages[0]!, title: '本机权威内容', important: true, legacyMetadata: { syncBaselineHash: 'local-hash' } }
      await db.pages.put(local)
      await db.syncVersions.put({ id: `${workspaceId}:page:${pageId}`, version: 1 })
      webdav.pull.mockResolvedValueOnce({ entries: [remoteEntry({ deviceId: 'old-device' })], fingerprint: 'fp' })
      webdav.push.mockRejectedValueOnce(new Error('temporary connection failure'))
      await expect(synchronizeWebdav(repo, workspaceId, undefined, undefined, 'push')).rejects.toThrow('temporary connection failure')
      expect((await repo.getPage(pageId))?.title).toBe(local.title)
      expect(await repo.listOutbox(workspaceId)).toEqual([expect.objectContaining({ expectedVersion: 1, payload: expect.objectContaining({ title: local.title, important: true }) })])
      webdav.push.mockResolvedValue({ firstSeq: 20, count: 1 })
      expect((await synchronizeWebdav(repo, workspaceId)).state).toBe('synced')
      expect(await repo.hasPendingSyncChanges(workspaceId)).toBe(false)
      expect(await db.syncVersions.get(`${workspaceId}:page:${pageId}`)).toMatchObject({ version: 2, webdavParentVersion: true })
      expect((await repo.getPage(pageId))?.title).toBe(local.title)
      const pushes = webdav.push.mock.calls.length
      expect((await synchronizeWebdav(repo, workspaceId)).state).toBe('synced')
      expect(webdav.push).toHaveBeenCalledTimes(pushes)
    } finally {
      db.close()
      await db.delete()
    }
  })

  test('returns offline before the repository is configured', async () => {
    const { repo } = repository()
    await expect(synchronizeWebdav(repo, workspaceId)).resolves.toEqual({ state: 'offline', skipped: 0, conflicts: 0 })
    await expect(synchronizeWebdav(repo, workspaceId)).resolves.toEqual({ state: 'offline', skipped: 0, conflicts: 0 })
  })

  test('the whole-sync deadline settles even when credential IPC ignores cancellation', async () => {
    vi.useFakeTimers()
    try {
      const { webdav, secrets } = installDesktopMock()
      seedWebdavSettings()
      const { repo } = repository()
      let releaseSecret: (value: typeof appPassword) => void = () => undefined
      secrets.get.mockImplementationOnce(() => new Promise<typeof appPassword>((resolve) => { releaseSecret = resolve }))
      const run = synchronizeWebdav(repo, workspaceId)
      const outcome = expect(run).rejects.toThrow('本次同步 超时（180 秒）')
      await vi.advanceTimersByTimeAsync(WEBDAV_SYNC_TIMEOUT_MS)
      await outcome
      releaseSecret(appPassword)
      await vi.advanceTimersByTimeAsync(0)
      expect(webdav.pull).not.toHaveBeenCalled()
      expect(webdav.push).not.toHaveBeenCalled()
      expect(repo.acknowledgeSync).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test('small upload batches send only their objects and acknowledge only completed batches', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: `upload-${index}`, workspaceId, entityType: 'document', entityId: `doc-${index}`,
      expectedVersion: 1, operation: 'upsert', createdAt: timestamp,
      payload: { pageId: `doc-${index}`, schemaVersion: 3, markdown: `${index}-${'body'.repeat(900)}`, tiptapJson: { type: 'doc' }, updatedAt: timestamp },
    }))
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue(items)
    webdav.push.mockResolvedValueOnce({ firstSeq: 1, count: 25 }).mockRejectedValueOnce(new Error('interrupted batch'))
    const progress = vi.fn()
    await expect(synchronizeWebdav(repo, workspaceId, undefined, undefined, 'bidirectional', progress)).rejects.toThrow('interrupted batch')
    const pushes = webdav.push.mock.calls as unknown as Array<[unknown, string, unknown[], unknown[]]>
    expect(pushes.map((call) => [call[2].length, call[3].length])).toEqual([[25, 25], [25, 25]])
    expect(calls.acknowledge).toEqual([items.slice(0, 25).map((item) => ({ operation_id: item.id, entity_type: item.entityType, entity_id: item.entityId, version: 2 }))])
    expect(progress).toHaveBeenCalledWith('正在上传本机内容 26–50 / 60')
  })

  test('combines 200 small metadata changes into one journal commit instead of eight', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const items = Array.from({ length: 200 }, (_, index) => ({
      id: `op-${index}`, workspaceId, entityType: 'page_tag', entityId: `${pageId}:tag-${index}`,
      expectedVersion: 0, operation: 'upsert', payload: { pageId, tagId: `tag-${index}` },
    }))
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue(items)
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 200 })
    await expect(synchronizeWebdav(repo, workspaceId)).resolves.toMatchObject({ state: 'synced' })
    const pushes = webdav.push.mock.calls as unknown as Array<[unknown, string, unknown[], unknown[]]>
    expect(pushes.map((call) => [call[2].length, call[3].length])).toEqual([[200, 0]])
    expect(calls.acknowledge).toHaveLength(1)
    expect(calls.acknowledge[0]).toHaveLength(200)
  })

  test('deduplicates identical objects inside an upload batch', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `op-${index}`, workspaceId, entityType: 'asset', entityId: `asset-${index}`,
      expectedVersion: 0, operation: 'upsert', payload: { pageId, id: `asset-${index}` },
    }))
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue(items)
    ;(repo.getAssetContent as ReturnType<typeof vi.fn>).mockResolvedValue({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 30 })
    await synchronizeWebdav(repo, workspaceId)
    const pushes = webdav.push.mock.calls as unknown as Array<[unknown, string, unknown[], unknown[]]>
    expect(pushes.map((call) => [call[2].length, call[3].length])).toEqual([[30, 1]])
  })

  test('bounds large attachment batches by bytes and preserves completed progress', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const items = Array.from({ length: 3 }, (_, index) => ({
      id: `op-${index}`, workspaceId, entityType: 'asset', entityId: `asset-${index}`,
      expectedVersion: 0, operation: 'upsert', payload: { pageId, id: `asset-${index}` },
    }))
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue(items)
    ;(repo.getAssetContent as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({ arrayBuffer: async () => new Uint8Array(5 * 1024 * 1024).fill(Number(id.slice(-1))).buffer }))
    webdav.push.mockResolvedValueOnce({ firstSeq: 1, count: 1 }).mockRejectedValueOnce(new Error('network stopped'))
    await expect(synchronizeWebdav(repo, workspaceId)).rejects.toThrow('network stopped')
    const pushes = webdav.push.mock.calls as unknown as Array<[unknown, string, unknown[], unknown[]]>
    expect(pushes.map((call) => [call[2].length, call[3].length])).toEqual([[1, 1], [1, 1]])
    expect(calls.acknowledge[0]).toHaveLength(1)
  })

  test('does not acknowledge a partial remote batch receipt', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'op', workspaceId, entityType: 'page', entityId: pageId, expectedVersion: 0, operation: 'delete', payload: {} }])
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 0 })
    await expect(synchronizeWebdav(repo, workspaceId)).rejects.toThrow('远端上传确认不完整')
    expect(calls.acknowledge).toEqual([])
  })

  test('cancels a never-settling desktop request without acknowledging outbox and allows the next sync', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    const outboxItem = {
      id: 'op-cancel', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
      payload: { id: pageId, workspaceId, kind: 'document', title: '不应确认', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending' },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])
    let resolvePull: (() => void) | undefined
    webdav.pull.mockImplementationOnce(() => new Promise<{ entries: []; fingerprint: string }>((resolve) => { resolvePull = () => resolve({ entries: [], fingerprint: 'fp' }) }))
    const controller = new AbortController()
    const running = synchronizeWebdav(repo, workspaceId, controller.signal)
    await vi.waitFor(() => expect(webdav.pull).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(webdav.cancel).toHaveBeenCalledWith(expect.any(String))
    expect(calls.acknowledge).toEqual([])

    // The abandoned IPC promise may settle later, but it cannot retain the
    // renderer's sync state or prevent a new request from starting.
    resolvePull?.()
    webdav.pull.mockResolvedValue({ entries: [], fingerprint: 'fp' })
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 1 })
    await expect(synchronizeWebdav(repo, workspaceId)).resolves.toMatchObject({ state: 'synced' })
    expect(webdav.pull).toHaveBeenCalledTimes(3)
    expect(calls.acknowledge).toHaveLength(1)
  })

  test('times out a never-settling desktop request and leaves the outbox pending', async () => {
    vi.useFakeTimers()
    try {
      const { webdav } = installDesktopMock()
      seedWebdavSettings()
      const { repo, calls } = repository()
      const outboxItem = {
        id: 'op-timeout', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
        payload: { id: pageId, workspaceId, kind: 'document', title: '超时不确认', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending' },
      }
      ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([outboxItem])
      webdav.pull.mockImplementationOnce(() => new Promise(() => undefined))
      const running = synchronizeWebdav(repo, workspaceId)
      const outcome = expect(running).rejects.toThrow('读取远端日志 超时（60 秒）')
      await vi.advanceTimersByTimeAsync(WEBDAV_OPERATION_TIMEOUT_MS)

      await outcome
      expect(webdav.cancel).toHaveBeenCalledWith(expect.any(String))
      expect(calls.acknowledge).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not acknowledge private local-only changes when the sync is cancelled', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const privateItem = {
      id: 'op-private-cancel', workspaceId, entityType: 'page', entityId: pageId, operation: 'upsert' as const, expectedVersion: 0,
      payload: { id: pageId, locked: true, title: 'local only' },
    }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([privateItem])
    ;(repo.isPrivateSyncItem as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    const controller = new AbortController()
    webdav.pull.mockImplementationOnce(() => new Promise(() => undefined))
    const running = synchronizeWebdav(repo, workspaceId, controller.signal)
    await vi.waitFor(() => expect(webdav.pull).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(repo.acknowledgeLocalOnlySync).not.toHaveBeenCalled()
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
    expect(webdav.objectGet).toHaveBeenCalledWith(connection, externalizedHash, expect.any(String))
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

  test('refuses an asset journal row without bytes before metadata or cursors can advance', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo, calls } = repository()
    webdav.pull.mockResolvedValue({
      entries: [remoteEntry({ seq: 1, type: 'asset', id: 'asset-missing-bytes', payload: { id: 'asset-missing-bytes', pageId, kind: 'file', filename: 'missing.bin', mimeType: 'application/octet-stream', createdAt: timestamp } })],
      fingerprint: 'fp',
    })

    await expect(synchronizeWebdav(repo, workspaceId)).rejects.toThrow('缺少内容哈希')
    expect(calls.applyChanges).toEqual([])
    expect(calls.importedAssets).toEqual([])
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
    ], [], expect.any(String))
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

  test('publishes privacy retractions but keeps subsequent private edits local-only', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const retraction = { id: 'privacy-delete', workspaceId, entityType: 'page', entityId: pageId, operation: 'delete' as const, expectedVersion: 2, payload: { privacyRetraction: true }, createdAt: timestamp }
    const privateUpdate = { id: 'privacy-local', workspaceId, entityType: 'document', entityId: pageId, operation: 'upsert' as const, expectedVersion: 2, payload: { pageId, locked: true, markdown: 'PRIVATE' }, createdAt: timestamp }
    ;(repo.listOutbox as ReturnType<typeof vi.fn>).mockResolvedValue([retraction, privateUpdate])
    ;(repo.isPrivateSyncItem as ReturnType<typeof vi.fn>).mockImplementation(async (item) => item.id === privateUpdate.id)
    webdav.push.mockResolvedValue({ firstSeq: 9, count: 1 })

    await synchronizeWebdav(repo, workspaceId)

    expect(webdav.push).toHaveBeenCalledWith(connection, deviceId, [expect.objectContaining({ op: 'delete', type: 'page', id: pageId, ver: 2 })], [], expect.any(String))
    expect(repo.acknowledgeLocalOnlySync).toHaveBeenCalledWith([privateUpdate])
    expect(repo.acknowledgeSync).toHaveBeenCalledWith(workspaceId, [expect.objectContaining({ operation_id: 'privacy-delete' })], undefined, true)
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
    expect(recordDiagnosticEvent).toHaveBeenCalledWith({
      level: 'warning', category: 'sync', action: 'conflict', status: 'failed',
      message: `page:${pageId} · remote parent 0 · affected pages 1`,
    })
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
    vi.mocked(synchronizeLegacySsh).mockResolvedValue({ state: 'synced', skipped: 0, fingerprint: 'ssh-test', retryCount: 0 })
  })

  test('requires configured WebDAV credentials before starting', async () => {
    const { repo } = repository()
    await expect(migrateSshToWebdav(repo, workspaceId)).rejects.toThrow('请先完整填写并保存坚果云 WebDAV 设置')
  })

  test('publishes a full v4 snapshot of the local bundle', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const legacy = bundle()
    legacy.documents[0]!.tiptapJson = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '旧版标题' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '旧版正文' }] },
    ] }
    vi.mocked(repo.exportData).mockResolvedValue(legacy)
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 3 })

    const result = await migrateSshToWebdav(repo, workspaceId)

    expect(result.published).toBeGreaterThanOrEqual(2)
    const [pushedConnection, pushedDeviceId, entries] = (webdav.push as ReturnType<typeof vi.fn>).mock.calls[0]! as [unknown, string, Array<{ op: string; type: string; ver: number; payload: Record<string, unknown> }>]
    expect(pushedConnection).toEqual(connection)
    expect(pushedDeviceId).toBe(deviceId)
    expect(entries.every((entry) => entry.op === 'upsert' && entry.ver === 0)).toBe(true)
    expect(entries.some((entry) => entry.type === 'notebook')).toBe(true)
    expect(entries.some((entry) => entry.type === 'page')).toBe(true)
    expect(entries.some((entry) => entry.type === 'document')).toBe(true)
    expect(entries.find(entry => entry.type === 'document')?.payload).toMatchObject({ schemaVersion: 3, markdown: '# 旧版标题\n\n旧版正文', tiptapJson: { type: 'doc', content: [] } })
    expect(JSON.parse(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup') ?? '{}')).toEqual({ 'device-0001': 3 })
  })

  test('omits private notebooks and all related payloads from SSH migration', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const source = bundle()
    const privateNotebookId = '90000000-0000-4000-8000-000000000001'
    const privatePageId = '90000000-0000-4000-8000-000000000002'
    const privateSectionId = 'private-section'
    const inheritedPageId = 'private-inherited-page'
    source.notebooks.push({ id: privateNotebookId, workspaceId, name: 'PRIVATE NOTEBOOK', sortOrder: 9, createdAt: timestamp, updatedAt: timestamp, locked: true })
    source.sections.push({ id: privateSectionId, notebookId: privateNotebookId, name: 'PRIVATE SECTION', sortOrder: 0, createdAt: timestamp, updatedAt: timestamp })
    source.pages.push({ ...source.pages[0]!, id: privatePageId, title: 'PRIVATE TITLE', locked: true })
    source.pages.push({ ...source.pages[0]!, id: inheritedPageId, sectionId: privateSectionId, title: 'PRIVATE INHERITED' })
    for (const id of [privatePageId, inheritedPageId]) {
      source.documents.push({ pageId: id, schemaVersion: 3, markdown: 'PRIVATE BODY', tiptapJson: { type: 'doc', content: [] }, updatedAt: timestamp })
      source.assets.push({ id: `PRIVATE-ASSET-${id}`, pageId: id, kind: 'file', filename: 'PRIVATE FILE', mimeType: 'text/plain', createdAt: timestamp })
      source.revisions.push({ id: `PRIVATE-REVISION-${id}`, pageId: id, createdAt: timestamp, reason: 'manual', document: source.documents.at(-1)! })
      source.pageTags.push({ pageId: id, tagId: 'PRIVATE TAG' })
      source.taskSteps.push({ id: `PRIVATE-STEP-${id}`, pageId: id, text: 'PRIVATE STEP', checked: false, sortOrder: 0, createdAt: timestamp })
      source.readingPositions.push({ id: `PRIVATE-POSITION-${id}`, pageId: id, deviceId, anchorUtf16Offset: 1, viewportOffsetFraction: 0, updatedAt: timestamp })
      source.tombstones.push({ id: `PRIVATE-TOMBSTONE-${id}`, workspaceId, entityType: 'page', entityId: id, deletedAt: timestamp, deviceId })
    }
    source.pageLinks.push({ id: 'PRIVATE-LINK', workspaceId, sourcePageId: pageId, targetPageId: inheritedPageId, kind: 'link', createdAt: timestamp })
    vi.mocked(repo.exportData).mockResolvedValue(source)
    webdav.push.mockResolvedValue({ firstSeq: 1, count: 3 })

    await migrateSshToWebdav(repo, workspaceId)

    const serialized = JSON.stringify((webdav.push as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(2))
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain(privateNotebookId)
    expect(serialized).not.toContain(privatePageId)
    expect(serialized).not.toContain(privateSectionId)
    expect(serialized).not.toContain(inheritedPageId)
    expect(repo.getAssetContent).not.toHaveBeenCalled()
  })

  test('preserves an edit during migration and publishes it as a successor readable by a fresh device', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const sourceDb = new NotebookRendererDatabase(`migration-source-${crypto.randomUUID()}`)
    const targetDb = new NotebookRendererDatabase(`migration-target-${crypto.randomUUID()}`)
    const source = new RealRepository(sourceDb)
    const target = new RealRepository(targetDb)
    const initial = bundle()
    const originalDocument = { ...initial.documents[0]!, schemaVersion: 3, markdown: '迁移快照的正文' }
    const entries: Array<ReturnType<typeof remoteEntry>> = []
    let editDuringUpload = true
    const cursorKey = 'notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup'
    ;(webdav.push as ReturnType<typeof vi.fn>).mockImplementation(async (_settings, _device, batch) => {
      const firstSeq = entries.length + 1
      for (const item of batch) entries.push({ ...item, seq: entries.length + 1, deviceId })
      if (editDuringUpload) {
        editDuringUpload = false
        await source.savePage({ ...initial.pages[0]!, title: '上传过程中修改', syncStatus: 'pending' }, { ...originalDocument, markdown: '上传过程中更新的正文' })
      }
      return { firstSeq, count: batch.length }
    })
    ;(webdav.pull as ReturnType<typeof vi.fn>).mockImplementation(async (_settings, knownSeqs) => ({ entries: entries.filter(entry => entry.seq > (knownSeqs[deviceId] ?? 0)), fingerprint: 'remote' }))
    try {
      await source.saveNotebook(initial.notebooks[0]!)
      await source.savePage({ ...initial.pages[0]!, syncStatus: 'pending' }, originalDocument)
      expect((await migrateSshToWebdav(source, workspaceId)).published).toBe(3)
      const pending = await source.listOutbox(workspaceId)
      expect(pending.filter(item => ['page', 'document'].includes(item.entityType))).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: 'page', expectedVersion: 1 }),
        expect.objectContaining({ entityType: 'document', expectedVersion: 1 }),
      ]))
      expect((await source.getPage(pageId))?.syncStatus).toBe('pending')
      window.localStorage.removeItem(cursorKey)
      expect((await synchronizeWebdav(target, workspaceId, undefined, undefined, 'pull')).state).toBe('synced')
      expect((await target.getPageDocument(pageId))?.markdown).toBe(originalDocument.markdown)
      const targetCursor = window.localStorage.getItem(cursorKey)!
      expect((await synchronizeWebdav(source, workspaceId)).state).toBe('synced')
      expect(await source.hasPendingSyncChanges(workspaceId)).toBe(false)
      window.localStorage.setItem(cursorKey, targetCursor)
      expect((await synchronizeWebdav(target, workspaceId, undefined, undefined, 'pull')).state).toBe('synced')
      expect(await target.getPage(pageId)).toMatchObject({ title: '上传过程中修改', syncStatus: 'synced' })
      expect((await target.getPageDocument(pageId))?.markdown).toBe('上传过程中更新的正文')
      expect(await sourceDb.syncVersions.get(`${workspaceId}:document:${pageId}`)).toMatchObject({ version: 2, webdavParentVersion: true })
    } finally {
      sourceDb.close(); targetDb.close()
      await Promise.all([sourceDb.delete(), targetDb.delete()])
    }
  })

  test('restores nonempty Markdown, metadata, assets, history and trash on a fresh device', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const source = bundle()
    const sectionId = 'section-a'
    const childId = 'child-a'
    const assetId = 'asset-a'
    const tagId = 'tag-a'
    const trashId = 'trash-a'
    const markdown = `# 中文迁移\n\n${'保留正文和格式。\n'.repeat(300)}\n![附件](notebook-asset:${assetId})\n`
    source.notebooks[0] = { ...source.notebooks[0]!, emoji: '📓', color: '#123456' }
    source.sections.push({ id: sectionId, notebookId, name: '分区', color: '#abcdef', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp })
    source.pages[0] = { ...source.pages[0]!, sectionId, icon: '✅', sortOrder: 1000, treeUpdatedAt: timestamp, kind: 'task', dueAt: timestamp, reminderAt: timestamp, recurrenceRule: 'weekly', important: true, completedAt: timestamp, assigneeIds: ['user-a'] }
    source.pages.push({ ...source.pages[0]!, id: childId, parentPageId: pageId, sortOrder: 2000 })
    source.pages.push({ ...source.pages[0]!, id: trashId, deletedAt: timestamp })
    source.documents[0] = { pageId, schemaVersion: 3, markdown, tiptapJson: { type: 'doc', content: [] }, updatedAt: timestamp }
    source.documents.push({ ...source.documents[0]!, pageId: childId, markdown: '子页面正文' })
    source.documents.push({ ...source.documents[0]!, pageId: trashId, markdown: '可恢复的回收站正文' })
    source.assets.push({ id: assetId, pageId, kind: 'image', filename: '图片.png', mimeType: 'image/png', width: 40, height: 30, caption: '图片说明', displayWidth: 200, alignment: 'right', sidecarPaths: ['sidecar'], localPath: '/private/local-file', createdAt: timestamp })
    source.tags.push({ id: tagId, workspaceId, name: '标签', color: '#000000', createdAt: timestamp, updatedAt: timestamp })
    source.pageTags.push({ pageId, tagId })
    source.taskSteps.push({ id: 'step-a', pageId, text: '步骤', checked: true, sortOrder: 1, createdAt: timestamp })
    source.pageLinks.push({ id: 'link-a', workspaceId, sourcePageId: pageId, targetPageId: childId, kind: 'link', excerpt: '引用说明', createdAt: timestamp })
    source.readingPositions.push({ id: 'position-a', pageId, deviceId, anchorUtf16Offset: 42, viewportOffsetFraction: 0.5, updatedAt: timestamp })
    source.revisions.push({ id: 'revision-a', pageId, pageIcon: '✅', reason: 'manual', createdAt: timestamp, document: { ...source.documents[0]!, markdown: '# 历史正文\n原始内容', yjsState: new Uint8Array([1, 2]) } })
    source.tombstones.push({ id: 'gone', workspaceId, entityType: 'page', entityId: 'purged-page', deletedAt: timestamp, deviceId })
    source.tombstones.push({ id: 'trash', workspaceId, entityType: 'page', entityId: trashId, deletedAt: timestamp, deviceId })
    vi.mocked(repo.exportData).mockResolvedValue(source)
    vi.mocked(repo.getAssetContent).mockResolvedValue(new Blob(['immutable attachment bytes']))
    const entries: Array<ReturnType<typeof remoteEntry>> = []
    const objects = new Map<string, Uint8Array>()
    ;(webdav.push as ReturnType<typeof vi.fn>).mockImplementation(async (_settings, _device, batch, uploads) => {
      const firstSeq = entries.length + 1
      for (const item of batch) entries.push({ ...item, seq: entries.length + 1, deviceId })
      for (const item of uploads) objects.set(item.hash, item.data)
      return { firstSeq, count: batch.length }
    })
    const result = await migrateSshToWebdav(repo, workspaceId)
    expect(result.published).toBe(entries.length)
    expect(entries.find(entry => entry.type === 'document')?.payload).toHaveProperty('$payloadObject')
    expect(entries).toContainEqual(expect.objectContaining({ op: 'delete', id: 'purged-page' }))
    expect(JSON.stringify(entries)).not.toContain('/private/local-file')
    expect(JSON.stringify(entries)).not.toContain('yjsState')

    // Node's structuredClone (used by fake-indexeddb) preserves native Blob
    // bytes and methods, whereas jsdom's Blob is cloned as a plain object.
    vi.stubGlobal('Blob', NodeBlob)
    const db = new NotebookRendererDatabase(`migration-roundtrip-${crypto.randomUUID()}`)
    const restored = new RealRepository(db)
    try {
      window.localStorage.removeItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup')
      webdav.pull.mockResolvedValue({ entries, fingerprint: 'remote' })
      webdav.objectGet.mockImplementation(async (_settings, hash) => new Uint8Array(objects.get(hash)!))
      expect((await synchronizeWebdav(restored, workspaceId, undefined, undefined, 'pull')).state).toBe('synced')
      expect((await restored.getPageDocument(pageId))?.markdown).toBe(markdown)
      expect(await restored.getPage(pageId)).toMatchObject(source.pages[0]!)
      expect(await restored.getPage(childId)).toMatchObject({ parentPageId: pageId, sectionId, sortOrder: 2000 })
      expect((await restored.getPage(trashId))?.deletedAt).toBe(timestamp)
      expect((await restored.getPageDocument(trashId))?.markdown).toBe('可恢复的回收站正文')
      expect(await restored.listNotebooks(workspaceId)).toEqual(source.notebooks)
      expect(await restored.listSections(notebookId)).toEqual(source.sections)
      expect(await restored.listPageTags(pageId)).toEqual(source.pageTags)
      expect(await restored.listTaskSteps(pageId)).toEqual(source.taskSteps)
      expect(await restored.listPageLinks(pageId)).toEqual(source.pageLinks)
      expect((await restored.listAssets(pageId))[0]).toMatchObject({ caption: '图片说明', width: 40, alignment: 'right', sidecarPaths: ['sidecar'] })
      expect(await (await restored.getAssetContent(assetId))?.text()).toBe('immutable attachment bytes')
      expect((await restored.exportData(workspaceId)).revisions[0]?.document.markdown).toBe('# 历史正文\n原始内容')
    } finally {
      db.close()
      await db.delete()
      vi.unstubAllGlobals()
    }
  })

  test('does not publish or advance cursors when SSH is unavailable, an asset is missing, or confirmation is incomplete', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    vi.mocked(synchronizeLegacySsh).mockResolvedValueOnce({ state: 'offline', skipped: 0, fingerprint: '', retryCount: 0 })
    await expect(migrateSshToWebdav(repo, workspaceId)).rejects.toThrow('旧 SSH/SFTP 设置')
    expect(webdav.push).not.toHaveBeenCalled()
    vi.mocked(synchronizeLegacySsh).mockResolvedValueOnce({ state: 'conflict', skipped: 0, fingerprint: 'ssh-test', conflicts: [pageId], retryCount: 0 })
    await expect(migrateSshToWebdav(repo, workspaceId)).rejects.toThrow('内容存在冲突')
    expect(webdav.push).not.toHaveBeenCalled()
    const source = bundle()
    source.assets.push({ id: 'missing-asset', pageId, kind: 'file', filename: 'lost', mimeType: 'text/plain', createdAt: timestamp })
    vi.mocked(repo.exportData).mockResolvedValueOnce(source)
    await expect(migrateSshToWebdav(repo, workspaceId)).rejects.toThrow('缺少本地内容')
    expect(webdav.push).not.toHaveBeenCalled()
    webdav.push.mockResolvedValueOnce({ firstSeq: 1, count: 1 })
    await expect(migrateSshToWebdav(repo, workspaceId)).rejects.toThrow('上传确认不完整')
    expect(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup')).toBeNull()
  })

  test('batches a large migration and bounds an unresponsive upload', async () => {
    const { webdav } = installDesktopMock()
    seedWebdavSettings()
    const { repo } = repository()
    const source = bundle()
    source.tags = Array.from({ length: 420 }, (_, index) => ({ id: `tag-${index}`, workspaceId, name: `tag-${index}`, color: '#000', createdAt: timestamp, updatedAt: timestamp }))
    vi.mocked(repo.exportData).mockResolvedValue(source)
    let seq = 1
    ;(webdav.push as ReturnType<typeof vi.fn>).mockImplementation(async (_settings, _device, entries) => {
      const firstSeq = seq;seq += entries.length
      return { firstSeq, count: entries.length }
    })
    expect((await migrateSshToWebdav(repo, workspaceId)).published).toBe(423)
    expect(webdav.push).toHaveBeenCalledTimes(3)
    expect((webdav.push.mock.calls as unknown as Array<[unknown, unknown, unknown[]]>).every(call => call[2].length <= 200)).toBe(true)

    window.localStorage.removeItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup')
    vi.useFakeTimers()
    try {
      webdav.push.mockImplementation(() => new Promise(() => {}))
      const migration = migrateSshToWebdav(repo, workspaceId)
      const failure = expect(migration).rejects.toThrow('上传同步变更 超时')
      await vi.advanceTimersByTimeAsync(WEBDAV_OPERATION_TIMEOUT_MS + 1)
      await failure
      expect(webdav.cancel).toHaveBeenCalled()
      expect(window.localStorage.getItem('notebook-webdav-seqs-v1:https://dav.jianguoyun.com/dav/|jianguoyun|notebook_backup')).toBeNull()
    } finally { vi.useRealTimers() }
  })
})
