export type UUID = string
export type IsoDate = string
export type PageKind = 'document' | 'task'
export type SyncStatus = 'local' | 'pending' | 'synced' | 'conflict' | 'error'

export interface Workspace {
  id: UUID
  name: string
  createdAt: IsoDate
  updatedAt: IsoDate
}

export interface Notebook {
  id: UUID
  workspaceId: UUID
  name: string
  emoji?: string
  color?: string
  sortOrder: number
  createdAt: IsoDate
  updatedAt: IsoDate
  deletedAt?: IsoDate
  /** Access-controlled notebook. Its pages stay out of lists, search and AI until locally unlocked. */
  locked?: boolean
}

export interface Section {
  id: UUID
  notebookId: UUID
  parentSectionId?: UUID
  name: string
  color?: string
  sortOrder: number
  createdAt: IsoDate
  updatedAt: IsoDate
  deletedAt?: IsoDate
}

export interface Page {
  id: UUID
  workspaceId: UUID
  sectionId?: UUID
  /** Optional user-selected emoji. Empty/undefined uses the tree's document/folder fallback icon. */
  icon?: string
  /** Parent document in the section's ordered document tree. */
  parentPageId?: UUID
  /** Sparse sibling order. Values are local metadata and sync independently from Markdown. */
  sortOrder?: number
  /** Last structural move/reorder time, used to merge tree edits independently from body edits. */
  treeUpdatedAt?: IsoDate
  kind: PageKind
  title: string
  preview: string
  favorite: boolean
  createdAt: IsoDate
  updatedAt: IsoDate
  deletedAt?: IsoDate
  reminderAt?: IsoDate
  recurrenceRule?: string
  dueAt?: IsoDate
  completedAt?: IsoDate
  important?: boolean
  assigneeIds?: UUID[]
  syncStatus: SyncStatus
  legacyVersion?: number
  locked?: boolean
  legacyMetadata?: Record<string, unknown>
}

export interface Tag {
  id: UUID
  workspaceId: UUID
  name: string
  color: string
  createdAt: IsoDate
  updatedAt: IsoDate
  deletedAt?: IsoDate
}

export interface TaskStep {
  id: UUID
  pageId: UUID
  text: string
  checked: boolean
  sortOrder: number
  createdAt: IsoDate
}

export interface Asset {
  id: UUID
  pageId: UUID
  kind: 'image' | 'audio' | 'video' | 'file'
  filename: string
  mimeType: string
  byteSize?: number
  width?: number
  height?: number
  duration?: number
  /** Markdown resource presentation metadata; binary content remains immutable. */
  caption?: string
  displayWidth?: number
  alignment?: 'left' | 'center' | 'right'
  sidecarPaths?: string[]
  parentAssetId?: UUID
  role?: 'sidecar'
  checksum?: string
  localPath?: string
  remoteUrl?: string
  createdAt: IsoDate
}

export interface PageLink {
  id: UUID
  workspaceId: UUID
  sourcePageId: UUID
  targetPageId: UUID
  kind: 'link' | 'mention' | 'embed'
  excerpt?: string
  createdAt: IsoDate
}

export interface KnowledgeEntity {
  id: UUID
  workspaceId: UUID
  name: string
  type: string
  description: string
  sourcePageIds: UUID[]
  createdAt: IsoDate
  updatedAt: IsoDate
}

export interface KnowledgeRelation {
  id: UUID
  workspaceId: UUID
  sourceEntityId: UUID
  targetEntityId: UUID
  type: string
  evidence: string
  evidencePageId: UUID
  confidence: number
  createdAt: IsoDate
  updatedAt: IsoDate
}

export interface PageDocument {
  pageId: UUID
  schemaVersion: number
  /** Canonical durable body. Tiptap JSON is a rebuildable local editor cache. */
  markdown?: string
  tiptapJson: Record<string, unknown>
  yjsState?: Uint8Array
  /** Lossless source payload retained when an older document contains formatting the current editor cannot render yet. */
  legacySource?: Record<string, unknown>
  updatedAt: IsoDate
}

