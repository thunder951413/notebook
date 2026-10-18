import Dexie, { type EntityTable } from 'dexie'
import type {
  Asset,
  AutomationProposal,
  KnowledgeEntity,
  KnowledgeRelation,
  Notebook,
  Page,
  PageComment,
  PageDocument,
  PageLink,
  PageRevision,
  PageTag,
  ReadingPosition,
  Section,
  Tag,
  TaskStep,
  Tombstone,
} from '@notebook/domain'
import { legacyTiptapToCanonicalMarkdown, markdownToEditorCache, migrateLegacyPageDocument, sha256Hex } from '@notebook/sync-contract'
import { compactRevisions } from './rebase'
import { extractText } from './util'

export interface SyncOutboxItem {
  id: string
  workspaceId: string
  entityType: string
  entityId: string
  expectedVersion: number
  operation: 'upsert' | 'delete'
  payload: Record<string, unknown>
  createdAt: string
}

/**
 * Why one remote record was set aside instead of applied. The codes are shared
 * with Android; a record is retried when its cause may have gone away.
 */
export type QuarantineReason =
  | 'unknown-type' | 'invalid-payload' | 'workspace-mismatch'
  | 'missing-object' | 'object-corrupt' | 'needs-key' | 'bad-key'

/**
 * A remote record this device could not apply. Its read position moves past it
 * (so everything else keeps syncing) in the same transaction that stores it
 * here, which makes it durable and retryable instead of lost.
 */
export interface SyncQuarantineItem {
  /** `${repository}|${deviceId}|${seq}` */
  id: string
  workspaceId: string
  repository: string
  deviceId: string
  seq: number
  entityType: string
  entityId: string
  version: number
  operation: 'upsert' | 'delete'
  reason: QuarantineReason
  message: string
  /** `materialize`: raw is the journal payload as downloaded. `apply`: raw is the final decoded payload. */
  stage: 'materialize' | 'apply'
  raw: Record<string, unknown>
  hash?: string
  /** The payload came out of authenticated decryption (private data). */
  authenticated?: boolean
  attempts: number
  firstSeenAt: string
  lastTriedAt: string
}

export interface SyncCursor {
  workspaceId: string
  cursor: number
  /** WebDAV per-device read positions, committed atomically with applied records. */
  seqs?: Record<string, number>
}
export interface SyncVersion {
  id: string
  version: number
  /** Set only when `version` is the result of applying a WebDAV parent `ver`. */
  webdavParentVersion?: true
}
export interface AssetContent { id: string; data: Blob }
export interface PageDraft { pageId: string; document: PageDocument; createdAt: string }
export interface EditorCache {
  pageId: string
  sourceVersion: string
  tiptapJson: Record<string, unknown>
  byteSize: number
  accessedAt: string
}

export const MAX_EDITOR_CACHE_BYTES = 64 * 1024 * 1024
/**
 * Per-page history is a bounded ring. Current page/document state is stored in
 * separate tables, so evicting an old revision can never remove live content.
 */
export const MAX_AUTOSAVE_REVISIONS_PER_PAGE = 50
export const MAX_PINNED_REVISIONS_PER_PAGE = 20
export const MAX_REVISIONS_PER_PAGE = MAX_AUTOSAVE_REVISIONS_PER_PAGE + MAX_PINNED_REVISIONS_PER_PAGE

export class NotebookRendererDatabase extends Dexie {
  notebooks!: EntityTable<Notebook, 'id'>
  sections!: EntityTable<Section, 'id'>
  pages!: EntityTable<Page, 'id'>
  documents!: EntityTable<PageDocument, 'pageId'>
  tags!: EntityTable<Tag, 'id'>
  taskSteps!: EntityTable<TaskStep, 'id'>
  pageLinks!: EntityTable<PageLink, 'id'>
  knowledgeEntities!: EntityTable<KnowledgeEntity, 'id'>
  knowledgeRelations!: EntityTable<KnowledgeRelation, 'id'>
  assets!: EntityTable<Asset, 'id'>
  pageTags!: EntityTable<PageTag>
  readingPositions!: EntityTable<ReadingPosition, 'id'>
  tombstones!: EntityTable<Tombstone, 'id'>
  syncOutbox!: EntityTable<SyncOutboxItem, 'id'>
  syncCursors!: EntityTable<SyncCursor, 'workspaceId'>
  syncQuarantine!: EntityTable<SyncQuarantineItem, 'id'>
  syncVersions!: EntityTable<SyncVersion, 'id'>
  assetContents!: EntityTable<AssetContent, 'id'>
  revisions!: EntityTable<PageRevision, 'id'>
  comments!: EntityTable<PageComment, 'id'>
  drafts!: EntityTable<PageDraft, 'pageId'>
  editorCaches!: EntityTable<EditorCache, 'pageId'>
  automationProposals!: EntityTable<AutomationProposal, 'id'>

