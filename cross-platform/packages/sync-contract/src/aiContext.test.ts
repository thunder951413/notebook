import { describe, expect, test } from 'vitest'
import { buildAIContextBundle, type AIContextResolvedSource, type NotebookReferenceTarget } from './index'

const sources: Record<string, AIContextResolvedSource> = {
  'page:root': {
    status: 'ready',
    pageId: 'root',
    title: '主文章',
    markdown: '主正文\n\n![[page:embedded]]\n\n[[page:linked]]\n\n![[page:private]]',
  },
  'page:embedded': {
    status: 'ready',
    pageId: 'embedded',
    title: '嵌入文章',
    markdown: '嵌入正文\n\n![[page:root]]',
  },
  'page:linked': {
    status: 'ready',
    pageId: 'linked',
    title: '普通链接文章',
    markdown: '普通链接正文',
  },
  'page:private': {
    status: 'locked',
    pageId: 'private',
    title: '隐私文章',
  },
  'page:blocks#group:two-paragraphs': {
    status: 'ready',
    pageId: 'blocks',
    title: '连续两段',
    markdown: '第一段。\n\n第二段。',
  },
}

function key(target: NotebookReferenceTarget) {
  return target.kind === 'page' ? `page:${target.pageId}` : `page:${target.pageId}#${target.kind}:${target.targetId}`
}

const resolve = async (target: NotebookReferenceTarget) => sources[key(target)]

describe('AI context assembly', () => {
  test('expands explicit embeds by default and protects locked notes and cycles', async () => {
    const bundle = await buildAIContextBundle({ root: { pageId: 'root', kind: 'page' }, resolve })

    expect(bundle.items.map((item) => item.pageId)).toEqual(['root', 'embedded'])
    expect(bundle.items[1]).toMatchObject({ relationship: 'embed', depth: 1 })
    expect(bundle.markdown).toContain('来源：主文章（root）')
    expect(bundle.markdown).toContain('来源：嵌入文章（embedded）')
    expect(bundle.markdown).not.toContain('普通链接正文')
    expect(bundle.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['cycle', 'locked']))
  })

  test('can expand ordinary links when the caller explicitly requests all linked content', async () => {
    const bundle = await buildAIContextBundle({
      root: { pageId: 'root', kind: 'page' },
      resolve,
      policy: { expansion: 'all' },
    })

    expect(bundle.items.some((item) => item.pageId === 'linked' && item.relationship === 'link')).toBe(true)
    expect(bundle.markdown).toContain('普通链接正文')
  })

  test('accepts a block group as the root source', async () => {
    const bundle = await buildAIContextBundle({
      root: { pageId: 'blocks', kind: 'group', targetId: 'two-paragraphs' },
      resolve,
    })

    expect(bundle.items).toHaveLength(1)
    expect(bundle.items[0]?.markdown).toBe('第一段。\n\n第二段。')
    expect(bundle.markdown).toContain('blocks#group:two-paragraphs')
  })

  test('enforces a deterministic content budget', async () => {
    const bundle = await buildAIContextBundle({
      root: { pageId: 'root', kind: 'page' },
      resolve,
      policy: { maxCharacters: 4 },
    })

    expect(bundle.items).toHaveLength(1)
    expect(bundle.items[0]).toMatchObject({ markdown: '主正文\n', truncated: true })
    expect(bundle.totalCharacters).toBe(4)
    expect(bundle.truncated).toBe(true)
    expect(bundle.warnings).toContainEqual(expect.objectContaining({ code: 'budget-limit' }))
  })
})
