import { describe, expect, test } from 'vitest'
import { extractNotebookReferences, extractWikiLinks, formatWikiLink, isLinkableTitle, markdownToTiptap, normalizeWikiTitle, renameWikiLinks, tiptapToMarkdown, wikiLinkContext } from './index'

describe('title links [[标题]]', () => {
  test('extracts titles and aliases, ignoring id references and code', () => {
    const markdown = [
      '参见 [[会议记录]] 与 [[ 产品 愿景 |愿景]]，以及 [[page:abc|旧式]]。',
      '',
      '`[[行内代码]]` 不算，',
      '',
      '```',
      '[[代码块]]',
      '```',
      '',
      '空的 [[]] 和 [[a',
      'b]] 也不算。',
    ].join('\n')
    const links = extractWikiLinks(markdown)
    expect(links.map((link) => [link.title, link.alias])).toEqual([['会议记录', undefined], ['产品 愿景', '愿景']])
    expect(markdown.slice(links[0]!.index, links[0]!.index + links[0]!.raw.length)).toBe('[[会议记录]]')
    expect(extractNotebookReferences(markdown)).toHaveLength(1)
  })

  test('normalizes titles for matching', () => {
    expect(normalizeWikiTitle('  Ｍeeting   Notes ')).toBe(normalizeWikiTitle('meeting notes'))
    expect(isLinkableTitle('普通标题')).toBe(true)
    expect(isLinkableTitle('a|b')).toBe(false)
    expect(isLinkableTitle('a]b')).toBe(false)
    expect(isLinkableTitle('page:x')).toBe(false)
    expect(formatWikiLink('标题', '别名')).toBe('[[标题|别名]]')
    expect(formatWikiLink('标题', '标题')).toBe('[[标题]]')
  })

  test('renames links to a title, keeping aliases and code', () => {
    const source = '[[旧标题]]、[[旧标题|别名]]、[[ 旧标题 ]]、[[别的]] 与 `[[旧标题]]`'
    const result = renameWikiLinks(source, '旧标题', '新标题')
    expect(result.count).toBe(3)
    expect(result.markdown).toBe('[[新标题]]、[[新标题|别名]]、[[新标题]]、[[别的]] 与 `[[旧标题]]`')
    expect(renameWikiLinks(source, '旧标题', 'bad|title').count).toBe(0)
  })

  test('round trips through the editor document model', () => {
    const source = '开头 [[会议记录]] 中间 [[产品愿景|愿景]] 结尾 [[page:abc]]'
    const document = markdownToTiptap(source)
    const nodes = JSON.stringify(document)
    expect(nodes).toContain('"type":"wikiLink"')
    expect(nodes).toContain('"title":"会议记录"')
    expect(tiptapToMarkdown(document).trim()).toBe(source)
  })

  test('gives backlink context around a link', () => {
    const markdown = `${'前'.repeat(60)}[[目标]]${'后'.repeat(100)}`
    const [link] = extractWikiLinks(markdown)
    const context = wikiLinkContext(markdown, link!, 10)
    expect(context).toBe(`${'前'.repeat(10)}[[目标]]${'后'.repeat(20)}`)
  })
})
