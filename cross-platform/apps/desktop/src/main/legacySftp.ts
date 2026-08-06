import SftpClient from 'ssh2-sftp-client'
import { Client } from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { readFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'

export interface LegacySshConnection {
  host: string
  port: number
  username: string
  remotePath: string
  fingerprint?: string
  /** SSH 登录密码（与 privateKeyPath 二选一；服务器仅允许公钥认证时留空）。 */
  password?: string
  /** SSH 私钥文件路径（如 ~/.ssh/id_ed25519）。提供时优先使用公钥认证。 */
  privateKeyPath?: string
  /** SSH 私钥口令（加密私钥时必填，无口令私钥留空）。 */
  privateKeyPassphrase?: string
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
const MAX_HELPER_ARCHIVE_BYTES = MAX_REPOSITORY_BYTES + 32 * 1024 * 1024
const MAX_HELPER_STDERR_BYTES = 16 * 1024 * 1024
const HELPER_PROBE_TIMEOUT_MS = 15 * 1000
const HELPER_COMMAND_TIMEOUT_MS = 60 * 60 * 1000
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
  if (!value.remotePath.trim() || value.remotePath.includes('\0')) throw new Error('请填写远端同步目录')
  const hasPassword = Boolean(value.password)
  const hasPrivateKey = Boolean(value.privateKeyPath?.trim())
  if (!hasPassword && !hasPrivateKey) throw new Error('请配置 SSH 私钥文件路径或登录密码')
}

/** Resolve a `~/`-prefixed path to an absolute filesystem path. */
function resolvePrivateKeyPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('~/')) return posix.join(homedir(), trimmed.slice(2))
  if (trimmed === '~') return homedir()
  return trimmed
}

/**
 * Build ssh2/ssh2-sftp-client connect credentials from a LegacySshConnection.
 * Private key auth takes precedence when provided; password is only sent when
 * no key is configured (the server may have disabled password auth entirely).
 */
