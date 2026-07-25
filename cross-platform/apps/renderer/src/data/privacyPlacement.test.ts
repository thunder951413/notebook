import { describe, expect, test } from 'vitest'
import type { Notebook, Page, Section } from '@notebook/domain'
import { lockedForSection, planPagePrivacyNormalization } from './privacyPlacement'

const timestamps = { createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z' }
const notebooks: Notebook[] = [
  { id: 'public', workspaceId: 'workspace', name: '普通', sortOrder: 0, ...timestamps },
  { id: 'private', workspaceId: 'workspace', name: '隐私', sortOrder: 1, locked: true, ...timestamps },
]
const sections: Section[] = [
  { id: 'public-section', notebookId: 'public', name: '公开', sortOrder: 0, ...timestamps },
  { id: 'private-section', notebookId: 'private', name: '隐私', sortOrder: 0, ...timestamps },
]
const page = (id: string, sectionId: string, locked?: boolean): Page => ({
  id,
  workspaceId: 'workspace',
  sectionId,
  kind: 'document',
  title: id,
  preview: '',
  favorite: false,
  syncStatus: 'synced',
  locked,
  ...timestamps,
})

describe('page privacy follows the owning notebook', () => {
  test('derives privacy from section ownership rather than stale page flags', () => {
    expect(lockedForSection('public-section', sections, notebooks)).toBeUndefined()
    expect(lockedForSection('private-section', sections, notebooks)).toBe(true)
  })

  test('unlocks every stale child moved into a public notebook and locks public flags moved into privacy', () => {
    const changedAt = '2026-07-25T01:00:00.000Z'
    const normalized = planPagePrivacyNormalization([
      page('public-parent', 'public-section'),
      { ...page('stale-child-1', 'public-section', true), parentPageId: 'public-parent' },
      { ...page('stale-child-2', 'public-section', true), parentPageId: 'public-parent' },
      page('stale-private', 'private-section'),
    ], sections, notebooks, changedAt)

    expect(normalized.map((item) => [item.id, item.locked])).toEqual([
      ['stale-child-1', undefined],
      ['stale-child-2', undefined],
      ['stale-private', true],
    ])
    expect(normalized.every((item) => item.treeUpdatedAt === changedAt && item.syncStatus === 'pending')).toBe(true)
  })

  test('does not rewrite already consistent or orphaned records', () => {
    expect(planPagePrivacyNormalization([
      page('public-page', 'public-section'),
      page('private-page', 'private-section', true),
      page('orphan', 'missing', true),
    ], sections, notebooks, 'now')).toEqual([])
  })
})
