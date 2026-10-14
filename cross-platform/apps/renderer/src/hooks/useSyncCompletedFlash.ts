import { useEffect, useRef, useState } from 'react'

/** True for two seconds after a sync run finished successfully ("同步完成"). */
export function useSyncCompletedFlash(syncState: string) {
  const previousSyncState = useRef(syncState)
  const syncCompletionTimer = useRef<number | undefined>(undefined)
  const [showSyncCompleted, setShowSyncCompleted] = useState(false)
  useEffect(() => {
    const previous = previousSyncState.current
    previousSyncState.current = syncState
    if (syncCompletionTimer.current) {
      window.clearTimeout(syncCompletionTimer.current)
      syncCompletionTimer.current = undefined
    }
    if (previous === 'syncing' && syncState === 'synced') {
      setShowSyncCompleted(true)
      syncCompletionTimer.current = window.setTimeout(() => {
        setShowSyncCompleted(false)
        syncCompletionTimer.current = undefined
      }, 2_000)
    } else if (syncState !== 'synced') {
      setShowSyncCompleted(false)
    }
    return () => {
      if (syncCompletionTimer.current) window.clearTimeout(syncCompletionTimer.current)
    }
  }, [syncState])
  return showSyncCompleted
}
