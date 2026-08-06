import { createClient, type WebDAVClient, type WebDAVClientOptions } from 'webdav'
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
}

export interface WebdavTestResult {
  ok: boolean
  remotePathExists: boolean
  latencyMs: number
  message: string
}

const MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_OBJECT_BYTES = 100 * 1024 * 1024

function safeRemotePath(value: string): string {
  const normalized = posix.normalize(value.trim().replaceAll('\\', '/')).replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    throw new Error(`远端同步目录不安全：${value}`)
  }
  return normalized
}

function clientFor(settings: WebdavConnection): WebDAVClient {
  if (!settings.baseUrl.trim() || !/^https?:\/\//.test(settings.baseUrl.trim())) throw new Error('WebDAV 服务器地址不正确')
  if (!settings.username.trim()) throw new Error('请填写 WebDAV 用户名')
  if (!settings.appPassword) throw new Error('请填写 WebDAV 应用密码')
  safeRemotePath(settings.remotePath)
  const options: WebDAVClientOptions = {
    username: settings.username.trim(),
    password: settings.appPassword,
    maxBodyLength: MAX_OBJECT_BYTES + MAX_LOG_BYTES,
  }
  return createClient(settings.baseUrl.trim().replace(/\/+$/, ''), options)
}

const journalPath = (root: string, deviceId: string) => `${root}/journal/${deviceId}.jsonl`
const objectPath = (root: string, hash: string) => `${root}/objects/${hash.slice(0, 2)}/${hash}`

async function ensureDirectory(client: WebDAVClient, path: string) {
  // 坚果云 rejects nested MKCOL with 409 when the parent is missing, so every
  // segment is created from the root down. 201 (idempotent create) and the
  // usual already-exists codes are both tolerated.
  let current = ''
  for (const segment of path.split('/')) {
    current = current ? `${current}/${segment}` : segment
    try {
      await client.createDirectory(current)
    } catch (error) {
      // 405/409/301/302 mean the directory already exists; anything else rethrows.
      const status = (error as { status?: number })?.status
      if (status !== 405 && status !== 409 && status !== 301 && status !== 302) throw error
    }
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

export async function testWebdavConnection(settings: WebdavConnection): Promise<WebdavTestResult> {
  const startedAt = Date.now()
  try {
    const client = clientFor(settings)
    const root = safeRemotePath(settings.remotePath)
    await ensureDirectory(client, root)
    const exists = await client.exists(`${root}/journal`)
    return { ok: true, remotePathExists: exists, latencyMs: Date.now() - startedAt, message: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, remotePathExists: false, latencyMs: Date.now() - startedAt, message }
  }
}

/**
 * Pull all journal entries newer than the per-device sequence numbers the
 * client already consumed. Journals are small (KB), so each file is fetched
 * in full and filtered locally.
 */
export async function pullWebdavJournals(settings: WebdavConnection, knownSeqs: Record<string, number> = {}): Promise<WebdavPullResult> {
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  await ensureDirectory(client, `${root}/journal`)
  let deviceIds: string[] = []
  try {
    const contents = await client.getDirectoryContents(`${root}/journal`)
    deviceIds = (Array.isArray(contents) ? contents : []).map((item) => item.basename).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length))
  } catch {
    // journal/ does not exist yet: an empty repository.
  }
  const entries: Array<WebdavJournalEntry & { deviceId: string }> = []
  for (const deviceId of deviceIds) {
    let text = ''
    try {
      const data = await client.getFileContents(journalPath(root, deviceId), { format: 'text' })
      text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
    } catch (error) {
      const status = (error as { status?: number })?.status
      if (status === 404) continue
      throw error
    }
    if (text.length > MAX_LOG_BYTES) throw new Error(`远端日志 ${deviceId}.jsonl 超过 4 MB 上限`)
    const known = knownSeqs[deviceId] ?? 0
    for (const entry of parseJournal(text)) {
      if (entry.seq <= known) continue
      entries.push({ ...entry, deviceId })
    }
  }
  entries.sort((left, right) => left.deviceId === right.deviceId ? left.seq - right.seq : left.deviceId.localeCompare(right.deviceId))
  return { entries, fingerprint: `${settings.baseUrl.trim()}|${settings.username.trim()}|${safeRemotePath(settings.remotePath)}` }
}

export async function getWebdavObject(settings: WebdavConnection, hash: string): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`对象哈希格式不正确：${hash}`)
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  const data = await client.getFileContents(objectPath(root, hash), { format: 'binary' })
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(Buffer.from(data as ArrayBuffer))
  if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error('远端对象超过 100 MB 上限')
  return bytes
}

export async function putWebdavObject(settings: WebdavConnection, hash: string, data: Uint8Array): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`对象哈希格式不正确：${hash}`)
  if (data.byteLength > MAX_OBJECT_BYTES) throw new Error('对象超过 100 MB 上限')
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  const target = objectPath(root, hash)
  await ensureDirectory(client, `${root}/objects/${hash.slice(0, 2)}`)
  await client.putFileContents(target, Buffer.from(data), { overwrite: true })
}

/**
 * Append entries to this device's journal. WebDAV has no append primitive, so
 * the current journal is fetched, the new lines are appended locally, and the
 * whole file is written back. This is safe because only one device ever
 * writes a given journal file.
 */
export async function appendWebdavJournal(settings: WebdavConnection, deviceId: string, entries: Array<Omit<WebdavJournalEntry, 'seq'>>): Promise<{ firstSeq: number; count: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw new Error(`设备 ID 不正确：${deviceId}`)
  const client = clientFor(settings)
  const root = safeRemotePath(settings.remotePath)
  const path = journalPath(root, deviceId)
  await ensureDirectory(client, `${root}/journal`)
  let existing: WebdavJournalEntry[] = []
  try {
    const data = await client.getFileContents(path, { format: 'text' })
    const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
    existing = text ? parseJournal(text) : []
  } catch (error) {
    const status = (error as { status?: number })?.status
    if (status !== 404) throw error
  }
  if (existing.length + entries.length > 100_000) throw new Error('设备日志条目数超过 10 万，请先压缩日志')
  const firstSeq = existing.length ? existing[existing.length - 1]!.seq + 1 : 1
  const lines = entries.map((entry, index) => JSON.stringify({ ...entry, seq: firstSeq + index }))
  const body = [...existing.map((entry) => JSON.stringify(entry)), ...lines].join('\n') + '\n'
  if (body.length > MAX_LOG_BYTES) throw new Error('设备日志超过 4 MB 上限')
  await client.putFileContents(path, body, { overwrite: true })
  return { firstSeq, count: entries.length }
}
