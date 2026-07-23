import type { Asset, Notebook, Page, PageDocument, PageLink, PageRevision, ReadingPosition, Section, Tag, TaskStep, Tombstone } from '@notebook/domain'
import type { LegacyEncryptedData, LegacyLibraryEnvelope, LegacyNoteEnvelope, LegacyNoteIndex, LegacyReadingPositions, MigratedDocumentPayload, MigrationManifest } from './schema'
import { migrateLegacyPageDocument } from './markdown'

const appleReferenceDateMs = Date.UTC(2001, 0, 1)
export const appleReferenceSecondsToIso = (value: number) => new Date(appleReferenceDateMs + value * 1000).toISOString()

type TiptapMark = { type: string; attrs?: Record<string, unknown> }
type TiptapNode = { type: string; attrs?: Record<string, unknown>; marks?: TiptapMark[]; text?: string; content?: TiptapNode[] }
type SourceSpan = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; link?: string | null; textColor?: string | null; backgroundColor?: string | null; fontFamily?: string | null; fontSize?: number | null }
type SourceBlock = { type: string; level?: number | null; checked?: boolean | null; text?: SourceSpan[] | null; table?: { rows: string[][] } | null; asset?: { id: string; kind: 'image' | 'audio' | 'video' | 'file'; filename: string; mimeType: string } | null }

function spanToNode(span: SourceSpan): TiptapNode {
  const marks: TiptapMark[] = []
  if (span.bold) marks.push({ type: 'bold' })
  if (span.italic) marks.push({ type: 'italic' })
  if (span.underline) marks.push({ type: 'underline' })
  if (span.strikethrough) marks.push({ type: 'strike' })
  if (span.link) marks.push({ type: 'link', attrs: { href: span.link } })
  return { type: 'text', text: span.text, ...(marks.length ? { marks } : {}) }
}

function legacyBlockToTiptap(block: SourceBlock, assetId = (value: string) => value): TiptapNode {
  const content = block.text?.map(spanToNode) ?? []
  switch (block.type) {
    case 'heading': return { type: 'heading', attrs: { level: block.level ?? 2 }, content }
    case 'todo_item': return { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: block.checked ?? false }, content: [{ type: 'paragraph', content }] }] }
    case 'table': return {
      type: 'table',
      content: (block.table?.rows ?? []).map((row) => ({
        type: 'tableRow',
        content: row.map((cell) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: cell ? [{ type: 'text', text: cell }] : [] }] })),
      })),
    }
    case 'attachment': {
      const id = block.asset ? assetId(block.asset.id) : ''
      return block.asset?.kind === 'image'
        ? { type: 'image', attrs: { src: `notebook-asset:${id}`, legacyAssetId: id, alt: block.asset.filename, title: block.asset.filename } }
        : {
            type: 'paragraph',
            content: block.asset ? [{
              type: 'text',
              text: block.asset.filename,
              marks: [{ type: 'link', attrs: { href: `notebook-asset:${id}` } }],
            }] : [],
          }
    }
    case 'code': return { type: 'codeBlock', content }
    case 'blockquote': return { type: 'blockquote', content: [{ type: 'paragraph', content }] }
    default: return { type: 'paragraph', content }
  }
}

function tiptapPlainText(node: TiptapNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(tiptapPlainText).join(node.type === 'doc' ? '\n' : '')
}

export function legacyDocumentToTiptap(document: { blocks: SourceBlock[]; notebookNextTiptap?: unknown }, assetId = (value: string) => value) {
  const preserved = document.notebookNextTiptap
  if (preserved && typeof preserved === 'object' && (preserved as { type?: unknown }).type === 'doc' && Array.isArray((preserved as { content?: unknown }).content)) {
    const blockText = document.blocks.map((block) => block.text?.map((span) => span.text).join('') ?? '').join('\n')
    if (tiptapPlainText(preserved as TiptapNode) === blockText) return preserved as Record<string, unknown>
  }
  return { type: 'doc', content: document.blocks.map((block) => legacyBlockToTiptap(block, assetId)) }
}

export interface ImportedLegacyPage {
  page: Page
  document: PageDocument
  assets: Asset[]
  taskSteps: TaskStep[]
  tagIds: string[]
  linkedPageIds: string[]
}

