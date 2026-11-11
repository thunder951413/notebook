import { describe, expect, it } from 'vitest'
import { largeDocument } from '../data/largeDocument'
import { isDocumentEmpty } from './documentEmpty'

describe('isDocumentEmpty', () => {
  it('treats undefined, empty doc, empty paragraphs and whitespace/hardBreaks as empty', () => {
    expect(isDocumentEmpty(undefined)).toBe(true)
    expect(isDocumentEmpty({ type: 'doc', content: [] })).toBe(true)
    expect(isDocumentEmpty({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true)
    expect(isDocumentEmpty({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '   \n\t  ' }, { type: 'hardBreak' }] },
        { type: 'paragraph', content: [] },
      ],
    })).toBe(true)
  })

  it('checks largeDocument markdown without parsing or full trimming', () => {
    expect(isDocumentEmpty(largeDocument(''))).toBe(true)
    expect(isDocumentEmpty(largeDocument('  \n\n\t '))).toBe(true)
    expect(isDocumentEmpty(largeDocument('# 第一章\n\n' + '正文'.repeat(120_000)))).toBe(false)
  })

  it('returns false immediately on non-whitespace text or non-empty block/atomic nodes', () => {
    expect(isDocumentEmpty({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '你好' }] }],
    })).toBe(false)

    for (const nodeType of [
      'image',
      'table',
      'codeBlock',
      'horizontalRule',
      'math',
      'inlineMath',
      'blockMath',
      'notebookReference',
      'notebookLink',
      'notebookEmbed',
      'wikiLink',
      'heading',
      'taskList',
    ]) {
      expect(isDocumentEmpty({
        type: 'doc',
        content: [{ type: nodeType }],
      })).toBe(false)
    }
  })
})
