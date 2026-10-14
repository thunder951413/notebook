import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { NotebookSummary, PageSummary } from '../model'
import type { PageVisitHistory } from '../pageVisitHistory'
import { pageVisitTarget } from '../pageVisitHistory'

export interface PageNavigationOptions {
  accessiblePages: PageSummary[]
  accessibleTrashPages: PageSummary[]
  accessibleDocumentPageIds: Set<string>
  activeArea: string
  activeSection: string
  navigationOpen: boolean
  pageHistory: PageVisitHistory
  notebooks: NotebookSummary[]
  setActiveArea: Dispatch<SetStateAction<string>>
  setActivePage: Dispatch<SetStateAction<string>>
  setActiveSection: Dispatch<SetStateAction<string>>
  setActiveNotebook: Dispatch<SetStateAction<string>>
  setExpandedNotebook: Dispatch<SetStateAction<string | undefined>>
  setNavOpen: Dispatch<SetStateAction<boolean>>
  setPagesOpen: Dispatch<SetStateAction<boolean>>
  setQuery: Dispatch<SetStateAction<string>>
  setPageHistory: Dispatch<SetStateAction<PageVisitHistory>>
  setExpandedPageIds: Dispatch<SetStateAction<Set<string>>>
  /** Lets compact layouts close their drawer or switch to the editor. */
  onPageActivated?: () => void
}

/**
 * Navigation actions shared by the rail, page tree, history buttons and the
 * command palette. All of them resolve a target page through the accessible
 * page set and keep notebook/section/page state consistent.
 *
 * Callbacks read the latest options through a ref so their identity stays
 * stable across renders; tree rows and rail buttons can therefore be memoized.
 */
export function usePageNavigation(options: PageNavigationOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const historyNavigationTarget = useRef<string | undefined>(undefined)

  const selectArea = useCallback((area: 'notes' | 'tasks' | 'trash') => {
    const current = optionsRef.current
    current.setActiveArea(area)
    current.setQuery('')
    if (area === 'notes') {
      const firstPage = current.accessiblePages.find((page) => page.kind !== 'task' && page.sectionId === current.activeSection)
      if (firstPage) current.setActivePage(firstPage.id)
      return
    }
    if (area === 'tasks') {
      current.setPagesOpen(true)
      const firstTask = current.accessiblePages.find((page) => page.kind === 'task')
      if (firstTask) current.setActivePage(firstTask.id)
      return
    }
    current.setPagesOpen(true)
    if (current.accessibleTrashPages[0]) current.setActivePage(current.accessibleTrashPages[0].id)
  }, [])

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

  const openRecentPage = useCallback((pageId: string) => {
    const current = optionsRef.current
    const page = current.accessiblePages.find((candidate) => candidate.id === pageId)
    if (!page) return
    const notebook = current.notebooks.find((candidate) => candidate.sections.some((section) => section.id === page.sectionId))
    current.setActiveArea('notes')
    current.setActivePage(page.id)
    current.setActiveSection(page.sectionId)
    if (notebook) { current.setActiveNotebook(notebook.id); current.setExpandedNotebook(notebook.id) }
  }, [])

  const navigatePageHistory = useCallback((direction: -1 | 1) => {
    const current = optionsRef.current
    const result = pageVisitTarget(current.pageHistory, direction, (pageId) => current.accessibleDocumentPageIds.has(pageId))
    if (!result.pageId) return
    historyNavigationTarget.current = result.pageId
    current.setPageHistory(result.history)
    openRecentPage(result.pageId)
  }, [openRecentPage])

  const activateTreePage = useCallback((page: PageSummary, hasChildren: boolean, _closeOnNarrow: 'navigation' | 'pages') => {
    const current = optionsRef.current
    // A page from the notebook tree is a note, even when To-dos or Trash was
    // the last thing selected; otherwise the editor kept showing the To-dos
    // placeholder ("选择一项待办").
    current.setActiveArea('notes')
    current.setActivePage(page.id)
    current.setActiveSection(page.sectionId)
    const owner = current.notebooks.find((notebook) => notebook.sections.some((section) => section.id === page.sectionId))
    if (owner) {
      current.setActiveNotebook(owner.id)
      current.setExpandedNotebook(owner.id)
    }
    if (hasChildren) {
      current.setExpandedPageIds((currentIds) => currentIds.has(page.id) ? currentIds : new Set([...currentIds, page.id]))
    }
    current.onPageActivated?.()
  }, [])

  return { selectArea, toggleNavigation, openRecentPage, navigatePageHistory, activateTreePage, historyNavigationTarget }
}
