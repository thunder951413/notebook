import { afterEach, expect, test, vi } from 'vitest'
import { synchronizeMetadata } from './metadataSync'
import { saveSyncBackend } from './syncSettings'
import type { DexieNotebookRepository, RemoteSyncChange, SyncOutboxItem } from '@notebook/storage-renderer'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

test('uploads and downloads attachment bytes around metadata cursor updates', async () => {
  saveSyncBackend('api')
  vi.stubEnv('VITE_NOTEBOOK_API_URL', 'http://sync.test')
  const outgoing: SyncOutboxItem = { id: 'op-1', workspaceId: 'workspace-a', entityType: 'asset', entityId: 'asset-a', expectedVersion: 0, operation: 'upsert', payload: { id: 'asset-a' }, createdAt: new Date().toISOString() }
  const applied: unknown[] = []
  const remote: RemoteSyncChange[][] = []
  const atomicContents: Map<string, Uint8Array>[] = []
  const repository = {
    listOutbox: vi.fn().mockResolvedValue([outgoing]), getAssetContent: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1, 2])], { type: 'image/png' })),
    acknowledgeSync: vi.fn(async (_workspace: string, value: unknown[]) => { applied.push(...value) }), markSyncConflicts: vi.fn(), getSyncCursor: vi.fn().mockResolvedValue(0),
    applyRemoteChanges: vi.fn(async (_workspace: string, value: RemoteSyncChange[], cursor: number, contents?: Map<string, Uint8Array>) => {
      remote.push(value)
      if (contents) atomicContents.push(contents)
      return { cursor, conflicts: [] }
    }),
  } as unknown as DexieNotebookRepository
  const responses = [
    new Response(null, { status: 204 }),
    Response.json({ applied: [{ operation_id: 'op-1', entity_type: 'asset', entity_id: 'asset-a', version: 1, cursor: 1 }], conflicts: [] }),
    Response.json({ cursor: 2, has_more: false, changes: [{ cursor: 2, entity_type: 'asset', entity_id: 'asset-b', version: 1, operation: 'upsert', payload: { id: 'asset-b' } }] }),
    new Response(new Uint8Array([3, 4]), { status: 200, headers: { 'Content-Type': 'image/png' } }),
  ]
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)
  expect(await synchronizeMetadata(repository, 'workspace-a')).toEqual({ state: 'synced', conflicts: 0 })
  expect(fetchMock.mock.calls.map(([url, options]) => [String(url), options?.method ?? 'GET'])).toEqual([
    ['http://sync.test/v1/sync/assets/asset-a?workspace_id=workspace-a', 'PUT'], ['http://sync.test/v1/sync/push', 'POST'],
    ['http://sync.test/v1/sync/pull?workspace_id=workspace-a&cursor=0&limit=200', 'GET'], ['http://sync.test/v1/sync/assets/asset-b?workspace_id=workspace-a', 'GET'],
  ])
  expect(applied).toHaveLength(1)
  expect(remote[0]?.[0]?.entityId).toBe('asset-b')
  expect(atomicContents[0]?.get('asset-b')).toEqual(new Uint8Array([3, 4]))
})

test('does not import remote attachment bytes or advance past a local conflict', async () => {
  saveSyncBackend('api')
  vi.stubEnv('VITE_NOTEBOOK_API_URL', 'http://sync.test')
  const atomicContents: Map<string, Uint8Array>[] = []
  const repository = {
    listOutbox: vi.fn().mockResolvedValue([]),
    getSyncCursor: vi.fn().mockResolvedValue(4),
    applyRemoteChanges: vi.fn(async (_workspace: string, _changes: RemoteSyncChange[], _cursor: number, contents?: Map<string, Uint8Array>) => {
      if (contents) atomicContents.push(contents)
      return { cursor: 4, conflicts: [{ entityType: 'asset', entityId: 'asset-a', pageIds: ['page-a'] }] }
    }),
  } as unknown as DexieNotebookRepository
  const responses = [
    Response.json({ cursor: 6, has_more: true, changes: [
      { cursor: 5, entity_type: 'asset', entity_id: 'asset-a', version: 2, operation: 'upsert', payload: { id: 'asset-a' } },
      { cursor: 6, entity_type: 'asset', entity_id: 'asset-b', version: 1, operation: 'upsert', payload: { id: 'asset-b' } },
    ] }),
    new Response(new Uint8Array([1]), { status: 200 }),
    new Response(new Uint8Array([2]), { status: 200 }),
  ]
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

  expect(await synchronizeMetadata(repository, 'workspace-a')).toEqual({ state: 'conflict', conflicts: 1 })
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(atomicContents).toHaveLength(1)
  expect([...atomicContents[0]!.keys()]).toEqual(['asset-a', 'asset-b'])
})

test('does not publish attachment metadata when local bytes are missing', async () => {
  saveSyncBackend('api')
  vi.stubEnv('VITE_NOTEBOOK_API_URL', 'http://sync.test')
  const repository = {
    listOutbox: vi.fn().mockResolvedValue([{ id: 'op-1', workspaceId: 'workspace-a', entityType: 'asset', entityId: 'asset-a', expectedVersion: 0, operation: 'upsert', payload: {}, createdAt: '' }]),
    getAssetContent: vi.fn().mockResolvedValue(undefined),
  } as unknown as DexieNotebookRepository
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  await expect(synchronizeMetadata(repository, 'workspace-a')).rejects.toThrow(/缺少本地内容/)
  expect(fetchMock).not.toHaveBeenCalled()
})
