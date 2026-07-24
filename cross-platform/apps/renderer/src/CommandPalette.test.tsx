import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { vi } from 'vitest'
import { CommandPalette, type PaletteItem } from './CommandPalette'

test('merges full-text page matches into Cmd+P results', async () => {
  const run = vi.fn()
  const items: PaletteItem[] = [
    {
      id: 'page:deep-note',
      group: 'page',
      title: '普通标题',
      subtitle: '页面 · 工作',
      keywords: '摘要没有目标词',
      run,
    },
  ]
  const searchPageIds = vi.fn(async (query: string) => query === '正文深处的唯一短语' ? ['deep-note'] : [])

  render(
    <FluentProvider theme={webLightTheme}>
      <CommandPalette open items={items} searchPageIds={searchPageIds} onClose={() => undefined} />
    </FluentProvider>,
  )

  const palette = screen.getByRole('dialog', { name: '命令面板' })
  const search = within(palette).getByRole('textbox', { name: '搜索命令、页面和设置' })
  fireEvent.change(search, { target: { value: '正文深处的唯一短语' } })

  await waitFor(() => expect(searchPageIds).toHaveBeenCalledWith('正文深处的唯一短语'))
  expect(await within(palette).findByRole('button', { name: /普通标题/ })).toBeInTheDocument()
  fireEvent.click(within(palette).getByRole('button', { name: /普通标题/ }))
  expect(run).toHaveBeenCalledOnce()
})

test('does not start a full-body search for the first character', async () => {
  const searchPageIds = vi.fn().mockResolvedValue([])
  render(
    <FluentProvider theme={webLightTheme}>
      <CommandPalette
        open
        items={[{ id: 'page:uboot', group: 'page', title: 'Uboot', subtitle: '页面 · 工作', run: vi.fn() }]}
        searchPageIds={searchPageIds}
        onClose={() => undefined}
      />
    </FluentProvider>,
  )
  fireEvent.change(screen.getByRole('textbox', { name: '搜索命令、页面和设置' }), { target: { value: 'u' } })
  expect(screen.getByRole('button', { name: /Uboot/ })).toBeInTheDocument()
  await new Promise((resolve) => window.setTimeout(resolve, 220))
  expect(searchPageIds).not.toHaveBeenCalled()
})

test('requires an explicit second confirmation before running a dangerous command', async () => {
  const run = vi.fn()
  render(
    <FluentProvider theme={webLightTheme}>
      <CommandPalette
        open
        items={[{
          id: 'delete:current-page',
          group: 'command',
          title: '删除当前页面',
          dangerous: true,
          confirmDescription: '页面及其子页面将移动到回收站。',
          confirmLabel: '确认删除',
          run,
        }]}
        onClose={() => undefined}
      />
    </FluentProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: '删除当前页面需确认' }))
  expect(run).not.toHaveBeenCalled()
  const confirmation = screen.getByRole('alertdialog', { name: '确认危险操作' })
  expect(within(confirmation).getByText('页面及其子页面将移动到回收站。')).toBeVisible()
  fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }))
  expect(run).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '删除当前页面需确认' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认删除' }))
  expect(run).toHaveBeenCalledOnce()
})
