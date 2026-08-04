import SftpClient from 'ssh2-sftp-client'
import { Client } from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

export interface LegacySshConnection {
  host: string
  port: number
  username: string
  password: string
  remotePath: string
  fingerprint?: string
}

export interface LegacySftpFile { name: string; data: Uint8Array }
export interface LegacySftpPullOptions {
  knownObjectHashes?: string[]
  knownNoteSignatures?: Array<{ noteID: string; signature: string }>
  /** Skip note bodies and objects; only repository metadata is returned. */
  metadataOnly?: boolean
  /** Reuse the SSH connection opened by a previous pull/push. */
  sessionId?: string
}
export interface LegacySftpPushOptions {
  knownObjectHashes?: string[]
  sessionId?: string
}
export interface LegacySftpPullResult {
  files: LegacySftpFile[]
  indexHash: string
  fingerprint: string
  objectHashes: string[]
  reusedObjectCount: number
  reusedNoteIds: string[]
  sessionId: string
}

export interface LegacySftpConnectionResult {
  fingerprint: string
  remotePath: string
  remotePathExists: boolean
  latencyMs: number
}

export interface LegacySftpHelperResult {
  ok: boolean
  /** Binary payload for export-tar; undefined for the other operations. */
  data?: Uint8Array
  /** Human-readable result, e.g. verify errors or gc removed count. */
  message: string
}

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_REPOSITORY_BYTES = 512 * 1024 * 1024
const MAX_HELPER_STDERR_BYTES = 16 * 1024 * 1024
const LOCK_RETRIES = 30
const LOCK_STALE_MS = 30 * 60 * 1000
const LOCK_HEARTBEAT_MS = 60 * 1000
const TRANSFER_CONCURRENCY = 4
const SESSION_IDLE_MS = 60 * 1000
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string | undefined): value is string => Boolean(value && uuidPattern.test(value))
const COMPRESSED_REPOSITORY_VERSION = 2
const compressedRepositoryFormat = Object.freeze({
  version: COMPRESSED_REPOSITORY_VERSION,
  noteEncoding: 'gzip',
  notePathPattern: 'notes/{noteID}.json.gz',
  jsonEncoding: 'utf-8',
  historyEncoding: 'full-snapshot-deduplicated',
})
const pulledNoteCache = new Map<string, { signature: string; data: Buffer }>()
const pulledObjectCache = new Map<string, { contentHash: string; data: Buffer }>()
const MAX_NOTE_CACHE_BYTES = 128 * 1024 * 1024
const MAX_OBJECT_CACHE_BYTES = 64 * 1024 * 1024

interface SftpSession {
  id: string
  client: SftpClient
  root: string
  fingerprint: string
  key: string
  /** Settings identity used to validate a renderer-provided session id. */
  settingsKey: string
  lastUsed: number
  timer?: NodeJS.Timeout
}
const sessions = new Map<string, SftpSession>()
let sessionCounter = 0

function cacheBuffer<T extends { data: Buffer }>(cache: Map<string, T>, key: string, value: T, maximumBytes: number) {
  cache.delete(key)
  cache.set(key, value)
  let total = 0
  for (const item of cache.values()) total += item.data.byteLength
  while (total > maximumBytes && cache.size > 1) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    total -= cache.get(oldestKey)!.data.byteLength
    cache.delete(oldestKey)
  }
}

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function validateConnection(value: LegacySshConnection) {
  if (!value.host.trim() || /[\s/]/.test(value.host)) throw new Error('SSH 服务器地址不正确')
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('SSH 端口必须在 1–65535 之间')
  if (!value.username.trim() || /[\r\n]/.test(value.username)) throw new Error('SSH 用户名不正确')
  if (!value.password) throw new Error('请填写 SSH 密码')
  if (!value.remotePath.trim() || value.remotePath.includes('\0')) throw new Error('请填写远端同步目录')
}

function safeRelativePath(value: string) {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) throw new Error(`远端仓库包含不安全路径：${value}`)
  return normalized
}

function isAllowedRepositoryFile(value: string) {
  const name = safeRelativePath(value)
  if (['library.json', 'notes/index.json', 'notes/reading_positions.json', 'notes/assets_manifest.json', 'notes/privacy.json'].includes(name)) return true
  if (/^notes\/[0-9a-f-]{36}\.json$/i.test(name)) return uuidPattern.test(name.slice('notes/'.length, -'.json'.length))
  if (/^objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/i.test(name)) return true
  return name.startsWith('attachments/') && name.length > 'attachments/'.length
}

function usesCompressedNotes(index: Buffer | undefined) {
  if (!index) return false
  try {
    const parsed = JSON.parse(index.toString('utf8')) as { repositoryFormat?: { version?: number; noteEncoding?: string } }
    return (parsed.repositoryFormat?.version === COMPRESSED_REPOSITORY_VERSION || parsed.repositoryFormat?.version === 3) && parsed.repositoryFormat.noteEncoding === 'gzip'
  } catch {
    return false
  }
}

