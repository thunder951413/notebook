export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticStatus = 'started' | 'success' | 'failed' | 'cancelled' | 'info'

export interface DiagnosticEventInput {
  level: DiagnosticLevel
  category: string
  action: string
  status: DiagnosticStatus
  message?: string
  durationMs?: number
  operationId?: string
  resource?: { type: string; id?: string }
  errorType?: string
  errorCode?: string
  stack?: string[]
}

export interface DiagnosticEntry extends DiagnosticEventInput {
  id: string
  timestamp: string
}

// Messages are denied by default because renderer strings can originate from
// note content, filenames, remote responses, or user-supplied automation data.
// This list contains only enum labels and numeric/count summaries audited at
// their producers.
const SAFE_MESSAGE_EVENTS = new Set([
  'asset/save',
  'data/export',
  'data/import',
  'page/create',
  'page/restore',
  'page/trash',
  'privacy/normalize-page-placement',
  'settings/automatic-sync',
  'sync/conflict',
  'sync/entity-conflict',
  'sync/keep-local',
  'sync/outbox',
  'sync/run',
  'sync/server-check',
  'sync/upload-batch',
])

export function recordDiagnosticEvent(event: DiagnosticEventInput) {
  const keepMessage = event.level !== 'error' && SAFE_MESSAGE_EVENTS.has(`${event.category}/${event.action}`)
  const safeEvent = keepMessage ? event : { ...event, message: undefined, resource: undefined }
  void window.notebookDesktop?.diagnostics.record(safeEvent).catch(() => undefined)
}

export function rendererErrorDetails(error: unknown) {
  if (!(error instanceof Error)) return { errorType: typeof error }
  const code = (error as Error & { code?: unknown }).code
  return {
    errorType: error.name,
    ...(code !== undefined ? { errorCode: String(code) } : {}),
    ...(error.stack ? { stack: error.stack.split('\n').slice(1, 6) } : {}),
  }
}

export function installRendererDiagnostics() {
  recordDiagnosticEvent({ level: 'info', category: 'app', action: 'renderer-ready', status: 'success' })
  const onError = (event: ErrorEvent) => recordDiagnosticEvent({
    level: 'error',
    category: 'renderer',
    action: 'uncaught-error',
    status: 'failed',
    ...rendererErrorDetails(event.error),
  })
  const onRejection = (event: PromiseRejectionEvent) => recordDiagnosticEvent({
    level: 'error',
    category: 'renderer',
    action: 'unhandled-rejection',
    status: 'failed',
    ...rendererErrorDetails(event.reason),
  })
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
