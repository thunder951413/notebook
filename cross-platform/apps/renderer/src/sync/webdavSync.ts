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
const PAYLOAD_OBJECT_MARKER = '$payloadObject'
const EXTERNALIZE_BYTES = 2048
const BRIDGE_BASE = 'http://127.0.0.1:8787'
/** Individual WebDAV round-trips must not keep the UI busy forever. */
export const WEBDAV_OPERATION_TIMEOUT_MS = 60_000
/** A complete pull → push → pull round has a separate upper bound. */
export const WEBDAV_SYNC_TIMEOUT_MS = 180_000

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
  test(connection: WebdavConnection, signal?: AbortSignal): Promise<{ ok: boolean; remotePathExists: boolean; latencyMs: number; message: string }>
  pull(connection: WebdavConnection, knownSeqs: Record<string, number>, signal?: AbortSignal): Promise<{ entries: WebdavPullEntry[]; fingerprint: string }>
  objectGet(connection: WebdavConnection, hash: string, signal?: AbortSignal): Promise<Uint8Array>
  push(connection: WebdavConnection, deviceId: string, entries: WebdavPushEntry[], objects: Array<{ hash: string; data: Uint8Array }>, signal?: AbortSignal): Promise<{ firstSeq: number; count: number }>
}

function abortError(): DOMException {
  return new DOMException('WebDAV 同步已取消', 'AbortError')
}

/**
 * ipcRenderer.invoke cannot itself be aborted. Reject the renderer-side wait
 * immediately, while also notifying the main process to abort its matching
 * WebDAV client request. The main process has a second deadline as a fallback.
 */
function invokeDesktopWebdav<T>(signal: AbortSignal | undefined, invoke: (requestId: string) => Promise<T>): Promise<T> {
  const webdav = window.notebookDesktop!.webdav
  const requestId = crypto.randomUUID()
  if (signal?.aborted) return Promise.reject(abortError())
  const operation = invoke(requestId)
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      void webdav.cancel(requestId).catch(() => undefined)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function desktopTransport(): WebdavTransport {
  const webdav = window.notebookDesktop!.webdav
  return {
    test: (connection, signal) => invokeDesktopWebdav(signal, (requestId) => webdav.test(connection, requestId)),
    pull: (connection, knownSeqs, signal) => invokeDesktopWebdav(signal, (requestId) => webdav.pull(connection, knownSeqs, requestId)),
    objectGet: (connection, hash, signal) => invokeDesktopWebdav(signal, (requestId) => webdav.objectGet(connection, hash, requestId)),
    push: (connection, deviceId, entries, objects, signal) => invokeDesktopWebdav(signal, (requestId) => webdav.push(connection, deviceId, entries, objects, requestId)),
  }
}

async function bridgePost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BRIDGE_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notebook-Request-Id': crypto.randomUUID() },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new DOMException(`WebDAV 同步已取消：${error instanceof Error ? error.message : String(error)}`, 'AbortError')
    throw new Error('无法连接本机同步助手（127.0.0.1:8787）。请使用 ./ctl start 启动它。', { cause: error })
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
    test: async (connection, signal) => bridgePost('/v1/local-webdav/test', { settings: connection }, signal),
    pull: async (connection, knownSeqs, signal) => bridgePost('/v1/local-webdav/pull', { settings: connection, knownSeqs }, signal),
    objectGet: async (connection, hash, signal) => {
      const result = await bridgePost<{ dataBase64: string }>('/v1/local-webdav/object', { settings: connection, hash }, signal)
      return base64ToBytes(result.dataBase64)
    },
    push: async (connection, deviceId, entries, objects, signal) => bridgePost('/v1/local-webdav/push', {
      settings: connection,
      deviceId,
      entries,
      objects: objects.map((object) => ({ hash: object.hash, dataBase64: bytesToBase64(object.data) })),
    }, signal),
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

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

async function withDeadline<T>(label: string, externalSignal: AbortSignal | undefined, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (externalSignal?.aborted) throw abortError()
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort(externalSignal?.reason)
  externalSignal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`${label} 超时`))
  }, timeoutMs)
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (timedOut) throw new Error(`${label} 超时（${Math.ceil(timeoutMs / 1_000)} 秒）`, { cause: error })
    if (externalSignal?.aborted) throw abortError()
    throw error
  } finally {
    window.clearTimeout(timer)
    externalSignal?.removeEventListener('abort', forwardAbort)
  }
}

