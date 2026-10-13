import { createClient, type WebDAVClient, type WebDAVClientOptions } from 'webdav'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

/**
 * WebDAV transport for the v4 append-only journal repository (e.g. 坚果云).
 *
 * Repository layout under remotePath:
 *   journal/<deviceID>.jsonl   per-device append-only change log
 *   objects/<xx>/<sha256>      content-addressed note/attachment bytes
 *
 * Each device only ever writes its own journal file (single writer), so the
 * read-modify-write append below is race-free across devices.
 */

export interface WebdavConnection {
  /** WebDAV base URL, e.g. https://dav.jianguoyun.com/dav/ */
  baseUrl: string
  username: string
  /** WebDAV application password (not the account password). */
  appPassword: string
  /** Repository path relative to the WebDAV root, e.g. notebook_backup. */
  remotePath: string
  /** Optional secret used only for private-note encryption (not auth). */
  syncPassword?: string
}

export interface WebdavJournalEntry {
  seq: number
  ts: string
  op: 'upsert' | 'delete'
  type: string
  id: string
  ver: number
  /** Content hash referencing objects/<xx>/<hash> when the payload is large. */
  hash?: string
  payload: Record<string, unknown>
}

export interface WebdavPullResult {
  /** New entries per device (seq > knownSeqs[deviceId]), ordered by seq. */
  entries: Array<WebdavJournalEntry & { deviceId: string }>
  fingerprint: string
  /** Every device that currently has a journal in the repository. */
  devices?: string[]
  /**
   * Devices whose remote sequence went backwards (journal deleted/recreated).
   * Their entries were re-read from the start; the caller must reset cursors.
   */
  resetDevices?: string[]
  /** Recoverable repository anomalies worth recording in diagnostics. */
  warnings?: string[]
}

export interface WebdavTestResult {
  ok: boolean
  remotePathExists: boolean
  latencyMs: number
  message: string
}

// Compact early to keep normal traffic small, but do not make 4 MB a hard
// outage: revision entities have unique ids and may legitimately survive
// state compaction until the segmented v5 protocol is deployed.
const MAX_LOG_BYTES = 100 * 1024 * 1024
const MAX_OBJECT_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 100_000
const MAX_HEAD_BYTES = 64 * 1024
const MAX_REVISION_ENTRIES = MAX_ENTRIES
const MAX_REVISION_BYTES = MAX_LOG_BYTES
const DEVICE_ID_PATTERN = /^[0-9a-f-]{36}$/i

const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const isNonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
/** Bounded, short-lived caches; credentials are part of the opaque namespace. */
class SyncCache<T> {
  private values = new Map<string, { value: T; expires: number }>()
  constructor(private limit: number) {}
  get(key: string): T | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    this.values.delete(key)
    if (entry.expires <= Date.now()) return undefined
    this.values.set(key, entry)
    return entry.value
  }
  set(key: string, value: T) {
    this.values.delete(key)
    this.values.set(key, { value, expires: Date.now() + 5 * 60_000 })
    if (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!)
  }
  invalidate(prefix: string) {
    for (const key of this.values.keys()) if (key.startsWith(prefix)) this.values.delete(key)
  }
}
const objectPresenceCache = new SyncCache<boolean>(4096)
const directoryCache = new SyncCache<boolean>(1024)
const headCache = new SyncCache<{ etag: string; head: WebdavJournalHead }>(256)

interface WebdavJournalHead {
  version: 1
  deviceId: string
  lastSeq: number
  journalBytes: number
  journalSha256: string
  updatedAt: string
  stateEntries: number
  historyEntries: number
}

function safeRemotePath(value: string): string {
  const normalized = posix.normalize(value.trim().replaceAll('\\', '/')).replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    throw new Error(`远端同步目录不安全：${value}`)
  }
  return normalized
}

