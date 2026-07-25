import { app } from 'electron'
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticStatus = 'started' | 'success' | 'failed' | 'cancelled' | 'info'

export interface DiagnosticEventInput {
  level: DiagnosticLevel
  category: string
  action: string
  status: DiagnosticStatus
  message?: string
  durationMs?: number
}

export interface DiagnosticEntry extends DiagnosticEventInput {
  id: string
  timestamp: string
}

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_TEXT_LENGTH = 500
let writeQueue = Promise.resolve()

export function diagnosticLogPath() {
  return join(app.getPath('logs'), 'notebook-next-diagnostics.jsonl')
}

function safeToken(value: unknown, fallback: string) {
  const normalized = String(value ?? '').trim().replace(/[^a-z0-9._-]/gi, '-').slice(0, 64)
  return normalized || fallback
}

export function sanitizeDiagnosticMessage(value: unknown) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(password|passphrase|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/([?&](?:password|token|secret|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/\b(sk-[a-z0-9_-]{8,}|github_pat_[a-z0-9_]+|gh[opusr]_[a-z0-9_]+)\b/gi, '[redacted]')
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
}

function normalizeEntry(input: DiagnosticEventInput): DiagnosticEntry {
  const level: DiagnosticLevel = ['info', 'warning', 'error'].includes(input.level) ? input.level : 'info'
  const status: DiagnosticStatus = ['started', 'success', 'failed', 'cancelled', 'info'].includes(input.status) ? input.status : 'info'
  const message = sanitizeDiagnosticMessage(input.message)
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    category: safeToken(input.category, 'app'),
    action: safeToken(input.action, 'unknown'),
    status,
    ...(message ? { message } : {}),
    ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.round(input.durationMs!)) } : {}),
  }
}

async function rotateIfNeeded(path: string) {
  const size = await stat(path).then((value) => value.size).catch(() => 0)
  if (size < MAX_LOG_BYTES) return
  const previous = `${path}.1`
  await rm(previous, { force: true })
  await rename(path, previous)
}

export function appendDiagnosticEvent(input: DiagnosticEventInput): Promise<void> {
  const entry = normalizeEntry(input)
  const operation = writeQueue.catch(() => undefined).then(async () => {
    const path = diagnosticLogPath()
    await mkdir(dirname(path), { recursive: true })
    await rotateIfNeeded(path)
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  })
  writeQueue = operation
  return operation
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

export async function readDiagnosticEvents(limit = 100): Promise<DiagnosticEntry[]> {
  await writeQueue.catch(() => undefined)
  const path = diagnosticLogPath()
  const entries = [
    ...await readEntries(`${path}.1`),
    ...await readEntries(path),
  ]
  return entries.slice(-Math.max(1, Math.min(500, Math.round(limit))))
}
