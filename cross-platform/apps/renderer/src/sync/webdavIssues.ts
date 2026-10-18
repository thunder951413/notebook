import type { QuarantineReason, SyncQuarantineItem } from '@notebook/storage-renderer'
import { PrivacyError } from './webdavPrivacy'

/** Why a peer's journal cannot be read as a whole (contract: pull-isolation.json). */
export type WebdavBlockCode = 'journal-corrupt' | 'head-corrupt' | 'journal-truncated' | 'journal-missing' | 'journal-too-large'

export interface WebdavBlockedDevice {
  deviceId: string
  code: WebdavBlockCode
  message: string
  knownSeq: number
  headLastSeq?: number
  journalLastSeq?: number
}

/** What still needs attention after a sync that otherwise succeeded. */
export interface WebdavSyncIssues {
  /** Remote records set aside because this device cannot apply them (yet). */
  quarantined: number
  /** Devices whose journal could not be trusted; their records are not (fully) read. */
  blocked: WebdavBlockedDevice[]
}

/** A record that failed to materialize, in the quarantine vocabulary. */
export interface MaterializeFailure { reason: QuarantineReason; message: string }

/**
 * Sorts a failure while reading one remote record. Only trouble with the
 * record's own data is set aside. Anything else (network, authentication,
 * timeouts, cancellation) says nothing about the record and must fail the run,
 * otherwise an outage would silently turn every record into a "problem".
 */
export function classifyMaterializeFailure(error: unknown): MaterializeFailure | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof PrivacyError) {
    return { reason: error.code === 'needs-key' ? 'needs-key' : error.code === 'bad-key' ? 'bad-key' : 'invalid-payload', message }
  }
  if ((error as { status?: number } | null)?.status === 404 || /Invalid response: 404/.test(message)) return { reason: 'missing-object', message }
  if (/SHA-256 校验失败|内容校验失败/.test(message)) return { reason: 'object-corrupt', message }
  if (error instanceof SyntaxError || /不是有效的实体内容|缺少内容哈希/.test(message)) return { reason: 'invalid-payload', message }
  return undefined
}

/** Failures that retrying can fix by itself are retried a few times per record, then left to the user. */
const AUTOMATIC_ATTEMPTS = 5
const retriedThisSession = new Set<string>()

/** Whether the next sync should quietly try a set-aside record again. */
export function shouldRetryAutomatically(item: SyncQuarantineItem, context: { hasKey: boolean; supportsType: (entityType: string) => boolean }): boolean {
  switch (item.reason) {
    case 'needs-key': return context.hasKey && item.attempts < AUTOMATIC_ATTEMPTS
    case 'bad-key': return context.hasKey && item.attempts < AUTOMATIC_ATTEMPTS
    case 'unknown-type': return context.supportsType(item.entityType)
    case 'missing-object':
    case 'object-corrupt': return item.attempts < AUTOMATIC_ATTEMPTS
    // A newer app version may accept what an older one rejected: once per launch.
    case 'invalid-payload': {
      if (retriedThisSession.has(item.id)) return false
      retriedThisSession.add(item.id)
      return true
    }
    default: return false
  }
}

const BLOCKED_KEY = 'notebook-webdav-blocked-v1'

export function saveBlockedDevices(repository: string, blocked: WebdavBlockedDevice[]) {
  try {
    const all = JSON.parse(window.localStorage.getItem(BLOCKED_KEY) ?? '{}') as Record<string, WebdavBlockedDevice[]>
    if (blocked.length) all[repository] = blocked
    else delete all[repository]
    window.localStorage.setItem(BLOCKED_KEY, JSON.stringify(all))
  } catch { /* storage unavailable: the list is informational */ }
}

export function loadBlockedDevices(repository: string): WebdavBlockedDevice[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(BLOCKED_KEY) ?? '{}') as Record<string, WebdavBlockedDevice[]>
    return Array.isArray(all[repository]) ? all[repository] : []
  } catch { return [] }
}

/** Short Chinese summary for toasts and the status line. */
export function describeIssues(issues: WebdavSyncIssues): string {
  const parts: string[] = []
  if (issues.quarantined) parts.push(`${issues.quarantined} 条云端记录暂时无法应用`)
  if (issues.blocked.length) parts.push(`${issues.blocked.length} 台设备的云端日志异常`)
  return parts.join('，')
}
