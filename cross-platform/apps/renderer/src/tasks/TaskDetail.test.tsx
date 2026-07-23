import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi, test, expect } from 'vitest'
import { TaskDetail } from './TaskDetail'

const task = {
  id: 'task-1',
  notebookId: 'notebook-1',
  sectionId: 'section-1',
  title: '新任务',
  preview: '',
  updatedAt: '2026-07-23T00:00:00.000Z',
  updatedLabel: '刚刚',
  version: 1,
  kind: 'task' as const,
  important: false,
  tags: [],
}

test('renames a task and exposes its editable controls', async () => {
  const updateTask = vi.fn().mockResolvedValue(undefined)
  render(<TaskDetail task={task} loadSteps={async () => []} saveSteps={async () => {}} updateTask={updateTask} />)

  const title = screen.getByRole('textbox', { name: '任务标题' })
  fireEvent.change(title, { target: { value: '验收发布流程' } })
  fireEvent.blur(title)
  expect(updateTask).toHaveBeenCalledWith({ title: '验收发布流程' })

  fireEvent.change(screen.getByRole('combobox', { name: '重复' }), { target: { value: 'weekly' } })
  expect(updateTask).toHaveBeenCalledWith({ recurrenceRule: 'weekly' })

  await waitFor(() => expect(screen.getByPlaceholderText('添加步骤')).toBeEnabled())
  fireEvent.change(screen.getByPlaceholderText('添加步骤'), { target: { value: '检查附件' } })
  fireEvent.keyDown(screen.getByPlaceholderText('添加步骤'), { key: 'Enter' })
  expect(await screen.findByRole('checkbox', { name: '检查附件' })).toBeInTheDocument()
})
