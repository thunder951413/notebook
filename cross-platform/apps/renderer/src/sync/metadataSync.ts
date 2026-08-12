import type { DexieNotebookRepository, RemoteSyncChange } from '@notebook/storage-renderer'
import { getSyncToken, loadSyncSettings } from './syncSettings'
import { loadSyncBackend } from './legacySshSettings'

interface PushResponse {
  applied: Array<{ operation_id: string; entity_type: string; entity_id: string; version: number; cursor: number }>
  conflicts: Array<{ operation_id: string; entity_type: string; entity_id: string; current_version: number; current_payload: Record<string, unknown> }>
}

interface PullResponse { cursor: number; has_more: boolean; changes: Array<{
  cursor: number; entity_type: string; entity_id: string; version: number; operation: string; payload: Record<string, unknown>
}> }

async function requestHeaders() {
  const token = await getSyncToken()
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

export async function synchronizeMetadata(repository: DexieNotebookRepository, workspaceId: string, signal?: AbortSignal) {
  const settings = loadSyncSettings()
  if (loadSyncBackend() !== 'api') return { state: 'offline' as const, conflicts: 0 }
  const baseUrl = settings.baseUrl
  if (!settings.enabled || !baseUrl || !navigator.onLine) return { state: 'offline' as const, conflicts: 0 }
  const headers = await requestHeaders()
  const outgoing = await repository.listOutbox(workspaceId)
  let conflicts = 0
  if (outgoing.length) {
    for (const item of outgoing.filter((value) => value.entityType === 'asset')) {
      const assetUrl = `${baseUrl}/v1/sync/assets/${encodeURIComponent(item.entityId)}?workspace_id=${encodeURIComponent(workspaceId)}`
      if (item.operation === 'delete') {
        const response = await fetch(assetUrl, { method: 'DELETE', headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'Content-Type')), signal })
        if (!response.ok) throw new Error(`附件删除同步失败：${response.status}`)
      } else {
        const content = await repository.getAssetContent(item.entityId)
        if (!content) throw new Error(`附件 ${item.entityId} 缺少本地内容，已阻止不完整同步`)
        const response = await fetch(assetUrl, { method: 'PUT', headers: { ...Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'Content-Type')), 'Content-Type': content.type || 'application/octet-stream' }, body: content, signal })
        if (!response.ok) throw new Error(`附件上传失败：${response.status}`)
      }
    }
    const response = await fetch(`${baseUrl}/v1/sync/push`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ workspace_id: workspaceId, changes: outgoing.map((item) => ({ operation_id: item.id, entity_type: item.entityType, entity_id: item.entityId, expected_version: item.expectedVersion, operation: item.operation, payload: item.payload })) }),
    })
    if (!response.ok) throw new Error(`同步上传失败：${response.status}`)
    const result = await response.json() as PushResponse
    await repository.acknowledgeSync(workspaceId, result.applied)
    await repository.markSyncConflicts(result.conflicts.filter((item) => item.entity_type === 'page').map((item) => item.entity_id))
    conflicts = result.conflicts.length
  }

  let cursor = await repository.getSyncCursor(workspaceId)
  let hasMore = true
  while (hasMore) {
    const response = await fetch(`${baseUrl}/v1/sync/pull?workspace_id=${encodeURIComponent(workspaceId)}&cursor=${cursor}&limit=200`, { headers, signal })
    if (!response.ok) throw new Error(`同步下载失败：${response.status}`)
    const result = await response.json() as PullResponse
    const changes: RemoteSyncChange[] = result.changes.map((item) => ({ cursor: item.cursor, entityType: item.entity_type, entityId: item.entity_id, version: item.version, operation: item.operation, payload: item.payload }))
    const downloadedAssets = new Map<string, Uint8Array>()
    for (const item of changes.filter((value) => value.entityType === 'asset' && value.operation !== 'delete')) {
      const assetResponse = await fetch(`${baseUrl}/v1/sync/assets/${encodeURIComponent(item.entityId)}?workspace_id=${encodeURIComponent(workspaceId)}`, { headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'Content-Type')), signal })
      if (!assetResponse.ok) throw new Error(`附件下载失败：${assetResponse.status}`)
      downloadedAssets.set(item.entityId, new Uint8Array(await assetResponse.arrayBuffer()))
    }
    const applied = await repository.applyRemoteChanges(workspaceId, changes, result.cursor, downloadedAssets)
    conflicts += applied.conflicts.length
    cursor = applied.cursor
    // A blocked change remains intentionally pullable. End this cycle instead
    // of spinning on the same cursor; the next user sync retries after the
    // local conflict has been resolved.
    hasMore = result.has_more && applied.conflicts.length === 0
  }
  return { state: conflicts ? 'conflict' as const : 'synced' as const, conflicts }
}
