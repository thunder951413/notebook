import type { Asset, NotebookDataBundle, PageDocument, PageRevision } from '@notebook/domain'
import { encodeLegacyRepository } from './exporter'
import { importLegacyLibrary } from './importer'
import type { LegacyLibraryEnvelope, LegacyReadingPositions } from './schema'
import { markdownToTiptap, tiptapToMarkdown } from './markdown'

const encoder = new TextEncoder()

async function sha256(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

const markdownOf = (document: PageDocument) => document.markdown ?? tiptapToMarkdown(document.tiptapJson)

function imagePresentations(document: PageDocument) {
  const values = new Map<string, Pick<Asset, 'caption' | 'displayWidth' | 'alignment'>>()
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const value = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown[] }
    if (value.type === 'image') {
      const source = typeof value.attrs?.src === 'string' ? value.attrs.src : ''
      const id = typeof value.attrs?.legacyAssetId === 'string' ? value.attrs.legacyAssetId : source.startsWith('notebook-asset:') ? source.slice('notebook-asset:'.length) : ''
      if (id) values.set(id, {
        ...(typeof value.attrs?.title === 'string' && value.attrs.title ? { caption: value.attrs.title } : {}),
        ...(Number.isFinite(Number(value.attrs?.width)) ? { displayWidth: Number(value.attrs?.width) } : {}),
        ...(value.attrs?.textAlign === 'left' || value.attrs?.textAlign === 'center' || value.attrs?.textAlign === 'right' ? { alignment: value.attrs.textAlign } : {}),
      })
    }
    for (const child of value.content ?? []) visit(child)
  }
  visit(document.tiptapJson)
  return values
}

function restoreImagePresentations(document: Record<string, unknown>, assets: MarkdownAssetReference[]) {
  const values = new Map(assets.map((asset) => [asset.id, asset]))
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const value = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown[] }
    if (value.type === 'image') {
      const source = typeof value.attrs?.src === 'string' ? value.attrs.src : ''
      const id = typeof value.attrs?.legacyAssetId === 'string' ? value.attrs.legacyAssetId : source.startsWith('notebook-asset:') ? source.slice('notebook-asset:'.length) : ''
      const asset = values.get(id)
      if (asset) value.attrs = { ...value.attrs, legacyAssetId: id, ...(asset.caption ? { title: asset.caption } : {}), ...(asset.displayWidth ? { width: asset.displayWidth } : {}), ...(asset.alignment ? { textAlign: asset.alignment } : {}) }
    }
    for (const child of value.content ?? []) visit(child)
  }
  visit(document)
  return document
}

export function markdownToEditorCache(markdown: string, assets: MarkdownAssetReference[] = []) {
  return restoreImagePresentations(markdownToTiptap(markdown), assets)
}

export interface MarkdownHistoryEntry {
  id: string
  createdAt: string
  updatedAt: string
  reason: PageRevision['reason']
  contentHash: string
}

export interface MarkdownAssetReference extends Asset { objectHash?: string }

export interface MarkdownNoteEnvelope {
  schemaVersion: 3
  noteID: string
  metadata: NotebookDataBundle['pages'][number]
  currentContentHash: string
  contentObjects: Record<string, string>
  history: MarkdownHistoryEntry[]
  assets: MarkdownAssetReference[]
  taskSteps: NotebookDataBundle['taskSteps']
  tagIDs: string[]
  linkedPageIDs: string[]
}

export interface EncodedMarkdownRepository {
  files: Map<string, Uint8Array>
  pageVersions: Map<string, number>
  skippedPageIds: string[]
}

