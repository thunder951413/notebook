import { useCallback, useRef } from 'react'
import type { Dispatch, DragEvent as ReactDragEvent, SetStateAction } from 'react'
import type { NotebookSummary, PageSummary } from '../model'
import { descendantsOf } from '../pageTree'
import { PAGE_TREE_DRAG_TYPE } from '../persistence/localLayout'
import type { PageTreeDropTarget } from '../components/PageTreeRow'

export interface PageTreeActionOptions {
  accessiblePages: PageSummary[]
  notebooks: NotebookSummary[]
  currentSection: { id: string } | undefined
  currentNotebook: NotebookSummary | undefined
  expandedPageIds: Set<string>
  activePage: string
  pageDropTarget: PageTreeDropTarget | undefined
  createPage: (sectionId: string, kind?: 'document' | 'task', parentPageId?: string) => Promise<string>
  createSection: (notebookId: string, name: string) => Promise<{ sectionId: string; pageId: string }>
  movePageInTree: (pageId: string, sectionId: string, parentPageId: string | undefined, sortOrder: number) => Promise<unknown>
  promotePageToNotebookRoot: (pageId: string, targetRootPageId?: string, position?: 'before' | 'after') => Promise<string>
  reorderNotebookRoot: (pageId: string, targetRootPageId: string, position: 'before' | 'after') => Promise<string | undefined>
  setActivePage: Dispatch<SetStateAction<string>>
  setActiveSection: Dispatch<SetStateAction<string>>
  setActiveNotebook: Dispatch<SetStateAction<string>>
  setExpandedNotebook: Dispatch<SetStateAction<string | undefined>>
  setExpandedPageIds: Dispatch<SetStateAction<Set<string>>>
  setPageDropTarget: Dispatch<SetStateAction<PageTreeDropTarget | undefined>>
  /** Receives failed drag-and-drop moves so hosts can surface them to the user. */
  onMoveError?: (message: string) => void
}

/**
 * Page-tree mutations: expansion, creation, drag-and-drop and subtree moves.
 * Moving a page keeps the hierarchy invariant that a page only stores its
 * parent and sibling order, so moves stay local to the affected siblings.
 *
 * Callbacks read the latest options through a ref so their identity is stable
 * across renders — memoized tree rows would otherwise re-render every time.
 */