export function validatedWebdavBaseUrl(value: string): URL {
  let base: URL
  try {
    base = new URL(value.trim())
  } catch {
    throw new Error('WebDAV 服务器地址不正确')
  }
  if (base.protocol === 'https:') return base
  // HTTP is only useful for a local development/test endpoint. Requiring TLS
  // everywhere else prevents the app password and journal from crossing a
  // network in clear text.
  const hostname = base.hostname.toLowerCase()
  if (base.protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]')) return base
  throw new Error('WebDAV 服务器必须使用 HTTPS；仅 localhost 可使用 HTTP')
}

function clientFor(settings: WebdavConnection): WebDAVClient {
  const baseUrl = validatedWebdavBaseUrl(settings.baseUrl)
  if (!settings.username.trim()) throw new Error('请填写 WebDAV 用户名')
  if (!settings.appPassword) throw new Error('请填写 WebDAV 应用密码')
  safeRemotePath(settings.remotePath)
  const options: WebDAVClientOptions = {
    username: settings.username.trim(),
    password: settings.appPassword,
    maxBodyLength: MAX_OBJECT_BYTES + MAX_LOG_BYTES,
  }
  return createClient(baseUrl.toString().replace(/\/+$/, ''), options)
}

const journalPath = (root: string, deviceId: string) => `${root}/journal/${deviceId}.jsonl`
const journalHeadPath = (root: string, deviceId: string) => `${root}/journal/${deviceId}.head.json`
const objectPath = (root: string, hash: string) => `${root}/objects/${hash.slice(0, 2)}/${hash}`
const cacheNamespace = (settings: WebdavConnection) => `${sha256(JSON.stringify([settings.baseUrl.trim(), settings.username.trim(), settings.appPassword, safeRemotePath(settings.remotePath)]))}:`
// webdav normalizes PROPFIND ETags by removing quotes. Weak validators must
// never authorize reuse of a commit marker whose content may have changed.
const strongEtag = (value: string | null | undefined) => value && !/^W\//i.test(value) ? value.replaceAll('"', '') : undefined

async function ensureDirectory(client: WebDAVClient, path: string, signal?: AbortSignal, namespace = '') {
  // 坚果云 rejects nested MKCOL with 409 when the parent is missing, so every
  // segment is created from the root down. 201 (idempotent create) and the
  // usual already-exists codes are both tolerated.
  let current = ''
  for (const segment of path.split('/')) {
    current = current ? `${current}/${segment}` : segment
    if (signal?.aborted) throw signal.reason ?? new DOMException('WebDAV 操作已取消', 'AbortError')
    if (namespace && directoryCache.get(namespace + current)) continue
    try {
      await client.createDirectory(current, { signal })
    } catch (error) {
      // 409 is a missing parent, not evidence that this directory exists.
      const status = (error as { status?: number })?.status
      if (status !== 405 && status !== 301 && status !== 302) throw error
    }
    if (namespace) directoryCache.set(namespace + current, true)
  }
}

async function putWithDirectory(client: WebDAVClient, settings: WebdavConnection, path: string, data: string | Buffer, signal?: AbortSignal) {
  const namespace = cacheNamespace(settings)
  try {
    await ensureDirectory(client, posix.dirname(path), signal, namespace)
    await client.putFileContents(path, data, { overwrite: true, signal })
  } catch (error) {
    const status = (error as { status?: number })?.status
    if (status !== 404 && status !== 409) throw error
    // A directory removed on another device invalidates cached provisioning.
    directoryCache.invalidate(namespace)
    objectPresenceCache.invalidate(namespace)
    await ensureDirectory(client, posix.dirname(path), signal, namespace)
    await client.putFileContents(path, data, { overwrite: true, signal })
  }
}

/** Parse a journal file body into entries, tolerating a trailing newline. */
function parseJournal(text: string): WebdavJournalEntry[] {
  const entries: WebdavJournalEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    entries.push(JSON.parse(trimmed) as WebdavJournalEntry)
  }
  return entries
}

/**
 * Keep only the latest record per entity, preserving original seq values.
 * Seq numbers stay monotonic, so other devices' per-device read cursors
 * remain valid after the file shrinks.
 */
