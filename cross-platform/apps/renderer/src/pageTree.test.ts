import { describe, expect, it } from 'vitest'
import type { PageSummary } from './model'
import { ancestorsOf, descendantsOf, flattenPageTree } from './pageTree'

const page = (id: string, parentPageId?: string, sortOrder = 1000): PageSummary => ({
  id,
  sectionId: 'section',
  parentPageId,
  sortOrder,
  title: id,
  preview: '',
  updatedLabel: id,
  tags: [],
})

describe('page tree', () => {
  const pages = [
    page('root-b', undefined, 2000),
    page('grandchild', 'child', 1000),
    page('root-a', undefined, 1000),
    page('child', 'root-a', 1000),
  ]

  it('orders roots and only reveals descendants of expanded pages', () => {
    expect(flattenPageTree(pages, new Set()).map(({ page: item, depth }) => [item.id, depth])).toEqual([
      ['root-a', 0],
      ['root-b', 0],
    ])
    expect(flattenPageTree(pages, new Set(['root-a', 'child'])).map(({ page: item, depth }) => [item.id, depth])).toEqual([
      ['root-a', 0],
      ['child', 1],
      ['grandchild', 2],
      ['root-b', 0],
    ])
  })

  it('keeps the ancestor path visible while filtering', () => {
    expect(flattenPageTree(pages, new Set(), new Set(['grandchild'])).map(({ page: item }) => item.id)).toEqual([
      'root-a',
      'child',
      'grandchild',
    ])
  })

  it('finds ancestors and descendants without looping on malformed cycles', () => {
    expect(ancestorsOf(pages, 'grandchild')).toEqual(['root-a', 'child'])
    expect([...descendantsOf(pages, 'root-a')]).toEqual(['child', 'grandchild'])
    const cyclic = [page('one', 'two'), page('two', 'one')]
    expect([...descendantsOf(cyclic, 'one')]).toEqual(['two'])
    expect(flattenPageTree(cyclic, new Set(['one', 'two']))).toEqual([])
  })
})
