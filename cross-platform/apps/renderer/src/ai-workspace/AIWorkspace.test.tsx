import { fireEvent, render, screen } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { describe, expect, test, vi } from 'vitest'
import type { AutomationProposal, AutomationProposalChange } from '@notebook/domain'
import {
  AIWorkspace,
  changeSummary,
  compactDiffParts,
  groupProposalChanges,
  mentionSearch,
  replaceMentionQuery,
  summarizeProposalChanges,
} from './AIWorkspace'

describe('AI workspace @ mentions', () => {
  test('finds the active article query without treating earlier mentions as active', () => {
    expect(mentionSearch('整理 @项目总览')).toBe('项目总览')
    expect(mentionSearch('@项目总览 请结合 @风险')).toBe('风险')
    expect(mentionSearch('@项目总览 请总结')).toBeUndefined()
  })

  test('replaces only the active mention query and keeps the surrounding request', () => {
    expect(replaceMentionQuery('请比较 @项', '@项目总览 ')).toBe('请比较 @项目总览 ')
    expect(replaceMentionQuery('@A 与 @B草稿', '@B正式版 ')).toBe('@A 与 @B正式版 ')
  })
})

describe('AI review workspace interaction', () => {
  test('separates ask and edit modes and applies only reviewed changes', async () => {
    const parent = {
      id: 'parent',
      sectionId: 'section-a',
      title: '项目说明',
      preview: '旧摘要',
      updatedLabel: '',
      tags: [],
    }
    const changes: AutomationProposalChange[] = [
      change({
        id: 'change-content',
        type: 'update-page',
        before: { pageId: 'parent', title: '项目说明', markdown: '旧内容', sectionId: 'section-a', updatedAt },
        after: { pageId: 'parent', title: '项目说明', markdown: '新内容', sectionId: 'section-a', updatedAt },
      }),
      change({
        id: 'change-child',
        type: 'create-page',
        after: { pageId: 'child', title: '实施步骤', markdown: '第一步', sectionId: 'section-a', parentPageId: 'parent', updatedAt },
      }),
    ]
    const proposal: AutomationProposal = {
      id: 'proposal',
      workspaceId: 'workspace',
      title: '整理项目说明',
      source: 'built-in-ai',
      status: 'pending',
      changes,
      createdAt: updatedAt,
    }
    const apply = vi.fn(async () => undefined)
    render(<FluentProvider theme={webLightTheme}><AIWorkspace
      currentPage={parent}
      pages={[parent]}
      trashPages={[]}
      notebooks={[{
        id: 'notebook-a',
        name: '项目',
        emoji: '📘',
        sections: [{ id: 'section-a', name: '默认', color: '#888', pageCount: 1 }],
      }]}
      proposals={[proposal]}
      documents={{}}
      privacyUnlocked={false}
      loadDocument={async () => undefined}
      loadAssets={async () => []}
      searchWorkspace={async () => []}
      onClose={() => undefined}
      onOpenPage={() => undefined}
      onCreateWriteback={async () => 'writeback'}
      onCreateAgentProposal={async () => 'agent'}
      onApplyProposal={apply}
      onRejectProposal={async () => undefined}
    /></FluentProvider>)

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByLabelText('校订正文差异')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /问笔记库/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /修改笔记/ }))
    expect(screen.getByLabelText('说明笔记修改要求')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '检索笔记库' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成修改草案' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /实施步骤/ }))
    fireEvent.click(screen.getByRole('button', { name: '忽略此项' }))
    fireEvent.click(screen.getByRole('button', { name: '应用 1 项' }))
    expect(apply).toHaveBeenCalledWith('proposal', ['change-content'])
  })
})

const updatedAt = '2026-07-26T00:00:00.000Z'
const change = (input: Partial<AutomationProposalChange> & Pick<AutomationProposalChange, 'id' | 'type' | 'after'>): AutomationProposalChange => ({
  ...input,
  id: input.id,
  type: input.type,
  before: input.before,
  after: input.after,
})