export function usePageTreeActions(options: PageTreeActionOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const togglePageExpanded = useCallback((pageId: string) => {
    const { accessiblePages, expandedPageIds, activePage } = optionsRef.current
    const collapsing = expandedPageIds.has(pageId)
    const descendants = descendantsOf(accessiblePages, pageId)
    if (collapsing && descendants.has(activePage)) optionsRef.current.setActivePage(pageId)
    optionsRef.current.setExpandedPageIds((current) => {
      const next = new Set(current)
      if (next.has(pageId)) {
        next.delete(pageId)
        // Descendant expansion state is not useful while its ancestor is
        // collapsed and was the source of the former top-level re-open race.
        for (const id of descendants) next.delete(id)
      }
      else next.add(pageId)
      return next
    })
  }, [])

  const createTreePage = useCallback(async (parentPageId?: string) => {
    const { accessiblePages, currentSection } = optionsRef.current
    const sectionId = parentPageId
      ? accessiblePages.find((page) => page.id === parentPageId)?.sectionId
      : currentSection?.id
    if (!sectionId) return
    const id = await optionsRef.current.createPage(sectionId, 'document', parentPageId)
    optionsRef.current.setActiveSection(sectionId)
    if (parentPageId) optionsRef.current.setExpandedPageIds((current) => new Set([...current, parentPageId]))
    optionsRef.current.setActivePage(id)
  }, [])

  const createTopLevelPage = useCallback(async (name = '无标题页面') => {
    const currentNotebook = optionsRef.current.currentNotebook
    if (!currentNotebook) return
    const created = await optionsRef.current.createSection(currentNotebook.id, name)
    optionsRef.current.setActiveNotebook(currentNotebook.id)
    optionsRef.current.setExpandedNotebook(currentNotebook.id)
    optionsRef.current.setActiveSection(created.sectionId)
    optionsRef.current.setActivePage(created.pageId)
  }, [])

  const setDropPosition = useCallback((event: ReactDragEvent<HTMLElement>, pageId: string) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height)
    optionsRef.current.setPageDropTarget({ id: pageId, position: ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside' })
  }, [])

  const movePageRelative = useCallback(async (sourceId: string, target: PageSummary, position: 'before' | 'inside' | 'after') => {
    const { accessiblePages, notebooks } = optionsRef.current
    if (!sourceId || sourceId === target.id) return
    const source = accessiblePages.find((page) => page.id === sourceId)
    if (!source || descendantsOf(accessiblePages, sourceId).has(target.id)) return
    const targetOwner = notebooks.find((notebook) => notebook.sections.some((section) => section.id === target.sectionId))
    if (source.notebookRoot && target.notebookRoot && position !== 'inside') {
      const sectionId = await optionsRef.current.reorderNotebookRoot(sourceId, target.id, position)
      if (sectionId) optionsRef.current.setActiveSection(sectionId)
      if (targetOwner) { optionsRef.current.setActiveNotebook(targetOwner.id); optionsRef.current.setExpandedNotebook(targetOwner.id) }
      return
    }
    if (!source.notebookRoot && target.notebookRoot && position !== 'inside') {
      const sectionId = await optionsRef.current.promotePageToNotebookRoot(sourceId, target.id, position)
      optionsRef.current.setActiveSection(sectionId)
      if (targetOwner) { optionsRef.current.setActiveNotebook(targetOwner.id); optionsRef.current.setExpandedNotebook(targetOwner.id) }
      return
    }
    const parentPageId = position === 'inside' ? target.id : target.parentPageId
    const sectionId = target.sectionId
    const siblings = accessiblePages
      .filter((page) => page.kind !== 'task' && page.sectionId === sectionId && page.parentPageId === parentPageId && page.id !== sourceId)
      .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.title.localeCompare(right.title, 'zh-CN'))
    let sortOrder: number
    if (position === 'inside') {
      sortOrder = Math.max(0, ...siblings.map((page) => page.sortOrder ?? 0)) + 1000
    } else {
      const targetIndex = siblings.findIndex((page) => page.id === target.id)
      const insertionIndex = Math.max(0, targetIndex + (position === 'after' ? 1 : 0))
      const previous = siblings[insertionIndex - 1]?.sortOrder
      const next = siblings[insertionIndex]?.sortOrder
      sortOrder = previous !== undefined && next !== undefined ? (previous + next) / 2
        : previous !== undefined ? previous + 1000
          : next !== undefined ? next - 1000
            : 1000
    }
    await optionsRef.current.movePageInTree(sourceId, sectionId, parentPageId, sortOrder)
    if (parentPageId) optionsRef.current.setExpandedPageIds((current) => new Set([...current, parentPageId!]))
    optionsRef.current.setActiveSection(sectionId)
    if (targetOwner) { optionsRef.current.setActiveNotebook(targetOwner.id); optionsRef.current.setExpandedNotebook(targetOwner.id) }
  }, [])

  const dropPage = useCallback(async (event: ReactDragEvent<HTMLElement>, target: PageSummary) => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData(PAGE_TREE_DRAG_TYPE)
    const position = optionsRef.current.pageDropTarget?.id === target.id ? optionsRef.current.pageDropTarget.position : 'inside'
    optionsRef.current.setPageDropTarget(undefined)
    try {
      await movePageRelative(sourceId, target, position)
    } catch (error) {
      // A rejected drop used to vanish as an unhandled rejection with no UI
      // feedback; surface it through the same channel as other failures.
      optionsRef.current.onMoveError?.(error instanceof Error ? error.message : '移动页面失败')
    }
  }, [movePageRelative])

  return { togglePageExpanded, createTreePage, createTopLevelPage, setDropPosition, movePageRelative, dropPage }
}
