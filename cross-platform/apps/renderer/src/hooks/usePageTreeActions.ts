import { useCallback } from 'react'
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
}

/**
 * Page-tree mutations: expansion, creation, drag-and-drop and subtree moves.
 * Moving a page keeps the hierarchy invariant that a page only stores its
 * parent and sibling order, so moves stay local to the affected siblings.
 */
export function usePageTreeActions(options: PageTreeActionOptions) {
  const togglePageExpanded = useCallback((pageId: string) => {
    const collapsing = options.expandedPageIds.has(pageId)
    const descendants = descendantsOf(options.accessiblePages, pageId)
    if (collapsing && descendants.has(options.activePage)) options.setActivePage(pageId)
    options.setExpandedPageIds((current) => {
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
  }, [options])

  const createTreePage = useCallback(async (parentPageId?: string) => {
    const sectionId = parentPageId
      ? options.accessiblePages.find((page) => page.id === parentPageId)?.sectionId
      : options.currentSection?.id
    if (!sectionId) return
    const id = await options.createPage(sectionId, 'document', parentPageId)
    options.setActiveSection(sectionId)
    if (parentPageId) options.setExpandedPageIds((current) => new Set([...current, parentPageId]))
    options.setActivePage(id)
  }, [options])

  const createTopLevelPage = useCallback(async (name = '无标题页面') => {
    if (!options.currentNotebook) return
    const created = await options.createSection(options.currentNotebook.id, name)
    options.setActiveNotebook(options.currentNotebook.id)
    options.setExpandedNotebook(options.currentNotebook.id)
    options.setActiveSection(created.sectionId)
    options.setActivePage(created.pageId)
  }, [options])

  const setDropPosition = useCallback((event: ReactDragEvent<HTMLElement>, pageId: string) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height)
    options.setPageDropTarget({ id: pageId, position: ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside' })
  }, [options])

  const movePageRelative = useCallback(async (sourceId: string, target: PageSummary, position: 'before' | 'inside' | 'after') => {
    if (!sourceId || sourceId === target.id) return
    const source = options.accessiblePages.find((page) => page.id === sourceId)
    if (!source || descendantsOf(options.accessiblePages, sourceId).has(target.id)) return
    const targetOwner = options.notebooks.find((notebook) => notebook.sections.some((section) => section.id === target.sectionId))
    if (source.notebookRoot && target.notebookRoot && position !== 'inside') {
      const sectionId = await options.reorderNotebookRoot(sourceId, target.id, position)
      if (sectionId) options.setActiveSection(sectionId)
      if (targetOwner) { options.setActiveNotebook(targetOwner.id); options.setExpandedNotebook(targetOwner.id) }
      return
    }
    if (!source.notebookRoot && target.notebookRoot && position !== 'inside') {
      const sectionId = await options.promotePageToNotebookRoot(sourceId, target.id, position)
      options.setActiveSection(sectionId)
      if (targetOwner) { options.setActiveNotebook(targetOwner.id); options.setExpandedNotebook(targetOwner.id) }
      return
    }
    const parentPageId = position === 'inside' ? target.id : target.parentPageId
    const sectionId = target.sectionId
    const siblings = options.accessiblePages
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
    await options.movePageInTree(sourceId, sectionId, parentPageId, sortOrder)
    if (parentPageId) options.setExpandedPageIds((current) => new Set([...current, parentPageId!]))
    options.setActiveSection(sectionId)
    if (targetOwner) { options.setActiveNotebook(targetOwner.id); options.setExpandedNotebook(targetOwner.id) }
  }, [options])

  const dropPage = useCallback(async (event: ReactDragEvent<HTMLElement>, target: PageSummary) => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData(PAGE_TREE_DRAG_TYPE)
    const position = options.pageDropTarget?.id === target.id ? options.pageDropTarget.position : 'inside'
    options.setPageDropTarget(undefined)
    await movePageRelative(sourceId, target, position)
  }, [movePageRelative, options])

  return { togglePageExpanded, createTreePage, createTopLevelPage, setDropPosition, movePageRelative, dropPage }
}
