import { showToast } from '../components/toast'
import { recordDiagnosticEvent, rendererErrorDetails } from '../diagnostics/diagnostics'

const AUTOSAVE_ERROR_THROTTLE_MS = 15_000

let lastAutosaveToastAt = 0
let lastDraftDiagnosticAt = 0
const alreadyToastedErrors = new WeakSet<object>()

export function markSaveErrorToasted(error: unknown) {
  if (error && typeof error === 'object') alreadyToastedErrors.add(error)
}

export function reportAutosaveFailure(error: unknown) {
  recordDiagnosticEvent({
    level: 'error',
    category: 'storage',
    action: 'autosave',
    status: 'failed',
    ...rendererErrorDetails(error),
  })
  if (error && typeof error === 'object' && alreadyToastedErrors.has(error)) return
  const now = Date.now()
  if (now - lastAutosaveToastAt >= AUTOSAVE_ERROR_THROTTLE_MS) {
    lastAutosaveToastAt = now
    showToast('自动保存失败，请检查磁盘空间或存储权限', { kind: 'error' })
  }
}

export function reportDraftFailure(error: unknown) {
  const now = Date.now()
  if (now - lastDraftDiagnosticAt < AUTOSAVE_ERROR_THROTTLE_MS) return
  lastDraftDiagnosticAt = now
  recordDiagnosticEvent({
    level: 'error',
    category: 'storage',
    action: 'draft-stage',
    status: 'failed',
    ...rendererErrorDetails(error),
  })
}

export function resetAutosaveFailureThrottleForTests() {
  lastAutosaveToastAt = 0
  lastDraftDiagnosticAt = 0
}
