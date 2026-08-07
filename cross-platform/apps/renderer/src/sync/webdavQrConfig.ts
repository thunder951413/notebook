import type { WebdavSettings } from './webdavSettings'

/**
 * QR payload shared with Android Notebook: scanning the code on the desktop
 * fills in the WebDAV (坚果云) sync configuration on the phone.
 *
 * {"type":"notebook-webdav","version":1,"baseUrl":"https://dav.jianguoyun.com/dav/",
 *  "username":"user@example.com","appPassword":"...","remotePath":"notebook_backup",
 *  "syncPassword":"..."}
 *
 * The app password grants WebDAV access, so the code is sensitive: the
 * settings UI warns about it and suggests rotating the password afterwards.
 */
export interface WebdavQrPayload {
  type: 'notebook-webdav'
  version: 1
  baseUrl: string
  username: string
  appPassword: string
  remotePath: string
  /** 可选：仅用于隐私笔记加密（同步密码），与 WebDAV 认证无关。 */
  syncPassword?: string
}

export function buildWebdavQrPayload(settings: WebdavSettings, appPassword: string, syncPassword = ''): WebdavQrPayload {
  const baseUrl = settings.baseUrl.trim()
  const username = settings.username.trim()
  const remotePath = settings.remotePath.trim()
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error('请先填写 WebDAV 服务器地址')
  if (!username) throw new Error('请先填写 WebDAV 用户名')
  if (!remotePath) throw new Error('请先填写远端同步目录')
  if (!appPassword.trim()) throw new Error('请先填写并保存 WebDAV 应用密码')
  return {
    type: 'notebook-webdav',
    version: 1,
    baseUrl,
    username,
    appPassword: appPassword.trim(),
    remotePath,
    ...(syncPassword.trim() ? { syncPassword: syncPassword.trim() } : {}),
  }
}

export function serializeWebdavQrPayload(settings: WebdavSettings, appPassword: string, syncPassword = '') {
  return JSON.stringify(buildWebdavQrPayload(settings, appPassword, syncPassword))
}
