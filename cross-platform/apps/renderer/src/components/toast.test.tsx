import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ToastHost, dismissToast, getToasts, showToast } from './toast'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  // getToasts() returns the live array; dismissToast swaps in a filtered copy,
  // so iterating the previous snapshot is safe.
  for (const entry of getToasts()) dismissToast(entry.id)
  vi.useRealTimers()
})

test('shows a message and dismisses it after the default duration', () => {
  render(<ToastHost />)
  act(() => showToast('已从剪贴板剪藏为 Markdown'))
  expect(screen.getByText('已从剪贴板剪藏为 Markdown')).toBeInTheDocument()
  act(() => { vi.advanceTimersByTime(4_000) })
  expect(screen.queryByText('已从剪贴板剪藏为 Markdown')).not.toBeInTheDocument()
})

test('error toasts carry the error style and can be dismissed manually', () => {
  const { container } = render(<ToastHost />)
  act(() => showToast('移动页面失败', { kind: 'error' }))
  expect(container.querySelector('.toast.error')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭提醒' }))
  expect(screen.queryByText('移动页面失败')).not.toBeInTheDocument()
})
