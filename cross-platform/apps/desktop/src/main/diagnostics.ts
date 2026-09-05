import { app } from 'electron'
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticStatus = 'started' | 'success' | 'failed' | 'cancelled' | 'info'

export interface DiagnosticErrorDetails {
  errorType?: string
  errorCode?: string
  stack?: string[]
}

export interface DiagnosticEventInput extends DiagnosticErrorDetails {
  level: DiagnosticLevel
  category: string
  action: string
  status: DiagnosticStatus
  message?: string
  durationMs?: number
  operationId?: string
  resource?: { type: string; id?: string }
}

export interface DiagnosticEntry extends DiagnosticEventInput {
  id: string
  timestamp: string
  sessionId: string
  appVersion: string
  platform: string
  arch: string
}

export const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_TEXT_LENGTH = 500
const MAX_STACK_FRAMES = 5
const MAX_QUEUED_WRITES = 256
const sessionId = randomUUID()

let ioQueue = Promise.resolve()
let queuedWrites = 0
let droppedWrites = 0
let writeFailureReported = false

export function diagnosticLogPath() {
  return join(app.getPath('logs'), 'notebook-next-diagnostics.jsonl')
}

function safeToken(value: unknown, fallback: string, maximum = 64) {
  const normalized = String(value ?? '').trim().replace(/[^a-z0-9._-]/gi, '-').slice(0, maximum)
  return normalized || fallback
}

export function sanitizeDiagnosticMessage(value: unknown) {
  return String(value ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s]+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(password|passphrase|token|secret|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/([?&](?:password|token|secret|key|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(sk-[a-z0-9_-]{8,}|github_pat_[a-z0-9_]+|gh[opusr]_[a-z0-9_]+)\b/gi, '[redacted]')
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
}

function sanitizeStackFrame(frame: string) {
  const withoutPaths = String(frame ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/[^/\s)]+)?(?:[a-z]:)?[\\/](?:[^\s():]+[\\/])+([^\\/\s():]+:\d+(?::\d+)?)/gi, '$1')
  return sanitizeDiagnosticMessage(withoutPaths)
    .slice(0, 240)
}

export function diagnosticErrorDetails(error: unknown): DiagnosticErrorDetails {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return { errorType: safeToken(typeof error, 'unknown') }
  }
  const value = error as { name?: unknown; code?: unknown; stack?: unknown; constructor?: { name?: string } }
  const frames = typeof value.stack === 'string'
    ? value.stack.split('\n').slice(1, MAX_STACK_FRAMES + 1).map(sanitizeStackFrame).filter(Boolean)
    : []
  return {
    errorType: safeToken(value.name ?? value.constructor?.name, 'Error'),
    ...(value.code !== undefined ? { errorCode: safeToken(value.code, 'unknown') } : {}),
    ...(frames.length ? { stack: frames } : {}),
  }
}

function normalizeEntry(input: DiagnosticEventInput): DiagnosticEntry {
  const level: DiagnosticLevel = ['info', 'warning', 'error'].includes(input.level) ? input.level : 'info'
  const status: DiagnosticStatus = ['started', 'success', 'failed', 'cancelled', 'info'].includes(input.status) ? input.status : 'info'
  const message = sanitizeDiagnosticMessage(input.message)
  const operationId = input.operationId ? safeToken(input.operationId, 'unknown', 96) : undefined
  const resourceType = input.resource ? safeToken(input.resource.type, 'resource') : undefined
  const resourceId = input.resource?.id ? safeToken(input.resource.id, 'unknown', 96) : undefined
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId,
    appVersion: sanitizeDiagnosticMessage(app.getVersion?.() ?? 'unknown') || 'unknown',
    platform: safeToken(process.platform, 'unknown'),
    arch: safeToken(process.arch, 'unknown'),
    level,
    category: safeToken(input.category, 'app'),
    action: safeToken(input.action, 'unknown'),
    status,
    ...(message ? { message } : {}),
    ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.round(input.durationMs!)) } : {}),
    ...(operationId ? { operationId } : {}),
    ...(resourceType ? { resource: { type: resourceType, ...(resourceId ? { id: resourceId } : {}) } } : {}),
    ...(input.errorType ? { errorType: safeToken(input.errorType, 'Error') } : {}),
    ...(input.errorCode ? { errorCode: safeToken(input.errorCode, 'unknown') } : {}),
    ...(input.stack?.length ? { stack: input.stack.slice(0, MAX_STACK_FRAMES).map(sanitizeStackFrame).filter(Boolean) } : {}),
  }
}

