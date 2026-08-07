import { beforeEach, describe, expect, test } from 'vitest'
import { buildWebdavQrPayload, serializeWebdavQrPayload } from './webdavQrConfig'

const settings = { baseUrl: 'https://dav.jianguoyun.com/dav/', username: 'user@example.com', remotePath: 'notebook_backup' }

describe('webdav QR payload', () => {
  beforeEach(() => { window.localStorage.clear() })

  test('serializes the full configuration including credentials', () => {
    const serialized = serializeWebdavQrPayload(settings, 'app-password', 'sync-password')
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    expect(parsed).toMatchObject({
      type: 'notebook-webdav',
      version: 1,
      baseUrl: 'https://dav.jianguoyun.com/dav/',
      username: 'user@example.com',
      appPassword: 'app-password',
      remotePath: 'notebook_backup',
      syncPassword: 'sync-password',
    })
  })

  test('omits the optional sync password when blank', () => {
    const payload = buildWebdavQrPayload(settings, 'app-password')
    expect(payload).not.toHaveProperty('syncPassword')
  })

  test('trims surrounding whitespace but keeps the URL shape as-is', () => {
    const payload = buildWebdavQrPayload(
      { baseUrl: 'https://dav.jianguoyun.com/dav// ', username: ' user@example.com ', remotePath: ' notebook_backup ' },
      ' app-password ',
    )
    expect(payload).toEqual({
      type: 'notebook-webdav',
      version: 1,
      baseUrl: 'https://dav.jianguoyun.com/dav//',
      username: 'user@example.com',
      appPassword: 'app-password',
      remotePath: 'notebook_backup',
    })
  })

  test('rejects incomplete configuration', () => {
    expect(() => buildWebdavQrPayload({ ...settings, username: '' }, 'app-password')).toThrow(/用户名/)
    expect(() => buildWebdavQrPayload({ ...settings, baseUrl: 'ftp://x' }, 'app-password')).toThrow(/服务器地址/)
    expect(() => buildWebdavQrPayload(settings, '')).toThrow(/应用密码/)
    expect(() => buildWebdavQrPayload({ ...settings, remotePath: '' }, 'app-password')).toThrow(/远端同步目录/)
  })
})
