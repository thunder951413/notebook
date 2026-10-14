import { posix } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** On-disk layout of the legacy SSH repository: allowed paths, the index and compressed notes. */

export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_REPOSITORY_BYTES = 512 * 1024 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isUuid = (value: string | undefined): value is string => Boolean(value && uuidPattern.test(value))
const COMPRESSED_REPOSITORY_VERSION = 2
const compressedRepositoryFormat = Object.freeze({
  version: COMPRESSED_REPOSITORY_VERSION,
  noteEncoding: 'gzip',
  notePathPattern: 'notes/{noteID}.json.gz',
  jsonEncoding: 'utf-8',
  historyEncoding: 'full-snapshot-deduplicated',
})
export function safeRelativePath(value: string) {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) throw new Error(`远端仓库包含不安全路径：${value}`)
  return normalized
}

export function isAllowedRepositoryFile(value: string) {
  const name = safeRelativePath(value)
  if (['library.json', 'notes/index.json', 'notes/reading_positions.json', 'notes/assets_manifest.json', 'notes/privacy.json'].includes(name)) return true
  if (/^notes\/[0-9a-f-]{36}\.json$/i.test(name)) return uuidPattern.test(name.slice('notes/'.length, -'.json'.length))
  if (/^objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/i.test(name)) return true
  return name.startsWith('attachments/') && name.length > 'attachments/'.length
}

export function usesCompressedNotes(index: Buffer | undefined) {
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

export function compactJson(value: Buffer) {
  return Buffer.from(JSON.stringify(JSON.parse(value.toString('utf8'))))
}

export function compressedNotePath(noteId: string) {
  return `notes/${noteId}.json.gz`
}

export function encodeCompressedIndex(value: Buffer) {
  const parsed = JSON.parse(value.toString('utf8')) as Record<string, unknown>
  const format = parsed.repositoryFormat as { version?: number; noteEncoding?: string } | undefined
  if (format?.version !== 3 || format.noteEncoding !== 'gzip') parsed.repositoryFormat = compressedRepositoryFormat
  return Buffer.from(JSON.stringify(parsed))
}

export function decodeCompressedNote(value: Buffer, name: string) {
  try {
    return compactJson(gunzipSync(value, { maxOutputLength: MAX_FILE_BYTES }))
  } catch (error) {
    throw new Error(`无法解压远端笔记：${name}`, { cause: error })
  }
}

