import type { Asset, NotebookDataBundle, Page, PageDocument, PageRevision } from '@notebook/domain'

const appleReferenceDateMs = Date.UTC(2001, 0, 1)
const encoder = new TextEncoder()
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface EncodedLegacyRepository {
  files: Map<string, Uint8Array>
  pageVersions: Map<string, number>
  skippedPageIds: string[]
}

type TiptapMark = { type?: string; attrs?: Record<string, unknown> }
type TiptapNode = { type?: string; attrs?: Record<string, unknown>; marks?: TiptapMark[]; text?: string; content?: TiptapNode[] }
type LegacySpan = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; link?: string }
type LegacyBlock = Record<string, unknown> & { id: string; type: string; text?: LegacySpan[]; asset?: Record<string, unknown> }

const isUuid = (value: string | undefined): value is string => Boolean(value && uuidPattern.test(value))
const toAppleSeconds = (value: string | undefined) => (Date.parse(value ?? '') - appleReferenceDateMs) / 1000
const safeAppleSeconds = (value: string | undefined) => Number.isFinite(toAppleSeconds(value)) ? toAppleSeconds(value) : (Date.now() - appleReferenceDateMs) / 1000
const cleanFilename = (value: string) => value.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 180) || 'attachment'
const contentVersion = (page: Page) => Math.max(page.legacyVersion ?? 0, Date.parse(page.updatedAt), 1)

async function sha256(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

function nodeText(node: TiptapNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(nodeText).join(node.type === 'paragraph' ? '' : '\n')
}

function inlineSpans(node: TiptapNode): LegacySpan[] {
  const result: LegacySpan[] = []
  const visit = (current: TiptapNode) => {
    if (typeof current.text === 'string') {
      const span: LegacySpan = { text: current.text }
      for (const mark of current.marks ?? []) {
        if (mark.type === 'bold') span.bold = true
        else if (mark.type === 'italic') span.italic = true
        else if (mark.type === 'underline') span.underline = true
        else if (mark.type === 'strike') span.strikethrough = true
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') span.link = mark.attrs.href
      }
      result.push(span)
      return
    }
    for (const child of current.content ?? []) visit(child)
  }
  visit(node)
  return result.length ? result : [{ text: '' }]
}

function assetReference(asset: Asset) {
  return {
    id: asset.id,
    kind: asset.kind,
    filename: asset.filename,
    mimeType: asset.mimeType || 'application/octet-stream',
    ...(asset.width == null ? {} : { width: asset.width }),
    ...(asset.height == null ? {} : { height: asset.height }),
    ...(asset.duration == null ? {} : { duration: asset.duration }),
    createdAt: safeAppleSeconds(asset.createdAt),
    sidecarFiles: asset.sidecarPaths ?? [],
  }
}

function tiptapToLegacyBlocks(document: PageDocument | undefined, assets: Asset[]) {
  const root = document?.tiptapJson as TiptapNode | undefined
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const inlineAssetIds = new Set<string>()
  const blocks: LegacyBlock[] = []
  let sequence = 0
  const nextId = () => `notebook-next-${++sequence}`

  const addNode = (node: TiptapNode) => {
    if (node.type === 'heading') blocks.push({ id: nextId(), type: 'heading', level: Number(node.attrs?.level ?? 2), text: inlineSpans(node) })
    else if (node.type === 'paragraph') blocks.push({ id: nextId(), type: 'paragraph', text: inlineSpans(node) })
    else if (node.type === 'codeBlock') blocks.push({ id: nextId(), type: 'code', text: [{ text: nodeText(node) }] })
    else if (node.type === 'blockquote') blocks.push({ id: nextId(), type: 'blockquote', text: [{ text: nodeText(node) }] })
    else if (node.type === 'taskList') {
      for (const item of node.content ?? []) blocks.push({ id: nextId(), type: 'todo_item', checked: Boolean(item.attrs?.checked), text: [{ text: nodeText(item) }] })
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      for (const item of node.content ?? []) blocks.push({ id: nextId(), type: 'paragraph', text: [{ text: `${node.type === 'bulletList' ? '• ' : ''}${nodeText(item)}` }] })
    } else if (node.type === 'table') {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => nodeText(cell)))
      blocks.push({ id: nextId(), type: 'table', table: { rows, columnWidths: [], rowHeights: [] } })
    } else if (node.type === 'image') {
      const source = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
      const id = typeof node.attrs?.legacyAssetId === 'string' ? node.attrs.legacyAssetId : source.startsWith('notebook-asset:') ? source.slice('notebook-asset:'.length) : ''
      const asset = byId.get(id)
      if (asset) { inlineAssetIds.add(id); blocks.push({ id: nextId(), type: 'attachment', asset: assetReference(asset) }) }
    } else for (const child of node.content ?? []) addNode(child)
  }
  for (const node of root?.content ?? []) addNode(node)
  for (const asset of assets.filter((item) => !item.parentAssetId && !inlineAssetIds.has(item.id))) blocks.push({ id: nextId(), type: 'attachment', asset: assetReference(asset) })
  return blocks.length ? blocks : [{ id: nextId(), type: 'paragraph', text: [{ text: '' }] }]
}

