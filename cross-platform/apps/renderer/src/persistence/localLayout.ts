/**
 * localStorage persistence for layout and convenience state. This is a
 * renderer-only cache: durable workspace state lives in IndexedDB, while
 * these keys only remember window layout, expanded page trees, recent pages,
 * Vim mode and the per-session reading positions used to restore a page's
 * scroll offset on reopen.
 */

export const LAYOUT_KEY = 'notebook-layout-v1'
export const RECENT_PAGES_KEY = 'notebook-recent-pages-v1'
export const VIM_MODE_KEY = 'notebook-vim-mode-v1'
export const EXPANDED_PAGES_KEY = 'notebook-expanded-pages-v1'
export const PAGE_TREE_DRAG_TYPE = 'application/x-notebook-page-id'
export const LOCAL_READING_POSITIONS_KEY = 'notebook-local-reading-positions-v1'

export type RightPanel = 'outline' | 'backlinks'
export type ViewportPosition = { scrollTop?: number; fraction: number }
export type SavedLayout = { navOpen?: boolean; pagesOpen?: boolean; aiOpen?: boolean; rightPanel?: RightPanel; notebookWidth?: number; pageWidth?: number; aiWidth?: number; sidebarWidth?: number; listWidth?: number; browse?: 'tree' | 'list' }

export function readLayout(): SavedLayout {
  try { return JSON.parse(globalThis.localStorage?.getItem(LAYOUT_KEY) ?? '{}') as SavedLayout } catch { return {} }
}

export function readLocalReadingPositions(): Record<string, ViewportPosition> {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(LOCAL_READING_POSITIONS_KEY) ?? '{}') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([pageId, raw]) => {
      if (!raw || typeof raw !== 'object') return []
      const position = raw as Record<string, unknown>
      const fraction = Number(position.fraction)
      const scrollTop = Number(position.scrollTop)
      if (!Number.isFinite(fraction)) return []
      return [[pageId, {
        fraction: Math.max(0, Math.min(1, fraction)),
        ...(Number.isFinite(scrollTop) && scrollTop >= 0 ? { scrollTop } : {}),
      } satisfies ViewportPosition]]
    }).slice(-500))
  } catch {
    return {}
  }
}

export function writeLocalReadingPositions(positions: Map<string, ViewportPosition>) {
  try {
    globalThis.localStorage?.setItem(LOCAL_READING_POSITIONS_KEY, JSON.stringify(Object.fromEntries([...positions].slice(-500))))
  } catch {
    // Reading position is a convenience cache; IndexedDB still keeps the
    // synchronized fractional fallback if localStorage is unavailable.
  }
}

export function readRecentPageIds(): string[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(RECENT_PAGES_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-12) : []
  } catch { return [] }
}

export function readExpandedPageIds(): Set<string> {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(EXPANDED_PAGES_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch { return new Set() }
}

export function readVimEnabled() {
  try { return globalThis.localStorage?.getItem(VIM_MODE_KEY) === 'true' } catch { return false }
}
