export const AUTO_SYNC_DEBOUNCE_MS = 30_000

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
export function createQuietSyncScheduler(run: () => void | Promise<void>, delayMs = AUTO_SYNC_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    request() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void run()
      }, delayMs)
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
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
