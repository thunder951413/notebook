import { useCallback, useEffect, useRef, useState } from 'react'
import { loadSyncSettings } from '../sync/syncSettings'
import { synchronizeLegacySsh, type LegacySyncMode } from '../sync/legacySshSync'
import { loadSyncBackend } from '../sync/legacySshSettings'
import { synchronizeWebdav, type WebdavSyncIssues } from '../sync/webdavSync'
import { describeIssues } from '../sync/webdavIssues'
import { describeSyncError, recordSyncSuccess } from '../sync/syncErrors'
import { showToast } from '../components/toast'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'
import {
  MIN_AUTO_SYNC_INTERVAL_MS,
  VISIBLE_REMOTE_POLL_MS,
  createAutomaticSyncPolicy,
  createDeferredRun,
  createQuietSyncScheduler,
  createSyncStateFinalizer,
  schedulePendingSyncBatch,
  type AutomaticSyncReason,
  type SettledSyncState,
} from '../sync/syncLifecycle'
import { WORKSPACE_ID, repository } from './workspaceStore'

/**
 * Background synchronization for the workspace: one run at a time, automatic
 * triggers paced by the sync policy, retries and quiet-period batching.
 * `reload` refreshes the visible library after a run changed it.
 */
export function useWorkspaceSync(reload: () => Promise<void>) {
  const [syncState, setSyncState] = useState<'offline' | 'syncing' | 'synced' | 'conflict' | 'error'>('offline')
  const [syncError, setSyncError] = useState<string>()
  const [syncProgress, setSyncProgress] = useState<string>()
  const [syncIssues, setSyncIssues] = useState<WebdavSyncIssues>()
  const reportedIssues = useRef('')
  const settledSyncState = useRef<SettledSyncState>('offline')
  const syncRunning = useRef(false)
  const syncTask = useRef<Promise<boolean> | undefined>(undefined)
  const queuedSyncTask = useRef<Promise<boolean> | undefined>(undefined)
  const activeSyncSignal = useRef<AbortSignal | undefined>(undefined)
  const automaticSyncPolicy = useRef(createAutomaticSyncPolicy())
  const syncRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const syncScheduler = useRef<ReturnType<typeof createQuietSyncScheduler> | undefined>(undefined)
  const deferredSync = useRef<ReturnType<typeof createDeferredRun> | undefined>(undefined)
  const deferredSyncReason = useRef<AutomaticSyncReason>('boundary')

  const syncNow = useCallback((options?: { signal?: AbortSignal; force?: boolean; mode?: LegacySyncMode; scope?: { pageId: string }; reason?: AutomaticSyncReason }): Promise<boolean> => {
      if (syncTask.current) {
        // Automatic events join the current run. Durable outbox writes and
        // the completion check schedule any remaining edits after a quiet
        // period. Only an explicit manual request needs an immediate follow-up.
        // React may replace an aborted startup effect with a fresh one. It
        // must not join the cancelled run and silently lose the startup pull.
        if (!options?.force && !activeSyncSignal.current?.aborted) return syncTask.current
        if (!queuedSyncTask.current) {
          queuedSyncTask.current = syncTask.current.then(() => {
            queuedSyncTask.current = undefined
            return syncNow(options)
          })
        }
        return queuedSyncTask.current
      }
      activeSyncSignal.current = options?.signal
      const operation = (async () => {
      // The auto-sync switch gates every automatic trigger (startup, opening
      // a note, debounced edit sync); the manual toolbar button forces through.
      if (!options?.force && !loadSyncSettings().enabled) {
        // Skipping an automatic trigger must not erase the last manual
        // result (especially an actionable conflict or upload failure).
        return false
      }
      // Focus/blur and quiet-period triggers cannot resolve a conflict. Keep
      // its actionable state visible until the user explicitly retries or
      // chooses a winner, instead of repeatedly downloading the same prefix.
      if (!options?.force && settledSyncState.current === 'conflict') return false
      if (!options?.force) {
        const reason = options?.reason ?? 'foreground'
        const recentRequests = await window.notebookDesktop?.webdav.recentRequestCount?.().catch(() => undefined)
        const decision = automaticSyncPolicy.current.decide(reason, await repository.hasPendingSyncChanges(WORKSPACE_ID), Date.now(), recentRequests)
        if (!decision.run) {
          if (decision.retryInMs !== undefined) {
            deferredSyncReason.current = reason
            deferredSync.current?.schedule(decision.retryInMs)
          }
          if (decision.heldBy === 'budget') recordDiagnosticEvent({ level: 'warning', category: 'sync', action: 'request-budget', status: 'info', message: `30 分钟内已发出 ${recentRequests} 个请求，自动同步推迟` })
          return false
        }
        automaticSyncPolicy.current.started()
      }
      if (options?.signal?.aborted) return false
      syncScheduler.current?.cancel()
      if (syncRetryTimer.current !== undefined) clearTimeout(syncRetryTimer.current)
      syncRetryTimer.current = undefined
      const retryLater = () => {
        const delay = automaticSyncPolicy.current.failed()
        if (loadSyncSettings().enabled) syncRetryTimer.current = setTimeout(() => {
          syncRetryTimer.current = undefined
          void syncNow({ reason: 'retry' })
        }, delay)
      }
      syncRunning.current = true
      const startedAt = performance.now()
      const mode = options?.mode ?? 'bidirectional'
      const stateFinalizer = createSyncStateFinalizer(settledSyncState.current, (state) => {
        settledSyncState.current = state
        setSyncState(state)
      })
      setSyncState('syncing')
      setSyncProgress('正在准备同步…')
      setSyncError(undefined)
      recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'run', status: 'started', message: mode })
      try {
        const result = loadSyncBackend() === 'webdav'
          ? await synchronizeWebdav(repository, WORKSPACE_ID, options?.signal, options?.scope, mode, setSyncProgress)
          : await synchronizeLegacySsh(repository, WORKSPACE_ID, options?.force, options?.mode)
        stateFinalizer.complete(result.state)
        // The sync worked, but records or devices still need attention: say so
        // (once per distinct situation) instead of letting "synced" mean "all fine".
        const issues = 'issues' in result ? result.issues : undefined
        setSyncIssues(issues)
        const issueSummary = issues ? describeIssues(issues) : ''
        if (issueSummary && issueSummary !== reportedIssues.current) showToast(`已同步，但${issueSummary}。详情见 设置 → 同步状态与修复。`, { durationMs: 10_000 })
        reportedIssues.current = issueSummary
        if (result.state !== 'offline' && !('changed' in result && result.changed === false)) {
          await reload()
          const pages = repository.db?.pages
          if (pages) void pages.filter((page) => !page.deletedAt).count().then((count) => recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'library', status: 'info', message: `pages ${count}` }), () => undefined)
        }
        if (result.state === 'synced') {
          automaticSyncPolicy.current.succeeded()
          recordSyncSuccess()
        }
        // Concurrent edits no longer stop synchronization; tell the user where
        // the other version went instead of silently picking one.
        const resolvedConflicts = 'resolved' in result ? result.resolved ?? [] : []
        const copies = resolvedConflicts.filter((item) => item.copyPageId).length
        if (copies) showToast(`${copies} 篇笔记在多台设备上同时被修改：已保留本机版本，另一版本另存为“冲突副本”笔记。`, { durationMs: 10_000 })
        if ('republished' in result && result.republished) showToast('云端缺少本机的同步记录，已自动重新上传本机全部内容。', { durationMs: 8_000 })
        if (result.state === 'error') retryLater()
        // WebDAV acknowledges one bounded outbox batch at a time. Acking 200
        // items does not create another Dexie record, so schedule the next
        // batch explicitly instead of leaving the tail stranded forever. The
        // same quiet period prevents v4's whole-journal rewrite from becoming
        // an in-flight request storm.
        if (result.state === 'synced') await schedulePendingSyncBatch(
          () => repository.hasPendingSyncChanges(WORKSPACE_ID),
          () => { deferredSyncReason.current = 'boundary'; deferredSync.current?.schedule(MIN_AUTO_SYNC_INTERVAL_MS) },
        )
        const retryCount = 'retryCount' in result ? result.retryCount : 0
        recordDiagnosticEvent({
          level: result.state === 'conflict' ? 'warning' : 'info',
          category: 'sync',
          action: 'run',
          status: result.state === 'synced' ? 'success' : result.state === 'conflict' ? 'failed' : 'info',
          message: retryCount ? `${result.state} · 远端并发更新后自动重试 ${retryCount} 次` : result.state,
          durationMs: performance.now() - startedAt,
        })
        return result.state === 'synced'
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          const message = error instanceof Error ? error.message : '同步失败'
          stateFinalizer.complete('error')
          setSyncError(describeSyncError(message))
          retryLater()
          // Pulls commit in batches; show whatever this run already restored.
          void reload().catch(() => undefined)
          recordDiagnosticEvent({ level: 'error', category: 'sync', action: 'run', status: 'failed', message, durationMs: performance.now() - startedAt })
        } else {
          recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'run', status: 'cancelled', durationMs: performance.now() - startedAt })
        }
        return false
      } finally {
        // Commit the terminal state at the actual end of the run. Keeping this
        // in finally prevents an aborted lifecycle request or an overlapping
        // reload from leaving the toolbar permanently stuck on `syncing` even
        // though the transport already completed (and logged success).
        stateFinalizer.finish()
        setSyncProgress(undefined)
        syncRunning.current = false
      }
      })()
      syncTask.current = operation
      void operation.finally(() => {
        if (syncTask.current === operation) syncTask.current = undefined
      })
      return operation
  }, [reload])

  // Sync at startup, when the network comes back and on a slow visible poll.
  // Durable outbox writes schedule their own quiet-period sync.
  useEffect(() => {
    const controller = new AbortController()
    const sync = () => { void syncNow({ signal: controller.signal, reason: 'online' }) }
    void syncNow({ signal: controller.signal, reason: 'startup' })
    window.addEventListener('online', sync)
    // Edits made on the phone should appear without clicking “sync”. A slow
    // poll only while visible costs one small request when nothing changed.
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void syncNow({ reason: 'foreground' })
    }, VISIBLE_REMOTE_POLL_MS)
    return () => { controller.abort(); window.removeEventListener('online', sync); window.clearInterval(poll) }
  }, [syncNow])

  // Every durable outbox append gets one quiet-period sync. Draft
  // and scroll-local writes do not enter this path until explicitly flushed.
  useEffect(() => {
    const scheduler = createQuietSyncScheduler(() => { void syncNow({ reason: 'changes' }) })
    syncScheduler.current = scheduler
    const deferred = createDeferredRun(() => { void syncNow({ reason: deferredSyncReason.current }) })
    deferredSync.current = deferred
    return () => {
      scheduler.cancel()
      deferred.cancel()
      if (deferredSync.current === deferred) deferredSync.current = undefined
      if (syncRetryTimer.current !== undefined) clearTimeout(syncRetryTimer.current)
      if (syncScheduler.current === scheduler) syncScheduler.current = undefined
    }
  }, [syncNow])

  const requestSyncSoon = useCallback(() => { syncScheduler.current?.request() }, [])
  /** Leaving a note is a natural moment to upload its edits (paced by the policy). */
  const requestBoundarySync = useCallback(() => {
    // A moment later, so the closing editor's final save is in the outbox.
    deferredSyncReason.current = 'boundary'
    deferredSync.current?.schedule(1_500)
  }, [])

  useEffect(() => {
    const onOutboxAppend = () => { requestSyncSoon() }
    const event = repository.db.syncOutbox.hook('creating')
    event.subscribe(onOutboxAppend)
    return () => {
      event.unsubscribe(onOutboxAppend)
    }
  }, [requestSyncSoon])

  return { syncState, syncError, syncProgress, syncIssues, syncNow, requestSyncSoon, requestBoundarySync }
}
