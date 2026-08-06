const SETTINGS_KEY = 'notebook-webdav-settings-v1'
const BACKEND_KEY = 'notebook-sync-backend-v1'
const SEQS_KEY = 'notebook-webdav-seqs-v1'
const APP_PASSWORD_KEY = 'webdav-app-password'
const SYNC_PASSWORD_KEY = 'webdav-sync-password'
const BROWSER_APP_PASSWORD_KEY = 'notebook-webdav-app-password'
const BROWSER_SYNC_PASSWORD_KEY = 'notebook-webdav-sync-password'

export interface WebdavSettings {
  /** WebDAV base URL, e.g. https://dav.jianguoyun.com/dav/ */
  baseUrl: string
  username: string
  /** Repository path relative to the WebDAV root, e.g. notebook_backup. */
  remotePath: string
}

const emptyWebdavSettings: WebdavSettings = { baseUrl: 'https://dav.jianguoyun.com/dav/', username: '', remotePath: 'notebook_backup' }

export function loadWebdavSettings(): WebdavSettings {
  try {
    const saved = JSON.parse(window.localStorage?.getItem(SETTINGS_KEY) ?? '{}') as Partial<WebdavSettings>
    return {
      baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : emptyWebdavSettings.baseUrl,
      username: typeof saved.username === 'string' ? saved.username : '',
      remotePath: typeof saved.remotePath === 'string' ? saved.remotePath : emptyWebdavSettings.remotePath,
    }
  } catch { return emptyWebdavSettings }
}

export async function saveWebdavSettings(settings: WebdavSettings, appPassword?: string, syncPassword?: string | null) {
  if (!settings.baseUrl.trim() || !/^https?:\/\//.test(settings.baseUrl.trim())) throw new Error('请填写 WebDAV 服务器地址')
  if (!settings.username.trim()) throw new Error('请填写 WebDAV 用户名')
  if (!settings.remotePath.trim()) throw new Error('请填写远端同步目录')
  const normalized = { ...settings, baseUrl: settings.baseUrl.trim().replace(/\/+$/, ''), username: settings.username.trim(), remotePath: settings.remotePath.trim() }
  window.localStorage?.setItem(BACKEND_KEY, 'webdav')
  window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(normalized))
  if (appPassword?.trim()) {
    if (window.notebookDesktop) await window.notebookDesktop.secrets.set(APP_PASSWORD_KEY, appPassword)
    else window.sessionStorage?.setItem(BROWSER_APP_PASSWORD_KEY, appPassword)
  }
  if (syncPassword !== undefined && syncPassword !== null) {
    if (syncPassword) {
      if (window.notebookDesktop) await window.notebookDesktop.secrets.set(SYNC_PASSWORD_KEY, syncPassword)
      else window.sessionStorage?.setItem(BROWSER_SYNC_PASSWORD_KEY, syncPassword)
    } else await clearWebdavSyncPassword()
  }
  return normalized
}

export async function getWebdavAppPassword() { return window.notebookDesktop ? window.notebookDesktop.secrets.get(APP_PASSWORD_KEY) : window.sessionStorage?.getItem(BROWSER_APP_PASSWORD_KEY) ?? undefined }
export async function hasWebdavAppPassword() { return Boolean(await getWebdavAppPassword()) }
export async function clearWebdavAppPassword() { if (window.notebookDesktop) await window.notebookDesktop.secrets.delete(APP_PASSWORD_KEY); else window.sessionStorage?.removeItem(BROWSER_APP_PASSWORD_KEY) }

export async function getWebdavSyncPassword() { return window.notebookDesktop ? window.notebookDesktop.secrets.get(SYNC_PASSWORD_KEY) : window.sessionStorage?.getItem(BROWSER_SYNC_PASSWORD_KEY) ?? undefined }
export async function clearWebdavSyncPassword() { if (window.notebookDesktop) await window.notebookDesktop.secrets.delete(SYNC_PASSWORD_KEY); else window.sessionStorage?.removeItem(BROWSER_SYNC_PASSWORD_KEY) }

/** Repository identity used to scope per-device read cursors. */
export function webdavFingerprint(settings: WebdavSettings) {
  return `${settings.baseUrl.trim()}|${settings.username.trim()}|${settings.remotePath.trim()}`
}

export function loadWebdavKnownSeqs(settings: WebdavSettings): Record<string, number> {
  try {
    const key = `${SEQS_KEY}:${webdavFingerprint(settings)}`
    const parsed = JSON.parse(window.localStorage?.getItem(key) ?? '{}') as Record<string, number>
    return Object.fromEntries(Object.entries(parsed).filter(([, seq]) => Number.isInteger(seq) && seq > 0))
  } catch { return {} }
}

export function saveWebdavKnownSeqs(settings: WebdavSettings, knownSeqs: Record<string, number>) {
  window.localStorage?.setItem(`${SEQS_KEY}:${webdavFingerprint(settings)}`, JSON.stringify(knownSeqs))
}
