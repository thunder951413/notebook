import { isSupportedSyncEntityType, type DexieNotebookRepository, type RemoteQuarantineInput, type RemoteSyncChange, type SyncQuarantineItem } from '@notebook/storage-renderer'
import { sha256Hex } from '@notebook/sync-contract'
import { legacyDeviceId } from './legacySshSettings'
import { synchronizeLegacySsh } from './legacySshSync'
import { getWebdavAppPassword, getWebdavSyncPassword, loadWebdavKnownSeqs, loadWebdavSettings, saveWebdavKnownSeqs, webdavFingerprint, type WebdavSettings } from './webdavSettings'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'
import { buildWebdavSnapshot, serializeWebdavPayload } from './webdavPayload'
import { isEncryptedPayload, WebdavPrivacyCipher } from './webdavPrivacy'
import { classifyMaterializeFailure, describeIssues, loadBlockedDevices, saveBlockedDevices, shouldRetryAutomatically, type MaterializeFailure, type WebdavBlockedDevice, type WebdavSyncIssues } from './webdavIssues'
export type { WebdavBlockedDevice, WebdavSyncIssues } from './webdavIssues'

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
/**
 * A sync run is cancelled when nothing has progressed for this long. A large
 * first restore may legitimately take many minutes; it keeps running as long
 * as requests keep completing.
 */
export const WEBDAV_SYNC_IDLE_TIMEOUT_MS = 120_000
/** Upper bound for one push; mirrors the native deadline (60 s + 5 s per object, max 900 s). */
const WEBDAV_PUSH_MAX_MS = 900_000
/** Assumed worst-case upload speed: 64 KiB/s (~0.5 Mbps). */
const WEBDAV_PUSH_BYTES_PER_SECOND = 64 * 1024
const WEBDAV_PUSH_HEARTBEAT_MS = 30_000
/** Absolute upper bound for one run. Applied batches are kept either way. */
export const WEBDAV_SYNC_TIMEOUT_MS = 30 * 60_000
const SSH_MIGRATION_TIMEOUT_MS = 180_000
/** Remote entries committed per transaction while pulling. */
export const WEBDAV_PULL_BATCH_ENTRIES = 40
/** Object downloads in flight at once (坚果云 throttles bursts). */
const WEBDAV_PULL_CONCURRENCY = 3
export const WEBDAV_UPLOAD_BATCH_SIZE = 25
export const WEBDAV_UPLOAD_BATCH_BYTES = 8 * 1024 * 1024
const WEBDAV_BATCH_JOURNAL_BYTES = 256 * 1024
const WEBDAV_BATCH_MAX_ENTRIES = 200

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
  pull(connection: WebdavConnection, knownSeqs: Record<string, number>, signal?: AbortSignal): Promise<{ entries: WebdavPullEntry[]; fingerprint: string; devices?: string[]; resetDevices?: string[]; warnings?: string[]; blocked?: WebdavBlockedDevice[] }>
  objectGet(connection: WebdavConnection, hash: string, signal?: AbortSignal): Promise<Uint8Array>
  push(connection: WebdavConnection, deviceId: string, entries: WebdavPushEntry[], objects: Array<{ hash: string; data: Uint8Array }>, signal?: AbortSignal, minSeq?: number): Promise<{ firstSeq: number; count: number }>
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
    push: (connection, deviceId, entries, objects, signal, minSeq) => invokeDesktopWebdav(signal, (requestId) => minSeq ? webdav.push(connection, deviceId, entries, objects, requestId, minSeq) : webdav.push(connection, deviceId, entries, objects, requestId)),
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
  /** Explicitly false only when no remote records or local acks changed data. */
  changed?: boolean
  /** Concurrent edits settled automatically (local kept, remote body copied). */
  resolved?: Array<{ entityType: string; entityId: string; pageIds: string[]; copyPageId?: string }>
  /** The repository lost this device's journal; the full library was queued again. */
  republished?: number
  /** Present when the sync worked but something still needs attention: never show a plain "synced". */
  issues?: WebdavSyncIssues
}

/**
 * Read cursors live in IndexedDB, committed in the same transaction as the
 * records they cover, so the database is the authority. localStorage is only
 * a legacy mirror: it can run ahead of the database (a crash between the two
 * writes) or outlive it (the database was cleared), and trusting it would skip
 * records this device never applied, including its own journal.
 */
export async function loadSeqs(repository: DexieNotebookRepository, settings: WebdavSettings): Promise<Record<string, number>> {
  const stored = typeof repository.getWebdavSeqs === 'function' ? await repository.getWebdavSeqs(webdavFingerprint(settings)) : undefined
  const legacy = loadWebdavKnownSeqs(settings)
  if (stored) return Object.fromEntries(Object.entries(stored).filter(([, seq]) => Number.isInteger(seq) && seq >= 0))
  if (typeof repository.getWebdavSeqs !== 'function' || !repository.db) return legacy
  // No cursors in the database. If it holds synchronised data, these are
  // pre-upgrade cursors worth keeping; if it is empty, they describe data that
  // is gone and everything must be read again (applying is idempotent).
  const hasSyncState = Boolean(await repository.db.syncVersions.limit(1).count())
  if (hasSyncState) return legacy
  if (Object.keys(legacy).length) recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'cursors-discarded', status: 'success', message: '本机数据库没有同步记录，已忽略残留的读取位置并重新读取云端' })
  return {}
}

async function saveSeqs(repository: DexieNotebookRepository, settings: WebdavSettings, seqs: Record<string, number>) {
  saveWebdavKnownSeqs(settings, seqs)
  if (typeof repository.saveWebdavSeqs === 'function') await repository.saveWebdavSeqs(webdavFingerprint(settings), seqs)
}

/** Repair: forget every read position so the next sync re-reads all journals. Applying is idempotent. */
export async function resetWebdavReadPositions(repository: DexieNotebookRepository) {
  const settings = loadWebdavSettings()
  saveWebdavKnownSeqs(settings, {})
  if (typeof repository.saveWebdavSeqs === 'function') await repository.saveWebdavSeqs(webdavFingerprint(settings), {})
  recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'repair-reset-cursors', status: 'success' })
}

