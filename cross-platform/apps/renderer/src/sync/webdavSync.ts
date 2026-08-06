import type { DexieNotebookRepository, RemoteSyncChange } from '@notebook/storage-renderer'
import type { NotebookDataBundle } from '@notebook/domain'
import { sha256Hex } from '@notebook/sync-contract'
import { legacyDeviceId } from './legacySshSettings'
import { synchronizeLegacySsh } from './legacySshSync'
import { getWebdavAppPassword, getWebdavSyncPassword, loadWebdavKnownSeqs, loadWebdavSettings, saveWebdavKnownSeqs, type WebdavSettings } from './webdavSettings'

/**
 * v4 append-only journal synchronizer over WebDAV (e.g. 坚果云).
 *
 * Repository layout:
 *   journal/<deviceID>.jsonl   per-device append-only change log
 *   objects/<xx>/<sha256>      content-addressed note/attachment bytes
 *
 * Each device appends its own journal (single writer), so no locks or index
 * files are needed. Conflicts are detected while pulling: a remote entity
 * version above the local baseline with pending local edits marks a conflict,
 * which the shared storage-renderer merge logic resolves.
 */

const OBJECT_MARKER = '$object'
const EXTERNALIZE_BYTES = 2048
const BRIDGE_BASE = 'http://127.0.0.1:8787'

interface WebdavConnection extends WebdavSettings {
  appPassword: string
  syncPassword?: string
}

interface WebdavPullEntry {
  seq: number
  ts: string
  op: 'upsert' | 'delete'
  type: string
  id: string
  ver: number
  hash?: string
  payload: Record<string, unknown>
  deviceId: string
}

interface WebdavPushEntry {
  ts: string
  op: 'upsert' | 'delete'
  type: string
  id: string
  ver: number
  hash?: string
  payload: Record<string, unknown>
}

/** Transport abstraction: Electron IPC on desktop, loopback helper in browsers. */
interface WebdavTransport {
  test(connection: WebdavConnection): Promise<{ ok: boolean; remotePathExists: boolean; latencyMs: number; message: string }>
  pull(connection: WebdavConnection, knownSeqs: Record<string, number>): Promise<{ entries: WebdavPullEntry[]; fingerprint: string }>
  objectGet(connection: WebdavConnection, hash: string): Promise<Uint8Array>
  push(connection: WebdavConnection, deviceId: string, entries: WebdavPushEntry[], objects: Array<{ hash: string; data: Uint8Array }>): Promise<{ firstSeq: number; count: number }>
}

function desktopTransport(): WebdavTransport {
  const webdav = window.notebookDesktop!.webdav
  return {
    test: (connection) => webdav.test(connection),
    pull: (connection, knownSeqs) => webdav.pull(connection, knownSeqs),
    objectGet: (connection, hash) => webdav.objectGet(connection, hash),
    push: (connection, deviceId, entries, objects) => webdav.push(connection, deviceId, entries, objects),
  }
}

async function bridgePost<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BRIDGE_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error('无法连接本机同步助手（127.0.0.1:8787）。请使用 ./ctl start 启动它。')
  }
  if (!response.ok) {
    let detail = ''
    try { detail = ((await response.json()) as { detail?: unknown }).detail?.toString() ?? '' } catch { /* non-JSON body */ }
    throw new Error(`本机同步助手返回 ${response.status}${detail ? `：${detail}` : ''}`)
  }
  return response.json() as Promise<T>
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Browser builds reach the v4 repository through the local Python helper. */
function bridgeTransport(): WebdavTransport {
  return {
    test: async (connection) => bridgePost('/v1/local-webdav/test', { settings: connection }),
    pull: async (connection, knownSeqs) => bridgePost('/v1/local-webdav/pull', { settings: connection, knownSeqs }),
    objectGet: async (connection, hash) => {
      const result = await bridgePost<{ dataBase64: string }>('/v1/local-webdav/object', { settings: connection, hash })
      return base64ToBytes(result.dataBase64)
    },
    push: async (connection, deviceId, entries, objects) => bridgePost('/v1/local-webdav/push', {
      settings: connection,
      deviceId,
      entries,
      objects: objects.map((object) => ({ hash: object.hash, dataBase64: bytesToBase64(object.data) })),
    }),
  }
}

function webdavTransport(): WebdavTransport {
  return window.notebookDesktop ? desktopTransport() : bridgeTransport()
}

export interface WebdavSyncResult {
  state: 'offline' | 'synced' | 'conflict' | 'error'
  skipped: number
  conflicts: number
}

