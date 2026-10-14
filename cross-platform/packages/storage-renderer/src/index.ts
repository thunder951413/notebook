import type { AutomationProposal, NotebookRepository, Page, PageDocument, UUID, Tombstone, PageRevision } from '@notebook/domain'
import { legacyTiptapToCanonicalMarkdown } from '@notebook/sync-contract'
import { searchWorkspaceCandidatesWith, searchWorkspaceHitsWith, searchWorkspaceWith } from './search'
import { TransferRepository } from './repository/transfer'

export type { RemoteSyncChange, RemoteApplyResult } from './remotePayload'
export type { SyncOutboxItem } from './database'
export { NotebookRendererDatabase, MAX_AUTOSAVE_REVISIONS_PER_PAGE, MAX_EDITOR_CACHE_BYTES, MAX_PINNED_REVISIONS_PER_PAGE, MAX_REVISIONS_PER_PAGE } from './database'
export { preserveChangesSinceSnapshot } from './rebase'
export { markdownToPlainText, matchedTerms, searchQueryTerms, searchSnippet, searchTokenize, type SearchHit } from './search'

/**
 * The renderer's IndexedDB repository. Responsibilities are layered in
 * ./repository (core → content → sync → transfer); this class adds
 * automation proposals and search and is the public entry point.
 */
export class DexieNotebookRepository extends TransferRepository implements NotebookRepository {
  saveAutomationProposal(proposal: AutomationProposal) { return this.db.automationProposals.put(proposal) }
  getAutomationProposal(id: UUID) { return this.db.automationProposals.get(id) }
  listAutomationProposals(workspaceId: UUID) {
    return this.db.automationProposals.where('workspaceId').equals(workspaceId).reverse().sortBy('createdAt')
  }
  async updateAutomationProposalStatus(id: UUID, status: AutomationProposal['status']) {
    const proposal = await this.db.automationProposals.get(id)
    if (!proposal) throw new Error('AI 修改提案不存在')
    await this.db.automationProposals.put({ ...proposal, status, reviewedAt: new Date().toISOString() })
  }
  async applyAutomationProposal(
    proposalId: UUID,
    prepared: Array<{ page: Page; document?: PageDocument; previousPageId?: UUID; delete?: boolean; deviceId?: string }>,
    acceptedChangeIds?: UUID[],
  ) {
    return this.db.transaction('rw', [this.db.automationProposals, this.db.pages, this.db.documents, this.db.revisions, this.db.tombstones, this.db.syncOutbox, this.db.syncVersions, this.db.drafts], async () => {
      const proposal = await this.db.automationProposals.get(proposalId)
      if (!proposal || proposal.status !== 'pending') throw new Error('AI 修改提案不存在或已经审阅')
      const acceptedIds = new Set(acceptedChangeIds ?? proposal.changes.map((change) => change.id))
      const acceptedChanges = proposal.changes.filter((change) => acceptedIds.has(change.id))
      if (!acceptedChanges.length) throw new Error('至少需要接受一项 AI 修改')
      for (const change of acceptedChanges) {
        if (!change.before) continue
        const current = await this.db.pages.get(change.before.pageId)
        if (!current || current.updatedAt !== change.before.updatedAt) throw Object.assign(new Error(`“${change.before.title}”在提案生成后已变化`), { code: 'stale' })
      }
      for (const value of prepared) {
        const existing = value.previousPageId ? await this.db.pages.get(value.previousPageId) : undefined
        const existingDocument = value.previousPageId ? await this.db.documents.get(value.previousPageId) : undefined
        if (existing && existingDocument) {
          const revision: PageRevision = {
            id: crypto.randomUUID(),
            pageId: existing.id,
            pageIcon: existing.icon ?? null,
            document: {
              ...existingDocument,
              markdown: existingDocument.markdown ?? legacyTiptapToCanonicalMarkdown(existingDocument.tiptapJson),
              tiptapJson: { type: 'doc', content: [] },
              yjsState: undefined,
            },
            createdAt: value.document?.updatedAt ?? value.page.updatedAt,
            reason: 'manual',
          }
          await this.db.revisions.put(revision)
          await this.enqueueChange(existing.workspaceId, 'revision', revision.id, 'upsert', revision as unknown as Record<string, unknown>)
          await this.pruneRevisionRing(existing.workspaceId, existing.id)
        }
        if (value.delete) {
          const deletedAt = value.page.deletedAt ?? value.page.updatedAt
          const tombstone: Tombstone = {
            id: `page:${value.page.id}`,
            workspaceId: value.page.workspaceId,
            entityType: 'page',
            entityId: value.page.id,
            deletedAt,
            deviceId: value.deviceId ?? 'electron-ai',
          }
          await this.db.pages.put({ ...value.page, deletedAt, syncStatus: 'pending', updatedAt: deletedAt })
          await this.db.tombstones.put(tombstone)
          await this.db.drafts.delete(value.page.id)
          await this.enqueueChange(value.page.workspaceId, 'page', value.page.id, 'delete', {})
          continue
        }
        if (!value.document) throw new Error(`AI 修改缺少页面正文：${value.page.title}`)
        await this.db.pages.put(value.page)
        await this.db.documents.put(value.document)
        await this.db.drafts.delete(value.page.id)
        await this.enqueueChange(value.page.workspaceId, 'page', value.page.id, 'upsert', value.page as unknown as Record<string, unknown>)
        await this.enqueueChange(value.page.workspaceId, 'document', value.page.id, 'upsert', { ...value.document, yjsState: undefined })
      }
      await this.db.automationProposals.put({
        ...proposal,
        status: 'applied',
        acceptedChangeIds: acceptedChanges.map((change) => change.id),
        rejectedChangeIds: proposal.changes.filter((change) => !acceptedIds.has(change.id)).map((change) => change.id),
        reviewedAt: new Date().toISOString(),
      })
    }).finally(() => this.searchIndex.invalidate(prepared[0]?.page.workspaceId ?? ''))
  }
  async searchWorkspace(workspaceId: UUID, query: string, limit = 50): Promise<Page[]> {
    return searchWorkspaceWith(this.db, this.searchIndex, workspaceId, query, limit)
  }

  /**
   * Returns a high-recall candidate set using only the cached inverted index.
   * Unlike the user-facing search ranking above, this deliberately avoids the
   * O(page count) exact-substring pass. Callers must verify the small result
   * set before presenting an exact semantic such as an unlinked mention.
   */
  async searchWorkspaceCandidates(workspaceId: UUID, query: string, limit = 200): Promise<Page[]> {
    return searchWorkspaceCandidatesWith(this.db, this.searchIndex, workspaceId, query, limit)
  }

  /** Full-text hits with excerpts for the search panel (title, preview and body). */
  async searchWorkspaceHits(workspaceId: UUID, query: string, limit = 30) {
    return searchWorkspaceHitsWith(this.db, this.searchIndex, workspaceId, query, limit)
  }
}
