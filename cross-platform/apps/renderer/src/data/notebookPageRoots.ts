import type { Page, Section } from '@notebook/domain'

export const NOTEBOOK_ROOT_SECTION_KEY = 'notebookRootSectionId'

export function notebookRootSectionId(page: Pick<Page, 'legacyMetadata'>) {
  const value = page.legacyMetadata?.notebookRootSectionId
  return typeof value === 'string' && value ? value : undefined
}

export function withoutNotebookRootMarker(metadata: Page['legacyMetadata']) {
  if (!metadata || !(NOTEBOOK_ROOT_SECTION_KEY in metadata)) return metadata
  const next = { ...metadata }
  delete next[NOTEBOOK_ROOT_SECTION_KEY]
  return Object.keys(next).length ? next : undefined
}

export interface NotebookPageRootMigration {
  roots: Page[]
  reparented: Page[]
}

/**
 * Converts the former visible Section level into ordinary root pages.
 *
 * Sections remain as transparent compatibility buckets for the existing
 * Android/SSH contract. In the product model every returned root is a normal
 * Page whose visible parent is the notebook.
 */
export function planNotebookPageRootMigration(
  sections: Section[],
  pages: Page[],
  workspaceId: string,
  now: string,
  createId: () => string,
): NotebookPageRootMigration {
  const roots: Page[] = []
  const reparented: Page[] = []

  for (const section of sections) {
    const existingRoot = pages.find((page) => notebookRootSectionId(page) === section.id)
    // A trashed root is intentional and must not be recreated. Restoring the
    // page restores the complete subtree.
    if (existingRoot) continue

    const root: Page = {
      id: createId(),
      workspaceId,
      sectionId: section.id,
      sortOrder: section.sortOrder * 1000,
      treeUpdatedAt: now,
      kind: 'document',
      title: section.name,
      preview: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending',
      legacyMetadata: { [NOTEBOOK_ROOT_SECTION_KEY]: section.id },
    }
    roots.push(root)

    for (const page of pages) {
      if (page.deletedAt || page.kind === 'task' || page.sectionId !== section.id || page.parentPageId) continue
      reparented.push({
        ...page,
        parentPageId: root.id,
        treeUpdatedAt: now,
        updatedAt: now,
        syncStatus: 'pending',
      })
    }
  }

  return { roots, reparented }
}
