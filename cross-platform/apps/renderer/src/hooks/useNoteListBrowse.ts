import { useCallback, useEffect, useMemo } from 'react'
import type { NotebookSummary, PageSummary } from '../model'
import type { ListScope } from '../shell/Sidebar'
import { useDueBannerState } from '../shell/DueBanner'
import { buildSections, createdTime, isEmptyQuery, isOpenTodo, pageMatches, parseSearchQuery, rankSearchHits, tagCounts, todoDigest, updatedTime, type ListOrder, type ListSection } from '../shell/browse'

/**
 * Everything the note list shows, derived from the library and the chosen
 * scope: scoped pages, search hits or dated sections, counts, the to-do
 * digest and the list title. Keeps the Dock badge in step with due to-dos.
 */
export function useNoteListBrowse({ notebooks, accessiblePages, accessibleTrashPages, scope, privacyUnlocked, query, searchAll, notesOrder, tasksOrder, grouped, nowMs, pinyinVersion }: {
  notebooks: NotebookSummary[]
  accessiblePages: PageSummary[]
  accessibleTrashPages: PageSummary[]
  scope: ListScope
  privacyUnlocked: boolean
  query: string
  searchAll: boolean
  notesOrder: ListOrder
  tasksOrder: ListOrder
  grouped: boolean
  nowMs: number
  pinyinVersion: number
}) {
  const notebookBySection = useMemo(() => {
    const map = new Map<string, (typeof notebooks)[number]>()
    for (const notebook of notebooks) for (const section of notebook.sections) map.set(section.id, notebook)
    return map
  }, [notebooks])
  const notebookName = useCallback((page: PageSummary) => notebookBySection.get(page.sectionId)?.name ?? '', [notebookBySection])
  const browseContext = useMemo(() => ({ notebookName }), [notebookName])
  const documentPages = useMemo(() => accessiblePages.filter((page) => page.kind !== 'task'), [accessiblePages])
  const taskPages = useMemo(() => accessiblePages.filter((page) => page.kind === 'task'), [accessiblePages])
  const scopeNotebook = scope.kind === 'notebook' ? notebooks.find((notebook) => notebook.id === scope.id && (!notebook.locked || privacyUnlocked)) : undefined
  const listScope = useMemo<ListScope>(() => scope.kind === 'notebook' && !scopeNotebook ? { kind: 'all' } : scope, [scope, scopeNotebook])
  const scopedPages = useMemo(() => {
    switch (listScope.kind) {
      case 'favorites': return documentPages.filter((page) => page.favorite)
      case 'tasks': return taskPages
      case 'trash': return accessibleTrashPages
      case 'notebook': return documentPages.filter((page) => notebookBySection.get(page.sectionId)?.id === listScope.id)
      case 'tag': return documentPages.filter((page) => page.tags.includes(listScope.name))
      default: return documentPages
    }
  }, [accessibleTrashPages, documentPages, listScope, notebookBySection, taskPages])
  const parsedQuery = useMemo(() => parseSearchQuery(query), [query])
  const searching = !isEmptyQuery(parsedQuery)
  const listOrder: ListOrder = listScope.kind === 'tasks' ? tasksOrder : notesOrder === 'due' ? 'updated' : notesOrder
  const listSections = useMemo<ListSection[]>(() => {
    void pinyinVersion // recompute once the pinyin dictionary has loaded
    if (searching) {
      const everything = [...documentPages, ...taskPages]
      const base = listScope.kind === 'trash' ? accessibleTrashPages : searchAll || listScope.kind === 'all' ? everything : scopedPages
      const hits = rankSearchHits(base.filter((page) => pageMatches(page, parsedQuery, browseContext)), parsedQuery, browseContext)
      return hits.length ? [{ key: 'search', label: `找到 ${hits.length} 项`, pages: hits }] : []
    }
    const pin = listScope.kind === 'all' || listScope.kind === 'notebook' || listScope.kind === 'tag'
    return buildSections(scopedPages, listOrder, { pinFavorites: pin, grouped, now: nowMs })
  }, [accessibleTrashPages, browseContext, documentPages, grouped, listOrder, listScope.kind, nowMs, parsedQuery, pinyinVersion, scopedPages, searchAll, searching, taskPages])
  const listPages = useMemo(() => listSections.flatMap((section) => section.pages), [listSections])
  const listTerms = useMemo(() => parsedQuery.terms, [parsedQuery])
  const listTimeOf = useCallback((page: PageSummary) => listOrder === 'created' ? createdTime(page) : updatedTime(page), [listOrder])
  const tags = useMemo(() => tagCounts(documentPages), [documentPages])
  const digest = useMemo(() => todoDigest(taskPages, nowMs), [nowMs, taskPages])
  const banner = useDueBannerState(nowMs)
  const bannerItems = useMemo(() => digest.attention.filter((page) => !banner.hidden(page)), [banner, digest.attention])
  // Dock badge: actionable todos only (overdue + due today).
  useEffect(() => { void window.notebookDesktop?.badge?.set(digest.badge).catch(() => undefined) }, [digest.badge])

  const scopeTitle = listScope.kind === 'all' ? '全部笔记'
    : listScope.kind === 'favorites' ? '置顶'
    : listScope.kind === 'tasks' ? '待办'
    : listScope.kind === 'trash' ? '回收站'
    : listScope.kind === 'notebook' ? `${scopeNotebook?.emoji ? `${scopeNotebook.emoji} ` : ''}${scopeNotebook?.name ?? '笔记本'}`
    : `#${listScope.name}`
  const openTodoCount = useMemo(() => taskPages.filter(isOpenTodo).length, [taskPages])
  const favoriteCount = useMemo(() => documentPages.filter((page) => page.favorite).length, [documentPages])
  const notebookCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const page of documentPages) {
      const notebookId = notebookBySection.get(page.sectionId)?.id
      if (notebookId) counts.set(notebookId, (counts.get(notebookId) ?? 0) + 1)
    }
    return counts
  }, [documentPages, notebookBySection])
  const scopeSubtitle = searching ? `${listPages.length} 项结果`
    : listScope.kind === 'tasks' ? `${openTodoCount} 项未完成`
    : listScope.kind === 'trash' ? `${scopedPages.length} 项`
    : `${scopedPages.length} 篇`
  return { notebookBySection, notebookName, browseContext, documentPages, taskPages, scopeNotebook, listScope, scopedPages, parsedQuery, searching, listOrder, listSections, listPages, listTerms, listTimeOf, tags, digest, banner, bannerItems, scopeTitle, openTodoCount, favoriteCount, notebookCounts, scopeSubtitle }
}
