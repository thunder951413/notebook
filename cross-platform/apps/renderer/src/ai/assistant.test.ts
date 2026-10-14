import { describe, expect, test } from 'vitest'
import type { NotebookSummary, PageSummary } from '../model'
import { citedSources, emptyScope, mergedMarkdown, numberedContext, pagePath, parseSearchResults, resolveScope, scopeLabel, shiftHeadings } from './assistant'

const page = (id: string, title: string, extra: Partial<PageSummary> = {}): PageSummary => ({ id, sectionId: 's1', title, preview: '', updatedLabel: '', tags: [], kind: 'document', ...extra })
const notebooks: NotebookSummary[] = [
  { id: 'n1', name: '工作', emoji: '📒', sections: [{ id: 's1', name: '默认' } as NotebookSummary['sections'][number]] },
  { id: 'n2', name: '生活', emoji: '📒', sections: [{ id: 's2', name: '默认' } as NotebookSummary['sections'][number]] },
]
const pages = [
  page('a', '模块手册', { sortOrder: 1 }),
  page('a1', 'uboot', { parentPageId: 'a', sortOrder: 1 }),
  page('a2', 'drm', { parentPageId: 'a', sortOrder: 2, tags: ['驱动'] }),
  page('a11', '编译', { parentPageId: 'a1', sortOrder: 1 }),
  page('b', '入职', { sortOrder: 2 }),
  page('secret', '密码', { sortOrder: 3, locked: true }),
  page('t', '买菜', { sortOrder: 4, kind: 'task' }),
  page('c', '旅行', { sectionId: 's2' }),
]

describe('assistant scope', () => {
  test('a picked page includes everything below it, in tree order', () => {
    expect(resolveScope({ ...emptyScope(), pageIds: ['a'] }, pages, notebooks).map((item) => item.id)).toEqual(['a', 'a1', 'a11', 'a2'])
  })
  test('notebooks, tags and extra pages combine; tasks and private notes are left out', () => {
    expect(resolveScope({ ...emptyScope(), notebookIds: ['n2'], tagNames: ['驱动'], extraPageIds: ['b', 'secret', 't'] }, pages, notebooks).map((item) => item.id)).toEqual(['a2', 'b', 'c'])
    expect(resolveScope({ ...emptyScope(), notebookIds: ['n1'] }, pages, notebooks, true).map((item) => item.id)).toContain('secret')
  })
  test('labels and paths', () => {
    expect(pagePath(pages[3]!, pages, notebooks)).toBe('工作 / 模块手册 / uboot')
    expect(scopeLabel({ ...emptyScope(), notebookIds: ['n1'], tagNames: ['驱动'] }, pages, notebooks)).toBe('工作、#驱动')
  })
})

describe('merging and prompts', () => {
  test('headings shift down one level outside code blocks', () => {
    expect(shiftHeadings('# A\n```\n# not a heading\n```\n###### F')).toBe('## A\n```\n# not a heading\n```\n###### F')
  })
  test('merged Markdown has one section per note with its location', () => {
    const text = mergedMarkdown([{ page: pages[1]!, path: '工作 / 模块手册', markdown: '# 步骤\n内容' }], '合并')
    expect(text).toBe('# 合并\n\n## uboot\n\n> 工作 / 模块手册\n\n## 步骤\n内容\n')
  })
  test('numbered sources stay within the budget and reuse numbers per note', () => {
    const context = numberedContext([
      { pageId: 'a', title: 'A', path: 'p', markdown: 'x'.repeat(300) },
      { pageId: 'a', title: 'A', path: 'p', markdown: 'y'.repeat(300) },
      { pageId: 'b', title: 'B', path: 'p', markdown: 'z'.repeat(5_000) },
    ], 1_000)
    expect(context.sources.map((source) => source.index)).toEqual([1, 2])
    expect(context.truncated).toBe(true)
    expect(context.text.startsWith('[1] A（p）')).toBe(true)
  })
  test('citations and search results are parsed', () => {
    expect(citedSources('见 [2] 和 [1][2]，以及 [10]')).toEqual([1, 2, 10])
    expect(parseSearchResults('结果：{"results":[{"index":3,"reason":"讲编译"},{"index":"x"}]}')).toEqual([{ index: 3, reason: '讲编译' }])
    expect(parseSearchResults('无法解析')).toEqual([])
  })
})
