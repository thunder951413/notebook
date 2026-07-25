import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, type WebContents } from 'electron'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AutomationApiState, AutomationBridgeRequest, AutomationBridgeResponse, AutomationRequestOperation } from '../automationContract'
import { appendDiagnosticEvent } from './diagnostics'

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_PORT = 47831
const MAX_BODY_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000

interface AutomationConfig {
  enabled: boolean
  port: number
  token: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const configPath = () => join(app.getPath('userData'), 'automation-api.v1.json')

async function atomicWrite(target: string, content: string) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true })
  try {
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function newToken() {
  return randomBytes(32).toString('base64url')
}

function validPort(value: unknown) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1024 && number <= 65_535 ? number : DEFAULT_PORT
}

async function loadConfig(): Promise<AutomationConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<AutomationConfig>
    return { enabled: Boolean(parsed.enabled), port: validPort(parsed.port), token: typeof parsed.token === 'string' && parsed.token.length >= 32 ? parsed.token : newToken() }
  } catch {
    return { enabled: false, port: DEFAULT_PORT, token: newToken() }
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.byteLength
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求正文超过 2 MB 限制'), { statusCode: 413 })
    chunks.push(value)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw Object.assign(new Error('请求正文不是有效 JSON'), { statusCode: 400 }) }
}

function route(request: IncomingMessage): { operation: AutomationRequestOperation; payload: unknown } | undefined {
  const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)
  const method = request.method ?? 'GET'
  if (method === 'GET' && url.pathname === '/v1/guide') return { operation: 'guide', payload: {} }
  if (method === 'GET' && url.pathname === '/v1/openapi.json') return { operation: 'openapi', payload: {} }
  if (method === 'GET' && url.pathname === '/v1/pages') return { operation: 'list-pages', payload: { query: url.searchParams.get('query') ?? '', limit: Number(url.searchParams.get('limit') ?? 100), cursor: url.searchParams.get('cursor') ?? undefined } }
  const page = url.pathname.match(/^\/v1\/pages\/([^/]+)$/)
  if (method === 'GET' && page) return { operation: 'get-page', payload: { pageId: decodeURIComponent(page[1]!) } }
  if (method === 'POST' && url.pathname === '/v1/proposals') return { operation: 'create-proposal', payload: undefined }
  if (method === 'GET' && url.pathname === '/v1/proposals') return { operation: 'list-proposals', payload: {} }
  const proposal = url.pathname.match(/^\/v1\/proposals\/([^/]+)$/)
  if (method === 'GET' && proposal) return { operation: 'get-proposal', payload: { proposalId: decodeURIComponent(proposal[1]!) } }
  return undefined
}

export class AutomationApiServer {
  private config: AutomationConfig = { enabled: false, port: DEFAULT_PORT, token: newToken() }
  private server?: Server
  private pending = new Map<string, PendingRequest>()

  constructor(private readonly renderer: () => WebContents | undefined) {}

  async initialize() {
    this.config = await loadConfig()
    await atomicWrite(configPath(), JSON.stringify(this.config))
    if (this.config.enabled) await this.start()
  }

  state(includeToken = false): AutomationApiState {
    const contents = this.renderer()
    return {
      enabled: Boolean(this.server?.listening),
      port: this.config.port,
      baseUrl: `http://${LOOPBACK_HOST}:${this.config.port}`,
      ...(includeToken ? { token: this.config.token } : {}),
      rendererReady: Boolean(contents && !contents.isDestroyed()),
    }
  }

  async configure(enabled: boolean, port: number) {
    const nextPort = validPort(port)
    const changedPort = nextPort !== this.config.port
    this.config = { ...this.config, enabled, port: nextPort }
    await atomicWrite(configPath(), JSON.stringify(this.config))
    if (!enabled) await this.stop()
    else if (changedPort && this.server) { await this.stop(); await this.start() }
    else if (!this.server) await this.start()
    return this.state(true)
  }

  async regenerateToken() {
    this.config = { ...this.config, token: newToken() }
    await atomicWrite(configPath(), JSON.stringify(this.config))
    await appendDiagnosticEvent({ level: 'warning', category: 'automation', action: 'token-regenerated', status: 'success' })
    return this.state(true)
  }

  handleRendererResponse(response: AutomationBridgeResponse) {
    const pending = this.pending.get(response.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(Object.assign(new Error(response.error?.message ?? '自动化请求失败'), { code: response.error?.code ?? 'renderer_error' }))
  }

  async stop() {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await appendDiagnosticEvent({ level: 'info', category: 'automation', action: 'server-stop', status: 'success' })
  }

  private async start() {
    const server = createServer((request, response) => { void this.handleHttp(request, response) })
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, LOOPBACK_HOST, () => { server.off('error', reject); resolve() })
    })
    this.server = server
    await appendDiagnosticEvent({ level: 'info', category: 'automation', action: 'server-start', status: 'success', message: `${LOOPBACK_HOST}:${this.config.port}` })
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse) {
    const startedAt = performance.now()
    try {
      if (request.headers.origin) throw Object.assign(new Error('浏览器跨站请求不被允许'), { statusCode: 403 })
      const authorization = request.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!token || !safeEqual(token, this.config.token)) throw Object.assign(new Error('缺少或无效的 Bearer Token'), { statusCode: 401 })
      const matched = route(request)
      if (!matched) throw Object.assign(new Error('接口不存在'), { statusCode: 404 })
      const payload = matched.operation === 'create-proposal' ? await readJsonBody(request) : matched.payload
      const result = await this.forward(matched.operation, payload)
      sendJson(response, matched.operation === 'create-proposal' ? 201 : 200, result)
      void appendDiagnosticEvent({ level: 'info', category: 'automation', action: matched.operation, status: 'success', durationMs: performance.now() - startedAt })
    } catch (error) {
      const value = error as Error & { statusCode?: number; code?: string }
      const status = value.statusCode
        ?? (value.code === 'stale' ? 409
          : value.code === 'not_found' ? 404
            : value.code === 'validation_error' || value.code === 'request_error' ? 400
              : 500)
      sendJson(response, status, { error: { code: value.code ?? (status === 500 ? 'internal_error' : 'request_error'), message: value.message } })
      void appendDiagnosticEvent({ level: status >= 500 ? 'error' : 'warning', category: 'automation', action: 'request', status: 'failed', message: value.message, durationMs: performance.now() - startedAt })
    }
  }

  private forward(operation: AutomationRequestOperation, payload: unknown) {
    const contents = this.renderer()
    if (!contents || contents.isDestroyed()) throw Object.assign(new Error('Notebook 界面尚未就绪'), { statusCode: 503 })
    const id = randomUUID()
    const request: AutomationBridgeRequest = { id, operation, payload }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error('Notebook 处理自动化请求超时'), { statusCode: 504 }))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      contents.send('notebook:automation-request', request)
    })
  }
}
