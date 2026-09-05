import { randomUUID } from 'node:crypto'

export interface ReloadableContents {
  isDestroyed: () => boolean
  reload: () => void
}

interface RendererReloaderOptions<T extends ReloadableContents> {
  getContents: () => T | undefined
  flush: (contents: T, operationId: string) => Promise<void>
  onError: (error: unknown) => void
  onEvent?: (event: { phase: 'started' | 'flushed' | 'reloaded' | 'failed'; operationId: string; durationMs: number; error?: unknown }) => void
  createOperationId?: () => string
}

/** Reloads only after the renderer has durably flushed its latest editor state. */
export function createRendererReloader<T extends ReloadableContents>({ getContents, flush, onError, onEvent, createOperationId = randomUUID }: RendererReloaderOptions<T>) {
  let reloadInProgress = false

  const notify = (event: Parameters<NonNullable<typeof onEvent>>[0]) => {
    try { onEvent?.(event) } catch { /* Diagnostics must not affect reload. */ }
  }

  return () => {
    const contents = getContents()
    if (!contents || contents.isDestroyed() || reloadInProgress) return
    reloadInProgress = true
    const operationId = createOperationId()
    const startedAt = Date.now()
    notify({ phase: 'started', operationId, durationMs: 0 })
    void flush(contents, operationId).then(() => {
      notify({ phase: 'flushed', operationId, durationMs: Date.now() - startedAt })
      if (!contents.isDestroyed()) {
        contents.reload()
        notify({ phase: 'reloaded', operationId, durationMs: Date.now() - startedAt })
      }
    }).catch((error) => {
      notify({ phase: 'failed', operationId, durationMs: Date.now() - startedAt, error })
      onError(error)
    }).finally(() => {
      reloadInProgress = false
    })
  }
}
