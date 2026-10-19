import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { vi } from 'vitest'
import { App } from './App'
import { automationRepository } from './data/useWorkspaceData'

test('first deletion never builds the full-text index and keeps the confirmation', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: query.includes('1301px'), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) })
  const { container } = render(<FluentProvider theme={webLightTheme}><App /></FluentProvider>)
  await screen.findByLabelText('页面正文')
  const search = vi.spyOn(automationRepository, 'searchWorkspaceCandidates')
    .mockRejectedValue(new Error('Deleting must not start a full-text search'))
  try {
    const navigation = screen.getByRole('navigation', { name: '导航' })
    fireEvent.contextMenu(within(navigation).getByRole('treeitem', { name: '旧版本数据迁移' }))
    const actions = await within(container).findByRole('dialog', { name: '旧版本数据迁移页面操作' })
    fireEvent.click(within(actions).getByRole('button', { name: '移到回收站' }))
    const confirmation = await screen.findByRole('alertdialog', { name: '移到回收站' })
    expect(search).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '移到回收站' }))
    await waitFor(() => expect(within(navigation).queryByRole('treeitem', { name: '旧版本数据迁移' })).not.toBeInTheDocument())
    expect((await automationRepository.getPage('migration'))?.deletedAt).toBeTruthy()
    expect(search).not.toHaveBeenCalled()
  } finally {
    search.mockRestore()
  }
})
