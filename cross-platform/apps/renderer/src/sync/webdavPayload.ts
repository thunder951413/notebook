import type { NotebookDataBundle, PageDocument } from '@notebook/domain'
import { legacyTiptapToCanonicalMarkdown } from '@notebook/sync-contract'

/** Shared by normal outbox publication and the initial migration snapshot. */
export function serializeWebdavPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (type === 'document') {
    const document = payload as unknown as PageDocument
    if (typeof document.markdown !== 'string' && !document.tiptapJson) throw new Error('同步正文缺少 Markdown 和旧版内容')
    return {
      ...payload,
      schemaVersion: Math.max(3, document.schemaVersion),
      markdown: document.markdown ?? legacyTiptapToCanonicalMarkdown(document.tiptapJson),
      tiptapJson: { type: 'doc', content: [] },
      yjsState: undefined,
    }
  }
  if (type === 'revision') return { ...payload, document: serializeWebdavPayload('document', payload.document as Record<string, unknown>) }
  if (type === 'asset') return { ...payload, localPath: undefined }
  return { ...payload }
}

export interface WebdavSnapshotEntry {
  type: string
  id: string
  op: 'upsert' | 'delete'
  ver: number
  payload: Record<string, unknown>
}

export function buildWebdavSnapshot(bundle: NotebookDataBundle, deviceId: string, includePrivate = false): WebdavSnapshotEntry[] {
  const entries: WebdavSnapshotEntry[] = []
  const push = (type: string, id: string, payload: object) => entries.push({
    type, id, op: 'upsert', ver: 0, payload: serializeWebdavPayload(type, { ...payload }),
  })
  const privateNotebookIds = new Set(bundle.notebooks.filter(item => !includePrivate && item.locked).map(item => item.id))
  const privateSectionIds = new Set(bundle.sections.filter(item => privateNotebookIds.has(item.notebookId)).map(item => item.id))
  const privatePageIds = new Set(bundle.pages.filter(item => !includePrivate && (item.locked || Boolean(item.sectionId && privateSectionIds.has(item.sectionId)))).map(item => item.id))
  const publicPages = bundle.pages.filter(item => !privatePageIds.has(item.id))
  const publicPageIds = new Set(publicPages.map(item => item.id))
  for (const row of bundle.notebooks.filter(item => !privateNotebookIds.has(item.id))) push('notebook', row.id, row)
  for (const row of bundle.sections.filter(item => !privateSectionIds.has(item.id))) push('section', row.id, row)
  for (const item of publicPages) push('page', item.id, { ...item, syncStatus: 'synced' })
  for (const row of bundle.documents.filter(item => publicPageIds.has(item.pageId))) push('document', row.pageId, row)
  for (const item of bundle.tags) push('tag', item.id, item)
  for (const row of bundle.pageTags.filter(item => publicPageIds.has(item.pageId))) push('page_tag', `${row.pageId}:${row.tagId}`, row)
  for (const row of bundle.taskSteps.filter(item => publicPageIds.has(item.pageId))) push('task_step', row.id, row)
  for (const row of bundle.assets.filter(item => publicPageIds.has(item.pageId))) push('asset', row.id, row)
  for (const row of bundle.pageLinks.filter(item => publicPageIds.has(item.sourcePageId) && publicPageIds.has(item.targetPageId))) push('page_link', row.id, row)
  for (const row of bundle.readingPositions.filter(item => publicPageIds.has(item.pageId))) push('reading_position', row.id, { ...row, deviceId: row.deviceId || deviceId })
  for (const row of bundle.revisions.filter(item => publicPageIds.has(item.pageId))) push('revision', row.id, row)
  const privateKeys = new Set([
    ...[...privateNotebookIds].map(id => `notebook:${id}`),
    ...[...privateSectionIds].map(id => `section:${id}`),
    ...[...privatePageIds].flatMap(id => [`page:${id}`, `document:${id}`]),
    ...bundle.pageTags.filter(item => privatePageIds.has(item.pageId)).map(item => `page_tag:${item.pageId}:${item.tagId}`),
    ...bundle.taskSteps.filter(item => privatePageIds.has(item.pageId)).map(item => `task_step:${item.id}`),
    ...bundle.assets.filter(item => privatePageIds.has(item.pageId)).map(item => `asset:${item.id}`),
    ...bundle.pageLinks.filter(item => privatePageIds.has(item.sourcePageId) || privatePageIds.has(item.targetPageId)).map(item => `page_link:${item.id}`),
    ...bundle.readingPositions.filter(item => privatePageIds.has(item.pageId)).map(item => `reading_position:${item.id}`),
    ...bundle.revisions.filter(item => privatePageIds.has(item.pageId)).map(item => `revision:${item.id}`),
  ])
  const liveByEntity = new Map(entries.map(entry => [`${entry.type}:${entry.id}`, entry]))
  // Apply deletions after historical live rows so migration cannot resurrect them.
  for (const item of bundle.tombstones) {
    if (privateKeys.has(`${item.entityType}:${item.entityId}`)) continue
    const live = liveByEntity.get(`${item.entityType}:${item.entityId}`)
    // A soft-deleted row is still recoverable trash; its deletedAt is already
    // in the upsert. Only absent/stale live rows need a destructive deletion.
    if (live?.payload.deletedAt) continue
    entries.push({ type: item.entityType, id: item.entityId, op: 'delete', ver: live ? 1 : 0, payload: {} })
  }
  return entries
}
