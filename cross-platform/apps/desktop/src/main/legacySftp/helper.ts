import { Client } from 'ssh2'
import { posix } from 'node:path'
import { REPOSITORY_HELPER } from './helperScript'
import { MAX_REPOSITORY_BYTES } from './repositoryFormat'
import { buildSshCredentials, fingerprint, validateConnection } from './session'
import type { LegacySftpHelperResult, LegacySshConnection } from './types'

/** Running the server-side repository helper over an SSH exec channel. */

const MAX_HELPER_ARCHIVE_BYTES = MAX_REPOSITORY_BYTES + 32 * 1024 * 1024
const MAX_HELPER_STDERR_BYTES = 16 * 1024 * 1024
const HELPER_PROBE_TIMEOUT_MS = 15 * 1000
const HELPER_COMMAND_TIMEOUT_MS = 60 * 60 * 1000
// The helper is executed as `python3 -c "..."`. The script itself, the
// operation and the repository root travel as base64 payloads, which contain
// no shell metacharacters inside double quotes; the caller invokes `main()`
// explicitly after exec so the repository root reaches the script without
// environment plumbing. stdin stays available for import-tar payloads.
function helperCommand(op: string, root: string) {
  const script = Buffer.from(REPOSITORY_HELPER).toString('base64')
  return `python3 -c "import base64,sys;exec(base64.b64decode('${script}'));main(base64.b64decode('${Buffer.from(op).toString('base64')}').decode(),base64.b64decode('${Buffer.from(root).toString('base64')}').decode())"`
}

interface ExecResult { code: number; stdout: Uint8Array; stderr: string }

async function connectExec(settings: LegacySshConnection) {
  validateConnection(settings)
  const credentials = await buildSshCredentials(settings)
  const client = new Client()
  let presented = ''
  const expected = settings.fingerprint?.trim() ?? ''
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        client.removeListener('ready', onReady)
        reject(error)
      }
      const onReady = () => {
        client.removeListener('error', onError)
        resolve()
      }
      client.once('error', onError)
      client.once('ready', onReady)
      client.connect({
        host: settings.host.trim(), port: settings.port, username: settings.username.trim(),
        password: credentials.password, privateKey: credentials.privateKey, passphrase: credentials.passphrase,
        readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          presented = fingerprint(key)
          return !expected || presented === expected
        },
      })
    })
  } catch (error) {
    client.end()
    if (expected && presented && presented !== expected) throw new Error(`SSH 主机指纹已变化|${expected}|${presented}`, { cause: error })
    throw error
  }
  if (!presented) { client.end(); throw new Error('服务器没有提供可校验的 SSH 主机密钥') }
  // ssh2 emits connection-level errors after the ready event as well. Keeping
  // a listener prevents an unhandled EventEmitter error from crashing the main
  // process; command streams still surface their own failure to the caller.
  client.on('error', () => undefined)
  return client
}

function execCommand(client: Client, command: string, input?: Uint8Array, maximumStdout = MAX_REPOSITORY_BYTES, timeoutMs = HELPER_COMMAND_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return }
      const chunks: Buffer[] = []
      let stdoutBytes = 0
      let stderr = ''
      let stderrBytes = 0
      let settled = false
      let timeout: NodeJS.Timeout | undefined
      const onClientError = (reason: Error) => {
        rejectOnce(reason)
        stream.close()
      }
      const cleanup = () => {
        client.removeListener('error', onClientError)
        if (timeout) clearTimeout(timeout)
      }
      const rejectOnce = (reason: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(reason)
      }
      const resolveOnce = (value: ExecResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      client.once('error', onClientError)
      timeout = setTimeout(() => {
        rejectOnce(new Error(`服务器 helper 执行超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已终止`))
        stream.close()
      }, timeoutMs)
      stream.on('data', (chunk: Buffer) => {
        if (settled) return
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > maximumStdout) {
          rejectOnce(new Error(`服务器 helper 输出超过 ${Math.floor(maximumStdout / 1024 / 1024)} MB 上限`))
          stream.close()
          return
        }
        chunks.push(chunk)
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        if (settled) return
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_HELPER_STDERR_BYTES) {
          rejectOnce(new Error('服务器 helper 错误输出超过 16 MB 上限'))
          stream.close()
          return
        }
        stderr += chunk.toString('utf8')
      })
      stream.on('close', (code: number | null) => resolveOnce({ code: code ?? -1, stdout: new Uint8Array(Buffer.concat(chunks)), stderr }))
      stream.on('error', rejectOnce)
      if (input) stream.write(input)
      stream.end()
    })
  })
}