export function normalizeRepositoryIndex(value: Buffer): Buffer {
  const parsed = JSON.parse(value.toString('utf8')) as {
    entries?: Array<{ noteID?: string; version?: number; [key: string]: unknown }>
    deletedEntries?: Array<{ noteID?: string; deletedAt?: string | number; [key: string]: unknown }>
    [key: string]: unknown
  }
  const stableEntrySignature = (entry: Record<string, unknown>) => JSON.stringify(
    Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))),
  )
  const entries = new Map<string, NonNullable<typeof parsed.entries>[number]>()
  for (const entry of parsed.entries ?? []) {
    if (!isUuid(entry.noteID)) continue
    const current = entries.get(entry.noteID)
    const version = Number.isFinite(entry.version) ? Number(entry.version) : 0
    const currentVersion = Number.isFinite(current?.version) ? Number(current?.version) : 0
    if (!current || version > currentVersion || (version === currentVersion && stableEntrySignature(entry) > stableEntrySignature(current))) entries.set(entry.noteID, entry)
  }
  const deletedEntries = new Map<string, NonNullable<typeof parsed.deletedEntries>[number]>()
  for (const entry of parsed.deletedEntries ?? []) {
    if (!isUuid(entry.noteID)) continue
    const current = deletedEntries.get(entry.noteID)
    const deletedAt = typeof entry.deletedAt === 'number' ? entry.deletedAt : Date.parse(String(entry.deletedAt ?? ''))
    const currentDeletedAt = typeof current?.deletedAt === 'number' ? current.deletedAt : Date.parse(String(current?.deletedAt ?? ''))
    if (!current || (Number.isFinite(deletedAt) ? deletedAt : 0) >= (Number.isFinite(currentDeletedAt) ? currentDeletedAt : 0)) deletedEntries.set(entry.noteID, entry)
  }
  return Buffer.from(JSON.stringify({
    ...parsed,
    entries: [...entries.values()].sort((left, right) => left.noteID!.localeCompare(right.noteID!)),
    deletedEntries: [...deletedEntries.values()].sort((left, right) => left.noteID!.localeCompare(right.noteID!)),
  }))
}

function compactJson(value: Buffer) {
  return Buffer.from(JSON.stringify(JSON.parse(value.toString('utf8'))))
}

function compressedNotePath(noteId: string) {
  return `notes/${noteId}.json.gz`
}

function encodeCompressedIndex(value: Buffer) {
  const parsed = JSON.parse(value.toString('utf8')) as Record<string, unknown>
  const format = parsed.repositoryFormat as { version?: number; noteEncoding?: string } | undefined
  if (format?.version !== 3 || format.noteEncoding !== 'gzip') parsed.repositoryFormat = compressedRepositoryFormat
  return Buffer.from(JSON.stringify(parsed))
}

function decodeCompressedNote(value: Buffer, name: string) {
  try {
    return compactJson(gunzipSync(value, { maxOutputLength: MAX_FILE_BYTES }))
  } catch (error) {
    throw new Error(`无法解压远端笔记：${name}`, { cause: error })
  }
}

async function connect(settings: LegacySshConnection) {
  validateConnection(settings)
  const client = new SftpClient('Notebook legacy sync')
  let presented = ''
  const expected = settings.fingerprint?.trim() ?? ''
  try {
    await client.connect({
      host: settings.host.trim(), port: settings.port, username: settings.username.trim(), password: settings.password,
      readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer | string) => {
        presented = fingerprint(Buffer.isBuffer(key) ? key : Buffer.from(key))
        return !expected || presented === expected
      },
    })
  } catch (error) {
    await client.end().catch(() => undefined)
    if (expected && presented && presented !== expected) throw new Error(`SSH 主机指纹已变化|${expected}|${presented}`, { cause: error })
    throw error
  }
  if (!presented) { await client.end(); throw new Error('服务器没有提供可校验的 SSH 主机密钥') }
  const home = await client.cwd()
  const configured = settings.remotePath.trim()
  const root = configured === '~' ? home : configured.startsWith('~/') ? posix.join(home, configured.slice(2)) : configured.startsWith('/') ? posix.normalize(configured) : posix.join(home, configured)
  return { client, root, fingerprint: presented }
}

function settingsSessionKey(settings: LegacySshConnection) {
  return `${settings.host.trim()}:${settings.port}:${settings.username.trim()}:${settings.remotePath.trim()}`
}

function canReuseSession(session: SftpSession, settings: LegacySshConnection) {
  const expectedFingerprint = settings.fingerprint?.trim()
  return session.settingsKey === settingsSessionKey(settings) && (!expectedFingerprint || session.fingerprint === expectedFingerprint)
}

/**
 * SFTP sessions keep the SSH connection alive between the pull and push phases
 * of one sync, avoiding a second handshake per synchronization. Sessions are
 * released explicitly by the renderer or expire after an idle period.
 */
async function sessionFor(settings: LegacySshConnection, sessionId?: string): Promise<SftpSession> {
  if (sessionId) {
    const existing = sessions.get(sessionId)
    if (existing && canReuseSession(existing, settings)) {
      existing.lastUsed = Date.now()
      scheduleSessionCleanup(existing)
      return existing
    }
  }
  const connected = await connect(settings)
  const key = `${settings.host.trim()}:${settings.port}:${settings.username.trim()}:${connected.root}`
  const existing = [...sessions.values()].find((session) => session.key === key && canReuseSession(session, settings))
  if (existing) {
    await connected.client.end().catch(() => undefined)
    existing.lastUsed = Date.now()
    scheduleSessionCleanup(existing)
    return existing
  }
  const session: SftpSession = { id: `s${++sessionCounter}`, client: connected.client, root: connected.root, fingerprint: connected.fingerprint, key, settingsKey: settingsSessionKey(settings), lastUsed: Date.now() }
  sessions.set(session.id, session)
  scheduleSessionCleanup(session)
  return session
}

