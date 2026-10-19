import { useEffect, useRef, useState } from 'react'
import { requestConfirm } from '../components/confirmDialog'
import { Badge, Button, Input, Switch, Tab, TabList, Text } from '@fluentui/react-components'
import { loadSyncSettings, saveSyncSettings, type SyncSettings } from '../sync/syncSettings'
import { clearWebdavAppPassword, clearWebdavSyncPassword, getWebdavAppPassword, getWebdavSyncPassword, hasWebdavAppPassword, loadWebdavSettings, saveWebdavSettings, type WebdavSettings } from '../sync/webdavSettings'
import { testWebdavConnection } from '../sync/webdavSync'
import type { WebdavBlockedDevice } from '../sync/webdavIssues'
import type { QuarantineReason, SyncQuarantineItem } from '@notebook/storage-renderer'
import { serializeWebdavQrPayload } from '../sync/webdavQrConfig'
import QRCode from 'qrcode'
import type { LegacySyncMode } from '../sync/legacySshSync'
import { ACCENT_PRESETS, type AccentColor } from '../appearance/accent'
import type { ThemePreference } from '../appearance/theme'
import { recordDiagnosticEvent, type DiagnosticEntry } from '../diagnostics/diagnostics'
import type { AutomationProposal } from '@notebook/domain'
import { diffLines } from 'diff'
import { buildAutomationHandoffText } from '../automation/handoff'
import { AutomationWorkspaceReview } from '../automation/AutomationWorkspaceReview'
import type { NotebookSummary, PageSummary } from '../model'
import { AIProviderSettingsPanel } from './AIProviderSettings'
import { lastSyncSuccess, relativeTime } from '../sync/syncErrors'
import { fileManagerName } from '../shell/keys'

type SettingsPage = 'general' | 'data' | 'services' | 'automation'
type SyncState = 'offline' | 'syncing' | 'synced' | 'conflict' | 'error'

interface SettingsCenterProps {
  initialPage?: SettingsPage
  theme: 'light' | 'dark'
  accentColor: AccentColor
  syncState: SyncState
  syncError?: string
  syncProgress?: string
  currentPageTitle: string
  transferMessage?: string
  dataRoot?: { path: string; source: 'default' | 'environment' | 'command-line' | 'saved' }
  desktop: boolean
  aiService?: string
  collaborationService?: string
  privacyAvailable: boolean
  privacyConfigured: boolean
  privacyUnlocked: boolean
  automationProposals: AutomationProposal[]
  automationNotebooks: NotebookSummary[]
  automationPages: PageSummary[]
  onClose: () => void
  themePreference: ThemePreference
  onThemePreferenceChange: (preference: ThemePreference) => void
  onAccentColorChange: (color: AccentColor) => void
  onSyncNow: (mode?: LegacySyncMode) => Promise<boolean>
  onImport: () => void
  onExportPage: (format: 'md' | 'html') => void
  onPrint: () => void
  onExportWorkspace: () => void
  onExportEncrypted: () => void
  onResetHistory: () => Promise<{ pageCount: number; removedRevisionCount: number }>
  onChooseDataRoot?: () => void
  onPrivacyAction: () => void
  onMigrateFromSsh: () => Promise<{ published: number }>
  onApplyAutomationProposal: (proposalId: string) => Promise<void>
  onRejectAutomationProposal: (proposalId: string) => Promise<void>
  /** Self-service repair tools for WebDAV synchronization. */
  syncRepair?: {
    status: () => Promise<{ pending: number; conflictCopies: number }>
    resetReadPositions: () => Promise<void>
    republishAll: () => Promise<number>
    /** Remote records set aside and devices whose journal cannot be read. */
    issues: () => Promise<{ quarantined: number; blocked: WebdavBlockedDevice[]; items: SyncQuarantineItem[]; ownDeviceId: string }>
    /** Keep a copy of this device's damaged journal, remove it and queue everything for publication again. */
    rebuildOwnJournal: () => Promise<{ backup?: string; floorSeq: number; republished: number }>
    retryIssues: () => Promise<number>
    dismissIssues: (ids: string[]) => Promise<void>
  }
}

const quarantineLabels: Record<QuarantineReason, { title: string; hint: string }> = {
  'needs-key': { title: '需要隐私同步密钥', hint: '在上方填写与其他设备相同的同步密码，下次同步会自动读取。' },
  'bad-key': { title: '隐私同步密钥不匹配', hint: '确认各设备使用同一个同步密码；正确后会自动读取。' },
  'unknown-type': { title: '来自更新版本的记录', hint: '升级本应用后会自动读取。' },
  'invalid-payload': { title: '记录内容不正确', hint: '可能由其他版本写入。升级应用后会重试一次；仍失败请导出诊断日志。' },
  'workspace-mismatch': { title: '属于其他工作区', hint: '不会影响本机内容，可以删除。' },
  'missing-object': { title: '云端文件缺失', hint: '请在产生该内容的设备上选“重新上传本机全部内容”，再点“重试”。' },
  'object-corrupt': { title: '云端文件已损坏', hint: '请在产生该内容的设备上选“重新上传本机全部内容”，再点“重试”。' },
}

const blockedLabels: Record<WebdavBlockedDevice['code'], string> = {
  'journal-corrupt': '日志含有无法解析的记录',
  'head-corrupt': '提交标记损坏',
  'journal-truncated': '日志被截断，部分记录丢失',
  'journal-missing': '日志文件缺失',
  'journal-too-large': '日志超过 100 MB',
}

const syncLabels: Record<SyncState, string> = {
  offline: '仅保存在本机',
  syncing: '正在同步',
  synced: '同步完成',
  conflict: '同步冲突',
  error: '同步失败',
}

function focusableChildren(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    // Fluent UI's mover inserts aria-hidden tab sentinels. They must not
    // become our dialog's tab boundary.
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true' && !element.hasAttribute('data-tabster-dummy'))
}

function trapDialogKey(event: KeyboardEvent, container: HTMLElement, onClose: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    onClose()
    return
  }
  if (event.key !== 'Tab') return
  const controls = focusableChildren(container)
  if (!controls.length) return
  const first = controls[0]!
  const last = controls[controls.length - 1]!
  const source = event.target
  if (event.shiftKey && (document.activeElement === first || source === first)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || source === last)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    first.focus()
  }
}