/**
 * Repair: queue the complete local library for publication as successors of
 * the current versions. Used when the remote folder was emptied or another
 * device cannot see some notes. Other devices merge it idempotently.
 */
export async function queueFullWebdavRepublish(repository: DexieNotebookRepository, workspaceId: string): Promise<number> {
  const syncPassword = (await getWebdavSyncPassword()) ?? undefined
  const snapshot = buildWebdavSnapshot(await repository.exportData(workspaceId), legacyDeviceId(), Boolean(syncPassword))
  const enqueue = async () => {
    for (const item of snapshot) await repository.enqueueChange(workspaceId, item.type, item.id, item.op, item.payload)
  }
  if (repository.db) await repository.db.transaction('rw', [repository.db.syncOutbox, repository.db.syncVersions], enqueue)
  else await enqueue()
  recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'repair-republish', status: 'success', message: `已排队 ${snapshot.length} 条` })
  return snapshot.length
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
  let rejectOnAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(abortError())
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })
  try {
    // Credential IPC and third-party adapters may ignore AbortSignal. The
    // deadline must still settle the UI; late continuations check the signal
    // before any subsequent upload or acknowledgement.
    return await Promise.race([operation(controller.signal), aborted])
  } catch (error) {
    if (timedOut) throw new Error(`${label} 超时（${Math.ceil(timeoutMs / 1_000)} 秒）`, { cause: error })
    if (externalSignal?.aborted) throw abortError()
    throw error
  } finally {
    window.clearTimeout(timer)
    controller.signal.removeEventListener('abort', rejectOnAbort)
    externalSignal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * Like withDeadline, but the deadline is "no progress for `idleMs`": every
 * `alive()` call restarts the idle timer. `maxMs` still caps the whole run.
 */
async function withWatchdog<T>(label: string, externalSignal: AbortSignal | undefined, idleMs: number, maxMs: number, operation: (signal: AbortSignal, alive: () => void) => Promise<T>): Promise<T> {
  if (externalSignal?.aborted) throw abortError()
  const controller = new AbortController()
  let timeoutMessage: string | undefined
  const forwardAbort = () => controller.abort(externalSignal?.reason)
  externalSignal?.addEventListener('abort', forwardAbort, { once: true })
  const expire = (message: string) => {
    timeoutMessage = message
    controller.abort(new Error(message))
  }
  const idleMessage = `${label} 超时（${Math.ceil(idleMs / 1_000)} 秒没有进展）`
  let idleTimer = window.setTimeout(() => expire(idleMessage), idleMs)
  const hardTimer = window.setTimeout(() => expire(`${label} 超时（${Math.ceil(maxMs / 60_000)} 分钟）`), maxMs)
  const alive = () => {
    if (controller.signal.aborted) return
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => expire(idleMessage), idleMs)
  }
  let rejectOnAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(abortError())
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })
  try {
    return await Promise.race([operation(controller.signal, alive), aborted])
  } catch (error) {
    if (timeoutMessage) throw new Error(timeoutMessage, { cause: error })
    if (externalSignal?.aborted) throw abortError()
    throw error
  } finally {
    window.clearTimeout(idleTimer)
    window.clearTimeout(hardTimer)
    controller.signal.removeEventListener('abort', rejectOnAbort)
    externalSignal?.removeEventListener('abort', forwardAbort)
  }
}

function boundedTransport(transport: WebdavTransport, syncSignal: AbortSignal, alive: () => void = () => undefined): WebdavTransport {
  const progressed = <T>(operation: Promise<T>) => operation.then((value) => { alive(); return value })
  return {
    test: (connection, signal) => progressed(withDeadline('WebDAV 连接测试', signal ?? syncSignal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => transport.test(connection, requestSignal))),
    pull: (connection, knownSeqs, signal) => progressed(withDeadline('读取远端日志', signal ?? syncSignal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => transport.pull(connection, knownSeqs, requestSignal))),
    objectGet: (connection, hash, signal) => progressed(withDeadline('下载远端对象', signal ?? syncSignal, WEBDAV_OPERATION_TIMEOUT_MS, (requestSignal) => transport.objectGet(connection, hash, requestSignal))),
    // A batch of up to 8 MiB cannot finish in 60 s on a slow uplink. Scale the
    // deadline with the payload, and keep the idle watchdog fed while the
    // upload is genuinely in flight; cancellation still works throughout.
    push: (connection, deviceId, entries, objects, signal, minSeq) => {
      const heartbeat = window.setInterval(alive, WEBDAV_PUSH_HEARTBEAT_MS)
      return progressed(withDeadline('上传同步变更', signal ?? syncSignal, pushDeadlineMs(objects), (requestSignal) => transport.push(connection, deviceId, entries, objects, requestSignal, minSeq)))
        .finally(() => window.clearInterval(heartbeat))
    },
  }
}

