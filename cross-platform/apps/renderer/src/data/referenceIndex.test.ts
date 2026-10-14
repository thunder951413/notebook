import { describe, expect, test } from 'vitest'
import { pageLinksFromMarkdown } from './referenceIndex'

describe('derived backlink index', () => {
  test('keeps separate page, block, range, link and embed occurrences', () => {
    const links = pageLinksFromMarkdown('source', [
      '[[page:target]]',
      '[[page:target#^b-one]]',
      '[[page:target#^b-two]]',
      '[[page:target#group:g-one]]',
      '![[page:target#^b-one]]',
    ].join('\n\n'), '2026-07-23T00:00:00.000Z')

    expect(links).toHaveLength(5)
    expect(links.map((link) => `${link.kind}:${link.excerpt ?? 'page'}`)).toEqual([
      'link:page',
      'link:block:b-one',
      'link:block:b-two',
      'link:group:g-one',
      'embed:block:b-one',
    ])
    expect(new Set(links.map((link) => link.id))).toHaveLength(5)
  })

  test('deduplicates the same semantic target within one source page', () => {
    const links = pageLinksFromMarkdown('source', '[[page:target#^b-one]] 和 [[page:target#^b-one|固定文本]]', 'now')
    expect(links).toHaveLength(1)
  })
})

describe('title links in the derived index', () => {
  test('resolves [[title]] once per target and skips unresolved and self links', () => {
    const titles: Record<string, string> = { 会议记录: 'meeting', 产品愿景: 'source' }
    const links = pageLinksFromMarkdown('source', '见 [[会议记录]]，再见 [[会议记录|会议]]、[[不存在]] 和 [[产品愿景]]。', 'now', (title) => titles[title])
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ id: 'markdown-title-link:source:meeting', sourcePageId: 'source', targetPageId: 'meeting', kind: 'link' })
    expect(links[0]!.excerpt).toContain('[[会议记录]]')
  })
})
