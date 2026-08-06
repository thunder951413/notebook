import type { LegacySshSettings } from './legacySshSettings'

/**
 * QR payload shared with Android Notebook.
 *
 * v1 (legacy): password-based auth, `password` is required.
 * v2 (current): adds `privateKeyPath` + `privateKeyPassphrase`; password is
 *   optional (servers may have disabled password auth). At least one of
 *   `password` or `privateKeyPath` must be present.
 */
export interface NotebookSyncQrPayload {
  type: 'notebook-sync'
  version: 1 | 2
  host: string
  port: number
  username: string
  path: string
  fingerprint: string
  /** SSH 登录密码（v1 必填；v2 可选，服务器关闭密码登录时留空）。 */
  password?: string
  /** SSH 私钥文件路径（v2 新增；提供时优先使用公钥认证）。 */
  privateKeyPath?: string
  /** SSH 私钥口令（v2 新增；无口令私钥可留空）。 */
  privateKeyPassphrase?: string
}

export function buildNotebookSyncQrPayload(settings: LegacySshSettings, password: string, passphrase = ''): NotebookSyncQrPayload {
  const host = settings.host.trim()
  const username = settings.username.trim()
  const path = settings.remotePath.trim()
  const privateKeyPath = settings.privateKeyPath.trim()
  if (!host) throw new Error('请先填写 SSH 服务器地址')
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error('SSH 端口必须在 1–65535 之间')
  if (!username) throw new Error('请先填写 SSH 用户名')
  if (!path) throw new Error('请先填写远端同步目录')
  if (!password && !privateKeyPath) throw new Error('请先保存 SSH 私钥文件路径或密码')
  if (settings.fingerprint && !settings.fingerprint.startsWith('SHA256:')) throw new Error('SSH 主机指纹格式无效')
  // Emit v2 when a private key is configured (or password is absent);
  // otherwise stay on v1 for backward compatibility with older Android builds.
  const version: 1 | 2 = privateKeyPath || !password ? 2 : 1
  return {
    type: 'notebook-sync',
    version,
    host,
    port: settings.port,
    username,
    path,
    fingerprint: settings.fingerprint.trim(),
    ...(password ? { password } : {}),
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(version === 2 && passphrase ? { privateKeyPassphrase: passphrase } : {}),
  }
}

export function serializeNotebookSyncQrPayload(settings: LegacySshSettings, password: string, passphrase = '') {
  return JSON.stringify(buildNotebookSyncQrPayload(settings, password, passphrase))
}