export function pushDeadlineMs(objects: ReadonlyArray<{ data: Uint8Array }>): number {
  const bytes = objects.reduce((total, object) => total + object.data.byteLength, 0)
  const budget = WEBDAV_OPERATION_TIMEOUT_MS + objects.length * 5_000 + Math.ceil(bytes / WEBDAV_PUSH_BYTES_PER_SECOND) * 1_000
  return Math.min(WEBDAV_PUSH_MAX_MS, budget)
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

/** Runs `worker` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let failed = false
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = await worker(items[index] as T)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

function journalKey(entry: WebdavPullEntry) {
  return `${entry.deviceId}\n${entry.type}\n${entry.id}`
}

interface ReadableEntry { index: number; entry: WebdavPullEntry; payload: Record<string, unknown>; encrypted: boolean; asset?: Uint8Array; failure?: undefined }
interface UnreadableEntry { index: number; entry: WebdavPullEntry; failure: MaterializeFailure }

/** Download, decrypt and verify everything one journal record needs. */
async function materializeEntry(
  entry: WebdavPullEntry,
  transport: WebdavTransport,
  connection: WebdavConnection,
  cipher: WebdavPrivacyCipher,
  signal?: AbortSignal,
): Promise<{ payload: Record<string, unknown>; encrypted: boolean; asset?: Uint8Array }> {
  let payload = await materializePayload(entry.payload, transport, connection, signal)
  const encrypted = isEncryptedPayload(payload)
  if (encrypted) payload = await cipher.decryptPayload(entry.type, entry.id, payload, entry.op, entry.ver)
  if (entry.type === 'document' && entry.op === 'upsert') payload = await materializeDocument(payload, transport, connection, signal)
  let asset: Uint8Array | undefined
  if (entry.type === 'asset' && entry.op === 'upsert') {
    const hash = payload.objectHash as string | undefined ?? entry.hash
    if (!hash) throw new Error(`远端附件 ${entry.id} 缺少内容哈希，已阻止不完整同步`)
    let data = await transport.objectGet(connection, hash, signal)
    if (encrypted) data = await cipher.decrypt(`asset-bytes:${entry.id}`, JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>)
    if (typeof payload.checksum === 'string' && await sha256Bytes(data) !== payload.checksum) throw new Error(`附件 ${entry.id} 的内容校验失败`)
    asset = data
  }
  return { payload, encrypted, ...(asset ? { asset } : {}) }
}

/**
 * Try set-aside records again, in one transaction with their release: a record
 * that now applies leaves the quarantine, one that still fails stays with its
 * attempt counted. The read position is not touched (it already moved past).
 */
async function retryQuarantineWith(
  repository: DexieNotebookRepository,
  workspaceId: string,
  settings: WebdavSettings,
  connection: WebdavConnection,
  transport: WebdavTransport,
  signal: AbortSignal,
  select: (item: SyncQuarantineItem) => boolean,
): Promise<{ retried: number; remaining: number }> {
  if (typeof repository.listQuarantine !== 'function') return { retried: 0, remaining: 0 }
  const repositoryKey = webdavFingerprint(settings)
  const items = (await repository.listQuarantine()).filter((item) => item.repository === repositoryKey && select(item))
  if (!items.length) return { retried: 0, remaining: await repository.countQuarantine() }
  const cipher = new WebdavPrivacyCipher(connection.syncPassword ?? '')
  const ownDeviceId = legacyDeviceId()
  const changes: RemoteSyncChange[] = []
  const assets = new Map<string, Uint8Array>()
  const stillFailing: RemoteQuarantineInput[] = []
  const cursor = await repository.getSyncCursor(workspaceId)
  for (const item of items) {
    throwIfAborted(signal)
    const source = { repository: item.repository, deviceId: item.deviceId, seq: item.seq, ...(item.hash ? { hash: item.hash } : {}) }
    let payload = item.raw
    let encrypted = item.authenticated === true
    if (item.stage === 'materialize') {
      try {
        const entry: WebdavPullEntry = { seq: item.seq, ts: item.firstSeenAt, op: item.operation, type: item.entityType, id: item.entityId, ver: item.version, payload: item.raw, deviceId: item.deviceId, ...(item.hash ? { hash: item.hash } : {}) }
        const result = await materializeEntry(entry, transport, connection, cipher, signal)
        payload = result.payload
        encrypted = result.encrypted
        if (result.asset) assets.set(item.entityId, result.asset)
      } catch (error) {
        throwIfAborted(signal)
        const failure = classifyMaterializeFailure(error)
        if (!failure) throw error
        stillFailing.push({ ...source, entityType: item.entityType, entityId: item.entityId, version: item.version, operation: item.operation, reason: failure.reason, message: failure.message.slice(0, 300), stage: 'materialize', raw: item.raw })
        continue
      }
    }
    changes.push({
      cursor: cursor + changes.length + 1, entityType: item.entityType, entityId: item.entityId, version: item.version, operation: item.operation, payload, source,
      ...(encrypted ? { authenticatedPrivate: true as const } : {}),
      ...(item.deviceId === ownDeviceId ? { ownDevice: true as const } : {}),
    })
  }
  await repository.applyRemoteChanges(workspaceId, changes, cursor, assets, true, false, { autoResolve: true, quarantine: stillFailing, releaseQuarantine: items.map((item) => item.id) })
  const remaining = await repository.countQuarantine()
  recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'quarantine-retry', status: 'success', message: `重试 ${items.length} 条，剩余 ${remaining} 条` })
  return { retried: items.length, remaining }
}

/** User-initiated: try the set-aside records again (all of them, or the given ones). */
export async function retryWebdavQuarantine(repository: DexieNotebookRepository, workspaceId: string, ids?: string[], signal?: AbortSignal): Promise<{ retried: number; remaining: number }> {
  return withDeadline('重试同步问题', signal, WEBDAV_SYNC_TIMEOUT_MS, async (retrySignal) => {
    const settings = loadWebdavSettings()
    const appPassword = await getWebdavAppPassword()
    if (!settings.baseUrl || !settings.username || !appPassword) throw new Error('请先完整填写并保存坚果云 WebDAV 设置')
    const connection = connectionFor(settings, appPassword, (await getWebdavSyncPassword()) ?? undefined)
    const wanted = ids ? new Set(ids) : undefined
    return retryQuarantineWith(repository, workspaceId, settings, connection, boundedTransport(webdavTransport(), retrySignal), retrySignal, (item) => !wanted || wanted.has(item.id))
  })
}

/**
 * One full pull round: read every journal's new entries, fetch referenced
 * objects, apply through the shared change pipeline, then advance read cursors.
 *
 * Entries are applied in small batches. Each batch commits its data and the
 * per-device read positions in one transaction, so a failed or timed-out run
 * keeps everything already applied and the next run continues from there
 * instead of downloading the whole library again.
 */
