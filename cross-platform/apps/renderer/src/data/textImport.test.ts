import { describe, expect, test } from 'vitest'
import { decodeImportedText, importedTitle, importSummary, plainTextToMarkdown, stripRepeatedTitle, textImportKind } from './textImport'

describe('text import', () => {
  test('recognises the supported formats', () => {
    expect(textImportKind('a.md')).toBe('markdown')
    expect(textImportKind('A.MARKDOWN')).toBe('markdown')
    expect(textImportKind('b.txt')).toBe('text')
    expect(textImportKind('c.htm')).toBe('html')
    expect(textImportKind('d.pdf')).toBeUndefined()
  })

  test('decodes UTF-8, UTF-8 with BOM and GB18030', () => {
    expect(decodeImportedText(new TextEncoder().encode('你好'))).toBe('你好')
    expect(decodeImportedText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('笔记')]))).toBe('笔记')
    // "中文" in GBK/GB18030.
    expect(decodeImportedText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文')
  })

  test('titles come from the file name, then the content', () => {
    expect(importedTitle('dir/会议记录.md', '# 别的', 'markdown')).toBe('会议记录')
    expect(importedTitle('新建文本文档.txt', '\n第一行内容\n第二行', 'text')).toBe('第一行内容')
    expect(importedTitle('untitled.html', '<title>网页标题</title>', 'html')).toBe('网页标题')
  })

  test('plain text keeps line breaks and is not read as Markdown', () => {
    expect(plainTextToMarkdown('# 不是标题\n- 不是列表\n第三行\n\n新段落')).toBe('\\# 不是标题  \n\\- 不是列表  \n第三行\n\n新段落')
  })

  test('a leading heading equal to the title is not repeated', () => {
    expect(stripRepeatedTitle('# 计划\n\n正文', '计划')).toBe('正文')
    expect(stripRepeatedTitle('# 其他\n\n正文', '计划')).toBe('# 其他\n\n正文')
  })

  test('summary names skipped files', () => {
    expect(importSummary(2, [])).toBe('已导入 2 篇笔记')
    expect(importSummary(1, [{ name: 'a.pdf', reason: '不支持的格式' }])).toBe('已导入 1 篇笔记，跳过 1 个文件：a.pdf（不支持的格式）')
  })
})
