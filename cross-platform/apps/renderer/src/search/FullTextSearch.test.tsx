import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { SearchHit } from '@notebook/storage-renderer'
import { DocumentEditor } from '../editor/DocumentEditor'
import { markdownToDocument } from '../editor/extensions'
import { FullTextSearch, findInDocument } from './FullTextSearch'

vi.mock('../collaboration/useCollaborativeDocument', () => ({
  useCollaborativeDocument: () => ({ document: {}, status: 'offline', readOnly: false }),
}))

const hit = (id: string, title: string, snippet: string, terms: string[]): SearchHit => ({
  page: { id, workspaceId: 'w', sectionId: 'notes', kind: 'document', title, preview: '', favorite: false, createdAt: '', updatedAt: '', syncStatus: 'synced' },
  snippet,
  terms,
})

test('searches as you type, highlights hits and opens the chosen note', async () => {
  const search = vi.fn(async (query: string) => query === '同步冲突'
    ? [hit('a', '周会纪要', '…讨论了同步冲突的处理方式…', ['同步冲突']), hit('b', '同步冲突说明', '冲突副本的由来', ['同步冲突'])]
    : [])
  const onOpen = vi.fn()
  render(<FullTextSearch search={search} notebookName={() => '工作'} onOpen={onOpen} onClose={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: '全文搜索' })
  expect(input).toHaveFocus()
  fireEvent.change(input, { target: { value: '同步冲突' } })
  const options = await screen.findAllByRole('option')
  expect(options).toHaveLength(2)
  expect(options[0]!.querySelector('mark')?.textContent).toBe('同步冲突')
  expect(options[1]!.querySelectorAll('mark')).toHaveLength(1)
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(options[1]).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ page: expect.objectContaining({ id: 'b' }) }))
  fireEvent.change(input, { target: { value: '不存在' } })
  expect(await screen.findByText('没有找到包含“不存在”的笔记。')).toBeInTheDocument()
})

test('the opened note highlights the hit and selects the first occurrence', async () => {
  findInDocument({ pageId: 'notes-page', terms: ['同步冲突'] })
  render(<DocumentEditor workspaceId="w" pageId="notes-page" pageTitle="周会" content={markdownToDocument('开头。\n\n讨论了同步冲突，以及第二次同步冲突。')} />)
  const body = await screen.findByLabelText('页面正文')
  await waitFor(() => expect(body.querySelectorAll('.search-hit-highlight')).toHaveLength(2))
  const editor = (body as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
  const { from, to } = editor.state.selection
  expect(editor.state.doc.textBetween(from, to)).toBe('同步冲突')
  // The next edit clears the highlight.
  act(() => { editor.chain().focus('end').insertContent('。').run() })
  expect(body.querySelectorAll('.search-hit-highlight')).toHaveLength(0)
})
