import type { AutomationProposal, AutomationProposalPageState } from '@notebook/domain'
import type { NotebookSummary, PageSummary } from '../model'

export interface AutomationReviewSummary {
  created: number
  deleted: number
  renamed: number
  moved: number
  content: number
  affected: number
}

export interface AutomationWorkspaceReview {
  beforePages: PageSummary[]
  afterPages: PageSummary[]
  affectedPageIds: Set<string>
  summary: AutomationReviewSummary
}

function applyProposalState(page: PageSummary, state: AutomationProposalPageState): PageSummary {
  return {
    ...page,
    id: state.pageId,
    sectionId: state.sectionId ?? '',
    parentPageId: state.parentPageId,
    sortOrder: state.sortOrder,
    title: state.title,
  }
}

function pageFromProposal(state: AutomationProposalPageState): PageSummary {
  return {
    id: state.pageId,
    sectionId: state.sectionId ?? '',
    parentPageId: state.parentPageId,
    sortOrder: state.sortOrder,
    title: state.title,
    preview: '',
    updatedLabel: '',
    tags: [],
    kind: 'document',
  }
}

export function buildAutomationWorkspaceReview(pages: PageSummary[], proposal: AutomationProposal): AutomationWorkspaceReview {
  const before = new Map(pages.map((page) => [page.id, page]))
  const after = new Map(pages.map((page) => [page.id, page]))
  const affectedPageIds = new Set<string>()
  const summary: AutomationReviewSummary = { created: 0, deleted: 0, renamed: 0, moved: 0, content: 0, affected: proposal.changes.length }

  for (const change of proposal.changes) {
    affectedPageIds.add(change.after.pageId)
    if (change.type === 'delete-page' || change.after.deletedAt) {
      const current = pages.find((page) => page.id === change.after.pageId) ?? (change.before ? pageFromProposal(change.before) : undefined)
      if (current && change.before) before.set(change.before.pageId, applyProposalState(current, change.before))
      after.delete(change.after.pageId)
      summary.deleted += 1
      continue
    }
    if (change.before) {
      const current = pages.find((page) => page.id === change.before!.pageId) ?? pageFromProposal(change.before)
      before.set(change.before.pageId, applyProposalState(current, change.before))
      after.set(change.after.pageId, applyProposalState(current, change.after))
      if (change.before.title !== change.after.title) summary.renamed += 1
      if (change.before.sectionId !== change.after.sectionId
        || change.before.parentPageId !== change.after.parentPageId
        || change.before.sortOrder !== change.after.sortOrder) summary.moved += 1
      if (change.before.markdown !== change.after.markdown) summary.content += 1
    } else {
      before.delete(change.after.pageId)
      after.set(change.after.pageId, pageFromProposal(change.after))
      summary.created += 1
      if (change.after.markdown) summary.content += 1
    }
  }

  return { beforePages: [...before.values()], afterPages: [...after.values()], affectedPageIds, summary }
}

export function pageLocation(pageId: string, pages: PageSummary[], notebooks: NotebookSummary[]) {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const page = byId.get(pageId)
  if (!page) return '不存在'
  const section = notebooks.flatMap((notebook) => notebook.sections.map((value) => ({ notebook, section: value }))).find((item) => item.section.id === page.sectionId)
  const ancestors: string[] = []
  const seen = new Set<string>()
  let cursor = page.parentPageId ? byId.get(page.parentPageId) : undefined
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    ancestors.unshift(cursor.title)
    cursor = cursor.parentPageId ? byId.get(cursor.parentPageId) : undefined
  }
  return [section?.notebook.name, section?.section.name, ...ancestors, page.title].filter(Boolean).join(' › ')
}
