import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { parse as parsePlist } from 'plist'
import type { NotebookDataBundle } from '@notebook/domain'
import {
  importLegacyBundle,
  importDocumentMigrationPackage,
  markdownToEditorCache,
  migrateLegacyPageDocument,
  libraryEnvelopeSchema,
  migratedDocumentSchema,
  migrationManifestSchema,
  noteEnvelopeSchema,
  noteIndexSchema,
  readingPositionsSchema,
  normalizeLegacyEncryptedData,
  importMarkdownRepository,
  sha256Hex,
  verifyPrivacyKeyCheck,
  type PrivacyKeyCheck,
  type StoredMarkdownNoteEnvelope,
  type LegacyEncryptedData,
  type LegacyLibraryEnvelope,
  type LegacyNoteEnvelope,
  type LegacyNoteIndex,
  type LegacyReadingPositions,
} from '@notebook/sync-contract'

export interface ImportFile { name: string; data: Uint8Array }

function expandFiles(files: ImportFile[]): ImportFile[] {
  return files.flatMap((file) => {
    if (!file.name.toLocaleLowerCase().endsWith('.zip')) return [file]
    return Object.entries(unzipSync(file.data)).map(([name, data]) => ({ name, data }))
  })
}

export interface DecodedImport { bundle: NotebookDataBundle; assetContents: Map<string, Uint8Array> }

/**
 * Resolve a locally available resource by its repository-local id, or by its
 * immutable content hash when another device assigned it a different id.
 */
export type AssetContentLoader = (assetId: string, contentHash?: string) => Promise<Uint8Array | undefined>

function documentPlainText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(documentPlainText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const node = value as { type?: unknown; text?: unknown; content?: unknown }
  if (typeof node.text === 'string') return node.text
  return documentPlainText(node.content)
}

function verified(bundle: NotebookDataBundle, assetContents: Map<string, Uint8Array>): DecodedImport {
  for (const asset of bundle.assets) {
    const declaredHash = (asset as typeof asset & { objectHash?: string }).objectHash ?? asset.checksum
    if (!declaredHash) continue
    const content = assetContents.get(asset.id)
    if (!content) throw new Error(`资源 ${asset.filename} 缺少内容对象，已中止导入`)
    if (sha256Hex(content) !== declaredHash.toLocaleLowerCase()) throw new Error(`资源 ${asset.filename} 的 SHA-256 校验失败，已中止导入`)
    if (asset.byteSize !== undefined && asset.byteSize !== content.byteLength) throw new Error(`资源 ${asset.filename} 的大小与清单不一致，已中止导入`)
  }
  return { bundle, assetContents }
}