export function importLegacyNote(envelope: LegacyNoteEnvelope, workspaceId: string): ImportedLegacyPage {
  const snapshot = envelope.currentSnapshot
  const metadata = snapshot.metadata
  if (metadata.id !== envelope.noteID) throw new Error('Envelope noteID does not match snapshot metadata id')
  const updatedAt = appleReferenceSecondsToIso(metadata.updatedAt)
  const page: Page = {
    id: metadata.id,
    workspaceId,
    sectionId: metadata.folderID ?? undefined,
    kind: metadata.itemType === 'todo' ? 'task' : 'document',
    title: metadata.title,
    preview: snapshot.document.blocks.flatMap((block) => block.text?.map((span) => span.text) ?? []).join(' ').slice(0, 240),
    favorite: metadata.todoIsImportant,
    createdAt: appleReferenceSecondsToIso(metadata.createdAt),
    updatedAt,
    reminderAt: metadata.reminderAt == null ? undefined : appleReferenceSecondsToIso(metadata.reminderAt),
    recurrenceRule: metadata.recurrenceRule,
    dueAt: metadata.todoDueAt == null ? undefined : appleReferenceSecondsToIso(metadata.todoDueAt),
    completedAt: metadata.todoCompletedAt == null ? undefined : appleReferenceSecondsToIso(metadata.todoCompletedAt),
    important: metadata.todoIsImportant,
    syncStatus: 'local',
    legacyVersion: metadata.version,
    legacyMetadata: { ...(metadata as unknown as Record<string, unknown>), syncState: envelope.syncState },
  }
  const legacyDocument: PageDocument = {
    pageId: page.id,
    schemaVersion: 1,
    tiptapJson: legacyDocumentToTiptap(snapshot.document),
    legacySource: snapshot.document as unknown as Record<string, unknown>,
    updatedAt,
  }
  return {
    page,
    document: migrateLegacyPageDocument(legacyDocument),
    assets: snapshot.assets.flatMap(({ reference, relativeFilePath, sidecarRelativePaths }) => [{
      id: reference.id, pageId: page.id, kind: reference.kind, filename: reference.filename, mimeType: reference.mimeType,
      width: reference.width, height: reference.height, duration: reference.duration, sidecarPaths: reference.sidecarFiles,
      localPath: relativeFilePath, createdAt: appleReferenceSecondsToIso(reference.createdAt),
    }, ...sidecarRelativePaths.map((path, index): Asset => ({
      id: `${reference.id}:sidecar:${index}`, pageId: page.id, kind: 'file', filename: path.split('/').pop() ?? path,
      mimeType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream', localPath: path,
      createdAt: appleReferenceSecondsToIso(reference.createdAt), parentAssetId: reference.id, role: 'sidecar',
    }))]),
    taskSteps: snapshot.todoSteps.map((step) => ({
      id: step.id,
      pageId: page.id,
      text: step.text,
      checked: step.checked,
      sortOrder: step.order,
      createdAt: appleReferenceSecondsToIso(step.createdAt),
    })),
    tagIds: metadata.tagIDs,
    linkedPageIds: metadata.linkedNoteIDs,
  }
}

export interface ImportedLegacyLibrary {
  notebook: Notebook
  privateNotebook?: Notebook
  sections: Section[]
  tags: Tag[]
  encryptedPageIds: string[]
  tombstones: Tombstone[]
}