async function pullWebdavOnce(
  repository: DexieNotebookRepository,
  workspaceId: string,
  settings: WebdavSettings,
  connection: WebdavConnection,
  transport: WebdavTransport,
  signal: AbortSignal,
  keepLocal = false,
  onProgress?: (message: string) => void,
): Promise<{ conflicts: number; conflictKeys: Set<string>; changed: boolean; resolved: NonNullable<WebdavSyncResult['resolved']>; devices?: string[]; blocked: WebdavBlockedDevice[] }> {
  throwIfAborted(signal)
  onProgress?.('正在读取远端日志…')
  // Recovery re-reads every device head, including previously consumed
  // snapshots. Otherwise a stale cached cursor could hide the remote branch
  // the user has explicitly chosen to supersede.
  const storedSeqs = await loadSeqs(repository, settings)
  const knownSeqs = keepLocal ? {} : storedSeqs
  const pulled = await transport.pull(connection, knownSeqs, signal)
  for (const warning of pulled.warnings ?? []) recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'repository-warning', status: 'info', message: warning })
  const ownDeviceId = legacyDeviceId()
  const repositoryKey = webdavFingerprint(settings)
  // A missing own journal is healed by republishing, so it is not a problem to report.
  const blocked = (pulled.blocked ?? []).filter((item) => !(item.deviceId === ownDeviceId && item.code === 'journal-missing'))
  saveBlockedDevices(repositoryKey, blocked)
  for (const item of blocked) recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'device-blocked', status: 'failed', message: `${item.deviceId} · ${item.code} · ${item.message}`.slice(0, 300) })
  // Read positions advance only across entries that are durably applied.
  const seqs = { ...storedSeqs }
  for (const device of pulled.resetDevices ?? []) seqs[device] = 0
  const entries = pulled.entries
  if (!entries.length) {
    if (pulled.resetDevices?.length) await saveSeqs(repository, settings, seqs)
    return { conflicts: 0, conflictKeys: new Set(), changed: false, resolved: [], devices: pulled.devices, blocked }
  }
  // A journal keeps every version of a note. Within one device's journal a
  // later entry for the same entity replaces the earlier ones, so only the
  // newest is downloaded and applied (version jumps are accepted by the
  // merge pipeline). This keeps a first restore close to one object per note.
  const newest = new Map<string, number>()
  entries.forEach((entry, index) => newest.set(journalKey(entry), index))
  const needed = (index: number) => newest.get(journalKey(entries[index] as WebdavPullEntry)) === index
  const total = newest.size
  let done = 0
  const cipher = new WebdavPrivacyCipher(connection.syncPassword ?? '')
  const conflictKeys = new Set<string>()
  const resolved: NonNullable<WebdavSyncResult['resolved']> = []
  let conflicts = 0
  for (let start = 0; start < entries.length;) {
    throwIfAborted(signal)
    const end = Math.min(entries.length, start + WEBDAV_PULL_BATCH_ENTRIES)
    const indices: number[] = []
    for (let index = start; index < end; index += 1) if (needed(index)) indices.push(index)
    const downloadedAssets = new Map<string, Uint8Array>()
    // A record that cannot be read (object gone, no key, damaged) is set aside
    // with its position instead of failing the run: every other record in the
    // batch still applies, and the set-aside one is retried later.
    const materialized = await mapLimit<number, ReadableEntry | UnreadableEntry>(indices, WEBDAV_PULL_CONCURRENCY, async (index) => {
      const entry = entries[index] as WebdavPullEntry
      try {
        const result = await materializeEntry(entry, transport, connection, cipher, signal)
        done += 1
        onProgress?.(total > 1 ? `正在同步远端内容 ${done} / ${total}` : '正在同步远端内容…')
        return { index, entry, ...result }
      } catch (error) {
        throwIfAborted(signal)
        const failure = classifyMaterializeFailure(error)
        if (!failure) throw error
        done += 1
        return { index, entry, failure }
      }
    })
    throwIfAborted(signal)
    const readable = materialized.filter((item): item is ReadableEntry => item.failure === undefined)
    const setAside: RemoteQuarantineInput[] = materialized.flatMap((item) => item.failure
      ? [{ repository: repositoryKey, deviceId: item.entry.deviceId, seq: item.entry.seq, entityType: item.entry.type, entityId: item.entry.id, version: item.entry.ver, operation: item.entry.op, reason: item.failure.reason, message: item.failure.message.slice(0, 300), stage: 'materialize' as const, raw: item.entry.payload, ...(item.entry.hash ? { hash: item.entry.hash } : {}) }]
      : [])
    for (const item of readable) if (item.asset) downloadedAssets.set(item.entry.id, item.asset)
    const batchCursor = await repository.getSyncCursor(workspaceId)
    const changes: RemoteSyncChange[] = readable.map(({ entry, payload, encrypted }, offset) => ({
      cursor: batchCursor + offset + 1, entityType: entry.type, entityId: entry.id, version: entry.ver, operation: entry.op, payload,
      source: { repository: repositoryKey, deviceId: entry.deviceId, seq: entry.seq, ...(entry.hash ? { hash: entry.hash } : {}) },
      ...(encrypted ? { authenticatedPrivate: true as const } : {}),
      ...(entry.deviceId === ownDeviceId ? { ownDevice: true as const } : {}),
    }))
    const batchSeqs = { ...seqs }
    for (let index = start; index < end; index += 1) {
      const entry = entries[index] as WebdavPullEntry
      batchSeqs[entry.deviceId] = Math.max(batchSeqs[entry.deviceId] ?? 0, entry.seq)
    }
    // Asset metadata, bytes and the read positions share one Dexie
    // transaction. If a byte write fails, neither its metadata nor the
    // position becomes visible, so the same journal record stays retryable.
    // Test and third-party repository adapters may still use the older
    // two-stage contract (bytes imported afterwards).
    const applied = await repository.applyRemoteChanges(workspaceId, changes, batchCursor + changes.length, downloadedAssets, true, keepLocal, { autoResolve: true, webdavSeqs: { key: repositoryKey, seqs: batchSeqs }, quarantine: setAside })
    if (repository.applyRemoteChanges.length < 4) await repository.importAssetContents(downloadedAssets)
    for (const conflict of applied.conflicts) {
      conflictKeys.add(`${conflict.entityType}:${conflict.entityId}`)
      const change = changes.find((item) => item.entityType === conflict.entityType && item.entityId === conflict.entityId && item.cursor > applied.cursor)
      recordDiagnosticEvent({
        level: 'warning', category: 'sync', action: 'conflict', status: 'failed',
        message: `${conflict.entityType}:${conflict.entityId} · remote parent ${change?.version ?? 'unknown'} · affected pages ${conflict.pageIds.length}`,
      })
      if (repository.db && change && ['section', 'page', 'document'].includes(conflict.entityType)) {
        const local = conflict.entityType === 'section' ? await repository.db.sections.get(conflict.entityId)
          : conflict.entityType === 'page' ? await repository.getPage(conflict.entityId)
            : await repository.getPageDocument(conflict.entityId)
        const version = await repository.db.syncVersions.get(`${workspaceId}:${conflict.entityType}:${conflict.entityId}`)
        const fields = [...new Set([...Object.keys(local ?? {}), ...Object.keys(change.payload)])]
          .filter((key) => JSON.stringify((local as unknown as Record<string, unknown> | undefined)?.[key]) !== JSON.stringify(change.payload[key]))
        recordDiagnosticEvent({
          level: 'warning', category: 'sync', action: 'entity-conflict', status: 'failed',
          message: JSON.stringify({ id: conflict.entityId, version: version?.version, parentVersion: version?.webdavParentVersion, localUpdatedAt: local?.updatedAt, remoteUpdatedAt: change.payload.updatedAt, fields }),
        })
      }
    }
    for (const item of applied.resolved ?? []) {
      resolved.push(item)
      recordDiagnosticEvent({
        level: 'warning', category: 'sync', action: 'conflict-auto-resolved', status: 'success',
        message: `${item.entityType}:${item.entityId} · 保留本机版本${item.copyPageId ? ` · 另一版本已存为 ${item.copyPageId}` : ''}`,
      })
    }
    for (const item of [...setAside.map((row) => ({ entityType: row.entityType, entityId: row.entityId, reason: row.reason })), ...(applied.quarantined ?? [])]) {
      recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'record-quarantined', status: 'failed', message: `${item.entityType}:${item.entityId} · ${item.reason}` })
    }
    for (const item of applied.discarded ?? []) {
      recordDiagnosticEvent({
        level: 'warning', category: 'sync', action: 'remote-upsert-ignored', status: 'success',
        message: `${item.entityType}:${item.entityId} 已在本机永久删除，忽略其他设备的旧版本`,
      })
    }
    // applyRemoteChanges stops immediately before the first conflicting
    // change. Only advance the read positions across the prefix it actually
    // committed; otherwise the conflicting entry and every later entry would
    // be filtered out forever on the next pull.
    const appliedCount = Math.max(0, Math.min(changes.length, applied.cursor - batchCursor))
    const stopAt = appliedCount < changes.length ? (readable[appliedCount] as { index: number }).index : end
    for (let index = start; index < stopAt; index += 1) {
      const entry = entries[index] as WebdavPullEntry
      seqs[entry.deviceId] = Math.max(seqs[entry.deviceId] ?? 0, entry.seq)
    }
    await saveSeqs(repository, settings, seqs)
    if (applied.conflicts.length) {
      conflicts += applied.conflicts.length
      break
    }
    if (entries.length > WEBDAV_PULL_BATCH_ENTRIES) recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'pull-batch', status: 'success', message: `已应用 ${end} / ${entries.length} 条远端记录（下载 ${done} / ${total}）` })
    start = end
  }
  if (keepLocal) recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'keep-local', status: 'success', message: `已核对 ${entries.length} 条远端记录；本机内容保留，覆盖变更已持久排队` })
  return { conflicts, conflictKeys, changed: true, resolved, devices: pulled.devices, blocked }
}

