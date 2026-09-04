import { afterEach, expect, test, vi } from 'vitest'
import { createClient } from 'webdav'
import { configureWebdavFetch } from './webdavFetch'

afterEach(() => { configureWebdavFetch((url, init) => fetch(url, init)) })

test('routes WebDAV through the supplied system transport, preserving auth, binary bodies and cancellation', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
  configureWebdavFetch(fetcher)
  const client = createClient('https://dav.example.test/dav', { username: 'test', password: 'example' })
  const controller = new AbortController()
  const bytes = Buffer.from([0, 255, 128, 10])

  await client.putFileContents('/object', bytes, { signal: controller.signal })

  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0]!
  expect(url).toBe('https://dav.example.test/dav/object')
  expect(init).toMatchObject({ method: 'PUT', body: bytes, signal: controller.signal, cache: 'no-store', credentials: 'omit' })
  expect(init.headers.get('authorization')).toBe(`Basic ${Buffer.from('test:example').toString('base64')}`)
  expect(init.headers.get('content-type')).toBe('application/octet-stream')
  expect(init.headers.has('content-length')).toBe(false)
  expect(init.headers.has('transfer-encoding')).toBe(false)
})

test('keeps network failures visible to the sync deadline and error UI', async () => {
  const failure = new Error('system proxy unavailable')
  configureWebdavFetch(vi.fn().mockRejectedValue(failure))
  const client = createClient('https://dav.example.test/dav')
  await expect(client.getDirectoryContents('/journal')).rejects.toBe(failure)
})
