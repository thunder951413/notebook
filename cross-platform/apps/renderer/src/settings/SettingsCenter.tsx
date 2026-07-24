import { useEffect, useState } from 'react'
import { Badge, Button, Input, Switch, Tab, TabList, Text } from '@fluentui/react-components'
import QRCode from 'qrcode'
import { loadSyncSettings, saveSyncSettings, type SyncSettings } from '../sync/syncSettings'
import { clearLegacySshPassword, getLegacySshPassword, hasLegacySshPassword, loadLegacySshSettings, saveLegacySshSettings, type LegacySshSettings } from '../sync/legacySshSettings'
import type { LegacySyncMode } from '../sync/legacySshSync'
import { serializeNotebookSyncQrPayload } from '../sync/sshQrConfig'

type SettingsPage = 'general' | 'data' | 'services'
type SyncState = 'offline' | 'syncing' | 'synced' | 'conflict' | 'error'

interface SettingsCenterProps {
  initialPage?: SettingsPage
  theme: 'light' | 'dark'
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
  onClose: () => void
  onToggleTheme: () => void
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
}

const syncLabels: Record<SyncState, string> = {
  offline: '仅保存在本机',
  syncing: '正在同步',
  synced: '同步完成',
  conflict: '同步冲突',
  error: '同步失败',
}