/** The page an outbox item belongs to, so scoped syncs can filter by note. */
function outboxPageId(item: { entityType: string; entityId: string; payload: Record<string, unknown> }): string | undefined {
  if (item.entityType === 'page' || item.entityType === 'document') return item.entityId
  const pageId = item.payload.pageId
  return typeof pageId === 'string' ? pageId : undefined
}

function* uploadBatches(entries: WebdavPushEntry[], objects: Array<{ hash: string; data: Uint8Array }>) {
  const objectsByHash = new Map(objects.map(object => [object.hash, object]))
  for (let offset = 0; offset < entries.length;) {
    const batch: WebdavPushEntry[] = []
    const hashes = new Set<string>()
    let objectBytes = 0
    let journalBytes = 0
    for (let index = offset; index < entries.length; index += 1) {
      const entry = entries[index]!
      const references = [entry.hash, typeof entry.payload.$assetObject === 'string' ? entry.payload.$assetObject : undefined].filter((hash): hash is string => Boolean(hash))
      const newHashes = [...new Set(references)].filter(hash => !hashes.has(hash))
      const bytes = newHashes.reduce((total, hash) => total + (objectsByHash.get(hash)?.data.byteLength ?? 0), 0)
      const rowBytes = encoder.encode(JSON.stringify(entry)).byteLength + 1
      if (batch.length && (batch.length >= WEBDAV_BATCH_MAX_ENTRIES
        || hashes.size + newHashes.length > WEBDAV_UPLOAD_BATCH_SIZE
        || objectBytes + bytes > WEBDAV_UPLOAD_BATCH_BYTES
        || journalBytes + rowBytes > WEBDAV_BATCH_JOURNAL_BYTES)) break
      batch.push(entry)
      for (const hash of newHashes) hashes.add(hash)
      objectBytes += bytes
      journalBytes += rowBytes
    }
    yield { offset, batch, batchObjects: [...hashes].map(hash => objectsByHash.get(hash)!).filter(Boolean), objectBytes, journalBytes }
    offset += batch.length
  }
}

