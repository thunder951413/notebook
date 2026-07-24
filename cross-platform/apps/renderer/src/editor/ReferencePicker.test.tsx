import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { vi } from 'vitest'
import { ReferencePicker } from './ReferencePicker'
import { INSERT_REFERENCE_EVENT, type InsertReferenceDetail } from './referenceCommands'
import type { PageSummary } from '../model'

test('selects reference blocks without retaining a pooled checkbox event', async () => {
  const page: PageSummary = {
    id: 'page-a',
    sectionId: 'section-a',
    title: '目标页面',
    preview: '正文摘要',
    updatedLabel: '刚刚',
    tags: [],
    favorite: false,
    kind: 'document',
    syncStatus: 'synced',
  }
  const document = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] },
    ],
  }

  const saveDocument = vi.fn(async (_pageId: string, _document: Record<string, unknown>) => undefined)
  const inserted: InsertReferenceDetail[] = []
  const captureInsert = (event: Event) => inserted.push((event as CustomEvent<InsertReferenceDetail>).detail)
  window.addEventListener(INSERT_REFERENCE_EVENT, captureInsert)

  render(
    <FluentProvider theme={webLightTheme}>
      <ReferencePicker
        pages={[page]}
        currentPageId="current-page"
        loadDocument={vi.fn(async () => document)}
        saveDocument={saveDocument}
        onClose={vi.fn()}
      />
    </FluentProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: /目标页面.*正文摘要/ }))
  const first = await screen.findByRole('checkbox', { name: '选择第一段' })
  const second = screen.getByRole('checkbox', { name: '选择第二段' })
  fireEvent.click(first)
  fireEvent.click(second)

  expect(first).toBeChecked()
  expect(second).toBeChecked()
  expect(screen.getByRole('button', { name: '嵌入所选段落' })).toBeEnabled()

  fireEvent.click(screen.getByRole('button', { name: /第一段.*嵌入此段/ }))
  await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce())
  expect(inserted).toEqual([expect.objectContaining({
    target: expect.objectContaining({ pageId: 'page-a', kind: 'block' }),
    embed: true,
  })])
  window.removeEventListener(INSERT_REFERENCE_EVENT, captureInsert)
})

test('creates a fixed-text dynamic block link and adds a stable anchor to the target', async () => {
  const page: PageSummary = {
    id: 'target-page',
    sectionId: 'section-a',
    title: '目标页面',
    preview: '目标摘要',
    updatedLabel: '刚刚',
    tags: [],
    kind: 'document',
  }
  const targetDocument = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '需要引用的段落' }] }],
  }
  const saveDocument = vi.fn(async (_pageId: string, _document: Record<string, unknown>) => undefined)
  const inserted: InsertReferenceDetail[] = []
  const captureInsert = (event: Event) => inserted.push((event as CustomEvent<InsertReferenceDetail>).detail)
  window.addEventListener(INSERT_REFERENCE_EVENT, captureInsert)

  render(
    <FluentProvider theme={webLightTheme}>
      <ReferencePicker
        pages={[page]}
        currentPageId="source-page"
        loadDocument={vi.fn(async () => targetDocument)}
        saveDocument={saveDocument}
        onClose={vi.fn()}
      />
    </FluentProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: /目标页面.*目标摘要/ }))
  fireEvent.click(screen.getByRole('radio', { name: '动态链接' }))
  fireEvent.change(screen.getByRole('textbox', { name: '引用显示文字' }), { target: { value: '固定别名' } })
  fireEvent.click(await screen.findByRole('button', { name: /需要引用的段落.*链接此段/ }))

  await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce())
  expect(JSON.stringify(saveDocument.mock.calls[0]![1])).toContain('blockAnchor')
  expect(inserted).toEqual([{
    target: expect.objectContaining({ pageId: 'target-page', kind: 'block', targetId: expect.stringMatching(/^b-/) }),
    embed: false,
    alias: '固定别名',
  }])
  window.removeEventListener(INSERT_REFERENCE_EVENT, captureInsert)
})

