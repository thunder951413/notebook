import { describe, expect, it } from 'vitest'
import type { Page } from '@notebook/domain'
import { applyPendingPatch, replaceById, withRecords, withoutIds } from './pageState'

const page = (id: string, overrides: Partial<Page> = {}): Page => ({
  id,
  workspaceId: 'workspace',
  sectionId: 'section',
  kind: 'document',
  title: id,
  preview: '',
  favorite: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  syncStatus: 'synced',
  ...overrides,
})

describe('page state mirrors', () => {
  it('locks identity and forces pending on patched pages', () => {
    const patched = applyPendingPatch(page('a'), { title: '新标题', id: 'evil', syncStatus: 'synced' } as Partial<Page>, '2026-01-02T00:00:00.000Z')
    expect(patched.id).toBe('a')
    expect(patched.title).toBe('新标题')
    expect(patched.syncStatus).toBe('pending')
    expect(patched.updatedAt).toBe('2026-01-02T00:00:00.000Z')
    // Untouched fields survive.
    expect(patched.favorite).toBe(false)
  })

  it('replaces exactly one record by id', () => {
    const records = [page('a'), page('b')]
    const next = replaceById(records, page('b', { title: '改了' }))
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(records[0])
    expect(next[1]?.title).toBe('改了')
  })

  it('removes and appends without touching the rest', () => {
    const records = [page('a'), page('b'), page('c')]
    const ids = new Set(['a', 'c'])
    expect(withoutIds(records, ids).map((item) => item.id)).toEqual(['b'])
    expect(withRecords(withoutIds(records, ids), [page('d')]).map((item) => item.id)).toEqual(['b', 'd'])
    // Appending nothing keeps the previous array instance.
    const same = [page('a')]
    expect(withRecords(same, [])).toBe(same)
  })
})
