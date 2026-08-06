import { describe, expect, test } from 'vitest'
import { buildNotebookSyncQrPayload, serializeNotebookSyncQrPayload } from './sshQrConfig'
import type { LegacySshSettings } from './legacySshSettings'

const baseSettings: LegacySshSettings = {
  host: 'notebook.example',
  port: 21000,
  username: 'user',
  remotePath: '~/NotebookSync',
  fingerprint: 'SHA256:host-key',
  privateKeyPath: '',
}

describe('Android SSH QR configuration', () => {
  test('matches the version 1 payload consumed by Android (password-only)', () => {
    const settings: LegacySshSettings = { ...baseSettings, host: ' notebook.example ', username: ' user ', remotePath: ' ~/NotebookSync ' }
    expect(JSON.parse(serializeNotebookSyncQrPayload(settings, 'secret'))).toEqual({
      type: 'notebook-sync',
      version: 1,
      host: 'notebook.example',
      port: 21000,
      username: 'user',
      password: 'secret',
      path: '~/NotebookSync',
      fingerprint: 'SHA256:host-key',
    })
  })

  test('emits version 2 with private key when configured', () => {
    const settings: LegacySshSettings = { ...baseSettings, privateKeyPath: '~/.ssh/id_ed25519' }
    const payload = JSON.parse(serializeNotebookSyncQrPayload(settings, '', 'my-passphrase'))
    expect(payload).toEqual({
      type: 'notebook-sync',
      version: 2,
      host: 'notebook.example',
      port: 21000,
      username: 'user',
      path: '~/NotebookSync',
      fingerprint: 'SHA256:host-key',
      privateKeyPath: '~/.ssh/id_ed25519',
      privateKeyPassphrase: 'my-passphrase',
    })
  })

  test('emits version 2 without password when using private key only', () => {
    const settings: LegacySshSettings = { ...baseSettings, privateKeyPath: '~/.ssh/id_ed25519' }
    const payload = JSON.parse(serializeNotebookSyncQrPayload(settings, ''))
    expect(payload.version).toBe(2)
    expect(payload.password).toBeUndefined()
    expect(payload.privateKeyPath).toBe('~/.ssh/id_ed25519')
  })

  test('refuses to display an incomplete or unsafe payload', () => {
    const settings: LegacySshSettings = { ...baseSettings, host: '', fingerprint: '' }
    expect(() => buildNotebookSyncQrPayload(settings, 'secret')).toThrow(/服务器地址/)
    expect(() => buildNotebookSyncQrPayload({ ...settings, host: 'server' }, '')).toThrow(/密码/)
    expect(() => buildNotebookSyncQrPayload({ ...settings, host: 'server', fingerprint: 'md5:bad' }, 'secret')).toThrow(/指纹/)
  })
})
