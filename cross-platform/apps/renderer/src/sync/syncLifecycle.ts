/*
 * When to talk to 坚果云 — the same rules as the Android app (SyncPacing.kt).
 *
 * 坚果云 allows 600 WebDAV requests per 30 minutes for free accounts (1500
 * paid), shared by every device; one sync costs roughly 3–10 requests. Edits
 * are saved locally at once and uploaded at natural boundaries instead of
 * after every pause in typing:
 *
 * - switching notes, hiding the window, quitting: upload pending edits;
 *   automatic uploads stay at least MIN_AUTO_SYNC_INTERVAL_MS apart;
 * - a long editing session: at most one upload per EDIT_SYNC_MAX_WAIT_MS;
 * - focusing the window: download only when the last sync is older than
 *   REMOTE_CHECK_INTERVAL_MS (switching apps is not a reason to sync);
 * - this device stays under AUTO_REQUEST_BUDGET requests per window so other
 *   devices keep room. A manual sync is never held back.
 */
export const EDIT_SYNC_MAX_WAIT_MS = 5 * 60_000
export const MIN_AUTO_SYNC_INTERVAL_MS = 60_000
export const REMOTE_CHECK_INTERVAL_MS = 2 * 60_000
/** While the window is visible, look for other devices' edits this often (one small request when unchanged). */
export const VISIBLE_REMOTE_POLL_MS = 10 * 60_000
export const REQUEST_BUDGET_WINDOW_MS = 30 * 60_000
export const AUTO_REQUEST_BUDGET = 240
/** Kept for callers that still name the old constants. */
export const AUTO_SYNC_DEBOUNCE_MS = EDIT_SYNC_MAX_WAIT_MS
export const AUTO_SYNC_MAX_WAIT_MS = EDIT_SYNC_MAX_WAIT_MS
export type AutomaticSyncReason = 'startup' | 'online' | 'foreground' | 'background' | 'shutdown' | 'changes' | 'boundary' | 'retry'

export interface SyncDecision {
  run: boolean
  /** When set, the same request should be retried after this delay. */
  retryInMs?: number
  /** Why it was held back, for diagnostics. */
  heldBy?: 'interval' | 'budget' | 'backoff'
}

const UPLOAD_REASONS = new Set<AutomaticSyncReason>(['changes', 'boundary', 'background'])

export function createAutomaticSyncPolicy() {
  let lastSuccess = -Infinity
  let lastRun = -Infinity
  let retryAt = 0
  let failures = 0
  const decide = (reason: AutomaticSyncReason, pending: boolean, now = Date.now(), recentRequests?: number): SyncDecision => {
      // Quitting must not strand edits, and it happens once.
      if (reason === 'shutdown') return { run: pending }
      if (now < retryAt && reason !== 'online') return { run: false, heldBy: 'backoff' }
      if (UPLOAD_REASONS.has(reason)) {
        if (!pending) return { run: false }
      } else if (reason === 'foreground' && now - lastSuccess < REMOTE_CHECK_INTERVAL_MS) {
        return { run: false }
      }
      if (recentRequests !== undefined && recentRequests >= AUTO_REQUEST_BUDGET) return { run: false, retryInMs: 5 * 60_000, heldBy: 'budget' }
      if (UPLOAD_REASONS.has(reason) && now - lastRun < MIN_AUTO_SYNC_INTERVAL_MS) {
        return { run: false, retryInMs: Math.max(1_000, lastRun + MIN_AUTO_SYNC_INTERVAL_MS - now), heldBy: 'interval' }
      }
      return { run: true }
  }
  return {
    decide,
    /** Boolean form of decide(). */
    shouldRun: (reason: AutomaticSyncReason, pending: boolean, now = Date.now()) => decide(reason, pending, now).run,
    started(now = Date.now()) { lastRun = now },
    succeeded(now = Date.now()) { lastSuccess = now; retryAt = 0; failures = 0 },
    failed(now = Date.now()) {
      const delay = Math.min(60_000 * 2 ** Math.min(failures++, 4), 15 * 60_000)
      retryAt = now + delay
      return delay
    },
  }
}

/** Runs one deferred request at the earliest time asked for. */
export function createDeferredRun(run: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let dueAt = Infinity
  return {
    schedule(delayMs: number, now = Date.now()) {
      const target = now + Math.max(0, delayMs)
      if (timer !== undefined && dueAt <= target) return
      if (timer !== undefined) clearTimeout(timer)
      dueAt = target
      timer = setTimeout(() => { timer = undefined; dueAt = Infinity; run() }, Math.max(0, delayMs))
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      dueAt = Infinity
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

/** Coalesces durable outbox writes: one sync at most maxWait after the first edit. */
export function createQuietSyncScheduler(run: () => void | Promise<void>, delayMs = EDIT_SYNC_MAX_WAIT_MS, maxWaitMs = EDIT_SYNC_MAX_WAIT_MS) {
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