function compactJournal(entries: WebdavJournalEntry[]): { entries: WebdavJournalEntry[]; stateEntries: number; historyEntries: number } {
  const state = new Map<string, WebdavJournalEntry>()
  const revisions = new Map<string, WebdavJournalEntry>()
  for (const entry of entries) {
    const target = entry.type === 'revision' ? revisions : state
    const key = `${entry.type}:${entry.id}`
    const previous = target.get(key)
    if (!previous || entry.seq > previous.seq) target.set(key, entry)
  }
  const newestRevisions = [...revisions.values()].sort((left, right) => right.seq - left.seq)
  const history: WebdavJournalEntry[] = []
  let historyBytes = 0
  for (const entry of newestRevisions) {
    if (history.length >= MAX_REVISION_ENTRIES) break
    const serializedBytes = utf8Bytes(JSON.stringify(entry)) + 1
    if (history.length > 0 && historyBytes + serializedBytes > MAX_REVISION_BYTES) break
    history.push(entry)
    historyBytes += serializedBytes
  }
  return {
    entries: [...state.values(), ...history].sort((left, right) => left.seq - right.seq),
    stateEntries: state.size,
    historyEntries: history.length,
  }
}

function buildHead(deviceId: string, body: string, entries: WebdavJournalEntry[], stateEntries: number, historyEntries: number): WebdavJournalHead {
  return {
    version: 1,
    deviceId,
    lastSeq: entries.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0),
    journalBytes: utf8Bytes(body),
    journalSha256: sha256(body),
    updatedAt: new Date().toISOString(),
    stateEntries,
    historyEntries,
  }
}

function parseHead(text: string, deviceId: string): WebdavJournalHead {
  if (utf8Bytes(text) > MAX_HEAD_BYTES) throw new Error(`远端日志 ${deviceId}.head.json 超过 64 KiB 上限`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`远端日志 ${deviceId}.head.json 格式不正确`)
  }
  const head = value as Partial<WebdavJournalHead>
  if (
    head.version !== 1 || head.deviceId !== deviceId || !isNonNegativeInteger(head.lastSeq) ||
    !isNonNegativeInteger(head.journalBytes) || head.journalBytes > MAX_LOG_BYTES ||
    typeof head.journalSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(head.journalSha256) ||
    typeof head.updatedAt !== 'string' || !isNonNegativeInteger(head.stateEntries) ||
    !isNonNegativeInteger(head.historyEntries)
  ) throw new Error(`远端日志 ${deviceId}.head.json 内容不正确`)
  return head as WebdavJournalHead
}

export async function testWebdavConnection(settings: WebdavConnection, signal?: AbortSignal): Promise<WebdavTestResult> {
  const startedAt = Date.now()
  if (signal?.aborted) throw signal.reason ?? new DOMException('WebDAV 操作已取消', 'AbortError')
  try {
    const client = clientFor(settings)
    const root = safeRemotePath(settings.remotePath)
    await ensureDirectory(client, root, signal, cacheNamespace(settings))
    const exists = await client.exists(`${root}/journal`, { signal })
    return { ok: true, remotePathExists: exists, latencyMs: Date.now() - startedAt, message: '' }
  } catch (error) {
    // An aborted probe is a control-flow outcome, not a failed connection
    // result. Let the IPC deadline wrapper convert it to a clear cancellation
    // or timeout error instead of returning a misleading `ok: false` value.
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, remotePathExists: false, latencyMs: Date.now() - startedAt, message }
  }
}

/**
 * Pull all journal entries newer than the per-device sequence numbers the
 * client already consumed. Journals are small (KB), so each file is fetched
 * in full and filtered locally.
 */