function scheduleSessionCleanup(session: SftpSession) {
  if (session.timer) clearTimeout(session.timer)
  session.timer = setTimeout(() => {
    if (Date.now() - session.lastUsed >= SESSION_IDLE_MS) {
      sessions.delete(session.id)
      void session.client.end().catch(() => undefined)
    } else {
      scheduleSessionCleanup(session)
    }
  }, SESSION_IDLE_MS)
  session.timer.unref?.()
}

export async function releaseLegacySession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  if (session.timer) clearTimeout(session.timer)
  await session.client.end().catch(() => undefined)
}

export async function testLegacyConnection(settings: LegacySshConnection): Promise<LegacySftpConnectionResult> {
  const startedAt = Date.now()
  const { client, root, fingerprint: actualFingerprint } = await connect(settings)
  try {
    const remotePathExists = Boolean(await client.exists(root))
    if (remotePathExists) await client.stat(root)
    return {
      fingerprint: actualFingerprint,
      remotePath: root,
      remotePathExists,
      latencyMs: Math.max(0, Date.now() - startedAt),
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

function isNoSuchFile(error: unknown) {
  const code = (error as { code?: unknown }).code
  return code === 2 || (error instanceof Error && /no such file|not found|ENOENT/i.test(error.message))
}

/**
 * Reads a bounded remote file. Missing files return undefined instead of
 * throwing.  When the caller has a directory-listing size it is passed in to
 * avoid a second stat; direct callers stat before downloading so a malicious
 * or accidentally huge optional file is never buffered in memory.
 */
async function readOptional(client: SftpClient, path: string, maximumBytes = MAX_FILE_BYTES, knownSize?: number): Promise<Buffer | undefined> {
  try {
    const size = knownSize ?? (await client.stat(path)).size
    if (size > maximumBytes) throw new Error(`远端文件超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB：${posix.basename(path)}`)
    const value = await client.get(path)
    if (!Buffer.isBuffer(value)) throw new Error(`无法读取远端文件：${path}`)
    if (value.byteLength > maximumBytes) throw new Error(`远端文件超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB：${posix.basename(path)}`)
    return value
  } catch (error) {
    if (isNoSuchFile(error)) return undefined
    throw error
  }
}

async function listOptional(client: SftpClient, path: string): Promise<Map<string, { size: number }> | undefined> {
  try {
    const entries = await client.list(path)
    return new Map(entries.map((entry) => [entry.name, { size: entry.size }]))
  } catch (error) {
    if (isNoSuchFile(error)) return undefined
    throw error
  }
}

function mapWithConcurrency<T>(values: T[], limit: number, worker: (value: T) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    let active = 0
    let failed = false
    const next = () => {
      if (failed) return
      while (active < limit && index < values.length) {
        const current = index
        index += 1
        active += 1
        void worker(values[current]!).then(() => {
          active -= 1
          next()
        }, (error) => {
          failed = true
          reject(error)
        })
      }
      if (active === 0 && index >= values.length) resolve()
    }
    next()
  })
}

async function acquireLock(client: SftpClient, root: string) {
  await client.mkdir(posix.join(root, 'notes'), true)
  const lockPath = posix.join(root, 'notes/.index-write.lock')
  const ownerPath = posix.join(lockPath, 'owner')
  // The legacy Android/macOS lock contract stores a plain owner UUID and uses
  // the lock directory mtime to determine staleness.
  const owner = randomUUID()
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await client.mkdir(lockPath, false)
      await client.put(Buffer.from(`${owner}\n`), ownerPath)
      return { lockPath, ownerPath, owner }
    } catch {
      const stats = await client.stat(lockPath).catch(() => undefined)
      const ownerStats = await client.stat(ownerPath).catch(() => undefined)
      const modifiedAt = Math.max(Number(stats?.modifyTime ?? Number.NaN), Number(ownerStats?.modifyTime ?? Number.NaN))
      if (Number.isFinite(modifiedAt) && Date.now() - modifiedAt > LOCK_STALE_MS) {
        const quarantine = `${lockPath}.stale-${owner}`
        if (await client.rename(lockPath, quarantine).then(() => true).catch(() => false)) {
          await client.delete(posix.join(quarantine, 'owner'), true).catch(() => undefined)
          await client.rmdir(quarantine, false).catch(() => undefined)
        }
        continue
      }
      if (attempt + 1 === LOCK_RETRIES) {
        const currentOwner = (await readOptional(client, ownerPath).catch(() => undefined))?.toString('utf8').trim()
        const age = Number.isFinite(modifiedAt) ? Math.max(0, Math.floor((Date.now() - modifiedAt) / 1_000)) : undefined
        throw new Error(`远端仓库正在由其他设备同步${currentOwner ? `（锁 ${currentOwner.slice(0, 8)}）` : ''}${age !== undefined ? `，已持续约 ${age} 秒` : ''}；应用会在锁超过 30 分钟且确认陈旧后自动恢复，请稍后重试`)
      }
      await delay(1_000)
    }
  }
  throw new Error('无法取得远端同步锁')
}

async function refreshLock(client: SftpClient, lock: { lockPath: string; ownerPath: string; owner: string }) {
  const currentOwner = await readOptional(client, lock.ownerPath)
  if (currentOwner?.toString('utf8').trim() !== lock.owner) throw new Error('远端发布锁所有权已变化，已停止同步')
  const raw = (client as unknown as { sftp?: { setstat(path: string, attributes: { atime: number; mtime: number }, callback: (error?: Error | null) => void): void } }).sftp
  if (!raw) throw new Error('当前 SFTP 客户端无法续租远端发布锁')
  const seconds = Math.floor(Date.now() / 1_000)
  await new Promise<void>((resolve, reject) => raw.setstat(lock.lockPath, { atime: seconds, mtime: seconds }, (error) => error ? reject(error) : resolve()))
}

