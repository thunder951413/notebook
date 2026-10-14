import SftpClient from 'ssh2-sftp-client'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { MAX_FILE_BYTES } from './repositoryFormat'
import { readOptional } from './session'
import { delay, sha256 } from './util'

/** Repository lock (mkdir-based, heartbeat, stale takeover) and verified atomic writes. */

const LOCK_RETRIES = 30
const LOCK_STALE_MS = 30 * 60 * 1000
const LOCK_HEARTBEAT_MS = 60 * 1000
export async function acquireLock(client: SftpClient, root: string) {
  await client.mkdir(posix.join(root, 'notes'), true)
  const lockPath = posix.join(root, 'notes/.index-write.lock')
  const ownerPath = posix.join(lockPath, 'owner')
  // The legacy Android/macOS lock contract stores a plain owner UUID and uses
  // the lock directory mtime to determine staleness.
  const owner = randomUUID()
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await client.mkdir(lockPath, false)
      await client.put(Buffer.from(`${owner}\n`), ownerPath)
      return { lockPath, ownerPath, owner }
    } catch {
      const stats = await client.stat(lockPath).catch(() => undefined)
      const ownerStats = await client.stat(ownerPath).catch(() => undefined)
      const modifiedAt = Math.max(Number(stats?.modifyTime ?? Number.NaN), Number(ownerStats?.modifyTime ?? Number.NaN))
      if (Number.isFinite(modifiedAt) && Date.now() - modifiedAt > LOCK_STALE_MS) {
        const quarantine = `${lockPath}.stale-${owner}`
        if (await client.rename(lockPath, quarantine).then(() => true).catch(() => false)) {
          await client.delete(posix.join(quarantine, 'owner'), true).catch(() => undefined)
          await client.rmdir(quarantine, false).catch(() => undefined)
        }
        continue
      }
      if (attempt + 1 === LOCK_RETRIES) {
        const currentOwner = (await readOptional(client, ownerPath).catch(() => undefined))?.toString('utf8').trim()
        const age = Number.isFinite(modifiedAt) ? Math.max(0, Math.floor((Date.now() - modifiedAt) / 1_000)) : undefined
        throw new Error(`远端仓库正在由其他设备同步${currentOwner ? `（锁 ${currentOwner.slice(0, 8)}）` : ''}${age !== undefined ? `，已持续约 ${age} 秒` : ''}；应用会在锁超过 30 分钟且确认陈旧后自动恢复，请稍后重试`)
      }
      await delay(1_000)
    }
  }
  throw new Error('无法取得远端同步锁')
}

async function refreshLock(client: SftpClient, lock: { lockPath: string; ownerPath: string; owner: string }) {
  const currentOwner = await readOptional(client, lock.ownerPath)
  if (currentOwner?.toString('utf8').trim() !== lock.owner) throw new Error('远端发布锁所有权已变化，已停止同步')
  const raw = (client as unknown as { sftp?: { setstat(path: string, attributes: { atime: number; mtime: number }, callback: (error?: Error | null) => void): void } }).sftp
  if (!raw) throw new Error('当前 SFTP 客户端无法续租远端发布锁')
  const seconds = Math.floor(Date.now() / 1_000)
  await new Promise<void>((resolve, reject) => raw.setstat(lock.lockPath, { atime: seconds, mtime: seconds }, (error) => error ? reject(error) : resolve()))
}

export function maintainLock(client: SftpClient, lock: { lockPath: string; ownerPath: string; owner: string }) {
  let failure: unknown
  let refreshing = false
  const timer = setInterval(() => {
    if (refreshing || failure) return
    refreshing = true
    void refreshLock(client, lock).catch((error) => { failure = error }).finally(() => { refreshing = false })
  }, LOCK_HEARTBEAT_MS)
  return async () => {
    clearInterval(timer)
    if (failure) throw failure
    await refreshLock(client, lock)
  }
}

export async function releaseLock(client: SftpClient, lock: { lockPath: string; ownerPath: string; owner: string }) {
  const currentOwner = await readOptional(client, lock.ownerPath).catch(() => undefined)
  if (currentOwner?.toString('utf8').trim() !== lock.owner) return
  await client.delete(lock.ownerPath, true).catch(() => undefined)
  await client.rmdir(lock.lockPath, false).catch(() => undefined)
}

/**
 * Writes a remote file atomically via a temporary name and rename. The
 * read-back verification is only applied to files that are not content
 * addressed: notes and objects carry their own hashes which the next pull
 * validates, so the extra round trip is skipped for them.
 */
export async function atomicWrite(client: SftpClient, path: string, data: Buffer, verify = false) {
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`文件超过 100 MB：${posix.basename(path)}`)
  await client.mkdir(posix.dirname(path), true)
  const temporary = `${path}.tmp.notebook-next.${randomUUID()}`
  try {
    await client.put(data, temporary)
    if (verify) {
      const check = await readOptional(client, temporary)
      if (!check || sha256(check) !== sha256(data)) throw new Error(`远端临时文件校验失败：${posix.basename(path)}`)
    }
    try { await client.posixRename(temporary, path) }
    catch { if (await client.exists(path)) await client.delete(path); await client.rename(temporary, path) }
  } catch (error) {
    await client.delete(temporary, true).catch(() => undefined)
    throw error
  }
}

export const verifyOnWrite = (name: string) => name === 'notes/index.json' || name === 'notes/privacy.json'

