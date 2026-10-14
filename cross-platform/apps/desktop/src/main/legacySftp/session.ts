import SftpClient from 'ssh2-sftp-client'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { readFile } from 'node:fs/promises'
import { MAX_FILE_BYTES } from './repositoryFormat'
import type { LegacySftpConnectionResult, LegacySshConnection } from './types'

/** SSH credentials, pooled SFTP sessions and tolerant reads. */

const SESSION_IDLE_MS = 60 * 1000
interface SftpSession {
  id: string
  client: SftpClient
  root: string
  fingerprint: string
  key: string
  /** Settings identity used to validate a renderer-provided session id. */
  settingsKey: string
  lastUsed: number
  timer?: NodeJS.Timeout
}
const sessions = new Map<string, SftpSession>()
let sessionCounter = 0

export const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
export function validateConnection(value: LegacySshConnection) {
  if (!value.host.trim() || /[\s/]/.test(value.host)) throw new Error('SSH 服务器地址不正确')
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('SSH 端口必须在 1–65535 之间')
  if (!value.username.trim() || /[\r\n]/.test(value.username)) throw new Error('SSH 用户名不正确')
  if (!value.remotePath.trim() || value.remotePath.includes('\0')) throw new Error('请填写远端同步目录')
  const hasPassword = Boolean(value.password)
  const hasPrivateKey = Boolean(value.privateKeyPath?.trim())
  if (!hasPassword && !hasPrivateKey) throw new Error('请配置 SSH 私钥文件路径或登录密码')
}

/** Resolve a `~/`-prefixed path to an absolute filesystem path. */
function resolvePrivateKeyPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('~/')) return posix.join(homedir(), trimmed.slice(2))
  if (trimmed === '~') return homedir()
  return trimmed
}

/**
 * Build ssh2/ssh2-sftp-client connect credentials from a LegacySshConnection.
 * Private key auth takes precedence when provided; password is only sent when
 * no key is configured (the server may have disabled password auth entirely).
 */
export async function buildSshCredentials(settings: LegacySshConnection) {
  const keyPath = settings.privateKeyPath?.trim()
  if (keyPath) {
    let privateKey: Buffer
    try {
      privateKey = await readFile(resolvePrivateKeyPath(keyPath))
    } catch (error) {
      throw new Error(`无法读取 SSH 私钥文件：${resolvePrivateKeyPath(keyPath)}（请检查路径和权限）`, { cause: error })
    }
    const passphrase = settings.privateKeyPassphrase?.trim() || undefined
    return { privateKey, passphrase, password: undefined as string | undefined }
  }
  return { privateKey: undefined, passphrase: undefined, password: settings.password }
}

async function connect(settings: LegacySshConnection) {
  validateConnection(settings)
  const credentials = await buildSshCredentials(settings)
  const client = new SftpClient('Notebook legacy sync')
  let presented = ''
  const expected = settings.fingerprint?.trim() ?? ''
  try {
    await client.connect({
      host: settings.host.trim(), port: settings.port, username: settings.username.trim(),
      password: credentials.password, privateKey: credentials.privateKey, passphrase: credentials.passphrase,
      readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer | string) => {
        presented = fingerprint(Buffer.isBuffer(key) ? key : Buffer.from(key))
        return !expected || presented === expected
      },
    })
  } catch (error) {
    await client.end().catch(() => undefined)
    if (expected && presented && presented !== expected) throw new Error(`SSH 主机指纹已变化|${expected}|${presented}`, { cause: error })
    throw error
  }
  if (!presented) { await client.end(); throw new Error('服务器没有提供可校验的 SSH 主机密钥') }
  const home = await client.cwd()
  const configured = settings.remotePath.trim()
  const root = configured === '~' ? home : configured.startsWith('~/') ? posix.join(home, configured.slice(2)) : configured.startsWith('/') ? posix.normalize(configured) : posix.join(home, configured)
  return { client, root, fingerprint: presented }
}

function settingsSessionKey(settings: LegacySshConnection) {
  return `${settings.host.trim()}:${settings.port}:${settings.username.trim()}:${settings.remotePath.trim()}:${settings.privateKeyPath?.trim() ?? ''}`
}

