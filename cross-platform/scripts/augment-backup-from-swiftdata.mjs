import { readFile, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import Database from '../services/collaboration/node_modules/better-sqlite3/lib/index.js'
import { strFromU8, strToU8, unzipSync, zipSync } from '../apps/web/node_modules/fflate/esm/index.mjs'
import { legacyDocumentToTiptap } from '../packages/sync-contract/src/importer.ts'

const args = new Map(Array.from({ length: Math.floor(process.argv.slice(2).length / 2) }, (_, index) => {
  const offset = index * 2 + 2
  return [process.argv[offset], process.argv[offset + 1]]
}))
const input = args.get('--backup')
const databasePath = args.get('--database')
const output = args.get('--output')
if (!input || !databasePath || !output) {
  throw new Error('Usage: node augment-backup-from-swiftdata.mjs --backup <zip> --database <store> --output <zip>')
}

const appleEpochMs = Date.UTC(2001, 0, 1)
const appleDate = (seconds) => new Date(appleEpochMs + Number(seconds) * 1000).toISOString()
const uuid = (value) => {
  const hex = Buffer.from(value).toString('hex').toUpperCase()
  if (hex.length !== 32) throw new Error(`Invalid UUID blob length: ${hex.length}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const snapshotJSON = (value) => {
  const data = Buffer.from(value)
  const magic = Buffer.from('NBKSNPZ1')
  if (!data.subarray(0, magic.length).equals(magic)) return data.toString('utf8')
  if (data.length <= 16) throw new Error('Compressed snapshot header is truncated')
  const expectedSize = Number(data.readBigUInt64LE(8))
  const decoded = inflateRawSync(data.subarray(16))
  if (decoded.length !== expectedSize) throw new Error(`Compressed snapshot size mismatch: ${decoded.length}/${expectedSize}`)
  return decoded.toString('utf8')
}

const files = unzipSync(new Uint8Array(await readFile(input)))
const rootFile = files['notebook-next.json']
if (!rootFile) throw new Error('Notebook Next backup is missing notebook-next.json')
const payload = JSON.parse(strFromU8(rootFile))
if (payload?.schemaVersion !== 1 || !payload.bundle) throw new Error('Unsupported Notebook Next backup')
const bundle = payload.bundle
const workspaceId = bundle.notebooks[0]?.workspaceId
if (!workspaceId) throw new Error('Backup does not contain a workspace')
const pageIds = new Set(bundle.pages.map((item) => item.id.toUpperCase()))

const database = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const versionRows = database.prepare(`
    SELECT ZID AS id, ZNOTEID AS noteId, ZRECORDEDAT AS recordedAt, ZUPDATEDAT AS updatedAt,
           ZSNAPSHOTDATA AS snapshotData
    FROM ZBLOCKDOCUMENTNOTEVERSIONENTITY
  `).all()
  const revisions = versionRows.flatMap((row) => {
    const pageId = uuid(row.noteId)
    if (!pageIds.has(pageId)) return []
    const snapshot = JSON.parse(snapshotJSON(row.snapshotData))
    if (!snapshot?.document?.blocks) return []
    return [{
      id: uuid(row.id), pageId, createdAt: appleDate(row.recordedAt), reason: 'import',
      document: {
        pageId, schemaVersion: 1, tiptapJson: legacyDocumentToTiptap(snapshot.document),
        legacySource: snapshot.document, updatedAt: appleDate(row.updatedAt),
      },
    }]
  })

  const positions = database.prepare(`
    SELECT ZNOTEID AS noteId, ZANCHORUTF16OFFSET AS anchorOffset,
           ZVIEWPORTOFFSETFRACTION AS viewportOffset, ZUPDATEDAT AS updatedAt, ZDEVICEID AS deviceId
    FROM ZBLOCKDOCUMENTREADINGPOSITIONENTITY
  `).all().flatMap((row) => {
    const pageId = uuid(row.noteId)
    return pageIds.has(pageId) ? [{
      id: pageId, pageId, anchorUtf16Offset: Number(row.anchorOffset),
      viewportOffsetFraction: Number(row.viewportOffset), updatedAt: appleDate(row.updatedAt),
      deviceId: row.deviceId || 'legacy-macos',
    }] : []
  })

  const tombstones = database.prepare(`
    SELECT ZNOTEID AS noteId, ZDELETEDAT AS deletedAt, ZDELETEDBYDEVICEID AS deviceId
    FROM ZBLOCKDOCUMENTDELETEDNOTETOMBSTONEENTITY
  `).all().map((row) => {
    const entityId = uuid(row.noteId)
    return {
      id: `page:${entityId}`, workspaceId, entityType: 'page', entityId,
      deletedAt: appleDate(row.deletedAt), deviceId: row.deviceId || 'legacy-macos',
    }
  })

  const mergeById = (current, additions) => [...new Map([...current, ...additions].map((item) => [item.id, item])).values()]
  bundle.revisions = mergeById(bundle.revisions ?? [], revisions)
  bundle.readingPositions = mergeById(bundle.readingPositions ?? [], positions)
  bundle.tombstones = mergeById(bundle.tombstones ?? [], tombstones)
  payload.exportedAt = new Date().toISOString()
  files['notebook-next.json'] = strToU8(JSON.stringify(payload))
  await writeFile(output, zipSync(files, { level: 6 }))
  console.log(JSON.stringify({
    pages: bundle.pages.length,
    revisions: bundle.revisions.length,
    readingPositions: bundle.readingPositions.length,
    tombstones: bundle.tombstones.length,
    skippedVersions: versionRows.length - revisions.length,
  }))
} finally {
  database.close()
}