export function SettingsCenter({ initialPage = 'general', theme, themePreference, accentColor, syncState, syncError, syncProgress, currentPageTitle, transferMessage, dataRoot, desktop, aiService, collaborationService, privacyAvailable, privacyConfigured, privacyUnlocked, automationProposals, automationNotebooks, automationPages, onClose, onThemePreferenceChange, onAccentColorChange, onSyncNow, onImport, onExportPage, onPrint, onExportWorkspace, onExportEncrypted, onResetHistory, onChooseDataRoot, onPrivacyAction, onMigrateFromSsh, onApplyAutomationProposal, onRejectAutomationProposal, syncRepair }: SettingsCenterProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const qrDialogRef = useRef<HTMLElement>(null)
  const qrCloseButtonRef = useRef<HTMLButtonElement>(null)
  const qrReturnFocusRef = useRef<HTMLElement | null>(null)
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() => loadSyncSettings())
  const [webdavSettings, setWebdavSettings] = useState<WebdavSettings>(() => loadWebdavSettings())
  const [webdavAppPassword, setWebdavAppPassword] = useState('')
  const [webdavSyncPassword, setWebdavSyncPassword] = useState('')
  const [storedWebdavAppPassword, setStoredWebdavAppPassword] = useState(false)
  const [storedWebdavSyncPassword, setStoredWebdavSyncPassword] = useState(false)
  const [savingSync, setSavingSync] = useState(false)
  const [savingAutoSync, setSavingAutoSync] = useState(false)
  const [checkingServer, setCheckingServer] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string>()
  const [syncMessageIsError, setSyncMessageIsError] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [webdavQrOpen, setWebdavQrOpen] = useState(false)
  const [webdavQrDataUrl, setWebdavQrDataUrl] = useState<string>()
  const [webdavQrError, setWebdavQrError] = useState<string>()
  const [updateState, setUpdateState] = useState<DesktopUpdateState>()
  const [updateActionError, setUpdateActionError] = useState<string>()
  const [githubReleaseToken, setGithubReleaseToken] = useState('')
  const [storedGithubReleaseToken, setStoredGithubReleaseToken] = useState(false)
  const [diagnosticEntries, setDiagnosticEntries] = useState<DiagnosticEntry[]>([])
  const [diagnosticMessage, setDiagnosticMessage] = useState<string>()
  const [automationState, setAutomationState] = useState<{ enabled: boolean; port: number; baseUrl: string; token?: string; rendererReady: boolean }>()
  const [automationPort, setAutomationPort] = useState(47831)
  const [automationMessage, setAutomationMessage] = useState<string>()
  const [automationBusy, setAutomationBusy] = useState(false)

  useEffect(() => setPage(initialPage), [initialPage])
  useEffect(() => {
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (!dialog || webdavQrOpen || !(event.target instanceof Node) || !dialog.contains(event.target)) return
      trapDialogKey(event, dialog, onClose)
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose, webdavQrOpen])
  useEffect(() => {
    if (!webdavQrOpen) return
    qrReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => qrCloseButtonRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      const target = qrReturnFocusRef.current
      requestAnimationFrame(() => target?.isConnected && target.focus())
    }
  }, [webdavQrOpen])
  useEffect(() => {
    if (!webdavQrOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = qrDialogRef.current
      if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return
      trapDialogKey(event, dialog, () => setWebdavQrOpen(false))
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [webdavQrOpen])
  useEffect(() => { void hasWebdavAppPassword().then(setStoredWebdavAppPassword) }, [])
  useEffect(() => { void getWebdavSyncPassword().then((value) => setStoredWebdavSyncPassword(Boolean(value))) }, [])
  useEffect(() => {
    const updates = window.notebookDesktop?.updates
    if (!updates) return
    void updates.getState().then(setUpdateState).catch((error: unknown) => {
      setUpdateActionError(error instanceof Error ? error.message : '无法读取更新状态')
    })
    return updates.onStateChanged((state) => {
      setUpdateState(state)
      setUpdateActionError(undefined)
    })
  }, [])
  useEffect(() => {
    if (!desktop) return
    void window.notebookDesktop?.secrets.get('github-release-token').then((value) => setStoredGithubReleaseToken(Boolean(value)))
  }, [desktop])
  useEffect(() => {
    if (page !== 'data' || !desktop) return
    void refreshDiagnostics()
  }, [desktop, page])
  useEffect(() => {
    if (page !== 'automation' || !desktop) return
    void window.notebookDesktop?.automation.getState().then((state) => {
      setAutomationState(state)
      setAutomationPort(state.port)
    }).catch((error: unknown) => setAutomationMessage(error instanceof Error ? error.message : '无法读取外部 AI 接口状态'))
  }, [desktop, page])

  const configureAutomation = async (enabled: boolean) => {
    if (!window.notebookDesktop || automationBusy) return
    setAutomationBusy(true)
    setAutomationMessage(undefined)
    try {
      const state = await window.notebookDesktop.automation.configure(enabled, automationPort)
      setAutomationState(state)
      setAutomationPort(state.port)
      setAutomationMessage(enabled ? `本地 AI 接口已启动：${state.baseUrl}` : '本地 AI 接口已关闭。')
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : '无法更改外部 AI 接口状态')
    } finally {
      setAutomationBusy(false)
    }
  }

  const regenerateAutomationToken = async () => {
    if (!window.notebookDesktop || automationBusy) return
    if (!(await requestConfirm({ title: '重新生成自动化 Token？', description: '旧 Token 会立即失效。确定重新生成吗？', confirmLabel: '重新生成', destructive: true }))) return
    setAutomationBusy(true)
    try {
      setAutomationState(await window.notebookDesktop.automation.regenerateToken())
      setAutomationMessage('访问 Token 已更新，旧 Token 已失效。')
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : '无法更新访问 Token')
    } finally {
      setAutomationBusy(false)
    }
  }

  const copyAutomationHandoff = async () => {
    const token = automationState?.token
    const baseUrl = automationState?.baseUrl
    if (!token || !baseUrl || !automationState.enabled) {
      setAutomationMessage('请先启用本地 AI 接口，再复制接入说明。')
      return
    }
    try {
      await navigator.clipboard.writeText(buildAutomationHandoffText({ baseUrl, token }))
      setAutomationMessage('AI 接入说明已复制，包含访问 Token；请直接粘贴给可信 AI，不要发布到聊天记录之外或公共位置。')
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : '无法复制 AI 接入说明')
    }
  }

  const reviewAutomationProposal = async (proposal: AutomationProposal, decision: 'apply' | 'reject') => {
    if (automationBusy) return
    if (decision === 'apply' && !(await requestConfirm({ title: `应用“${proposal.title}”？`, description: `将应用其中的 ${proposal.changes.length} 项修改。每篇现有笔记都会先保留历史版本，确定继续吗？`, confirmLabel: '应用修改', destructive: true }))) return
    setAutomationBusy(true)
    setAutomationMessage(undefined)
    try {
      if (decision === 'apply') await onApplyAutomationProposal(proposal.id)
      else await onRejectAutomationProposal(proposal.id)
      setAutomationMessage(decision === 'apply' ? 'AI 修改已应用并进入正常同步队列。' : 'AI 修改提案已拒绝，笔记没有变化。')
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : '无法审阅 AI 修改提案')
    } finally {
      setAutomationBusy(false)
    }
  }

  const refreshDiagnostics = async () => {
    try {
      const entries = await window.notebookDesktop?.diagnostics.list(100) ?? []
      setDiagnosticEntries(entries)
      setDiagnosticMessage(undefined)
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : '无法读取诊断日志')
    }
  }

  const exportDiagnostics = async () => {
    try {
      const path = await window.notebookDesktop?.diagnostics.export()
      if (path) setDiagnosticMessage(`诊断日志已导出到 ${path}`)
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : '无法导出诊断日志')
    }
  }

  const runUpdateAction = async (action: 'check' | 'download' | 'install' | 'open') => {
    const updates = window.notebookDesktop?.updates
    if (!updates) return
    setUpdateActionError(undefined)
    try {
      if (action === 'check') setUpdateState(await updates.check())
      else if (action === 'download') setUpdateState(await updates.download())
      else if (action === 'install') await updates.install()
      else await updates.openReleasePage()
    } catch (error) {
      setUpdateActionError(error instanceof Error ? error.message : '更新操作失败')
    }
  }

  const saveGithubReleaseToken = async () => {
    const token = githubReleaseToken.trim()
    if (!token || !window.notebookDesktop) return
    setUpdateActionError(undefined)
    try {
      await window.notebookDesktop.secrets.set('github-release-token', token)
      setGithubReleaseToken('')
      setStoredGithubReleaseToken(true)
      setUpdateState(await window.notebookDesktop.updates.check())
    } catch (error) {
      setUpdateActionError(error instanceof Error ? error.message : '无法保存 GitHub Token')
    }
  }

  const clearGithubReleaseToken = async () => {
    if (!window.notebookDesktop) return
    await window.notebookDesktop.secrets.delete('github-release-token')
    setGithubReleaseToken('')
    setStoredGithubReleaseToken(false)
    setUpdateState(await window.notebookDesktop.updates.check())
  }

  const saveAndSync = async () => {
    if (savingSync || syncState === 'syncing') return
    setSavingSync(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const savedWebdav = await saveWebdavSettings(webdavSettings, webdavAppPassword || undefined, webdavSyncPassword || undefined)
      setWebdavSettings(savedWebdav)
      if (webdavAppPassword) { setStoredWebdavAppPassword(true); setWebdavAppPassword('') }
      if (webdavSyncPassword) setStoredWebdavSyncPassword(true)
      const saved = await saveSyncSettings(syncSettings)
      setSyncSettings(saved)
      const succeeded = await onSyncNow('bidirectional')
      setSyncMessage(succeeded
        ? '设置已保存，双向同步已完成。'
        : !navigator.onLine
          ? `设置已保存；当前离线${saved.enabled ? '，将在联网后自动同步' : ''}。`
          : undefined)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '无法保存同步设置')
      setSyncMessageIsError(true)
    } finally { setSavingSync(false) }
  }

  const toggleAutoSync = async (enabled: boolean) => {
    if (savingAutoSync) return
    const previous = syncSettings
    const next = { ...syncSettings, enabled }
    setSyncSettings(next)
    setSavingAutoSync(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const saved = await saveSyncSettings(next)
      setSyncSettings(saved)
      recordDiagnosticEvent({ level: 'info', category: 'settings', action: 'automatic-sync', status: 'success', message: enabled ? '已启用' : '已关闭' })
      if (!enabled) {
        setSyncMessage('自动同步已关闭；仍可使用右上角或下方按钮手动同步。')
        return
      }
      setSyncMessage('自动同步已开启，正在执行首次同步…')
      const synchronized = await onSyncNow('bidirectional')
      setSyncMessage(synchronized ? '自动同步已开启，首次同步已完成。' : undefined)
    } catch (error) {
      setSyncSettings(previous)
      setSyncMessage(error instanceof Error ? error.message : '无法保存自动同步设置')
      setSyncMessageIsError(true)
      recordDiagnosticEvent({ level: 'error', category: 'settings', action: 'automatic-sync', status: 'failed', message: error instanceof Error ? error.message : '无法保存设置' })
    } finally {
      setSavingAutoSync(false)
    }
  }

  const [repairStatus, setRepairStatus] = useState<{ pending: number; conflictCopies: number }>()
  const [repairing, setRepairing] = useState(false)
  const [issueSnapshot, setIssueSnapshot] = useState<{ quarantined: number; blocked: WebdavBlockedDevice[]; items: SyncQuarantineItem[]; ownDeviceId: string }>()
  useEffect(() => {
    if (page !== 'services' || !syncRepair) return
    let cancelled = false
    void syncRepair.status().then((status) => { if (!cancelled) setRepairStatus(status) }).catch(() => undefined)
    void syncRepair.issues().then((snapshot) => { if (!cancelled) setIssueSnapshot(snapshot) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [page, syncRepair, syncState])

  const retryIssues = async () => {
    if (!syncRepair || repairing || savingSync || syncState === 'syncing') return
    setRepairing(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const remaining = await syncRepair.retryIssues()
      setSyncMessage(remaining ? `仍有 ${remaining} 条云端记录暂时无法应用，原因见下方列表。` : '所有异常记录都已处理。')
      setSyncMessageIsError(remaining > 0)
      setIssueSnapshot(await syncRepair.issues())
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '重试失败')
      setSyncMessageIsError(true)
    } finally {
      setRepairing(false)
    }
  }

  const rebuildOwnJournal = async () => {
    if (!syncRepair || repairing || savingSync || syncState === 'syncing') return
    const confirmed = await requestConfirm({ title: '重建本机日志？', description: '本机在云端的同步日志已损坏，所以无法上传新的修改。重建会保留一份损坏文件的副本（同目录下以 .corrupt 结尾），移除损坏的日志，再把本机全部内容重新上传；序号会接着原来的继续，其他设备已读取的内容不会重复或丢失。本机笔记不会改动。', confirmLabel: '重建并重新上传' })
    if (!confirmed) return
    setRepairing(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const rebuilt = await syncRepair.rebuildOwnJournal()
      const succeeded = await onSyncNow('bidirectional')
      setSyncMessage(succeeded ? `本机日志已重建，已重新排队 ${rebuilt.republished} 条内容${rebuilt.backup ? '，损坏的日志已另存备份' : ''}。` : '日志已重建，但这次同步没有完成；内容已排队保留，请稍后重试。')
      setSyncMessageIsError(!succeeded)
      setIssueSnapshot(await syncRepair.issues())
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '重建失败')
      setSyncMessageIsError(true)
    } finally {
      setRepairing(false)
    }
  }

  const dismissIssues = async () => {
    if (!syncRepair || !issueSnapshot?.items.length || repairing) return
    const confirmed = await requestConfirm({ title: `删除 ${issueSnapshot.items.length} 条异常记录？`, description: '这些云端记录将不再尝试读取，本机内容不受影响。其他设备上的原始记录不会被删除。此操作无法撤销。', confirmLabel: '删除异常记录' })
    if (!confirmed) return
    await syncRepair.dismissIssues(issueSnapshot.items.map((item) => item.id))
    setIssueSnapshot(await syncRepair.issues())
  }

  const runRepair = async (kind: 'reread' | 'republish') => {
    if (!syncRepair || repairing || savingSync || syncState === 'syncing') return
    const confirmed = kind === 'reread'
      ? await requestConfirm({ title: '重新读取全部云端记录？', description: '会忽略本机记住的读取位置，从头核对坚果云上所有设备的记录。已有内容不会被删除或重复，适合“别的设备的修改迟迟不出现”时使用。记录多时会多花一些流量。', confirmLabel: '重新读取并同步' })
      : await requestConfirm({ title: '重新上传本机全部内容？', description: '会把本机所有笔记、附件和设置重新排队上传，作为当前版本的后续版本。其他设备会自动合并，不会产生重复笔记。适合云端目录被清空、或新设备缺少部分笔记时使用。', confirmLabel: '重新上传并同步' })
    if (!confirmed) return
    setRepairing(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      if (kind === 'reread') await syncRepair.resetReadPositions()
      const queued = kind === 'republish' ? await syncRepair.republishAll() : 0
      const succeeded = await onSyncNow('bidirectional')
      setSyncMessage(succeeded
        ? kind === 'reread' ? '已重新核对全部云端记录，同步完成。' : `已重新上传 ${queued} 条记录${(await syncRepair.status()).pending ? '；剩余内容会分批继续上传' : ''}。`
        : '修复已开始，但本次同步没有完成；内容已排队保留，请查看上方错误后重试。')
      setSyncMessageIsError(!succeeded)
      setRepairStatus(await syncRepair.status())
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '修复失败')
      setSyncMessageIsError(true)
    } finally {
      setRepairing(false)
    }
  }

  const keepLocalAndSync = async () => {
    if (savingSync || checkingServer || syncState === 'syncing') return
    if (!await requestConfirm({ title: '以本机内容解决同步冲突？', description: '请先导出完整备份。本机已有内容将覆盖远端对应记录，远端独有内容仍会保留并下载；配置隐私同步密钥后，私密内容以密文上传。此选择仅用于本次恢复，之后仍使用正常双向同步。', confirmLabel: '保留本机并同步' })) return
    setSavingSync(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const succeeded = await onSyncNow('push')
      setSyncMessage(succeeded ? '已保留本机内容并发布本批变更；如仍有待上传项，请继续同步。' : '恢复未完成，本机内容和待上传变更仍保留，请查看错误后重试。')
      setSyncMessageIsError(!succeeded)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '无法完成本机优先同步')
      setSyncMessageIsError(true)
    } finally {
      setSavingSync(false)
    }
  }

  const testWebdavServer = async () => {
    if (savingSync || checkingServer || syncState === 'syncing') return
    setCheckingServer(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    const startedAt = performance.now()
    recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'server-check', status: 'started' })
    try {
      const saved = await saveWebdavSettings(webdavSettings, webdavAppPassword || undefined, webdavSyncPassword || undefined)
      const appPassword = webdavAppPassword || await getWebdavAppPassword()
      if (!appPassword) throw new Error('请填写 WebDAV 应用密码后再检测连接')
      const syncPassword = webdavSyncPassword || await getWebdavSyncPassword() || undefined
      const result = await testWebdavConnection(saved, appPassword, syncPassword)
      if (!result.ok) throw new Error(result.message || '无法连接 WebDAV 服务器')
      setWebdavSettings(saved)
      if (webdavAppPassword) {
        setStoredWebdavAppPassword(true)
        setWebdavAppPassword('')
      }
      setSyncMessage(result.remotePathExists
        ? `服务器连接正常（${result.latencyMs} ms），远端目录可访问。`
        : `服务器连接正常（${result.latencyMs} ms）；远端目录尚不存在，首次同步时会自动创建。`)
      recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'server-check', status: 'success', message: result.remotePathExists ? '远端目录可访问' : '远端目录尚未创建', durationMs: performance.now() - startedAt })
    } catch (error) {
      const message = describeSshConnectionError(error)
      setSyncMessage(message)
      setSyncMessageIsError(true)
      recordDiagnosticEvent({ level: 'error', category: 'sync', action: 'server-check', status: 'failed', message, durationMs: performance.now() - startedAt })
    } finally {
      setCheckingServer(false)
    }
  }

  /** Encode the current WebDAV configuration into a QR code for Android to scan. */
  const showWebdavQr = async () => {
    const appPassword = webdavAppPassword || await getWebdavAppPassword() || ''
    const syncPassword = webdavSyncPassword || ((await getWebdavSyncPassword()) ?? '')
    try {
      const payload = serializeWebdavQrPayload(webdavSettings, appPassword, syncPassword)
      setWebdavQrDataUrl(await QRCode.toDataURL(payload, { width: 300, margin: 1 }))
      setWebdavQrError(undefined)
      setWebdavQrOpen(true)
    } catch (error) {
      setWebdavQrError(error instanceof Error ? error.message : '无法生成配置二维码')
    }
  }

  const removeWebdavAppPassword = async () => {
    await clearWebdavAppPassword()
    setWebdavAppPassword('')
    setStoredWebdavAppPassword(false)
    setSyncMessageIsError(false)
    setSyncMessage('WebDAV 应用密码已从当前设备删除。')
  }

  const removeWebdavSyncPassword = async () => {
    await clearWebdavSyncPassword()
    setWebdavSyncPassword('')
    setStoredWebdavSyncPassword(false)
    setSyncMessageIsError(false)
    setSyncMessage('同步密码已从当前设备删除。')
  }

  const migrateFromSsh = async () => {
    if (migrating || savingSync || syncState === 'syncing') return
    if (!(await requestConfirm({ title: '从 SSH 迁移到坚果云 WebDAV？', description: '将从旧 SSH/SFTP 仓库读取最新数据，并一次性发布到坚果云 WebDAV。SSH 仅用于本次迁移或兼容恢复，不作为日常同步。确定继续吗？', confirmLabel: '开始迁移', destructive: true }))) return
    setMigrating(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const savedWebdav = await saveWebdavSettings(webdavSettings, webdavAppPassword || undefined, webdavSyncPassword || undefined)
      setWebdavSettings(savedWebdav)
      if (webdavAppPassword) { setStoredWebdavAppPassword(true); setWebdavAppPassword('') }
      if (webdavSyncPassword) setStoredWebdavSyncPassword(true)
      await saveSyncSettings({ ...syncSettings, enabled: true })
      setSyncSettings((current) => ({ ...current, enabled: true }))
      const result = await onMigrateFromSsh()
      setSyncMessage(`迁移完成：已发布 ${result.published} 条变更到坚果云。`)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '迁移失败')
      setSyncMessageIsError(true)
    } finally {
      setMigrating(false)
    }
  }

  const resetHistory = async () => {
    if (savingSync) return
    if (!(await requestConfirm({ title: '重置全部版本历史？', description: '这会永久删除所有旧历史版本，并将每篇笔记的当前内容设为唯一初始版本。随后需要同步覆盖远端。确定继续吗？', confirmLabel: '重置历史', destructive: true }))) return
    setSavingSync(true)
    setSyncMessage(undefined)
    try {
      const result = await onResetHistory()
      const synchronized = await onSyncNow('push')
      setSyncMessage(synchronized
        ? `已删除 ${result.removedRevisionCount} 个旧版本；${result.pageCount} 篇笔记已设为初始版本并覆盖远端。`
        : `已在本机删除 ${result.removedRevisionCount} 个旧版本并重建 ${result.pageCount} 个初始版本，但远端同步尚未完成。`)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '无法重置版本历史')
    } finally {
      setSavingSync(false)
    }
  }

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="settings-dialog settings-center" role="dialog" aria-modal="true" aria-label="设置">
      <header className="settings-center-header"><div><h2>Notebook 设置</h2><p>应用的外观、数据、服务和安全选项都集中在这里。</p></div><Button ref={closeButtonRef} appearance="subtle" aria-label="关闭设置" onClick={onClose}>关闭</Button></header>
      <div className="settings-center-layout">
        <TabList vertical selectedValue={page} onTabSelect={(_, data) => setPage(data.value as SettingsPage)} aria-label="设置类别">
          <Tab value="general">常规</Tab>
          <Tab value="data">数据与备份</Tab>
          <Tab value="services">同步与连接</Tab>
          <Tab value="automation">AI 与自动化</Tab>
        </TabList>
        <div className="settings-center-content">
          {transferMessage && <div className="settings-message" role="status">{transferMessage}</div>}
          {page === 'general' && <>
            <SettingsSection title="外观" description="主题设置按当前设备保存。">
              <SettingsRow title="颜色主题" description={themePreference === 'system' ? `当前跟随系统（${theme === 'dark' ? '深色' : '浅色'}）` : `当前使用${theme === 'dark' ? '深色' : '浅色'}模式`}><div className="settings-action-grid"><Button appearance={themePreference === 'light' ? 'primary' : 'subtle'} onClick={() => onThemePreferenceChange('light')}>浅色</Button><Button appearance={themePreference === 'dark' ? 'primary' : 'subtle'} onClick={() => onThemePreferenceChange('dark')}>深色</Button><Button appearance={themePreference === 'system' ? 'primary' : 'subtle'} onClick={() => onThemePreferenceChange('system')}>跟随系统</Button></div></SettingsRow>
              <div className="accent-setting">
                <div><strong>高亮色</strong><span>用于选中项、主按钮、链接和编辑器焦点</span></div>
                <div className="accent-options" role="radiogroup" aria-label="高亮色">
                  {ACCENT_PRESETS.map((preset) => <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={accentColor === preset.id}
                    aria-label={preset.label}
                    className={accentColor === preset.id ? 'selected' : ''}
                    onClick={() => onAccentColorChange(preset.id)}
                  ><span style={{ background: preset.main }} /><small>{preset.label}</small></button>)}
                </div>
              </div>
            </SettingsSection>
            <SettingsSection title="工作状态" description="Notebook 会优先保存到本机，再按服务配置进行同步。">
              <SettingsRow title="同步状态" description={syncLabels[syncState]}><Badge appearance="tint" color={syncState === 'error' || syncState === 'conflict' ? 'danger' : syncState === 'offline' ? 'informative' : 'success'}>{syncLabels[syncState]}</Badge></SettingsRow>
              <SettingsRow title="快速记录" description="在桌面版任何界面呼出新页面"><kbd>Ctrl/Cmd + Shift + N</kbd></SettingsRow>
            </SettingsSection>
            {desktop && <SettingsSection title="应用更新" description="macOS、Windows 和 Linux 统一检查 GitHub Release。">
              <SettingsRow
                title={`Notebook Next ${updateState?.currentVersion ?? ''}`}
                description={updateState?.message ?? '正在读取更新状态…'}
              >
                <Badge
                  appearance="tint"
                  color={updateState?.status === 'error' ? 'danger' : updateState?.status === 'available' || updateState?.status === 'downloaded' ? 'warning' : updateState?.status === 'up-to-date' ? 'success' : 'informative'}
                >
                  {updateState?.status === 'checking' ? '检查中'
                    : updateState?.status === 'available' ? `可更新至 ${updateState.availableVersion}`
                      : updateState?.status === 'downloading' ? `下载 ${Math.round(updateState.progressPercent ?? 0)}%`
                        : updateState?.status === 'downloaded' ? '等待重启安装'
                          : updateState?.status === 'up-to-date' ? '已是最新'
                            : updateState?.status === 'error' ? '检查失败'
                              : '尚未检查'}
                </Badge>
              </SettingsRow>
              {updateState?.status === 'downloading' && <div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(updateState.progressPercent ?? 0)}>
                <span style={{ width: `${updateState.progressPercent ?? 0}%` }} />
                <small>{formatBytes(updateState.transferredBytes)} / {formatBytes(updateState.totalBytes)}</small>
              </div>}
              {(updateActionError || updateState?.status === 'error') && <div className="sync-settings-result error" role="alert">{updateActionError ?? updateState?.message}</div>}
              <div className="settings-action-grid">
                {updateState?.status === 'available' && updateState.canAutoInstall
                  ? <Button appearance="primary" onClick={() => void runUpdateAction('download')}>下载更新</Button>
                  : updateState?.status === 'available'
                    ? <Button appearance="primary" onClick={() => void runUpdateAction('open')}>打开 Release 下载页</Button>
                    : updateState?.status === 'downloaded'
                      ? <Button appearance="primary" onClick={() => void runUpdateAction('install')}>重启并安装</Button>
                      : <Button disabled={updateState?.status === 'checking' || updateState?.status === 'downloading'} onClick={() => void runUpdateAction('check')}>检查更新</Button>}
                <Button appearance="subtle" onClick={() => void runUpdateAction('open')}>查看 GitHub Release</Button>
              </div>
              {updateState?.checkedAt && <Text size={200}>上次检查：{new Date(updateState.checkedAt).toLocaleString()}</Text>}
              {updateState?.releaseNotes && <details className="update-release-notes"><summary>查看 {updateState.releaseName || updateState.availableVersion || '新版本'} 的更新说明</summary><pre>{updateState.releaseNotes}</pre></details>}
              <details className="update-release-notes" open={updateState?.requiresAuthentication || undefined}>
                <summary>私有 GitHub 仓库凭据{storedGithubReleaseToken ? '（已配置）' : '（可选）'}</summary>
                <div className="private-release-token">
                  <Text size={200}>使用仅对该仓库授予 Contents: Read 的 fine-grained Token。Token 只加密保存在当前设备，不会写入笔记或安装包。</Text>
                  <Input
                    type="password"
                    value={githubReleaseToken}
                    onChange={(_, data) => setGithubReleaseToken(data.value)}
                    placeholder={storedGithubReleaseToken ? '已安全保存；输入新值可替换' : 'github_pat_…'}
                    aria-label="GitHub Release 只读 Token"
                  />
                  <div className="settings-action-grid">
                    <Button disabled={!githubReleaseToken.trim()} onClick={() => void saveGithubReleaseToken()}>保存并重新检查</Button>
                    {storedGithubReleaseToken && <Button appearance="subtle" onClick={() => void clearGithubReleaseToken()}>清除 Token</Button>}
                  </div>
                </div>
              </details>
              {!updateState?.canAutoInstall && <Text size={200}>当前安装包不支持应用内安装时，仍可检测版本并跳转到对应 Release。Windows 请优先使用 NSIS 安装版，Linux 请优先使用 AppImage/DEB。</Text>}
            </SettingsSection>}
          </>}
          {page === 'data' && <>
            <SettingsSection title="导入" description="支持旧版导出包、加密备份、Markdown、HTML 和文本文件。">
              <div className="settings-action-grid"><Button appearance="primary" onClick={onImport}>选择文件并导入</Button></div>
            </SettingsSection>
            <SettingsSection title="完整备份" description="导出全部笔记本、页面、附件和版本。">
              <div className="settings-action-grid"><Button onClick={onExportWorkspace}>导出完整备份</Button><Button onClick={onExportEncrypted}>导出加密备份</Button></div>
            </SettingsSection>
            <SettingsSection title="版本历史" description="永久移除旧版本，只把每篇笔记的当前正文保留为新的初始版本。">
              <div className="settings-action-grid"><Button appearance="secondary" disabled={savingSync || syncState === 'syncing'} onClick={() => void resetHistory()}>删除旧历史并重建基线</Button></div>
              <Text size={200}>此操作不会删除当前正文、图片或附件；完成后会通过 WebDAV 发布新的同步基线。</Text>
            </SettingsSection>
            <SettingsSection title="当前页面" description={currentPageTitle}>
              <div className="settings-action-grid"><Button onClick={() => onExportPage('md')}>导出 Markdown</Button><Button onClick={() => onExportPage('html')}>导出 HTML</Button><Button onClick={onPrint}>打印 / 导出 PDF</Button></div>
            </SettingsSection>
            <SettingsSection title="数据目录" description={desktop ? '桌面版数据目录用于保存本机数据库和附件。' : '浏览器数据由当前浏览器配置管理。'}>
              <div className="settings-path">{dataRoot?.path ?? (desktop ? '正在读取…' : '浏览器 IndexedDB（由浏览器管理）')}</div>
              {onChooseDataRoot && <Button onClick={onChooseDataRoot}>更改数据目录并重启</Button>}
              <Text size={200}>旧版 NotebookData 请通过上方“导入”迁移，不要直接作为新数据目录使用。</Text>
            </SettingsSection>
            {desktop && <SettingsSection title="诊断日志" description="记录最近的应用、同步和数据操作，便于定位问题；不会保存笔记正文、标题或密码。">
              <div className="diagnostic-log" role="log" aria-label="最近诊断日志">
                {diagnosticEntries.length ? [...diagnosticEntries].reverse().slice(0, 40).map((entry) => <div key={entry.id} className={`diagnostic-entry ${entry.level}`}>
                  <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>
                  <strong>{diagnosticActionLabel(entry.category, entry.action)}</strong>
                  <span className={`diagnostic-status ${entry.status}`}>{diagnosticStatusLabel(entry.status)}</span>
                  {entry.message && <p>{entry.message}</p>}
                  {entry.durationMs !== undefined && <small>{entry.durationMs} ms</small>}
                </div>) : <div className="diagnostic-empty">还没有诊断记录。后续启动、同步和数据操作会显示在这里。</div>}
              </div>
              <div className="settings-action-grid">
                <Button onClick={() => void refreshDiagnostics()}>刷新日志</Button>
                <Button onClick={() => void exportDiagnostics()}>导出日志</Button>
                <Button appearance="subtle" onClick={() => void window.notebookDesktop?.diagnostics.reveal()}>在{fileManagerName()}中显示</Button>
              </div>
              {diagnosticMessage && <div className="sync-settings-result" role="status">{diagnosticMessage}</div>}
            </SettingsSection>}
          </>}
          {page === 'services' && <>
            <SettingsSection title="WebDAV 同步" description="坚果云 WebDAV 是跨设备日常同步的唯一正式方式；笔记以 v4 日志格式同步到同一远端仓库。">
              <div className="sync-settings-form">
                <Switch aria-label="启用自动同步" checked={syncSettings.enabled} disabled={savingAutoSync} onChange={(_, data) => void toggleAutoSync(data.checked)} label={savingAutoSync ? '正在保存自动同步设置…' : '启用自动同步（关闭后仍可手动同步）'} />
                {!desktop && <div className="sync-settings-result">浏览器通过 127.0.0.1:8787 的本机 Python 助手连接 WebDAV 同步；应用密码仅保存在当前标签会话。</div>}
                  <label><span>WebDAV 服务器地址</span><Input value={webdavSettings.baseUrl} onChange={(_, data) => setWebdavSettings((current) => ({ ...current, baseUrl: data.value }))} placeholder="https://dav.jianguoyun.com/dav/" aria-label="WebDAV 服务器地址" /></label>
                  <div className="sync-ssh-grid">
                    <label><span>用户名</span><Input value={webdavSettings.username} onChange={(_, data) => setWebdavSettings((current) => ({ ...current, username: data.value }))} placeholder="坚果云账号" aria-label="WebDAV 用户名" /></label>
                    <label><span>应用密码</span><Input type="password" value={webdavAppPassword} onChange={(_, data) => setWebdavAppPassword(data.value)} placeholder={storedWebdavAppPassword ? (desktop ? '已由操作系统加密保存；留空保持不变' : '已保存在当前标签会话；留空保持不变') : '坚果云安全选项生成的应用密码'} aria-label="WebDAV 应用密码" /></label>
                  </div>
                  <label><span>远端同步目录</span><Input value={webdavSettings.remotePath} onChange={(_, data) => setWebdavSettings((current) => ({ ...current, remotePath: data.value }))} placeholder="notebook_backup" aria-label="远端同步目录" /></label>
                  <label><span>隐私同步密钥</span><Input type="password" value={webdavSyncPassword} onChange={(_, data) => setWebdavSyncPassword(data.value)} placeholder={storedWebdavSyncPassword ? (desktop ? '已由操作系统加密保存；留空保持不变' : '已保存在当前标签会话；留空保持不变') : '与 Android 使用相同密钥，加密同步私密笔记、附件和历史'} aria-label="同步密码" /></label>
                <div className="sync-action-panel">
                  <div className="sync-action-heading"><strong>连接与同步</strong><span>先检测连接；日常多设备同步只使用 WebDAV。</span></div>
                  <div className="sync-primary-actions">
                    <Button disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void testWebdavServer()}>{checkingServer ? '正在检测…' : '检测服务器连接'}</Button>
                    <Button appearance="primary" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void saveAndSync()}>{savingSync || syncState === 'syncing' ? '正在同步…' : '立即同步'}</Button>
                    <Button appearance="secondary" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void showWebdavQr()}>生成配置二维码</Button>
                  </div>
                </div>
                {syncState === 'syncing' && syncProgress && <div className="sync-settings-result" role="status">{syncProgress}</div>}
                <div className="sync-utility-actions">
                  {syncState === 'conflict' && <Button disabled={savingSync || checkingServer} onClick={() => void keepLocalAndSync()}>以本机为准解决冲突</Button>}
                  {storedWebdavSyncPassword && <Button appearance="subtle" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void removeWebdavSyncPassword()}>清除已保存同步密码</Button>}
                  {storedWebdavAppPassword && <Button appearance="subtle" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void removeWebdavAppPassword()}>清除已保存应用密码</Button>}
                </div>
                {desktop && <details className="sync-action-panel">
                  <summary>从旧 SSH 迁移 / 兼容工具</summary>
                  <div className="sync-action-heading"><strong>旧 SSH/SFTP 仓库</strong><span>仅用于一次性迁移、恢复或核对历史仓库；不再推荐作为持续同步后端。</span></div>
                  <div className="sync-primary-actions">
                    <Button appearance="subtle" disabled={migrating || savingSync || checkingServer || syncState === 'syncing'} onClick={() => void migrateFromSsh()}>{migrating ? '正在迁移…' : '迁移 SSH 数据到坚果云'}</Button>
                  </div>
                </details>}
                {(syncMessage || syncError) && <div className={`sync-settings-result ${(syncMessage ? syncMessageIsError : Boolean(syncError)) ? 'error' : ''}`} role="status">{syncMessage ?? syncError}</div>}
              <Text size={200}>坚果云需先在网页版“安全选项”中生成应用密码。修改停止 30 秒后合并同步，持续编辑最多等待 3 分钟；切换到其他应用或退出时会立即同步待上传内容。回到窗口时最多每 2 分钟检查一次云端，另外每 10 分钟后台检查一次。失败后逐步延长重试间隔，手动同步可立即重试。</Text>
              </div>
            </SettingsSection>
            {syncRepair && <SettingsSection title="同步状态与修复" description="多台设备同时修改同一篇笔记时，同步不会中断：本机版本保留，另一版本另存为“冲突副本”笔记，可对比后删除。">
              <dl className="settings-service-list sync-health-list">
                <dt>当前状态</dt><dd>{syncLabels[syncState]}{syncState === 'error' && syncError ? ` · ${syncError}` : ''}</dd>
                <dt>上次成功同步</dt><dd>{relativeTime(lastSyncSuccess())}</dd>
                <dt>等待上传</dt><dd>{repairStatus ? `${repairStatus.pending} 条变更` : '…'}</dd>
                <dt>冲突副本</dt><dd>{repairStatus ? (repairStatus.conflictCopies ? `${repairStatus.conflictCopies} 篇（标题含“冲突副本”）` : '无') : '…'}</dd>
              </dl>
              <div className="settings-action-grid">
                <Button disabled={repairing || savingSync || syncState === 'syncing'} onClick={() => void runRepair('reread')}>{repairing ? '正在修复…' : '重新读取全部云端记录'}</Button>
                <Button disabled={repairing || savingSync || syncState === 'syncing'} onClick={() => void runRepair('republish')}>重新上传本机全部内容</Button>
              </div>
              {issueSnapshot && (issueSnapshot.items.length > 0 || issueSnapshot.blocked.length > 0) && <div className="sync-issues" role="status">
                <strong>需要处理的同步问题</strong>
                {issueSnapshot.blocked.map((device) => device.deviceId === issueSnapshot.ownDeviceId
                  ? <p key={device.deviceId}>本机的云端同步日志异常（{blockedLabels[device.code]}），新的修改暂时无法上传。请选择下方“重建本机日志”。</p>
                  : <p key={device.deviceId}>设备 {device.deviceId.slice(0, 8)}：{blockedLabels[device.code]}。其余设备的同步不受影响；请在那台设备上打开应用，在同步设置中选择“重建本机日志”。</p>)}
                {[...new Set(issueSnapshot.items.map((item) => item.reason))].map((reason) => {
                  const rows = issueSnapshot.items.filter((item) => item.reason === reason)
                  return <p key={reason}>{rows.length} 条：{quarantineLabels[reason].title}。{quarantineLabels[reason].hint}</p>
                })}
                <div className="settings-action-grid">
                  {issueSnapshot.blocked.some((device) => device.deviceId === issueSnapshot.ownDeviceId) && <Button appearance="primary" disabled={repairing || savingSync || syncState === 'syncing'} onClick={() => void rebuildOwnJournal()}>重建本机日志</Button>}
                  {issueSnapshot.items.length > 0 && <Button disabled={repairing || savingSync || syncState === 'syncing'} onClick={() => void retryIssues()}>{repairing ? '正在重试…' : '重试异常记录'}</Button>}
                  {issueSnapshot.items.length > 0 && <Button appearance="subtle" disabled={repairing || savingSync || syncState === 'syncing'} onClick={() => void dismissIssues()}>删除异常记录</Button>}
                </div>
              </div>}
              <Text size={200}>别的设备的修改没出现：选“重新读取”。云端目录被清空或新设备缺笔记：选“重新上传”。两者都不会删除任何内容，可以放心重复执行。仍有问题时，在“数据与备份 → 诊断日志”导出日志。</Text>
            </SettingsSection>}
            <SettingsSection title="其他服务" description="AI 与实时协作可以独立部署；未配置时不影响本地笔记和数据同步。">
              <dl className="settings-service-list"><dt>AI 服务</dt><dd>{aiService ?? '本机 127.0.0.1:8787'}</dd><dt>协作服务</dt><dd>{collaborationService ?? '未配置 · Yjs 离线模式'}</dd></dl>
            </SettingsSection>
            <SettingsSection title="安全" description="敏感信息不会写入笔记内容。">
              <SettingsRow title="隐私笔记本" description={!privacyAvailable ? '尚未导入隐私笔记本' : privacyUnlocked ? '当前已解锁；关闭应用后会重新锁定' : privacyConfigured ? '当前已锁定' : '需要为此设备设置新的隐私密码'}><Button disabled={!privacyAvailable} onClick={onPrivacyAction}>{privacyUnlocked ? '立即锁定' : privacyConfigured ? '解锁' : '设置密码'}</Button></SettingsRow>
              <p className="settings-note">隐私锁会从普通列表、搜索、任务、提醒和 AI 上下文中隐藏内容。当前 WebDAV v4 会把隐私笔记本及其页面、正文、历史、附件和内部关系严格保留在本机，不会明文上传；跨设备隐私同步将在统一的加密协议完成后启用。</p>
              <p className="settings-note">Electron 桌面版使用操作系统凭据保存 WebDAV 应用密码与同步密码；普通浏览器只在当前标签会话保存，不写入 localStorage 或 IndexedDB。</p>
              <p className="settings-note">加密备份使用 AES-GCM；备份口令只在当前设备处理，无法由服务端找回。</p>
            </SettingsSection>
          </>}
          {page === 'automation' && <>
            <SettingsSection title="内置 AI 模型" description="在 Notebook 内直接对话并通过 @ 指定文章；回答先进入暂存审阅，不直接改写笔记。">
              <AIProviderSettingsPanel />
            </SettingsSection>
            <SettingsSection title="本地 AI 自动化接口" description="让外部 AI 搜索笔记并提交结构化修改提案；只监听 127.0.0.1，不接受局域网连接。">
              {!desktop
                ? <div className="sync-settings-result error">外部 AI 接口仅在 Electron 桌面版可用。</div>
                : <>
                  <SettingsRow title="接口状态" description={automationState?.enabled ? `正在监听 ${automationState.baseUrl}` : '默认关闭；启动后仍需 Bearer Token'}>
                    <Switch checked={Boolean(automationState?.enabled)} disabled={automationBusy} onChange={(_, data) => void configureAutomation(data.checked)} label={automationState?.enabled ? '已启用' : '已关闭'} />
                  </SettingsRow>
                  <div className="automation-api-config">
                    <label><span>端口</span><Input type="number" min={1024} max={65535} value={String(automationPort)} disabled={automationState?.enabled || automationBusy} onChange={(_, data) => setAutomationPort(Number(data.value) || 47831)} /></label>
                    <label><span>地址</span><Input readOnly value={automationState?.baseUrl ?? `http://127.0.0.1:${automationPort}`} /></label>
                    <label><span>Bearer Token</span><Input readOnly type="password" value={automationState?.token ?? ''} /></label>
                  </div>
                  <div className="settings-action-grid">
                    <Button appearance="primary" disabled={!automationState?.enabled || !automationState.token} onClick={() => void copyAutomationHandoff()}>复制 AI 接入说明</Button>
                    <Button disabled={!automationState?.token} onClick={() => void navigator.clipboard.writeText(automationState?.token ?? '').then(() => setAutomationMessage('Token 已复制。'))}>复制 Token</Button>
                    <Button disabled={!automationState?.token} onClick={() => void navigator.clipboard.writeText(`${automationState?.baseUrl}/v1/guide`).then(() => setAutomationMessage('AI 规则接口地址已复制。'))}>复制规则地址</Button>
                    <Button appearance="subtle" disabled={automationBusy} onClick={() => void regenerateAutomationToken()}>重新生成 Token</Button>
                  </div>
                  <Text size={200}>“复制 AI 接入说明”会把地址、Token、完整流程和安全规则合成一段可直接粘贴给 AI 的指令。内容包含访问凭据，请只交给可信的本机 AI。AI 随后会读取 <code>/v1/guide</code> 和 <code>/v1/openapi.json</code>，再访问页面与提交提案。</Text>
                </>}
              {automationMessage && <div className="sync-settings-result" role="status">{automationMessage}</div>}
            </SettingsSection>
            <SettingsSection title="待审阅修改" description="逐笔记查看标题、正文和层级变化。应用前会再次检查页面版本，避免覆盖你刚刚做的编辑。">
              <div className="automation-proposals">
                {automationProposals.length === 0 && <div className="diagnostic-empty">还没有外部 AI 修改提案。</div>}
                {automationProposals.map((proposal) => <details key={proposal.id} className={`automation-proposal ${proposal.status}`} open={proposal.status === 'pending'}>
                  <summary><span><strong>{proposal.title}</strong><small>{proposal.source} · {proposal.changes.length} 项 · {new Date(proposal.createdAt).toLocaleString()}</small></span><Badge appearance="tint" color={proposal.status === 'pending' ? 'warning' : proposal.status === 'applied' ? 'success' : proposal.status === 'stale' ? 'danger' : 'informative'}>{automationStatusLabel(proposal.status)}</Badge></summary>
                  {proposal.explanation && <p>{proposal.explanation}</p>}
                  <AutomationWorkspaceReview proposal={proposal} notebooks={automationNotebooks} pages={automationPages} />
                  <div className="automation-change-list">
                    {proposal.changes.map((change) => <article key={change.id} className="automation-change">
                      <header><strong>{change.type === 'create-page' ? '新增' : change.type === 'delete-page' ? '移到回收站' : '修改'} · {change.after.title}</strong>{change.before?.title !== change.after.title && <span>{change.before?.title ?? '新页面'} → {change.after.title}</span>}</header>
                      {(change.before?.sectionId !== change.after.sectionId || change.before?.parentPageId !== change.after.parentPageId) && <div className="automation-structure-diff">位置：{change.before?.sectionId ?? '无'} / {change.before?.parentPageId ?? '顶层'} → {change.after.sectionId ?? '无'} / {change.after.parentPageId ?? '顶层'}</div>}
                      <div className="automation-diff" aria-label={`${change.after.title} 正文差异`}>
                        {diffLines(change.before?.markdown ?? '', change.type === 'delete-page' ? '' : change.after.markdown).map((part, index) => <pre key={index} className={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'}>{part.value.split('\n').map((line, lineIndex, lines) => lineIndex < lines.length - 1 ? `${part.added ? '+ ' : part.removed ? '- ' : '  '}${line}\n` : line).join('')}</pre>)}
                      </div>
                    </article>)}
                  </div>
                  {proposal.status === 'pending' && <div className="settings-action-grid">
                    <Button appearance="primary" disabled={automationBusy} onClick={() => void reviewAutomationProposal(proposal, 'apply')}>应用全部修改</Button>
                    <Button disabled={automationBusy} onClick={() => void reviewAutomationProposal(proposal, 'reject')}>拒绝提案</Button>
                  </div>}
                </details>)}
              </div>
            </SettingsSection>
            <SettingsSection title="安全模型" description="外部 AI 只能提交提案，最终写入权仍在 Notebook。">
              <ul className="settings-note">
                <li>仅监听本机回环地址；所有请求都需要随机 Token。</li>
                <li>隐私笔记不会被列出、搜索或读取。</li>
                <li>修改使用 updatedAt 乐观锁，过期提案不能应用。</li>
                <li>应用前为现有页面创建历史版本，应用后走现有同步和冲突检测。</li>
                <li>Token 和笔记正文不会写入诊断日志。</li>
              </ul>
            </SettingsSection>
          </>}
        </div>
      </div>
    </section>
    {webdavQrOpen && <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWebdavQrOpen(false) }}>
      <section ref={qrDialogRef} className="settings-dialog webdav-qr-dialog" role="dialog" aria-modal="true" aria-label="坚果云配置二维码">
        <div><h2>坚果云配置二维码</h2><Button ref={qrCloseButtonRef} appearance="subtle" onClick={() => setWebdavQrOpen(false)}>关闭</Button></div>
        {webdavQrDataUrl
          ? <img src={webdavQrDataUrl} alt="坚果云 WebDAV 配置二维码" style={{ width: 300, height: 300 }} />
          : <div className="sync-settings-result error">{webdavQrError ?? '正在生成…'}</div>}
        <p className="settings-note">使用 Android 端「设置与同步」中的扫描按钮扫码，即可自动填入服务器地址、用户名、应用密码与远端目录并开始同步。</p>
        <p className="settings-note error">⚠ 二维码包含 WebDAV 应用密码，扫描后请在坚果云安全选项重新生成应用密码，并清除本端已保存的应用密码；不要截图或转发二维码。</p>
      </section>
    </div>}
  </div>
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="settings-section"><div className="settings-section-heading"><h3>{title}</h3><p>{description}</p></div>{children}</section>
}

function SettingsRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong><span>{description}</span></div><div>{children}</div></div>
}

function formatBytes(value?: number) {
  if (!value || value < 1) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function describeSshConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/无法读取 SSH 私钥文件/.test(message)) return message
  if (/ENOENT|EACCES|EISDIR|ENOTDIR/i.test(message)) return '无法读取 SSH 私钥文件，请检查私钥文件路径和权限。'
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return '找不到 SSH 服务器，请检查服务器地址或 DNS。'
  if (/ECONNREFUSED/i.test(message)) return 'SSH 服务器拒绝连接，请检查端口以及 SSH 服务是否已启动。'
  if (/ETIMEDOUT|Timed out|timeout/i.test(message)) return '连接 SSH 服务器超时，请检查网络、防火墙和端口。'
  if (/authentication|auth methods|permission denied/i.test(message)) return 'SSH 身份验证失败，请检查用户名、私钥文件路径与口令（或密码）。'
  if (/私钥|key.*parse|unable to parse|bad passphrase|encrypted key/i.test(message)) return '无法解析 SSH 私钥或私钥口令不正确，请检查私钥文件内容和口令。'
  return message || '服务器连接失败'
}

function diagnosticActionLabel(category: string, action: string) {
  const labels: Record<string, string> = {
    'app.started': '应用启动',
    'app.stopped': '应用退出',
    'app.renderer-ready': '界面就绪',
    'workspace.loaded': '工作区加载完成',
    'renderer.process-gone': '界面进程退出',
    'renderer.uncaught-error': '界面运行错误',
    'renderer.unhandled-rejection': '异步操作错误',
    'sync.run': '数据同步',
    'sync.server-check': '服务器连接检测',
    'settings.automatic-sync': '自动同步设置',
    'data.import': '导入数据',
    'data.export': '导出备份',
    'data.encrypted-export': '导出加密备份',
    'page.create': '新建页面',
    'page.autosave': '页面自动保存',
    'page.trash': '页面移到回收站',
    'page.restore': '恢复页面',
    'page.purge': '永久删除页面',
    'asset.save': '保存附件',
    'notebook.delete': '删除笔记本',
    'section.delete': '删除分区',
  }
  return labels[`${category}.${action}`] ?? `${category} · ${action}`
}

function diagnosticStatusLabel(status: DiagnosticEntry['status']) {
  return status === 'started' ? '开始'
    : status === 'success' ? '完成'
      : status === 'failed' ? '失败'
        : status === 'cancelled' ? '取消'
          : '信息'
}

function automationStatusLabel(status: AutomationProposal['status']) {
  return status === 'pending' ? '等待审阅'
    : status === 'applied' ? '已应用'
      : status === 'rejected' ? '已拒绝'
        : '已过期'
}
