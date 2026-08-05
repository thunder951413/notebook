import { createServer } from 'node:net'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { normalizeRepositoryIndex, pullLegacyRepository, pushLegacyRepository, releaseLegacySession, runRepositoryHelper, testLegacyConnection } from './legacySftp'

const enabled = process.env.NOTEBOOK_SFTP_E2E === '1'
let root = ''
let port = 0
let fingerprint = ''
let server: ReturnType<typeof spawn> | undefined

const encode = (value: string) => new TextEncoder().encode(value)
const bytes = (value: Uint8Array) => Buffer.from(value)
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

function tar(entries: Array<{ name: string; data: Uint8Array }>) {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data)
    const header = Buffer.alloc(512)
    const writeOctal = (offset: number, length: number, value: number) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
    header.write(entry.name, 0, 100, 'utf8')
    writeOctal(100, 8, 0o644)
    writeOctal(108, 8, 0)
    writeOctal(116, 8, 0)
    writeOctal(124, 12, data.byteLength)
    writeOctal(136, 12, Math.floor(Date.now() / 1000))
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    const checksum = header.reduce((total, byte) => total + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    chunks.push(header, data)
    const padding = (512 - data.byteLength % 512) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function tarNames(archive: Uint8Array) {
  const data = Buffer.from(archive)
  const names: string[] = []
  for (let offset = 0; offset + 512 <= data.byteLength;) {
    const header = data.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeText || '0', 8)
    names.push(name)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

const helperSettings = (remotePath: string) => ({ host: '127.0.0.1', port, username: 'notebook', password: 'test-password', remotePath, fingerprint })

async function writeHelperRepository(remotePath: string) {
  const repository = join(root, remotePath)
  const noteId = '30000000-0000-4000-8000-000000000004'
  const body = '# Repository helper\n'
  const contentHash = digest(body)
  const object = Buffer.from('referenced object')
  const objectHash = digest(object)
  await mkdir(join(repository, 'notes'), { recursive: true })
  await mkdir(join(repository, 'objects', objectHash.slice(0, 2)), { recursive: true })
  await writeFile(join(repository, 'library.json'), '{"folders":[],"tags":[]}')
  await writeFile(join(repository, 'notes', `${noteId}.json.gz`), gzipSync(JSON.stringify({ schemaVersion: 3, noteID: noteId, metadata: { id: noteId }, currentContentHash: contentHash, contentObjects: { [contentHash]: body }, history: [], assets: [] })))
  await writeFile(join(repository, 'notes', 'assets_manifest.json'), JSON.stringify({ entries: [{ relativePath: `objects/${objectHash.slice(0, 2)}/${objectHash}`, contentHash: objectHash, size: object.byteLength }] }))
  await writeFile(join(repository, 'objects', objectHash.slice(0, 2), objectHash), object)
  await writeFile(join(repository, 'notes', 'index.json'), JSON.stringify({ repositoryFormat: { version: 3, noteEncoding: 'gzip', contentFormat: 'markdown-gfm', assetAddressing: 'sha256' }, entries: [{ noteID: noteId, version: 1, contentHash }] }))
  return { repository, noteId, object, objectHash }
}

test('normalizes duplicate index rows by highest version and newest deletion', () => {
  const noteId = '30000000-0000-4000-8000-000000000001'
  const normalized = JSON.parse(normalizeRepositoryIndex(Buffer.from(JSON.stringify({
    repositoryFormat: { version: 3 },
    entries: [{ noteID: noteId, version: 9, contentHash: 'new' }, { noteID: noteId, version: 2, contentHash: 'old' }],
    deletedEntries: [{ noteID: noteId, deletedAt: '2026-01-01T00:00:00.000Z' }, { noteID: noteId, deletedAt: '2026-02-01T00:00:00.000Z' }],
  }))).toString('utf8'))
  expect(normalized.entries).toEqual([{ noteID: noteId, version: 9, contentHash: 'new' }])
  expect(normalized.deletedEntries).toEqual([{ noteID: noteId, deletedAt: '2026-02-01T00:00:00.000Z' }])
})

test('normalizes equal-version index rows independently of JSON field order', () => {
  const noteId = '30000000-0000-4000-8000-000000000001'
  const left = { noteID: noteId, version: 9, contentHash: 'aaa', historyCount: 2 }
  const right = { historyCount: 2, contentHash: 'bbb', version: 9, noteID: noteId }
  const forward = normalizeRepositoryIndex(Buffer.from(JSON.stringify({ entries: [left, right] })))
  const reverse = normalizeRepositoryIndex(Buffer.from(JSON.stringify({ entries: [right, left] })))
  expect(forward.equals(reverse)).toBe(true)
  expect(JSON.parse(forward.toString('utf8')).entries).toEqual([right])
})

async function availablePort() {
  const socket = createServer()
  await new Promise<void>((resolveReady) => socket.listen(0, '127.0.0.1', resolveReady))
  const address = socket.address()
  const value = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolveClosed) => socket.close(() => resolveClosed()))
  return value
}

