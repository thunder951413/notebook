import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { appendWebdavJournal, getWebdavObject, pullWebdavJournals, putWebdavObject, testWebdavConnection, type WebdavConnection } from './webdav'

/**
 * Minimal in-memory WebDAV server (MKCOL/PUT/GET/DELETE/PROPFIND) exercising
 * the transport against a real HTTP endpoint, mirroring the SFTP E2E pattern
 * without external processes or credentials.
 */

interface ServerEntry { data: Buffer | null } // null marks a directory

const decodePath = (raw: string) => {
  try { return decodeURIComponent(raw.split('?')[0]!) } catch { return raw.split('?')[0]! }
}

const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function multistatus(entries: Array<{ href: string; isDirectory: boolean }>) {
  const responses = entries.map(({ href, isDirectory }) => [
    '  <d:response>',
    `    <d:href>${xmlEscape(href)}</d:href>`,
    '    <d:propstat>',
    '      <d:prop>',
    isDirectory ? '        <d:resourcetype><d:collection/></d:resourcetype>' : '        <d:resourcetype/>',
    `        <d:displayname>${xmlEscape(href.split('/').filter(Boolean).pop() ?? '')}</d:displayname>`,
    '      </d:prop>',
    '      <d:status>HTTP/1.1 200 OK</d:status>',
    '    </d:propstat>',
    '  </d:response>',
  ].join('\n')).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">\n${responses}\n</d:multistatus>`
}

function serve(entries: Map<string, ServerEntry>) {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const path = decodePath(request.url ?? '/')
    requestLog.push({ method: request.method ?? '', path })
    try {
      switch (request.method) {
        case 'MKCOL': {
          if (entries.has(path) || [...entries.keys()].some((key) => key.startsWith(`${path}/`))) {
            response.writeHead(405).end()
          } else {
            entries.set(path, { data: null })
            response.writeHead(201).end()
          }
          break
        }
        case 'PUT': {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(chunk as Buffer)
          entries.set(path, { data: Buffer.concat(chunks) })
          response.writeHead(201).end()
          break
        }
        case 'GET': {
          const entry = entries.get(path)
          if (!entry || entry.data === null) { response.writeHead(404).end(); break }
          response.writeHead(200, { 'content-type': 'application/octet-stream' })
          response.end(entry.data)
          break
        }
        case 'DELETE': {
          if (!entries.has(path) && ![...entries.keys()].some((key) => key.startsWith(`${path}/`))) {
            response.writeHead(404).end()
          } else {
            for (const key of entries.keys()) if (key === path || key.startsWith(`${path}/`)) entries.delete(key)
            response.writeHead(204).end()
          }
          break
        }
        case 'PROPFIND': {
          if (propfindFailureStatus) {
            response.writeHead(propfindFailureStatus).end()
            break
          }
          const normalized = path.replace(/\/$/, '')
          if (![...entries.keys()].some((key) => key.replace(/\/$/, '') === normalized)) {
            response.writeHead(404).end()
            break
          }
          const depth = request.headers.depth ?? '1'
          const children = [...entries.keys()].filter((key) => {
            const candidate = key.replace(/\/$/, '')
            if (candidate === normalized) return true
            if (depth === '1') return candidate.startsWith(`${normalized}/`) && !candidate.slice(normalized.length + 1).includes('/')
            return false
          })
          response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
          response.end(multistatus(children.map((key) => ({ href: key, isDirectory: entries.get(key)!.data === null }))))
          break
        }
        case 'OPTIONS':
          response.writeHead(200, { dav: '1' }).end()
          break
        default:
          response.writeHead(405).end()
      }
    } catch {
      response.writeHead(500).end()
    }
  })
}

let server: Server
let baseUrl = ''
let connection: WebdavConnection
const entries = new Map<string, ServerEntry>()
let propfindFailureStatus: number | undefined
const requestLog: Array<{ method: string; path: string }> = []