  constructor(name = 'notebook-next') {
    super(name)
    this.version(1).stores({
      notebooks: 'id, workspaceId, sortOrder, updatedAt, deletedAt',
      sections: 'id, notebookId, parentSectionId, sortOrder, updatedAt, deletedAt',
      pages: 'id, workspaceId, sectionId, kind, updatedAt, deletedAt, syncStatus, *title',
      documents: 'pageId, updatedAt',
      tags: 'id, workspaceId, name, updatedAt, deletedAt',
      taskSteps: 'id, pageId, sortOrder',
    })
    this.version(2).stores({
      pageLinks: 'id, workspaceId, sourcePageId, targetPageId, kind',
      knowledgeEntities: 'id, workspaceId, name, type, *sourcePageIds, updatedAt',
      knowledgeRelations: 'id, workspaceId, sourceEntityId, targetEntityId, type, evidencePageId, updatedAt',
    })
    this.version(3).stores({
      assets: 'id, pageId, kind, checksum',
      pageTags: '[pageId+tagId], pageId, tagId',
      readingPositions: 'id, pageId, updatedAt',
      tombstones: 'id, workspaceId, entityType, entityId, deletedAt',
    })
    this.version(4).stores({
      syncOutbox: 'id, workspaceId, createdAt, [entityType+entityId]',
      syncCursors: 'workspaceId',
      syncVersions: 'id',
    })
    this.version(5).stores({ assetContents: 'id' })
    this.version(6).stores({ revisions: 'id, pageId, createdAt' })
    this.version(7).stores({ comments: 'id, workspaceId, pageId, createdAt, resolvedAt' })
    this.version(8).stores({ drafts: 'pageId, createdAt' })
    this.version(9).stores({}).upgrade(async (transaction) => {
      await transaction.table<PageRevision>('revisions').toCollection().modify((revision) => {
        revision.document = migrateLegacyPageDocument(revision.document)
      })
    })
    this.version(10).stores({}).upgrade(async (transaction) => {
      const documents = transaction.table<PageDocument>('documents')
      const revisions = transaction.table<PageRevision>('revisions')
      const pages = transaction.table<Page>('pages')
      const drafts = transaction.table<PageDraft>('drafts')
      const legacyDocuments = (await documents.toArray()).filter((document) => document.schemaVersion < 3 || document.markdown === undefined)
      for (const document of legacyDocuments) {
        const previousMarkdown = legacyTiptapToCanonicalMarkdown(document.tiptapJson)
        const migrated = migrateLegacyPageDocument(document)
        await revisions.put({
          id: crypto.randomUUID(),
          pageId: document.pageId,
          // Keep a recovery point without retaining the obsolete rich-text
          // cache. Markdown is the durable body; the editor JSON is disposable.
          document: migrated,
          createdAt: new Date().toISOString(),
          reason: 'import',
        })
        await documents.put(migrated)
        const page = await pages.get(document.pageId)
        if (page) await pages.put({
          ...page,
          syncStatus: 'pending',
          legacyMetadata: {
            ...page.legacyMetadata,
            // The current SSH v3 repository was produced from the old Tiptap
            // cache using this exact serializer. Treat that body as the merge
            // base so normalization publishes as a local edit instead of
            // reporting a conflict on every migrated page.
            syncBaselineHash: typeof page.legacyMetadata?.syncBaselineHash === 'string'
              ? page.legacyMetadata.syncBaselineHash
              : sha256Hex(previousMarkdown),
          },
        })
      }
      const legacyDrafts = (await drafts.toArray()).filter((draft) => draft.document.schemaVersion < 3 || draft.document.markdown === undefined)
      for (const draft of legacyDrafts) await drafts.put({ ...draft, document: migrateLegacyPageDocument(draft.document) })
    })
    this.version(11).stores({}).upgrade(async (transaction) => {
      const documents = await transaction.table<PageDocument>('documents').toArray()
      const revisionTable = transaction.table<PageRevision>('revisions')
      const revisions = (await revisionTable.toArray()).map((revision) => ({
        ...revision,
        document: migrateLegacyPageDocument(revision.document),
      }))
      const compacted = compactRevisions(documents, revisions)
      await revisionTable.clear()
      await revisionTable.bulkPut(compacted)
    })
    // Version 12 was exercised by a local pre-release build. Keep the version
    // slot so that database 12 can move forward, but perform the final,
    // idempotent normalization in version 13 below.
    this.version(12).stores({})
    this.version(13).stores({}).upgrade(async (transaction) => {
      const documentTable = transaction.table<PageDocument>('documents')
      const revisionTable = transaction.table<PageRevision>('revisions')
      const pageTable = transaction.table<Page>('pages')
      const draftTable = transaction.table<PageDraft>('drafts')
      const documents = await documentTable.toArray()
      const normalizedDocuments = documents.map(migrateLegacyPageDocument)
      await documentTable.bulkPut(normalizedDocuments)
      for (let index = 0; index < documents.length; index += 1) {
        if (documents[index]?.markdown === normalizedDocuments[index]?.markdown) continue
        const page = await pageTable.get(documents[index]!.pageId)
        if (page) await pageTable.put({ ...page, syncStatus: 'pending' })
      }
      await pageTable.toCollection().modify((page) => {
        const title = page.title.trim()
        if (title !== page.title) {
          page.title = title
          page.syncStatus = 'pending'
        }
      })
      const revisions = (await revisionTable.toArray()).map((revision) => ({
        ...revision,
        document: migrateLegacyPageDocument(revision.document),
      }))
      const compacted = compactRevisions(normalizedDocuments, revisions)
      await revisionTable.clear()
      await revisionTable.bulkPut(compacted)
      await draftTable.toCollection().modify((draft) => {
        draft.document = migrateLegacyPageDocument(draft.document)
      })
    })
    this.version(14).stores({}).upgrade(async (transaction) => {
      const pages = transaction.table<Page>('pages')
      const sections = await transaction.table<Section>('sections').toArray()
      const notebooks = await transaction.table<Notebook>('notebooks').toArray()
      const publicInbox = sections.find((section) => section.id === 'inbox')
        ?? sections.find((section) => !notebooks.find((notebook) => notebook.id === section.notebookId)?.locked)
      const privateInbox = sections.find((section) => notebooks.find((notebook) => notebook.id === section.notebookId)?.locked)
      await pages.toCollection().modify((page) => {
        if (page.sectionId) return
        const fallback = page.locked ? privateInbox : publicInbox
        if (!fallback) return
        page.sectionId = fallback.id
        page.syncStatus = 'pending'
      })
    })
    this.version(15).stores({}).upgrade(async (transaction) => {
      const documents = await transaction.table<PageDocument>('documents').toArray()
      const pages = transaction.table<Page>('pages')
      for (const document of documents) {
        if (document.markdown === undefined) continue
        const page = await pages.get(document.pageId)
        if (!page) continue
        const preview = extractText(markdownToEditorCache(document.markdown)).replace(/\s+/g, ' ').trim().slice(0, 240)
        if (preview !== page.preview) await pages.put({ ...page, preview, syncStatus: 'pending' })
      }
    })
    this.version(16).stores({
      pages: 'id, workspaceId, sectionId, parentPageId, kind, updatedAt, treeUpdatedAt, deletedAt, syncStatus, *title, [sectionId+parentPageId+sortOrder]',
    }).upgrade(async (transaction) => {
      const pages = transaction.table<Page>('pages')
      const records = (await pages.toArray()).sort((left, right) =>
        (left.sectionId ?? '').localeCompare(right.sectionId ?? '')
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      const counters = new Map<string, number>()
      for (const page of records) {
        if (page.sortOrder !== undefined && page.treeUpdatedAt) continue
        const key = `${page.sectionId ?? ''}:${page.parentPageId ?? ''}`
        const sortOrder = page.sortOrder ?? (counters.get(key) ?? 0) + 1000
        counters.set(key, Math.max(counters.get(key) ?? 0, sortOrder))
        await pages.put({
          ...page,
          sortOrder,
          treeUpdatedAt: page.treeUpdatedAt ?? page.createdAt,
          syncStatus: page.syncStatus === 'conflict' ? 'conflict' : 'pending',
        })
      }
    })
    // Parsed editor JSON is device-local and disposable. Keeping it outside
    // `documents` prevents it from entering sync, history, or exported data.
    this.version(17).stores({ editorCaches: 'pageId, sourceVersion, accessedAt' })
    this.version(18).stores({ automationProposals: 'id, workspaceId, status, createdAt' })
    this.version(19).stores({}).upgrade(async (transaction) => {
      const revisions = transaction.table<PageRevision>('revisions')
      const grouped = new Map<string, PageRevision[]>()
      for (const revision of await revisions.toArray()) {
        const values = grouped.get(revision.pageId) ?? []
        values.push(revision)
        grouped.set(revision.pageId, values)
      }
      const staleIds: string[] = []
      for (const values of grouped.values()) {
        values.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        staleIds.push(...values.filter((revision) => revision.reason === 'autosave').slice(MAX_AUTOSAVE_REVISIONS_PER_PAGE).map((revision) => revision.id))
        staleIds.push(...values.filter((revision) => revision.reason !== 'autosave').slice(MAX_PINNED_REVISIONS_PER_PAGE).map((revision) => revision.id))
      }
      if (staleIds.length) {
        await revisions.bulkDelete(staleIds)
        const stale = new Set(staleIds)
        const outbox = transaction.table<SyncOutboxItem>('syncOutbox')
        const staleOutboxIds = (await outbox.toArray())
          .filter((item) => item.entityType === 'revision' && stale.has(item.entityId))
          .map((item) => item.id)
        if (staleOutboxIds.length) await outbox.bulkDelete(staleOutboxIds)
      }
    })
    // Lets the outbox be read oldest-first per workspace (queue order).
    this.version(20).stores({ syncOutbox: 'id, workspaceId, createdAt, [workspaceId+createdAt], [entityType+entityId]' })
    this.version(21).stores({ syncQuarantine: 'id, workspaceId, repository, reason' })
  }
}