export async function runRepositoryHelper(settings: LegacySshConnection, operation: 'export-tar' | 'import-tar' | 'verify' | 'gc', input?: Uint8Array): Promise<LegacySftpHelperResult> {
  if (input && input.byteLength > MAX_HELPER_ARCHIVE_BYTES) throw new Error(`待导入归档超过 ${Math.floor(MAX_HELPER_ARCHIVE_BYTES / 1024 / 1024)} MB 传输上限`)
  const client = await connectExec(settings)
  try {
    const cwdResult = await execCommand(client, 'pwd', undefined, 1024 * 1024, HELPER_PROBE_TIMEOUT_MS)
    if (cwdResult.code !== 0) throw new Error(cwdResult.stderr.trim() || '无法确定 SSH 用户主目录')
    const home = cwdResult.stdout.length ? new TextDecoder().decode(cwdResult.stdout).trim() : ''
    if (!home.startsWith('/')) throw new Error('服务器返回了无效的 SSH 用户主目录')
    const configured = settings.remotePath.trim()
    const root = configured === '~' ? home : configured.startsWith('~/') ? posix.join(home, configured.slice(2)) : configured.startsWith('/') ? posix.normalize(configured) : posix.join(home, configured)
    const result = await execCommand(client, helperCommand(operation, root), input, operation === 'export-tar' ? MAX_HELPER_ARCHIVE_BYTES : MAX_HELPER_STDERR_BYTES)
    const stderrMessage = (() => {
      const raw = result.stderr.trim()
      if (!raw) return ''
      for (const line of raw.split(/\r?\n/).reverse()) {
        try {
          const value = JSON.parse(line) as { error?: unknown }
          if (typeof value.error === 'string') return value.error
        } catch { /* preserve raw stderr below */ }
      }
      return raw
    })()
    if (operation === 'export-tar') {
      // The tar stream is raw; a failed helper prints a JSON error to stderr.
      if (result.code !== 0 || result.stdout.byteLength === 0) {
        throw new Error(stderrMessage || `服务器 helper 导出失败（退出码 ${result.code}）`)
      }
      return { ok: true, data: result.stdout, message: `${result.stdout.byteLength} 字节` }
    }
    let parsed: { ok?: boolean; error?: string; errors?: string[]; quarantined?: number; purged?: number; graceDays?: number; retentionDays?: number; recovery?: string | null }
    try {
      parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as typeof parsed
    } catch {
      throw new Error(stderrMessage || `服务器 helper 返回了无法解析的结果（退出码 ${result.code}）`)
    }
    if (operation === 'verify') {
      const errors = parsed.errors ?? []
      if (result.code !== 0 || parsed.ok === false || errors.length) {
        throw new Error(errors.length ? `仓库校验发现 ${errors.length} 个问题：${errors.join('；')}` : (parsed.error ?? stderrMessage) || '服务器 helper 校验失败')
      }
      return { ok: true, message: '仓库校验通过' }
    }
    if (result.code !== 0 || parsed.ok === false) throw new Error((parsed.error ?? stderrMessage) || '服务器 helper 执行失败')
    if (operation === 'gc') {
      const recovery = parsed.recovery ? `，恢复目录：${parsed.recovery}` : ''
      return { ok: true, message: `已隔离 ${parsed.quarantined ?? 0} 个孤儿对象，永久清除 ${parsed.purged ?? 0} 个过期隔离对象${recovery}` }
    }
    return { ok: true, message: parsed.recovery ? `仓库已导入；覆盖前文件保存在 ${parsed.recovery}` : '仓库已导入' }
  } finally {
    client.end()
  }
}
