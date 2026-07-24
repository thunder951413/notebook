import { describe, expect, test } from 'vitest'
import { buildNotebookSyncQrPayload, serializeNotebookSyncQrPayload } from './sshQrConfig'

describe('Android SSH QR configuration', () => {
  test('matches the version 1 payload consumed by Android', () => {
    const settings = {
      host: ' notebook.example ',
      port: 21000,
      username: ' user ',
      remotePath: ' ~/NotebookSync ',
      fingerprint: 'SHA256:host-key',
    }
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

  test('refuses to display an incomplete or unsafe payload', () => {
    const settings = { host: '', port: 22, username: 'user', remotePath: '~/NotebookSync', fingerprint: '' }
    expect(() => buildNotebookSyncQrPayload(settings, 'secret')).toThrow(/服务器地址/)
    expect(() => buildNotebookSyncQrPayload({ ...settings, host: 'server' }, '')).toThrow(/密码/)
    expect(() => buildNotebookSyncQrPayload({ ...settings, host: 'server', fingerprint: 'md5:bad' }, 'secret')).toThrow(/指纹/)
  })
})