function documentSignature(document: PageDocument | undefined) {
  return JSON.stringify(document?.tiptapJson ?? null)
}

async function revisionHistory(page: Page, revisions: PageRevision[], assets: Asset[], deviceId: string, currentDocument?: PageDocument) {
  const result: Array<Record<string, unknown>> = []
  let previousSignature: string | undefined
  const currentSignature = documentSignature(currentDocument)
  // Existing Notebook history is archival data. Do not silently trim it while
  // translating to the shared macOS/Android SSH contract. Consecutive snapshots
  // with the same document are sync artifacts rather than distinct recovery
  // points, and a trailing snapshot identical to the current body is redundant.
  const compacted = revisions.filter((item) => isUuid(item.id)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).filter((revision) => {
    const signature = documentSignature(revision.document)
    if (signature === previousSignature) return false
    previousSignature = signature
    return true
  })
  if (compacted.length && documentSignature(compacted[compacted.length - 1]?.document) === currentSignature) compacted.pop()
  for (const revision of compacted) {
    const blocks = tiptapToLegacyBlocks(revision.document, assets)
    const snapshot = {
      metadata: legacyMetadata(page, contentVersion(page)),
      document: { schemaVersion: '2.0', source: 'notebook-next', blocks, notebookNextTiptap: revision.document.tiptapJson },
      assets: [], todoSteps: [],
    }
    result.push({ id: revision.id, noteID: page.id, version: contentVersion(page), recordedAt: safeAppleSeconds(revision.createdAt), updatedAt: safeAppleSeconds(revision.document.updatedAt), title: page.title, authorDeviceID: deviceId, contentHash: await sha256(JSON.stringify(snapshot)), snapshot })
  }
  return result
}

function legacyMetadata(page: Page, version: number, tagIds: string[] = [], linkedNoteIds: string[] = []) {
  return {
    id: page.id,
    title: page.title,
    createdAt: safeAppleSeconds(page.createdAt),
    updatedAt: safeAppleSeconds(page.updatedAt),
    folderID: isUuid(page.sectionId) ? page.sectionId : null,
    folderName: '',
    reminderAt: page.reminderAt ? safeAppleSeconds(page.reminderAt) : null,
    recurrenceRule: page.recurrenceRule ?? 'none',
    version,
    tagIDs: tagIds.filter(isUuid),
    viewMode: 'preview',
    itemType: page.kind === 'task' ? 'todo' : 'note',
    todoDueAt: page.dueAt ? safeAppleSeconds(page.dueAt) : null,
    todoCompletedAt: page.completedAt ? safeAppleSeconds(page.completedAt) : null,
    todoIsImportant: page.important ?? page.favorite,
    todoOrder: 0,
    linkedNoteIDs: linkedNoteIds.filter(isUuid),
    notebookNextUpdatedAt: page.updatedAt,
  }
}

