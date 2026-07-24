import type { PageSummary } from '../model'
import type { NotebookReferenceTarget } from '@notebook/sync-contract'

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
}

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
