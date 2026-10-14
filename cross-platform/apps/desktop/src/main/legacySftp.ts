import { posix } from 'node:path'
import { gzipSync } from 'node:zlib'
import { acquireLock, atomicWrite, maintainLock, releaseLock, verifyOnWrite } from './legacySftp/lock'
import { MAX_FILE_BYTES, MAX_REPOSITORY_BYTES, compactJson, compressedNotePath, decodeCompressedNote, encodeCompressedIndex, isAllowedRepositoryFile, isUuid, normalizeRepositoryIndex, safeRelativePath, usesCompressedNotes } from './legacySftp/repositoryFormat'
import { listOptional, readOptional, sessionFor } from './legacySftp/session'
import type { LegacySftpFile, LegacySftpPullOptions, LegacySftpPullResult, LegacySftpPushOptions, LegacySshConnection } from './legacySftp/types'
import { cacheBuffer, mapWithConcurrency, sha256 } from './legacySftp/util'

export type { LegacySshConnection, LegacySftpFile, LegacySftpPullOptions, LegacySftpPushOptions, LegacySftpPullResult, LegacySftpConnectionResult, LegacySftpHelperResult } from './legacySftp/types'
export { normalizeRepositoryIndex } from './legacySftp/repositoryFormat'
export { releaseLegacySession, testLegacyConnection } from './legacySftp/session'
export { runRepositoryHelper } from './legacySftp/helper'

const TRANSFER_CONCURRENCY = 4
const pulledNoteCache = new Map<string, { signature: string; data: Buffer }>()
const pulledObjectCache = new Map<string, { contentHash: string; data: Buffer }>()
const MAX_NOTE_CACHE_BYTES = 128 * 1024 * 1024
const MAX_OBJECT_CACHE_BYTES = 64 * 1024 * 1024

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

