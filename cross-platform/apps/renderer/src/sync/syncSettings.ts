export const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
import { loadSyncBackend } from './legacySshSettings'
const SETTINGS_KEY = 'notebook-sync-settings-v1'
const BROWSER_TOKEN_KEY = 'notebook-sync-token'
export { loadSyncBackend, saveSyncBackend, type SyncBackend } from './legacySshSettings'

export interface SyncSettings {
  enabled: boolean
  baseUrl: string
  workspaceId: string
}

export function loadSyncSettings(): SyncSettings {
  const environmentUrl = (import.meta.env.VITE_NOTEBOOK_API_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? ''
  try {
    const saved = JSON.parse(window.localStorage?.getItem(SETTINGS_KEY) ?? '{}') as Partial<SyncSettings>
    const baseUrl = typeof saved.baseUrl === 'string' ? saved.baseUrl : environmentUrl
    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : Boolean(baseUrl),
      baseUrl,
      workspaceId: DEFAULT_WORKSPACE_ID,
    }
  } catch {
    return { enabled: Boolean(environmentUrl), baseUrl: environmentUrl, workspaceId: DEFAULT_WORKSPACE_ID }
  }
}

export function normalizeSyncUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  const url = new URL(normalized)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('同步服务地址必须使用 HTTP 或 HTTPS')
  if (!url.hostname) throw new Error('同步服务地址缺少主机名')
  return normalized
}

export async function saveSyncSettings(settings: Pick<SyncSettings, 'enabled' | 'baseUrl'>, token?: string): Promise<SyncSettings> {
  const value: SyncSettings = { enabled: settings.enabled, baseUrl: normalizeSyncUrl(settings.baseUrl), workspaceId: DEFAULT_WORKSPACE_ID }
  if (value.enabled && loadSyncBackend() === 'api' && !value.baseUrl) throw new Error('启用同步前请填写服务地址')
  window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(value))
  if (token?.trim()) {
    if (window.notebookDesktop) await window.notebookDesktop.secrets.set('sync-token', token.trim())
    else window.sessionStorage?.setItem(BROWSER_TOKEN_KEY, token.trim())
  }
  return value
}

export async function getSyncToken(): Promise<string | undefined> {
  if (window.notebookDesktop) return window.notebookDesktop.secrets.get('sync-token')
  return window.sessionStorage?.getItem(BROWSER_TOKEN_KEY) ?? undefined
}

export async function hasSyncToken(): Promise<boolean> {
  return Boolean(await getSyncToken())
}

export async function clearSyncToken(): Promise<void> {
  if (window.notebookDesktop) await window.notebookDesktop.secrets.delete('sync-token')
  else window.sessionStorage?.removeItem(BROWSER_TOKEN_KEY)
}
