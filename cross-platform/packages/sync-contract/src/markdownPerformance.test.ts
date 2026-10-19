import { expect, test, vi } from 'vitest'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import Image from '@tiptap/extension-image'
import { markdownToTiptap, notebookReferenceExtensions } from './index'

test('a long prose document does not repeatedly split its remaining body', () => {
  const source = ('一段正文，用来检查大量短段落的解析。\n\n').repeat(40_000) + '末尾完整保留。'
  const original = String.prototype.split
  let splitCharacters = 0
  const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator, limit) {
    if (this.length > 10_000) splitCharacters += this.length
    // Fail early if a tokenizer regresses to quadratic work, rather than
    // hanging the test runner on a book-sized fixture.
    if (splitCharacters > source.length * 8) throw new Error('Repeated full-body line splitting')
    return original.call(this, separator, limit)
  })
  try {
    const document = markdownToTiptap(source)
    expect(document.content).toHaveLength(40_001)
    expect((document.content as Array<{ content: Array<{ text: string }> }>).at(-1)?.content[0]?.text).toBe('末尾完整保留。')
  } finally {
    split.mockRestore()
  }
})

test.each([
  '1. 一\n2. 二\n\n结尾',
  'a) 字母\nb) 第二项\n\n结尾',
  'III. 罗马\nIV. 下一项\n\n结尾',
  '1. 父项\n   1. 子项\n   2. 子项二\n2. 父项二',
  '- [ ] 待办\n  - [x] 子待办\n  - 普通子项\n- [x] 完成\n\n结尾',
  '\n\n- [ ] \n\n## 下节\n\n正文',
  '| 名称 | 内容 |\n| :--- | ---: |\n| `a|b` | 值 |\n\n结尾',
  '名称 | 内容\n--- | ---\n文本 | 值\n\n结尾',
  '名称\n| --- |\n`a|b`\n\n结尾',
  '普通段落\n---\n\n正文 | 非表格\n\n末尾',
  '```md\n- [ ] 字面量\n1. 字面量\n```',
])('fast rejection preserves upstream Markdown semantics: %s', (source) => {
  const upstream = new MarkdownManager({ extensions: [
    StarterKit, TaskList, TaskItem.configure({ nested: true }), TableKit,
    Image.configure({ allowBase64: false }), ...notebookReferenceExtensions,
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
  ] })
  expect(markdownToTiptap(source)).toEqual(upstream.parse(source))
})