export function normalizeLegacyEncryptedData(value: unknown): LegacyEncryptedData {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const encryptedFolders = Array.isArray(source.encryptedFolders) ? source.encryptedFolders.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const folder = item as Record<string, unknown>
    return typeof folder.id === 'string' && typeof folder.name === 'string'
      ? [{ id: folder.id, name: folder.name, order: typeof folder.order === 'number' ? folder.order : 0 }]
      : []
  }) : []
  const encryptedNoteIDs = Array.isArray(source.encryptedNoteIDs) ? source.encryptedNoteIDs.filter((id): id is string => typeof id === 'string') : []
  const noteToFolderMapping = source.noteToFolderMapping && typeof source.noteToFolderMapping === 'object'
    ? Object.fromEntries(Object.entries(source.noteToFolderMapping as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return { encryptedFolders, encryptedNoteIDs, noteToFolderMapping }
}

function privacyRecords(encrypted: LegacyEncryptedData, notebookId: string, workspaceId: string, timestamp: string) {
  const folderById = new Map(encrypted.encryptedFolders.map((folder) => [folder.id, folder]))
  const referencedFolderIds = [...new Set(Object.values(encrypted.noteToFolderMapping))]
  for (const [index, id] of referencedFolderIds.entries()) if (!folderById.has(id)) {
    folderById.set(id, { id, name: `隐私分区 ${index + 1}`, order: index })
  }
  if (encrypted.encryptedNoteIDs.length && folderById.size === 0) {
    folderById.set(`legacy-private-unfiled-${notebookId}`, { id: `legacy-private-unfiled-${notebookId}`, name: '未归类', order: 0 })
  }
  const sections: Section[] = [...folderById.values()].map((folder) => ({
    id: folder.id, notebookId, name: folder.name, sortOrder: folder.order, color: '#8b5a9f', createdAt: timestamp, updatedAt: timestamp,
  }))
  const notebook: Notebook | undefined = sections.length ? {
    id: notebookId, workspaceId, name: '隐私笔记本', emoji: '🔒', sortOrder: 101, createdAt: timestamp, updatedAt: timestamp, locked: true,
  } : undefined
  return { notebook, sections }
}

export function importLegacyLibrary(envelope: LegacyLibraryEnvelope, workspaceId: string): ImportedLegacyLibrary {
  const exportedAt = appleReferenceSecondsToIso(envelope.exportedAt)
  const notebookId = `legacy-${envelope.deviceID}`
  const encrypted = normalizeLegacyEncryptedData(envelope.encryptedData)
  const privateNotebookId = `legacy-private-${envelope.deviceID}`
  const privacy = privacyRecords(encrypted, privateNotebookId, workspaceId, exportedAt)
  const encryptedFolderIds = new Set([
    ...privacy.sections.map((section) => section.id),
    ...envelope.folders.filter((folder) => folder.folderType === 'encryptedFolder').map((folder) => folder.id),
  ])
  const normalFolders = envelope.folders.filter((folder) => !encryptedFolderIds.has(folder.id))
  const legacyEncryptedSections: Section[] = envelope.folders.filter((folder) => folder.folderType === 'encryptedFolder' && !privacy.sections.some((section) => section.id === folder.id)).map((folder) => ({
    id: folder.id, notebookId: privateNotebookId, name: folder.name, sortOrder: folder.sortOrder, color: '#8b5a9f',
    createdAt: appleReferenceSecondsToIso(folder.createdAt ?? folder.updatedAt ?? envelope.exportedAt),
    updatedAt: appleReferenceSecondsToIso(folder.updatedAt ?? folder.createdAt ?? envelope.exportedAt),
  }))
  const privateSections = [...privacy.sections, ...legacyEncryptedSections]
  const privateNotebook = privacy.notebook ?? (privateSections.length ? {
    id: privateNotebookId, workspaceId, name: '隐私笔记本', emoji: '🔒', sortOrder: 101, createdAt: exportedAt, updatedAt: exportedAt, locked: true,
  } : undefined)
  return {
    notebook: { id: notebookId, workspaceId, name: '迁移的笔记', emoji: '📥', sortOrder: 100, createdAt: exportedAt, updatedAt: exportedAt },
    privateNotebook,
    sections: [...normalFolders.map((folder) => ({
      id: folder.id, notebookId, name: folder.name, sortOrder: folder.sortOrder,
      color: folder.folderType === 'todoList' ? '#0f766e' : '#7c3aed',
      createdAt: appleReferenceSecondsToIso(folder.createdAt ?? folder.updatedAt ?? envelope.exportedAt),
      updatedAt: appleReferenceSecondsToIso(folder.updatedAt ?? folder.createdAt ?? envelope.exportedAt),
    })), ...privateSections],
    tags: envelope.tags.map((tag) => ({ id: tag.id, workspaceId, name: tag.name, color: tag.color, createdAt: appleReferenceSecondsToIso(tag.createdAt), updatedAt: appleReferenceSecondsToIso(tag.updatedAt ?? tag.createdAt) })),
    encryptedPageIds: encrypted.encryptedNoteIDs,
    tombstones: [
      ...envelope.deletedFolders.map((value) => value as { id: string; deletedAt: number; deletedByDeviceID: string }).map((value) => ({ id: `section:${value.id}`, workspaceId, entityType: 'section' as const, entityId: value.id, deletedAt: appleReferenceSecondsToIso(value.deletedAt), deviceId: value.deletedByDeviceID })),
      ...envelope.deletedTags.map((value) => value as { id: string; deletedAt: number; deletedByDeviceID: string }).map((value) => ({ id: `tag:${value.id}`, workspaceId, entityType: 'tag' as const, entityId: value.id, deletedAt: appleReferenceSecondsToIso(value.deletedAt), deviceId: value.deletedByDeviceID })),
    ],
  }
}

export interface ImportedLegacyBundle extends ImportedLegacyLibrary {
  pages: Page[]
  documents: PageDocument[]
  assets: Asset[]
  taskSteps: TaskStep[]
  pageTags: Array<{ pageId: string; tagId: string }>
  pageLinks: PageLink[]
  readingPositions: ReadingPosition[]
  revisions: PageRevision[]
}

export function importLegacyBundle(input: { library: LegacyLibraryEnvelope; notes: LegacyNoteEnvelope[]; index?: LegacyNoteIndex; readingPositions?: LegacyReadingPositions }, workspaceId: string): ImportedLegacyBundle {
  const library = importLegacyLibrary(input.library, workspaceId)
  const notes = input.notes.map((note) => importLegacyNote(note, workspaceId))
  const indexedIds = new Set(input.index?.entries.map((entry) => entry.noteID) ?? notes.map((note) => note.page.id))
  const pages = notes.filter((note) => indexedIds.has(note.page.id))
  const now = new Date().toISOString()
  const pageLinks = pages.flatMap((note) => note.linkedPageIds.map((targetPageId) => ({ id: `legacy-link:${note.page.id}:${targetPageId}`, workspaceId, sourcePageId: note.page.id, targetPageId, kind: 'link' as const, createdAt: now })))
  const deletedPages: Tombstone[] = (input.index?.deletedEntries ?? []).map((entry) => ({ id: `page:${entry.noteID}`, workspaceId, entityType: 'page', entityId: entry.noteID, deletedAt: appleReferenceSecondsToIso(entry.deletedAt), deviceId: entry.deletedByDeviceID }))
  const revisions: PageRevision[] = input.notes.flatMap((note) => note.history.flatMap((entry) => {
    const snapshot = entry.snapshot as LegacyNoteEnvelope['currentSnapshot']
    if (!snapshot?.document?.blocks) return []
    return [{
      id: entry.id, pageId: note.noteID, createdAt: appleReferenceSecondsToIso(entry.recordedAt), reason: 'import' as const,
      document: migrateLegacyPageDocument({ pageId: note.noteID, schemaVersion: 1, tiptapJson: legacyDocumentToTiptap(snapshot.document), legacySource: snapshot.document as unknown as Record<string, unknown>, updatedAt: appleReferenceSecondsToIso(entry.updatedAt) }),
    }]
  }))
  return {
    ...library,
    pages: pages.map((item) => {
      const encrypted = normalizeLegacyEncryptedData(input.library.encryptedData)
      const locked = library.encryptedPageIds.includes(item.page.id)
      const privateSectionId = encrypted.noteToFolderMapping[item.page.id]
      const fallbackPrivateSection = library.sections.find((section) => section.notebookId === library.privateNotebook?.id)?.id
      return {
        ...item.page,
        sectionId: locked ? privateSectionId ?? fallbackPrivateSection : item.page.sectionId,
        locked,
        legacyMetadata: { ...item.page.legacyMetadata, ...(privateSectionId ? { legacyEncryptedFolderId: privateSectionId } : {}) },
      }
    }),
    documents: pages.map((item) => item.document),
    assets: pages.flatMap((item) => item.assets),
    taskSteps: pages.flatMap((item) => item.taskSteps),
    pageTags: pages.flatMap((item) => item.tagIds.map((tagId) => ({ pageId: item.page.id, tagId }))),
    pageLinks,
    readingPositions: (input.readingPositions?.positions ?? []).map((position) => ({ id: position.noteID, pageId: position.noteID, anchorUtf16Offset: position.anchorUTF16Offset, viewportOffsetFraction: position.viewportOffsetFraction, updatedAt: position.updatedAt, deviceId: position.deviceID })),
    revisions,
    tombstones: [...library.tombstones, ...deletedPages],
  }
}

export function importDocumentMigrationPackage(manifest: MigrationManifest, documents: Map<string, MigratedDocumentPayload>, workspaceId: string, encryptedInput?: LegacyEncryptedData): ImportedLegacyBundle {
  const notebookId = `legacy-package-${manifest.exportedAt}`
  const notebook: Notebook = { id: notebookId, workspaceId, name: '迁移的笔记', emoji: '📥', sortOrder: 100, createdAt: manifest.exportedAt, updatedAt: manifest.exportedAt }
  const encrypted = normalizeLegacyEncryptedData(encryptedInput)
  const privateNotebookId = `legacy-package-private-${manifest.exportedAt}`
  const privacy = privacyRecords(encrypted, privateNotebookId, workspaceId, manifest.exportedAt)
  const encryptedFolderIds = new Set(privacy.sections.map((section) => section.id))
  const sections: Section[] = [...manifest.folders.filter((folder) => !encryptedFolderIds.has(folder.id)).map((folder) => ({
    id: folder.id, notebookId, name: folder.name, sortOrder: folder.sortOrder,
    color: folder.folderType === 'todoList' ? '#0f766e' : folder.folderType === 'encryptedFolder' ? '#b45309' : '#7c3aed',
    createdAt: folder.createdAt ?? manifest.exportedAt, updatedAt: folder.createdAt ?? manifest.exportedAt,
  })), ...privacy.sections]
  const tags: Tag[] = manifest.tags.map((tag) => ({ id: tag.id, workspaceId, name: tag.name, color: tag.color, createdAt: tag.createdAt, updatedAt: tag.createdAt }))
  const pages: Page[] = []
  const pageDocuments: PageDocument[] = []
  const assets: Asset[] = []
  const pageTags: Array<{ pageId: string; tagId: string }> = []
  const pageLinks: PageLink[] = []
  for (const note of manifest.notes) {
    const document = documents.get(note.documentPath)
    if (!document) throw new Error(`迁移包缺少文档：${note.documentPath}`)
    // Legacy document packages only guarantee asset ids are unique inside one
    // note (many real exports contain asset-1 in several notes). Namespace the
    // id before it reaches IndexedDB/the sync protocol, where ids are global.
    const importedAssetId = (legacyId: string) => `legacy-asset:${note.id}:${legacyId}`
    const locked = encrypted.encryptedNoteIDs.includes(note.id)
    const privateSectionId = encrypted.noteToFolderMapping[note.id]
    pages.push({
      id: note.id, workspaceId, sectionId: locked ? privateSectionId ?? privacy.sections[0]?.id : note.folderID ?? undefined, kind: note.itemType === 'todo' ? 'task' : 'document', title: note.title,
      preview: document.blocks.flatMap((block) => block.text?.map((span) => span.text) ?? []).join(' ').slice(0, 240), favorite: note.todoIsImportant ?? false,
      createdAt: note.createdAt, updatedAt: note.updatedAt, deletedAt: note.deletedAt ?? undefined, reminderAt: note.reminderAt ?? undefined,
      recurrenceRule: note.recurrenceRule, dueAt: note.todoDueAt ?? undefined, completedAt: note.todoCompletedAt ?? undefined,
      important: note.todoIsImportant ?? false, syncStatus: 'local', legacyVersion: note.version, locked,
      legacyMetadata: { ...(note as unknown as Record<string, unknown>), ...(privateSectionId ? { legacyEncryptedFolderId: privateSectionId } : {}) },
    })
    pageDocuments.push(migrateLegacyPageDocument({ pageId: note.id, schemaVersion: 1, tiptapJson: { type: 'doc', content: document.blocks.map((block) => legacyBlockToTiptap(block, importedAssetId)) }, legacySource: document as unknown as Record<string, unknown>, updatedAt: note.updatedAt }))
    for (const block of document.blocks) if (block.asset) assets.push({
      id: importedAssetId(block.asset.id), pageId: note.id, kind: block.asset.kind, filename: block.asset.filename.split('/').pop() ?? block.asset.filename,
      mimeType: block.asset.mimeType, width: block.asset.width ?? undefined, height: block.asset.height ?? undefined,
      duration: block.asset.duration ?? undefined, sidecarPaths: block.asset.sidecarFiles,
      localPath: `${note.documentPath.slice(0, note.documentPath.lastIndexOf('/') + 1)}${block.asset.filename}`, createdAt: block.asset.createdAt ?? note.createdAt,
    }, ...block.asset.sidecarFiles.map((path, index): Asset => ({
      id: `${importedAssetId(block.asset!.id)}:sidecar:${index}`, pageId: note.id, kind: 'file', filename: path.split('/').pop() ?? path,
      mimeType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      localPath: `${note.documentPath.slice(0, note.documentPath.lastIndexOf('/') + 1)}${path}`,
      createdAt: block.asset!.createdAt ?? note.createdAt, parentAssetId: importedAssetId(block.asset!.id), role: 'sidecar',
    })))
    pageTags.push(...note.tagIDs.map((tagId) => ({ pageId: note.id, tagId })))
    pageLinks.push(...(note.linkedNoteIDs ?? []).map((targetPageId) => ({ id: `legacy-link:${note.id}:${targetPageId}`, workspaceId, sourcePageId: note.id, targetPageId, kind: 'link' as const, createdAt: note.updatedAt })))
  }
  return {
    notebook, privateNotebook: privacy.notebook, sections, tags, encryptedPageIds: encrypted.encryptedNoteIDs, tombstones: [], pages, documents: pageDocuments, assets,
    taskSteps: (manifest.todoSteps ?? []).map((step) => ({ id: step.id, pageId: step.noteID, text: step.text, checked: step.checked, sortOrder: step.order, createdAt: step.createdAt })),
    pageTags, pageLinks, readingPositions: [], revisions: [],
  }
}