const encoder = new TextEncoder()

async function sha256Bytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data.slice().buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function connectionFor(settings: WebdavSettings, appPassword: string, syncPassword?: string): WebdavConnection {
  return { ...settings, appPassword, syncPassword }
}

/** Restore externalized document bodies fetched from objects/. */
async function materializeDocument(payload: Record<string, unknown>, transport: WebdavTransport, connection: WebdavConnection): Promise<Record<string, unknown>> {
  const marker = (payload.tiptapJson as { [OBJECT_MARKER]?: unknown } | undefined)?.[OBJECT_MARKER]
  if (typeof marker !== 'string') return payload
  const bytes = await transport.objectGet(connection, marker)
  return { ...payload, tiptapJson: JSON.parse(new TextDecoder().decode(bytes)) }
}

/** Externalize large document bodies into objects/, replacing them with a hash marker. */
function externalizeDocument(payload: Record<string, unknown>, objects: Array<{ hash: string; data: Uint8Array }>): { payload: Record<string, unknown>; hash?: string } {
  const tiptap = payload.tiptapJson
  if (!tiptap || typeof tiptap !== 'object') return { payload }
  const json = JSON.stringify(tiptap)
  if (json.length <= EXTERNALIZE_BYTES) return { payload }
  const hash = sha256Hex(json)
  objects.push({ hash, data: encoder.encode(json) })
  return { payload: { ...payload, tiptapJson: { [OBJECT_MARKER]: hash } }, hash }
}

export async function testWebdavConnection(settings: WebdavSettings, appPassword: string, syncPassword?: string) {
  return webdavTransport().test(connectionFor(settings, appPassword, syncPassword))
}

/**
 * One full pull round: read every journal's new entries, fetch referenced
 * objects, apply through the shared change pipeline, then advance read cursors.
 * Reads cursors from storage each time, so consecutive rounds (pull → push →
 * pull) pick up exactly the entries published since the last round.
 */
async function pullWebdavOnce(
  repository: DexieNotebookRepository,
  workspaceId: string,
  settings: WebdavSettings,
  connection: WebdavConnection,
  transport: WebdavTransport,
): Promise<{ conflicts: number; conflictKeys: Set<string> }> {
  const knownSeqs = loadWebdavKnownSeqs(settings)
  const pulled = await transport.pull(connection, knownSeqs)
  if (!pulled.entries.length) return { conflicts: 0, conflictKeys: new Set() }
  const previousCursor = await repository.getSyncCursor(workspaceId)
  const changes: RemoteSyncChange[] = []
  const downloadedAssets = new Map<string, Uint8Array>()
  for (let index = 0; index < pulled.entries.length; index += 1) {
    const entry = pulled.entries[index] as WebdavPullEntry
    let payload = entry.payload
    if (entry.type === 'document' && entry.op === 'upsert') payload = await materializeDocument(payload, transport, connection)
    if (entry.type === 'asset' && entry.op === 'upsert') {
      const hash = entry.hash ?? (entry.payload.objectHash as string | undefined)
      if (hash) downloadedAssets.set(entry.id, await transport.objectGet(connection, hash))
    }
    changes.push({ cursor: previousCursor + index + 1, entityType: entry.type, entityId: entry.id, version: entry.ver, operation: entry.op, payload })
  }
  const applied = await repository.applyRemoteChanges(workspaceId, changes, previousCursor + pulled.entries.length)
  await repository.importAssetContents(downloadedAssets)
  const conflictKeys = new Set<string>()
  for (const conflict of applied.conflicts) conflictKeys.add(`${conflict.entityType}:${conflict.entityId}`)
  const nextSeqs = { ...knownSeqs }
  for (const entry of pulled.entries) nextSeqs[entry.deviceId] = Math.max(nextSeqs[entry.deviceId] ?? 0, entry.seq)
  saveWebdavKnownSeqs(settings, nextSeqs)
  return { conflicts: applied.conflicts.length, conflictKeys }
}

/** The page an outbox item belongs to, so scoped syncs can filter by note. */
function outboxPageId(item: { entityType: string; entityId: string; payload: Record<string, unknown> }): string | undefined {
  if (item.entityType === 'page' || item.entityType === 'document') return item.entityId
  const pageId = item.payload.pageId
  return typeof pageId === 'string' ? pageId : undefined
}

