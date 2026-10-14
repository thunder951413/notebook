import { useEffect, useMemo } from 'react'
import { registerAfterFlushHandler } from '../data/flushCoordinator'
import { createBackgroundSyncGate } from '../sync/syncLifecycle'
import type { AutomaticSyncReason } from '../sync/syncLifecycle'

type SyncNow = (options?: { reason?: AutomaticSyncReason }) => Promise<boolean>

/**
 * Sync at the app's lifecycle boundaries: a bounded final sync after the
 * quit/hide flush, and a background/foreground gate driven by window focus
 * and visibility (flushing reading positions before going to background).
 */
export function useLifecycleSync(syncNow: SyncNow, flushDirtyReadingPositions: () => Promise<void>) {
  useEffect(() => registerAfterFlushHandler(async () => {
    // Quitting must not strand a durable outbox behind an unbounded network
    // request. A timeout leaves the outbox intact for the next launch.
    let timer: number | undefined
    try {
      await Promise.race([
        syncNow({ reason: 'shutdown' }),
        new Promise<void>((resolve) => { timer = window.setTimeout(resolve, 4_000) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }), [syncNow])

  const backgroundSyncGate = useMemo(() => createBackgroundSyncGate(async () => {
    await flushDirtyReadingPositions()
    await syncNow({ reason: 'background' })
  }), [flushDirtyReadingPositions, syncNow])

  useEffect(() => {
    const onFocus = () => {
      backgroundSyncGate.foreground()
      void syncNow({ reason: 'foreground' })
    }
    const onBlur = () => { backgroundSyncGate.background() }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') backgroundSyncGate.background()
      else onFocus()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [backgroundSyncGate, syncNow])
}