describe('AI proposal review model', () => {
  test('groups changes by notebook and keeps the proposed page hierarchy', () => {
    const changes = [
      change({
        id: 'change-parent',
        type: 'update-page',
        before: { pageId: 'parent', title: '父页', markdown: '', sectionId: 'section-a', updatedAt },
        after: { pageId: 'parent', title: '父页', markdown: '更新', sectionId: 'section-a', updatedAt },
      }),
      change({
        id: 'change-child',
        type: 'create-page',
        after: { pageId: 'child', title: '子页', markdown: '新增', sectionId: 'section-a', parentPageId: 'parent', updatedAt },
      }),
    ]
    const groups = groupProposalChanges(changes, [{
      id: 'parent',
      sectionId: 'section-a',
      title: '父页',
      preview: '',
      updatedLabel: '',
      tags: [],
    }], [{
      id: 'notebook-a',
      name: '项目',
      emoji: '📘',
      sections: [{ id: 'section-a', name: '默认', color: '#888', pageCount: 2 }],
    }])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('项目')
    expect(groups[0]?.items.map((item) => item.depth)).toEqual([0, 1])
  })

  test('summarizes content, structure, create and delete changes independently', () => {
    const state = { pageId: 'page', title: '页面', markdown: '正文', sectionId: 'section-a', updatedAt }
    expect(summarizeProposalChanges([
      change({ id: 'm', type: 'update-page', before: state, after: { ...state, markdown: '新正文' } }),
      change({ id: 'r', type: 'update-page', before: state, after: { ...state, title: '新标题' } }),
      change({ id: 'a', type: 'create-page', after: { ...state, pageId: 'new' } }),
      change({ id: 'd', type: 'delete-page', before: state, after: state }),
    ])).toEqual({ modified: 1, created: 1, moved: 1, deleted: 1 })
  })

  test('uses proposal snapshots rather than the current applied location for historical moves', () => {
    const moved = change({
      id: 'move',
      type: 'update-page',
      before: { pageId: 'page', title: '页面', markdown: '', sectionId: 'section-a', updatedAt },
      after: { pageId: 'page', title: '页面', markdown: '', sectionId: 'section-b', updatedAt },
    })
    const currentPages = [{
      id: 'page',
      sectionId: 'section-b',
      title: '页面',
      preview: '',
      updatedLabel: '',
      tags: [],
    }]
    const notebooks = [
      { id: 'a', name: '旧笔记本', emoji: 'A', sections: [{ id: 'section-a', name: '默认', color: '', pageCount: 0 }] },
      { id: 'b', name: '新笔记本', emoji: 'B', sections: [{ id: 'section-b', name: '默认', color: '', pageCount: 1 }] },
    ]
    expect(changeSummary(moved, currentPages, notebooks)).toContain('旧笔记本')
    expect(changeSummary(moved, currentPages, notebooks)).toContain('新笔记本')
    const reordered = change({
      id: 'reorder',
      type: 'update-page',
      before: { pageId: 'page', title: '页面', markdown: '', sectionId: 'section-b', sortOrder: 1, updatedAt },
      after: { pageId: 'page', title: '页面', markdown: '', sectionId: 'section-b', sortOrder: 2, updatedAt },
    })
    expect(changeSummary(reordered, currentPages, notebooks)).toBe('同级顺序调整')
  })

  test('collapses long unchanged context and caps huge changed sections', () => {
    const visible = compactDiffParts([
      { value: Array.from({ length: 30 }, (_, index) => `context ${index}`).join('\n') },
      { value: Array.from({ length: 20 }, (_, index) => `added ${index}`).join('\n'), added: true },
    ], 5)
    expect(visible.filter((part) => part.kind === 'unchanged')).toHaveLength(2)
    expect(visible.filter((part) => part.kind === 'omitted').map((part) => part.omittedLines)).toEqual([22, 15])
    expect(visible.find((part) => part.kind === 'added')?.value.split('\n')).toHaveLength(5)
  })
})
