import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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

  test('round-trips binary objects under objects/<xx>/<sha256>', async () => {
    const hash = 'c'.repeat(64)
    const data = new Uint8Array([0, 1, 2, 250, 251, 255])
    await putWebdavObject(connection, hash, data)
    const fetched = await getWebdavObject(connection, hash)
    expect([...fetched]).toEqual([...data])
    // Content-addressing is idempotent: overwriting with the same bytes is fine.
    await putWebdavObject(connection, hash, data)
    await expect(getWebdavObject(connection, 'not-a-hash')).rejects.toThrow('对象哈希格式不正确')
  })

  test('rejects oversized journals and unsafe remote paths', async () => {
    await expect(appendWebdavJournal(connection, '../escape', [])).rejects.toThrow('设备 ID 不正确')
    await expect(appendWebdavJournal({ ...connection, remotePath: '../escape' }, '00000000-0000-4000-8000-000000000001', [])).rejects.toThrow('远端同步目录不安全')
  })
})
