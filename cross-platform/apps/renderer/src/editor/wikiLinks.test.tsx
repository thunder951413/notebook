import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import type { PageSummary } from '../model'
import { DocumentEditor } from './DocumentEditor'
import { documentToMarkdown, markdownToDocument } from './extensions'
import { configureReferenceRuntime, openWikiLink, resolveWikiLink, suggestWikiLinkPages } from './referenceRuntime'

vi.mock('../collaboration/useCollaborativeDocument', () => ({
  useCollaborativeDocument: () => ({ document: {}, status: 'offline', readOnly: false }),
}))

const page = (id: string, title: string, extra: Partial<PageSummary> = {}): PageSummary => ({
  id, sectionId: 'notes', title, preview: '', updatedLabel: '刚刚', tags: [], favorite: false, kind: 'document', updatedAt: '2026-10-01T00:00:00.000Z', ...extra,
})

const pages = [
  page('meeting', '会议记录', { updatedAt: '2026-10-03T00:00:00.000Z' }),
  page('meeting-old', '会议记录', { kind: 'task', updatedAt: '2026-10-05T00:00:00.000Z' }),
  page('weekly', '每周会议'),
  page('vision', '产品愿景'),
  page('secret', '私密计划'),
]
const openPage = vi.fn()
const createPageForTitle = vi.fn()

beforeEach(() => {
  openPage.mockReset()
  createPageForTitle.mockReset()
  configureReferenceRuntime({ pages, accessiblePageIds: new Set(['meeting', 'meeting-old', 'weekly', 'vision']), documents: {}, openPage, createPageForTitle })
})

test('resolves title links: notes before to-dos, missing and locked targets', () => {
  expect(resolveWikiLink(' 会议记录 ')).toMatchObject({ status: 'ready', pageId: 'meeting' })
  expect(resolveWikiLink('不存在的笔记')).toMatchObject({ status: 'missing' })
  expect(resolveWikiLink('私密计划')).toMatchObject({ status: 'locked' })
  openWikiLink('会议记录')
  expect(openPage).toHaveBeenCalledWith({ pageId: 'meeting', kind: 'page' })
  openWikiLink('新的想法')
  expect(createPageForTitle).toHaveBeenCalledWith('新的想法')
  openWikiLink('私密计划')
  expect(createPageForTitle).toHaveBeenCalledTimes(1)
})

test('suggests exact, then prefix, then contained titles', () => {
  expect(suggestWikiLinkPages('会议').map((item) => item.id)).toEqual(['meeting', 'meeting-old', 'weekly'])
  expect(suggestWikiLinkPages('私密')).toEqual([])
})

test('title links survive Markdown → editor → Markdown', () => {
  const markdown = '参见 [[会议记录]] 和 [[产品愿景|愿景]]。'
  expect(documentToMarkdown(markdownToDocument(markdown)).trim()).toBe(markdown)
})

function typeText(editor: Editor, text: string) {
  const { view } = editor
  const { from, to } = view.state.selection
  const handled = view.someProp('handleTextInput', (handler) => handler(view, from, to, text, () => view.state.tr.insertText(text, from, to)))
  if (!handled) view.dispatch(view.state.tr.insertText(text, from, to))
}

async function renderEditor(markdown: string, onChange = vi.fn()) {
  render(<DocumentEditor workspaceId="workspace" pageId="vision" pageTitle="产品愿景" content={markdownToDocument(markdown)} onChange={onChange} />)
  const body = await screen.findByLabelText('页面正文')
  const editor = (body as HTMLElement & { editor: Editor }).editor
  return { body, editor, onChange }
}

test('typing [[ offers matching notes and inserts the chosen title link', async () => {
  const { body, editor, onChange } = await renderEditor('开头')
  act(() => { editor.chain().focus('end').insertContent(' [[会议').run() })
  const menu = await screen.findByRole('listbox', { name: '链接到笔记' })
  const options = screen.getAllByRole('option')
  expect(options.map((option) => option.textContent)).toEqual(['会议记录笔记', '会议记录待办', '每周会议笔记', '新建笔记“会议”插入链接，点击链接即可创建', '段落、标题或嵌入…引用页面中的一部分'])
  expect(menu).toBeInTheDocument()
  fireEvent.keyDown(body, { key: 'ArrowDown' })
  fireEvent.keyDown(body, { key: 'ArrowUp' })
  fireEvent.keyDown(body, { key: 'Enter' })
  await waitFor(() => expect(screen.queryByRole('listbox', { name: '链接到笔记' })).not.toBeInTheDocument())
  expect(documentToMarkdown(editor.getJSON()).trim()).toBe('开头 [[会议记录]]')
  await waitFor(() => expect(onChange).toHaveBeenCalled())
  expect(documentToMarkdown(onChange.mock.lastCall![0]).trim()).toBe('开头 [[会议记录]]')
})

test('Escape keeps the typed text, closing ]] turns it into a link, and a dangling link creates its page', async () => {
  const { body, editor } = await renderEditor('')
  act(() => { editor.chain().focus('end').insertContent('[[新的想法').run() })
  await screen.findByRole('listbox', { name: '链接到笔记' })
  fireEvent.keyDown(body, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  expect(editor.getText()).toBe('[[新的想法')
  // Input rules run on typed text: type "]]" through ProseMirror's text input path.
  act(() => { typeText(editor, ']'); typeText(editor, ']') })
  await waitFor(() => expect(body.querySelector('.wiki-link-node')).not.toBeNull())
  const link = body.querySelector('.wiki-link-node') as HTMLButtonElement
  expect(link).toHaveAttribute('data-status', 'missing')
  expect(documentToMarkdown(editor.getJSON()).trim()).toBe('[[新的想法]]')
  fireEvent.click(link)
  expect(createPageForTitle).toHaveBeenCalledWith('新的想法')
})

test('links re-resolve when the library changes', async () => {
  const { body } = await renderEditor('[[以后再写]]')
  const link = body.querySelector('.wiki-link-node') as HTMLButtonElement
  expect(link).toHaveAttribute('data-status', 'missing')
  act(() => {
    configureReferenceRuntime({ pages: [...pages, page('later', '以后再写')], accessiblePageIds: new Set(['later']), documents: {}, openPage, createPageForTitle })
  })
  expect(link).toHaveAttribute('data-status', 'ready')
  fireEvent.click(link)
  expect(openPage).toHaveBeenCalledWith({ pageId: 'later', kind: 'page' })
})
