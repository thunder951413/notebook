import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createContentExtensions, documentToMarkdown, htmlToDocument, markdownToDocument, sanitizeSupportedHtml } from './extensions'
import { initialContent } from './DocumentEditor'
import { configureReferenceRuntime } from './referenceRuntime'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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

  test('preserves Notebook links, embeds, block anchors and contiguous groups', () => {
    const source = [
      '参见 [[page:target#^b-one]]。',
      '',
      '当前段落。 ^b-current',
      '',
      '![[page:target#group:g-one]]',
      '',
      '<!-- notebook:group g-current:start title="连续内容" -->',
      '',
      '第一段。',
      '',
      '第二段。',
      '',
      '<!-- notebook:group g-current:end -->',
    ].join('\n')
    const output = documentToMarkdown(markdownToDocument(source))
    expect(output).toContain('[[page:target#^b-one]]')
    expect(output).toContain('当前段落。 ^b-current')
    expect(output).toContain('![[page:target#group:g-one]]')
    expect(output).toContain('<!-- notebook:group g-current:start title="连续内容" -->')
    expect(output).toContain('<!-- notebook:group g-current:end -->')
  })

  test('keeps surrounding source content intact for inline links and block embeds', () => {
    const source = [
      '前文 [[page:target#^b-one]] 后文。',
      '',
      '嵌入之前。',
      '',
      '![[page:target#group:g-one]]',
      '',
      '嵌入之后。',
    ].join('\n')
    const output = documentToMarkdown(markdownToDocument(source))
    expect(output).toContain('前文 [[page:target#^b-one]] 后文。')
    expect(output.indexOf('嵌入之前。')).toBeLessThan(output.indexOf('![[page:target#group:g-one]]'))
    expect(output.indexOf('![[page:target#group:g-one]]')).toBeLessThan(output.indexOf('嵌入之后。'))
  })

  test('inserts links at the caret without replacing adjacent text', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const editor = new Editor({
      element: host,
      extensions: createContentExtensions(),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '前文后文' }] }] },
    })
    editor.chain().setTextSelection(3).insertContent({
      type: 'notebookLink',
      attrs: { pageId: 'target', targetKind: 'block', targetId: 'b-one', alias: null },
    }).run()
    const markdown = documentToMarkdown(editor.getJSON())
    expect(markdown).toBe('前文[[page:target#^b-one]]后文')
    editor.destroy()
    host.remove()
  })

  test('renders dynamic and fixed links, live embeds, navigation, deletion and restoration', async () => {
    const openPage = vi.fn()
    const targetPage = {
      id: 'target',
      sectionId: 'old-section',
      title: '目标页面',
      preview: '',
      updatedLabel: '刚刚',
      tags: [],
      favorite: false,
      kind: 'document' as const,
    }
    const firstDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '动态段落第一版' }, { type: 'blockAnchor', attrs: { anchorId: 'b-one' } }] },
        { type: 'blockGroup', attrs: { groupId: 'g-one', title: '连续结论' }, content: [
          { type: 'paragraph', content: [{ type: 'text', text: '范围第一段' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '范围第二段' }] },
        ] },
      ],
    }
    configureReferenceRuntime({
      pages: [targetPage],
      accessiblePageIds: new Set(['target']),
      documents: { target: firstDocument },
      openPage,
    })
    const dynamicHost = document.createElement('div')
    document.body.append(dynamicHost)
    const editor = new Editor({
      element: dynamicHost,
      extensions: createContentExtensions(false, undefined, 'source'),
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [
            { type: 'text', text: '前 ' },
            { type: 'notebookLink', attrs: { pageId: 'target', targetKind: 'page', targetId: null, alias: null } },
            { type: 'text', text: ' 中 ' },
            { type: 'notebookLink', attrs: { pageId: 'target', targetKind: 'block', targetId: 'b-one', alias: null } },
            { type: 'text', text: ' 后 ' },
            { type: 'notebookLink', attrs: { pageId: 'target', targetKind: 'block', targetId: 'b-one', alias: '固定称呼' } },
          ] },
          { type: 'paragraph', content: [
            { type: 'notebookLink', attrs: { pageId: 'target', targetKind: 'group', targetId: 'g-one', alias: null } },
          ] },
          { type: 'notebookEmbed', attrs: { pageId: 'target', targetKind: 'block', targetId: 'b-one', alias: null } },
          { type: 'notebookEmbed', attrs: { pageId: 'target', targetKind: 'group', targetId: 'g-one', alias: null } },
        ],
      },
    })

    await vi.waitFor(() => expect(editor.view.dom).toHaveTextContent('动态段落第一版'))
    expect(editor.view.dom).toHaveTextContent('前 目标页面 中 动态段落第一版 后 固定称呼')
    expect(editor.view.dom).toHaveTextContent('连续结论')
    expect(editor.view.dom).toHaveTextContent('范围第一段')
    expect(editor.view.dom).toHaveTextContent('范围第二段')

    const blockLink = editor.view.dom.querySelector<HTMLButtonElement>('.notebook-link-node[data-target-kind="block"]:not(:last-child)')!
    blockLink.click()
    expect(openPage).toHaveBeenCalledWith({ pageId: 'target', kind: 'block', targetId: 'b-one' })

    const updatedDocument = structuredClone(firstDocument)
    ;(updatedDocument.content[0]!.content![0] as { text: string }).text = '动态段落第二版'
    configureReferenceRuntime({
      pages: [{ ...targetPage, title: '改名后的页面', sectionId: 'moved-section' }],
      accessiblePageIds: new Set(['target']),
      documents: { target: updatedDocument },
      openPage,
    })
    await vi.waitFor(() => {
      expect(editor.view.dom).toHaveTextContent('改名后的页面')
      expect(editor.view.dom).toHaveTextContent('动态段落第二版')
    })
    expect(editor.view.dom).toHaveTextContent('固定称呼')
    expect(editor.view.dom).not.toHaveTextContent('动态段落第一版')

    configureReferenceRuntime({ pages: [], accessiblePageIds: new Set(), documents: {}, openPage })
    await vi.waitFor(() => expect(editor.view.dom.querySelector('.notebook-link-node')).toHaveAttribute('data-status', 'missing'))
    expect(editor.view.dom).toHaveTextContent('引用目标不存在')

    configureReferenceRuntime({
      pages: [{ ...targetPage, title: '恢复后的页面' }],
      accessiblePageIds: new Set(['target']),
      documents: { target: updatedDocument },
      openPage,
    })
    await vi.waitFor(() => expect(editor.view.dom).toHaveTextContent('恢复后的页面'))
    expect(editor.view.dom).toHaveTextContent('动态段落第二版')
    editor.destroy()
    dynamicHost.remove()
  })

  test('loads content-addressed images inside referenced content', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { this.callback = callback }
      observe() { this.callback([{ isIntersecting: true }]) }
      disconnect() {}
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:referenced-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const loadAsset = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    const targetPage = {
      id: 'target-with-image',
      sectionId: 'section',
      title: '图文页面',
      preview: '',
      updatedLabel: '刚刚',
      tags: [],
      kind: 'document' as const,
    }
    configureReferenceRuntime({
      pages: [targetPage],
      accessiblePageIds: new Set([targetPage.id]),
      documents: {
        [targetPage.id]: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '图片前文字' }] },
            { type: 'image', attrs: { src: 'notebook-asset:asset-in-reference', alt: '架构图' } },
            { type: 'paragraph', content: [{ type: 'text', text: '图片后文字' }] },
          ],
        },
      },
    })
    const imageHost = document.createElement('div')
    document.body.append(imageHost)
    const editor = new Editor({
      element: imageHost,
      extensions: createContentExtensions(false, loadAsset, 'source'),
      content: {
        type: 'doc',
        content: [{ type: 'notebookEmbed', attrs: { pageId: targetPage.id, targetKind: 'page', targetId: null, alias: null } }],
      },
    })

    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledWith('asset-in-reference'))
    await vi.waitFor(() => expect(editor.view.dom.querySelector('.notebook-embed-body img')).toHaveAttribute('src', 'blob:referenced-image'))
    expect(editor.view.dom).toHaveTextContent('图片前文字')
    expect(editor.view.dom).toHaveTextContent('图片后文字')
    const embeddedBody = editor.view.dom.querySelector<HTMLElement>('.notebook-embed-body')!
    const range = document.createRange()
    range.selectNodeContents(embeddedBody)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(window.getSelection()?.toString()).toContain('图片前文字')
    expect(getComputedStyle(embeddedBody).userSelect).toBe('text')
    expect(embeddedBody).toHaveAttribute('contenteditable', 'true')
    expect(embeddedBody).toHaveAttribute('aria-readonly', 'true')
    expect(embeddedBody.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '不能写入' }))).toBe(false)
    editor.destroy()
    imageHost.remove()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:referenced-image')
  })

  test('renders only one embed level and leaves nested references as navigation hints', async () => {
    const targetPage = {
      id: 'target-with-nested-reference',
      sectionId: 'section',
      title: '一级目标',
      preview: '',
      updatedLabel: '刚刚',
      tags: [],
      kind: 'document' as const,
    }
    configureReferenceRuntime({
      pages: [targetPage],
      accessiblePageIds: new Set([targetPage.id]),
      documents: {
        [targetPage.id]: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '一级引用正文' }] },
            { type: 'notebookEmbed', attrs: { pageId: 'second-level', targetKind: 'page', targetId: null, alias: null } },
          ],
        },
      },
    })
    const host = document.createElement('div')
    document.body.append(host)
    const editor = new Editor({
      element: host,
      extensions: createContentExtensions(false, undefined, 'source'),
      content: {
        type: 'doc',
        content: [{ type: 'notebookEmbed', attrs: { pageId: targetPage.id, targetKind: 'page', targetId: null, alias: null } }],
      },
    })

    await vi.waitFor(() => expect(editor.view.dom).toHaveTextContent('一级引用正文'))
    expect(editor.view.dom).toHaveTextContent('嵌套引用：打开原文查看')
    expect(editor.view.dom.querySelectorAll('.notebook-embed-node')).toHaveLength(1)
    editor.destroy()
    host.remove()
  })

  test('can migrate the legacy seeded HTML without recursive parsing', () => {
    const document = markdownToDocument(initialContent)
    expect(JSON.stringify(document)).toContain('Notebook Next 产品愿景')
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

  test('resizes an image with the drag handle and persists its width in the document', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:resizable-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const host = document.createElement('div')
    document.body.append(host)
    const editor = new Editor({
      element: host,
      extensions: createContentExtensions(false, vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))),
      content: { type: 'doc', content: [{ type: 'image', attrs: { legacyAssetId: 'asset-resize', alt: '可缩放图片', width: 320 } }] },
    })
    const image = editor.view.dom.querySelector<HTMLImageElement>('.inline-image-node img')!
    const handle = editor.view.dom.querySelector<HTMLButtonElement>('.inline-image-resize-handle')!
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 180, x: 0, y: 0, top: 0, right: 320, bottom: 180, left: 0, toJSON: () => ({}) })
    vi.spyOn(editor.view.dom, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600, x: 0, y: 0, top: 0, right: 800, bottom: 600, left: 0, toJSON: () => ({}) })

    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 320 }))
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 500 }))

    expect(editor.getJSON().content?.[0]?.attrs?.width).toBe(500)
    expect(editor.view.dom.querySelector<HTMLElement>('.inline-image-node')?.style.width).toBe('500px')
    editor.destroy()
    host.remove()
  })

  test('defers image asset reads until the image is near the viewport', async () => {
    let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { intersect = callback }
      observe() {}
      disconnect() {}
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:deferred-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const loadAsset = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createContentExtensions(false, loadAsset),
      content: { type: 'doc', content: [{ type: 'image', attrs: { legacyAssetId: 'asset-lazy', alt: '大笔记图片' } }] },
    })

    expect(loadAsset).not.toHaveBeenCalled()
    expect(editor.view.dom).toHaveTextContent('滚动到附近时载入')
    intersect?.([{ isIntersecting: true }])
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledWith('asset-lazy'))
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
