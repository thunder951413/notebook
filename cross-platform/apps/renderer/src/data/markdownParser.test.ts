import { expect, test } from 'vitest'
import { markdownToEditorCache } from '@notebook/sync-contract'
import { mergeParsedMarkdownChunks, splitMarkdownForParallelParsing } from './markdownParser'

test('parallel Markdown chunks preserve block semantics when merged', () => {
  const source = [
    '# 第一章',
    '',
    '第一段包含 **粗体**、[链接](https://example.com) 和 `代码`。',
    '',
    '- 列表一',
    '- 列表二',
    '',
    '```ts',
    'const value = 1',
    '',
    'console.log(value)',
    '```',
    '',
    '## 第二章',
    '',
    '| 名称 | 状态 |',
    '| --- | --- |',
    '| Notebook | 完成 |',
    '',
    '> 引用段落',
    '',
    '- [ ] 后续任务',
    '',
    '结尾段落。',
  ].join('\n')
  const chunks = splitMarkdownForParallelParsing(source, 80)
  expect(chunks.length).toBeGreaterThan(1)
  const merged = mergeParsedMarkdownChunks(chunks.map((chunk) => markdownToEditorCache(chunk)))
  expect(merged).toEqual(markdownToEditorCache(source))
})

test('keeps reference-style Markdown in one parser context', () => {
  const source = `${'# 标题\n\n正文 '.repeat(30)}\n\n[资料][docs]\n\n[docs]: https://example.com/docs`
  expect(splitMarkdownForParallelParsing(source, 80)).toEqual([source])
})

test('does not split inside fenced code or display math', () => {
  const source = [
    '# 开始',
    '',
    '```text',
    '代码块第一段',
    '',
    '代码块第二段',
    '```',
    '',
    '$$',
    'a + b',
    '',
    '= c',
    '$$',
    '',
    '# 结束',
  ].join('\n')
  const chunks = splitMarkdownForParallelParsing(source, 20)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.some((chunk) => chunk.includes('```text\n代码块第一段\n\n代码块第二段\n```'))).toBe(true)
  expect(chunks.some((chunk) => chunk.includes('$$\na + b\n\n= c\n$$'))).toBe(true)
})
