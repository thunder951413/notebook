import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { PageSummary } from '../model'
import { notePreview } from '../shell/NoteList'
import { EmptyParentPage } from './EmptyParentPageHint'

const page = (id: string, title: string, preview = ''): PageSummary => ({ id, sectionId: 's', title, preview, updatedLabel: '', tags: [], parentPageId: 'parent' })

test('an empty parent lists its sub-notes and offers to write a body', () => {
  const onOpen = vi.fn()
  const onCompose = vi.fn()
  render(<EmptyParentPage title="uboot" pages={[page('a', '编译', '先装交叉编译器'), page('b', '烧录'), page('c', '调试')]} childCounts={new Map([['c', 2]])} onOpen={onOpen} onCompose={onCompose} />)
  const overview = screen.getByRole('note', { name: '目录页提示' })
  expect(within(overview).getByRole('heading', { name: 'uboot' })).toBeInTheDocument()
  expect(within(overview).getByText(/3 个子笔记/)).toBeInTheDocument()
  // A child with a body shows its start, a blank leaf says so, a child folder says how many it holds.
  expect(within(overview).getByText('先装交叉编译器')).toBeInTheDocument()
  expect(within(overview).getByText('没有更多内容')).toBeInTheDocument()
  expect(within(overview).getByText('2 个子笔记')).toBeInTheDocument()
  fireEvent.click(within(overview).getByRole('button', { name: /烧录/ }))
  expect(onOpen).toHaveBeenCalledWith('b')
  fireEvent.click(within(overview).getByRole('button', { name: '添加正文…' }))
  expect(onCompose).toHaveBeenCalledTimes(1)
})

test('a list row shows the body, or how many sub-notes a body-less note holds', () => {
  expect(notePreview('  开头一行 ', 3)).toBe('开头一行')
  expect(notePreview('', 3)).toBe('3 个子笔记')
  expect(notePreview('  ', 0)).toBe('没有更多内容')
})
