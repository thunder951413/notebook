import { describe, expect, test } from 'vitest'
import { legacyTiptapToCanonicalMarkdown, markdownToTiptap, repairDocumentStructure, tiptapToMarkdown } from './index'

const emptyItems = {
  type: 'doc',
  content: [
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [] }] },
    { type: 'bulletList', content: [{ type: 'listItem' }] },
  ],
}

describe('empty list items', () => {
  test('serialize instead of crashing', () => {
    expect(() => tiptapToMarkdown(emptyItems)).not.toThrow()
    expect(() => legacyTiptapToCanonicalMarkdown(emptyItems)).not.toThrow()
    expect(tiptapToMarkdown(emptyItems)).toContain('- [ ]')
  })

  test('an empty task from the daily-note template round-trips', () => {
    const document = markdownToTiptap('## 今日重点\n\n- [ ] \n\n## 随手记录\n')
    expect(() => tiptapToMarkdown(document)).not.toThrow()
    expect(tiptapToMarkdown(markdownToTiptap(tiptapToMarkdown(document)))).toBe(tiptapToMarkdown(document))
  })

  test('repair drops missing children and leaves valid documents untouched', () => {
    const valid = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }
    expect(repairDocumentStructure(valid)).toBe(valid)
    const broken = { type: 'doc', content: [undefined, { type: 'paragraph' }, null] }
    expect(repairDocumentStructure(broken)).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(broken.content).toHaveLength(3)
  })
})
