import type { Asset, NotebookDataBundle, PageDocument, PageRevision } from '@notebook/domain'
import { encodeLegacyRepository } from './exporter'
import { importLegacyLibrary } from './importer'
import type { LegacyLibraryEnvelope, LegacyReadingPositions } from './schema'
import { markdownToTiptap, tiptapToMarkdown } from './markdown'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

export function sha256Hex(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  return bytesToHex(sha256(bytes))
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

export interface EncryptedMarkdownNoteEnvelope {
  schemaVersion: 3
  noteID: string
  metadata: NotebookDataBundle['pages'][number]
  currentContentHash: string
  contentObjects: Record<string, string>
  history: []
  assets: []
  taskSteps: []
  tagIDs: []
  linkedPageIDs: []
  privacyEncryption: { version: 1; algorithm: 'AES-256-GCM'; kdf: 'PBKDF2-SHA256'; iterations: number; salt: string; iv: string; ciphertext: string }
}

export type StoredMarkdownNoteEnvelope = MarkdownNoteEnvelope | EncryptedMarkdownNoteEnvelope

const PRIVACY_ITERATIONS = 310_000
const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

async function privacyKey(secret: string, salt: Uint8Array, usage: KeyUsage[]) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PRIVACY_ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, usage)
}

async function encryptPrivateNote(note: MarkdownNoteEnvelope, secret: string): Promise<EncryptedMarkdownNoteEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: encoder.encode(note.noteID) as BufferSource }, await privacyKey(secret, salt, ['encrypt']), encoder.encode(JSON.stringify(note)) as BufferSource))
  return {
    schemaVersion: 3, noteID: note.noteID,
    metadata: { ...note.metadata, title: '隐私笔记', preview: '', locked: true, legacyMetadata: undefined },
    currentContentHash: note.currentContentHash, contentObjects: {}, history: [], assets: [], taskSteps: [], tagIDs: [], linkedPageIDs: [],
    privacyEncryption: { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: PRIVACY_ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) },
  }
}

export async function decryptPrivateNote(note: StoredMarkdownNoteEnvelope, secret?: string): Promise<MarkdownNoteEnvelope> {
  if (!('privacyEncryption' in note)) return note
  if (!secret) throw new Error(`隐私笔记 ${note.noteID} 已加密，请先配置相同的 SSH 密码`)
  const encryption = note.privacyEncryption
  if (encryption.version !== 1 || encryption.algorithm !== 'AES-256-GCM' || encryption.kdf !== 'PBKDF2-SHA256' || encryption.iterations !== PRIVACY_ITERATIONS) throw new Error(`隐私笔记 ${note.noteID} 使用了不支持的加密格式`)
  try {
    const cleartext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(encryption.iv) as BufferSource, additionalData: encoder.encode(note.noteID) as BufferSource }, await privacyKey(secret, fromBase64(encryption.salt), ['decrypt']), fromBase64(encryption.ciphertext) as BufferSource)
    const decoded = JSON.parse(new TextDecoder().decode(cleartext)) as MarkdownNoteEnvelope
    if (decoded.noteID !== note.noteID) throw new Error('note id mismatch')
    return decoded
  } catch { throw new Error(`隐私笔记 ${note.noteID} 解密失败：SSH 密码不一致或远端数据已损坏`) }
}

export interface EncodedMarkdownRepository {
  files: Map<string, Uint8Array>
  pageVersions: Map<string, number>
  skippedPageIds: string[]
}

