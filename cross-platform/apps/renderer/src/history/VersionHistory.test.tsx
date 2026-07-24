import { fireEvent, render, screen, within } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import type { PageRevision } from '@notebook/domain'
import { vi } from 'vitest'
import { VersionHistory } from './VersionHistory'

const revisions: PageRevision[] = [{
  id: '10000000-0000-4000-8000-000000000001',
  pageId: '20000000-0000-4000-8000-000000000001',
  createdAt: '2026-07-23T08:00:00.000Z',
  reason: 'import',
  document: {
    pageId: '20000000-0000-4000-8000-000000000001',
    schemaVersion: 1,
    markdown: '# 标题\n旧内容\n',
    tiptapJson: { type: 'doc', content: [] },
    updatedAt: '2026-07-23T08:00:00.000Z',
  },
}]

test('lists migrated versions and displays their diff from the current note', async () => {
  render(<FluentProvider theme={webLightTheme}><VersionHistory
    pageId={revisions[0]!.pageId}
    currentMarkdown={'# 标题\n新内容\n'}
    load={vi.fn().mockResolvedValue(revisions)}
    create={vi.fn().mockResolvedValue(revisions[0])}
    restore={vi.fn().mockResolvedValue(undefined)}
  /></FluentProvider>)

  fireEvent.click(screen.getByRole('button', { name: '版本' }))
  const history = await screen.findByText('共 1 个版本')
  const popover = history.closest('.version-popover') as HTMLElement
  expect(within(popover).getByText('版本 1 · 导入版本')).toBeInTheDocument()
  fireEvent.click(within(popover).getByRole('button', { name: '与当前差异' }))
  const difference = within(popover).getByLabelText('版本差异')
  expect(within(difference).getByText('旧内容')).toHaveClass('removed')
  expect(within(difference).getByText('新内容')).toHaveClass('added')
})

test('creates and selects a manual version from the history panel', async () => {
  const manual = { ...revisions[0]!, id: 'manual-version', reason: 'manual' as const }
  const create = vi.fn().mockResolvedValue(manual)
  render(<FluentProvider theme={webLightTheme}><VersionHistory
    pageId={manual.pageId}
    currentMarkdown={manual.document.markdown ?? ''}
    load={vi.fn().mockResolvedValue([])}
    create={create}
    restore={vi.fn().mockResolvedValue(undefined)}
  /></FluentProvider>)
  fireEvent.click(screen.getByRole('button', { name: '版本' }))
  fireEvent.click(await screen.findByRole('button', { name: '创建版本' }))
  expect(create).toHaveBeenCalledWith(manual.pageId)
  expect(await screen.findByText('版本 1 · 手动保存')).toBeInTheDocument()
})