function maintainLock(client: SftpClient, lock: { lockPath: string; ownerPath: string; owner: string }) {
  let failure: unknown
  let refreshing = false
  const timer = setInterval(() => {
    if (refreshing || failure) return
    refreshing = true
    void refreshLock(client, lock).catch((error) => { failure = error }).finally(() => { refreshing = false })
  }, LOCK_HEARTBEAT_MS)
  return async () => {
    clearInterval(timer)
    if (failure) throw failure
    await refreshLock(client, lock)
  }
}

async function releaseLock(client: SftpClient, lock: { lockPath: string; ownerPath: string; owner: string }) {
  const currentOwner = await readOptional(client, lock.ownerPath).catch(() => undefined)
  if (currentOwner?.toString('utf8').trim() !== lock.owner) return
  await client.delete(lock.ownerPath, true).catch(() => undefined)
  await client.rmdir(lock.lockPath, false).catch(() => undefined)
}

/**
 * Writes a remote file atomically via a temporary name and rename. The
 * read-back verification is only applied to files that are not content
 * addressed: notes and objects carry their own hashes which the next pull
 * validates, so the extra round trip is skipped for them.
 */
async function atomicWrite(client: SftpClient, path: string, data: Buffer, verify = false) {
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`文件超过 100 MB：${posix.basename(path)}`)
  await client.mkdir(posix.dirname(path), true)
  const temporary = `${path}.tmp.notebook-next.${randomUUID()}`
  try {
    await client.put(data, temporary)
    if (verify) {
      const check = await readOptional(client, temporary)
      if (!check || sha256(check) !== sha256(data)) throw new Error(`远端临时文件校验失败：${posix.basename(path)}`)
    }
    try { await client.posixRename(temporary, path) }
    catch { if (await client.exists(path)) await client.delete(path); await client.rename(temporary, path) }
  } catch (error) {
    await client.delete(temporary, true).catch(() => undefined)
    throw error
  }
}

const verifyOnWrite = (name: string) => name === 'notes/index.json' || name === 'notes/privacy.json'

