import { describe, expect, test } from 'vitest'
import type { NotebookSummary, PageSummary } from '../model'
import { categoryGroup, cleanModelMarkdown, compareNotes, mergeGroup, normalizeBlock, parseSplit, parseSuggestions, similarity, splitBlocks, splitGroup, tagGroup, type OrganizeNote } from './organize'

const page = (id: string, title: string, extra: Partial<PageSummary> = {}): PageSummary => ({ id, sectionId: 's1', title, preview: '', updatedLabel: '', tags: [], kind: 'document', updatedAt: '2026-10-14T00:00:00Z', ...extra })
const notebooks = [{ id: 'n1', name: '工作', emoji: '📒', sections: [{ id: 's1', name: '默认', color: '', pageCount: 0 }] }] as NotebookSummary[]
const root = page('root', '工作', { notebookRoot: true })
const pages = [root, page('a', 'uboot 编译', { parentPageId: 'root', sortOrder: 1000, tags: ['驱动'] }), page('b', 'uboot 烧录', { parentPageId: 'root', sortOrder: 2000 }), page('c', '杂记', { parentPageId: 'root', sortOrder: 3000 }), page('c1', '杂记子页', { parentPageId: 'c' })]
const notes: OrganizeNote[] = [
  { index: 1, page: pages[1]!, path: '工作', markdown: '# 步骤\n\n先配置 defconfig\n\n```\nmake -j8\n```' },
  { index: 2, page: pages[2]!, path: '工作', markdown: '用 fastboot 烧录 uboot' },
  { index: 3, page: pages[3]!, path: '工作', markdown: '会议：周五评审\n\n买咖啡豆' },
]
let counter = 0
const context = { pages, notebooks, newId: () => `new-${++counter}` }

describe('suggestions', () => {
  test('parse keeps only valid notes and drops duplicates across categories', () => {
    const parsed = parseSuggestions('```json\n{"categories":[{"name":"uboot","description":"引导","notes":[1,2,9]},{"name":"其他","notes":[2,3]}],"tags":[{"note":1,"add":["uboot"],"remove":[]},{"note":7,"add":["x"]}],"merges":[{"title":"uboot 全流程","notes":[1,2],"reason":"同一件事"},{"title":"x","notes":[1]}],"splits":[{"note":3,"reason":"两件事","parts":[{"title":"会议","summary":""},{"title":"购物","summary":""}]}]}\n```', 3)
    expect(parsed.categories).toEqual([{ name: 'uboot', description: '引导', notes: [1, 2] }, { name: '其他', description: '', notes: [3] }])
    expect(parsed.tags).toEqual([{ note: 1, add: ['uboot'], remove: [] }])
    expect(parsed.merges).toHaveLength(1)
    expect(parsed.splits[0]!.parts.map((part) => part.title)).toEqual(['会议', '购物'])
    expect(parseSuggestions('不是 JSON', 3)).toEqual({ categories: [], tags: [], merges: [], splits: [] })
  })
})

describe('plan groups', () => {
  test('a category becomes a folder where the notes live, with the notes moved in', () => {
    const group = categoryGroup({ name: 'uboot', description: '引导', notes: [1, 2] }, notes, context)!
    expect(group.ops[0]).toMatchObject({ kind: 'create', title: 'uboot', location: { sectionId: 's1', parentPageId: 'root' } })
    const ref = (group.ops[0] as { ref: string }).ref
    expect(group.ops.slice(1)).toMatchObject([{ kind: 'move', pageId: 'a', location: { parentRef: ref } }, { kind: 'move', pageId: 'b', location: { parentRef: ref } }])
    expect(group.after[0]!.location).toBe('工作 / uboot')
  })
  test('an existing folder with the same name is reused', () => {
    const withFolder = { ...context, pages: [...pages, page('f', 'uboot', { parentPageId: 'root' })] }
    const group = categoryGroup({ name: 'uboot', description: '', notes: [1, 2] }, notes, withFolder)!
    expect(group.ops.every((op) => op.kind === 'move' && op.location.parentPageId === 'f')).toBe(true)
  })
  test('tags, merge and split', () => {
    expect(tagGroup({ note: 1, add: ['uboot'], remove: ['驱动'] }, notes, context)!.ops).toEqual([{ kind: 'tags', pageId: 'a', tags: ['uboot'] }])
    expect(tagGroup({ note: 1, add: ['驱动'], remove: [] }, notes, context)).toBeUndefined()
    const merge = mergeGroup({ title: 'uboot', notes: [1, 3], reason: '' }, notes, '合并正文', context)!
    expect(merge.ops.map((op) => op.kind)).toEqual(['create', 'move', 'trash', 'trash'])
    expect(merge.ops[1]).toMatchObject({ pageId: 'c1' })
    const split = splitGroup({ note: 3, reason: '', parts: [] }, notes, { parts: [{ title: '会议', markdown: '会议：周五评审' }, { title: '购物', markdown: '买咖啡豆' }], remainder: '' }, context)!
    expect(split.ops.map((op) => op.kind)).toEqual(['create', 'create', 'update'])
    expect((split.ops[2] as { markdown: string }).markdown).toContain('{{notebook-ref:')
  })
})

describe('model output', () => {
  test('split sections and fenced answers', () => {
    expect(parseSplit('===== 部分：会议 =====\n周五评审\n===== 部分：购物 =====\n买豆子\n===== 剩余内容 =====\n概述')).toEqual({ parts: [{ title: '会议', markdown: '周五评审' }, { title: '购物', markdown: '买豆子' }], remainder: '概述' })
    expect(cleanModelMarkdown('```markdown\n# 标题\n正文\n```', '标题')).toBe('正文')
  })
})

describe('compare', () => {
  test('blocks keep code and list items apart', () => {
    expect(splitBlocks('# A\n段落一\n续行\n\n- 甲\n- 乙\n\n```\nx\n\ny\n```')).toEqual(['# A', '段落一\n续行', '- 甲', '- 乙', '```\nx\n\ny\n```'])
    expect(normalizeBlock('## 标题 [链接](http://x) [[page:1|笔记]]')).toBe('标题链接笔记')
    expect(similarity('先配置defconfig', '先配置defconfig')).toBe(1)
  })
  test('classifies kept, rewritten, scattered, missing and added content', () => {
    const result = compareNotes(
      [{ key: 'a', title: 'A', markdown: '先配置 defconfig 然后编译\n\n用 fastboot 烧录 uboot 到板子上\n\n这一段完全消失了不会再出现' }],
      [{ key: 'm', title: 'M', markdown: '先配置 defconfig 然后编译\n\n使用 fastboot 把 uboot 烧录到板子上\n\n新增的总结段落内容' }],
    )
    expect(result.before.map((block) => block.status)).toEqual(['kept', 'rewritten', 'missing'])
    expect(result.after.map((block) => block.status)).toEqual(['kept', 'rewritten', 'added'])
    expect(result.stats).toMatchObject({ kept: 1, rewritten: 1, missing: 1, added: 1, total: 3 })
  })
})
