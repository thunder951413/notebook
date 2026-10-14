import { describe, expect, test } from 'vitest'
import type { Page } from '@notebook/domain'
import { restoreBatchIds } from './workspaceStore'

const page = (id: string, parentPageId: string | undefined, deletedAt: string): Page => ({ id, workspaceId: 'w', sectionId: 's', parentPageId, kind: 'document', title: id, preview: '', favorite: false, createdAt: deletedAt, updatedAt: deletedAt, syncStatus: 'synced', deletedAt })

describe('restoring from the trash', () => {
  test('brings back the pages trashed together, not ones deleted earlier', () => {
    const trash = [
      page('p', undefined, '2026-10-14T05:00:00Z'),
      page('c1', 'p', '2026-10-14T05:00:00Z'),
      page('g', 'c1', '2026-10-14T05:00:00Z'),
      page('old', 'p', '2026-10-01T00:00:00Z'),
      page('old-child', 'old', '2026-10-01T00:00:00Z'),
    ]
    expect(restoreBatchIds(trash, 'p').sort()).toEqual(['c1', 'g', 'p'])
    expect(restoreBatchIds(trash, 'old').sort()).toEqual(['old', 'old-child'])
  })
})
