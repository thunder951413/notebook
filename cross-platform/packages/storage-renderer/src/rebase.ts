import type { NotebookDataBundle, PageDocument, PageRevision, PageTag } from '@notebook/domain'
import { legacyTiptapToCanonicalMarkdown } from '@notebook/sync-contract'

function compactRevisions(documents: PageDocument[], revisions: PageRevision[]) {
  const signature = (document: PageDocument) => document.markdown ?? legacyTiptapToCanonicalMarkdown(document.tiptapJson)
  const currentDocuments = new Map(documents.map((document) => [document.pageId, signature(document)]))
  const byPage = new Map<string, PageRevision[]>()
  for (const revision of revisions) {
    const values = byPage.get(revision.pageId) ?? []
    values.push(revision)
    byPage.set(revision.pageId, values)
  }
  return [...byPage.values()].flatMap((values) => {
    let previous: string | undefined
    const compacted = values.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).filter((revision) => {
      const value = `${signature(revision.document)}\u0000${revision.pageIcon === undefined ? 'legacy' : revision.pageIcon ?? 'default'}`
      if (value === previous) return false
      previous = value
      return true
    })
    const last = compacted[compacted.length - 1]
    if (last && last.pageIcon === undefined && signature(last.document) === currentDocuments.get(last.pageId)) compacted.pop()
    return compacted.map((revision) => ({
      ...revision,
      document: {
        ...revision.document,
        markdown: signature(revision.document),
        tiptapJson: { type: 'doc', content: [] },
        yjsState: undefined,
      },
    }))
  })
}

function compactRevisionHistory(bundle: NotebookDataBundle) {
  return compactRevisions(bundle.documents, bundle.revisions)
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

function keepChangesSinceSnapshot<T>(target: T[], snapshot: T[], current: T[], keyOf: (value: T) => string): T[] {
  const result = new Map(target.map((value) => [keyOf(value), value]))
  const before = new Map(snapshot.map((value) => [keyOf(value), value]))
  const now = new Map(current.map((value) => [keyOf(value), value]))
  for (const key of new Set([...before.keys(), ...now.keys()])) {
    const previous = before.get(key)
    const latest = now.get(key)
    if (sameValue(previous, latest)) continue
    if (latest === undefined) result.delete(key)
    else result.set(key, latest)
  }
  return [...result.values()]
}

/**
 * Rebases changes made after a sync snapshot over the result that was actually
 * published. This is deliberately collection-wide: an attachment, task step,
 * tag, or reading-position edit made while SFTP is in flight must be protected
 * just as carefully as a page body.
 */
export function preserveChangesSinceSnapshot(target: NotebookDataBundle, snapshot: NotebookDataBundle, current: NotebookDataBundle): NotebookDataBundle {
  const byId = <T extends { id: string }>(value: T) => value.id
  const byPage = <T extends { pageId: string }>(value: T) => value.pageId
  const byPageTag = (value: PageTag) => `${value.pageId}:${value.tagId}`
  return {
    notebooks: keepChangesSinceSnapshot(target.notebooks, snapshot.notebooks, current.notebooks, byId),
    sections: keepChangesSinceSnapshot(target.sections, snapshot.sections, current.sections, byId),
    pages: keepChangesSinceSnapshot(target.pages, snapshot.pages, current.pages, byId),
    documents: keepChangesSinceSnapshot(target.documents, snapshot.documents, current.documents, byPage),
    tags: keepChangesSinceSnapshot(target.tags, snapshot.tags, current.tags, byId),
    pageTags: keepChangesSinceSnapshot(target.pageTags, snapshot.pageTags, current.pageTags, byPageTag),
    taskSteps: keepChangesSinceSnapshot(target.taskSteps, snapshot.taskSteps, current.taskSteps, byId),
    assets: keepChangesSinceSnapshot(target.assets, snapshot.assets, current.assets, byId),
    pageLinks: keepChangesSinceSnapshot(target.pageLinks, snapshot.pageLinks, current.pageLinks, byId),
    knowledgeEntities: keepChangesSinceSnapshot(target.knowledgeEntities, snapshot.knowledgeEntities, current.knowledgeEntities, byId),
    knowledgeRelations: keepChangesSinceSnapshot(target.knowledgeRelations, snapshot.knowledgeRelations, current.knowledgeRelations, byId),
    readingPositions: keepChangesSinceSnapshot(target.readingPositions, snapshot.readingPositions, current.readingPositions, byId),
    revisions: keepChangesSinceSnapshot(target.revisions, snapshot.revisions, current.revisions, byId),
    comments: keepChangesSinceSnapshot(target.comments, snapshot.comments, current.comments, byId),
    tombstones: keepChangesSinceSnapshot(target.tombstones, snapshot.tombstones, current.tombstones, byId),
  }
}

export { compactRevisionHistory, compactRevisions, sameValue }