export async function encodeMarkdownRepository(bundle: NotebookDataBundle, assetContents: Map<string, Uint8Array>, deviceId: string): Promise<EncodedMarkdownRepository> {
  const legacy = await encodeLegacyRepository({ ...bundle, revisions: [] }, assetContents, deviceId)
  const files = new Map([...legacy.files].filter(([name]) => !/^notes\/[0-9a-f-]{36}\.json$/i.test(name) && !name.startsWith('attachments/')))
  const manifests = new Map<string, { relativePath: string; contentHash: string; size: number }>()
  const indexEntries: Array<{ noteID: string; version: number; contentHash: string; historyCount: number }> = []
  const pageVersions = new Map<string, number>()
  const validPageIds = new Set(legacy.pageVersions.keys())

  for (const page of bundle.pages.filter((item) => validPageIds.has(item.id))) {
    const document = bundle.documents.find((item) => item.pageId === page.id)
    if (!document) continue
    const currentMarkdown = markdownOf(document)
    const currentContentHash = await sha256(currentMarkdown)
    const contentObjects: Record<string, string> = { [currentContentHash]: currentMarkdown }
    const history: MarkdownHistoryEntry[] = []
    let previousHash: string | undefined
    for (const revision of bundle.revisions.filter((item) => item.pageId === page.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      const markdown = markdownOf(revision.document)
      const contentHash = await sha256(markdown)
      if (contentHash === previousHash) continue
      previousHash = contentHash
      contentObjects[contentHash] = markdown
      history.push({ id: revision.id, createdAt: revision.createdAt, updatedAt: revision.document.updatedAt, reason: revision.reason, contentHash })
    }
    if (history[history.length - 1]?.contentHash === currentContentHash) history.pop()

    const assets: MarkdownAssetReference[] = []
    const presentations = imagePresentations(document)
    for (const asset of bundle.assets.filter((item) => item.pageId === page.id)) {
      const bytes = assetContents.get(asset.id)
      const objectHash = bytes ? await sha256(bytes) : asset.checksum
      if (bytes && objectHash) {
        const relativePath = `objects/${objectHash.slice(0, 2)}/${objectHash}`
        files.set(relativePath, bytes)
        manifests.set(objectHash, { relativePath, contentHash: objectHash, size: bytes.byteLength })
      }
      assets.push({ ...asset, ...presentations.get(asset.id), ...(objectHash ? { objectHash, checksum: objectHash, localPath: `objects/${objectHash.slice(0, 2)}/${objectHash}` } : {}) })
    }

    const envelope: MarkdownNoteEnvelope = {
      schemaVersion: 3, noteID: page.id, metadata: page, currentContentHash, contentObjects, history, assets,
      taskSteps: bundle.taskSteps.filter((item) => item.pageId === page.id),
      tagIDs: bundle.pageTags.filter((item) => item.pageId === page.id).map((item) => item.tagId),
      linkedPageIDs: bundle.pageLinks.filter((item) => item.sourcePageId === page.id).map((item) => item.targetPageId),
    }
    files.set(`notes/${page.id}.json`, encoder.encode(JSON.stringify(envelope)))
    const version = Math.max(page.legacyVersion ?? 0, Date.parse(page.updatedAt), 1)
    pageVersions.set(page.id, version)
    if (!page.deletedAt) indexEntries.push({ noteID: page.id, version, contentHash: currentContentHash, historyCount: history.length })
  }

  files.set('notes/assets_manifest.json', encoder.encode(JSON.stringify({ schemaVersion: 3, deviceID: deviceId, entries: [...manifests.values()] })))
  files.set('notes/index.json', encoder.encode(JSON.stringify({ schemaVersion: 3, deviceID: deviceId, repositoryFormat: { version: 3, noteEncoding: 'gzip', contentFormat: 'markdown-gfm', assetAddressing: 'sha256' }, entries: indexEntries, deletedEntries: bundle.tombstones.filter((item) => item.entityType === 'page').map((item) => ({ noteID: item.entityId, deletedAt: item.deletedAt, deletedByDeviceID: item.deviceId })) })))
  return { files, pageVersions, skippedPageIds: legacy.skippedPageIds }
}

export function importMarkdownRepository(input: { library: LegacyLibraryEnvelope; notes: MarkdownNoteEnvelope[]; readingPositions?: LegacyReadingPositions }, workspaceId: string) {
  const library = importLegacyLibrary(input.library, workspaceId)
  const now = new Date().toISOString()
  const pages = input.notes.map((note) => ({ ...note.metadata, workspaceId, syncStatus: 'synced' as const }))
  const documents = input.notes.map((note) => {
    const markdown = note.contentObjects[note.currentContentHash] ?? ''
    return { pageId: note.noteID, schemaVersion: 3, markdown, tiptapJson: { type: 'doc', content: [] }, updatedAt: note.metadata.updatedAt }
  })
  const revisions = input.notes.flatMap((note) => note.history.flatMap((entry) => {
    const markdown = note.contentObjects[entry.contentHash]
    // History is cold data. Its Markdown is authoritative and the editor tree is
    // rebuilt only when this exact revision is restored.
    return markdown === undefined ? [] : [{ id: entry.id, pageId: note.noteID, createdAt: entry.createdAt, reason: entry.reason, document: { pageId: note.noteID, schemaVersion: 3, markdown, tiptapJson: { type: 'doc', content: [] }, updatedAt: entry.updatedAt } }]
  }))
  return {
    notebooks: [library.notebook, ...(library.privateNotebook ? [library.privateNotebook] : [])], sections: library.sections, pages, documents,
    tags: library.tags, pageTags: input.notes.flatMap((note) => note.tagIDs.map((tagId) => ({ pageId: note.noteID, tagId }))),
    taskSteps: input.notes.flatMap((note) => note.taskSteps), assets: input.notes.flatMap((note) => note.assets),
    pageLinks: input.notes.flatMap((note) => note.linkedPageIDs.map((targetPageId) => ({ id: `markdown-link:${note.noteID}:${targetPageId}`, workspaceId, sourcePageId: note.noteID, targetPageId, kind: 'link' as const, createdAt: now }))),
    knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions, comments: [], tombstones: library.tombstones,
  } satisfies NotebookDataBundle
}
