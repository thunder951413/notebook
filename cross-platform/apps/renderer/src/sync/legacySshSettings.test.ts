import { beforeEach, describe, expect, test } from 'vitest'
import { clearLegacySshPassword, getLegacySshPassword, loadLegacySshSettings, loadSyncBackend, saveLegacySshSettings, saveSyncBackend } from './legacySshSettings'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => { values.delete(key) }, setItem: (key, value) => { values.set(key, String(value)) } }
}

describe('legacy SSH settings', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() })
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() })
    delete window.notebookDesktop
  })

  test('normalizes the connection and keeps browser passwords out of persistent storage', async () => {
    const saved = await saveLegacySshSettings({ host: ' 10.0.0.2 ', port: 22, username: ' user ', remotePath: ' ~/notebook_backup ', fingerprint: ' SHA256:test ', privateKeyPath: ' ~/.ssh/id_ed25519 ' }, 'secret')
    expect(saved).toEqual({ host: '10.0.0.2', port: 22, username: 'user', remotePath: '~/notebook_backup', fingerprint: 'SHA256:test', privateKeyPath: '~/.ssh/id_ed25519' })
    expect(loadLegacySshSettings()).toEqual(saved)
    expect(await getLegacySshPassword()).toBe('secret')
    expect(JSON.stringify([...Array(window.localStorage.length)].map((_, index) => window.localStorage.getItem(window.localStorage.key(index)!)))).not.toContain('secret')
    await clearLegacySshPassword()
    expect(await getLegacySshPassword()).toBeUndefined()
  })

  test('persists the explicit backend choice and validates required fields', async () => {
    expect(loadSyncBackend()).toBe('webdav')
    saveSyncBackend('api')
    expect(loadSyncBackend()).toBe('api')
    await expect(saveLegacySshSettings({ host: '', port: 22, username: 'user', remotePath: '~/notes', fingerprint: '', privateKeyPath: '' })).rejects.toThrow(/服务器/)
  })
})