export async function synchronizeWebdav(repository: DexieNotebookRepository, workspaceId: string, _signal?: AbortSignal, scope?: { pageId: string }): Promise<WebdavSyncResult> {
  const settings = loadWebdavSettings()
  if (!settings.baseUrl || !settings.username) return { state: 'offline', skipped: 0, conflicts: 0 }
  const appPassword = await getWebdavAppPassword()
  if (!appPassword) return { state: 'offline', skipped: 0, conflicts: 0 }
  const connection = connectionFor(settings, appPassword, (await getWebdavSyncPassword()) ?? undefined)
  const transport = webdavTransport()
  const deviceId = legacyDeviceId()

  // ---- Pull: adopt everything other devices published (journals are
  // append-only and shared, so pulls are always full increments — even a
  // scoped sync must see remote edits before pushing the focused page).
  let conflicts = 0
  let conflictKeys = new Set<string>()
  const firstPull = await pullWebdavOnce(repository, workspaceId, settings, connection, transport)
  conflicts += firstPull.conflicts
  conflictKeys = firstPull.conflictKeys

  // ---- Push: append pending local changes to this device's journal. Entries
  // that conflicted during the pull stay queued for the user to resolve; a
  // scoped sync (opening a note) pushes only that note's entities.
  const outgoing = await repository.listOutbox(workspaceId)
  const pending = outgoing.filter((item) => {
    if (conflictKeys.has(`${item.entityType}:${item.entityId}`)) return false
    if (!scope) return true
    return outboxPageId(item) === scope.pageId
  })
  if (pending.length) {
    const entries: Array<{ ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> }> = []
    const objects: Array<{ hash: string; data: Uint8Array }> = []
    for (const item of pending) {
      const entry: { ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> } = {
        ts: new Date().toISOString(),
        op: item.operation,
        type: item.entityType,
        id: item.entityId,
        ver: item.expectedVersion,
        payload: item.payload,
      }
      if (item.entityType === 'document' && item.operation === 'upsert') {
        const external = externalizeDocument(item.payload, objects)
        entry.payload = external.payload
        entry.hash = external.hash
      }
      if (item.entityType === 'asset' && item.operation === 'upsert') {
        const content = await repository.getAssetContent(item.entityId)
        if (!content) throw new Error(`附件 ${item.entityId} 缺少本地内容，已阻止不完整同步`)
        const bytes = new Uint8Array(await content.arrayBuffer())
        const hash = await sha256Bytes(bytes)
        objects.push({ hash, data: bytes })
        entry.hash = hash
        entry.payload = { ...item.payload, objectHash: hash, byteSize: bytes.byteLength }
      }
      entries.push(entry)
    }
    if (entries.length) {
      const pushed = await transport.push(connection, deviceId, entries, objects)
      await repository.acknowledgeSync(workspaceId, pending.map((item) => ({
        operation_id: item.id,
        entity_type: item.entityType,
        entity_id: item.entityId,
        version: item.expectedVersion + 1,
      })))
      const nextSeqs = loadWebdavKnownSeqs(settings)
      nextSeqs[deviceId] = Math.max(nextSeqs[deviceId] ?? 0, pushed.firstSeq + pushed.count - 1)
      saveWebdavKnownSeqs(settings, nextSeqs)

      // ---- Pull 2: anything another device published while we were pushing
      // comes back immediately, instead of waiting for the next trigger.
      const secondPull = await pullWebdavOnce(repository, workspaceId, settings, connection, transport)
      conflicts += secondPull.conflicts
      for (const key of secondPull.conflictKeys) conflictKeys.add(key)
    }
  }

  return { state: conflicts ? 'conflict' : 'synced', skipped: 0, conflicts }
}

