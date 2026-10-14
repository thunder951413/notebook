import { useEffect, useRef } from 'react'
import { automationRepository } from '../data/workspaceStore'
import { applyLegacyImport } from '../sync/legacyImport'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'
import { showToast } from '../components/toast'

/**
 * Desktop-shell events handled once per app: adopting the old desktop app's
 * sync settings (then restoring the library), announcing a downloaded update
 * and opening the update center from the menu.
 */
export function useDesktopMigrationAndUpdates(syncNow: (options?: { force?: boolean }) => Promise<boolean>, openUpdateCenter: () => void) {
  // Moving from the old desktop app: take over its sync settings once and
  // restore the library from WebDAV right away.
  const syncNowRef = useRef(syncNow)
  syncNowRef.current = syncNow
  useEffect(() => {
    let cancelled = false
    void applyLegacyImport().then(async (imported) => {
      if (!imported || cancelled) return
      showToast('已从旧版导入坚果云设置，正在恢复笔记…', { durationMs: 8_000 })
      const synced = await syncNowRef.current({ force: true })
      const restoredCount = await automationRepository.db.pages.filter((page) => !page.deletedAt).count()
      recordDiagnosticEvent({ level: synced ? 'info' : 'warning', category: 'migration', action: 'restored', status: synced ? 'success' : 'failed', message: `pages ${restoredCount}` })
      showToast(synced ? `恢复完成：${restoredCount} 篇笔记和待办` : '设置已导入，但这次同步没有完成，稍后会自动重试', { kind: synced ? 'info' : 'error', durationMs: 10_000 })
    }).catch((error: unknown) => showToast(error instanceof Error ? error.message : '无法导入旧版设置', { kind: 'error' }))
    return () => { cancelled = true }
  }, [])

  // Updates download quietly in the background; offer the restart once ready.
  useEffect(() => {
    const updates = window.notebookDesktop?.updates
    if (!updates) return
    let announced = ''
    return updates.onStateChanged((state) => {
      if (state.status !== 'downloaded' || !state.availableVersion || announced === state.availableVersion) return
      announced = state.availableVersion
      showToast(`新版本 ${state.availableVersion} 已下载`, {
        durationMs: 60_000,
        action: { label: '重启并更新', run: () => { void updates.install().catch((error: unknown) => showToast(error instanceof Error ? error.message : '无法安装更新', { kind: 'error' })) } },
      })
    })
  }, [])
  const openUpdateCenterRef = useRef(openUpdateCenter)
  openUpdateCenterRef.current = openUpdateCenter
  useEffect(() => window.notebookDesktop?.events.onUpdateCenter?.(() => openUpdateCenterRef.current()), [])
}
