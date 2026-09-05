import { describe, expect, test, vi } from 'vitest'
import { createRendererReloader, type ReloadableContents } from './reloadLifecycle'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('renderer reload lifecycle', () => {
  test('waits for the durable renderer flush before reloading', async () => {
    const pendingFlush = deferred()
    const contents: ReloadableContents = { isDestroyed: () => false, reload: vi.fn() }
    const flush = vi.fn(() => pendingFlush.promise)
    const onEvent = vi.fn()
    const reload = createRendererReloader({ getContents: () => contents, flush, onError: vi.fn(), onEvent, createOperationId: () => 'reload-1' })

    reload()
    reload()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(contents, 'reload-1')
    expect(contents.reload).not.toHaveBeenCalled()

    pendingFlush.resolve()
    await pendingFlush.promise
    await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledTimes(1))
    expect(onEvent.mock.calls.map(([event]) => event.phase)).toEqual(['started', 'flushed', 'reloaded'])
    expect(onEvent.mock.calls.every(([event]) => event.operationId === 'reload-1')).toBe(true)
  })

  test('keeps the current renderer open when its flush fails', async () => {
    const failure = new Error('disk full')
    const contents: ReloadableContents = { isDestroyed: () => false, reload: vi.fn() }
    const onError = vi.fn()
    const reload = createRendererReloader({
      getContents: () => contents,
      flush: () => Promise.reject(failure),
      onError,
      onEvent: vi.fn(),
      createOperationId: () => 'reload-2',
    })

    reload()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(contents.reload).not.toHaveBeenCalled()
  })
})
