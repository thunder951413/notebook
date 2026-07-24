import { describe, expect, test } from 'vitest'
import { extractNotebookReferences, formatNotebookReference, markdownToTiptap, normalizeReferenceTargetIds, parseNotebookReference, tiptapToMarkdown } from './index'

describe('Notebook Markdown references', () => {
  test('parses and formats page, block and group references', () => {
    expect(parseNotebookReference('[[page:page-1]]')).toMatchObject({ pageId: 'page-1', kind: 'page', embed: false })
    expect(parseNotebookReference('[[page:page-1#^b-one|固定标题]]')).toMatchObject({ pageId: 'page-1', kind: 'block', targetId: 'b-one', alias: '固定标题' })
    expect(parseNotebookReference('![[page:page-1#group:g-one]]')).toMatchObject({ pageId: 'page-1', kind: 'group', targetId: 'g-one', embed: true })
    expect(formatNotebookReference({ pageId: 'page-1', kind: 'group', targetId: 'g-one' }, { embed: true })).toBe('![[page:page-1#group:g-one]]')
  })

  test('extracts references without treating aliases as identity', () => {
    const references = extractNotebookReferences('链接 [[page:one|一]]，嵌入：\n\n![[page:two#^b-two]]')
    expect(references).toHaveLength(2)
    expect(references[0]).toMatchObject({ pageId: 'one', kind: 'page', alias: '一', embed: false })
    expect(references[1]).toMatchObject({ pageId: 'two', kind: 'block', targetId: 'b-two', embed: true })
  })

  test('round trips aliases containing closing brackets and backslashes', () => {
    const alias = String.raw`A]B \ C`
    const formatted = formatNotebookReference({ pageId: 'page-1', kind: 'block', targetId: 'b-one' }, { alias })
    expect(formatted).toBe(String.raw`[[page:page-1#^b-one|A\]B \\ C]]`)
    expect(parseNotebookReference(formatted)).toMatchObject({ alias })
    expect(extractNotebookReferences(`前 ${formatted} 后`)[0]).toMatchObject({ alias })
  })

  test('preserves block anchors followed by harmless trailing whitespace', () => {
    const output = tiptapToMarkdown(markdownToTiptap('段落。 ^b-space   \n'))
    expect(output).toContain('段落。 ^b-space')
  })

  test('round trips links, anchors, embeds and contiguous block groups', () => {
    const source = [
      '# 主页面',
      '',
      '查看 [[page:target-page]] 和 [[page:target-page#^b-target|固定名称]]。',
      '',
      '可引用段落。 ^b-source',
      '',
      '![[page:target-page#^b-target]]',
      '',
      '<!-- notebook:group g-range:start title="两段结论" -->',
      '',
      '第一自然段。',
      '',
      '第二自然段。',
      '',
      '<!-- notebook:group g-range:end -->',
    ].join('\n')
    const output = tiptapToMarkdown(markdownToTiptap(source))
    expect(output).toContain('[[page:target-page]]')
    expect(output).toContain('[[page:target-page#^b-target|固定名称]]')
    expect(output).toContain('可引用段落。 ^b-source')
    expect(output).toContain('![[page:target-page#^b-target]]')
    expect(output).toContain('<!-- notebook:group g-range:start title="两段结论" -->')
    expect(output).toContain('第一自然段。')
    expect(output).toContain('第二自然段。')
    expect(output).toContain('<!-- notebook:group g-range:end -->')
  })

  test('preserves moved target IDs and regenerates only copied duplicates', () => {
    const normalized = normalizeReferenceTargetIds({
      type: 'doc',
      content: [
        { type: 'blockGroup', attrs: { groupId: 'g-one' }, content: [
          { type: 'paragraph', content: [{ type: 'text', text: '移动后的原块' }, { type: 'blockAnchor', attrs: { anchorId: 'b-one' } }] },
        ] },
        { type: 'blockGroup', attrs: { groupId: 'g-one' }, content: [
          { type: 'paragraph', content: [{ type: 'text', text: '复制出的块' }, { type: 'blockAnchor', attrs: { anchorId: 'b-one' } }] },
        ] },
      ],
    }, (prefix) => `${prefix}-new`)
    const serialized = JSON.stringify(normalized)
    expect(serialized.match(/"anchorId":"b-one"/g)).toHaveLength(1)
    expect(serialized).toContain('"anchorId":"b-new"')
    expect(serialized.match(/"groupId":"g-one"/g)).toHaveLength(1)
    expect(serialized).toContain('"groupId":"g-new"')
  })
})