function decodeBase64Text(value: string) {
  const binary = atob(value.replace(/\s+/g, ''))
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

function decodeLegacyPrivacyConfiguration(files: ImportFile[], embedded?: unknown): LegacyEncryptedData {
  const encryptedFile = files.find((file) => /(^|\/)Config\/EncryptedData\.plist$/i.test(file.name))
  const folderFile = files.find((file) => /(^|\/)Config\/EncryptedFolders\.plist$/i.test(file.name))
  const encrypted = normalizeLegacyEncryptedData(encryptedFile ? parsePlist(strFromU8(encryptedFile.data)) : embedded)
  if (!folderFile) return encrypted
  const folderConfig = parsePlist(strFromU8(folderFile.data)) as Record<string, unknown>
  let folders = encrypted.encryptedFolders
  if (typeof folderConfig.foldersData === 'string') {
    try {
      const decoded = JSON.parse(decodeBase64Text(folderConfig.foldersData))
      folders = normalizeLegacyEncryptedData({ encryptedFolders: decoded }).encryptedFolders
    } catch { /* A damaged optional folder-name file must not hide the notes themselves. */ }
  }
  const names = folderConfig.folderNames && typeof folderConfig.folderNames === 'object' ? folderConfig.folderNames as Record<string, unknown> : {}
  folders = folders.map((folder) => ({ ...folder, name: typeof names[folder.id] === 'string' ? names[folder.id] as string : folder.name }))
  return { ...encrypted, encryptedFolders: folders }
}

export async function decodeImport(files: ImportFile[], workspaceId: string, privacySecret?: string, fallbackAssetContents: Map<string, Uint8Array> | AssetContentLoader = new Map()): Promise<DecodedImport> {
  const expanded = expandFiles(files)
  const privacyCheckFile = expanded.find((file) => /(^|\/)notes\/privacy\.json$/i.test(file.name))
  if (privacyCheckFile) await verifyPrivacyKeyCheck(JSON.parse(strFromU8(privacyCheckFile.data)) as PrivacyKeyCheck, privacySecret)
  const current = expanded.find((file) => file.name.endsWith('notebook-next.json'))
  if (current) {
    const value = JSON.parse(strFromU8(current.data)) as { schemaVersion?: number; bundle?: NotebookDataBundle }
    if (value.schemaVersion !== 1 || !value.bundle) throw new Error('不支持的 Notebook Next 备份版本')
    const changedPageIds = new Set(value.bundle.documents
      .filter((document) => document.schemaVersion < 3 || document.markdown === undefined)
      .map((document) => document.pageId))
    const documents = value.bundle.documents.map(migrateLegacyPageDocument)
    const documentByPage = new Map(documents.map((document) => [document.pageId, document]))
    const publicInbox = value.bundle.sections.find((section) => section.id === 'inbox')
      ?? value.bundle.sections.find((section) => !value.bundle!.notebooks.find((notebook) => notebook.id === section.notebookId)?.locked)
    const bundle: NotebookDataBundle = {
      ...value.bundle,
      pages: value.bundle.pages.map((page) => ({
        ...page,
        title: page.title.trim(),
        preview: documentByPage.get(page.id)?.markdown !== undefined
          ? documentPlainText(markdownToEditorCache(documentByPage.get(page.id)!.markdown!)).replace(/\s+/g, ' ').trim().slice(0, 240)
          : page.preview,
        ...(!page.sectionId && !page.locked && publicInbox ? { sectionId: publicInbox.id } : {}),
        ...(changedPageIds.has(page.id) ? { syncStatus: 'pending' as const } : {}),
      })),
      documents,
      revisions: (value.bundle.revisions ?? []).map((revision) => ({
        ...revision,
        document: migrateLegacyPageDocument(revision.document),
      })),
      comments: value.bundle.comments ?? [],
    }
    const assetContents = new Map(bundle.assets.flatMap((asset) => {
      const file = expanded.find((item) => item.name === `assets/${asset.id}`)
      return file ? [[asset.id, file.data] as const] : []
    }))
    return verified(bundle, assetContents)
  }

  const manifestFile = expanded.find((file) => file.name.endsWith('manifest.json'))
  if (manifestFile) {
    const parsedManifest = migrationManifestSchema.safeParse(JSON.parse(strFromU8(manifestFile.data)))
    if (parsedManifest.success) {
      const documents = new Map(parsedManifest.data.notes.map((note) => {
        const file = expanded.find((item) => item.name === note.documentPath || item.name.endsWith(`/${note.documentPath}`))
        if (!file) throw new Error(`迁移包缺少文档：${note.documentPath}`)
        return [note.documentPath, migratedDocumentSchema.parse(JSON.parse(strFromU8(file.data)))] as const
      }))
      const embeddedPrivacy = (parsedManifest.data as unknown as { encryptedData?: unknown }).encryptedData
      const imported = importDocumentMigrationPackage(parsedManifest.data, documents, workspaceId, decodeLegacyPrivacyConfiguration(expanded, embeddedPrivacy))
      const bundle: NotebookDataBundle = {
        notebooks: [imported.notebook, ...(imported.privateNotebook ? [imported.privateNotebook] : [])], sections: imported.sections, pages: imported.pages, documents: imported.documents,
        tags: imported.tags, pageTags: imported.pageTags, taskSteps: imported.taskSteps, assets: imported.assets,
        pageLinks: imported.pageLinks, knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: imported.revisions, comments: [], tombstones: imported.tombstones,
      }
      const assetContents = new Map(imported.assets.flatMap((asset) => {
        const file = asset.localPath ? expanded.find((item) => item.name === asset.localPath || item.name.endsWith(`/${asset.localPath}`)) : undefined
        return file ? [[asset.id, file.data] as const] : []
      }))
      return verified(bundle, assetContents)
    }
  }

  let library: LegacyLibraryEnvelope | undefined
  let index: LegacyNoteIndex | undefined
  let markdownRepositoryDetected = false
  let positions: LegacyReadingPositions | undefined
  const notes: LegacyNoteEnvelope[] = []
  const markdownNotes: StoredMarkdownNoteEnvelope[] = []
  for (const file of expanded.filter((item) => item.name.toLocaleLowerCase().endsWith('.json'))) {
    const value: unknown = JSON.parse(strFromU8(file.data))
    if (value && typeof value === 'object' && (value as { repositoryFormat?: { version?: number } }).repositoryFormat?.version === 3) {
      markdownRepositoryDetected = true
    }
    if (value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 3 && typeof (value as { noteID?: unknown }).noteID === 'string') { markdownNotes.push(value as StoredMarkdownNoteEnvelope); continue }
    const note = noteEnvelopeSchema.safeParse(value)
    if (note.success) { notes.push(note.data); continue }
    const parsedLibrary = libraryEnvelopeSchema.safeParse(value)
    if (parsedLibrary.success) { library = parsedLibrary.data; continue }
    const parsedIndex = noteIndexSchema.safeParse(value)
    if (parsedIndex.success) {
      index = parsedIndex.data
      continue
    }
    const parsedPositions = readingPositionsSchema.safeParse(value)
    if (parsedPositions.success) positions = parsedPositions.data
  }
  if (!library) throw new Error('迁移包中缺少 library-envelope.json')
  if (markdownNotes.length || markdownRepositoryDetected) {
    const bundle = await importMarkdownRepository({ library, notes: markdownNotes, readingPositions: positions, index, privacySecret }, workspaceId)
    // Fallback contents can be a prebuilt map or a lazy loader. Sync passes a
    // loader so bytes for remote-referenced objects are read from IndexedDB on
    // demand instead of exporting the whole attachment store up front.
    const fallbackByHash = new Map<string, Uint8Array>()
    if (fallbackAssetContents instanceof Map) {
      for (const bytes of fallbackAssetContents.values()) fallbackByHash.set(sha256Hex(bytes), bytes)
    }
    const loadContent = async (assetId: string, contentHash?: string) => {
      const bytes = fallbackAssetContents instanceof Map ? fallbackAssetContents.get(assetId) : await fallbackAssetContents(assetId, contentHash)
      if (bytes) fallbackByHash.set(sha256Hex(bytes), bytes)
      return bytes
    }
    const assetContents = new Map<string, Uint8Array>()
    for (const asset of bundle.assets) {
      const normalized = asset.localPath?.replace(/^\.\//, '')
      const file = normalized ? expanded.find((item) => item.name === normalized || item.name.endsWith(`/${normalized}`)) : undefined
      if (file?.data) { assetContents.set(asset.id, file.data); continue }
      const declared = (asset as typeof asset & { objectHash?: string }).objectHash ?? asset.checksum
      const direct = await loadContent(asset.id, declared?.toLowerCase())
      const fallback = direct ?? (declared ? fallbackByHash.get(declared.toLowerCase()) : undefined)
      if (fallback) assetContents.set(asset.id, fallback)
    }
    return verified(bundle, assetContents)
  }
  if (notes.length === 0) throw new Error('迁移包中没有可导入的笔记信封')
  const imported = importLegacyBundle({ library, notes, index, readingPositions: positions }, workspaceId)
  const bundle: NotebookDataBundle = {
    notebooks: [imported.notebook, ...(imported.privateNotebook ? [imported.privateNotebook] : [])], sections: imported.sections, pages: imported.pages, documents: imported.documents,
    tags: imported.tags, pageTags: imported.pageTags, taskSteps: imported.taskSteps, assets: imported.assets,
    pageLinks: imported.pageLinks, knowledgeEntities: [], knowledgeRelations: [], readingPositions: imported.readingPositions, revisions: imported.revisions, comments: [], tombstones: imported.tombstones,
  }
  const assetContents = new Map(imported.assets.flatMap((asset) => {
    const normalized = asset.localPath?.replace(/^\.\//, '')
    const file = normalized ? expanded.find((item) => item.name === normalized || item.name.endsWith(`/${normalized}`)) : undefined
    return file ? [[asset.id, file.data] as const] : []
  }))
  return verified(bundle, assetContents)
}

export function encodeExport(bundle: NotebookDataBundle, assetContents: Map<string, Uint8Array>) {
  const payload = { format: 'notebook-next', schemaVersion: 1, exportedAt: new Date().toISOString(), bundle }
  return zipSync({ 'notebook-next.json': strToU8(JSON.stringify(payload)), ...Object.fromEntries([...assetContents].map(([id, data]) => [`assets/${id}`, data])) }, { level: 6 })
}

export function base64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function bytesToBase64(value: Uint8Array) {
  let result = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < value.length; offset += chunkSize) result += String.fromCharCode(...value.subarray(offset, offset + chunkSize))
  return btoa(result)
}