export async function pullLegacyRepository(settings: LegacySshConnection, options: LegacySftpPullOptions = {}): Promise<LegacySftpPullResult> {
  const session = await sessionFor(settings, options.sessionId)
  const { client, root } = session
  try {
    await client.mkdir(root, true)
    const files = new Map<string, Buffer>()
    const knownObjectHashes = new Set(options.knownObjectHashes?.filter((value) => /^[0-9a-f]{64}$/i.test(value)).map((value) => value.toLowerCase()) ?? [])
    const knownNoteSignatures = new Map(options.knownNoteSignatures?.flatMap((item) => isUuid(item.noteID) && item.signature.length <= 256 ? [[item.noteID, item.signature] as const] : []) ?? [])
    const remoteObjectHashes = new Set<string>()
    const reusedNoteIds: string[] = []
    let reusedObjectCount = 0
    const cacheNamespace = `${settings.host.trim()}:${settings.port}:${settings.username.trim()}:${root}`
    let totalBytes = 0
    const addValue = (name: string, value: Buffer) => {
      totalBytes += value.byteLength
      if (totalBytes > MAX_REPOSITORY_BYTES) throw new Error('远端同步仓库超过 512 MB 单次传输上限；请清理无用附件或拆分仓库后重试')
      files.set(name, value)
    }
    // Directory listings replace the per-file exists+stat round trips. The
    // notes listing also tells us which notes actually exist, so downloads are
    // a single get each.
    const rootListing = await listOptional(client, root)
    const notesListing = await listOptional(client, posix.join(root, 'notes'))
    // The listing avoids an extra stat for repository metadata; readOptional
    // still verifies the received bytes in case a concurrent writer replaces a
    // file between listing and download.
    const readListed = async (name: string, listing: Map<string, { size: number }> | undefined, transform?: (value: Buffer) => Buffer) => {
      if (files.has(name)) return
      const listed = listing?.get(posix.basename(name))
      if (!listed) return
      const value = await readOptional(client, posix.join(root, name), MAX_FILE_BYTES, listed.size)
      if (!value) return
      addValue(name, transform ? transform(value) : value)
    }
    // Pulls are optimistic snapshots. Publishing clients write the index last;
    // reading it both before and after avoids holding the cross-device write
    // lock during a potentially large download and prevents killed readers
    // from leaving Android blocked behind a stale lock.
    const remoteIndex = await readOptional(client, posix.join(root, 'notes/index.json'))
    if (remoteIndex) addValue('notes/index.json', remoteIndex)
    for (const name of ['library.json', 'notes/reading_positions.json', 'notes/assets_manifest.json', 'notes/privacy.json']) {
      await readListed(name, name.startsWith('notes/') ? notesListing : rootListing)
    }
    const index = remoteIndex ? normalizeRepositoryIndex(remoteIndex) : undefined
    if (index) files.set('notes/index.json', index)
    if (index && !options.metadataOnly) {
      const parsed = JSON.parse(index.toString('utf8')) as { entries?: Array<{ noteID?: string; version?: number; contentHash?: string; historyCount?: number }> }
      const compressed = usesCompressedNotes(index)
      const entries = parsed.entries ?? []
      const pending: Array<{ entry: NonNullable<typeof parsed.entries>[number]; name: string; cacheKey: string; signature: string }> = []
      for (const entry of entries) if (isUuid(entry.noteID)) {
        const name = `notes/${entry.noteID}.json`
        const cacheKey = `${cacheNamespace}:${entry.noteID}`
        const signature = `${entry.version ?? 0}:${entry.contentHash ?? ''}:${entry.historyCount ?? 0}:${compressed ? 'gzip' : 'json'}`
        if (knownNoteSignatures.get(entry.noteID) === signature) {
          reusedNoteIds.push(entry.noteID)
          continue
        }
        const cached = pulledNoteCache.get(cacheKey)
        if (cached?.signature === signature) addValue(name, cached.data)
        else pending.push({ entry, name, cacheKey, signature })
      }
      await mapWithConcurrency(pending, TRANSFER_CONCURRENCY, async ({ entry, name, cacheKey, signature }) => {
        const remoteName = compressed ? compressedNotePath(entry.noteID!) : name
        const value = await readOptional(client, posix.join(root, remoteName))
        if (!value) return
        const decoded = compressed ? decodeCompressedNote(value, name) : value
        addValue(name, decoded)
        cacheBuffer(pulledNoteCache, cacheKey, { signature, data: decoded }, MAX_NOTE_CACHE_BYTES)
      })
    }
    const manifest = files.get('notes/assets_manifest.json')
    if (manifest) {
      // The manifest is parsed even in metadataOnly mode so callers can learn
      // the remote object hash set without downloading a single object.
      const parsed = JSON.parse(manifest.toString('utf8')) as { entries?: Array<{ relativePath?: string; contentHash?: string }> }
      const entries = parsed.entries ?? []
      const pending: Array<{ name: string; contentHash?: string }> = []
      for (const entry of entries) if (typeof entry.relativePath === 'string') {
        const relative = safeRelativePath(entry.relativePath)
        const name = relative.startsWith('objects/') ? relative : `attachments/${relative}`
        const contentHash = entry.contentHash?.toLowerCase()
        if (contentHash && /^[0-9a-f]{64}$/.test(contentHash)) remoteObjectHashes.add(contentHash)
        if (options.metadataOnly) continue
        if (contentHash && knownObjectHashes.has(contentHash)) {
          reusedObjectCount += 1
          continue
        }
        const cacheKey = `${cacheNamespace}:${name}`
        const cached = entry.contentHash ? pulledObjectCache.get(cacheKey) : undefined
        if (cached && cached.contentHash === entry.contentHash) addValue(name, cached.data)
        else pending.push({ name, contentHash: entry.contentHash })
      }
      if (!options.metadataOnly) {
        await mapWithConcurrency(pending, TRANSFER_CONCURRENCY, async ({ name, contentHash }) => {
          const value = await readOptional(client, posix.join(root, name))
          if (!value) return
          addValue(name, value)
          if (contentHash) cacheBuffer(pulledObjectCache, `${cacheNamespace}:${name}`, { contentHash, data: value }, MAX_OBJECT_CACHE_BYTES)
        })
      }
    }
    const finalIndex = await readOptional(client, posix.join(root, 'notes/index.json'))
    if ((finalIndex ? sha256(finalIndex) : '') !== (remoteIndex ? sha256(remoteIndex) : '')) {
      throw new Error('远端索引在拉取期间已变化，请重新同步')
    }
    return {
      files: [...files].map(([name, data]) => ({ name, data: new Uint8Array(data) })),
      indexHash: remoteIndex ? sha256(remoteIndex) : '',
      fingerprint: session.fingerprint,
      objectHashes: [...remoteObjectHashes],
      reusedObjectCount,
      reusedNoteIds,
      sessionId: session.id,
    }
  } finally {
    // The session stays open so the caller can push over the same connection.
  }
}

