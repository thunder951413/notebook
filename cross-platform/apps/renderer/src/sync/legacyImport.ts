import { saveWebdavSettings } from './webdavSettings'

/**
 * Applies the one-time hand-over from the old Electron app, if one is
 * waiting: WebDAV address, account, repository and the secrets that the old
 * app kept in its encrypted store. Returns true when settings were imported.
 */
export async function applyLegacyImport(): Promise<boolean> {
  const take = window.notebookDesktop?.legacy?.take
  if (!take) return false
  const data = await take()
  if (!data?.webdav?.username || !data.webdav.baseUrl) return false
  await saveWebdavSettings(
    { baseUrl: data.webdav.baseUrl, username: data.webdav.username, remotePath: data.webdav.remotePath || 'notebook_backup' },
    data.appPassword,
    data.syncPassword ?? null,
  )
  if (data.githubToken) await window.notebookDesktop?.secrets.set('github-release-token', data.githubToken)
  return true
}