beforeAll(async () => {
  if (!enabled) return
  root = await mkdtemp(join(tmpdir(), 'notebook-sftp-e2e-'))
  port = await availablePort()
  const script = resolve(import.meta.dirname, '../../../../../notebook_android/scripts/test_sftp_server.py')
  server = spawn(process.env.NOTEBOOK_SFTP_PYTHON ?? 'python3', [script, '--root', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  fingerprint = await new Promise<string>((resolveFingerprint, reject) => {
    let errors = ''
    const timeout = setTimeout(() => reject(new Error('SFTP test server did not start')), 10_000)
    server?.stdout?.once('data', (value) => { clearTimeout(timeout); resolveFingerprint(String(value).trim()) })
    server?.stderr?.on('data', (value) => { errors += String(value) })
    server?.once('exit', (code) => { if (!fingerprint) { clearTimeout(timeout); reject(new Error(`SFTP test server exited (${code}): ${errors}`)) } })
    server?.once('error', reject)
  })
}, 20_000)

afterAll(async () => {
  server?.kill('SIGTERM')
  if (root) await rm(root, { recursive: true, force: true })
})

test.runIf(enabled)('uploads atomically and pulls an Android-compatible SSH repository', async () => {
  const settings = { host: '127.0.0.1', port, username: 'notebook', password: 'test-password', remotePath: 'repository', fingerprint }
  const connection = await testLegacyConnection(settings)
  expect(connection).toMatchObject({ fingerprint, remotePathExists: false })
  expect(connection.latencyMs).toBeGreaterThanOrEqual(0)
  const empty = await pullLegacyRepository(settings)
  expect(empty.indexHash).toBe('')
  expect(empty.fingerprint).toBe(fingerprint)
  expect(empty.sessionId).toBeTruthy()
  const noteId = '30000000-0000-4000-8000-000000000001'
  const files = [
    { name: 'library.json', data: encode('{"folders":[],"tags":[]}') },
    { name: `notes/${noteId}.json`, data: encode('{"noteID":"test"}') },
    { name: 'notes/assets_manifest.json', data: encode('{"entries":[{"relativePath":"page/image.png"}]}') },
    { name: 'attachments/page/image.png', data: new Uint8Array([1, 2, 3]) },
    { name: 'notes/index.json', data: encode(JSON.stringify({ entries: [{ noteID: noteId }] })) },
  ]
  // The push reuses the pull's SSH session instead of opening a second connection.
  await pushLegacyRepository(settings, files, empty.indexHash, { sessionId: empty.sessionId })
  const physicalNote = await readFile(join(root, 'repository', 'notes', `${noteId}.json.gz`))
  expect(JSON.parse(gunzipSync(physicalNote).toString('utf8'))).toEqual({ noteID: 'test' })
  await expect(access(join(root, 'repository', 'notes', `${noteId}.json`))).rejects.toThrow()
  const physicalIndex = JSON.parse(await readFile(join(root, 'repository', 'notes', 'index.json'), 'utf8'))
  expect(physicalIndex.repositoryFormat).toMatchObject({ version: 2, noteEncoding: 'gzip' })
  const pulled = await pullLegacyRepository(settings)
  expect(pulled.files.map((item) => item.name).sort()).toEqual(files.map((item) => item.name).sort())
  expect(bytes(pulled.files.find((item) => item.name === 'attachments/page/image.png')!.data)).toEqual(Buffer.from([1, 2, 3]))
  await releaseLegacySession(pulled.sessionId)
  await expect(pullLegacyRepository({ ...settings, fingerprint: 'SHA256:wrong' })).rejects.toThrow(/指纹已变化/)
})

test.runIf(enabled)('round-trips a v3 Markdown repository with content-addressed resources', async () => {
  const settings = { host: '127.0.0.1', port, username: 'notebook', password: 'test-password', remotePath: 'repository-v3', fingerprint }
  const empty = await pullLegacyRepository(settings)
  const noteId = '30000000-0000-4000-8000-000000000003'
  const objectHash = 'a'.repeat(64)
  const note = { schemaVersion: 3, noteID: noteId, currentContentHash: 'b'.repeat(64), contentObjects: { ['b'.repeat(64)]: '# Markdown' }, history: [] }
  const files = [
    { name: 'library.json', data: encode('{"folders":[],"tags":[]}') },
    { name: `notes/${noteId}.json`, data: encode(JSON.stringify(note)) },
    { name: 'notes/assets_manifest.json', data: encode(JSON.stringify({ entries: [{ relativePath: `objects/aa/${objectHash}`, contentHash: objectHash }] })) },
    { name: `objects/aa/${objectHash}`, data: new Uint8Array([4, 5, 6]) },
    { name: 'notes/index.json', data: encode(JSON.stringify({ repositoryFormat: { version: 3, noteEncoding: 'gzip', contentFormat: 'markdown-gfm', assetAddressing: 'sha256' }, entries: [{ noteID: noteId }] })) },
  ]
  await pushLegacyRepository(settings, files, empty.indexHash)
  const physicalIndex = JSON.parse(await readFile(join(root, 'repository-v3', 'notes', 'index.json'), 'utf8'))
  expect(physicalIndex.repositoryFormat.version).toBe(3)
  expect(JSON.parse(gunzipSync(await readFile(join(root, 'repository-v3', 'notes', `${noteId}.json.gz`))).toString('utf8'))).toEqual(note)
  expect(await readFile(join(root, 'repository-v3', 'objects', 'aa', objectHash))).toEqual(Buffer.from([4, 5, 6]))
  const pulled = await pullLegacyRepository(settings)
  expect(JSON.parse(bytes(pulled.files.find((item) => item.name === `notes/${noteId}.json`)!.data).toString('utf8'))).toEqual(note)
  expect(bytes(pulled.files.find((item) => item.name === `objects/aa/${objectHash}`)!.data)).toEqual(Buffer.from([4, 5, 6]))
  expect(pulled.objectHashes).toContain(objectHash)
  const incremental = await pullLegacyRepository(settings, { knownObjectHashes: [objectHash] })
  expect(incremental.files.some((item) => item.name === `objects/aa/${objectHash}`)).toBe(false)
  expect(incremental.reusedObjectCount).toBe(1)
  // metadataOnly skips note bodies and objects while still returning the index.
  const metadata = await pullLegacyRepository(settings, { metadataOnly: true, knownObjectHashes: [objectHash] })
  expect(metadata.files.some((item) => item.name === `notes/${noteId}.json`)).toBe(false)
  expect(metadata.files.some((item) => item.name === `objects/aa/${objectHash}`)).toBe(false)
  expect(metadata.files.some((item) => item.name === 'notes/index.json')).toBe(true)
  expect(metadata.objectHashes).toContain(objectHash)
})

test.runIf(enabled)('runs repository helper verification and exports a valid tar archive over SSH exec', async () => {
  const remotePath = 'repository-helper-export'
  const source = await writeHelperRepository(remotePath)
  const verification = await runRepositoryHelper(helperSettings(remotePath), 'verify')
  expect(verification.ok).toBe(true)
  expect(verification.message).toMatch(/校验通过/)

  const exported = await runRepositoryHelper(helperSettings(remotePath), 'export-tar')
  expect(exported.ok).toBe(true)
  expect(exported.data).toBeTruthy()
  expect(tarNames(exported.data!)).toEqual(expect.arrayContaining([
    'library.json',
    'notes/index.json',
    `notes/${source.noteId}.json.gz`,
    `objects/${source.objectHash.slice(0, 2)}/${source.objectHash}`,
  ]))
  const destination = 'repository-helper-export-imported'
  await expect(runRepositoryHelper(helperSettings(destination), 'import-tar', exported.data)).resolves.toMatchObject({ ok: true })
  await expect(readFile(join(root, destination, 'notes', 'index.json'), 'utf8')).resolves.toContain(source.noteId)
  const repeated = await runRepositoryHelper(helperSettings(destination), 'import-tar', exported.data)
  expect(repeated.message).toMatch(/覆盖前文件保存在/)
  await expect(access(join(root, destination, '.notebook-next-recovery'))).resolves.toBeUndefined()
})

test.runIf(enabled)('verifies a compressed legacy repository with attachment-relative manifest paths', async () => {
  const remotePath = 'repository-helper-legacy'
  const repository = join(root, remotePath)
  const noteId = '30000000-0000-4000-8000-000000000005'
  const attachment = Buffer.from('legacy attachment')
  const attachmentHash = digest(attachment)
  const relativePath = `${noteId}/legacy.bin`
  await mkdir(join(repository, 'notes'), { recursive: true })
  await mkdir(join(repository, 'attachments', noteId), { recursive: true })
  await writeFile(join(repository, 'library.json'), '{"folders":[],"tags":[]}')
  await writeFile(join(repository, 'notes', `${noteId}.json.gz`), gzipSync(JSON.stringify({ noteID: noteId, currentSnapshot: {} })))
  await writeFile(join(repository, 'attachments', relativePath), attachment)
  await writeFile(join(repository, 'notes', 'assets_manifest.json'), JSON.stringify({ entries: [{ relativePath, contentHash: attachmentHash, size: attachment.byteLength }] }))
  await writeFile(join(repository, 'notes', 'index.json'), JSON.stringify({ repositoryFormat: { version: 2, noteEncoding: 'gzip' }, entries: [{ noteID: noteId, version: 1, contentHash: digest('{}'), historyCount: 0 }] }))
  await expect(runRepositoryHelper(helperSettings(remotePath), 'verify')).resolves.toMatchObject({ ok: true, message: expect.stringMatching(/校验通过/) })
})

test.runIf(enabled)('reports detailed corruption from repository helper verification', async () => {
  const remotePath = 'repository-helper-corrupt'
  const source = await writeHelperRepository(remotePath)
  await writeFile(join(source.repository, 'objects', source.objectHash.slice(0, 2), source.objectHash), 'corrupted object')
  const detail = await runRepositoryHelper(helperSettings(remotePath), 'verify').then(
    (result) => result.message,
    (error: Error) => error.message,
  )
  expect(detail).toMatch(new RegExp(`objects/${source.objectHash.slice(0, 2)}/${source.objectHash} hash mismatch`))
})

test.runIf(enabled)('rejects an invalid helper import without publishing its index', async () => {
  const remotePath = 'repository-helper-invalid-import'
  const repository = join(root, remotePath)
  const originalIndex = '{"entries":[{"noteID":"existing"}]}'
  await mkdir(join(repository, 'notes'), { recursive: true })
  await writeFile(join(repository, 'notes', 'index.json'), originalIndex)
  const claimedHash = 'a'.repeat(64)
  const invalid = tar([
    { name: 'notes/index.json', data: encode('{"entries":[]}') },
    { name: `objects/aa/${claimedHash}`, data: encode('not the claimed object') },
  ])
  await expect(runRepositoryHelper(helperSettings(remotePath), 'import-tar', invalid)).rejects.toThrow()
  await expect(readFile(join(repository, 'notes', 'index.json'), 'utf8')).resolves.toBe(originalIndex)
})

test.runIf(enabled)('quarantines old unreferenced objects while preserving referenced objects', async () => {
  const remotePath = 'repository-helper-gc'
  const source = await writeHelperRepository(remotePath)
  const orphan = Buffer.from('old unreferenced object')
  const orphanHash = digest(orphan)
  const orphanPath = join(source.repository, 'objects', orphanHash.slice(0, 2), orphanHash)
  await mkdir(join(source.repository, 'objects', orphanHash.slice(0, 2)), { recursive: true })
  await writeFile(orphanPath, orphan)
  const historyObject = Buffer.from('history-only object')
  const historyObjectHash = digest(historyObject)
  const historyObjectPath = join(source.repository, 'objects', historyObjectHash.slice(0, 2), historyObjectHash)
  await mkdir(join(source.repository, 'objects', historyObjectHash.slice(0, 2)), { recursive: true })
  await writeFile(historyObjectPath, historyObject)
  const notePath = join(source.repository, 'notes', `${source.noteId}.json.gz`)
  const envelope = JSON.parse(gunzipSync(await readFile(notePath)).toString('utf8'))
  const historyAssetId = 'history-only-asset'
  const historyMarkdown = `![history](notebook-asset:${historyAssetId})`
  const historyHash = digest(historyMarkdown)
  envelope.contentObjects[historyHash] = historyMarkdown
  envelope.history = [{ contentHash: historyHash }]
  envelope.assets.push({ id: historyAssetId, objectHash: historyObjectHash, checksum: historyObjectHash, localPath: `objects/${historyObjectHash.slice(0, 2)}/${historyObjectHash}` })
  await writeFile(notePath, gzipSync(JSON.stringify(envelope)))
  const indexPath = join(source.repository, 'notes', 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  index.entries[0].historyCount = 1
  await writeFile(indexPath, JSON.stringify(index))
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  await utimes(orphanPath, old, old)
  await utimes(historyObjectPath, old, old)

  const outcome = await runRepositoryHelper(helperSettings(remotePath), 'gc')
  expect(outcome.ok).toBe(true)
  expect(outcome.message).toMatch(/隔离|quarantin/i)
  await expect(access(orphanPath)).rejects.toThrow()
  await expect(readFile(join(source.repository, 'objects', source.objectHash.slice(0, 2), source.objectHash))).resolves.toEqual(source.object)
  await expect(readFile(historyObjectPath)).resolves.toEqual(historyObject)
})

test.runIf(enabled)('fails closed when encrypted notes hide the historical object graph from gc', async () => {
  const remotePath = 'repository-helper-private-gc'
  const source = await writeHelperRepository(remotePath)
  const privateEnvelope = {
    schemaVersion: 3,
    noteID: source.noteId,
    metadata: { id: source.noteId },
    currentContentHash: digest('private'),
    contentObjects: {},
    history: [], assets: [], taskSteps: [], tagIDs: [], linkedPageIDs: [],
    privacyEncryption: { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: 310000, salt: 'salt', iv: 'iv', ciphertext: 'ciphertext' },
  }
  await writeFile(join(source.repository, 'notes', `${source.noteId}.json.gz`), gzipSync(JSON.stringify(privateEnvelope)))
  await expect(runRepositoryHelper(helperSettings(remotePath), 'gc')).rejects.toThrow(/encrypted|加密/i)
  await expect(readFile(join(source.repository, 'objects', source.objectHash.slice(0, 2), source.objectHash))).resolves.toEqual(source.object)
})