async function buildSshCredentials(settings: LegacySshConnection) {
  const keyPath = settings.privateKeyPath?.trim()
  if (keyPath) {
    let privateKey: Buffer
    try {
      privateKey = await readFile(resolvePrivateKeyPath(keyPath))
    } catch (error) {
      throw new Error(`无法读取 SSH 私钥文件：${resolvePrivateKeyPath(keyPath)}（请检查路径和权限）`, { cause: error })
    }
    const passphrase = settings.privateKeyPassphrase?.trim() || undefined
    return { privateKey, passphrase, password: undefined as string | undefined }
  }
  return { privateKey: undefined, passphrase: undefined, password: settings.password }
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
  const credentials = await buildSshCredentials(settings)
  const client = new SftpClient('Notebook legacy sync')
  let presented = ''
  const expected = settings.fingerprint?.trim() ?? ''
  try {
    await client.connect({
      host: settings.host.trim(), port: settings.port, username: settings.username.trim(),
      password: credentials.password, privateKey: credentials.privateKey, passphrase: credentials.passphrase,
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
  return `${settings.host.trim()}:${settings.port}:${settings.username.trim()}:${settings.remotePath.trim()}:${settings.privateKeyPath?.trim() ?? ''}`
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
const REPOSITORY_HELPER = String.raw`import gzip, hashlib, json, os, posixpath, re, shutil, sys, tarfile, tempfile, time, uuid

ALLOWED_ROOT_FILES = {'library.json', 'notes/index.json', 'notes/reading_positions.json', 'notes/assets_manifest.json', 'notes/privacy.json'}
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_REPOSITORY_BYTES = 512 * 1024 * 1024
LOCK_RETRIES = 30
LOCK_RETRY_SECONDS = 1
LOCK_STALE_SECONDS = 30 * 60
GC_GRACE_SECONDS = 7 * 24 * 60 * 60
GC_QUARANTINE_SECONDS = 30 * 24 * 60 * 60
RECOVERY_DIRECTORY = '.notebook-next-recovery'
UUID_PATTERN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
HASH_PATTERN = re.compile(r'^[0-9a-f]{64}$', re.I)
OBJECT_REFERENCE_PATTERN = re.compile(r'objects/([0-9a-f]{2})/([0-9a-f]{64})', re.I)
ASSET_REFERENCE_PATTERN = re.compile(r'notebook-asset:([-A-Za-z0-9._:]+)')

def safe(name):
    norm = posixpath.normpath(name.replace('\\\\', '/'))
    if norm in ('', '.', '..') or norm.startswith('/') or norm.startswith('../'):
        return None
    return norm

def note_id(name):
    if not name.startswith('notes/'):
        return None
    suffix = '.json.gz' if name.endswith('.json.gz') else '.json' if name.endswith('.json') else None
    if not suffix:
        return None
    value = name[len('notes/'):-len(suffix)]
    return value if UUID_PATTERN.match(value) else None

def is_note(name):
    return note_id(name) is not None

def is_object(name):
    parts = name.split('/')
    return len(parts) == 3 and parts[0] == 'objects' and HASH_PATTERN.match(parts[2]) is not None and parts[1].lower() == parts[2][:2].lower()

def allowed(name):
    return name in ALLOWED_ROOT_FILES or is_note(name) or is_object(name) or (name.startswith('attachments/') and len(name) > len('attachments/'))

def die(message):
    print(json.dumps({'ok': False, 'error': message}), file=sys.stderr)
    sys.exit(1)

def safe_path(root, rel):
    normalized = safe(rel)
    if not normalized:
        raise ValueError('unsafe path: %s' % rel)
    target = os.path.join(root, *normalized.split('/'))
    root_real = os.path.realpath(root)
    parent_real = os.path.realpath(os.path.dirname(target))
    if os.path.commonpath([root_real, parent_real]) != root_real:
        raise ValueError('path escapes repository root: %s' % rel)
    return target

def read_bytes(path, compressed=False):
    opener = gzip.open if compressed else open
    chunks = []
    total = 0
    with opener(path, 'rb') as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_BYTES:
                raise ValueError('decoded file exceeds 100 MB')
            chunks.append(chunk)
    return b''.join(chunks)

def load_json(path, compressed=False):
    return json.loads(read_bytes(path, compressed=compressed).decode('utf-8'))

def sha256_file(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, 'rb') as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                raise ValueError('file exceeds 100 MB')
            digest.update(chunk)
    return digest.hexdigest(), size

def repository_files(root):
    files = []
    total = 0
    if not os.path.isdir(root):
        return files
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [name for name in dirnames if name != RECOVERY_DIRECTORY and name != '.index-write.lock' and '.index-write.lock.stale.' not in name and not os.path.islink(os.path.join(dirpath, name))]
        for filename in filenames:
            if '.tmp.notebook-next.' in filename or filename.endswith('.tmp'):
                continue
            full = os.path.join(dirpath, filename)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rel = posixpath.relpath(full, root)
            if not allowed(rel):
                continue
            size = os.path.getsize(full)
            if size > MAX_FILE_BYTES:
                raise ValueError('%s exceeds 100 MB' % rel)
            total += size
            if total > MAX_REPOSITORY_BYTES:
                raise ValueError('repository exceeds 512 MB')
            files.append((rel, full, size))
    return sorted(files)

def acquire_lock(root):
    notes_dir = os.path.join(root, 'notes')
    os.makedirs(notes_dir, exist_ok=True)
    lock_path = os.path.join(notes_dir, '.index-write.lock')
    owner_path = os.path.join(lock_path, 'owner')
    owner = str(uuid.uuid4())
    for attempt in range(LOCK_RETRIES):
        try:
            os.mkdir(lock_path)
            break
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(lock_path)
            except FileNotFoundError:
                continue
            if age > LOCK_STALE_SECONDS:
                stale = lock_path + '.stale.' + str(uuid.uuid4())
                try:
                    os.rename(lock_path, stale)
                    shutil.rmtree(stale, ignore_errors=True)
                    continue
                except OSError:
                    pass
            if attempt + 1 >= LOCK_RETRIES:
                die('repository is locked by another device')
            time.sleep(LOCK_RETRY_SECONDS)
    else:
        die('repository lock could not be acquired')
    try:
        with open(owner_path, 'w', encoding='utf-8') as f:
            f.write(owner + '\n')
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

def validate_repository(root, require_index=True, beat=None, for_gc=False):
    errors = []
    live_objects = set()

    def add(message):
        if len(errors) < 200:
            errors.append(message)

    def pulse():
        if beat:
            beat()

    try:
        files = repository_files(root)
    except Exception as error:
        return ['repository inventory invalid: %s' % error], live_objects
    by_name = {rel: (full, size) for rel, full, size in files}
    if require_index and 'library.json' not in by_name:
        add('library.json is missing')
    if require_index and 'notes/assets_manifest.json' not in by_name:
        add('notes/assets_manifest.json is missing')

    for directory in ('notes', 'objects'):
        base = os.path.join(root, directory)
        if not os.path.isdir(base) or os.path.islink(base):
            if os.path.islink(base):
                add('%s directory must not be a symbolic link' % directory)
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            dirnames[:] = [name for name in dirnames if name != '.index-write.lock' and '.index-write.lock.stale.' not in name]
            for filename in filenames:
                full = os.path.join(dirpath, filename)
                rel = posixpath.relpath(full, root)
                if os.path.islink(full):
                    add('%s must not be a symbolic link' % rel)
                elif directory == 'objects' and not is_object(rel):
                    add('%s is not a valid content-addressed object path' % rel)
                elif directory == 'notes' and not allowed(rel) and not filename.endswith('.tmp') and '.tmp.notebook-next.' not in filename:
                    add('%s is not an allowed repository note path' % rel)

    metadata_values = {}
    for metadata_name in ('library.json', 'notes/reading_positions.json', 'notes/privacy.json'):
        if metadata_name not in by_name:
            continue
        try:
            value = load_json(by_name[metadata_name][0])
            if not isinstance(value, dict):
                add('%s must contain a JSON object' % metadata_name)
            else:
                metadata_values[metadata_name] = value
        except Exception as error:
            add('%s invalid: %s' % (metadata_name, error))
        pulse()

    manifest = None
    manifest_name = 'notes/assets_manifest.json'
    if manifest_name in by_name:
        try:
            manifest = load_json(by_name[manifest_name][0])
            if not isinstance(manifest, dict) or not isinstance(manifest.get('entries', []), list):
                add('%s entries must be an array' % manifest_name)
                manifest = None
        except Exception as error:
            add('%s invalid: %s' % (manifest_name, error))
    if manifest:
        seen_paths = set()
        for position, entry in enumerate(manifest.get('entries', [])):
            if not isinstance(entry, dict):
                add('%s entry %d is not an object' % (manifest_name, position))
                continue
            rel = safe(str(entry.get('relativePath', '')))
            content_hash = str(entry.get('contentHash', '')).lower()
            physical_rel = rel if rel and (is_object(rel) or rel.startswith('attachments/')) else ('attachments/%s' % rel if rel else None)
            if not rel or not physical_rel or not allowed(physical_rel):
                add('%s entry %d has unsafe path' % (manifest_name, position))
                continue
            if rel in seen_paths:
                add('%s has duplicate path %s' % (manifest_name, rel))
            seen_paths.add(rel)
            if not HASH_PATTERN.match(content_hash):
                add('%s entry %s has invalid contentHash' % (manifest_name, rel))
                continue
            if is_object(rel):
                expected = 'objects/%s/%s' % (content_hash[:2], content_hash)
                if rel.lower() != expected.lower():
                    add('%s entry %s does not match its contentHash' % (manifest_name, rel))
                live_objects.add(content_hash)
            if physical_rel not in by_name:
                add('%s references missing file %s' % (manifest_name, physical_rel))
                continue
            try:
                actual_hash, actual_size = sha256_file(by_name[physical_rel][0])
                if actual_hash != content_hash:
                    add('%s file %s hash mismatch' % (manifest_name, rel))
                declared_size = entry.get('size')
                if declared_size is not None and (not isinstance(declared_size, (int, float)) or int(declared_size) != actual_size):
                    add('%s file %s size mismatch' % (manifest_name, rel))
            except Exception as error:
                add('%s file %s invalid: %s' % (manifest_name, rel, error))
            pulse()

    index = None
    index_name = 'notes/index.json'
    if index_name not in by_name:
        if require_index:
            add('notes/index.json is missing')
    else:
        try:
            index = load_json(by_name[index_name][0])
            if not isinstance(index, dict):
                add('notes/index.json must contain a JSON object')
                index = None
        except Exception as error:
            add('notes/index.json invalid: %s' % error)

    if index:
        entries = index.get('entries', [])
        deletions = index.get('deletedEntries', [])
        if not isinstance(entries, list):
            add('notes/index.json entries must be an array')
            entries = []
        if not isinstance(deletions, list):
            add('notes/index.json deletedEntries must be an array')
            deletions = []
        seen_entries = set()
        seen_deletions = set()
        repository_format = index.get('repositoryFormat', {})
        has_private_notes = False
        compressed = isinstance(repository_format, dict) and repository_format.get('version') in (2, 3) and repository_format.get('noteEncoding') == 'gzip'
        if repository_format:
            if not isinstance(repository_format, dict) or repository_format.get('version') not in (2, 3) or repository_format.get('noteEncoding') != 'gzip':
                add('notes/index.json repositoryFormat is unsupported')
            elif repository_format.get('version') == 3 and (repository_format.get('contentFormat') != 'markdown-gfm' or repository_format.get('assetAddressing') != 'sha256'):
                add('notes/index.json v3 repositoryFormat is incomplete')
        for position, deletion in enumerate(deletions):
            value = deletion.get('noteID') if isinstance(deletion, dict) else None
            if not isinstance(value, str) or not UUID_PATTERN.match(value):
                add('notes/index.json deletion %d has invalid noteID' % position)
            elif value in seen_deletions:
                add('notes/index.json has duplicate deletion %s' % value)
            else:
                seen_deletions.add(value)
        for position, entry in enumerate(entries):
            if not isinstance(entry, dict):
                add('notes/index.json entry %d is not an object' % position)
                continue
            value = entry.get('noteID')
            if not isinstance(value, str) or not UUID_PATTERN.match(value):
                add('notes/index.json entry %d has invalid noteID' % position)
                continue
            if value in seen_entries:
                add('notes/index.json has duplicate entry %s' % value)
            seen_entries.add(value)
            if value in seen_deletions:
                add('notes/index.json lists %s as both live and deleted' % value)
            if not isinstance(entry.get('version'), int) or entry.get('version') < 0:
                add('notes/index.json entry %s has invalid version' % value)
            if not isinstance(entry.get('contentHash'), str) or not HASH_PATTERN.match(entry.get('contentHash')):
                add('notes/index.json entry %s has invalid contentHash' % value)
            if entry.get('historyCount') is not None and (not isinstance(entry.get('historyCount'), int) or entry.get('historyCount') < 0):
                add('notes/index.json entry %s has invalid historyCount' % value)
            rel = 'notes/%s.json.gz' % value if compressed else 'notes/%s.json' % value
            if rel not in by_name:
                add('notes/index.json references missing note %s' % rel)
                continue
            try:
                envelope = load_json(by_name[rel][0], compressed=compressed)
                if not isinstance(envelope, dict) or envelope.get('noteID') != value:
                    add('%s noteID mismatch' % rel)
                    continue
                if 'privacyEncryption' in envelope:
                    has_private_notes = True
                    encryption = envelope.get('privacyEncryption')
                    if (not isinstance(encryption, dict) or encryption.get('version') != 1
                            or encryption.get('algorithm') != 'AES-256-GCM'
                            or encryption.get('kdf') != 'PBKDF2-SHA256'
                            or encryption.get('iterations') != 310000
                            or not all(isinstance(encryption.get(key), str) and encryption.get(key) for key in ('salt', 'iv', 'ciphertext'))):
                        add('%s privacy envelope invalid' % rel)
                    if for_gc:
                        add('%s is encrypted, so the helper cannot prove its complete historical object graph; gc is disabled' % rel)
                    pulse()
                    continue
                if envelope.get('schemaVersion') == 3:
                    metadata = envelope.get('metadata')
                    objects = envelope.get('contentObjects')
                    history = envelope.get('history', [])
                    current_hash = envelope.get('currentContentHash')
                    if not isinstance(metadata, dict) or metadata.get('id') != value:
                        add('%s metadata id mismatch' % rel)
                    if not isinstance(objects, dict):
                        add('%s contentObjects must be an object' % rel)
                        objects = {}
                    if not isinstance(current_hash, str) or not HASH_PATTERN.match(current_hash):
                        add('%s currentContentHash invalid' % rel)
                    elif not isinstance(objects.get(current_hash), str):
                        add('%s current content object is missing' % rel)
                    elif hashlib.sha256(objects[current_hash].encode('utf-8')).hexdigest() != current_hash.lower():
                        add('%s current content hash mismatch' % rel)
                    if isinstance(entry.get('contentHash'), str) and entry.get('contentHash').lower() != str(current_hash).lower():
                        add('%s index contentHash mismatch' % rel)
                    if not isinstance(history, list):
                        add('%s history must be an array' % rel)
                        history = []
                    if isinstance(entry.get('historyCount'), int) and entry.get('historyCount') != len(history):
                        add('%s index historyCount mismatch' % rel)
                    for history_position, history_entry in enumerate(history):
                        history_hash = history_entry.get('contentHash') if isinstance(history_entry, dict) else None
                        if not isinstance(history_hash, str) or not HASH_PATTERN.match(history_hash) or not isinstance(objects.get(history_hash), str):
                            add('%s history %d content object is missing' % (rel, history_position))
                        elif hashlib.sha256(objects[history_hash].encode('utf-8')).hexdigest() != history_hash.lower():
                            add('%s history %d content hash mismatch' % (rel, history_position))
                    for markdown in objects.values():
                        if isinstance(markdown, str):
                            for object_prefix, object_hash in OBJECT_REFERENCE_PATTERN.findall(markdown):
                                if object_prefix.lower() != object_hash[:2].lower():
                                    add('%s contains an object reference with the wrong prefix' % rel)
                                live_objects.add(object_hash.lower())
                    assets = envelope.get('assets', [])
                    if not isinstance(assets, list):
                        add('%s assets must be an array' % rel)
                        assets = []
                    asset_hashes = {}
                    for asset_position, asset in enumerate(assets):
                        if not isinstance(asset, dict):
                            add('%s asset %d is not an object' % (rel, asset_position))
                            continue
                        object_hash = str(asset.get('objectHash') or asset.get('checksum') or '').lower()
                        local_path = safe(str(asset.get('localPath', '')))
                        if object_hash:
                            if not HASH_PATTERN.match(object_hash):
                                add('%s asset %d has invalid object hash' % (rel, asset_position))
                            else:
                                live_objects.add(object_hash)
                                if isinstance(asset.get('id'), str) and asset.get('id'):
                                    asset_hashes[asset.get('id')] = object_hash
                                expected = 'objects/%s/%s' % (object_hash[:2], object_hash)
                                if local_path and local_path.lower() != expected.lower():
                                    add('%s asset %d object path mismatch' % (rel, asset_position))
                                if expected not in by_name:
                                    add('%s asset %d references missing object' % (rel, asset_position))
                    for markdown in objects.values():
                        if not isinstance(markdown, str):
                            continue
                        for asset_id in ASSET_REFERENCE_PATTERN.findall(markdown):
                            object_hash = asset_hashes.get(asset_id)
                            if object_hash:
                                live_objects.add(object_hash)
                            else:
                                add('%s content references asset %s without an object mapping' % (rel, asset_id))
                pulse()
            except Exception as error:
                add('%s invalid: %s' % (rel, error))
            pulse()

        if has_private_notes:
            privacy = metadata_values.get('notes/privacy.json')
            if not isinstance(privacy, dict):
                add('notes/privacy.json is required when encrypted notes exist')
            elif (privacy.get('schemaVersion') != 1 or privacy.get('algorithm') != 'AES-256-GCM'
                    or privacy.get('kdf') != 'PBKDF2-SHA256' or privacy.get('iterations') != 310000
                    or not all(isinstance(privacy.get(key), str) and privacy.get(key) for key in ('salt', 'iv', 'ciphertext'))):
                add('notes/privacy.json key-check format is invalid')

    for rel, full, _size in files:
        if not is_object(rel):
            continue
        try:
            actual_hash, _actual_size = sha256_file(full)
            expected_hash = rel.split('/')[-1].lower()
            if actual_hash != expected_hash:
                add('%s hash mismatch' % rel)
        except Exception as error:
            add('%s invalid: %s' % (rel, error))
        pulse()
    return errors, live_objects

def recovery_root(root):
    value = os.path.join(root, RECOVERY_DIRECTORY)
    os.makedirs(value, mode=0o700, exist_ok=True)
    return value

def create_import_recovery(root, staged, beat):
    batch = os.path.join(recovery_root(root), 'import-%d-%s' % (int(time.time()), uuid.uuid4()))
    backed_up = []
    try:
        for rel, _full in staged:
            target = safe_path(root, rel)
            if not os.path.isfile(target):
                continue
            backup = os.path.join(batch, *rel.split('/'))
            os.makedirs(os.path.dirname(backup), exist_ok=True)
            try:
                os.link(target, backup)
            except OSError:
                shutil.copy2(target, backup)
            backed_up.append(rel)
            beat()
        if backed_up:
            with open(os.path.join(batch, 'manifest.json'), 'w', encoding='utf-8') as output:
                json.dump({'kind': 'import', 'createdAt': int(time.time()), 'files': backed_up}, output, separators=(',', ':'))
            return batch, set(backed_up)
        shutil.rmtree(batch, ignore_errors=True)
        return None, set()
    except Exception:
        shutil.rmtree(batch, ignore_errors=True)
        raise

def main(op, root):
    if not os.path.isabs(root):
        die('root must be absolute')
    root = os.path.realpath(root)
    if root == os.path.sep:
        die('repository root must not be the filesystem root')
    if op == 'export-tar':
        lock_path = owner_path = None
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            errors, _live = validate_repository(root, require_index=True, beat=beat)
            if errors:
                die('repository validation failed: %s' % '; '.join(errors[:20]))
            with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as out:
                for rel, full, _size in repository_files(root):
                    out.add(full, arcname=rel, recursive=False)
                    beat()
        except Exception as error:
            die('export failed: %s' % error)
        finally:
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    elif op == 'import-tar':
        lock_path = owner_path = stage = recovery_batch = None
        backed_up = set()
        published = []
        try:
            os.makedirs(root, exist_ok=True)
            stage = tempfile.mkdtemp(prefix='.notebook-next-import-', dir=root)
            total = 0
            members = set()
            with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
                for member in archive:
                    rel = safe(member.name)
                    if not rel or not allowed(rel):
                        raise ValueError('unsafe path: %s' % member.name)
                    if rel in members:
                        raise ValueError('duplicate archive member: %s' % member.name)
                    members.add(rel)
                    if not member.isfile():
                        raise ValueError('unsupported archive member: %s' % member.name)
                    if member.size < 0 or member.size > MAX_FILE_BYTES:
                        raise ValueError('archive member exceeds 100 MB: %s' % member.name)
                    total += member.size
                    if total > MAX_REPOSITORY_BYTES:
                        raise ValueError('archive exceeds 512 MB')
                    target = safe_path(stage, rel)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        raise ValueError('cannot extract archive member: %s' % member.name)
                    with open(target, 'wb') as out:
                        written = 0
                        while True:
                            chunk = extracted.read(65536)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > MAX_FILE_BYTES:
                                raise ValueError('archive member exceeds 100 MB: %s' % member.name)
                            out.write(chunk)
            errors, _live = validate_repository(stage, require_index=True)
            if errors:
                raise ValueError('repository validation failed: %s' % '; '.join(errors[:20]))
            staged = [(rel, full) for rel, full, _size in repository_files(stage)]
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            recovery_batch, backed_up = create_import_recovery(root, staged, beat)
            # Publish the index last, matching normal SFTP synchronization, so
            # readers never observe an index that references unpublished files.
            staged.sort(key=lambda item: (item[0] == 'notes/index.json', item[0]))
            for rel, full in staged:
                target = safe_path(root, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                existed = os.path.exists(target)
                os.replace(full, target)
                published.append((rel, existed))
                beat()
            recovery_rel = posixpath.relpath(recovery_batch, root) if recovery_batch else None
            print(json.dumps({'ok': True, 'recovery': recovery_rel}))
        except Exception as error:
            for rel, existed in reversed(published):
                target = safe_path(root, rel)
                backup = os.path.join(recovery_batch, *rel.split('/')) if recovery_batch else None
                try:
                    if existed and backup and os.path.isfile(backup):
                        os.replace(backup, target)
                    elif not existed and os.path.isfile(target):
                        os.remove(target)
                except OSError:
                    pass
            die('import failed: %s' % error)
        finally:
            if stage:
                shutil.rmtree(stage, ignore_errors=True)
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    elif op == 'verify':
        lock_path = owner_path = None
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            errors, _live = validate_repository(root, require_index=True, beat=beat)
            print(json.dumps({'ok': not errors, 'errors': errors}))
        except Exception as error:
            die('verify failed: %s' % error)
        finally:
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    elif op == 'gc':
        lock_path = owner_path = None
        batch = None
        moved_objects = []
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            errors, live_objects = validate_repository(root, require_index=True, beat=beat, for_gc=True)
            if errors:
                raise ValueError('repository validation failed: %s' % '; '.join(errors[:20]))
            now = time.time()
            recovery = recovery_root(root)
            purged = 0
            for name in sorted(os.listdir(recovery)):
                batch = os.path.join(recovery, name)
                if not name.startswith('gc-') or not os.path.isdir(batch):
                    continue
                if now - os.path.getmtime(batch) < GC_QUARANTINE_SECONDS:
                    continue
                for _dirpath, _dirnames, filenames in os.walk(batch):
                    purged += len([filename for filename in filenames if filename != 'manifest.json'])
                shutil.rmtree(batch)
                beat()
            candidates = []
            objects_dir = os.path.join(root, 'objects')
            if os.path.isdir(objects_dir):
                for prefix in sorted(os.listdir(objects_dir)):
                    prefix_dir = os.path.join(objects_dir, prefix)
                    if not os.path.isdir(prefix_dir) or os.path.islink(prefix_dir):
                        continue
                    for name in sorted(os.listdir(prefix_dir)):
                        full = os.path.join(prefix_dir, name)
                        if name.lower() in live_objects or not os.path.isfile(full) or os.path.islink(full):
                            continue
                        if now - os.path.getmtime(full) < GC_GRACE_SECONDS:
                            continue
                        candidates.append(('objects/%s/%s' % (prefix, name), full, os.path.getsize(full)))
                        beat()
            if candidates:
                batch = os.path.join(recovery, 'gc-%d-%s' % (int(now), uuid.uuid4()))
                for rel, full, size in candidates:
                    target = os.path.join(batch, *rel.split('/'))
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    os.replace(full, target)
                    moved_objects.append((rel, full, target, size))
                    beat()
                with open(os.path.join(batch, 'manifest.json'), 'w', encoding='utf-8') as output:
                    json.dump({'kind': 'gc', 'createdAt': int(now), 'purgeAfter': int(now + GC_QUARANTINE_SECONDS), 'objects': [{'path': rel, 'size': size, 'hash': rel.split('/')[-1]} for rel, _full, _target, size in moved_objects]}, output, separators=(',', ':'))
            print(json.dumps({
                'ok': True,
                'quarantined': len(candidates),
                'purged': purged,
                'graceDays': GC_GRACE_SECONDS // (24 * 60 * 60),
                'retentionDays': GC_QUARANTINE_SECONDS // (24 * 60 * 60),
                'recovery': posixpath.relpath(batch, root) if batch else None,
            }))
        except Exception as error:
            for _rel, original, quarantined, _size in reversed(moved_objects):
                try:
                    os.makedirs(os.path.dirname(original), exist_ok=True)
                    if os.path.isfile(quarantined) and not os.path.exists(original):
                        os.replace(quarantined, original)
                except OSError:
                    pass
            if batch:
                shutil.rmtree(batch, ignore_errors=True)
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
  const credentials = await buildSshCredentials(settings)
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
        host: settings.host.trim(), port: settings.port, username: settings.username.trim(),
        password: credentials.password, privateKey: credentials.privateKey, passphrase: credentials.passphrase,
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

function execCommand(client: Client, command: string, input?: Uint8Array, maximumStdout = MAX_REPOSITORY_BYTES, timeoutMs = HELPER_COMMAND_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return }
      const chunks: Buffer[] = []
      let stdoutBytes = 0
      let stderr = ''
      let stderrBytes = 0
      let settled = false
      let timeout: NodeJS.Timeout | undefined
      const onClientError = (reason: Error) => {
        rejectOnce(reason)
        stream.close()
      }
      const cleanup = () => {
        client.removeListener('error', onClientError)
        if (timeout) clearTimeout(timeout)
      }
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
      timeout = setTimeout(() => {
        rejectOnce(new Error(`服务器 helper 执行超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已终止`))
        stream.close()
      }, timeoutMs)
      stream.on('data', (chunk: Buffer) => {
        if (settled) return
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > maximumStdout) {
          rejectOnce(new Error(`服务器 helper 输出超过 ${Math.floor(maximumStdout / 1024 / 1024)} MB 上限`))
          stream.close()
          return
        }
        chunks.push(chunk)
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        if (settled) return
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_HELPER_STDERR_BYTES) {
          rejectOnce(new Error('服务器 helper 错误输出超过 16 MB 上限'))
          stream.close()
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
  if (input && input.byteLength > MAX_HELPER_ARCHIVE_BYTES) throw new Error(`待导入归档超过 ${Math.floor(MAX_HELPER_ARCHIVE_BYTES / 1024 / 1024)} MB 传输上限`)
  const client = await connectExec(settings)
  try {
    const cwdResult = await execCommand(client, 'pwd', undefined, 1024 * 1024, HELPER_PROBE_TIMEOUT_MS)
    if (cwdResult.code !== 0) throw new Error(cwdResult.stderr.trim() || '无法确定 SSH 用户主目录')
    const home = cwdResult.stdout.length ? new TextDecoder().decode(cwdResult.stdout).trim() : ''
    if (!home.startsWith('/')) throw new Error('服务器返回了无效的 SSH 用户主目录')
    const configured = settings.remotePath.trim()
    const root = configured === '~' ? home : configured.startsWith('~/') ? posix.join(home, configured.slice(2)) : configured.startsWith('/') ? posix.normalize(configured) : posix.join(home, configured)
    const result = await execCommand(client, helperCommand(operation, root), input, operation === 'export-tar' ? MAX_HELPER_ARCHIVE_BYTES : MAX_HELPER_STDERR_BYTES)
    const stderrMessage = (() => {
      const raw = result.stderr.trim()
      if (!raw) return ''
      for (const line of raw.split(/\r?\n/).reverse()) {
        try {
          const value = JSON.parse(line) as { error?: unknown }
          if (typeof value.error === 'string') return value.error
        } catch { /* preserve raw stderr below */ }
      }
      return raw
    })()
    if (operation === 'export-tar') {
      // The tar stream is raw; a failed helper prints a JSON error to stderr.
      if (result.code !== 0 || result.stdout.byteLength === 0) {
        throw new Error(stderrMessage || `服务器 helper 导出失败（退出码 ${result.code}）`)
      }
      return { ok: true, data: result.stdout, message: `${result.stdout.byteLength} 字节` }
    }
    let parsed: { ok?: boolean; error?: string; errors?: string[]; quarantined?: number; purged?: number; graceDays?: number; retentionDays?: number; recovery?: string | null }
    try {
      parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as typeof parsed
    } catch {
      throw new Error(stderrMessage || `服务器 helper 返回了无法解析的结果（退出码 ${result.code}）`)
    }
    if (operation === 'verify') {
      const errors = parsed.errors ?? []
      if (result.code !== 0 || parsed.ok === false || errors.length) {
        throw new Error(errors.length ? `仓库校验发现 ${errors.length} 个问题：${errors.join('；')}` : (parsed.error ?? stderrMessage) || '服务器 helper 校验失败')
      }
      return { ok: true, message: '仓库校验通过' }
    }
    if (result.code !== 0 || parsed.ok === false) throw new Error((parsed.error ?? stderrMessage) || '服务器 helper 执行失败')
    if (operation === 'gc') {
      const recovery = parsed.recovery ? `，恢复目录：${parsed.recovery}` : ''
      return { ok: true, message: `已隔离 ${parsed.quarantined ?? 0} 个孤儿对象，永久清除 ${parsed.purged ?? 0} 个过期隔离对象${recovery}` }
    }
    return { ok: true, message: parsed.recovery ? `仓库已导入；覆盖前文件保存在 ${parsed.recovery}` : '仓库已导入' }
  } finally {
    client.end()
  }
}