function canReuseSession(session: SftpSession, settings: LegacySshConnection) {
  const expectedFingerprint = settings.fingerprint?.trim()
  return session.settingsKey === settingsSessionKey(settings) && (!expectedFingerprint || session.fingerprint === expectedFingerprint)
}

/**
 * SFTP sessions keep the SSH connection alive between the pull and push phases
 * of one sync, avoiding a second handshake per synchronization. Sessions are
 * released explicitly by the renderer or expire after an idle period.
 */
export async function sessionFor(settings: LegacySshConnection, sessionId?: string): Promise<SftpSession> {
  if (sessionId) {
    const existing = sessions.get(sessionId)
    if (existing && canReuseSession(existing, settings)) {
      existing.lastUsed = Date.now()
      scheduleSessionCleanup(existing)
      return existing
    }
  }
  const connected = await connect(settings)
  const key = `${settings.host.trim()}:${settings.port}:${settings.username.trim()}:${connected.root}`
  const existing = [...sessions.values()].find((session) => session.key === key && canReuseSession(session, settings))
  if (existing) {
    await connected.client.end().catch(() => undefined)
    existing.lastUsed = Date.now()
    scheduleSessionCleanup(existing)
    return existing
  }
  const session: SftpSession = { id: `s${++sessionCounter}`, client: connected.client, root: connected.root, fingerprint: connected.fingerprint, key, settingsKey: settingsSessionKey(settings), lastUsed: Date.now() }
  sessions.set(session.id, session)
  scheduleSessionCleanup(session)
  return session
}

function scheduleSessionCleanup(session: SftpSession) {
  if (session.timer) clearTimeout(session.timer)
  session.timer = setTimeout(() => {
    if (Date.now() - session.lastUsed >= SESSION_IDLE_MS) {
      sessions.delete(session.id)
      void session.client.end().catch(() => undefined)
    } else {
      scheduleSessionCleanup(session)
    }
  }, SESSION_IDLE_MS)
  session.timer.unref?.()
}

export async function releaseLegacySession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  if (session.timer) clearTimeout(session.timer)
  await session.client.end().catch(() => undefined)
}

export async function testLegacyConnection(settings: LegacySshConnection): Promise<LegacySftpConnectionResult> {
  const startedAt = Date.now()
  const { client, root, fingerprint: actualFingerprint } = await connect(settings)
  try {
    const remotePathExists = Boolean(await client.exists(root))
    if (remotePathExists) await client.stat(root)
    return {
      fingerprint: actualFingerprint,
      remotePath: root,
      remotePathExists,
      latencyMs: Math.max(0, Date.now() - startedAt),
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

function isNoSuchFile(error: unknown) {
  const code = (error as { code?: unknown }).code
  return code === 2 || (error instanceof Error && /no such file|not found|ENOENT/i.test(error.message))
}

/**
 * Reads a bounded remote file. Missing files return undefined instead of
 * throwing.  When the caller has a directory-listing size it is passed in to
 * avoid a second stat; direct callers stat before downloading so a malicious
 * or accidentally huge optional file is never buffered in memory.
 */
export async function readOptional(client: SftpClient, path: string, maximumBytes = MAX_FILE_BYTES, knownSize?: number): Promise<Buffer | undefined> {
  try {
    const size = knownSize ?? (await client.stat(path)).size
    if (size > maximumBytes) throw new Error(`远端文件超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB：${posix.basename(path)}`)
    const value = await client.get(path)
    if (!Buffer.isBuffer(value)) throw new Error(`无法读取远端文件：${path}`)
    if (value.byteLength > maximumBytes) throw new Error(`远端文件超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB：${posix.basename(path)}`)
    return value
  } catch (error) {
    if (isNoSuchFile(error)) return undefined
    throw error
  }
}

export async function listOptional(client: SftpClient, path: string): Promise<Map<string, { size: number }> | undefined> {
  try {
    const entries = await client.list(path)
    return new Map(entries.map((entry) => [entry.name, { size: entry.size }]))
  } catch (error) {
    if (isNoSuchFile(error)) return undefined
    throw error
  }
}

