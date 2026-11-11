import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PageSummary } from '../model'
import { ancestorsOf } from '../pageTree'
import type { PageVisitHistory } from '../pageVisitHistory'
import { pageVisitTarget } from '../pageVisitHistory'

/** How a page is opened; see `openPage` in App. */
export interface OpenPageOptions {
  /** The page's section, for a page that is not in the library snapshot yet or has just moved. */
  sectionId?: string
  /** The page's kind when it is not in the snapshot yet. */
  kind?: 'document' | 'task'
  /** Whether the page is in the Trash; by default looked up in the snapshot. */
  trash?: boolean
  /** Bring the editor forward on compact layouts (default true). */
  reveal?: boolean
  /** Put the cursor in the note's text. */
  focus?: boolean
  /** Keep the caller's explicit `expandedPageIds` update instead of replacing it from `openPage`. */
  preserveTreeExpansion?: boolean
  /** Keep notebooks collapsed in the sidebar if none are currently expanded (e.g. browsing smart lists). */
  keepSidebarCollapsed?: boolean
}

export interface PageNavigationOptions {
  accessiblePages: PageSummary[]
  accessibleDocumentPageIds: Set<string>
  activeArea: string
  activePage: string
  navigationOpen: boolean
  pageHistory: PageVisitHistory
  setNavOpen: Dispatch<SetStateAction<boolean>>
  setPagesOpen: Dispatch<SetStateAction<boolean>>
  setPageHistory: Dispatch<SetStateAction<PageVisitHistory>>
  setExpandedPageIds: Dispatch<SetStateAction<Set<string>>>
  /** The one way a page is selected: App's `openPage`. */
  openPage: (pageId: string, options?: OpenPageOptions) => void
}

/**
 * Navigation actions shared by the page tree, history buttons, links and the
 * command palette. Selecting the page itself is App's `openPage`; this adds
 * history, tree expansion and pane toggling around it.
 *
 * Callbacks read the latest options through a ref so their identity stays
 * stable across renders; tree rows and rail buttons can therefore be memoized.
 */
export function usePageNavigation(options: PageNavigationOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const historyNavigationTarget = useRef<string | undefined>(undefined)

  const toggleNavigation = useCallback(() => {
    const current = optionsRef.current
    if (current.navigationOpen) {
      current.setNavOpen(false)
      current.setPagesOpen(false)
      return
    }
    current.setPagesOpen(true)
    if (current.activeArea === 'notes') current.setNavOpen(true)
  }, [])

  /** Opens a page from the library by id; ids it cannot see are ignored. */
  const openRecentPage = useCallback((pageId: string) => {
    const current = optionsRef.current
    if (!current.accessiblePages.some((candidate) => candidate.id === pageId)) return
    current.openPage(pageId)
  }, [])

  const navigatePageHistory = useCallback((direction: -1 | 1) => {
    const current = optionsRef.current
    const result = pageVisitTarget(current.pageHistory, direction, (pageId) => current.accessibleDocumentPageIds.has(pageId))
    if (!result.pageId) return
    historyNavigationTarget.current = result.pageId
    current.setPageHistory(result.history)
    openRecentPage(result.pageId)
  }, [openRecentPage])

  const activateTreePage = useCallback((page: PageSummary, hasChildren: boolean) => {
    const current = optionsRef.current
    const inSection = current.accessiblePages.filter((candidate) => candidate.kind !== 'task' && candidate.sectionId === page.sectionId)
    const ancestors = ancestorsOf(inSection, page.id)
    current.setExpandedPageIds((currentIds) => {
      if (hasChildren) {
        if (current.activePage === page.id && currentIds.has(page.id)) return new Set(ancestors)
        return new Set([...ancestors, page.id])
      }
      return new Set(ancestors)
    })
    // A page from the notebook tree is a note, even when To-dos or Trash was
    // the last thing selected; openPage leaves those lists.
    current.openPage(page.id, { sectionId: page.sectionId, kind: 'document', trash: false, preserveTreeExpansion: true })
  }, [])

  return { toggleNavigation, openRecentPage, navigatePageHistory, activateTreePage, historyNavigationTarget }
}