beforeAll(async () => {
  server = serve(entries)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动测试 WebDAV 服务器')
  baseUrl = `http://127.0.0.1:${address.port}/dav/`
  connection = { baseUrl, username: 'test-user', appPassword: 'test-app-password', remotePath: 'notebook_backup' }
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe('webdav transport', () => {
  test('tests the connection and creates the repository root', async () => {
    const result = await testWebdavConnection(connection)
    expect(result.ok).toBe(true)
    expect(result.remotePathExists).toBe(false)
    // A pull provisions journal/, so the next probe sees a fully usable root.
    await pullWebdavJournals(connection, {})
    const second = await testWebdavConnection(connection)
    expect(second.remotePathExists).toBe(true)
  })

  test('appends per-device journals with monotonic sequence numbers', async () => {
    const first = await appendWebdavJournal(connection, '00000000-0000-4000-8000-000000000001', [
      { ts: '2026-08-04T00:00:00.000Z', op: 'upsert', type: 'page', id: 'page-1', ver: 0, payload: { title: 'a' } },
      { ts: '2026-08-04T00:00:01.000Z', op: 'upsert', type: 'page', id: 'page-2', ver: 1, payload: { title: 'b' } },
    ])
    expect(first).toEqual({ firstSeq: 1, count: 2 })
    const second = await appendWebdavJournal(connection, '00000000-0000-4000-8000-000000000001', [
      { ts: '2026-08-04T00:00:02.000Z', op: 'delete', type: 'page', id: 'page-1', ver: 2, payload: {} },
    ])
    expect(second).toEqual({ firstSeq: 3, count: 1 })
    // A second device starts its own journal at seq 1.
    const other = await appendWebdavJournal(connection, '00000000-0000-4000-8000-000000000002', [
      { ts: '2026-08-04T00:00:03.000Z', op: 'upsert', type: 'page', id: 'page-3', ver: 0, payload: { title: 'c' } },
    ])
    expect(other).toEqual({ firstSeq: 1, count: 1 })
  })

  test('compacts an oversized journal before appending, preserving seq values', async () => {
    const deviceA = '00000000-0000-4000-8000-00000000000a'
    // Seed an oversized journal: 8000 updates of the same entity (~600 B each).
    const big = Array.from({ length: 8000 }, (_, index) => JSON.stringify({
      seq: index + 1, ts: '2026-08-04T00:00:00.000Z', op: 'upsert', type: 'page', id: 'page-1', ver: index,
      payload: { id: 'page-1', title: `revision-${index}`, body: 'x'.repeat(500) },
    })).join('\n') + '\n'
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(4 * 1024 * 1024)
    entries.set('/dav/notebook_backup/journal/00000000-0000-4000-8000-00000000000a.jsonl', { data: Buffer.from(big) })
    entries.set('/dav/notebook_backup/journal', { data: null })

    const pushed = await appendWebdavJournal(connection, deviceA, [
      { ts: '2026-08-04T00:00:01.000Z', op: 'upsert', type: 'page', id: 'page-2', ver: 0, payload: { id: 'page-2', title: 'new' } },
    ])

    // firstSeq is based on the pre-compaction tail, so seq stays monotonic.
    expect(pushed).toEqual({ firstSeq: 8001, count: 1 })
    const stored = entries.get(`/dav/notebook_backup/journal/${deviceA}.jsonl`)!.data!.toString()
    expect(stored.length).toBeLessThan(4 * 1024 * 1024)
    const parsed = stored.trim().split('\n').map((line) => JSON.parse(line) as { seq: number; type: string; id: string; ver: number })
    // Only the latest revision of page-1 survives, with its original seq.
    expect(parsed.map(({ seq, type, id, ver }) => ({ seq, type, id, ver }))).toEqual([
      { seq: 8000, type: 'page', id: 'page-1', ver: 7999 },
      { seq: 8001, type: 'page', id: 'page-2', ver: 0 },
    ])
    // Leave the shared in-memory server clean for the tests that follow.
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
  })

  test('compacts an entry-count overflow instead of rejecting a compactable journal', async () => {
    const deviceA = '00000000-0000-4000-8000-00000000000c'
    const full = Array.from({ length: 100_000 }, (_, index) => JSON.stringify({
      seq: index + 1, ts: '2026-08-04T00:00:00.000Z', op: 'upsert', type: 'page', id: 'page-1', ver: index, payload: {},
    })).join('\n') + '\n'
    entries.set(`/dav/notebook_backup/journal/${deviceA}.jsonl`, { data: Buffer.from(full) })

    await expect(appendWebdavJournal(connection, deviceA, [
      { ts: '2026-08-04T00:00:01.000Z', op: 'upsert', type: 'page', id: 'page-2', ver: 0, payload: {} },
    ])).resolves.toEqual({ firstSeq: 100_001, count: 1 })
    const parsed = entries.get(`/dav/notebook_backup/journal/${deviceA}.jsonl`)!.data!.toString().trim().split('\n').map((line) => JSON.parse(line) as { seq: number })
    expect(parsed.map((entry) => entry.seq)).toEqual([100_000, 100_001])
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
  })

  test('uses UTF-8 bytes to trigger early compaction for CJK journals', async () => {
    const deviceA = '00000000-0000-4000-8000-00000000000d'
    const payload = '中'.repeat(800_000)
    const big = [1, 2].map((seq) => JSON.stringify({
      seq, ts: '2026-08-04T00:00:00.000Z', op: 'upsert', type: 'page', id: 'page-1', ver: seq - 1, payload: { payload },
    })).join('\n') + '\n'
    expect(big.length).toBeLessThan(4 * 1024 * 1024)
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(4 * 1024 * 1024)
    entries.set(`/dav/notebook_backup/journal/${deviceA}.jsonl`, { data: Buffer.from(big) })

    await appendWebdavJournal(connection, deviceA, [
      { ts: '2026-08-04T00:00:01.000Z', op: 'upsert', type: 'page', id: 'page-2', ver: 0, payload: {} },
    ])

    const stored = entries.get(`/dav/notebook_backup/journal/${deviceA}.jsonl`)!.data!
    expect(stored.byteLength).toBeLessThan(4 * 1024 * 1024)
    expect(stored.toString().trim().split('\n').map((line) => JSON.parse(line).seq)).toEqual([2, 3])
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
  })

  test('pulls only entries newer than the per-device read cursor', async () => {
    const pulled = await pullWebdavJournals(connection, { '00000000-0000-4000-8000-000000000001': 2 })
    expect(pulled.entries.map((entry) => `${entry.deviceId}:${entry.seq}:${entry.type}:${entry.id}`)).toEqual([
      '00000000-0000-4000-8000-000000000001:3:page:page-1',
      '00000000-0000-4000-8000-000000000002:1:page:page-3',
    ])
    expect(pulled.entries[0]).toMatchObject({ op: 'delete', ver: 2 })
    expect(pulled.fingerprint).toBe(`${baseUrl}|test-user|notebook_backup`)
    // Re-pulling with the same cursor yields nothing new.
    const again = await pullWebdavJournals(connection, { '00000000-0000-4000-8000-000000000001': 3, '00000000-0000-4000-8000-000000000002': 1 })
    expect(again.entries).toHaveLength(0)
  })

  test('uses a small committed head to skip an already-consumed journal', async () => {
    requestLog.length = 0
    await expect(pullWebdavJournals(connection, {
      '00000000-0000-4000-8000-000000000001': 3,
      '00000000-0000-4000-8000-000000000002': 1,
    })).resolves.toMatchObject({ entries: [] })
    expect(requestLog.filter((request) => request.method === 'GET' && request.path.endsWith('.head.json'))).toHaveLength(2)
    expect(requestLog.filter((request) => request.method === 'GET' && request.path.endsWith('.jsonl'))).toHaveLength(0)
  })

  test('keeps reading legacy journals that have no head marker', async () => {
    const deviceA = '00000000-0000-4000-8000-0000000000e1'
    entries.set(`/dav/notebook_backup/journal/${deviceA}.jsonl`, { data: Buffer.from(JSON.stringify({
      seq: 1, ts: 't', op: 'upsert', type: 'page', id: 'legacy', ver: 0, payload: {},
    }) + '\n') })
    requestLog.length = 0
    const pulled = await pullWebdavJournals(connection, {
      '00000000-0000-4000-8000-000000000001': 3,
      '00000000-0000-4000-8000-000000000002': 1,
    })
    expect(pulled.entries).toMatchObject([{ deviceId: deviceA, seq: 1, id: 'legacy' }])
    expect(requestLog.some((request) => request.method === 'GET' && request.path.endsWith(`${deviceA}.jsonl`))).toBe(true)
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
  })

  test('rejects journals that disagree with their committed head bytes or hash', async () => {
    const deviceA = '00000000-0000-4000-8000-0000000000e2'
    const body = JSON.stringify({ seq: 1, ts: 't', op: 'upsert', type: 'page', id: 'checked', ver: 0, payload: {} }) + '\n'
    const baseHead = {
      version: 1, deviceId: deviceA, lastSeq: 1, journalBytes: Buffer.byteLength(body),
      journalSha256: createHash('sha256').update(body, 'utf8').digest('hex'), updatedAt: '2026-08-07T00:00:00.000Z', stateEntries: 1, historyEntries: 0,
    }
    entries.set(`/dav/notebook_backup/journal/${deviceA}.jsonl`, { data: Buffer.from(body) })
    entries.set(`/dav/notebook_backup/journal/${deviceA}.head.json`, { data: Buffer.from(JSON.stringify({ ...baseHead, journalBytes: baseHead.journalBytes + 1 })) })
    await expect(pullWebdavJournals(connection, {})).rejects.toThrow('提交标记不一致')
    entries.set(`/dav/notebook_backup/journal/${deviceA}.head.json`, { data: Buffer.from(JSON.stringify({ ...baseHead, journalSha256: '0'.repeat(64) })) })
    await expect(pullWebdavJournals(connection, {})).rejects.toThrow('提交标记不一致')
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.head.json`)
  })

  test('hides a newer legacy-writer tail until its head is committed', async () => {
    const deviceA = '00000000-0000-4000-8000-0000000000e5'
    const committed = JSON.stringify({ seq: 1, ts: 't1', op: 'upsert', type: 'page', id: 'committed', ver: 0, payload: {} }) + '\n'
    const journal = committed + JSON.stringify({ seq: 2, ts: 't2', op: 'upsert', type: 'page', id: 'uncommitted', ver: 0, payload: {} }) + '\n'
    entries.set(`/dav/notebook_backup/journal/${deviceA}.jsonl`, { data: Buffer.from(journal) })
    entries.set(`/dav/notebook_backup/journal/${deviceA}.head.json`, { data: Buffer.from(JSON.stringify({
      version: 1, deviceId: deviceA, lastSeq: 1, journalBytes: Buffer.byteLength(committed),
      journalSha256: createHash('sha256').update(committed, 'utf8').digest('hex'), updatedAt: '2026-08-07T00:00:00.000Z', stateEntries: 1, historyEntries: 0,
    })) })
    const pulled = await pullWebdavJournals(connection, {})
    expect(pulled.entries.filter((entry) => entry.deviceId === deviceA).map((entry) => entry.id)).toEqual(['committed'])
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.head.json`)
  })

  test('bounds revision history while retaining current state and tombstones', async () => {
    const deviceA = '00000000-0000-4000-8000-0000000000e3'
    const revisions = Array.from({ length: 300 }, (_, index) => ({
      ts: `2026-08-07T00:00:${String(index % 60).padStart(2, '0')}.000Z`, op: 'upsert' as const, type: 'revision', id: `revision-${index}`, ver: 0, payload: { body: 'x'.repeat(10_000) },
    }))
    await appendWebdavJournal(connection, deviceA, [
      { ts: 't1', op: 'upsert', type: 'page', id: 'page-1', ver: 0, payload: { title: 'old' } },
      { ts: 't2', op: 'delete', type: 'page', id: 'page-1', ver: 1, payload: {} },
      ...revisions,
    ])
    const journal = entries.get(`/dav/notebook_backup/journal/${deviceA}.jsonl`)!.data!.toString().trim().split('\n').map((line) => JSON.parse(line) as { seq: number; op: string; type: string; id: string })
    const history = journal.filter((entry) => entry.type === 'revision')
    expect(journal.find((entry) => entry.type === 'page' && entry.id === 'page-1')).toMatchObject({ op: 'delete', seq: 2 })
    expect(history.length).toBeLessThan(256) // the 2 MiB byte ring is tighter than the 256-entry ring here.
    expect(Math.min(...history.map((entry) => entry.seq))).toBeGreaterThan(3)
    const head = JSON.parse(entries.get(`/dav/notebook_backup/journal/${deviceA}.head.json`)!.data!.toString()) as { stateEntries: number; historyEntries: number }
    expect(head).toMatchObject({ stateEntries: 1, historyEntries: history.length })
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.head.json`)
  })

  test('commits the head after the journal with matching metadata', async () => {
    const deviceA = '00000000-0000-4000-8000-0000000000e4'
    requestLog.length = 0
    await appendWebdavJournal(connection, deviceA, [{ ts: 't', op: 'upsert', type: 'page', id: 'page-1', ver: 0, payload: {} }])
    const puts = requestLog.filter((request) => request.method === 'PUT').map((request) => request.path)
    expect(puts.slice(-2)).toEqual([
      `/dav/notebook_backup/journal/${deviceA}.jsonl`,
      `/dav/notebook_backup/journal/${deviceA}.head.json`,
    ])
    const journal = entries.get(`/dav/notebook_backup/journal/${deviceA}.jsonl`)!.data!.toString()
    const head = JSON.parse(entries.get(`/dav/notebook_backup/journal/${deviceA}.head.json`)!.data!.toString()) as { version: number; deviceId: string; lastSeq: number; journalBytes: number; journalSha256: string; stateEntries: number; historyEntries: number }
    expect(head).toMatchObject({ version: 1, deviceId: deviceA, lastSeq: 1, journalBytes: Buffer.byteLength(journal), stateEntries: 1, historyEntries: 0 })
    expect(head.journalSha256).toBe(createHash('sha256').update(journal, 'utf8').digest('hex'))
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.jsonl`)
    entries.delete(`/dav/notebook_backup/journal/${deviceA}.head.json`)
  })

  test('ignores invalid journal filenames and surfaces directory-list failures', async () => {
    entries.set('/dav/notebook_backup/journal/not-a-device.jsonl', { data: Buffer.from('{not json}\n') })
    await expect(pullWebdavJournals(connection, {
      '00000000-0000-4000-8000-000000000001': 3,
      '00000000-0000-4000-8000-000000000002': 1,
    })).resolves.toMatchObject({ entries: [] })
    entries.delete('/dav/notebook_backup/journal/not-a-device.jsonl')

    propfindFailureStatus = 401
    try {
      await expect(pullWebdavJournals(connection, {})).rejects.toMatchObject({ status: 401 })
    } finally {
      propfindFailureStatus = undefined
    }
  })

  test('round-trips binary objects under objects/<xx>/<sha256>', async () => {
    const data = new Uint8Array([0, 1, 2, 250, 251, 255])
    const hash = createHash('sha256').update(data).digest('hex')
    await putWebdavObject(connection, hash, data)
    const fetched = await getWebdavObject(connection, hash)
    expect([...fetched]).toEqual([...data])
    // Content-addressing is idempotent: overwriting with the same bytes is fine.
    await putWebdavObject(connection, hash, data)
    await expect(getWebdavObject(connection, 'not-a-hash')).rejects.toThrow('对象哈希格式不正确')
  })

  test('does not upload an object body that already exists remotely', async () => {
    const hash = 'd'.repeat(64)
    const target = `/dav/notebook_backup/objects/dd/${hash}`
    entries.set(target, { data: Buffer.from('already-there') })
    requestLog.length = 0
    await putWebdavObject(connection, hash, new Uint8Array([1, 2, 3]))
    expect(requestLog.some((request) => request.method === 'PUT' && request.path === target)).toBe(false)
  })

  test('rejects oversized journals and unsafe remote paths', async () => {
    await expect(appendWebdavJournal(connection, '../escape', [])).rejects.toThrow('设备 ID 不正确')
    await expect(appendWebdavJournal({ ...connection, remotePath: '../escape' }, '00000000-0000-4000-8000-000000000001', [])).rejects.toThrow('远端同步目录不安全')
  })
})
