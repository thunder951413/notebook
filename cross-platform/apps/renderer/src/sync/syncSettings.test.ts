import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clearSyncToken, DEFAULT_WORKSPACE_ID, getSyncToken, loadSyncSettings, normalizeSyncUrl, saveSyncBackend, saveSyncSettings } from './syncSettings'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

describe('runtime sync settings', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() })
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() })
  })

  afterEach(async () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    await clearSyncToken()
    vi.unstubAllEnvs()
  })

  test('persists the service address while keeping the shared workspace identity fixed', async () => {
    const saved = await saveSyncSettings({ enabled: true, baseUrl: 'https://notes.example.com/' }, 'secret')
    expect(saved).toEqual({ enabled: true, baseUrl: 'https://notes.example.com', workspaceId: DEFAULT_WORKSPACE_ID })
    expect(loadSyncSettings()).toEqual(saved)
    expect(await getSyncToken()).toBe('secret')
  })

  test('validates URLs and permits disabling sync without a server', async () => {
    expect(() => normalizeSyncUrl('ssh://notes.example.com')).toThrow(/HTTP/)
    saveSyncBackend('api')
    await expect(saveSyncSettings({ enabled: true, baseUrl: '' })).rejects.toThrow(/服务地址/)
    await expect(saveSyncSettings({ enabled: false, baseUrl: '' })).resolves.toMatchObject({ enabled: false })
  })
})