function boundedTransport(transport: WebdavTransport, syncSignal: AbortSignal): WebdavTransport {
  return {
    test: (connection, signal) => withDeadline('WebDAV 连接测试', signal ?? syncSignal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => transport.test(connection, requestSignal)),
    pull: (connection, knownSeqs, signal) => withDeadline('读取远端日志', signal ?? syncSignal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => transport.pull(connection, knownSeqs, requestSignal)),
    objectGet: (connection, hash, signal) => withDeadline('下载远端对象', signal ?? syncSignal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => transport.objectGet(connection, hash, requestSignal)),
    push: (connection, deviceId, entries, objects, signal) => withDeadline('上传同步变更', signal ?? syncSignal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => transport.push(connection, deviceId, entries, objects, requestSignal)),
  }
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
async function materializeDocument(payload: Record<string, unknown>, transport: WebdavTransport, connection: WebdavConnection, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const marker = (payload.tiptapJson as { [OBJECT_MARKER]?: unknown } | undefined)?.[OBJECT_MARKER]
  if (typeof marker !== 'string') return payload
  const bytes = await transport.objectGet(connection, marker, signal)
  return { ...payload, tiptapJson: JSON.parse(new TextDecoder().decode(bytes)) }
}

async function materializePayload(payload: Record<string, unknown>, transport: WebdavTransport, connection: WebdavConnection, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const marker = payload[PAYLOAD_OBJECT_MARKER]
  if (typeof marker !== 'string') return payload
  const decoded = JSON.parse(new TextDecoder().decode(await transport.objectGet(connection, marker, signal))) as unknown
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') throw new Error(`远端对象 ${marker} 不是有效的实体内容`)
  return decoded as Record<string, unknown>
}

/** Externalize the complete durable document (including canonical Markdown). */
function externalizeDocument(payload: Record<string, unknown>, objects: Array<{ hash: string; data: Uint8Array }>): { payload: Record<string, unknown>; hash?: string } {
  const json = JSON.stringify(payload)
  const data = encoder.encode(json)
  if (data.byteLength <= EXTERNALIZE_BYTES) return { payload }
  const hash = sha256Hex(json)
  objects.push({ hash, data })
  return { payload: { [PAYLOAD_OBJECT_MARKER]: hash }, hash }
}

export async function testWebdavConnection(settings: WebdavSettings, appPassword: string, syncPassword?: string, signal?: AbortSignal) {
  return withDeadline('WebDAV 连接测试', signal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => webdavTransport().test(connectionFor(settings, appPassword, syncPassword), requestSignal))
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
  signal: AbortSignal,
): Promise<{ conflicts: number; conflictKeys: Set<string> }> {
  throwIfAborted(signal)
  const knownSeqs = loadWebdavKnownSeqs(settings)
  const pulled = await transport.pull(connection, knownSeqs, signal)
  if (!pulled.entries.length) return { conflicts: 0, conflictKeys: new Set() }
  const previousCursor = await repository.getSyncCursor(workspaceId)
  const changes: RemoteSyncChange[] = []
  const downloadedAssets = new Map<string, Uint8Array>()
  for (let index = 0; index < pulled.entries.length; index += 1) {
    throwIfAborted(signal)
    const entry = pulled.entries[index] as WebdavPullEntry
    let payload = await materializePayload(entry.payload, transport, connection, signal)
    if (entry.type === 'document' && entry.op === 'upsert') payload = await materializeDocument(payload, transport, connection, signal)
    if (entry.type === 'asset' && entry.op === 'upsert') {
      const hash = entry.hash ?? (entry.payload.objectHash as string | undefined)
      if (!hash) throw new Error(`远端附件 ${entry.id} 缺少内容哈希，已阻止不完整同步`)
      downloadedAssets.set(entry.id, await transport.objectGet(connection, hash, signal))
    }
    changes.push({ cursor: previousCursor + index + 1, entityType: entry.type, entityId: entry.id, version: entry.ver, operation: entry.op, payload })
  }
  throwIfAborted(signal)
  // Asset metadata, bytes and the read cursor share this one Dexie
  // transaction. If a byte write fails, neither its metadata nor the cursor
  // becomes visible, so the same journal record remains safely retryable.
  // Keep the optional argument for the concrete Dexie repository. Test and
  // third-party repository adapters can continue using the older two-stage
  // contract, while production metadata/bytes/cursor are atomic.
  const applied = await repository.applyRemoteChanges(workspaceId, changes, previousCursor + pulled.entries.length, downloadedAssets, true)
  throwIfAborted(signal)
  if (repository.applyRemoteChanges.length < 4) await repository.importAssetContents(downloadedAssets)
  const conflictKeys = new Set<string>()
  for (const conflict of applied.conflicts) conflictKeys.add(`${conflict.entityType}:${conflict.entityId}`)
  const nextSeqs = { ...knownSeqs }
  // applyRemoteChanges stops immediately before the first conflicting change.
  // Only advance WebDAV's per-device cursors across the prefix it actually
  // committed; otherwise the conflicting entry and every later entry would be
  // filtered out forever on the next pull.
  const appliedCount = Math.max(0, Math.min(pulled.entries.length, applied.cursor - previousCursor))
  for (const entry of pulled.entries.slice(0, appliedCount)) {
    nextSeqs[entry.deviceId] = Math.max(nextSeqs[entry.deviceId] ?? 0, entry.seq)
  }
  saveWebdavKnownSeqs(settings, nextSeqs)
  return { conflicts: applied.conflicts.length, conflictKeys }
}

/** The page an outbox item belongs to, so scoped syncs can filter by note. */
function outboxPageId(item: { entityType: string; entityId: string; payload: Record<string, unknown> }): string | undefined {
  if (item.entityType === 'page' || item.entityType === 'document') return item.entityId
  const pageId = item.payload.pageId
  return typeof pageId === 'string' ? pageId : undefined
}

export async function synchronizeWebdav(repository: DexieNotebookRepository, workspaceId: string, signal?: AbortSignal, scope?: { pageId: string }): Promise<WebdavSyncResult> {
  return withDeadline('本次同步', signal, WEBDAV_SYNC_TIMEOUT_MS, async (syncSignal) => {
    const settings = loadWebdavSettings()
    if (!settings.baseUrl || !settings.username) return { state: 'offline', skipped: 0, conflicts: 0 }
    const appPassword = await getWebdavAppPassword()
    if (!appPassword) return { state: 'offline', skipped: 0, conflicts: 0 }
    throwIfAborted(syncSignal)
    const connection = connectionFor(settings, appPassword, (await getWebdavSyncPassword()) ?? undefined)
    const transport = boundedTransport(webdavTransport(), syncSignal)
    const deviceId = legacyDeviceId()
    // syncOutbox is maintained in the same transaction as every local edit. It
    // is the smallest reliable database change marker: no full-library hash or
    // table scan is required before deciding whether there is anything to push.
    const hadLocalChanges = await repository.hasPendingSyncChanges(workspaceId)

    // ---- Pull: adopt everything other devices published (journals are
    // append-only and shared, so pulls are always full increments — even a
    // scoped sync must see remote edits before pushing the focused page).
    let conflicts = 0
    let conflictKeys = new Set<string>()
    const firstPull = await pullWebdavOnce(repository, workspaceId, settings, connection, transport, syncSignal)
    conflicts += firstPull.conflicts
    conflictKeys = firstPull.conflictKeys

    // A remote pull may overlap a local edit, so re-check the transactional
    // marker once before taking the zero-upload fast path.
    if (!hadLocalChanges && !await repository.hasPendingSyncChanges(workspaceId)) {
      return { state: conflicts ? 'conflict' : 'synced', skipped: 0, conflicts }
    }

    // ---- Push: append pending local changes to this device's journal. Entries
    // that conflicted during the pull stay queued for the user to resolve; a
    // scoped sync (opening a note) pushes only that note's entities.
    const outgoing = await repository.listOutbox(workspaceId)
    const privacy = await Promise.all(outgoing.map((item) => repository.isPrivateSyncItem(item)))
    const localOnly = outgoing.filter((_, index) => privacy[index])
    const pending = outgoing.filter((item) => {
      if (localOnly.includes(item)) return false
      if (conflictKeys.has(`${item.entityType}:${item.entityId}`)) return false
      if (!scope) return true
      return outboxPageId(item) === scope.pageId
    })
    if (pending.length) {
      const entries: Array<{ ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> }> = []
      const objects: Array<{ hash: string; data: Uint8Array }> = []
      for (const item of pending) {
        throwIfAborted(syncSignal)
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
        const pushed = await transport.push(connection, deviceId, entries, objects, syncSignal)
        throwIfAborted(syncSignal)
        await repository.acknowledgeSync(workspaceId, pending.map((item) => ({
          operation_id: item.id,
          entity_type: item.entityType,
          entity_id: item.entityId,
          version: item.expectedVersion + 1,
        })), undefined, true)
        const nextSeqs = loadWebdavKnownSeqs(settings)
        nextSeqs[deviceId] = Math.max(nextSeqs[deviceId] ?? 0, pushed.firstSeq + pushed.count - 1)
        saveWebdavKnownSeqs(settings, nextSeqs)

        // ---- Pull 2: anything another device published while we were pushing
        // comes back immediately, instead of waiting for the next trigger.
        const secondPull = await pullWebdavOnce(repository, workspaceId, settings, connection, transport, syncSignal)
        conflicts += secondPull.conflicts
        for (const key of secondPull.conflictKeys) conflictKeys.add(key)
      }
    }

    // Keep local-only acknowledgements until every network operation has
    // settled. A cancelled/timed-out sync must not acknowledge any outbox
    // rows, even rows that are intentionally excluded from remote publication.
    throwIfAborted(syncSignal)
    if (localOnly.length) await repository.acknowledgeLocalOnlySync(localOnly)
    return { state: conflicts ? 'conflict' : 'synced', skipped: 0, conflicts }
  })
}

/** Build a full v4 snapshot from the local bundle for first publication. */
function bundleToEntries(bundle: NotebookDataBundle, deviceId: string): Array<{ type: string; id: string; ver: number; payload: Record<string, unknown> }> {
  const entries: Array<{ type: string; id: string; ver: number; payload: Record<string, unknown> }> = []
  const push = (type: string, id: string, payload: Record<string, unknown>) => entries.push({ type, id, ver: 0, payload })
  const privateNotebookIds = new Set(bundle.notebooks.filter((notebook) => notebook.locked).map((notebook) => notebook.id))
  const privateSectionIds = new Set(bundle.sections.filter((section) => privateNotebookIds.has(section.notebookId)).map((section) => section.id))
  const privatePageIds = new Set(bundle.pages.filter((page) => page.locked || Boolean(page.sectionId && privateSectionIds.has(page.sectionId))).map((page) => page.id))
  for (const notebook of bundle.notebooks.filter((item) => !privateNotebookIds.has(item.id))) push('notebook', notebook.id, {
    id: notebook.id, workspaceId: notebook.workspaceId, name: notebook.name, sortOrder: notebook.sortOrder, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt,
  })
  for (const section of bundle.sections.filter((item) => !privateSectionIds.has(item.id))) push('section', section.id, {
    id: section.id, notebookId: section.notebookId, name: section.name, sortOrder: section.sortOrder, createdAt: section.createdAt, updatedAt: section.updatedAt,
  })
  for (const page of bundle.pages.filter((item) => !privatePageIds.has(item.id))) push('page', page.id, {
    id: page.id, workspaceId: page.workspaceId, kind: page.kind === 'task' ? 'task' : 'document', title: page.title, preview: page.preview,
    favorite: page.favorite, createdAt: page.createdAt, updatedAt: page.updatedAt, syncStatus: 'synced',
  })
  for (const document of bundle.documents.filter((item) => !privatePageIds.has(item.pageId))) push('document', document.pageId, {
    pageId: document.pageId, schemaVersion: document.schemaVersion, tiptapJson: document.tiptapJson ?? { type: 'doc', content: [] }, updatedAt: document.updatedAt,
  })
  for (const tag of bundle.tags) push('tag', tag.id, {
    id: tag.id, workspaceId: tag.workspaceId, name: tag.name, color: tag.color, createdAt: tag.createdAt, updatedAt: tag.updatedAt,
  })
  for (const pageTag of bundle.pageTags.filter((item) => !privatePageIds.has(item.pageId))) push('page_tag', `${pageTag.pageId}:${pageTag.tagId}`, { pageId: pageTag.pageId, tagId: pageTag.tagId })
  for (const step of bundle.taskSteps.filter((item) => !privatePageIds.has(item.pageId))) push('task_step', step.id, {
    id: step.id, pageId: step.pageId, text: step.text, checked: step.checked, sortOrder: step.sortOrder, createdAt: step.createdAt,
  })
  for (const asset of bundle.assets.filter((item) => !privatePageIds.has(item.pageId))) push('asset', asset.id, {
    id: asset.id, pageId: asset.pageId, kind: asset.kind, filename: asset.filename, mimeType: asset.mimeType,
    createdAt: asset.createdAt, byteSize: asset.byteSize, objectHash: asset.checksum,
  })
  for (const link of bundle.pageLinks.filter((item) => !privatePageIds.has(item.sourcePageId) && !privatePageIds.has(item.targetPageId))) push('page_link', link.id, {
    id: link.id, workspaceId: link.workspaceId, sourcePageId: link.sourcePageId, targetPageId: link.targetPageId, kind: link.kind, createdAt: link.createdAt,
  })
  for (const position of bundle.readingPositions.filter((item) => !privatePageIds.has(item.pageId))) push('reading_position', position.id, {
    id: position.id, pageId: position.pageId, anchorUtf16Offset: position.anchorUtf16Offset, viewportOffsetFraction: position.viewportOffsetFraction,
    updatedAt: position.updatedAt, deviceId: position.deviceId || deviceId,
  })
  for (const revision of bundle.revisions.filter((item) => !privatePageIds.has(item.pageId))) push('revision', revision.id, {
    ...revision,
    document: { ...revision.document, yjsState: undefined },
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
