import { fireEvent, render, screen } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { afterEach, expect, test } from 'vitest'
import { ConfirmDialogHost, pendingConfirmRequests, requestConfirm } from './confirmDialog'

afterEach(() => {
  while (pendingConfirmRequests() > 0) {
    // Drain leaked requests from a failed assertion so tests stay isolated.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
  }
})

function renderHost() {
  return render(<FluentProvider theme={webLightTheme}><ConfirmDialogHost /></FluentProvider>)
}

test('resolves true when confirmed and renders the destructive style flag', async () => {
  const { container } = renderHost()
  const pending = requestConfirm({ title: '永久删除', description: '此操作无法撤销。', confirmLabel: '删除', destructive: true })
  const dialog = await screen.findByRole('alertdialog', { name: '永久删除' })
  expect(screen.getByText('此操作无法撤销。')).toBeInTheDocument()
  expect(container.querySelector('.destructive-button')).toBeInTheDocument()
  fireEvent.click(withinDialog(dialog, '删除'))
  await expect(pending).resolves.toBe(true)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

test('resolves false on cancel, backdrop click and Escape', async () => {
  renderHost()
  const cancelled = requestConfirm({ title: '确认一' })
  fireEvent.click(await screen.findByRole('button', { name: '取消' }))
  await expect(cancelled).resolves.toBe(false)

  const backdropClosed = requestConfirm({ title: '确认二' })
  fireEvent.click(await screen.findByRole('alertdialog', { name: '确认二' }).then((dialog) => dialog.parentElement!))
  await expect(backdropClosed).resolves.toBe(false)

  const escapeClosed = requestConfirm({ title: '确认三' })
  await screen.findByRole('alertdialog', { name: '确认三' })
  fireEvent.keyDown(window, { key: 'Escape' })
  await expect(escapeClosed).resolves.toBe(false)
})

test('queues concurrent requests and answers them in order', async () => {
  renderHost()
  const first = requestConfirm({ title: '第一项' })
  const second = requestConfirm({ title: '第二项' })
  // Only the first is visible until it settles.
  fireEvent.click(await screen.findByRole('button', { name: '确定' }))
  await expect(first).resolves.toBe(true)
  expect(screen.getByRole('alertdialog', { name: '第二项' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  await expect(second).resolves.toBe(false)
})

function withinDialog(dialog: HTMLElement, name: string) {
  const button = [...dialog.querySelectorAll('button')].find((candidate) => candidate.textContent === name)
  if (!button) throw new Error(`button ${name} not found`)
  return button
}