export async function pushLegacyRepository(settings: LegacySshConnection, files: LegacySftpFile[], expectedIndexHash: string, options: LegacySftpPushOptions = {}) {
  const session = await sessionFor(settings, options.sessionId)
  const { client, root } = session
  let lock: { lockPath: string; ownerPath: string; owner: string } | undefined
  let finishHeartbeat: (() => Promise<void>) | undefined
  try {
    const normalized = files.map((file) => ({ name: safeRelativePath(file.name), data: Buffer.from(file.data) }))
    if (normalized.some((file) => !isAllowedRepositoryFile(file.name))) throw new Error('同步请求包含不允许的远端路径')
    if (normalized.reduce((sum, item) => sum + item.data.byteLength, 0) > MAX_REPOSITORY_BYTES) throw new Error('待上传同步仓库超过 512 MB 单次传输上限')
    await client.mkdir(root, true)
    lock = await acquireLock(client, root)
    finishHeartbeat = maintainLock(client, lock)
    const currentIndex = await readOptional(client, posix.join(root, 'notes/index.json'))
    const currentHash = currentIndex ? sha256(currentIndex) : ''
    if (currentHash !== expectedIndexHash) throw new Error('远端索引在同步期间已变化，请重新同步')
    const currentEntries = new Map<string, string>()
    const nextEntries = new Map<string, string>()
    const entrySignatures = (value: Buffer | undefined, target: Map<string, string>) => {
      if (!value) return
      const parsed = JSON.parse(value.toString('utf8')) as { entries?: Array<{ noteID?: string; version?: number; contentHash?: string; historyCount?: number }> }
      for (const entry of parsed.entries ?? []) if (isUuid(entry.noteID)) target.set(entry.noteID, `${entry.version ?? 0}:${entry.contentHash ?? ''}:${entry.historyCount ?? 0}`)
    }
    entrySignatures(currentIndex, currentEntries)
    entrySignatures(normalized.find((file) => file.name === 'notes/index.json')?.data, nextEntries)
    const unchangedNoteIds = new Set([...nextEntries].flatMap(([id, signature]) => currentEntries.get(id) === signature ? [id] : []))
    const encoded = normalized.flatMap((file) => {
      if (/^notes\/[0-9a-f-]{36}\.json$/i.test(file.name)) {
        const noteId = file.name.slice('notes/'.length, -'.json'.length)
        if (unchangedNoteIds.has(noteId)) return []
        const compact = compactJson(file.data)
        return [{ name: `${file.name}.gz`, data: gzipSync(compact, { level: 9 }) }]
      }
      if (file.name === 'notes/index.json') return [{ ...file, data: encodeCompressedIndex(file.data) }]
      if (file.name.endsWith('.json')) return [{ ...file, data: compactJson(file.data) }]
      return [file]
    })
    const knownObjects = new Set((options.knownObjectHashes ?? []).filter((value) => /^[0-9a-f]{64}$/i.test(value)).map((value) => value.toLowerCase()))
    const upload = async (file: { name: string; data: Buffer }) => {
      // Objects the renderer already knows about are skipped without a remote
      // exists check; unknown names still get one as a defensive guard.
      if (file.name.startsWith('objects/')) {
        const hash = file.name.split('/').pop()!.toLowerCase()
        if (!knownObjects.has(hash) && await client.exists(posix.join(root, file.name))) return
      }
      await atomicWrite(client, posix.join(root, file.name), file.data, verifyOnWrite(file.name))
    }
    // Upload in dependency order while transferring each wave concurrently:
    // objects first, then notes and metadata, and the index last so readers
    // never observe a half-published repository.
    const firstWave = encoded.filter((file) => file.name === 'library.json' || file.name.startsWith('attachments/') || file.name.startsWith('objects/'))
    const secondWave = encoded.filter((file) => !firstWave.includes(file) && file.name !== 'notes/index.json')
    await mapWithConcurrency(firstWave, TRANSFER_CONCURRENCY, upload)
    await mapWithConcurrency(secondWave, TRANSFER_CONCURRENCY, upload)
    const indexFile = encoded.find((file) => file.name === 'notes/index.json')
    if (indexFile) await atomicWrite(client, posix.join(root, indexFile.name), indexFile.data, true)
    await finishHeartbeat()
    finishHeartbeat = undefined
    return { fingerprint: session.fingerprint, sessionId: session.id }
  } finally {
    if (finishHeartbeat) await finishHeartbeat().catch(() => undefined)
    if (lock) await releaseLock(client, lock)
  }
}

/**
 * Repository maintenance helper. The helper is a single-file Python 3 script
 * executed over an SSH channel (fed via base64 so no quoting issues and no
 * files need to be uploaded); servers without python3 return a non-zero exit
 * and callers fall back to the plain SFTP path.
 */