function assertUploadConfirmation(pushed: { firstSeq: number; count: number }, count: number) {
  if (pushed.count !== count || !Number.isSafeInteger(pushed.firstSeq) || pushed.firstSeq < 1) throw new Error('远端上传确认不完整，待同步内容已保留')
}

/** What still needs attention in this repository, for the status line and the issues panel. */
export async function webdavSyncIssues(repository: DexieNotebookRepository): Promise<WebdavSyncIssues> {
  const quarantined = typeof repository.countQuarantine === 'function' ? await repository.countQuarantine() : 0
  return { quarantined, blocked: loadBlockedDevices(webdavFingerprint(loadWebdavSettings())) }
}

export async function synchronizeWebdav(repository: DexieNotebookRepository, workspaceId: string, signal?: AbortSignal, scope?: { pageId: string }, mode: 'bidirectional' | 'pull' | 'push' = 'bidirectional', onProgress?: (message: string) => void): Promise<WebdavSyncResult> {
  const result = await runWebdavSync(repository, workspaceId, signal, scope, mode, onProgress)
  if (result.state === 'offline') return result
  const issues = await webdavSyncIssues(repository)
  if (!issues.quarantined && !issues.blocked.length) return result
  recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'issues', status: 'info', message: describeIssues(issues) })
  return { ...result, issues }
}

