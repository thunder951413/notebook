import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { LargeDocumentReader } from './LargeDocumentReader'
import { largeDocument, replaceMarkdownSection } from '../data/largeDocument'
import { OUTLINE_JUMP_EVENT } from './outlineEvents'

afterEach(() => vi.restoreAllMocks())

test('loads only nearby content, finds unseen text, jumps to a distant chapter, and enters chapter editing', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const source = Array.from({ length: 200 }, (_, index) => `# 第 ${index} 章\n\n${`章节 ${index} 正文。`.repeat(150)}\n\n`).join('')
  const save = vi.fn(async (body: string, start: number, end: number, replacement: string) => replaceMarkdownSection(body, start, end, replacement))
  const { container } = render(<LargeDocumentReader workspaceId="workspace" pageId="test-book" pageTitle="大书" content={largeDocument(source)} onSaveSection={save} />)
  await screen.findByText('阅读模式 · 按需加载')
  expect(container.querySelectorAll('[aria-label="阅读正文"]')).toHaveLength(1)
  expect(screen.queryByLabelText('页面正文')).not.toBeInTheDocument()
  expect(container.querySelectorAll('.large-note-chunk')).toHaveLength(200)
  fireEvent.change(screen.getByLabelText('在本篇中查找'), { target: { value: '章节 198 正文' } })
  fireEvent.click(screen.getByText('下一处'))
  await waitFor(() => expect(container.querySelector('.search-hit-highlight')).toHaveTextContent('章节 198 正文'))
  await act(async () => { window.dispatchEvent(new CustomEvent(OUTLINE_JUMP_EVENT, { detail: { index: 199 } })) })
  await waitFor(() => expect(container.querySelector('[data-chunk="199"] h1')).toHaveTextContent('第 199 章'))
  const chapter = container.querySelector('[data-chunk="199"]')!
  fireEvent.click(chapter.querySelector('button')!)
  await screen.findByText('编辑本章 · 第 199 章')
  const editor = await screen.findByLabelText('页面正文')
  expect(editor).toHaveTextContent('章节 199 正文')
  expect(editor).not.toHaveTextContent('章节 198 正文')
  fireEvent.click(screen.getByText('保存并返回阅读'))
  await screen.findByText('阅读模式 · 按需加载')
  expect(save).not.toHaveBeenCalled()
})
