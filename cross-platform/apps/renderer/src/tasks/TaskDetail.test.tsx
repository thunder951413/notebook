import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { vi, test, expect } from 'vitest'
import type { TaskStep } from '@notebook/domain'
import { TaskDetail } from './TaskDetail'

const task = {
  id: 'task-1',
  notebookId: 'notebook-1',
  sectionId: 'section-1',
  title: '',
  preview: '',
  updatedAt: '2026-07-23T00:00:00.000Z',
  updatedLabel: '刚刚',
  version: 1,
  kind: 'task' as const,
  important: false,
  tags: [],
}

function renderTask(overrides: Partial<typeof task> & Record<string, unknown> = {}, steps: TaskStep[] = []) {
  const updateTask = vi.fn().mockResolvedValue(undefined)
  const saveSteps = vi.fn().mockResolvedValue(undefined)
  render(<TaskDetail task={{ ...task, ...overrides }} loadSteps={async () => steps} saveSteps={saveSteps} updateTask={updateTask} />)
  return { updateTask, saveSteps }
}

async function draftRow() {
  const draft = screen.getByRole('textbox', { name: '添加步骤' })
  await waitFor(() => expect(draft).toBeEnabled())
  return draft
}

test('the todo is edited as its own text, with no separate title', () => {
  const { updateTask } = renderTask()
  const item = screen.getByRole('textbox', { name: '待办事项' })
  expect(item).toHaveFocus()
  fireEvent.change(item, { target: { value: '给房东转账' } })
  fireEvent.blur(item)
  expect(updateTask).toHaveBeenCalledWith({ title: '给房东转账' })
})

test('schedule fields stay hidden until set or added, and sit in the side column', () => {
  const { updateTask } = renderTask()
  const aside = screen.getByRole('complementary', { name: '时间' })
  expect(within(aside).queryByLabelText('截止时间')).not.toBeInTheDocument()
  expect(within(aside).queryByRole('combobox', { name: '重复' })).not.toBeInTheDocument()

  fireEvent.click(within(aside).getByRole('button', { name: '重复' }))
  fireEvent.change(within(aside).getByRole('combobox', { name: '重复' }), { target: { value: 'weekly' } })
  expect(updateTask).toHaveBeenCalledWith({ recurrenceRule: 'weekly' })

  fireEvent.click(within(aside).getByRole('button', { name: '移除重复' }))
  expect(updateTask).toHaveBeenCalledWith({ recurrenceRule: 'none' })
})

test('a set due date shows in the side column', () => {
  renderTask({ dueAt: '2026-10-21T09:00:00.000Z' })
  expect(within(screen.getByRole('complementary', { name: '时间' })).getByLabelText('截止时间')).toBeInTheDocument()
})

test('typing in the steps area creates a checkable step; Enter starts the next one', async () => {
  const { saveSteps } = renderTask()
  const draft = await draftRow()
  fireEvent.change(draft, { target: { value: '检查附件' } })

  expect(screen.getByRole('checkbox', { name: '完成步骤 检查附件' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '步骤内容' })).toBe(draft)
  expect(saveSteps).toHaveBeenLastCalledWith('task-1', [expect.objectContaining({ text: '检查附件', checked: false, sortOrder: 0 })])

  fireEvent.keyDown(draft, { key: 'Enter' })
  const next = screen.getByRole('textbox', { name: '添加步骤' })
  expect(next).toHaveFocus()
  fireEvent.change(next, { target: { value: '发送邮件' } })
  expect(screen.getAllByRole('textbox', { name: '步骤内容' })).toHaveLength(2)

  fireEvent.click(screen.getByRole('checkbox', { name: '完成步骤 检查附件' }))
  expect(saveSteps).toHaveBeenLastCalledWith('task-1', [
    expect.objectContaining({ text: '检查附件', checked: true, sortOrder: 0 }),
    expect.objectContaining({ text: '发送邮件', checked: false, sortOrder: 1 }),
  ])
})

test('Enter inside a step splits it, Ctrl+Enter breaks the line, and input-method Enter does nothing', async () => {
  const step: TaskStep = { id: 'step-1', pageId: 'task-1', text: '买牛奶面包', checked: false, sortOrder: 0, createdAt: '2026-10-20T00:00:00.000Z' }
  const { saveSteps } = renderTask({}, [step])
  await draftRow()
  const input = screen.getByRole('textbox', { name: '步骤内容' }) as HTMLTextAreaElement

  input.setSelectionRange(3, 3)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(screen.getAllByRole('textbox', { name: '步骤内容' })).toHaveLength(1)

  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  expect(input).toHaveValue('买牛奶\n面包')

  input.setSelectionRange(4, 4)
  fireEvent.keyDown(input, { key: 'Enter' })
  const rows = screen.getAllByRole('textbox', { name: '步骤内容' })
  expect(rows.map((row) => (row as HTMLTextAreaElement).value)).toEqual(['买牛奶\n', '面包'])
  expect(rows[1]).toHaveFocus()
  expect(saveSteps).toHaveBeenLastCalledWith('task-1', [expect.objectContaining({ id: 'step-1', text: '买牛奶\n' }), expect.objectContaining({ text: '面包', sortOrder: 1 })])
})

test('Backspace at the start of a step joins it to the previous one', async () => {
  const step: TaskStep = { id: 'step-1', pageId: 'task-1', text: '订机票', checked: false, sortOrder: 0, createdAt: '2026-10-20T00:00:00.000Z' }
  const { saveSteps } = renderTask({}, [step])
  await draftRow()
  const first = screen.getByRole('textbox', { name: '步骤内容' }) as HTMLTextAreaElement
  first.setSelectionRange(1, 1)
  fireEvent.keyDown(first, { key: 'Enter' })
  expect(saveSteps).toHaveBeenLastCalledWith('task-1', [expect.objectContaining({ text: '订' }), expect.objectContaining({ text: '机票' })])

  const second = screen.getAllByRole('textbox', { name: '步骤内容' })[1] as HTMLTextAreaElement
  second.setSelectionRange(0, 0)
  fireEvent.keyDown(second, { key: 'Backspace' })
  expect(screen.getByRole('textbox', { name: '步骤内容' })).toHaveValue('订机票')
  expect(screen.getByRole('textbox', { name: '步骤内容' })).toHaveFocus()
})
