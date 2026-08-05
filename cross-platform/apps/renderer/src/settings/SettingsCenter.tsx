import { useEffect, useState } from 'react'
import { Badge, Button, Input, Switch, Tab, TabList, Text } from '@fluentui/react-components'
import QRCode from 'qrcode'
import { loadSyncSettings, saveSyncSettings, type SyncSettings } from '../sync/syncSettings'
import { clearLegacySshPassword, getLegacySshPassword, hasLegacySshPassword, loadLegacySshSettings, saveLegacySshSettings, type LegacySshSettings } from '../sync/legacySshSettings'
import type { LegacySyncMode } from '../sync/legacySshSync'
import { runRepositoryHelper, type RepositoryHelperOperation } from '../sync/repositoryHelper'
import { serializeNotebookSyncQrPayload } from '../sync/sshQrConfig'
import { ACCENT_PRESETS, type AccentColor } from '../appearance/accent'
import { recordDiagnosticEvent, type DiagnosticEntry } from '../diagnostics/diagnostics'
import type { AutomationProposal } from '@notebook/domain'
import { diffLines } from 'diff'
import { buildAutomationHandoffText } from '../automation/handoff'
import { AutomationWorkspaceReview } from '../automation/AutomationWorkspaceReview'
import type { NotebookSummary, PageSummary } from '../model'
import { AIProviderSettingsPanel } from './AIProviderSettings'

type SettingsPage = 'general' | 'data' | 'services' | 'automation'
type SyncState = 'offline' | 'syncing' | 'synced' | 'conflict' | 'error'

interface SettingsCenterProps {
  initialPage?: SettingsPage
  theme: 'light' | 'dark'
  accentColor: AccentColor
  syncState: SyncState
  syncError?: string
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
  onToggleTheme: () => void
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
  onPublishSshArchive?: (file: File) => Promise<void>
  onApplyAutomationProposal: (proposalId: string) => Promise<void>
  onRejectAutomationProposal: (proposalId: string) => Promise<void>
}

const syncLabels: Record<SyncState, string> = {
  offline: '仅保存在本机',
  syncing: '正在同步',
  synced: '同步完成',
  conflict: '同步冲突',
  error: '同步失败',
}

