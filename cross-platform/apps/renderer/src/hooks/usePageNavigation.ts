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
}

/**
 * Navigation actions shared by the rail, page tree, history buttons and the
 * command palette. All of them resolve a target page through the accessible
 * page set and keep notebook/section/page state consistent.
 */
export function usePageNavigation(options: PageNavigationOptions) {
  const historyNavigationTarget = useRef<string | undefined>(undefined)

  const selectArea = useCallback((area: 'notes' | 'tasks' | 'trash') => {
    options.setActiveArea(area)
    options.setQuery('')
    if (area === 'notes') {
      const firstPage = options.accessiblePages.find((page) => page.kind !== 'task' && page.sectionId === options.activeSection)
      if (firstPage) options.setActivePage(firstPage.id)
      return
    }
    if (area === 'tasks') {
      options.setPagesOpen(true)
      const firstTask = options.accessiblePages.find((page) => page.kind === 'task')
      if (firstTask) options.setActivePage(firstTask.id)
      return
    }
    options.setPagesOpen(true)
    if (options.accessibleTrashPages[0]) options.setActivePage(options.accessibleTrashPages[0].id)
  }, [options])

  const toggleNavigation = useCallback(() => {
    if (options.navigationOpen) {
      options.setNavOpen(false)
      options.setPagesOpen(false)
      return
    }
    options.setPagesOpen(true)
    if (options.activeArea === 'notes') options.setNavOpen(true)
  }, [options])

  const openRecentPage = useCallback((pageId: string) => {
    const page = options.accessiblePages.find((candidate) => candidate.id === pageId)
    if (!page) return
    const notebook = options.notebooks.find((candidate) => candidate.sections.some((section) => section.id === page.sectionId))
    options.setActiveArea('notes')
    options.setActivePage(page.id)
    options.setActiveSection(page.sectionId)
    if (notebook) { options.setActiveNotebook(notebook.id); options.setExpandedNotebook(notebook.id) }
  }, [options])

  const navigatePageHistory = useCallback((direction: -1 | 1) => {
    const result = pageVisitTarget(options.pageHistory, direction, (pageId) => options.accessibleDocumentPageIds.has(pageId))
    if (!result.pageId) return
    historyNavigationTarget.current = result.pageId
    options.setPageHistory(result.history)
    openRecentPage(result.pageId)
  }, [openRecentPage, options])

  const activateTreePage = useCallback((page: PageSummary, hasChildren: boolean, closeOnNarrow: 'navigation' | 'pages') => {
    options.setActivePage(page.id)
    options.setActiveSection(page.sectionId)
    const owner = options.notebooks.find((notebook) => notebook.sections.some((section) => section.id === page.sectionId))
    if (owner) {
      options.setActiveNotebook(owner.id)
      options.setExpandedNotebook(owner.id)
    }
    if (hasChildren) {
      options.setExpandedPageIds((current) => current.has(page.id) ? current : new Set([...current, page.id]))
    }
    if (!window.matchMedia('(max-width: 680px)').matches) return
    if (closeOnNarrow === 'navigation') options.setNavOpen(false)
    options.setPagesOpen(false)
  }, [options])

  return { selectArea, toggleNavigation, openRecentPage, navigatePageHistory, activateTreePage, historyNavigationTarget }
}
