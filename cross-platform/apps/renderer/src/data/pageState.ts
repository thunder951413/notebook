import type { Page } from '@notebook/domain'

/**
 * Local mirrors for fine-grained page mutations. Writing through the
 * repository and then applying these helpers keeps React state in sync
 * without scanning the whole library on every metadata toggle.
 */

/** Repository-shaped patch: identity locked to the stored record, change marked pending. */
export function applyPendingPatch(page: Page, patch: Partial<Page>, updatedAt: string): Page {
  return { ...page, ...patch, id: page.id, updatedAt, syncStatus: 'pending' }
}

export function replaceById<T extends { id: string }>(records: T[], updated: T): T[] {
  return records.map((record) => record.id === updated.id ? updated : record)
}

export function withoutIds<T extends { id: string }>(records: T[], ids: ReadonlySet<string>): T[] {
  return records.filter((record) => !ids.has(record.id))
}

export function withRecords<T>(records: T[], added: T[]): T[] {
  return added.length ? [...records, ...added] : records
}