export async function pullWebdavJournals(settings: WebdavConnection, knownSeqs: Record<string, number> = {}, signal?: AbortSignal): Promise<WebdavPullResult> {
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  let deviceIds: string[] = []
  const devicesWithHeads = new Set<string>()
  const headEtags = new Map<string, string>()
  try {
    const contents = await client.getDirectoryContents(`${root}/journal`, { signal })
    const items = Array.isArray(contents) ? contents : []
    const names = items.map((item) => item.basename)
    deviceIds = names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .filter((deviceId) => DEVICE_ID_PATTERN.test(deviceId))
    for (const item of items) {
      const name = item.basename
      if (!name.endsWith('.head.json')) continue
      const deviceId = name.slice(0, -'.head.json'.length)
      if (DEVICE_ID_PATTERN.test(deviceId)) devicesWithHeads.add(deviceId)
      const etag = strongEtag(item.etag)
      if (etag) headEtags.set(deviceId, etag)
    }
  } catch (error) {
    // A missing journal directory means an empty repository. Authentication
    // and server failures must remain visible to the caller.
    const status = (error as { status?: number })?.status
    if (status !== 404) throw error
    directoryCache.invalidate(cacheNamespace(settings))
    objectPresenceCache.invalidate(cacheNamespace(settings))
    headCache.invalidate(cacheNamespace(settings))
  }
  const entries: Array<WebdavJournalEntry & { deviceId: string }> = []
  const resetDevices: string[] = []
  const warnings: string[] = []
  for (const deviceId of deviceIds) {
    let known = knownSeqs[deviceId] ?? 0
    let head: WebdavJournalHead | undefined
    if (devicesWithHeads.has(deviceId)) {
      try {
        const key = cacheNamespace(settings) + deviceId
        const etag = headEtags.get(deviceId)
        const cached = etag ? headCache.get(key) : undefined
        if (cached && cached.etag === etag) head = cached.head
        else {
          const response = await client.getFileContents(journalHeadPath(root, deviceId), { format: 'text', details: true, signal })
          if (typeof response !== 'object' || !('data' in response)) throw new Error('WebDAV 提交标记响应缺少详情')
          const data = response.data
          const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
          head = parseHead(text, deviceId)
          // Only bind the body to the listing validator if GET confirms it;
          // a concurrent writer may change the marker between these requests.
          if (etag && strongEtag(response.headers.etag) === etag) headCache.set(key, { etag, head })
        }
      } catch (error) {
        const status = (error as { status?: number })?.status
        if (status !== 404) throw error
      }
      // A commit marker behind our cursor means the journal was deleted and
      // recreated (manual cleanup, restored folder). Skipping it would hide
      // every new record until it overtook the stale cursor, so re-read it.
      if (head && head.lastSeq < known) {
        resetDevices.push(deviceId)
        warnings.push(`${deviceId} 的远端序号从 ${known} 回退到 ${head.lastSeq}，已重新读取`)
        known = 0
      }
      // The marker is the commit point: once its sequence is known, never
      // fetch the corresponding large journal merely to confirm that fact.
      if (head && known >= head.lastSeq) continue
    }
    let text = ''
    try {
      const data = await client.getFileContents(journalPath(root, deviceId), { format: 'text', signal })
      text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
    } catch (error) {
      const status = (error as { status?: number })?.status
      if (status === 404) continue
      throw error
    }
    // Long-lived devices may already exceed the legacy 4 MB failure limit;
    // 100 MB is only a recovery/abuse guard until v5 segments the log.
    if (utf8Bytes(text) > MAX_LOG_BYTES) throw new Error(`远端日志 ${deviceId}.jsonl 超过 100 MB 上限`)
    const journal = parseJournal(text)
    const journalLastSeq = journal.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0)
    if (!head && journalLastSeq < known) {
      resetDevices.push(deviceId)
      warnings.push(`${deviceId} 的远端日志序号从 ${known} 回退到 ${journalLastSeq}，已重新读取`)
      known = 0
    }
    if (head && (utf8Bytes(text) !== head.journalBytes || sha256(text) !== head.journalSha256)) {
      // The journal PUT succeeded but its marker PUT did not (or an old v4
      // writer appended without a marker). Every row is still a complete JSON
      // record, so only the committed sequence range is exposed. Blocking the
      // whole repository here would stall every device until the writer came
      // back online; its unacknowledged rows are republished by that writer.
      warnings.push(`${deviceId} 的日志与提交标记不一致（日志序号 ${journalLastSeq}，标记 ${head.lastSeq}），仅读取已提交部分`)
    }
    for (const entry of journal) {
      if (entry.seq <= known || (head && entry.seq > head.lastSeq)) continue
      entries.push({ ...entry, deviceId })
    }
  }
  entries.sort((left, right) => left.deviceId === right.deviceId ? left.seq - right.seq : left.deviceId.localeCompare(right.deviceId))
  return {
    entries,
    fingerprint: `${settings.baseUrl.trim()}|${settings.username.trim()}|${safeRemotePath(settings.remotePath)}`,
    devices: deviceIds,
    ...(resetDevices.length ? { resetDevices } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}

export async function getWebdavObject(settings: WebdavConnection, hash: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`对象哈希格式不正确：${hash}`)
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  const data = await client.getFileContents(objectPath(root, hash), { format: 'binary', signal })
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(Buffer.from(data as ArrayBuffer))
  if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error('远端对象超过 100 MB 上限')
  if (sha256(Buffer.from(bytes)) !== hash) throw new Error(`远端对象 ${hash} 的 SHA-256 校验失败`)
  return bytes
}