async function rotateIfNeeded(path: string, incomingBytes: number) {
  const size = await stat(path).then((value) => value.size).catch(() => 0)
  if (size + incomingBytes <= MAX_LOG_BYTES) return
  const previous = `${path}.1`
  await rm(previous, { force: true })
  await rename(path, previous).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

async function writeEntry(entry: DiagnosticEntry) {
  const path = diagnosticLogPath()
  const line = `${JSON.stringify(entry)}\n`
  const incomingBytes = Buffer.byteLength(line)
  if (incomingBytes > MAX_LOG_BYTES) return
  await mkdir(dirname(path), { recursive: true })
  await rotateIfNeeded(path, incomingBytes)
  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
}

function serializeIO<T>(operation: () => Promise<T>): Promise<T> {
  const result = ioQueue.then(operation, operation)
  ioQueue = result.then(() => undefined, () => undefined)
  return result
}

export function appendDiagnosticEvent(input: DiagnosticEventInput): Promise<void> {
  if (queuedWrites >= MAX_QUEUED_WRITES) {
    droppedWrites += 1
    return Promise.resolve()
  }
  let entry: DiagnosticEntry
  try {
    entry = normalizeEntry(input)
  } catch {
    return Promise.resolve()
  }
  queuedWrites += 1
  return serializeIO(async () => {
    try {
      if (droppedWrites) {
        const dropped = droppedWrites
        droppedWrites = 0
        await writeEntry(normalizeEntry({
          level: 'warning', category: 'diagnostics', action: 'queue-overflow', status: 'info',
          message: `${dropped} events dropped`,
        }))
      }
      await writeEntry(entry)
      writeFailureReported = false
    } catch (error) {
      // Diagnostics are observational. A broken log directory must never block
      // saving, synchronization, reload, or shutdown.
      if (!writeFailureReported) {
        writeFailureReported = true
        console.warn('Unable to write Notebook diagnostics', diagnosticErrorDetails(error))
      }
    } finally {
      queuedWrites -= 1
    }
  })
}

/** Best-effort synchronous path for fatal main-process errors. Never throws. */
export function appendFatalDiagnosticEvent(input: DiagnosticEventInput) {
  try {
    const entry = normalizeEntry(input)
    const line = `${JSON.stringify(entry)}\n`
    const incomingBytes = Buffer.byteLength(line)
    if (incomingBytes > MAX_LOG_BYTES) return
    const path = diagnosticLogPath()
    mkdirSync(dirname(path), { recursive: true })
    const size = (() => { try { return statSync(path).size } catch { return 0 } })()
    if (size + incomingBytes > MAX_LOG_BYTES) {
      rmSync(`${path}.1`, { force: true })
      try { renameSync(path, `${path}.1`) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Preserve the original fatal exception and normal Electron crash semantics.
  }
}

async function readEntries(path: string) {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try {
      const parsed = JSON.parse(line) as Partial<DiagnosticEntry>
      if (!parsed.timestamp || !parsed.category || !parsed.action || !parsed.status) return []
      return [parsed as DiagnosticEntry]
    } catch {
      return []
    }
  })
}

async function allDiagnosticEvents() {
  return serializeIO(async () => {
    const path = diagnosticLogPath()
    return [
      ...await readEntries(`${path}.1`),
      ...await readEntries(path),
    ]
  })
}

export async function readDiagnosticEvents(limit = 100): Promise<DiagnosticEntry[]> {
  const entries = await allDiagnosticEvents()
  return entries.slice(-Math.max(1, Math.min(500, Math.round(limit))))
}

/** Returns the complete retained two-file history for export (at most 4 MiB). */
export async function exportDiagnosticEvents(): Promise<DiagnosticEntry[]> {
  return allDiagnosticEvents()
}
