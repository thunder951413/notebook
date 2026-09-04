export const AUTO_SYNC_DEBOUNCE_MS = 60_000
export const AUTO_SYNC_MAX_WAIT_MS = 5 * 60_000
export const REMOTE_CHECK_INTERVAL_MS = 2 * 60_000
export type AutomaticSyncReason = 'startup' | 'online' | 'foreground' | 'background' | 'shutdown' | 'changes' | 'retry'

/** No idle polling: only lifecycle events check for remote changes. */
export function createAutomaticSyncPolicy() {
  let lastSuccess = -Infinity
  let retryAt = 0
  let failures = 0
  return {
    shouldRun(reason: AutomaticSyncReason, pending: boolean, now = Date.now()) {
      if (now < retryAt && reason !== 'online') return false
      if (pending) return true
      if (reason === 'background' || reason === 'shutdown' || reason === 'changes') return false
      return reason === 'startup' || reason === 'online' || reason === 'retry' || now - lastSuccess >= REMOTE_CHECK_INTERVAL_MS
    },
    succeeded(now = Date.now()) { lastSuccess = now; retryAt = 0; failures = 0 },
    failed(now = Date.now()) {
      const delay = Math.min(60_000 * 2 ** Math.min(failures++, 4), 15 * 60_000)
      retryAt = now + delay
      return delay
    },
  }
}

export type SettledSyncState = 'offline' | 'synced' | 'conflict' | 'error'

/**
 * Keeps the last non-transient state while a run is active. A cancelled run
 * must return to that state instead of leaving the toolbar on `syncing`.
 */
export function createSyncStateFinalizer(previous: SettledSyncState, commit: (state: SettledSyncState) => void) {
  let terminal = previous
  return {
    complete(state: SettledSyncState) { terminal = state },
    finish() {
      commit(terminal)
      return terminal
    },
  }
}

/** Coalesces normal durable outbox writes into one quiet-period sync. */
export function createQuietSyncScheduler(run: () => void | Promise<void>, delayMs = AUTO_SYNC_DEBOUNCE_MS, maxWaitMs = AUTO_SYNC_MAX_WAIT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstRequestedAt: number | undefined
  return {
    request() {
      firstRequestedAt ??= Date.now()
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        firstRequestedAt = undefined
        void run()
      }, Math.max(0, Math.min(delayMs, maxWaitMs - (Date.now() - firstRequestedAt))))
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      firstRequestedAt = undefined
    },
  }
}

/** Treats blur + visibilitychange(hidden) as one transition. */
export function createBackgroundSyncGate(run: () => void | Promise<void>) {
  let backgrounded = false
  return {
    background() {
      if (backgrounded) return
      backgrounded = true
      void run()
    },
    foreground() {
      backgrounded = false
    },
  }
}

/** Re-arms the quiet scheduler after a bounded sync batch leaves an outbox tail. */
export async function schedulePendingSyncBatch(hasPending: () => Promise<boolean>, request: () => void) {
  if (await hasPending()) request()
}
