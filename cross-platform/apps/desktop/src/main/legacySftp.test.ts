import { createServer } from 'node:net'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { normalizeRepositoryIndex, pullLegacyRepository, pushLegacyRepository, testLegacyConnection } from './legacySftp'

const enabled = process.env.NOTEBOOK_SFTP_E2E === '1'
let root = ''
let port = 0
let fingerprint = ''
let server: ReturnType<typeof spawn> | undefined

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
  const noteId = '30000000-0000-4000-8000-000000000001'
  const files = [
    { name: 'library.json', dataBase64: Buffer.from('{"folders":[],"tags":[]}').toString('base64') },
    { name: `notes/${noteId}.json`, dataBase64: Buffer.from('{"noteID":"test"}').toString('base64') },
    { name: 'notes/assets_manifest.json', dataBase64: Buffer.from('{"entries":[{"relativePath":"page/image.png"}]}').toString('base64') },
    { name: 'attachments/page/image.png', dataBase64: Buffer.from([1, 2, 3]).toString('base64') },
    { name: 'notes/index.json', dataBase64: Buffer.from(JSON.stringify({ entries: [{ noteID: noteId }] })).toString('base64') },
  ]
  await pushLegacyRepository(settings, files, empty.indexHash)
  const physicalNote = await readFile(join(root, 'repository', 'notes', `${noteId}.json.gz`))
  expect(JSON.parse(gunzipSync(physicalNote).toString('utf8'))).toEqual({ noteID: 'test' })
  await expect(access(join(root, 'repository', 'notes', `${noteId}.json`))).rejects.toThrow()
  const physicalIndex = JSON.parse(await readFile(join(root, 'repository', 'notes', 'index.json'), 'utf8'))
  expect(physicalIndex.repositoryFormat).toMatchObject({ version: 2, noteEncoding: 'gzip' })
  const pulled = await pullLegacyRepository(settings)
  expect(pulled.files.map((item) => item.name).sort()).toEqual(files.map((item) => item.name).sort())
  expect(pulled.files.find((item) => item.name === 'attachments/page/image.png')?.dataBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  await expect(pullLegacyRepository({ ...settings, fingerprint: 'SHA256:wrong' })).rejects.toThrow(/指纹已变化/)
})

test.runIf(enabled)('round-trips a v3 Markdown repository with content-addressed resources', async () => {
  const settings = { host: '127.0.0.1', port, username: 'notebook', password: 'test-password', remotePath: 'repository-v3', fingerprint }
  const empty = await pullLegacyRepository(settings)
  const noteId = '30000000-0000-4000-8000-000000000003'
  const objectHash = 'a'.repeat(64)
  const note = { schemaVersion: 3, noteID: noteId, currentContentHash: 'b'.repeat(64), contentObjects: { ['b'.repeat(64)]: '# Markdown' }, history: [] }
  const files = [
    { name: 'library.json', dataBase64: Buffer.from('{"folders":[],"tags":[]}').toString('base64') },
    { name: `notes/${noteId}.json`, dataBase64: Buffer.from(JSON.stringify(note)).toString('base64') },
    { name: 'notes/assets_manifest.json', dataBase64: Buffer.from(JSON.stringify({ entries: [{ relativePath: `objects/aa/${objectHash}`, contentHash: objectHash }] })).toString('base64') },
    { name: `objects/aa/${objectHash}`, dataBase64: Buffer.from([4, 5, 6]).toString('base64') },
    { name: 'notes/index.json', dataBase64: Buffer.from(JSON.stringify({ repositoryFormat: { version: 3, noteEncoding: 'gzip', contentFormat: 'markdown-gfm', assetAddressing: 'sha256' }, entries: [{ noteID: noteId }] })).toString('base64') },
  ]
  await pushLegacyRepository(settings, files, empty.indexHash)
  const physicalIndex = JSON.parse(await readFile(join(root, 'repository-v3', 'notes', 'index.json'), 'utf8'))
  expect(physicalIndex.repositoryFormat.version).toBe(3)
  expect(JSON.parse(gunzipSync(await readFile(join(root, 'repository-v3', 'notes', `${noteId}.json.gz`))).toString('utf8'))).toEqual(note)
  expect(await readFile(join(root, 'repository-v3', 'objects', 'aa', objectHash))).toEqual(Buffer.from([4, 5, 6]))
  const pulled = await pullLegacyRepository(settings)
  expect(JSON.parse(Buffer.from(pulled.files.find((item) => item.name === `notes/${noteId}.json`)!.dataBase64, 'base64').toString('utf8'))).toEqual(note)
  expect(pulled.files.find((item) => item.name === `objects/aa/${objectHash}`)?.dataBase64).toBe(Buffer.from([4, 5, 6]).toString('base64'))
  expect(pulled.objectHashes).toContain(objectHash)
  const incremental = await pullLegacyRepository(settings, { knownObjectHashes: [objectHash] })
  expect(incremental.files.some((item) => item.name === `objects/aa/${objectHash}`)).toBe(false)
  expect(incremental.reusedObjectCount).toBe(1)
})