export interface ReadingPosition {
  id: UUID
  pageId: UUID
  anchorUtf16Offset: number
  viewportOffsetFraction: number
  updatedAt: IsoDate
  deviceId: string
}

export interface PageRevision {
  id: UUID
  pageId: UUID
  /** Page icon at the time of the snapshot. Older revisions omit this field. */
  pageIcon?: string | null
  document: PageDocument
  createdAt: IsoDate
  reason: 'autosave' | 'manual' | 'restore' | 'import'
}

export interface PageComment {
  id: UUID
  workspaceId: UUID
  pageId: UUID
  authorName: string
  body: string
  createdAt: IsoDate
  updatedAt: IsoDate
  resolvedAt?: IsoDate
}

export interface Tombstone {
  id: string
  workspaceId: UUID
  entityType: 'page' | 'section' | 'tag'
  entityId: UUID
  deletedAt: IsoDate
  deviceId: string
}

export interface PageTag {
  pageId: UUID
  tagId: UUID
}

export interface NotebookDataBundle {
  notebooks: Notebook[]
  sections: Section[]
  pages: Page[]
  documents: PageDocument[]
  tags: Tag[]
  pageTags: PageTag[]
  taskSteps: TaskStep[]
  assets: Asset[]
  pageLinks: PageLink[]
  knowledgeEntities: KnowledgeEntity[]
  knowledgeRelations: KnowledgeRelation[]
  readingPositions: ReadingPosition[]
  revisions: PageRevision[]
  comments: PageComment[]
  tombstones: Tombstone[]
}

export interface PageListQuery {
  sectionId?: UUID
  kind?: PageKind
  search?: string
  includeDeleted?: boolean
  limit?: number
  cursor?: string
}

export interface PageListResult {
  items: Page[]
  nextCursor?: string
}

export interface NotebookRepository {
  listNotebooks(workspaceId: UUID): Promise<Notebook[]>
  listSections(notebookId: UUID): Promise<Section[]>
  listPages(query: PageListQuery): Promise<PageListResult>
  getPage(id: UUID): Promise<Page | undefined>
  getPageDocument(pageId: UUID): Promise<PageDocument | undefined>
  savePage(page: Page, document?: PageDocument): Promise<void>
  movePageToTrash(pageId: UUID, deletedAt: IsoDate, deviceId: string): Promise<void>
  restorePage(pageId: UUID, restoredAt?: IsoDate): Promise<void>
  purgePage(pageId: UUID, deletedAt: IsoDate, deviceId: string): Promise<void>
  listTags(workspaceId: UUID): Promise<Tag[]>
  listPageTags(pageId: UUID): Promise<PageTag[]>
  savePageTags(pageId: UUID, tagIds: UUID[]): Promise<void>
  listTaskSteps(pageId: UUID): Promise<TaskStep[]>
  saveTaskSteps(pageId: UUID, steps: TaskStep[]): Promise<void>
  listPageLinks(pageId: UUID): Promise<PageLink[]>
  listBacklinks(pageId: UUID): Promise<PageLink[]>
  replacePageLinks(pageId: UUID, links: PageLink[]): Promise<void>
  createManualRevision(pageId: UUID): Promise<PageRevision>
  saveNotebook(notebook: Notebook): Promise<void>
  deleteNotebook(notebookId: UUID, deletedAt: IsoDate, deviceId: string): Promise<void>
  saveSection(section: Section): Promise<void>
  deleteSection(sectionId: UUID, deletedAt: IsoDate, deviceId: string): Promise<void>
  duplicatePage(pageId: UUID, newPageId: UUID, createdAt: IsoDate): Promise<Page>
}

export const isoNow = () => new Date().toISOString()

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`)
}
