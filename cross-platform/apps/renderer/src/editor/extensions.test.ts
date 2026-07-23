import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createContentExtensions, documentToMarkdown, markdownToDocument } from './extensions'

afterEach(() => vi.restoreAllMocks())

describe('official Tiptap Markdown round trip', () => {
  test('preserves headings, emphasis, task lists and GFM tables', () => {
    const source = '# 标题\n\n正文和 **重点** 可以混排。\n\n![示例图片](https://example.com/image.png)\n\n- [x] 已完成\n\n| 名称 | 状态 |\n| --- | --- |\n| Notebook | 完成 |'
    const document = markdownToDocument(source)
    const output = documentToMarkdown(document)
    expect(output).toContain('# 标题')
    expect(output).toContain('**重点**')
    expect(output).toContain('![示例图片](https://example.com/image.png)')
    expect(output).toContain('[x] 已完成')
    expect(output).toContain('| 名称')
  })

  test('renders a migrated local image asset inside the rich-text page', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:notebook-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const loadAsset = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createContentExtensions(false, loadAsset),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '图片如下' }] }, { type: 'image', attrs: { legacyAssetId: 'asset-1', alt: '迁移图片' } }] },
    })
    await vi.waitFor(() => expect(editor.view.dom.querySelector('img')).toHaveAttribute('src', 'blob:notebook-image'))
    expect(loadAsset).toHaveBeenCalledWith('asset-1')
    expect(createObjectUrl).toHaveBeenCalled()
    editor.destroy()
  })
})
