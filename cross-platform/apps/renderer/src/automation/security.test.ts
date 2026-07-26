import { expect, test } from 'vitest'
import type { AutomationProposal, Page } from '@notebook/domain'
import {
  isPublicAutomationPage,
  externalProposalView,
  validateAcceptedStructuralDependencies,
  validateAutomationMarkdown,
  validateProposalOperations,
} from './automationBridge'

const now = '2026-07-26T00:00:00.000Z'
const page = (id: string, parentPageId?: string): Page => ({
  id,
  workspaceId: 'workspace',
  sectionId: 'section-old',
  parentPageId,
  kind: 'document',
  title: id,
  preview: '',
  favorite: false,
  createdAt: now,
  updatedAt: now,
  syncStatus: 'synced',
})

test('rejects executable or remotely tracking AI Markdown', () => {
  expect(() => validateAutomationMarkdown('[危险](javascript:alert(1))')).toThrow('危险 URI')
  expect(() => validateAutomationMarkdown('<img src="https://tracker.example/pixel">')).toThrow('HTML 图片')
  expect(() => validateAutomationMarkdown('![跟踪](https://tracker.example/pixel.png)')).toThrow('notebook-asset')
  expect(() => validateAutomationMarkdown('<script>alert(1)</script>')).toThrow('脚本')
  expect(() => validateAutomationMarkdown('```js\nconst scheme = "javascript:"\n```')).not.toThrow()
})

test('preserves the exact attachment reference set in AI edits', () => {
  const baseline = '正文\n\n![图](notebook-asset:asset-1)'
  expect(() => validateAutomationMarkdown(`改写正文\n\n![图](notebook-asset:asset-1)`, baseline)).not.toThrow()
  expect(() => validateAutomationMarkdown('删除了图片', baseline)).toThrow('不得删除')
  expect(() => validateAutomationMarkdown(`${baseline}\n\n[附件](notebook-asset:invented)`, baseline)).toThrow('不得新增')
  expect(() => validateAutomationMarkdown('![新图](notebook-asset:invented)')).toThrow('不得新增')
})

test('excludes locked pages even inside a public section', () => {
  expect(isPublicAutomationPage(page('public'), new Set(['section-old']))).toBe(true)
  expect(isPublicAutomationPage({ ...page('locked'), locked: true }, new Set(['section-old']))).toBe(false)
})

test('redacts stored proposal snapshots after a page becomes private or deleted', () => {
  const proposal: AutomationProposal = {
    id: 'proposal-private',
    workspaceId: 'workspace',
    title: '曾经公开的修改',
    source: 'external-ai',
    status: 'pending',
    createdAt: now,
    changes: [{
      id: 'change-private',
      type: 'update-page',
      before: { pageId: 'now-private', title: '秘密', markdown: '绝不能再次返回', sectionId: 'section-old', updatedAt: now },
      after: { pageId: 'now-private', title: '秘密', markdown: '绝不能再次返回', sectionId: 'section-old', updatedAt: now },
    }],
  }
  const result = externalProposalView(proposal, new Set()) as { redacted?: boolean; changes?: unknown; changeCount?: number }
  expect(result).toMatchObject({ redacted: true, changeCount: 1 })
  expect(result.changes).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('绝不能再次返回')
})

test('rejects duplicate operations against the same existing page', () => {
  expect(() => validateProposalOperations([
    { type: 'update-page', pageId: 'same', expectedUpdatedAt: now, title: 'A' },
    { type: 'delete-page', pageId: 'same', expectedUpdatedAt: now },
  ])).toThrow('多次操作')
})

test('requires implicit descendant moves to be accepted with their parent', () => {
  const parent = page('parent')
  const child = page('child', 'parent')
  const proposal: AutomationProposal = {
    id: 'proposal',
    workspaceId: 'workspace',
    title: '移动树',
    source: 'test',
    status: 'pending',
    createdAt: now,
    changes: [
      {
        id: 'move-parent',
        type: 'update-page',
        before: { pageId: 'parent', title: 'parent', markdown: '', sectionId: 'section-old', updatedAt: now },
        after: { pageId: 'parent', title: 'parent', markdown: '', sectionId: 'section-new', updatedAt: now },
      },
      {
        id: 'move-child',
        type: 'update-page',
        before: { pageId: 'child', title: 'child', markdown: '', sectionId: 'section-old', parentPageId: 'parent', updatedAt: now },
        after: { pageId: 'child', title: 'child', markdown: '', sectionId: 'section-new', parentPageId: 'parent', updatedAt: now },
      },
    ],
  }
  expect(() => validateAcceptedStructuralDependencies(proposal, new Set(['move-parent']), [parent, child])).toThrow('全部子页面')
  expect(() => validateAcceptedStructuralDependencies(proposal, new Set(['move-parent', 'move-child']), [parent, child])).not.toThrow()
})
