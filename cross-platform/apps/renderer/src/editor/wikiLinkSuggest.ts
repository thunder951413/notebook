import type { EditorState } from 'prosemirror-state'
import { isLinkableTitle, normalizeWikiTitle } from '@notebook/sync-contract'
import type { PageSummary } from '../model'

export interface WikiTrigger {
  /** Document position of the opening `[[`. */
  from: number
  /** Cursor position (end of the typed query). */
  to: number
  query: string
}

const MAX_QUERY = 80

/**
 * An unfinished `[[…` immediately before the cursor in the current text
 * block (not in code), i.e. the user is typing a title link.
 */
export function findWikiTrigger(state: EditorState): WikiTrigger | undefined {
  const { selection } = state
  if (!selection.empty) return undefined
  const $from = selection.$from
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.spec.code) return undefined
  if ($from.marks().some((mark) => mark.type.spec.code)) return undefined
  // Atom nodes become U+FFFC so offsets stay aligned with document positions.
  const before = parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const open = before.lastIndexOf('[[')
  if (open < 0) return undefined
  const query = before.slice(open + 2)
  if (query.length > MAX_QUERY || /[[\]|\n￼]/.test(query) || query.startsWith('page:')) return undefined
  const from = $from.start() + open
  return { from, to: selection.from, query }
}

export type WikiSuggestion =
  | { kind: 'page'; page: PageSummary }
  | { kind: 'create'; title: string }
  | { kind: 'advanced' }

export function wikiSuggestions(query: string, pages: PageSummary[], currentPageId?: string): WikiSuggestion[] {
  const items: WikiSuggestion[] = pages.filter((page) => page.id !== currentPageId).map((page) => ({ kind: 'page', page }))
  const title = query.trim()
  const exact = pages.some((page) => normalizeWikiTitle(page.title) === normalizeWikiTitle(title))
  if (title && !exact && isLinkableTitle(title)) items.push({ kind: 'create', title })
  items.push({ kind: 'advanced' })
  return items
}