/** Build a full v4 snapshot from the local bundle for first publication. */
function bundleToEntries(bundle: NotebookDataBundle, deviceId: string): Array<{ type: string; id: string; ver: number; payload: Record<string, unknown> }> {
  const entries: Array<{ type: string; id: string; ver: number; payload: Record<string, unknown> }> = []
  const push = (type: string, id: string, payload: Record<string, unknown>) => entries.push({ type, id, ver: 0, payload })
  for (const notebook of bundle.notebooks) push('notebook', notebook.id, {
    id: notebook.id, workspaceId: notebook.workspaceId, name: notebook.name, sortOrder: notebook.sortOrder, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt,
  })
  for (const section of bundle.sections) push('section', section.id, {
    id: section.id, notebookId: section.notebookId, name: section.name, sortOrder: section.sortOrder, createdAt: section.createdAt, updatedAt: section.updatedAt,
  })
  for (const page of bundle.pages) push('page', page.id, {
    id: page.id, workspaceId: page.workspaceId, kind: page.kind === 'task' ? 'task' : 'document', title: page.title, preview: page.preview,
    favorite: page.favorite, createdAt: page.createdAt, updatedAt: page.updatedAt, syncStatus: 'synced',
  })
  for (const document of bundle.documents) push('document', document.pageId, {
    pageId: document.pageId, schemaVersion: document.schemaVersion, tiptapJson: document.tiptapJson ?? { type: 'doc', content: [] }, updatedAt: document.updatedAt,
  })
  for (const tag of bundle.tags) push('tag', tag.id, {
    id: tag.id, workspaceId: tag.workspaceId, name: tag.name, color: tag.color, createdAt: tag.createdAt, updatedAt: tag.updatedAt,
  })
  for (const pageTag of bundle.pageTags) push('page_tag', `${pageTag.pageId}:${pageTag.tagId}`, { pageId: pageTag.pageId, tagId: pageTag.tagId })
  for (const step of bundle.taskSteps) push('task_step', step.id, {
    id: step.id, pageId: step.pageId, text: step.text, checked: step.checked, sortOrder: step.sortOrder, createdAt: step.createdAt,
  })
  for (const asset of bundle.assets) push('asset', asset.id, {
    id: asset.id, pageId: asset.pageId, kind: asset.kind, filename: asset.filename, mimeType: asset.mimeType,
    createdAt: asset.createdAt, byteSize: asset.byteSize, objectHash: asset.checksum,
  })
  for (const link of bundle.pageLinks) push('page_link', link.id, {
    id: link.id, workspaceId: link.workspaceId, sourcePageId: link.sourcePageId, targetPageId: link.targetPageId, kind: link.kind, createdAt: link.createdAt,
  })
  for (const position of bundle.readingPositions) push('reading_position', position.id, {
    id: position.id, pageId: position.pageId, anchorUtf16Offset: position.anchorUtf16Offset, viewportOffsetFraction: position.viewportOffsetFraction,
    updatedAt: position.updatedAt, deviceId: position.deviceId || deviceId,
  })
  return entries
}

/**
 * One-time migration: merge the legacy SSH repository into the local store,
 * then publish the full local state as a v4 snapshot to WebDAV.
 */
export async function migrateSshToWebdav(repository: DexieNotebookRepository, workspaceId: string): Promise<{ published: number }> {
  const settings = loadWebdavSettings()
  const appPassword = await getWebdavAppPassword()
  if (!settings.baseUrl || !settings.username || !appPassword) throw new Error('请先完整填写并保存坚果云 WebDAV 设置')
  if (!window.notebookDesktop) throw new Error('从 SSH 迁移仅在 Electron 桌面版中提供')
  const connection = connectionFor(settings, appPassword, (await getWebdavSyncPassword()) ?? undefined)
  const deviceId = legacyDeviceId()

  // 1. Merge the latest SSH state into the local store first, so the snapshot
  // below includes every note that lives on the SSH server. Errors propagate
  // as exceptions and abort the migration.
  await synchronizeLegacySsh(repository, workspaceId, true)

  // 2. Export the merged local bundle and turn it into a full v4 snapshot.
  const bundle = await repository.exportData(workspaceId)
  const entries: Array<{ ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> }> = []
  const objects: Array<{ hash: string; data: Uint8Array }> = []
  for (const item of bundleToEntries(bundle, deviceId)) {
    if (item.type === 'asset') {
      const content = await repository.getAssetContent(item.id)
      if (content) {
        const bytes = new Uint8Array(await content.arrayBuffer())
        const hash = await sha256Bytes(bytes)
        objects.push({ hash, data: bytes })
        item.payload = { ...item.payload, objectHash: hash, byteSize: bytes.byteLength }
      }
      entries.push({ ts: new Date().toISOString(), op: 'upsert', ...item, hash: (item.payload as { objectHash?: string }).objectHash })
      continue
    }
    if (item.type === 'document') {
      const external = externalizeDocument(item.payload, objects)
      entries.push({ ts: new Date().toISOString(), op: 'upsert', ...item, payload: external.payload, hash: external.hash })
      continue
    }
    entries.push({ ts: new Date().toISOString(), op: 'upsert', ...item })
  }

  // 3. Publish the snapshot and advance this device's read cursor past it.
  const pushed = await webdavTransport().push(connection, deviceId, entries, objects)
  const knownSeqs = loadWebdavKnownSeqs(settings)
  knownSeqs[deviceId] = Math.max(knownSeqs[deviceId] ?? 0, pushed.firstSeq + pushed.count - 1)
  saveWebdavKnownSeqs(settings, knownSeqs)
  return { published: entries.length }
}
