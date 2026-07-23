import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createContentExtensions, documentToMarkdown, htmlToDocument, markdownToDocument, sanitizeSupportedHtml } from './extensions'

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

  test('sanitizes executable HTML before importing it as a note', () => {
    const imported = JSON.stringify(htmlToDocument('<p>安全正文</p><script>alert(1)</script><a href="javascript:alert(2)">危险链接</a>'))
    expect(imported).toContain('安全正文')
    expect(imported).not.toContain('alert(1)')
    expect(imported).not.toContain('javascript:')
  })

  test('removes source typography while preserving supported paste semantics', () => {
    const pasted = sanitizeSupportedHtml(`
      <div class="WordSection1" style="font-family: Calibri; font-size: 18pt; color: red; line-height: 2">
        <h2 id="source-title"><font face="宋体" size="6" color="blue">标题</font></h2>
        <p style="background: yellow"><strong>重点</strong>和<em>斜体</em>，
          <a class="external" style="color: green" href="https://example.com" target="_blank">链接</a>
        </p>
        <ol start="3"><li>列表</li></ol>
        <ul data-type="taskList"><li data-checked="true" data-pm-slice="1 1 []">待办</li></ul>
        <img data-asset-id="asset-1" src="notebook-asset:asset-1" alt="本地图片" class="source-image">
      </div>
    `)
    expect(pasted).toContain('<h2>标题</h2>')
    expect(pasted).toContain('<strong>重点</strong>')
    expect(pasted).toContain('<em>斜体</em>')
    expect(pasted).toContain('href="https://example.com"')
    expect(pasted).toContain('<ol start="3">')
    expect(pasted).toContain('data-type="taskList"')
    expect(pasted).toContain('data-checked="true"')
    expect(pasted).toContain('data-pm-slice="1 1 []"')
    expect(pasted).toContain('data-asset-id="asset-1"')
    expect(pasted).not.toMatch(/style=|class=|font-family|font-size|color=|face=|size=|target=|\sid=/)
  })
})
