import SftpClient from 'ssh2-sftp-client'
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

export interface LegacySftpFile { name: string; dataBase64: string }
export interface LegacySftpPullOptions {
  knownObjectHashes?: string[]
  knownNoteSignatures?: Array<{ noteID: string; signature: string }>
}
export interface LegacySftpPullResult {
  files: LegacySftpFile[]
  indexHash: string
  fingerprint: string
  objectHashes: string[]
  reusedObjectCount: number
  reusedNoteIds: string[]
}

export interface LegacySftpConnectionResult {
  fingerprint: string
  remotePath: string
  remotePathExists: boolean
  latencyMs: number
}

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_REPOSITORY_BYTES = 512 * 1024 * 1024
const LOCK_RETRIES = 30
const LOCK_STALE_MS = 30 * 60 * 1000
const LOCK_HEARTBEAT_MS = 60 * 1000
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

async function readOptional(client: SftpClient, path: string): Promise<Buffer | undefined> {
  if (!(await client.exists(path))) return undefined
  const stats = await client.stat(path)
  if (stats.size > MAX_FILE_BYTES) throw new Error(`远端文件超过 100 MB：${posix.basename(path)}`)
  const value = await client.get(path)
  if (!Buffer.isBuffer(value)) throw new Error(`无法读取远端文件：${path}`)
  return value
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

async function atomicWrite(client: SftpClient, path: string, data: Buffer) {
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`文件超过 100 MB：${posix.basename(path)}`)
  await client.mkdir(posix.dirname(path), true)
  const temporary = `${path}.tmp.notebook-next.${randomUUID()}`
  try {
    await client.put(data, temporary)
    const check = await readOptional(client, temporary)
    if (!check || sha256(check) !== sha256(data)) throw new Error(`远端临时文件校验失败：${posix.basename(path)}`)
    try { await client.posixRename(temporary, path) }
    catch { if (await client.exists(path)) await client.delete(path); await client.rename(temporary, path) }
  } catch (error) {
    await client.delete(temporary, true).catch(() => undefined)
    throw error
  }
}