async function runWebdavSync(repository: DexieNotebookRepository, workspaceId: string, signal?: AbortSignal, scope?: { pageId: string }, mode: 'bidirectional' | 'pull' | 'push' = 'bidirectional', onProgress?: (message: string) => void): Promise<WebdavSyncResult> {
  return withWatchdog('本次同步', signal, WEBDAV_SYNC_IDLE_TIMEOUT_MS, WEBDAV_SYNC_TIMEOUT_MS, async (syncSignal, alive) => {
    const settings = loadWebdavSettings()
    if (!settings.baseUrl || !settings.username) return { state: 'offline', skipped: 0, conflicts: 0 }
    onProgress?.('正在读取已保存的同步凭据…')
    const appPassword = await getWebdavAppPassword()
    if (!appPassword) return { state: 'offline', skipped: 0, conflicts: 0 }
    throwIfAborted(syncSignal)
    const connection = connectionFor(settings, appPassword, (await getWebdavSyncPassword()) ?? undefined)
    const transport = boundedTransport(webdavTransport(), syncSignal, alive)
    const deviceId = legacyDeviceId()
    const cipher = new WebdavPrivacyCipher(connection.syncPassword ?? '')
    if (connection.syncPassword && repository.db) {
      const seedKey = `notebook-private-seeded:${settings.baseUrl}|${settings.username}|${settings.remotePath}:${sha256Hex(connection.syncPassword)}`
      if (!window.localStorage.getItem(seedKey)) {
        const snapshot = buildWebdavSnapshot(await repository.exportData(workspaceId), deviceId, true)
        for (const item of snapshot) {
          const probe = { id: '', workspaceId, entityType: item.type, entityId: item.id, operation: item.op, payload: item.payload, expectedVersion: item.ver, createdAt: '' }
          if (await repository.isPrivateSyncItem(probe)) await repository.enqueueChange(workspaceId, item.type, item.id, item.op, item.payload)
        }
        window.localStorage.setItem(seedKey, '1')
      }
    }
    // syncOutbox is maintained in the same transaction as every local edit. It
    // is the smallest reliable database change marker: no full-library hash or
    // table scan is required before deciding whether there is anything to push.
    const hadLocalChanges = await repository.hasPendingSyncChanges(workspaceId)

    // ---- Pull: adopt everything other devices published (journals are
    // append-only and shared, so pulls are always full increments — even a
    // scoped sync must see remote edits before pushing the focused page).
    // Records set aside earlier may be readable now (key configured, app
    // upgraded, object re-uploaded). A failure here must not stop the sync.
    try {
      await retryQuarantineWith(repository, workspaceId, settings, connection, transport, syncSignal, (item) => shouldRetryAutomatically(item, { hasKey: Boolean(connection.syncPassword), supportsType: isSupportedSyncEntityType }))
    } catch (error) {
      throwIfAborted(syncSignal)
      recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'quarantine-retry', status: 'failed', message: error instanceof Error ? error.message.slice(0, 200) : String(error) })
    }
    let conflicts = 0
    let conflictKeys = new Set<string>()
    const firstPull = await pullWebdavOnce(repository, workspaceId, settings, connection, transport, syncSignal, mode === 'push', onProgress)
    conflicts += firstPull.conflicts
    conflictKeys = firstPull.conflictKeys
    const resolved = [...firstPull.resolved]
    let republished = 0
    const extras = () => ({ ...(resolved.length ? { resolved } : {}), ...(republished ? { republished } : {}) })
    // Self-healing: this device published before, but its journal is gone
    // from the repository (folder deleted or restored from an old copy), or
    // this is the first device connected to an empty folder. Without a full
    // publication other devices would silently miss existing notes. Sequence
    // numbers continue above the old ones so stale cursors stay valid.
    const ownSeq = (await loadSeqs(repository, settings))[deviceId] ?? 0
    if (mode !== 'pull' && firstPull.devices && !firstPull.devices.includes(deviceId) && (ownSeq > 0 || firstPull.devices.length === 0)) {
      onProgress?.('云端缺少本机记录，正在重新排队全部内容…')
      republished = await queueFullWebdavRepublish(repository, workspaceId)
      recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'remote-journal-missing', status: 'success', message: `本机日志在云端缺失（原序号 ${ownSeq}），已重新排队 ${republished} 条` })
    }
    // A blocked prefix may conceal conflicts later in the same journal. Do
    // not publish a document/asset from a page whose metadata is unresolved.
    if (conflicts || mode === 'pull') return { state: conflicts ? 'conflict' : 'synced', skipped: 0, conflicts, ...extras() }

    // A remote pull may overlap a local edit, so re-check the transactional
    // marker once before taking the zero-upload fast path.
    if (!hadLocalChanges && !republished && !await repository.hasPendingSyncChanges(workspaceId)) {
      return { state: conflicts ? 'conflict' : 'synced', skipped: 0, conflicts, ...(firstPull.changed ? {} : { changed: false }), ...extras() }
    }

    // ---- Push: append pending local changes to this device's journal. Entries
    // that conflicted during the pull stay queued for the user to resolve; a
    // scoped sync (opening a note) pushes only that note's entities.
    const outgoing = await repository.listOutbox(workspaceId)
    const privacy = await Promise.all(outgoing.map((item) => repository.isPrivateSyncItem(item)))
    const localOnly = outgoing.filter((_, index) => privacy[index] && !connection.syncPassword)
    const pending = outgoing.filter((item) => {
      if (localOnly.includes(item)) return false
      if (conflictKeys.has(`${item.entityType}:${item.entityId}`)) return false
      if (!scope) return true
      return outboxPageId(item) === scope.pageId
    })
    let failedItems = 0
    let uploadFailure: unknown
    if (pending.length) {
      const entries: Array<{ ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> }> = []
      const objects: Array<{ hash: string; data: Uint8Array }> = []
      // One unreadable item (a missing attachment, a corrupt body) must not
      // hold back everything else. Failed items stay queued; later changes to
      // the same entity wait behind them so versions are never published out
      // of order. The first failure is reported after the rest has uploaded.
      const prepared: typeof pending = []
      const blockedKeys = new Set<string>()
      for (const item of pending) {
        throwIfAborted(syncSignal)
        const itemKey = `${item.entityType}:${item.entityId}`
        if (blockedKeys.has(itemKey)) continue
        const objectStart = objects.length
        try {
          const entry: { ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> } = {
            ts: new Date().toISOString(),
            op: item.operation,
            type: item.entityType,
            id: item.entityId,
            ver: item.expectedVersion,
            payload: item.operation === 'upsert' ? serializeWebdavPayload(item.entityType, item.payload) : item.payload,
          }
          const privateItem = privacy[outgoing.indexOf(item)] === true
          if (!privateItem && ['document', 'revision'].includes(item.entityType) && item.operation === 'upsert') {
            const external = externalizeDocument(entry.payload, objects)
            entry.payload = external.payload
            entry.hash = external.hash
          }
          if (item.entityType === 'asset' && item.operation === 'upsert') {
            const content = await repository.getAssetContent(item.entityId)
            if (!content) throw new Error(`附件 ${item.entityId} 缺少本地内容，已阻止不完整同步`)
            const bytes = new Uint8Array(await content.arrayBuffer())
            const data = privateItem ? encoder.encode(JSON.stringify(await cipher.encrypt(`asset-bytes:${item.entityId}`, bytes))) : bytes
            const hash = await sha256Bytes(data)
            objects.push({ hash, data })
            entry.hash = hash
            entry.payload = { ...entry.payload, objectHash: hash, checksum: await sha256Bytes(bytes), byteSize: bytes.byteLength }
          }
          if (privateItem) {
            entry.payload = await cipher.encryptPayload(item.entityType, item.entityId, entry.payload, item.operation, item.expectedVersion)
            // Whole encrypted envelopes may be externalized, never plaintext.
            const encrypted = externalizeDocument(entry.payload, objects)
            entry.payload = encrypted.payload
            // Asset bytes use their own encrypted object; its reference is in
            // the encrypted metadata. Keep hash available for upload batching.
            if (encrypted.hash) {
              if (entry.hash) entry.payload = { ...entry.payload, $assetObject: entry.hash }
              entry.hash = encrypted.hash
            }
          }
          entries.push(entry)
          prepared.push(item)
        } catch (error) {
          throwIfAborted(syncSignal)
          objects.length = objectStart
          blockedKeys.add(itemKey)
          uploadFailure ??= error
          recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'prepare-item', status: 'failed', message: `${itemKey} 暂无法上传：${error instanceof Error ? error.message : String(error)}`.slice(0, 300) })
        }
      }
      failedItems = pending.length - prepared.length
      // Each IPC push shares one deadline. Bound object requests AND bytes,
      // but combine small metadata records to avoid rewriting the whole v4
      // journal once per 25 tags/steps. A single oversized item stands alone.
      for (const { offset, batch, batchObjects, objectBytes, journalBytes } of uploadBatches(entries, objects)) {
        throwIfAborted(syncSignal)
        onProgress?.(`正在上传本机内容 ${offset + 1}–${offset + batch.length} / ${entries.length}`)
        const pushed = await transport.push(connection, deviceId, batch, batchObjects, syncSignal, (await loadSeqs(repository, settings))[deviceId] ?? 0)
        throwIfAborted(syncSignal)
        assertUploadConfirmation(pushed, batch.length)
        const acknowledged = prepared.slice(offset, offset + batch.length).map((item) => ({
          operation_id: item.id,
          entity_type: item.entityType,
          entity_id: item.entityId,
          version: item.expectedVersion + 1,
        }))
        if (connection.syncPassword) await repository.acknowledgeSync(workspaceId, acknowledged, undefined, true, true)
        else await repository.acknowledgeSync(workspaceId, acknowledged, undefined, true)
        const nextSeqs = await loadSeqs(repository, settings)
        nextSeqs[deviceId] = Math.max(nextSeqs[deviceId] ?? 0, pushed.firstSeq + pushed.count - 1)
        await saveSeqs(repository, settings, nextSeqs)
        recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'upload-batch', status: 'success', message: `已上传 ${offset + batch.length} / ${entries.length} 条；${batchObjects.length} 个对象，${objectBytes} 字节；新增日志 ${journalBytes} 字节` })
      }

      if (entries.length) {
        // ---- Pull 2: anything another device published while we were pushing
        // comes back immediately, instead of waiting for the next trigger.
        const secondPull = await pullWebdavOnce(repository, workspaceId, settings, connection, transport, syncSignal, false, onProgress)
        conflicts += secondPull.conflicts
        resolved.push(...secondPull.resolved)
        for (const key of secondPull.conflictKeys) conflictKeys.add(key)
      }
    }

    // Keep local-only acknowledgements until every network operation has
    // settled. A cancelled/timed-out sync must not acknowledge any outbox
    // rows, even rows that are intentionally excluded from remote publication.
    throwIfAborted(syncSignal)
    if (localOnly.length) await repository.acknowledgeLocalOnlySync(localOnly)
    if (repository.db) recordDiagnosticEvent({
      level: 'info', category: 'sync', action: 'outbox', status: 'success',
      message: `本批上传 ${pending.length - failedItems} 条；剩余待上传 ${await repository.db.syncOutbox.where('workspaceId').equals(workspaceId).count()} 条`,
    })
    if (failedItems) throw uploadFailure
    return { state: conflicts ? 'conflict' : 'synced', skipped: 0, conflicts, ...extras() }
  })
}

