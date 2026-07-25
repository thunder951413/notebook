import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
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
