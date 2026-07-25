import { useMemo, useState } from 'react'
import type { AutomationProposal } from '@notebook/domain'
import type { NotebookSummary, PageSummary } from '../model'
import { flattenPageTree } from '../pageTree'
import { buildAutomationWorkspaceReview, pageLocation } from './workspaceReview'

interface AutomationWorkspaceReviewProps {
  proposal: AutomationProposal
  notebooks: NotebookSummary[]
  pages: PageSummary[]
}

export function AutomationWorkspaceReview({ proposal, notebooks, pages }: AutomationWorkspaceReviewProps) {
  const [showAll, setShowAll] = useState(false)
  const review = useMemo(() => buildAutomationWorkspaceReview(pages, proposal), [pages, proposal])
  const chips = [
    ['影响页面', review.summary.affected],
    ['新增', review.summary.created],
    ['删除', review.summary.deleted],
    ['改名', review.summary.renamed],
    ['移动/排序', review.summary.moved],
    ['正文修改', review.summary.content],
  ] as const

  return <section className="automation-workspace-review" aria-label="整个工作区变化">
    <header>
      <div><strong>整个工作区变化</strong><span>比较 AI 操作前后的完整页面结构；未变化页面作为位置参照。</span></div>
      <button type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? '只看变化路径' : '显示全部结构'}</button>
    </header>
    <div className="automation-review-summary">
      {chips.map(([label, value]) => <span key={label} className={value ? 'has-change' : ''}>{label}<strong>{value}</strong></span>)}
    </div>
    <div className="automation-tree-comparison">
      <WorkspaceTree title="修改前" pages={review.beforePages} notebooks={notebooks} affectedPageIds={review.affectedPageIds} showAll={showAll} />
      <WorkspaceTree title="批准后的状态" pages={review.afterPages} notebooks={notebooks} affectedPageIds={review.affectedPageIds} showAll={showAll} after />
    </div>
    <div className="automation-location-changes">
      {proposal.changes.map((change) => {
        const beforeLocation = change.before ? pageLocation(change.before.pageId, review.beforePages, notebooks) : '不存在'
        const afterLocation = pageLocation(change.after.pageId, review.afterPages, notebooks)
        const structural = !change.before || beforeLocation !== afterLocation
        return structural && <div key={change.id}><span>{change.type === 'delete-page' ? '移到回收站' : change.before ? '结构变化' : '新增页面'}</span><strong>{beforeLocation}</strong><b>→</b><strong>{afterLocation}</strong></div>
      })}
    </div>
  </section>
}

function WorkspaceTree({ title, pages, notebooks, affectedPageIds, showAll, after = false }: {
  title: string
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  affectedPageIds: Set<string>
  showAll: boolean
  after?: boolean
}) {
  const visibleIds = useMemo(() => {
    if (showAll) return undefined
    const byId = new Map(pages.map((page) => [page.id, page]))
    const result = new Set<string>()
    for (const id of affectedPageIds) {
      let cursor = byId.get(id)
      const seen = new Set<string>()
      while (cursor && !seen.has(cursor.id)) {
        result.add(cursor.id)
        seen.add(cursor.id)
        cursor = cursor.parentPageId ? byId.get(cursor.parentPageId) : undefined
      }
    }
    return result
  }, [affectedPageIds, pages, showAll])

  return <div className="automation-tree-pane">
    <h4>{title}</h4>
    {notebooks.map((notebook) => {
      const sections = notebook.sections.map((section) => {
        const sectionPages = pages.filter((page) => page.sectionId === section.id && page.kind !== 'task')
        const rows = flattenPageTree(sectionPages, new Set(sectionPages.map((page) => page.id)), visibleIds)
        return { section, rows }
      }).filter((item) => item.rows.length)
      if (!sections.length) return null
      return <details key={notebook.id} open><summary><span>{notebook.emoji}</span>{notebook.name}</summary>
        {sections.map(({ section, rows }) => <div key={section.id} className="automation-tree-section">
          <small>{section.name}</small>
          {rows.map(({ page, depth }) => <div key={page.id} className={`automation-tree-page ${affectedPageIds.has(page.id) ? `changed ${after ? 'after' : 'before'}` : ''}`} style={{ paddingInlineStart: `${10 + depth * 16}px` }}>
            <span>{page.icon || '▱'}</span><b>{page.title}</b>{affectedPageIds.has(page.id) && <em>{after ? '新状态' : '原状态'}</em>}
          </div>)}
        </div>)}
      </details>
    })}
  </div>
}
