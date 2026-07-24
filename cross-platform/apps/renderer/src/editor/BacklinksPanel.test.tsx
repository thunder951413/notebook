import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { vi } from 'vitest'
import { BacklinksSidebar } from './BacklinksPanel'

const pages = [{
  id: 'target',
  sectionId: 'notes',
  title: '目标页面',
  preview: '',
  updatedLabel: '刚刚',
  tags: [],
  favorite: false,
  kind: 'document' as const,
}]

test('opens backlinks without scanning every document for unlinked mentions', async () => {
  const load = vi.fn().mockResolvedValue([])
  const loadMentions = vi.fn().mockResolvedValue([])
  render(<FluentProvider theme={webLightTheme}><BacklinksSidebar
    pageId="target"
    pages={pages}
    load={load}
    loadMentions={loadMentions}
    openPage={vi.fn()}
  /></FluentProvider>)

  await waitFor(() => expect(load).toHaveBeenCalledWith('target'))
  expect(loadMentions).not.toHaveBeenCalled()
  expect(screen.getByText('还没有其他页面链接到这里。')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '查找未链接提及' }))
  await waitFor(() => expect(loadMentions).toHaveBeenCalledWith('target', expect.any(AbortSignal)))
  expect(await screen.findByText('没有发现未链接的标题提及。')).toBeInTheDocument()
})

test('refreshes backlinks after the derived reference index changes', async () => {
  const load = vi.fn().mockResolvedValue([])
  const view = render(<FluentProvider theme={webLightTheme}><BacklinksSidebar
    pageId="target"
    pages={pages}
    load={load}
    loadMentions={vi.fn().mockResolvedValue([])}
    openPage={vi.fn()}
    refreshKey={0}
  /></FluentProvider>)
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  view.rerender(<FluentProvider theme={webLightTheme}><BacklinksSidebar
    pageId="target"
    pages={pages}
    load={load}
    loadMentions={vi.fn().mockResolvedValue([])}
    openPage={vi.fn()}
    refreshKey={1}
  /></FluentProvider>)
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
})
