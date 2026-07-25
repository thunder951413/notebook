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

export function recordDiagnosticEvent(event: DiagnosticEventInput) {
  void window.notebookDesktop?.diagnostics.record(event).catch(() => undefined)
}

export function installRendererDiagnostics() {
  recordDiagnosticEvent({ level: 'info', category: 'app', action: 'renderer-ready', status: 'success' })
  const onError = (event: ErrorEvent) => recordDiagnosticEvent({
    level: 'error',
    category: 'renderer',
    action: 'uncaught-error',
    status: 'failed',
    message: event.error instanceof Error ? event.error.message : event.message || '界面发生未捕获错误',
  })
  const onRejection = (event: PromiseRejectionEvent) => recordDiagnosticEvent({
    level: 'error',
    category: 'renderer',
    action: 'unhandled-rejection',
    status: 'failed',
    message: event.reason instanceof Error ? event.reason.message : '界面发生未处理的异步错误',
  })
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
