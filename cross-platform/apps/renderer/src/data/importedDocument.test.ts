import { expect, test } from 'vitest'
import { markdownToEditorCache } from '@notebook/sync-contract'
import { prepareImportedDocument } from './importedDocument'

test('preserves a million-character Markdown body without parsing or serializing it', () => {
  const source = '# 大文档\n\n' + '正文含有 **粗体**、[链接](https://example.com)。\n\n'.repeat(40_000) + '末尾标记'
  const result = prepareImportedDocument(source, 'markdown')
  expect(source.length).toBeGreaterThan(1_000_000)
  expect(result.markdown).toBe(source)
  expect(result.tiptapJson).toEqual({ type: 'doc', content: [] })
  expect(result.preview.length).toBeLessThanOrEqual(240)
  expect(result.preview).toContain('正文含有 粗体、链接')
})

test('removes only a repeated title and leaves Markdown formatting intact', () => {
  const source = '# 标题\n\n正文  \n换行\n\n[资料][ref]\n\n[ref]: https://example.com\n'
  expect(prepareImportedDocument(source, 'markdown', '标题').markdown).toBe(source.slice('# 标题\n\n'.length))
  expect(prepareImportedDocument(source, 'markdown', '其他').markdown).toBe(source)
})

test('plain text remains literal when the deferred editor cache is built', () => {
  const source = '# 普通文本\n**不是粗体**\n\n最后一段'
  const result = prepareImportedDocument(source, 'text')
  const parsed = markdownToEditorCache(result.markdown)
  expect(JSON.stringify(parsed)).toContain('# 普通文本')
  expect(JSON.stringify(parsed)).toContain('**不是粗体**')
  expect(JSON.stringify(parsed)).not.toContain('"type":"heading"')
  expect(JSON.stringify(parsed)).not.toContain('"type":"bold"')
})

test('HTML still converts into supported Markdown', () => {
  const result = prepareImportedDocument('<h1>标题</h1><p><strong>正文</strong></p><script>alert(1)</script>', 'html')
  expect(result.markdown).toContain('# 标题')
  expect(result.markdown).toContain('**正文**')
  expect(result.markdown).not.toContain('alert')
})
