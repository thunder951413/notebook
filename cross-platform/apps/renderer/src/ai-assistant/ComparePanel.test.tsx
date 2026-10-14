import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import type { PlanGroup } from '../ai/organize'
import { ComparePanel } from './ComparePanel'

const groups: PlanGroup[] = [
  {
    id: 'g1',
    kind: 'rewrite',
    title: '编译笔记',
    ops: [{ kind: 'update', pageId: 'p1', markdown: '运行 make 编译。' }],
    before: [{ key: 'p1', title: '编译笔记', markdown: '运行 make 编译。\n\n记得先装交叉编译工具链 gcc-arm。' }],
    after: [{ key: 'p1', title: '编译笔记', markdown: '运行 make 编译。' }],
  },
  {
    id: 'g2',
    kind: 'tags',
    title: '网络配置',
    ops: [{ kind: 'tags', pageId: 'p2', tags: ['网络'] }],
    before: [{ key: 'p2', title: '网络配置', markdown: '静态 IP 设置方法', tags: [] }],
    after: [{ key: 'p2', title: '网络配置', markdown: '静态 IP 设置方法', tags: ['网络'] }],
  },
]

test('flags lost paragraphs, leaves those groups unchecked and applies only checked groups', async () => {
  const onApply = vi.fn(async (accepted: PlanGroup[]) => ({ applied: accepted.map((group) => group.id), failed: [], created: [] }))
  render(<FluentProvider theme={webLightTheme}><ComparePanel groups={groups} onBack={vi.fn()} onApply={onApply} onOpenPage={vi.fn()} /></FluentProvider>)
  expect(screen.getByText('未找到', { selector: '.compare-block-tag' })).toBeInTheDocument()
  expect(screen.getByLabelText('应用“编译笔记”')).not.toBeChecked()
  expect(screen.getByLabelText('应用“网络配置”')).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '应用选中的 1 项' }))
  await waitFor(() => expect(onApply).toHaveBeenCalled())
  expect(onApply.mock.calls[0]![0].map((group) => group.id)).toEqual(['g2'])
  expect(await screen.findByText('已应用 1 项')).toBeInTheDocument()
})