export async function putWebdavObject(settings: WebdavConnection, hash: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`对象哈希格式不正确：${hash}`)
  if (data.byteLength > MAX_OBJECT_BYTES) throw new Error('对象超过 100 MB 上限')
  if (sha256(Buffer.from(data)) !== hash) throw new Error('本地对象 SHA-256 校验失败')
  if (signal?.aborted) throw signal.reason ?? new DOMException('WebDAV 操作已取消', 'AbortError')
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  const target = objectPath(root, hash)
  const cacheKey = cacheNamespace(settings) + hash
  if (objectPresenceCache.get(cacheKey)) return
  if (await client.exists(target, { signal })) {
    objectPresenceCache.set(cacheKey, true)
    return
  }
  await putWithDirectory(client, settings, target, Buffer.from(data), signal)
  objectPresenceCache.set(cacheKey, true)
}

/**
 * Append entries to this device's journal. WebDAV has no append primitive, so
 * the current journal is fetched, the new lines are appended locally, and the
 * whole file is written back. This is safe because only one device ever
 * writes a given journal file.
 */
export async function appendWebdavJournal(settings: WebdavConnection, deviceId: string, entries: Array<Omit<WebdavJournalEntry, 'seq'>>, signal?: AbortSignal, minSeq = 0): Promise<{ firstSeq: number; count: number }> {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error(`设备 ID 不正确：${deviceId}`)
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  const path = journalPath(root, deviceId)
  let existing: WebdavJournalEntry[] = []
  try {
    const data = await client.getFileContents(path, { format: 'text', signal })
    const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
    if (utf8Bytes(text) > MAX_LOG_BYTES) throw new Error(`远端日志 ${deviceId}.jsonl 超过 100 MB 上限`)
    existing = text ? parseJournal(text) : []
  } catch (error) {
    const status = (error as { status?: number })?.status
    if (status !== 404) throw error
  }
  // Sequence numbers must never move backwards, even when the remote journal
  // was deleted: other devices filter by their last consumed sequence.
  const floor = Number.isSafeInteger(minSeq) && minSeq > 0 ? minSeq : 0
  const firstSeq = Math.max(existing.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0), floor) + 1
  const journalEntries = [...existing, ...entries.map((entry, index) => ({ ...entry, seq: firstSeq + index }))]
  // v4 journals remain readable by old clients. Electron always writes their
  // compact current-state/history-ring projection to make normal sync cheap.
  const compacted = compactJournal(journalEntries)
  if (compacted.entries.length > MAX_ENTRIES) throw new Error('设备日志条目数超过 10 万，请先压缩日志')
  const body = compacted.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  if (utf8Bytes(body) > MAX_LOG_BYTES) throw new Error('设备日志压缩后超过 100 MB 上限')
  await putWithDirectory(client, settings, path, body, signal)
  // Commit only after the journal bytes are durable. A failed marker PUT keeps
  // readers on the previous committed view rather than exposing this write.
  await client.putFileContents(journalHeadPath(root, deviceId), JSON.stringify(buildHead(deviceId, body, compacted.entries, compacted.stateEntries, compacted.historyEntries)), { overwrite: true, signal })
  return { firstSeq, count: entries.length }
}