export async function encodeLegacyRepository(bundle: NotebookDataBundle, assetContents: Map<string, Uint8Array>, deviceId: string): Promise<EncodedLegacyRepository> {
  const files = new Map<string, Uint8Array>()
  const pageVersions = new Map<string, number>()
  const validPages = bundle.pages.filter((page) => isUuid(page.id))
  const skippedPageIds = bundle.pages.filter((page) => !isUuid(page.id)).map((page) => page.id)
  const sectionNotebook = new Map(bundle.sections.map((section) => [section.id, section.notebookId]))
  const notebookById = new Map(bundle.notebooks.map((notebook) => [notebook.id, notebook]))
  const lockedNotebookIds = new Set(bundle.notebooks.filter((notebook) => notebook.locked).map((notebook) => notebook.id))
  const encryptedSections = bundle.sections.filter((section) => lockedNotebookIds.has(section.notebookId) && isUuid(section.id) && !section.deletedAt)
  const encryptedSectionIds = new Set(encryptedSections.map((section) => section.id))
  const encryptedPages = validPages.filter((page) => page.locked || (page.sectionId ? encryptedSectionIds.has(page.sectionId) : false))
  const encodeJson = (path: string, value: unknown) => files.set(path, encoder.encode(JSON.stringify(value)))

  const deletedSections = bundle.tombstones.filter((item) => item.entityType === 'section' && isUuid(item.entityId)).map((item) => ({ id: item.entityId, deletedAt: safeAppleSeconds(item.deletedAt), deletedByDeviceID: item.deviceId }))
  const deletedTags = bundle.tombstones.filter((item) => item.entityType === 'tag' && isUuid(item.entityId)).map((item) => ({ id: item.entityId, deletedAt: safeAppleSeconds(item.deletedAt), deletedByDeviceID: item.deviceId }))
  encodeJson('library.json', {
    exportedAt: (Date.now() - appleReferenceDateMs) / 1000,
    deviceID: deviceId,
    folders: bundle.sections.filter((item) => isUuid(item.id) && !item.deletedAt && !encryptedSectionIds.has(item.id)).map((section) => ({
      id: section.id, name: section.name, sortOrder: section.sortOrder, isSystem: false,
      createdAt: safeAppleSeconds(section.createdAt), updatedAt: safeAppleSeconds(section.updatedAt),
      folderType: validPages.some((page) => page.sectionId === section.id && page.kind === 'task') ? 'todoList' : 'noteFolder',
      notebookNextNotebook: sectionNotebook.get(section.id) ? notebookById.get(sectionNotebook.get(section.id)!) : undefined,
    })),
    tags: bundle.tags.filter((item) => isUuid(item.id) && !item.deletedAt).map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, createdAt: safeAppleSeconds(tag.createdAt), updatedAt: safeAppleSeconds(tag.updatedAt) })),
    encryptedData: {
      encryptedFolders: encryptedSections.map((section) => ({ id: section.id, name: section.name, order: section.sortOrder })),
      encryptedNoteIDs: encryptedPages.map((page) => page.id),
      noteToFolderMapping: Object.fromEntries(encryptedPages.flatMap((page) => page.sectionId && encryptedSectionIds.has(page.sectionId) ? [[page.id, page.sectionId]] : [])),
    },
    deletedFolders: deletedSections,
    deletedTags,
    notebookNextNotebooks: bundle.notebooks,
  })

  const indexEntries: Array<Record<string, unknown>> = []
  const deletedEntries = new Map<string, { noteID: string; deletedAt: number; deletedByDeviceID: string }>()
  for (const tombstone of bundle.tombstones.filter((item) => item.entityType === 'page' && isUuid(item.entityId))) deletedEntries.set(tombstone.entityId, { noteID: tombstone.entityId, deletedAt: safeAppleSeconds(tombstone.deletedAt), deletedByDeviceID: tombstone.deviceId })
  const manifestEntries: Array<Record<string, unknown>> = []

  for (const page of validPages) {
    const version = contentVersion(page)
    pageVersions.set(page.id, version)
    const deleted = Boolean(page.deletedAt)
    if (page.deletedAt) {
      deletedEntries.set(page.id, { noteID: page.id, deletedAt: safeAppleSeconds(page.deletedAt), deletedByDeviceID: deviceId })
    }
    const document = bundle.documents.find((item) => item.pageId === page.id)
    const pageAssets = bundle.assets.filter((item) => item.pageId === page.id)
    const roots = pageAssets.filter((item) => !item.parentAssetId)
    const assetSnapshots: Array<Record<string, unknown>> = []
    for (const asset of roots) {
      const relative = `${page.id}/${asset.id}-${cleanFilename(asset.filename)}`
      const sidecars = pageAssets.filter((item) => item.parentAssetId === asset.id)
      const sidecarRelativePaths: string[] = []
      const bytes = assetContents.get(asset.id)
      if (bytes) {
        files.set(`attachments/${relative}`, bytes)
        manifestEntries.push({ relativePath: relative, contentHash: await sha256(bytes), size: bytes.byteLength })
      }
      for (const sidecar of sidecars) {
        const sidecarPath = `${page.id}/${sidecar.id}-${cleanFilename(sidecar.filename)}`
        const sidecarBytes = assetContents.get(sidecar.id)
        if (sidecarBytes) {
          files.set(`attachments/${sidecarPath}`, sidecarBytes)
          manifestEntries.push({ relativePath: sidecarPath, contentHash: await sha256(sidecarBytes), size: sidecarBytes.byteLength })
          sidecarRelativePaths.push(sidecarPath)
        }
      }
      assetSnapshots.push({ reference: { ...assetReference(asset), sidecarFiles: sidecars.map((item) => item.filename) }, relativeFilePath: relative, sidecarRelativePaths })
    }
    const blocks = tiptapToLegacyBlocks(document, roots)
    const tagIds = bundle.pageTags.filter((item) => item.pageId === page.id).map((item) => item.tagId)
    const linkedPageIds = bundle.pageLinks.filter((item) => item.sourcePageId === page.id).map((item) => item.targetPageId)
    const snapshot = {
      metadata: legacyMetadata(page, version, tagIds, linkedPageIds),
      document: { schemaVersion: '2.0', source: 'notebook-next', blocks, notebookNextTiptap: document?.tiptapJson ?? { type: 'doc', content: [{ type: 'paragraph' }] } },
      assets: assetSnapshots,
      todoSteps: bundle.taskSteps.filter((item) => item.pageId === page.id && isUuid(item.id)).map((step) => ({ id: step.id, noteID: page.id, text: step.text, checked: step.checked, order: step.sortOrder, createdAt: safeAppleSeconds(step.createdAt) })),
    }
    const history = await revisionHistory(page, bundle.revisions.filter((item) => item.pageId === page.id), roots, deviceId, deleted ? undefined : document)
    const envelope = { noteID: page.id, deviceID: deviceId, exportedAt: (Date.now() - appleReferenceDateMs) / 1000, currentVersion: version, currentSnapshot: snapshot, history, syncState: { lastSyncDeviceID: deviceId }, notebookNextSchemaVersion: 1 }
    const serialized = JSON.stringify(envelope)
    encodeJson(`notes/${page.id}.json`, envelope)
    // Keep tombstoned envelopes as recovery material, but never advertise them
    // as active index entries to legacy Android/macOS clients.
    if (!deleted) indexEntries.push({ noteID: page.id, version, contentHash: await sha256(JSON.stringify(snapshot)), historyCount: history.length })
    if (!serialized) throw new Error(`无法序列化页面 ${page.id}`)
  }

  encodeJson('notes/assets_manifest.json', { generatedAt: (Date.now() - appleReferenceDateMs) / 1000, deviceID: deviceId, entries: manifestEntries })
  encodeJson('notes/reading_positions.json', {
    schemaVersion: 1, exportedAt: new Date().toISOString(), deviceID: deviceId,
    positions: bundle.readingPositions.filter((item) => isUuid(item.pageId)).map((item) => ({ noteID: item.pageId, anchorUTF16Offset: Math.max(0, item.anchorUtf16Offset), viewportOffsetFraction: Math.max(0, Math.min(1, item.viewportOffsetFraction)), updatedAt: item.updatedAt, deviceID: item.deviceId })),
  })
  encodeJson('notes/index.json', { generatedAt: (Date.now() - appleReferenceDateMs) / 1000, deviceID: deviceId, entries: indexEntries, deletedEntries: [...deletedEntries.values()] })
  return { files, pageVersions, skippedPageIds }
}