/**
 * One-time migration: merge the legacy SSH repository into the local store,
 * then publish the full local state as a v4 snapshot to WebDAV.
 */
export async function migrateSshToWebdav(repository: DexieNotebookRepository, workspaceId: string): Promise<{ published: number }> {
  return withDeadline('SSH 到 WebDAV 迁移', undefined, SSH_MIGRATION_TIMEOUT_MS, async (signal) => {
    const settings = loadWebdavSettings()
    const appPassword = await getWebdavAppPassword()
    if (!settings.baseUrl || !settings.username || !appPassword) throw new Error('请先完整填写并保存坚果云 WebDAV 设置')
    if (!window.notebookDesktop) throw new Error('从 SSH 迁移仅在 Electron 桌面版中提供')
    const connection = connectionFor(settings, appPassword, (await getWebdavSyncPassword()) ?? undefined)
    const deviceId = legacyDeviceId()
    const transport = boundedTransport(webdavTransport(), signal)
    throwIfAborted(signal)

    // 1. Merge the latest SSH state into the local store first, so the snapshot
    // below includes every note that lives on the SSH server. Errors propagate
    // as exceptions and abort the migration.
    const source = await synchronizeLegacySsh(repository, workspaceId, true)
    throwIfAborted(signal)
    if (source.state === 'offline') throw new Error('请先完整填写并保存旧 SSH/SFTP 设置，迁移尚未开始')
    if (source.state === 'conflict') throw new Error('旧 SSH/SFTP 内容存在冲突，请先解决后再迁移')

    // Capture the bundle, pending operation ids and parent versions together.
    // An edit made during upload must survive acknowledgement of this snapshot.
    const captureSnapshot = async () => {
      const pending = await repository.listOutbox(workspaceId, 0xffff_ffff)
      const snapshot = buildWebdavSnapshot(await repository.exportData(workspaceId), deviceId)
      const versions = repository.db ? await repository.db.syncVersions.bulkGet(snapshot.map(item => `${workspaceId}:${item.type}:${item.id}`)) : []
      snapshot.forEach((item, index) => { item.ver += versions[index]?.version ?? 0 })
      return { snapshot, pending }
    }
    const { snapshot, pending } = repository.db
      ? await repository.db.transaction('r', repository.db.tables, captureSnapshot)
      : await captureSnapshot()
    const pendingByEntity = new Map(pending.map(item => [`${item.entityType}:${item.entityId}`, item]))
    const lastByEntity = new Map(snapshot.map(item => [`${item.type}:${item.id}`, item]))

    // 2. Prepare every content object before publishing any journal entries.
    const entries: Array<{ ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> }> = []
    const objects: Array<{ hash: string; data: Uint8Array }> = []
    for (const item of snapshot) {
      throwIfAborted(signal)
      if (item.type === 'asset' && item.op === 'upsert') {
        const content = await repository.getAssetContent(item.id)
        if (!content) throw new Error(`附件 ${item.id} 缺少本地内容，已阻止不完整迁移`)
        const bytes = new Uint8Array(await content.arrayBuffer())
        const hash = await sha256Bytes(bytes)
        objects.push({ hash, data: bytes })
        item.payload = { ...item.payload, objectHash: hash, byteSize: bytes.byteLength }
        entries.push({ ts: new Date().toISOString(), ...item, hash })
        continue
      }
      if (item.type === 'document' && item.op === 'upsert') {
        const external = externalizeDocument(item.payload, objects)
        entries.push({ ts: new Date().toISOString(), ...item, payload: external.payload, hash: external.hash })
        continue
      }
      entries.push({ ts: new Date().toISOString(), ...item })
    }

    // 3. Persist each confirmed baseline before skipping our own journal. This
    // also makes partial retries and the first post-migration edit successors
    // of the published snapshot, instead of competing version-zero branches.
    for (const { offset, batch, batchObjects } of uploadBatches(entries, objects)) {
      throwIfAborted(signal)
      const pushed = await transport.push(connection, deviceId, batch, batchObjects, signal, (await loadSeqs(repository, settings))[deviceId] ?? 0)
      throwIfAborted(signal)
      assertUploadConfirmation(pushed, batch.length)
      await repository.acknowledgeSync(workspaceId, snapshot.slice(offset, offset + batch.length).map(item => ({
        operation_id: lastByEntity.get(`${item.type}:${item.id}`) === item
          ? pendingByEntity.get(`${item.type}:${item.id}`)?.id ?? crypto.randomUUID()
          : crypto.randomUUID(),
        entity_type: item.type,
        entity_id: item.id,
        version: item.ver + 1,
      })), undefined, true)
      throwIfAborted(signal)
      const knownSeqs = await loadSeqs(repository, settings)
      knownSeqs[deviceId] = Math.max(knownSeqs[deviceId] ?? 0, pushed.firstSeq + pushed.count - 1)
      await saveSeqs(repository, settings, knownSeqs)
    }
    return { published: entries.length }
  })
}
