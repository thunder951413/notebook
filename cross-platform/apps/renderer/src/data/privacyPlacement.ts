import type { Notebook, Page, Section } from '@notebook/domain'

export function lockedForSection(sectionId: string | undefined, sections: Section[], notebooks: Notebook[]): boolean | undefined {
  if (!sectionId) return undefined
  const notebookId = sections.find((section) => section.id === sectionId)?.notebookId
  if (!notebookId) return undefined
  return notebooks.find((notebook) => notebook.id === notebookId)?.locked ? true : undefined
}

export function planPagePrivacyNormalization(pages: Page[], sections: Section[], notebooks: Notebook[], changedAt: string): Page[] {
  const knownSectionIds = new Set(sections.map((section) => section.id))
  return pages.flatMap((page) => {
    if (!page.sectionId || !knownSectionIds.has(page.sectionId)) return []
    const locked = lockedForSection(page.sectionId, sections, notebooks)
    if (Boolean(page.locked) === Boolean(locked)) return []
    return [{
      ...page,
      locked,
      treeUpdatedAt: changedAt,
      syncStatus: page.syncStatus === 'conflict' ? 'conflict' as const : 'pending' as const,
    }]
  })
}
