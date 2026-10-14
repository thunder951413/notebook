import { useCallback } from 'react'
import type { Notebook, Page, Section } from '@notebook/domain'
import { legacyDeviceId } from '../sync/legacySshSettings'
import { notebookRootSectionId, withoutNotebookRootMarker } from './notebookPageRoots'
import { lockedForSection } from './privacyPlacement'
import { WORKSPACE_ID, enqueuePageMutation, repository, treePageIds } from './workspaceStore'

/** Moving pages within and between notebooks (tree drag and drop, top-level reordering). */
export function usePageTreeMoves({ notebookRecords, sectionRecords, pageRecords, reload }: { notebookRecords: Notebook[]; sectionRecords: Section[]; pageRecords: Page[]; reload: () => Promise<void> }) {
  const movePageInTree = useCallback(async (pageId: string, sectionId: string, parentPageId: string | undefined, sortOrder: number) => {
    await enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page) throw new Error(`Page not found: ${pageId}`)
      if (parentPageId === pageId) throw new Error('页面不能成为自己的子页面')
      const livePages = pageRecords.filter((item) => !item.deletedAt)
      let cursor = parentPageId
      const seen = new Set<string>()
      while (cursor) {
        if (cursor === pageId) throw new Error('不能把父页面移动到自己的子页面下')
        if (seen.has(cursor)) throw new Error('检测到无效的页面循环')
        seen.add(cursor)
        cursor = livePages.find((item) => item.id === cursor)?.parentPageId
      }
      const now = new Date().toISOString()
      const rootSectionId = notebookRootSectionId(page)
      const targetLocked = lockedForSection(sectionId, sectionRecords, notebookRecords)
      await repository.savePage({
        ...page,
        sectionId,
        locked: targetLocked,
        parentPageId,
        sortOrder,
        treeUpdatedAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        legacyMetadata: rootSectionId ? withoutNotebookRootMarker(page.legacyMetadata) : page.legacyMetadata,
      })
      if (page.sectionId !== sectionId) {
        const subtreeIds = new Set(treePageIds(livePages, pageId).slice(1))
        // A top-level page owns a transparent legacy Section. When it becomes
        // a child, move every remaining record (including tasks) out before
        // deleting that now-empty compatibility bucket.
        if (rootSectionId) {
          for (const item of livePages) {
            if (item.sectionId === rootSectionId && item.id !== pageId) subtreeIds.add(item.id)
          }
        }
        for (const descendantId of subtreeIds) {
          const descendant = livePages.find((item) => item.id === descendantId)
          if (descendant) await repository.savePage({ ...descendant, sectionId, locked: targetLocked, treeUpdatedAt: now, updatedAt: now, syncStatus: 'pending' })
        }
        if (rootSectionId) await repository.deleteSection(rootSectionId, now, legacyDeviceId())
      }
      await reload()
    })
  }, [notebookRecords, pageRecords, reload, sectionRecords])

  const promotePageToNotebookRoot = useCallback(async (pageId: string, targetRootPageId?: string, position: 'before' | 'after' = 'after') => {
    return enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page || page.deletedAt) throw new Error('找不到要提升的页面')
      const sourceSection = sectionRecords.find((item) => item.id === page.sectionId)
      if (!sourceSection) throw new Error('页面不属于有效笔记本')
      const targetRoot = targetRootPageId ? pageRecords.find((item) => item.id === targetRootPageId) : undefined
      const targetSection = targetRoot ? sectionRecords.find((item) => item.id === targetRoot.sectionId) : undefined
      const notebookId = targetSection?.notebookId ?? sourceSection.notebookId
      const notebookSections = sectionRecords
        .filter((item) => item.notebookId === notebookId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
      const targetIndex = targetSection ? notebookSections.findIndex((item) => item.id === targetSection.id) : -1
      const insertionIndex = targetIndex < 0 ? notebookSections.length : targetIndex + (position === 'after' ? 1 : 0)
      const previousOrder = notebookSections[insertionIndex - 1]?.sortOrder
      const nextOrder = notebookSections[insertionIndex]?.sortOrder
      const sectionOrder = previousOrder !== undefined && nextOrder !== undefined ? (previousOrder + nextOrder) / 2
        : previousOrder !== undefined ? previousOrder + 1
          : nextOrder !== undefined ? nextOrder - 1
            : 0
      const now = new Date().toISOString()
      const targetLocked = notebookRecords.find((item) => item.id === notebookId)?.locked ? true : undefined
      const section: Section = {
        id: crypto.randomUUID(),
        notebookId,
        name: page.title,
        color: sourceSection.color,
        sortOrder: sectionOrder,
        createdAt: now,
        updatedAt: now,
      }
      await repository.saveSection(section)
      const descendants = treePageIds(pageRecords.filter((item) => !item.deletedAt), pageId).slice(1)
      await repository.savePage({
        ...page,
        sectionId: section.id,
        locked: targetLocked,
        parentPageId: undefined,
        treeUpdatedAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        legacyMetadata: {
          ...withoutNotebookRootMarker(page.legacyMetadata),
          notebookRootSectionId: section.id,
        },
      })
      for (const descendantId of descendants) {
        const descendant = pageRecords.find((item) => item.id === descendantId)
        if (descendant) await repository.savePage({ ...descendant, sectionId: section.id, locked: targetLocked, treeUpdatedAt: now, updatedAt: now, syncStatus: 'pending' })
      }
      await reload()
      return section.id
    })
  }, [notebookRecords, pageRecords, reload, sectionRecords])

  const reorderNotebookRoot = useCallback(async (pageId: string, targetRootPageId: string, position: 'before' | 'after') => {
    const page = await repository.getPage(pageId)
    const target = await repository.getPage(targetRootPageId)
    const sourceSectionId = page ? notebookRootSectionId(page) : undefined
    const targetSectionId = target ? notebookRootSectionId(target) : undefined
    if (!page || !target || !sourceSectionId || !targetSectionId || sourceSectionId === targetSectionId) return page?.sectionId
    const sourceSection = sectionRecords.find((item) => item.id === sourceSectionId)
    const targetSection = sectionRecords.find((item) => item.id === targetSectionId)
    if (!sourceSection || !targetSection) throw new Error('顶层页面位置无效')
    const siblings = sectionRecords
      .filter((item) => item.notebookId === targetSection.notebookId && item.id !== sourceSection.id)
      .sort((left, right) => left.sortOrder - right.sortOrder)
    const targetIndex = siblings.findIndex((item) => item.id === targetSection.id)
    const insertionIndex = Math.max(0, targetIndex + (position === 'after' ? 1 : 0))
    const previousOrder = siblings[insertionIndex - 1]?.sortOrder
    const nextOrder = siblings[insertionIndex]?.sortOrder
    const sortOrder = previousOrder !== undefined && nextOrder !== undefined ? (previousOrder + nextOrder) / 2
      : previousOrder !== undefined ? previousOrder + 1
        : nextOrder !== undefined ? nextOrder - 1
          : 0
    const now = new Date().toISOString()
    const targetLocked = notebookRecords.find((item) => item.id === targetSection.notebookId)?.locked ? true : undefined
    await repository.saveSection({ ...sourceSection, notebookId: targetSection.notebookId, sortOrder, updatedAt: now })
    const sectionPages = await repository.listPages({ workspaceId: WORKSPACE_ID, sectionId: sourceSection.id, includeDeleted: true, limit: 500 })
    for (const sectionPage of sectionPages.items) {
      await repository.savePage({
        ...sectionPage,
        locked: targetLocked,
        sortOrder: sectionPage.id === page.id ? sortOrder * 1000 : sectionPage.sortOrder,
        treeUpdatedAt: now,
        updatedAt: sectionPage.id === page.id ? now : sectionPage.updatedAt,
        syncStatus: 'pending',
      })
    }
    await reload()
    return sourceSection.id
  }, [notebookRecords, reload, sectionRecords])

  return { movePageInTree, promotePageToNotebookRoot, reorderNotebookRoot }
}