export function SettingsCenter({ initialPage = 'general', theme, syncState, syncError, currentPageTitle, transferMessage, dataRoot, desktop, aiService, collaborationService, privacyAvailable, privacyConfigured, privacyUnlocked, onClose, onToggleTheme, onSyncNow, onImport, onExportPage, onPrint, onExportWorkspace, onExportEncrypted, onResetHistory, onChooseDataRoot, onPrivacyAction, onPublishSshArchive }: SettingsCenterProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() => loadSyncSettings())
  const [sshSettings, setSshSettings] = useState<LegacySshSettings>(() => loadLegacySshSettings())
  const [sshPassword, setSshPassword] = useState('')
  const [storedSshPassword, setStoredSshPassword] = useState(false)
  const [savingSync, setSavingSync] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string>()
  const [sshQrDataUrl, setSshQrDataUrl] = useState<string>()

  useEffect(() => setPage(initialPage), [initialPage])
  useEffect(() => { void hasLegacySshPassword().then(setStoredSshPassword) }, [])
  useEffect(() => setSshQrDataUrl(undefined), [sshPassword, sshSettings])

  const saveAndSync = async (mode: LegacySyncMode = 'bidirectional') => {
    if (savingSync || syncState === 'syncing') return
    setSavingSync(true)
    setSyncMessage(undefined)
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
          : '设置已保存，但本次同步未完成，请查看上方同步状态。')
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '无法保存同步设置')
    } finally { setSavingSync(false) }
  }

  const removeSshPassword = async () => {
    await clearLegacySshPassword()
    setSshPassword('')
    setStoredSshPassword(false)
    setSyncMessage('SSH 密码已从当前设备删除。')
  }

  const resetSshFingerprint = () => {
    setSshSettings((current) => ({ ...current, fingerprint: '' }))
    setSyncMessage('已清除已填写的主机指纹。下次连接会显示并记录服务器当前指纹，请先与服务器管理员核对。')
  }

  const toggleSshQrCode = async () => {
    if (sshQrDataUrl) {
      setSshQrDataUrl(undefined)
      return
    }
    setSyncMessage(undefined)
    try {
      const password = sshPassword || await getLegacySshPassword() || ''
      const payload = serializeNotebookSyncQrPayload(sshSettings, password)
      setSshQrDataUrl(await QRCode.toDataURL(payload, { width: 320, margin: 2, errorCorrectionLevel: 'M' }))
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '无法生成 Android 配置二维码')
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
        </TabList>
        <div className="settings-center-content">
          {transferMessage && <div className="settings-message" role="status">{transferMessage}</div>}
          {page === 'general' && <>
            <SettingsSection title="外观" description="主题设置按当前设备保存。">
              <SettingsRow title="颜色主题" description={`当前使用${theme === 'dark' ? '深色' : '浅色'}模式`}><Button onClick={onToggleTheme}>切换为{theme === 'dark' ? '浅色' : '深色'}模式</Button></SettingsRow>
            </SettingsSection>
            <SettingsSection title="工作状态" description="Notebook 会优先保存到本机，再按服务配置进行同步。">
              <SettingsRow title="同步状态" description={syncLabels[syncState]}><Badge appearance="tint" color={syncState === 'error' || syncState === 'conflict' ? 'danger' : syncState === 'offline' ? 'informative' : 'success'}>{syncLabels[syncState]}</Badge></SettingsRow>
              <SettingsRow title="快速记录" description="在桌面版任何界面呼出新页面"><kbd>Ctrl/Cmd + Shift + N</kbd></SettingsRow>
            </SettingsSection>
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
          </>}
          {page === 'services' && <>
            <SettingsSection title="SSH/SFTP 同步" description="网页、Electron 桌面版和 Android 共用同一套 SSH JSON 仓库。">
              <div className="sync-settings-form">
                <Switch aria-label="启用自动同步" checked={syncSettings.enabled} onChange={(_, data) => setSyncSettings((current) => ({ ...current, enabled: data.checked }))} label="启用自动同步（关闭后仍可手动同步）" />
                {!desktop && <div className="sync-settings-result">浏览器通过 127.0.0.1:8787 的本机 Python SSH 助手连接；使用 ./ctl start 会同时启动它。密码仅保存在当前标签会话。</div>}
                  <div className="sync-ssh-grid">
                    <label><span>SSH 服务器</span><Input value={sshSettings.host} onChange={(_, data) => setSshSettings((current) => ({ ...current, host: data.value }))} placeholder="服务器 IP" aria-label="SSH 服务器" /></label>
                    <label><span>端口</span><Input type="number" value={String(sshSettings.port)} onChange={(_, data) => setSshSettings((current) => ({ ...current, port: Number(data.value) || 22 }))} aria-label="SSH 端口" /></label>
                  </div>
                  <label><span>用户名</span><Input value={sshSettings.username} onChange={(_, data) => setSshSettings((current) => ({ ...current, username: data.value }))} aria-label="SSH 用户名" /></label>
                  <label><span>密码</span><Input type="password" value={sshPassword} onChange={(_, data) => setSshPassword(data.value)} placeholder={storedSshPassword ? (desktop ? '已由操作系统加密保存；留空保持不变' : '已保存在当前标签会话；留空保持不变') : '请输入 SSH 密码'} aria-label="SSH 密码" /></label>
                  <label><span>远端同步目录</span><Input value={sshSettings.remotePath} onChange={(_, data) => setSshSettings((current) => ({ ...current, remotePath: data.value }))} placeholder="~/notebook_backup" aria-label="远端同步目录" /></label>
                  <label><span>服务器主机指纹</span><Input readOnly value={sshSettings.fingerprint} placeholder="首次成功连接后自动记录 SHA256 指纹" aria-label="SSH 主机指纹" /></label>
                {sshSettings.fingerprint && <div className="settings-action-grid"><Button onClick={resetSshFingerprint}>重新核对主机指纹</Button></div>}
                <div className="ssh-qr-actions">
                  <Button disabled={savingSync || syncState === 'syncing'} onClick={() => void toggleSshQrCode()}>{sshQrDataUrl ? '隐藏 Android 配置二维码' : '显示 Android 配置二维码'}</Button>
                  {sshQrDataUrl && <div className="ssh-qr-card" role="region" aria-label="Android SSH 配置二维码">
                    <img src={sshQrDataUrl} alt="供 Android Notebook 扫描的 SSH 配置二维码" />
                    <div><strong>在 Android“设置与同步”中扫描</strong><p>二维码包含服务器、用户名、密码、目录和主机指纹。仅在可信环境展示，扫描完成后立即隐藏。</p></div>
                  </div>}
                </div>
                <div className="sync-mode-actions" aria-label="SSH 同步方式">
                  <Button disabled={savingSync || syncState === 'syncing'} onClick={() => void saveAndSync('push')}>推送本机变化</Button>
                  <Button disabled={savingSync || syncState === 'syncing'} onClick={() => void saveAndSync('pull')}>拉取并合并</Button>
                  <Button appearance="primary" disabled={savingSync || syncState === 'syncing'} onClick={() => void saveAndSync('bidirectional')}>{savingSync || syncState === 'syncing' ? '正在同步…' : '双向同步'}</Button>
                </div>
                <p className="settings-note">“推送”会先读取并校验远端索引，发现其他设备的新内容时先安全合并，避免覆盖 Android 的修改；“拉取”只更新本机，不发布本机待同步内容；日常使用建议选择“双向同步”。</p>
                {storedSshPassword && <div className="settings-action-grid"><Button disabled={savingSync || syncState === 'syncing'} onClick={() => void removeSshPassword()}>清除 SSH 密码</Button></div>}
                {onPublishSshArchive && <label className="settings-file-action"><span>首次迁移遇到超大历史库时，可直接发布由迁移工具生成的 SSH 仓库 ZIP。</span><input type="file" accept=".zip,application/zip" aria-label="发布迁移仓库 ZIP" disabled={savingSync || syncState === 'syncing'} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file || savingSync || syncState === 'syncing') return; setSavingSync(true); setSyncMessage('正在发布迁移仓库…'); void onPublishSshArchive(file).then(() => setSyncMessage('迁移仓库已发布到 SSH 服务器。')).catch((error) => setSyncMessage(error instanceof Error ? error.message : '迁移仓库发布失败')).finally(() => setSavingSync(false)) }} /></label>}
                {(syncMessage || syncError) && <div className={`sync-settings-result ${syncError ? 'error' : ''}`} role="status">{syncError ?? syncMessage}</div>}
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