const REPOSITORY_HELPER = String.raw`import gzip, hashlib, json, os, posixpath, shutil, sys, tarfile, tempfile, time, uuid

ALLOWED_ROOT_FILES = {'library.json', 'notes/index.json', 'notes/reading_positions.json', 'notes/assets_manifest.json', 'notes/privacy.json'}
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_REPOSITORY_BYTES = 512 * 1024 * 1024

def safe(name):
    norm = posixpath.normpath(name.replace('\\\\', '/'))
    if norm in ('', '.', '..') or norm.startswith('/') or norm.startswith('../'):
        return None
    return norm

def is_note(name):
    if not name.startswith('notes/') or not name.endswith('.json.gz'):
        return False
    note = name[len('notes/'):-len('.json.gz')]
    return len(note) == 36 and note.count('-') == 4

def is_object(name):
    parts = name.split('/')
    return len(parts) == 3 and parts[0] == 'objects' and len(parts[1]) == 2 and len(parts[2]) == 64

def allowed(name):
    return name in ALLOWED_ROOT_FILES or is_note(name) or is_object(name) or (name.startswith('attachments/') and len(name) > len('attachments/'))

def die(message):
    print(json.dumps({'ok': False, 'error': message}), file=sys.stderr)
    sys.exit(1)

def acquire_lock(root):
    notes_dir = os.path.join(root, 'notes')
    os.makedirs(notes_dir, exist_ok=True)
    lock_path = os.path.join(notes_dir, '.index-write.lock')
    owner_path = os.path.join(lock_path, 'owner')
    owner = str(uuid.uuid4())
    try:
        os.mkdir(lock_path)
    except FileExistsError:
        die('repository is locked by another device')
    try:
        with open(owner_path, 'w', encoding='utf-8') as f:
            f.write(owner + '\\n')
        os.utime(lock_path, None)
    except Exception:
        shutil.rmtree(lock_path, ignore_errors=True)
        raise
    return lock_path, owner_path, owner

def heartbeat(lock_path, owner_path, owner):
    try:
        with open(owner_path, 'r', encoding='utf-8') as f:
            if f.read().strip() != owner:
                die('repository lock ownership changed')
        os.utime(lock_path, None)
    except FileNotFoundError:
        die('repository lock ownership changed')

def release_lock(lock_path, owner_path, owner):
    try:
        with open(owner_path, 'r', encoding='utf-8') as f:
            if f.read().strip() != owner:
                return
        os.remove(owner_path)
        os.rmdir(lock_path)
    except OSError:
        pass

def main(op, root):
    if not os.path.isabs(root):
        die('root must be absolute')
    if op == 'export-tar':
        try:
            out = tarfile.open(fileobj=sys.stdout.buffer, mode='w|')
            for dirpath, _dirnames, filenames in os.walk(root):
                for filename in filenames:
                    if '.tmp.notebook-next.' in filename or filename.endswith('.tmp'):
                        continue
                    full = os.path.join(dirpath, filename)
                    rel = posixpath.relpath(full, root)
                    if not allowed(rel):
                        continue
                    out.add(full, arcname=rel, recursive=False)
            out.close()
        except Exception as error:
            die('export failed: %s' % error)
    elif op == 'import-tar':
        lock_path = owner_path = stage = None
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            stage = tempfile.mkdtemp(prefix='.notebook-next-import-', dir=root)
            total = 0
            with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
                for member in archive:
                    rel = safe(member.name)
                    if not rel or not allowed(rel):
                        die('unsafe path: %s' % member.name)
                    if not member.isfile():
                        die('unsupported archive member: %s' % member.name)
                    if member.size < 0 or member.size > MAX_FILE_BYTES:
                        die('archive member exceeds 100 MB: %s' % member.name)
                    total += member.size
                    if total > MAX_REPOSITORY_BYTES:
                        die('archive exceeds 512 MB')
                    target = os.path.join(stage, *rel.split('/'))
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        die('cannot extract archive member: %s' % member.name)
                    with open(target, 'wb') as out:
                        written = 0
                        while True:
                            chunk = extracted.read(65536)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > MAX_FILE_BYTES:
                                die('archive member exceeds 100 MB: %s' % member.name)
                            out.write(chunk)
                            heartbeat(lock_path, owner_path, owner)
            staged = []
            for dirpath, _dirnames, filenames in os.walk(stage):
                for filename in filenames:
                    full = os.path.join(dirpath, filename)
                    rel = posixpath.relpath(full, stage)
                    staged.append((rel, full))
            # Publish the index last, matching normal SFTP synchronization, so
            # readers never observe an index that references unpublished files.
            staged.sort(key=lambda item: (item[0] == 'notes/index.json', item[0]))
            for rel, full in staged:
                target = os.path.join(root, *rel.split('/'))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                os.replace(full, target)
                heartbeat(lock_path, owner_path, owner)
            print(json.dumps({'ok': True}))
        except Exception as error:
            die('import failed: %s' % error)
        finally:
            if stage:
                shutil.rmtree(stage, ignore_errors=True)
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    elif op == 'verify':
        errors = []
        objects_dir = os.path.join(root, 'objects')
        if os.path.isdir(objects_dir):
            for prefix in sorted(os.listdir(objects_dir)):
                prefix_dir = os.path.join(objects_dir, prefix)
                if not os.path.isdir(prefix_dir):
                    continue
                for name in sorted(os.listdir(prefix_dir)):
                    digest = hashlib.sha256()
                    with open(os.path.join(prefix_dir, name), 'rb') as f:
                        while True:
                            chunk = f.read(65536)
                            if not chunk:
                                break
                            digest.update(chunk)
                    if digest.hexdigest() != name:
                        errors.append('objects/%s/%s hash mismatch' % (prefix, name))
        notes_dir = os.path.join(root, 'notes')
        if os.path.isdir(notes_dir):
            for name in sorted(os.listdir(notes_dir)):
                if not name.endswith('.json.gz'):
                    continue
                full = os.path.join(notes_dir, name)
                try:
                    with gzip.open(full, 'rb') as f:
                        value = json.load(f)
                    if not isinstance(value, dict) or value.get('noteID') != name[:-len('.json.gz')]:
                        errors.append('notes/%s noteID mismatch' % name)
                except Exception as error:
                    errors.append('notes/%s invalid: %s' % (name, error))
        index_path = os.path.join(root, 'notes/index.json')
        if os.path.exists(index_path):
            try:
                with open(index_path, 'rb') as f:
                    json.load(f)
            except Exception as error:
                errors.append('notes/index.json invalid: %s' % error)
        print(json.dumps({'ok': not errors, 'errors': errors}))
    elif op == 'gc':
        lock_path = owner_path = None
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            declared = set()
            manifest_path = os.path.join(root, 'notes/assets_manifest.json')
            if os.path.exists(manifest_path):
                with open(manifest_path, 'rb') as f:
                    manifest = json.load(f)
                for entry in manifest.get('entries', []):
                    rel = entry.get('relativePath', '')
                    if rel.startswith('objects/'):
                        declared.add(rel.split('/')[-1])
            heartbeat(lock_path, owner_path, owner)
            removed = 0
            objects_dir = os.path.join(root, 'objects')
            if os.path.isdir(objects_dir):
                for prefix in sorted(os.listdir(objects_dir)):
                    prefix_dir = os.path.join(objects_dir, prefix)
                    if not os.path.isdir(prefix_dir):
                        continue
                    for name in sorted(os.listdir(prefix_dir)):
                        if name not in declared:
                            os.remove(os.path.join(prefix_dir, name))
                            removed += 1
                        heartbeat(lock_path, owner_path, owner)
            print(json.dumps({'ok': True, 'removed': removed}))
        except Exception as error:
            die('gc failed: %s' % error)
        finally:
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    else:
        die('unknown op: %s' % op)

`
// The helper is executed as `python3 -c "..."`. The script itself, the
// operation and the repository root travel as base64 payloads, which contain
// no shell metacharacters inside double quotes; the caller invokes `main()`
// explicitly after exec so the repository root reaches the script without
// environment plumbing. stdin stays available for import-tar payloads.
function helperCommand(op: string, root: string) {
  const script = Buffer.from(REPOSITORY_HELPER).toString('base64')
  return `python3 -c "import base64,sys;exec(base64.b64decode('${script}'));main(base64.b64decode('${Buffer.from(op).toString('base64')}').decode(),base64.b64decode('${Buffer.from(root).toString('base64')}').decode())"`
}

