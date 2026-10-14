import type { PageSummary } from '../model'
import { normalizeWikiTitle, type NotebookReferenceTarget } from '@notebook/sync-contract'

export interface ResolvedNotebookReference {
  status: 'ready' | 'missing' | 'locked'
  pageId: string
  title: string
  document?: Record<string, unknown>
}

interface ReferenceRuntimeState {
  pages: PageSummary[]
  accessiblePageIds: Set<string>
  documents: Record<string, Record<string, unknown>>
  loadDocument?: (pageId: string) => Promise<Record<string, unknown> | undefined>
  openPage?: (target: NotebookReferenceTarget) => void
  /** Creates a page for a `[[title]]` link that points nowhere and opens it. */
  createPageForTitle?: (title: string) => Promise<void> | void
}

export interface ResolvedWikiLink {
  status: 'ready' | 'missing' | 'locked'
  pageId?: string
  title: string
}

/** Listener key for title links; every library change re-resolves them. */
export const WIKI_LINK_LISTENER_KEY = 'wiki-links'

let state: ReferenceRuntimeState = {
  pages: [],
  accessiblePageIds: new Set(),
  documents: {},
}
const listeners = new Map<string, Set<() => void>>()

function sameIds(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}

function notify(pageId?: string) {
  if (pageId) {
    for (const listener of listeners.get(pageId) ?? []) listener()
    return
  }
  for (const pageListeners of listeners.values()) {
    for (const listener of pageListeners) listener()
  }
}

export function configureReferenceRuntime(next: ReferenceRuntimeState) {
  const previous = state
  state = next
  if (previous.pages !== next.pages || !sameIds(previous.accessiblePageIds, next.accessiblePageIds)) {
    notify()
    return
  }
  const pageIds = new Set([...Object.keys(previous.documents), ...Object.keys(next.documents)])
  for (const pageId of pageIds) {
    if (previous.documents[pageId] !== next.documents[pageId]) notify(pageId)
  }
}

export function subscribeToReferenceRuntime(pageId: string, listener: () => void) {
  const pageListeners = listeners.get(pageId) ?? new Set<() => void>()
  pageListeners.add(listener)
  listeners.set(pageId, pageListeners)
  return () => {
    pageListeners.delete(listener)
    if (!pageListeners.size) listeners.delete(pageId)
  }
}

export async function resolveNotebookReference(target: NotebookReferenceTarget, includeDocument = false): Promise<ResolvedNotebookReference> {
  const page = state.pages.find((item) => item.id === target.pageId)
  if (!page) return { status: 'missing', pageId: target.pageId, title: '引用目标不存在' }
  if (!state.accessiblePageIds.has(page.id)) return { status: 'locked', pageId: page.id, title: '隐私内容已锁定' }
  const document = includeDocument ? state.documents[page.id] ?? await state.loadDocument?.(page.id) : undefined
  return { status: 'ready', pageId: page.id, title: page.title, ...(document ? { document } : {}) }
}

export function openReferencedTarget(target: NotebookReferenceTarget) {
  state.openPage?.(target)
}

/**
 * Resolves `[[title]]` against the library: normalized title match, notes
 * before to-dos, then the most recently updated page.
 */
export function resolveWikiLink(title: string): ResolvedWikiLink {
  const key = normalizeWikiTitle(title)
  const matches = state.pages.filter((page) => normalizeWikiTitle(page.title) === key)
  if (!key || !matches.length) return { status: 'missing', title }
  const accessible = matches.filter((page) => state.accessiblePageIds.has(page.id))
  if (!accessible.length) return { status: 'locked', title: '隐私内容已锁定' }
  const [best] = [...accessible].sort((left, right) => Number(left.kind === 'task') - Number(right.kind === 'task')
    || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
  return { status: 'ready', pageId: best!.id, title: best!.title }
}

/** Follows a title link; a link to a page that does not exist creates it. */
export function openWikiLink(title: string) {
  const resolved = resolveWikiLink(title)
  if (resolved.status === 'ready' && resolved.pageId) state.openPage?.({ pageId: resolved.pageId, kind: 'page' })
  else if (resolved.status === 'missing') void state.createPageForTitle?.(title.trim())
}

/** Pages offered while typing `[[…`, best matches first. */
export function suggestWikiLinkPages(query: string, limit = 8): PageSummary[] {
  const key = normalizeWikiTitle(query)
  const candidates = state.pages.filter((page) => state.accessiblePageIds.has(page.id) && page.title.trim())
  if (!key) return [...candidates].sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')).slice(0, limit)
  const scored: Array<[number, PageSummary]> = []
  for (const page of candidates) {
    const title = normalizeWikiTitle(page.title)
    const position = title.indexOf(key)
    if (position < 0) continue
    scored.push([(title === key ? 0 : position === 0 ? 1 : 2) * 1000 + Math.min(title.length, 999), page])
  }
  return scored.sort((left, right) => left[0] - right[0]).slice(0, limit).map(([, page]) => page)
}
