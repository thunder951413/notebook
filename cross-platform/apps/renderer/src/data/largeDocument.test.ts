import { indexLargeMarkdown, chunkAtOffset } from './largeDocumentIndex'
import { isLargeDocument, largeDocument, replaceMarkdownSection } from './largeDocument'
import { documentToMarkdown } from '../editor/extensions'
import { editorDocumentFromStorage } from './workspaceStore'
import * as parser from './markdownParser'
import { vi } from 'vitest'

test('opens a million-character source without constructing any full editor cache', async () => {
  const markdown = '# 开始\n\n' + '这是一段完整的长篇正文。\n\n'.repeat(100_000) + '# 终章\n\n结束标记'
  const parse = vi.spyOn(parser, 'parseMarkdownForEditor')
  const document = await editorDocumentFromStorage({ pageId: 'big', schemaVersion: 3, updatedAt: '2026-10-19T00:00:00Z', markdown, tiptapJson: { type: 'doc', content: [] } }, [])
  expect(isLargeDocument(document)).toBe(true)
  expect(documentToMarkdown(document)).toBe(markdown)
  expect(parse).not.toHaveBeenCalled()
  const index = indexLargeMarkdown(markdown)
  expect(index.chunks.length).toBeGreaterThan(100)
  expect(Math.max(...index.chunks.map((chunk) => chunk.end - chunk.start))).toBeLessThan(7_000)
  expect(index.chunks.map((chunk) => markdown.slice(chunk.start, chunk.end)).join('')).toBe(markdown)
  expect(index.headings.at(-1)?.title).toBe('终章')
  expect(index.chunks[chunkAtOffset(index, markdown.indexOf('结束标记'))]?.end).toBe(markdown.length)
  parse.mockRestore()
})

test('indexes Markdown blocks and CRLF offsets without treating fenced headings as chapters', () => {
  const markdown = '# 第一章\r\n\r\n前言\r\n\r\n```md\r\n# 不是章节\r\n```\r\n\r\n- 第一项\r\n\r\n  第二段\r\n\r\n正文 [链接][目标]\r\n\r\n[目标]: https://example.org\r\n\r\n第二章\r\n------\r\n\r\n结尾\r\n'
  const index = indexLargeMarkdown(markdown)
  expect(index.headings.map((heading) => heading.title)).toEqual(['第一章', '第二章'])
  expect(markdown.slice(index.chapters[1]!.start).startsWith('第二章')).toBe(true)
  expect(index.chunks.map((chunk) => markdown.slice(chunk.start, chunk.end)).join('')).toBe(markdown)
  expect(index.definitions).toContain('[目标]: https://example.org')
  expect(index.chapters[0]?.definitions).toContain('[目标]: https://example.org')
  expect(index.chapters[1]?.definitions).toBe('')
})

test('replacing one chapter leaves all unseen source bytes and line endings intact', () => {
  const prefix = '# 第一章\r\n\r\n保留 **格式** 和空白  \r\n\r\n'
  const original = '# 第二章\r\n\r\n旧正文\r\n\r\n'
  const suffix = '# 第三章\r\n\r\n' + '从未加载的正文\r\n\r\n'.repeat(100_000)
  const source = prefix + original + suffix
  const result = replaceMarkdownSection(source, prefix.length, prefix.length + original.length, '# 第二章\n\n新正文')
  expect(result.markdown.slice(0, prefix.length)).toBe(prefix)
  expect(result.markdown.slice(result.end)).toBe(suffix)
  expect(documentToMarkdown(largeDocument(result.markdown))).toBe(result.markdown)
  expect(() => replaceMarkdownSection(source, -1, 1, 'x')).toThrow()
})

test('a single enormous block still has a bounded reading window', () => {
  const source = '```text\n' + '不拆坏源文件 '.repeat(50_000) + '\n```\n'
  const index = indexLargeMarkdown(source)
  expect(index.chunks.every((chunk) => chunk.literal)).toBe(true)
  expect(Math.max(...index.chunks.map((chunk) => chunk.end - chunk.start))).toBeLessThanOrEqual(6_000)
  expect(index.chunks.map((chunk) => source.slice(chunk.start, chunk.end)).join('')).toBe(source)
})

test('reference groups remain whole and an unclosed math block remains bounded', () => {
  const group = '<!-- notebook:group g-note:start -->\n\n# 组内标题\n\n内容\n\n<!-- notebook:group g-note:end -->\n\n'
  const source = group + '# 后面的章节\n\n' + '正文\n\n'.repeat(4_000)
  const index = indexLargeMarkdown(source)
  expect(index.headings.map((heading) => heading.title)).toEqual(['后面的章节'])
  expect(source.slice(index.chunks[0]!.start, index.chunks[0]!.end)).toBe(group)
  const unclosed = indexLargeMarkdown('$$\n\n' + '无限延续的公式\n\n'.repeat(40_000))
  expect(Math.max(...unclosed.chunks.map((chunk) => chunk.end - chunk.start))).toBeLessThanOrEqual(6_000)
})
