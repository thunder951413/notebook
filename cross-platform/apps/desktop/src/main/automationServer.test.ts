import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))

import { AutomationApiServer } from './automationServer'

async function availablePort() {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

let service: AutomationApiServer | undefined

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'notebook-automation-test-'))
})

afterEach(async () => {
  await service?.stop()
  service = undefined
  await rm(state.root, { recursive: true, force: true })
})

test('binds to loopback, requires a token and forwards authorized requests', async () => {
  let currentService: AutomationApiServer
  const renderer = {
    isDestroyed: () => false,
    send: (_channel: string, request: { id: string; operation: string }) => {
      currentService.handleRendererResponse({ id: request.id, ok: true, result: { operation: request.operation } })
    },
  }
  currentService = service = new AutomationApiServer(() => renderer as never)
  await service.initialize()
  const port = await availablePort()
  const enabled = await service.configure(true, port)

  const unauthorized = await fetch(`${enabled.baseUrl}/v1/guide`)
  expect(unauthorized.status).toBe(401)

  const authorized = await fetch(`${enabled.baseUrl}/v1/guide`, { headers: { authorization: `Bearer ${enabled.token}` } })
  expect(authorized.status).toBe(200)
  await expect(authorized.json()).resolves.toEqual({ operation: 'guide' })
})

test('rejects browser-origin requests and oversized or unknown routes', async () => {
  const renderer = { isDestroyed: () => false, send: vi.fn() }
  service = new AutomationApiServer(() => renderer as never)
  await service.initialize()
  const port = await availablePort()
  const enabled = await service.configure(true, port)
  const headers = { authorization: `Bearer ${enabled.token}` }

  const browser = await fetch(`${enabled.baseUrl}/v1/guide`, { headers: { ...headers, origin: 'https://malicious.example' } })
  expect(browser.status).toBe(403)
  const missing = await fetch(`${enabled.baseUrl}/v1/missing`, { headers })
  expect(missing.status).toBe(404)
  expect(renderer.send).not.toHaveBeenCalled()
})

test('regenerating the token invalidates the previous token', async () => {
  let currentService: AutomationApiServer
  const renderer = {
    isDestroyed: () => false,
    send: (_channel: string, request: { id: string }) => currentService.handleRendererResponse({ id: request.id, ok: true, result: {} }),
  }
  currentService = service = new AutomationApiServer(() => renderer as never)
  await service.initialize()
  const port = await availablePort()
  const enabled = await service.configure(true, port)
  const oldToken = enabled.token!
  const renewed = await service.regenerateToken()

  expect(renewed.token).not.toBe(oldToken)
  expect((await fetch(`${renewed.baseUrl}/v1/guide`, { headers: { authorization: `Bearer ${oldToken}` } })).status).toBe(401)
  expect((await fetch(`${renewed.baseUrl}/v1/guide`, { headers: { authorization: `Bearer ${renewed.token}` } })).status).toBe(200)
})

test('stores the bearer token outside the plaintext configuration file', async () => {
  let protectedToken: string | undefined
  const tokenStore = {
    get: vi.fn(async () => protectedToken),
    set: vi.fn(async (value: string) => { protectedToken = value }),
  }
  service = new AutomationApiServer(() => undefined, tokenStore)
  await service.initialize()
  expect(protectedToken).toBeTruthy()
  const config = await readFile(join(state.root, 'automation-api.v1.json'), 'utf8')
  expect(config).not.toContain(protectedToken!)
  expect(JSON.parse(config)).toEqual({ enabled: false, port: 47831 })
})

test('rejects oversized bodies and caps concurrent renderer requests', async () => {
  const renderer = { isDestroyed: () => false, send: vi.fn() }
  service = new AutomationApiServer(() => renderer as never)
  await service.initialize()
  const port = await availablePort()
  const enabled = await service.configure(true, port)
  const headers = { authorization: `Bearer ${enabled.token}`, 'content-type': 'application/json' }
  const oversized = await fetch(`${enabled.baseUrl}/v1/proposals`, {
    method: 'POST',
    headers,
    body: `{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`,
  })
  expect(oversized.status).toBe(413)

  const pending = Array.from({ length: 8 }, () => fetch(`${enabled.baseUrl}/v1/guide`, { headers }))
  await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledTimes(8))
  const overflow = await fetch(`${enabled.baseUrl}/v1/guide`, { headers })
  expect(overflow.status).toBe(429)
  await service.stop()
  service = undefined
  expect((await Promise.all(pending)).map((response) => response.status)).toEqual(Array(8).fill(503))
})

test('does not expose internal renderer failures to API clients', async () => {
  let currentService: AutomationApiServer
  const renderer = {
    isDestroyed: () => false,
    send: (_channel: string, request: { id: string }) => currentService.handleRendererResponse({
      id: request.id,
      ok: false,
      error: { code: 'renderer_error', message: 'private note body and /secret/path' },
    }),
  }
  currentService = service = new AutomationApiServer(() => renderer as never)
  await service.initialize()
  const port = await availablePort()
  const enabled = await service.configure(true, port)
  const response = await fetch(`${enabled.baseUrl}/v1/guide`, { headers: { authorization: `Bearer ${enabled.token}` } })
  expect(response.status).toBe(500)
  const body = await response.text()
  expect(body).toContain('Notebook 内部处理失败')
  expect(body).not.toContain('private note body')
  expect(body).not.toContain('/secret/path')
})
