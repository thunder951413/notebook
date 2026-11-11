import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, getToasts } from '../components/toast'
import * as diagnostics from '../diagnostics/diagnostics'
import {
  markSaveErrorToasted,
  reportAutosaveFailure,
  reportDraftFailure,
  resetAutosaveFailureThrottleForTests,
} from './autosaveError'

beforeEach(() => {
  resetAutosaveFailureThrottleForTests()
  for (const toast of getToasts().slice()) dismissToast(toast.id)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const toast of getToasts().slice()) dismissToast(toast.id)
})

describe('autosaveError', () => {
  it('logs diagnostic events and shows a throttled error toast on autosave failure', () => {
    const recordSpy = vi.spyOn(diagnostics, 'recordDiagnosticEvent').mockImplementation(() => undefined)
    reportAutosaveFailure(new Error('QuotaExceededError'))
    reportAutosaveFailure(new Error('QuotaExceededError again'))

    expect(recordSpy).toHaveBeenCalledTimes(2)
    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      category: 'storage',
      action: 'autosave',
      status: 'failed',
      errorType: 'Error',
    }))
    const errorToasts = getToasts().filter((toast) => toast.kind === 'error' && toast.message.includes('自动保存失败'))
    expect(errorToasts).toHaveLength(1)
  })

  it('logs diagnostic events without duplicate generic toast when caller already toasted', () => {
    const recordSpy = vi.spyOn(diagnostics, 'recordDiagnosticEvent').mockImplementation(() => undefined)
    const conflictError = new Error('正文已有其他更新')
    markSaveErrorToasted(conflictError)
    reportAutosaveFailure(conflictError)

    expect(recordSpy).toHaveBeenCalledOnce()
    expect(getToasts()).toHaveLength(0)
  })

  it('logs crash-draft staging failures via diagnostics', () => {
    const recordSpy = vi.spyOn(diagnostics, 'recordDiagnosticEvent').mockImplementation(() => undefined)
    reportDraftFailure(new Error('Disk full'))
    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      category: 'storage',
      action: 'draft-stage',
      status: 'failed',
    }))
  })
})