interface ExecResult { code: number; stdout: Uint8Array; stderr: string }

async function connectExec(settings: LegacySshConnection) {
  validateConnection(settings)
  const client = new Client()
  let presented = ''
  const expected = settings.fingerprint?.trim() ?? ''
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        client.removeListener('ready', onReady)
        reject(error)
      }
      const onReady = () => {
        client.removeListener('error', onError)
        resolve()
      }
      client.once('error', onError)
      client.once('ready', onReady)
      client.connect({
        host: settings.host.trim(), port: settings.port, username: settings.username.trim(), password: settings.password,
        readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          presented = fingerprint(key)
          return !expected || presented === expected
        },
      })
    })
  } catch (error) {
    client.end()
    if (expected && presented && presented !== expected) throw new Error(`SSH 主机指纹已变化|${expected}|${presented}`, { cause: error })
    throw error
  }
  if (!presented) { client.end(); throw new Error('服务器没有提供可校验的 SSH 主机密钥') }
  // ssh2 emits connection-level errors after the ready event as well. Keeping
  // a listener prevents an unhandled EventEmitter error from crashing the main
  // process; command streams still surface their own failure to the caller.
  client.on('error', () => undefined)
  return client
}

function execCommand(client: Client, command: string, input?: Uint8Array, maximumStdout = MAX_REPOSITORY_BYTES): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return }
      const chunks: Buffer[] = []
      let stdoutBytes = 0
      let stderr = ''
      let stderrBytes = 0
      let settled = false
      const onClientError = (reason: Error) => {
        stream.close()
        rejectOnce(reason)
      }
      const cleanup = () => client.removeListener('error', onClientError)
      const rejectOnce = (reason: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(reason)
      }
      const resolveOnce = (value: ExecResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      client.once('error', onClientError)
      stream.on('data', (chunk: Buffer) => {
        if (settled) return
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > maximumStdout) {
          stream.close()
          rejectOnce(new Error('服务器 helper 输出超过 512 MB 上限'))
          return
        }
        chunks.push(chunk)
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        if (settled) return
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_HELPER_STDERR_BYTES) {
          stream.close()
          rejectOnce(new Error('服务器 helper 错误输出超过 16 MB 上限'))
          return
        }
        stderr += chunk.toString('utf8')
      })
      stream.on('close', (code: number | null) => resolveOnce({ code: code ?? -1, stdout: new Uint8Array(Buffer.concat(chunks)), stderr }))
      stream.on('error', rejectOnce)
      if (input) stream.write(input)
      stream.end()
    })
  })
}

export async function runRepositoryHelper(settings: LegacySshConnection, operation: 'export-tar' | 'import-tar' | 'verify' | 'gc', input?: Uint8Array): Promise<LegacySftpHelperResult> {
  if (input && input.byteLength > MAX_REPOSITORY_BYTES) throw new Error('待导入仓库超过 512 MB 上限')
  const client = await connectExec(settings)
  try {
    const cwdResult = await execCommand(client, 'pwd', undefined, 1024 * 1024)
    const home = cwdResult.stdout.length ? new TextDecoder().decode(cwdResult.stdout).trim() : ''
    const configured = settings.remotePath.trim()
    const root = configured === '~' ? home : configured.startsWith('~/') ? posix.join(home, configured.slice(2)) : configured.startsWith('/') ? posix.normalize(configured) : posix.join(home, configured)
    const result = await execCommand(client, helperCommand(operation, root), input)
    if (operation === 'export-tar') {
      // The tar stream is raw; a failed helper prints a JSON error to stderr.
      if (result.code !== 0 || result.stdout.byteLength === 0) {
        throw new Error(result.stderr.trim() || `服务器 helper 导出失败（退出码 ${result.code}）`)
      }
      return { ok: true, data: result.stdout, message: `${result.stdout.byteLength} 字节` }
    }
    let parsed: { ok?: boolean; error?: string; errors?: string[]; removed?: number }
    try {
      parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as typeof parsed
    } catch {
      throw new Error(result.stderr.trim() || `服务器 helper 返回了无法解析的结果（退出码 ${result.code}）`)
    }
    if (result.code !== 0 || parsed.ok === false) throw new Error((parsed.error ?? result.stderr.trim()) || '服务器 helper 执行失败')
    if (operation === 'verify') {
      const errors = parsed.errors ?? []
      return { ok: true, message: errors.length ? `发现 ${errors.length} 个问题：${errors.join('；')}` : '仓库校验通过' }
    }
    if (operation === 'gc') return { ok: true, message: `已清理 ${parsed.removed ?? 0} 个孤儿对象` }
    return { ok: true, message: '仓库已导入' }
  } finally {
    client.end()
  }
}
