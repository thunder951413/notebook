import { expect, test } from 'vitest'
import type { AutomationProposal } from '@notebook/domain'
import type { NotebookSummary, PageSummary } from '../model'
import { buildAutomationWorkspaceReview, pageLocation } from './workspaceReview'

const pages: PageSummary[] = [
  { id: 'root', sectionId: 'section-a', title: '旧标题', preview: '', updatedLabel: '', tags: [], sortOrder: 1 },
  { id: 'child', sectionId: 'section-a', parentPageId: 'root', title: '子页', preview: '', updatedLabel: '', tags: [], sortOrder: 1 },
  { id: 'target', sectionId: 'section-b', title: '目标', preview: '', updatedLabel: '', tags: [], sortOrder: 1 },
]
const proposal: AutomationProposal = {
  id: 'proposal',
  workspaceId: 'workspace',
  title: '重组',
  source: 'test',
  status: 'pending',
  createdAt: '2026-07-25T00:00:00.000Z',
  changes: [
    {
      id: 'rename-move',
      type: 'update-page',
      before: { pageId: 'root', title: '旧标题', markdown: '旧正文', sectionId: 'section-a', sortOrder: 1, updatedAt: 'before' },
      after: { pageId: 'root', title: '新标题', markdown: '新正文', sectionId: 'section-b', parentPageId: 'target', sortOrder: 2, updatedAt: 'after' },
    },
    {
      id: 'create',
      type: 'create-page',
      after: { pageId: 'new', title: '新增页', markdown: '# 新增', sectionId: 'section-b', parentPageId: 'target', updatedAt: 'after' },
    },
  ],
}

test('builds complete before and after workspace states with categorized changes', () => {
  const review = buildAutomationWorkspaceReview(pages, proposal)
  expect(review.beforePages.find((page) => page.id === 'root')).toMatchObject({ title: '旧标题', sectionId: 'section-a' })
  expect(review.beforePages.some((page) => page.id === 'new')).toBe(false)
  expect(review.afterPages.find((page) => page.id === 'root')).toMatchObject({ title: '新标题', sectionId: 'section-b', parentPageId: 'target' })
  expect(review.afterPages.find((page) => page.id === 'new')).toMatchObject({ title: '新增页', parentPageId: 'target' })
  expect(review.summary).toEqual({ created: 1, deleted: 0, renamed: 1, moved: 1, content: 2, affected: 2 })
})

test('describes human-readable locations using notebook, section and ancestors', () => {
  const notebooks: NotebookSummary[] = [
    { id: 'book-a', name: '笔记本 A', emoji: 'A', sections: [{ id: 'section-a', name: '分区 A', color: '', pageCount: 2 }] },
    { id: 'book-b', name: '笔记本 B', emoji: 'B', sections: [{ id: 'section-b', name: '分区 B', color: '', pageCount: 1 }] },
  ]
  expect(pageLocation('child', pages, notebooks)).toBe('笔记本 A › 分区 A › 旧标题 › 子页')
})

test('removes recoverably deleted pages from the proposed tree', () => {
  const deleted: AutomationProposal = {
    id: 'delete-proposal',
    workspaceId: 'workspace',
    title: '清理旧页面',
    source: 'test',
    status: 'pending',
    createdAt: '2026-07-25T00:00:00.000Z',
    changes: [{
      id: 'delete-child',
      type: 'delete-page',
      before: { pageId: 'child', title: '子页', markdown: '正文', sectionId: 'section-a', parentPageId: 'root', updatedAt: 'before' },
      after: { pageId: 'child', title: '子页', markdown: '正文', sectionId: 'section-a', parentPageId: 'root', deletedAt: 'after', updatedAt: 'after' },
    }],
  }
  const review = buildAutomationWorkspaceReview(pages, deleted)
  expect(review.beforePages.some((page) => page.id === 'child')).toBe(true)
  expect(review.afterPages.some((page) => page.id === 'child')).toBe(false)
  expect(review.summary).toMatchObject({ affected: 1, deleted: 1 })
})
