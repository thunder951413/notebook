const SETTINGS_KEY = 'notebook-legacy-ssh-settings-v1'
const BACKEND_KEY = 'notebook-sync-backend-v1'
const DEVICE_KEY = 'notebook-legacy-device-id-v1'
const PASSWORD_KEY = 'legacy-ssh-password'
const BROWSER_PASSWORD_KEY = 'notebook-legacy-ssh-password'

export type SyncBackend = 'ssh' | 'api'

export interface LegacySshSettings {
  host: string
  port: number
  username: string
  remotePath: string
  fingerprint: string
}

const emptyLegacySshSettings: LegacySshSettings = { host: '', port: 22, username: '', remotePath: '~/notebook_backup', fingerprint: '' }

export function loadSyncBackend(): SyncBackend {
  const saved = window.localStorage?.getItem(BACKEND_KEY)
  if (saved === 'ssh' || saved === 'api') return saved
  return 'ssh'
}

export function saveSyncBackend(value: SyncBackend) {
  window.localStorage?.setItem(BACKEND_KEY, value)
}

export function loadLegacySshSettings(): LegacySshSettings {
  try {
    const saved = JSON.parse(window.localStorage?.getItem(SETTINGS_KEY) ?? '{}') as Partial<LegacySshSettings>
    return {
      host: typeof saved.host === 'string' ? saved.host : '',
      port: Number.isInteger(saved.port) ? Number(saved.port) : 22,
      username: typeof saved.username === 'string' ? saved.username : '',
      remotePath: typeof saved.remotePath === 'string' ? saved.remotePath : '~/notebook_backup',
      fingerprint: typeof saved.fingerprint === 'string' ? saved.fingerprint : '',
    }
  } catch { return emptyLegacySshSettings }
}

export async function saveLegacySshSettings(settings: LegacySshSettings, password?: string) {
  if (!settings.host.trim()) throw new Error('请填写 SSH 服务器地址')
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error('SSH 端口必须在 1–65535 之间')
  if (!settings.username.trim()) throw new Error('请填写 SSH 用户名')
  if (!settings.remotePath.trim()) throw new Error('请填写远端同步目录')
  const normalized = { ...settings, host: settings.host.trim(), username: settings.username.trim(), remotePath: settings.remotePath.trim(), fingerprint: settings.fingerprint.trim() }
  // Upgrading from an earlier HTTP preview must always return the app to the
  // shared Android/Electron SSH repository.
  window.localStorage?.setItem(BACKEND_KEY, 'ssh')
  window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(normalized))
  if (password?.trim()) {
    if (window.notebookDesktop) await window.notebookDesktop.secrets.set(PASSWORD_KEY, password)
    else window.sessionStorage?.setItem(BROWSER_PASSWORD_KEY, password)
  }
  return normalized
}

export async function getLegacySshPassword() { return window.notebookDesktop ? window.notebookDesktop.secrets.get(PASSWORD_KEY) : window.sessionStorage?.getItem(BROWSER_PASSWORD_KEY) ?? undefined }
export async function hasLegacySshPassword() { return Boolean(await getLegacySshPassword()) }
export async function clearLegacySshPassword() { if (window.notebookDesktop) await window.notebookDesktop.secrets.delete(PASSWORD_KEY); else window.sessionStorage?.removeItem(BROWSER_PASSWORD_KEY) }

export function legacyDeviceId() {
  const existing = window.localStorage?.getItem(DEVICE_KEY)
  if (existing) return existing
  const value = crypto.randomUUID()
  window.localStorage?.setItem(DEVICE_KEY, value)
  return value
}
