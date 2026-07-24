import { describe, expect, it } from 'vitest'
import type { Page, Section } from '@notebook/domain'
import { notebookRootSectionId, planNotebookPageRootMigration, withoutNotebookRootMarker } from './notebookPageRoots'

const section: Section = {
  id: 'section-a',
  notebookId: 'notebook-a',
  name: '顶层页面',
  sortOrder: 2,
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
}
const page = (patch: Partial<Page>): Page => ({
  id: 'page-a',
  workspaceId: 'workspace-a',
  sectionId: section.id,
  kind: 'document',
  title: '原页面',
  preview: '',
  favorite: false,
  createdAt: section.createdAt,
  updatedAt: section.updatedAt,
  syncStatus: 'synced',
  ...patch,
})

describe('notebook page roots', () => {
  it('creates a normal Page root and places former roots below it', () => {
    const child = page({})
    const nested = page({ id: 'nested', parentPageId: child.id })
    const task = page({ id: 'task', kind: 'task' })
    const result = planNotebookPageRootMigration(
      [section],
      [child, nested, task],
      'workspace-a',
      '2026-07-24T01:00:00.000Z',
      () => 'root-a',
    )

    expect(result.roots).toHaveLength(1)
    expect(result.roots[0]).toMatchObject({
      id: 'root-a',
      sectionId: section.id,
      title: section.name,
      kind: 'document',
    })
    expect(result.roots[0]?.parentPageId).toBeUndefined()
    expect(notebookRootSectionId(result.roots[0]!)).toBe(section.id)
    expect(result.reparented).toEqual([expect.objectContaining({ id: child.id, parentPageId: 'root-a' })])
  })

  it('does not recreate a root that is present or intentionally trashed', () => {
    const root = page({
      id: 'root-a',
      deletedAt: '2026-07-24T02:00:00.000Z',
      legacyMetadata: { notebookRootSectionId: section.id },
    })
    expect(planNotebookPageRootMigration([section], [root], 'workspace-a', section.updatedAt, () => 'new-root')).toEqual({
      roots: [],
      reparented: [],
    })
  })

  it('removes only the compatibility marker from a duplicated page', () => {
    expect(withoutNotebookRootMarker({ notebookRootSectionId: section.id, source: 'import' })).toEqual({ source: 'import' })
    expect(withoutNotebookRootMarker({ notebookRootSectionId: section.id })).toBeUndefined()
  })
})
