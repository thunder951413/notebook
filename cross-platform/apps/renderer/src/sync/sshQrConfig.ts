import type { LegacySshSettings } from './legacySshSettings'

export interface NotebookSyncQrPayload {
  type: 'notebook-sync'
  version: 1
  host: string
  port: number
  username: string
  password: string
  path: string
  fingerprint: string
}

export function buildNotebookSyncQrPayload(settings: LegacySshSettings, password: string): NotebookSyncQrPayload {
  const host = settings.host.trim()
  const username = settings.username.trim()
  const path = settings.remotePath.trim()
  if (!host) throw new Error('请先填写 SSH 服务器地址')
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error('SSH 端口必须在 1–65535 之间')
  if (!username) throw new Error('请先填写 SSH 用户名')
  if (!password) throw new Error('请先保存 SSH 密码')
  if (!path) throw new Error('请先填写远端同步目录')
  if (settings.fingerprint && !settings.fingerprint.startsWith('SHA256:')) throw new Error('SSH 主机指纹格式无效')
  return {
    type: 'notebook-sync',
    version: 1,
    host,
    port: settings.port,
    username,
    password,
    path,
    fingerprint: settings.fingerprint.trim(),
  }
}

export function serializeNotebookSyncQrPayload(settings: LegacySshSettings, password: string) {
  return JSON.stringify(buildNotebookSyncQrPayload(settings, password))
}
