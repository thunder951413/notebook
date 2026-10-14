import { describe, expect, test } from 'vitest'
import type { PlanGroup } from './organize'
import { applyPlan, type PlanApi } from './organizeApply'

function fakeApi(updatedAt: Record<string, string>) {
  const calls: string[] = []
  let next = 0
  const api: PlanApi = {
    pageUpdatedAt: async (id) => updatedAt[id],
    createPage: async (title) => { const id = `real-${++next}`; calls.push(`create ${title} → ${id}`); return id },
    updatePage: async (id, change) => { calls.push(`update ${id} ${change.markdown ?? ''}`) },
    movePage: async (id, _section, parent) => { calls.push(`move ${id} → ${parent ?? 'top'}`) },
    setTags: async (id, tags) => { calls.push(`tags ${id} ${tags.join(',')}`) },
    trash: async (id) => { calls.push(`trash ${id}`) },
    snapshot: async (id) => { calls.push(`snapshot ${id}`) },
  }
  return { api, calls }
}

const group = (id: string, ops: PlanGroup['ops'], before: PlanGroup['before'] = []): PlanGroup => ({ id, kind: 'merge', title: id, ops, before, after: [] })

describe('applying a plan', () => {
  test('creates before moving into new folders, resolves split links, trashes last', async () => {
    const { api, calls } = fakeApi({ a: 't1', s: 't2' })
    const outcome = await applyPlan([
      group('folder', [
        { kind: 'trash', pageId: 'a', expectedUpdatedAt: 't1' },
        { kind: 'move', pageId: 'child', location: { sectionId: 's1', parentRef: 'f', sortOrder: 1 } },
        { kind: 'create', ref: 'f', title: '目录', markdown: '', location: { sectionId: 's1', parentPageId: 'root', sortOrder: 1 } },
      ]),
      group('split', [
        { kind: 'create', ref: 'p1', title: '部分一', markdown: 'x', location: { sectionId: 's1', parentPageId: 's', sortOrder: 1 } },
        { kind: 'update', pageId: 's', expectedUpdatedAt: 't2', markdown: '- [[page:{{notebook-ref:p1}}|部分一]]' },
        { kind: 'tags', pageId: 's', tags: ['甲'] },
      ]),
    ], api)
    expect(outcome.failed).toEqual([])
    expect(outcome.applied).toEqual(['folder', 'split'])
    expect(calls).toEqual([
      'create 目录 → real-1', 'move real-1 → root',
      'create 部分一 → real-2', 'move real-2 → s',
      'snapshot s', 'update s - [[page:real-2|部分一]]',
      'move child → real-1',
      'tags s 甲',
      'trash a',
    ])
  })

  test('a group whose note changed since the plan is skipped', async () => {
    const { api, calls } = fakeApi({ n: 'changed' })
    const outcome = await applyPlan([group('rewrite', [{ kind: 'update', pageId: 'n', expectedUpdatedAt: 'old', markdown: '新' }], [{ key: 'n', title: '笔记', markdown: '旧' }])], api)
    expect(outcome.applied).toEqual([])
    expect(outcome.failed[0]!.message).toContain('“笔记”在生成方案后被修改过')
    expect(calls).toEqual([])
  })
})
