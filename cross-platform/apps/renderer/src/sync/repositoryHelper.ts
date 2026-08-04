import { getLegacySshPassword, loadLegacySshSettings, saveLegacySshSettings } from './legacySshSettings'

export type RepositoryHelperOperation = 'verify' | 'gc' | 'export-tar' | 'import-tar'

export interface RepositoryHelperOutcome {
  ok: boolean
  message: string
  /** Binary payload for export-tar; undefined for the other operations. */
  data?: Uint8Array
}

/**
 * Runs a repository maintenance helper over the SSH exec channel. Servers
 * without python3 fail with a non-zero exit and the error surfaces here, so
 * callers can fall back to plain SFTP behaviour (or tell the user to install
 * python3).
 */
export async function runRepositoryHelper(operation: RepositoryHelperOperation, input?: Uint8Array): Promise<RepositoryHelperOutcome> {
  const settings = loadLegacySshSettings()
  if (!settings.host || !settings.username || !settings.remotePath) throw new Error('请先完整填写并保存 SSH 设置')
  const password = await getLegacySshPassword()
  if (!password) throw new Error('请在设置中填写并保存 SSH 密码')
  if (!window.notebookDesktop) throw new Error('SSH 仓库维护仅在 Notebook Next Electron 桌面版中提供')
  const connection = { ...settings, password }
  let trusted = settings
  if (!settings.fingerprint) {
    const probe = await window.notebookDesktop.legacySftp.test(connection)
    trusted = await saveLegacySshSettings({ ...settings, fingerprint: probe.fingerprint })
  }
  const result = await window.notebookDesktop.legacySftp.helper({ ...trusted, password }, operation, input)
  if (!result.ok) throw new Error(result.message || '服务器 helper 执行失败')
  return { ok: true, message: result.message ?? '', data: result.data }
}