export async function pullLegacyRepository(settings: LegacySshConnection, options: LegacySftpPullOptions = {}): Promise<LegacySftpPullResult> {
  const { client, root, fingerprint: actualFingerprint } = await connect(settings)
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
    const add = async (name: string, remoteName = name, transform?: (value: Buffer) => Buffer) => {
      if (files.has(name)) return
      const remoteValue = await readOptional(client, posix.join(root, remoteName))
      if (!remoteValue) return
      const value = transform ? transform(remoteValue) : remoteValue
      addValue(name, value)
    }
    // Pulls are optimistic snapshots. Publishing clients write the index last;
    // reading it both before and after avoids holding the cross-device write
    // lock during a potentially large download and prevents killed readers
    // from leaving Android blocked behind a stale lock.
    const remoteIndex = await readOptional(client, posix.join(root, 'notes/index.json'))
    if (remoteIndex) addValue('notes/index.json', remoteIndex)
    await add('library.json'); await add('notes/reading_positions.json'); await add('notes/assets_manifest.json'); await add('notes/privacy.json')
    const index = remoteIndex ? normalizeRepositoryIndex(remoteIndex) : undefined
    if (index) files.set('notes/index.json', index)
    if (index) {
      const parsed = JSON.parse(index.toString('utf8')) as { entries?: Array<{ noteID?: string; version?: number; contentHash?: string; historyCount?: number }> }
      const compressed = usesCompressedNotes(index)
      for (const entry of parsed.entries ?? []) if (isUuid(entry.noteID)) {
        const name = `notes/${entry.noteID}.json`
        const cacheKey = `${cacheNamespace}:${entry.noteID}`
        const signature = `${entry.version ?? 0}:${entry.contentHash ?? ''}:${entry.historyCount ?? 0}:${compressed ? 'gzip' : 'json'}`
        if (knownNoteSignatures.get(entry.noteID) === signature) {
          reusedNoteIds.push(entry.noteID)
          continue
        }
        const cached = pulledNoteCache.get(cacheKey)
        if (cached?.signature === signature) addValue(name, cached.data)
        else {
          if (compressed) await add(name, compressedNotePath(entry.noteID), (value) => decodeCompressedNote(value, name))
          else await add(name)
          const data = files.get(name)
          if (data) cacheBuffer(pulledNoteCache, cacheKey, { signature, data }, MAX_NOTE_CACHE_BYTES)
        }
      }
    }
    const manifest = files.get('notes/assets_manifest.json')
    if (manifest) {
      const parsed = JSON.parse(manifest.toString('utf8')) as { entries?: Array<{ relativePath?: string; contentHash?: string }> }
      for (const entry of parsed.entries ?? []) if (typeof entry.relativePath === 'string') {
        const relative = safeRelativePath(entry.relativePath)
        const name = relative.startsWith('objects/') ? relative : `attachments/${relative}`
        const contentHash = entry.contentHash?.toLowerCase()
        if (contentHash && /^[0-9a-f]{64}$/.test(contentHash)) remoteObjectHashes.add(contentHash)
        if (contentHash && knownObjectHashes.has(contentHash)) {
          reusedObjectCount += 1
          continue
        }
        const cacheKey = `${cacheNamespace}:${name}`
        const cached = entry.contentHash ? pulledObjectCache.get(cacheKey) : undefined
        if (cached && cached.contentHash === entry.contentHash) addValue(name, cached.data)
        else {
          await add(name)
          const data = files.get(name)
          if (data && entry.contentHash) cacheBuffer(pulledObjectCache, cacheKey, { contentHash: entry.contentHash, data }, MAX_OBJECT_CACHE_BYTES)
        }
      }
    }
    const finalIndex = await readOptional(client, posix.join(root, 'notes/index.json'))
    if ((finalIndex ? sha256(finalIndex) : '') !== (remoteIndex ? sha256(remoteIndex) : '')) {
      throw new Error('远端索引在拉取期间已变化，请重新同步')
    }
    return {
      files: [...files].map(([name, data]) => ({ name, dataBase64: data.toString('base64') })),
      indexHash: remoteIndex ? sha256(remoteIndex) : '',
      fingerprint: actualFingerprint,
      objectHashes: [...remoteObjectHashes],
      reusedObjectCount,
      reusedNoteIds,
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function pushLegacyRepository(settings: LegacySshConnection, files: LegacySftpFile[], expectedIndexHash: string) {
  const { client, root, fingerprint: actualFingerprint } = await connect(settings)
  let lock: { lockPath: string; ownerPath: string; owner: string } | undefined
  let finishHeartbeat: (() => Promise<void>) | undefined
  try {
    const normalized = files.map((file) => ({ name: safeRelativePath(file.name), data: Buffer.from(file.dataBase64, 'base64') }))
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
    const priority = (name: string) => name === 'library.json' ? 0 : name.startsWith('attachments/') || name.startsWith('objects/') ? 1 : name === 'notes/assets_manifest.json' ? 2 : /^notes\/[0-9a-f-]{36}\.json\.gz$/i.test(name) ? 3 : name === 'notes/privacy.json' ? 4 : name === 'notes/reading_positions.json' ? 5 : 6
    encoded.sort((left, right) => priority(left.name) - priority(right.name) || left.name.localeCompare(right.name))
    for (const file of encoded) {
      if (file.name.startsWith('objects/') && await client.exists(posix.join(root, file.name))) continue
      await atomicWrite(client, posix.join(root, file.name), file.data)
    }
    await finishHeartbeat()
    finishHeartbeat = undefined
    return { fingerprint: actualFingerprint }
  } finally {
    if (finishHeartbeat) await finishHeartbeat().catch(() => undefined)
    if (lock) await releaseLock(client, lock)
    await client.end().catch(() => undefined)
  }
}