export async function encodeMarkdownRepository(bundle: NotebookDataBundle, assetContents: Map<string, Uint8Array>, deviceId: string, privacySecret?: string): Promise<EncodedMarkdownRepository> {
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
    const currentContentHash = sha256Hex(currentMarkdown)
    const contentObjects: Record<string, string> = { [currentContentHash]: currentMarkdown }
    const history: MarkdownHistoryEntry[] = []
    let previousHash: string | undefined
    for (const revision of bundle.revisions.filter((item) => item.pageId === page.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      const markdown = markdownOf(revision.document)
      const contentHash = sha256Hex(markdown)
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
      const objectHash = bytes ? sha256Hex(bytes) : asset.checksum
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
    if (page.locked && !privacySecret) throw new Error(`隐私笔记 ${page.title} 无法安全同步：缺少 SSH 加密密码`)
    const storedEnvelope = page.locked ? await encryptPrivateNote(envelope, privacySecret!) : envelope
    files.set(`notes/${page.id}.json`, encoder.encode(JSON.stringify(storedEnvelope)))
    const version = Math.max(page.legacyVersion ?? 0, Date.parse(page.updatedAt), 1)
    pageVersions.set(page.id, version)
    if (!page.deletedAt) indexEntries.push({ noteID: page.id, version, contentHash: currentContentHash, historyCount: history.length })
  }

  files.set('notes/assets_manifest.json', encoder.encode(JSON.stringify({ schemaVersion: 3, deviceID: deviceId, entries: [...manifests.values()] })))
  const livePages = new Map(bundle.pages.filter((page) => !page.deletedAt).map((page) => [page.id, page]))
  const activeTombstones = bundle.tombstones.filter((item) => item.entityType === 'page' && (!livePages.get(item.entityId) || item.deletedAt >= livePages.get(item.entityId)!.updatedAt))
  files.set('notes/index.json', encoder.encode(JSON.stringify({ schemaVersion: 3, generatedAt: (Date.now() - Date.UTC(2001, 0, 1)) / 1000, deviceID: deviceId, repositoryFormat: { version: 3, noteEncoding: 'gzip', contentFormat: 'markdown-gfm', assetAddressing: 'sha256' }, entries: indexEntries, deletedEntries: activeTombstones.map((item) => ({ noteID: item.entityId, deletedAt: item.deletedAt, deletedByDeviceID: item.deviceId })) })))
  return { files, pageVersions, skippedPageIds: legacy.skippedPageIds }
}

export function validateMarkdownNote(note: MarkdownNoteEnvelope, expectedContentHash?: string) {
  if (note.schemaVersion !== 3) throw new Error(`笔记 ${note.noteID} 的 Markdown 协议版本无效`)
  if (note.metadata.id !== note.noteID) throw new Error(`笔记 ${note.noteID} 的元数据 ID 不一致`)
  if (expectedContentHash && expectedContentHash !== note.currentContentHash) throw new Error(`笔记 ${note.noteID} 与索引中的内容哈希不一致`)
  const current = note.contentObjects[note.currentContentHash]
  if (current === undefined) throw new Error(`笔记 ${note.noteID} 缺少当前正文对象`)
  if (sha256Hex(current) !== note.currentContentHash) throw new Error(`笔记 ${note.noteID} 的当前正文已损坏`)
  for (const entry of note.history) {
    const markdown = note.contentObjects[entry.contentHash]
    if (markdown === undefined) throw new Error(`笔记 ${note.noteID} 的历史版本 ${entry.id} 缺少正文对象`)
    if (sha256Hex(markdown) !== entry.contentHash) throw new Error(`笔记 ${note.noteID} 的历史版本 ${entry.id} 已损坏`)
  }
}

export async function importMarkdownRepository(input: { library: LegacyLibraryEnvelope; notes: StoredMarkdownNoteEnvelope[]; readingPositions?: LegacyReadingPositions; index?: { entries: Array<{ noteID: string; contentHash: string }> }; privacySecret?: string }, workspaceId: string) {
  const library = importLegacyLibrary(input.library, workspaceId)
  const now = new Date().toISOString()
  const index = new Map(input.index?.entries.map((entry) => [entry.noteID, entry.contentHash]) ?? [])
  const notes = await Promise.all(input.notes.map((note) => decryptPrivateNote(note, input.privacySecret)))
  for (const note of notes) validateMarkdownNote(note, index.get(note.noteID))
  const pages = notes.map((note) => ({ ...note.metadata, workspaceId, syncStatus: 'synced' as const }))
  const documents = notes.map((note) => {
    const markdown = note.contentObjects[note.currentContentHash]!
    return { pageId: note.noteID, schemaVersion: 3, markdown, tiptapJson: { type: 'doc', content: [] }, updatedAt: note.metadata.updatedAt }
  })
  const revisions = notes.flatMap((note) => note.history.flatMap((entry) => {
    const markdown = note.contentObjects[entry.contentHash]!
    // History is cold data. Its Markdown is authoritative and the editor tree is
    // rebuilt only when this exact revision is restored.
    return [{ id: entry.id, pageId: note.noteID, createdAt: entry.createdAt, reason: entry.reason, document: { pageId: note.noteID, schemaVersion: 3, markdown, tiptapJson: { type: 'doc', content: [] }, updatedAt: entry.updatedAt } }]
  }))
  return {
    notebooks: [library.notebook, ...(library.privateNotebook ? [library.privateNotebook] : [])], sections: library.sections, pages, documents,
    tags: library.tags, pageTags: notes.flatMap((note) => note.tagIDs.map((tagId) => ({ pageId: note.noteID, tagId }))),
    taskSteps: notes.flatMap((note) => note.taskSteps), assets: notes.flatMap((note) => note.assets),
    pageLinks: notes.flatMap((note) => note.linkedPageIDs.map((targetPageId) => ({ id: `markdown-link:${note.noteID}:${targetPageId}`, workspaceId, sourcePageId: note.noteID, targetPageId, kind: 'link' as const, createdAt: now }))),
    knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions, comments: [], tombstones: library.tombstones,
  } satisfies NotebookDataBundle
}