export function SettingsCenter({ initialPage = 'general', theme, accentColor, syncState, syncError, currentPageTitle, transferMessage, dataRoot, desktop, aiService, collaborationService, privacyAvailable, privacyConfigured, privacyUnlocked, automationProposals, automationNotebooks, automationPages, onClose, onToggleTheme, onAccentColorChange, onSyncNow, onImport, onExportPage, onPrint, onExportWorkspace, onExportEncrypted, onResetHistory, onChooseDataRoot, onPrivacyAction, onPublishSshArchive, onApplyAutomationProposal, onRejectAutomationProposal }: SettingsCenterProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() => loadSyncSettings())
  const [sshSettings, setSshSettings] = useState<LegacySshSettings>(() => loadLegacySshSettings())
  const [sshPassword, setSshPassword] = useState('')
  const [storedSshPassword, setStoredSshPassword] = useState(false)
  const [savingSync, setSavingSync] = useState(false)
  const [savingAutoSync, setSavingAutoSync] = useState(false)
  const [checkingServer, setCheckingServer] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string>()
  const [syncMessageIsError, setSyncMessageIsError] = useState(false)
  const [sshQrDataUrl, setSshQrDataUrl] = useState<string>()
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
  const [maintenanceBusy, setMaintenanceBusy] = useState(false)
  const [maintenanceMessage, setMaintenanceMessage] = useState<string>()
  const [maintenanceMessageIsError, setMaintenanceMessageIsError] = useState(false)

  useEffect(() => setPage(initialPage), [initialPage])
  useEffect(() => { void hasLegacySshPassword().then(setStoredSshPassword) }, [])
  useEffect(() => setSshQrDataUrl(undefined), [sshPassword, sshSettings])
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
    if (!window.notebookDesktop || automationBusy || !window.confirm('旧 Token 会立即失效。确定重新生成吗？')) return
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
    if (decision === 'apply' && !window.confirm(`将应用“${proposal.title}”中的 ${proposal.changes.length} 项修改。每篇现有笔记都会先保留历史版本，确定继续吗？`)) return
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

  const saveAndSync = async (mode: LegacySyncMode = 'bidirectional') => {
    if (savingSync || syncState === 'syncing') return
    setSavingSync(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const savedSsh = await saveLegacySshSettings(sshSettings, sshPassword || undefined)
      setSshSettings(savedSsh)
      if (sshPassword) { setStoredSshPassword(true); setSshPassword('') }
      const saved = await saveSyncSettings(syncSettings)
      setSyncSettings(saved)
      const succeeded = await onSyncNow(mode)
      setSyncMessage(succeeded
        ? mode === 'pull' ? '设置已保存，远端内容已拉取并安全合并到本机。' : mode === 'push' ? '设置已保存，本机变化已在校验远端后安全推送。' : '设置已保存，双向同步已完成。'
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

  const testServer = async () => {
    if (savingSync || checkingServer || syncState === 'syncing') return
    setCheckingServer(true)
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    const startedAt = performance.now()
    recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'server-check', status: 'started' })
    try {
      const saved = await saveLegacySshSettings(sshSettings, sshPassword || undefined)
      const password = sshPassword || await getLegacySshPassword()
      if (!password) throw new Error('请填写 SSH 密码后再检测连接')
      const sftp = window.notebookDesktop?.legacySftp
      if (!sftp) throw new Error('服务器连接检测仅在 Electron 桌面版中可用')
      const result = await sftp.test({ ...saved, password })
      const trusted = saved.fingerprint
        ? saved
        : await saveLegacySshSettings({ ...saved, fingerprint: result.fingerprint })
      setSshSettings(trusted)
      if (sshPassword) {
        setStoredSshPassword(true)
        setSshPassword('')
      }
      setSyncMessage(result.remotePathExists
        ? `服务器连接正常（${result.latencyMs} ms），远端目录可访问；主机指纹 ${result.fingerprint}。`
        : `服务器连接正常（${result.latencyMs} ms）；远端目录尚不存在，首次同步时会自动创建。主机指纹 ${result.fingerprint}。`)
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

  const removeSshPassword = async () => {
    await clearLegacySshPassword()
    setSshPassword('')
    setStoredSshPassword(false)
    setSyncMessageIsError(false)
    setSyncMessage('SSH 密码已从当前设备删除。')
  }

  const resetSshFingerprint = () => {
    setSshSettings((current) => ({ ...current, fingerprint: '' }))
    setSyncMessageIsError(false)
    setSyncMessage('已清除已填写的主机指纹。下次连接会显示并记录服务器当前指纹，请先与服务器管理员核对。')
  }

  const runMaintenance = async (operation: RepositoryHelperOperation, input?: Uint8Array, confirmText?: string) => {
    if (savingSync || maintenanceBusy || syncState === 'syncing') return
    if (confirmText && !window.confirm(confirmText)) return
    setMaintenanceBusy(true)
    setMaintenanceMessage(undefined)
    setMaintenanceMessageIsError(false)
    try {
      const outcome = await runRepositoryHelper(operation, input)
      if (operation === 'export-tar' && outcome.data) {
        const url = URL.createObjectURL(new Blob([outcome.data as BlobPart], { type: 'application/x-tar' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `notebook-repository-${new Date().toISOString().slice(0, 10)}.tar`
        anchor.click()
        URL.revokeObjectURL(url)
        setMaintenanceMessage('仓库 tar 备份已导出并开始下载。')
      } else {
        setMaintenanceMessage(outcome.message)
      }
    } catch (error) {
      setMaintenanceMessage(describeSshConnectionError(error))
      setMaintenanceMessageIsError(true)
    } finally {
      setMaintenanceBusy(false)
    }
  }

  const toggleSshQrCode = async () => {
    if (sshQrDataUrl) {
      setSshQrDataUrl(undefined)
      return
    }
    setSyncMessage(undefined)
    setSyncMessageIsError(false)
    try {
      const password = sshPassword || await getLegacySshPassword() || ''
      const payload = serializeNotebookSyncQrPayload(sshSettings, password)
      setSshQrDataUrl(await QRCode.toDataURL(payload, { width: 320, margin: 2, errorCorrectionLevel: 'M' }))
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '无法生成 Android 配置二维码')
      setSyncMessageIsError(true)
    }
  }

  const resetHistory = async () => {
    if (savingSync || !window.confirm('这会永久删除所有旧历史版本，并将每篇笔记的当前内容设为唯一初始版本。随后需要同步覆盖远端。确定继续吗？')) return
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
    <section className="settings-dialog settings-center" role="dialog" aria-label="设置">
      <header className="settings-center-header"><div><h2>Notebook 设置</h2><p>应用的外观、数据、服务和安全选项都集中在这里。</p></div><Button appearance="subtle" aria-label="关闭设置" onClick={onClose}>关闭</Button></header>
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
              <SettingsRow title="颜色主题" description={`当前使用${theme === 'dark' ? '深色' : '浅色'}模式`}><Button onClick={onToggleTheme}>切换为{theme === 'dark' ? '浅色' : '深色'}模式</Button></SettingsRow>
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
              <Text size={200}>此操作不会删除当前正文、图片或附件；完成后会立即通过 SSH 覆盖远端历史。</Text>
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
                <Button appearance="subtle" onClick={() => void window.notebookDesktop?.diagnostics.reveal()}>在访达中显示</Button>
              </div>
              {diagnosticMessage && <div className="sync-settings-result" role="status">{diagnosticMessage}</div>}
            </SettingsSection>}
          </>}
          {page === 'services' && <>
            <SettingsSection title="SSH/SFTP 同步" description="网页、Electron 桌面版和 Android 共用同一套 SSH JSON 仓库。">
              <div className="sync-settings-form">
                <Switch aria-label="启用自动同步" checked={syncSettings.enabled} disabled={savingAutoSync} onChange={(_, data) => void toggleAutoSync(data.checked)} label={savingAutoSync ? '正在保存自动同步设置…' : '启用自动同步（关闭后仍可手动同步）'} />
                {!desktop && <div className="sync-settings-result">浏览器通过 127.0.0.1:8787 的本机 Python SSH 助手连接；使用 ./ctl start 会同时启动它。密码仅保存在当前标签会话。</div>}
                  <div className="sync-ssh-grid">
                    <label><span>SSH 服务器</span><Input value={sshSettings.host} onChange={(_, data) => setSshSettings((current) => ({ ...current, host: data.value }))} placeholder="服务器 IP" aria-label="SSH 服务器" /></label>
                    <label><span>端口</span><Input type="number" value={String(sshSettings.port)} onChange={(_, data) => setSshSettings((current) => ({ ...current, port: Number(data.value) || 22 }))} aria-label="SSH 端口" /></label>
                  </div>
                  <label><span>用户名</span><Input value={sshSettings.username} onChange={(_, data) => setSshSettings((current) => ({ ...current, username: data.value }))} aria-label="SSH 用户名" /></label>
                  <label><span>密码</span><Input type="password" value={sshPassword} onChange={(_, data) => setSshPassword(data.value)} placeholder={storedSshPassword ? (desktop ? '已由操作系统加密保存；留空保持不变' : '已保存在当前标签会话；留空保持不变') : '请输入 SSH 密码'} aria-label="SSH 密码" /></label>
                  <label><span>远端同步目录</span><Input value={sshSettings.remotePath} onChange={(_, data) => setSshSettings((current) => ({ ...current, remotePath: data.value }))} placeholder="~/notebook_backup" aria-label="远端同步目录" /></label>
                  <label><span>服务器主机指纹</span><Input readOnly value={sshSettings.fingerprint} placeholder="首次成功连接后自动记录 SHA256 指纹" aria-label="SSH 主机指纹" /></label>
                <div className="ssh-qr-actions">
                  {sshQrDataUrl && <div className="ssh-qr-card" role="region" aria-label="Android SSH 配置二维码">
                    <img src={sshQrDataUrl} alt="供 Android Notebook 扫描的 SSH 配置二维码" />
                    <div><strong>在 Android“设置与同步”中扫描</strong><p>二维码包含服务器、用户名、密码、目录和主机指纹。仅在可信环境展示，扫描完成后立即隐藏。</p></div>
                  </div>}
                </div>
                <div className="sync-action-panel">
                  <div className="sync-action-heading"><strong>连接与同步</strong><span>先检测连接；日常使用双向同步。</span></div>
                  <div className="sync-primary-actions">
                    <Button disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void testServer()}>{checkingServer ? '正在检测…' : '检测服务器连接'}</Button>
                    <Button appearance="primary" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void saveAndSync('bidirectional')}>{savingSync || syncState === 'syncing' ? '正在同步…' : '立即双向同步'}</Button>
                  </div>
                  <div className="sync-mode-actions" aria-label="SSH 单向同步方式">
                    <Button appearance="subtle" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void saveAndSync('pull')}>仅拉取并合并</Button>
                    <Button appearance="subtle" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void saveAndSync('push')}>仅推送本机变化</Button>
                  </div>
                </div>
                <p className="settings-note">“推送”会先读取并校验远端索引，发现其他设备的新内容时先安全合并，避免覆盖 Android 的修改；“拉取”只更新本机，不发布本机待同步内容；日常使用建议选择“双向同步”。</p>
                <div className="sync-utility-actions">
                  <Button appearance="subtle" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void toggleSshQrCode()}>{sshQrDataUrl ? '隐藏 Android 配置二维码' : 'Android 配置二维码'}</Button>
                  {storedSshPassword && <Button appearance="subtle" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={() => void removeSshPassword()}>清除已保存密码</Button>}
                  {sshSettings.fingerprint && <Button appearance="subtle" disabled={savingSync || checkingServer || syncState === 'syncing'} onClick={resetSshFingerprint}>重新核对主机指纹</Button>}
                </div>
                {desktop && <div className="sync-action-panel">
                  <div className="sync-action-heading"><strong>服务器仓库维护</strong><span>仅供桌面版手动维护，不参与日常同步或首次同步加速；服务器需具备 POSIX 环境和 python3。不可用时仍可使用普通 SFTP 同步。</span></div>
                  <div className="sync-primary-actions">
                    <Button appearance="subtle" disabled={savingSync || maintenanceBusy || syncState === 'syncing'} onClick={() => void runMaintenance('verify')}>{maintenanceBusy ? '正在执行…' : '校验仓库内容'}</Button>
                    <Button appearance="subtle" disabled={savingSync || maintenanceBusy || syncState === 'syncing'} onClick={() => void runMaintenance('gc', undefined, '这会将超过宽限期、且未被当前笔记、历史或附件清单引用的对象移入服务器私有隔离区，并生成恢复清单；隔离区超过更长保留期后，会在后续清理时永久清除。若存在无法检查完整历史引用的加密笔记，清理会安全拒绝。确定继续吗？')}>{maintenanceBusy ? '正在执行…' : '清理孤儿对象'}</Button>
                    <Button appearance="subtle" disabled={savingSync || maintenanceBusy || syncState === 'syncing'} onClick={() => void runMaintenance('export-tar')}>{maintenanceBusy ? '正在执行…' : '导出仓库 tar 备份'}</Button>
                  </div>
                  <label className="settings-file-action"><span>从 tar 备份恢复：先在暂存区校验路径、大小、哈希及跨文件引用，通过后才锁定仓库并最后发布索引；覆盖前文件会保存在服务器私有恢复目录，校验失败不会改动当前仓库。</span><input type="file" accept=".tar,application/x-tar" aria-label="导入仓库 tar 备份" disabled={savingSync || maintenanceBusy || syncState === 'syncing'} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file || savingSync || maintenanceBusy || syncState === 'syncing') return; void file.arrayBuffer().then((buffer) => void runMaintenance('import-tar', new Uint8Array(buffer), `将从 ${file.name} 恢复备份。系统会先在暂存区完成完整性校验；通过后才替换同名仓库文件、保留覆盖前副本并最后发布索引。确定继续吗？`)) }} /></label>
                  {maintenanceMessage && <div className={`sync-settings-result ${maintenanceMessageIsError ? 'error' : ''}`} role="status">{maintenanceMessage}</div>}
                </div>}
                {onPublishSshArchive && <label className="settings-file-action"><span>首次迁移遇到超大历史库时，可直接发布由迁移工具生成的 SSH 仓库 ZIP。</span><input type="file" accept=".zip,application/zip" aria-label="发布迁移仓库 ZIP" disabled={savingSync || syncState === 'syncing'} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file || savingSync || syncState === 'syncing') return; setSavingSync(true); setSyncMessage('正在发布迁移仓库…'); void onPublishSshArchive(file).then(() => setSyncMessage('迁移仓库已发布到 SSH 服务器。')).catch((error) => setSyncMessage(error instanceof Error ? error.message : '迁移仓库发布失败')).finally(() => setSavingSync(false)) }} /></label>}
                {(syncMessage || syncError) && <div className={`sync-settings-result ${(syncMessage ? syncMessageIsError : Boolean(syncError)) ? 'error' : ''}`} role="status">{syncMessage ?? syncError}</div>}
              <Text size={200}>Android 中填写相同的服务器、端口、用户名、密码和远端目录即可双向同步。首次连接后请核对各端显示的 SHA256 主机指纹；同一服务器可能按客户端能力提供不同算法的主机密钥。</Text>
              </div>
            </SettingsSection>
            <SettingsSection title="其他服务" description="AI 与实时协作可以独立部署；未配置时不影响本地笔记和数据同步。">
              <dl className="settings-service-list"><dt>AI 服务</dt><dd>{aiService ?? '本机 127.0.0.1:8787'}</dd><dt>协作服务</dt><dd>{collaborationService ?? '未配置 · Yjs 离线模式'}</dd></dl>
            </SettingsSection>
            <SettingsSection title="安全" description="敏感信息不会写入笔记内容。">
              <SettingsRow title="隐私笔记本" description={!privacyAvailable ? '尚未导入隐私笔记本' : privacyUnlocked ? '当前已解锁；关闭应用后会重新锁定' : privacyConfigured ? '当前已锁定' : '需要为此设备设置新的隐私密码'}><Button disabled={!privacyAvailable} onClick={onPrivacyAction}>{privacyUnlocked ? '立即锁定' : privacyConfigured ? '解锁' : '设置密码'}</Button></SettingsRow>
              <p className="settings-note">隐私锁会从普通列表、搜索、任务、提醒和 AI 上下文中隐藏内容。通过 SSH 同步时，隐私笔记的标题、正文、历史和笔记内元数据会使用由 SSH 密码派生的 AES-256-GCM 密钥加密；附件二进制仍依赖 SSH 账户和服务器磁盘保护。</p>
              <p className="settings-note">Electron 桌面版使用操作系统凭据保存 SSH 密码；普通浏览器只在当前标签会话保存密码，不写入 localStorage 或 IndexedDB。</p>
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
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return '找不到 SSH 服务器，请检查服务器地址或 DNS。'
  if (/ECONNREFUSED/i.test(message)) return 'SSH 服务器拒绝连接，请检查端口以及 SSH 服务是否已启动。'
  if (/ETIMEDOUT|Timed out|timeout/i.test(message)) return '连接 SSH 服务器超时，请检查网络、防火墙和端口。'
  if (/authentication|auth methods|permission denied/i.test(message)) return 'SSH 身份验证失败，请检查用户名和密码。'
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