test('creates one stable range for adjacent paragraphs and blocks self-embedding only', async () => {
  const currentPage: PageSummary = {
    id: 'current-page',
    sectionId: 'section-a',
    title: '当前页面',
    preview: '当前摘要',
    updatedLabel: '刚刚',
    tags: [],
    kind: 'document',
  }
  const targetDocument = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '连续第一段' }] },
      // Horizontal rules and other structural nodes are not shown as selectable
      // rows. They must not make two visibly adjacent rows fail validation.
      { type: 'horizontalRule' },
      { type: 'paragraph', content: [{ type: 'text', text: '连续第二段' }] },
      { type: 'blockGroup', attrs: { groupId: 'g-existing', title: '已有连续内容' }, content: [
        { type: 'paragraph', content: [{ type: 'text', text: '组内段落' }] },
      ] },
    ],
  }
  const saveDocument = vi.fn(async (_pageId: string, _document: Record<string, unknown>) => undefined)
  const inserted: InsertReferenceDetail[] = []
  const captureInsert = (event: Event) => inserted.push((event as CustomEvent<InsertReferenceDetail>).detail)
  window.addEventListener(INSERT_REFERENCE_EVENT, captureInsert)

  render(
    <FluentProvider theme={webLightTheme}>
      <ReferencePicker
        pages={[currentPage]}
        currentPageId="current-page"
        loadDocument={vi.fn(async () => targetDocument)}
        saveDocument={saveDocument}
        onClose={vi.fn()}
      />
    </FluentProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: /当前页面.*当前摘要/ }))
  expect(await screen.findByText('当前页面不能嵌入自身，但可以创建普通链接或选择其他页面。')).toBeVisible()
  expect(screen.getByRole('button', { name: '嵌入整篇' })).toBeDisabled()
  expect(screen.getByRole('button', { name: /已有连续内容.*嵌入连续内容/ })).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: '动态链接' }))
  expect(screen.getByRole('button', { name: '链接整篇' })).toBeEnabled()

  fireEvent.click(screen.getByRole('checkbox', { name: '选择连续第一段' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择连续第二段' }))
  fireEvent.click(screen.getByRole('button', { name: '链接所选段落' }))

  await waitFor(() => expect(saveDocument).toHaveBeenCalledOnce())
  const saved = JSON.stringify(saveDocument.mock.calls[0]![1])
  expect(saved).toContain('"type":"blockGroup"')
  expect(saved).toContain('连续第一段')
  expect(saved).toContain('连续第二段')
  expect(saved).toContain('"type":"horizontalRule"')
  expect(inserted).toEqual([{
    target: expect.objectContaining({ pageId: 'current-page', kind: 'group', targetId: expect.stringMatching(/^g-/) }),
    embed: false,
  }])
  window.removeEventListener(INSERT_REFERENCE_EVENT, captureInsert)
})

test('shows the complete block content in a hover preview without truncating it', async () => {
  const page: PageSummary = {
    id: 'target-page',
    sectionId: 'section-a',
    title: '长内容页面',
    preview: '页面摘要',
    updatedLabel: '刚刚',
    tags: [],
    kind: 'document',
  }
  const completeContent = `这是一个超过列表标题长度的内容块，列表本身仍然应该保持紧凑。${'完整预览内容'.repeat(12)}\n第二行也必须原样显示。`
  const document = {
    type: 'doc',
    content: [{ type: 'codeBlock', content: [{ type: 'text', text: completeContent }] }],
  }

  render(
    <FluentProvider theme={webLightTheme}>
      <ReferencePicker
        pages={[page]}
        currentPageId="source-page"
        loadDocument={vi.fn(async () => document)}
        saveDocument={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />
    </FluentProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: /长内容页面.*页面摘要/ }))
  const candidateButton = await screen.findByRole('button', { name: /代码 · 这是一个超过列表标题长度的内容块.*嵌入此段/ })
  const candidateRow = candidateButton.closest('.reference-target-row')
  expect(candidateRow).not.toBeNull()

  fireEvent.mouseEnter(candidateRow!)

  const preview = screen.getByRole('tooltip', { name: '块完整内容' })
  expect(preview).toBeVisible()
  expect(preview).toHaveTextContent('完整预览内容完整预览内容完整预览内容')
  expect(preview).toHaveTextContent('第二行也必须原样显示。')
})
