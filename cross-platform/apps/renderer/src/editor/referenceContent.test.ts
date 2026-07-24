import { describe, expect, test } from 'vitest'
import { findReferencedFragment, referenceDynamicLabel, referenceTargetElement } from './referenceContent'

const targetDocument = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '第一段会更新的正文' },
        { type: 'blockAnchor', attrs: { anchorId: 'b-one' } },
      ],
    },
    {
      type: 'blockGroup',
      attrs: { groupId: 'g-one', title: '两段结论' },
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第三段' }] },
      ],
    },
  ],
}

describe('reference content resolution', () => {
  test('resolves entire pages, single blocks and contiguous groups', () => {
    expect(findReferencedFragment(targetDocument, { pageId: 'page', kind: 'page' })).toBe(targetDocument)
    expect(JSON.stringify(findReferencedFragment(targetDocument, { pageId: 'page', kind: 'block', targetId: 'b-one' }))).toContain('第一段会更新的正文')
    expect(JSON.stringify(findReferencedFragment(targetDocument, { pageId: 'page', kind: 'block', targetId: 'b-one' }))).not.toContain('blockAnchor')
    expect(JSON.stringify(findReferencedFragment(targetDocument, { pageId: 'page', kind: 'group', targetId: 'g-one' }))).toContain('第三段')
  })

  test('uses dynamic block text and group titles while page links use the page title', () => {
    expect(referenceDynamicLabel(targetDocument, { pageId: 'page', kind: 'page' }, '页面标题')).toBe('页面标题')
    expect(referenceDynamicLabel(targetDocument, { pageId: 'page', kind: 'block', targetId: 'b-one' }, '页面标题')).toBe('第一段会更新的正文')
    expect(referenceDynamicLabel(targetDocument, { pageId: 'page', kind: 'group', targetId: 'g-one' }, '页面标题')).toBe('两段结论')
  })

  test('keeps locating an anchored block after it is reordered in the document DOM', () => {
    document.body.innerHTML = `
      <div class="document-editor-content">
        <p id="first">开头</p>
        <p id="target">目标<span data-block-anchor="b-one"></span></p>
        <div id="group" data-block-group="g-one">连续内容</div>
      </div>`
    const root = document.querySelector('.document-editor-content')!
    const target = document.querySelector('#target')!
    root.prepend(target)
    expect(referenceTargetElement(root, { pageId: 'page', kind: 'block', targetId: 'b-one' })).toBe(target)
    expect(referenceTargetElement(root, { pageId: 'page', kind: 'group', targetId: 'g-one' })).toBe(document.querySelector('#group'))
  })

  test('returns undefined instead of selecting a similarly named anchor', () => {
    document.body.innerHTML = '<p data-block-anchor="b-one-copy"></p>'
    expect(referenceTargetElement(document, { pageId: 'page', kind: 'block', targetId: 'b-one' })).toBeUndefined()
  })
})
