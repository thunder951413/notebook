import type { NotebookDataBundle, Page, PageDocument, PageRevision } from '@notebook/domain'
import type { DexieNotebookRepository } from '@notebook/storage-renderer'
import { encodeMarkdownRepository, sha256Hex } from '@notebook/sync-contract'
import { decodeImport, type ImportFile } from '../data/transfer'
import { getLegacySshPassword, legacyDeviceId, loadLegacySshSettings, saveLegacySshSettings } from './legacySshSettings'
import { loadSyncSettings } from './syncSettings'
import { unzipSync } from 'fflate'

const decoder = new TextDecoder()
const REMOTE_STATE_CACHE_PREFIX = 'notebook-ssh-remote-state-v3:'

// The last-seen remote state per connection+workspace: the raw index hash, the
// reading positions hash, the hashes of the remaining repository metadata and
// the per-note signature map. The C1 fast path compares a metadata-only probe
// against this snapshot; when nothing changed on either side the whole
// decode/merge/encode pipeline is skipped.
interface RemoteStateCache {
  indexHash: string
  readingPositionsHash: string
  libraryHash: string
  assetsManifestHash: string
  privacyHash: string
  signatures: Record<string, string>
}
type LegacySftpPullResult = Awaited<ReturnType<NonNullable<Window['notebookDesktop']>['legacySftp']['pull']>>

function repositoryEntrySignatures(indexBytes: Uint8Array | undefined) {
  const signatures = new Map<string, string>()
  if (!indexBytes) return signatures
  const parsed = JSON.parse(decoder.decode(indexBytes)) as {
    repositoryFormat?: { version?: number; noteEncoding?: string }
    entries?: Array<{ noteID?: string; version?: number; contentHash?: string; historyCount?: number }>
  }
  const encoding = (parsed.repositoryFormat?.version === 2 || parsed.repositoryFormat?.version === 3) && parsed.repositoryFormat.noteEncoding === 'gzip' ? 'gzip' : 'json'
  for (const entry of parsed.entries ?? []) if (entry.noteID) {
    signatures.set(entry.noteID, `${entry.version ?? 0}:${entry.contentHash ?? ''}:${entry.historyCount ?? 0}:${encoding}`)
  }
  return signatures
}

function remoteStateCacheKey(connection: { host: string; port: number; username: string; remotePath: string }, workspaceId: string) {
  return `${REMOTE_STATE_CACHE_PREFIX}${encodeURIComponent(`${connection.username}@${connection.host}:${connection.port}:${connection.remotePath}:${workspaceId}`)}`
}

function loadRemoteStateCache(key: string): RemoteStateCache | undefined {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(key) ?? 'null') as Partial<RemoteStateCache> | null
    if (!parsed
      || typeof parsed.indexHash !== 'string'
      || typeof parsed.readingPositionsHash !== 'string'
      || typeof parsed.libraryHash !== 'string'
      || typeof parsed.assetsManifestHash !== 'string'
      || typeof parsed.privacyHash !== 'string'
      || typeof parsed.signatures !== 'object'
      || !parsed.signatures) return undefined
    return {
      indexHash: parsed.indexHash,
      readingPositionsHash: parsed.readingPositionsHash,
      libraryHash: parsed.libraryHash,
      assetsManifestHash: parsed.assetsManifestHash,
      privacyHash: parsed.privacyHash,
      signatures: parsed.signatures,
    }
  } catch {
    return undefined
  }
}

function saveRemoteStateCache(key: string, state: RemoteStateCache) {
  window.localStorage?.setItem(key, JSON.stringify(state))
}

function remoteStateUnchanged(remote: RemoteStateCache, cached: RemoteStateCache) {
  if (remote.indexHash !== cached.indexHash
    || remote.readingPositionsHash !== cached.readingPositionsHash
    || remote.libraryHash !== cached.libraryHash
    || remote.assetsManifestHash !== cached.assetsManifestHash
    || remote.privacyHash !== cached.privacyHash) return false
  const remoteSignatures = Object.entries(remote.signatures).sort(([left], [right]) => left.localeCompare(right))
  const cachedSignatures = Object.entries(cached.signatures).sort(([left], [right]) => left.localeCompare(right))
  if (remoteSignatures.length !== cachedSignatures.length) return false
  return remoteSignatures.every(([noteId, signature], index) => cachedSignatures[index]?.[0] === noteId && cachedSignatures[index]?.[1] === signature)
}

function remoteStateFromPull(pulled: LegacySftpPullResult): RemoteStateCache {
  const file = (name: string) => pulled.files.find((item) => item.name === name)?.data
  const index = file('notes/index.json')
  const positions = file('notes/reading_positions.json')
  const library = file('library.json')
  const manifest = file('notes/assets_manifest.json')
  const privacy = file('notes/privacy.json')
  return {
    indexHash: pulled.indexHash,
    readingPositionsHash: positions ? sha256Hex(positions) : '',
    libraryHash: library ? sha256Hex(library) : '',
    assetsManifestHash: manifest ? sha256Hex(manifest) : '',
    privacyHash: privacy ? sha256Hex(privacy) : '',
    signatures: Object.fromEntries(repositoryEntrySignatures(index)),
  }
}

export function semanticallyEqualRepositoryJson(name: string, remote: Uint8Array | undefined, local: Uint8Array) {
  if (!remote || !name.endsWith('.json')) return false
  try {
    const normalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !['generatedAt', 'exportedAt', 'deviceID'].includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]))
    }
    return JSON.stringify(normalize(JSON.parse(decoder.decode(remote)))) === JSON.stringify(normalize(JSON.parse(decoder.decode(local))))
  } catch {
    return false
  }
}

function latestById<T extends { id: string; updatedAt?: string }>(local: T[], remote: T[]) {
  const result = new Map(local.map((item) => [item.id, item]))
  for (const item of remote) {
    const previous = result.get(item.id)
    if (!previous || (item.updatedAt ?? '') > (previous.updatedAt ?? '')) result.set(item.id, item)
  }
  return [...result.values()]
}

function selectPage(local: NotebookDataBundle['pages'][number], remote: NotebookDataBundle['pages'][number]) {
  const localVersion = local.legacyVersion ?? 0
  const remoteVersion = remote.legacyVersion ?? 0
  if (local.syncStatus === 'pending' && remoteVersion <= localVersion) return 'local' as const
  if (remoteVersion !== localVersion) return remoteVersion > localVersion ? 'remote' as const : 'local' as const
  return remote.updatedAt > local.updatedAt ? 'remote' as const : 'local' as const
}

const documentSignature = (document: PageDocument) => document.markdown ?? JSON.stringify(document.tiptapJson)

export function mergeBundles(local: NotebookDataBundle, remote: NotebookDataBundle, localAssets: Map<string, Uint8Array>, remoteAssets: Map<string, Uint8Array>) {
  const localPages = new Map(local.pages.map((page) => [page.id, page]))
  const remotePages = new Map(remote.pages.map((page) => [page.id, page]))
  const remoteDocuments = new Map(remote.documents.map((item) => [item.pageId, item]))
  const localDocuments = new Map(local.documents.map((item) => [item.pageId, item]))
  const publicNotebookIds = new Set(local.notebooks.filter((notebook) => !notebook.locked).map((notebook) => notebook.id))
  const knownSectionIds = new Set([...local.sections, ...remote.sections].map((section) => section.id))
  const fallbackSection = local.sections.find((section) => publicNotebookIds.has(section.notebookId) && /^(快速记录|quick notes?)$/i.test(section.name.trim()))
    ?? local.sections.find((section) => publicNotebookIds.has(section.notebookId))
    ?? local.sections[0]
  const placeInVisibleSection = <T extends Page>(page: T): T => page.sectionId && knownSectionIds.has(page.sectionId)
    ? page
    : fallbackSection
      ? { ...page, sectionId: fallbackSection.id }
      : page
  const sources = new Map<string, 'local' | 'remote'>()
  const localContentUnchangedFromBaseline = new Map<string, boolean>()
  const conflicts: string[] = []
  const pages = [...new Set([...localPages.keys(), ...remotePages.keys()])].flatMap((id) => {
    const left = localPages.get(id); const right = remotePages.get(id)
    const localDocument = localDocuments.get(id)
    const localHash = localDocument ? sha256Hex(documentSignature(localDocument)) : undefined
    const baselineHash = typeof left?.legacyMetadata?.syncBaselineHash === 'string' ? left.legacyMetadata.syncBaselineHash : undefined
    localContentUnchangedFromBaseline.set(id, Boolean(localHash && baselineHash && localHash === baselineHash))
    if (!left && right) { sources.set(id, 'remote'); return [placeInVisibleSection({ ...right, syncStatus: 'synced' as const })] }
    if (left && !right) { sources.set(id, 'local'); return [placeInVisibleSection(left)] }
    if (!left || !right) return []
    const remoteDocument = remoteDocuments.get(id)
    const remoteHash = remoteDocument ? sha256Hex(documentSignature(remoteDocument)) : undefined
    const localChanged = left.syncStatus === 'pending' || left.syncStatus === 'conflict' || Boolean(baselineHash && localHash !== baselineHash)
    const remoteChanged = baselineHash ? remoteHash !== baselineHash : (right.legacyVersion ?? 0) >= (left.legacyVersion ?? 0) && remoteHash !== localHash
    const localTreeTime = left.treeUpdatedAt ?? left.createdAt
    const remoteTreeTime = right.treeUpdatedAt ?? right.createdAt
    const tree = remoteTreeTime > localTreeTime ? right : left
    const withTree = <T extends Page>(value: T): T => placeInVisibleSection({
      ...value,
      sectionId: tree.sectionId,
      parentPageId: tree.parentPageId,
      sortOrder: tree.sortOrder,
      treeUpdatedAt: tree.treeUpdatedAt,
    })
    if (localHash && remoteHash && localHash !== remoteHash && localChanged && remoteChanged) {
      conflicts.push(id)
      sources.set(id, 'local')
      return [withTree({ ...left, legacyVersion: Math.max(left.legacyVersion ?? 0, right.legacyVersion ?? 0), syncStatus: 'conflict' as const, legacyMetadata: { ...left.legacyMetadata, syncBaselineHash: remoteHash } })]
    }
    const source = selectPage(left, right); sources.set(id, source)
    const selected = source === 'remote' ? right : left
    const localTreeWon = tree === left && (
      left.sectionId !== right.sectionId
      || left.parentPageId !== right.parentPageId
      || left.sortOrder !== right.sortOrder
    )
    return [withTree({
      ...selected,
      syncStatus: localTreeWon ? left.syncStatus : source === 'remote' ? 'synced' as const : left.syncStatus,
    })]
  })

  const localSections = new Map(local.sections.map((item) => [item.id, item]))
  const fallbackNotebook = local.notebooks.find((item) => item.name === '迁移的笔记') ?? local.notebooks[0]
  const localPrivateNotebook = local.notebooks.find((item) => item.locked)
  const remotePrivateNotebookIds = new Set(remote.notebooks.filter((item) => item.locked).map((item) => item.id))
  const importedPrivateNotebook = localPrivateNotebook ?? remote.notebooks.find((item) => item.locked)
  const normalizedRemoteSections = remote.sections.map((section) => ({
    ...section,
    notebookId: localSections.get(section.id)?.notebookId
      ?? (remotePrivateNotebookIds.has(section.notebookId) ? importedPrivateNotebook?.id : fallbackNotebook?.id)
      ?? section.notebookId,
  }))
  const sourceItems = <T extends { pageId: string }>(left: T[], right: T[]) => [...new Set([...left.map((item) => item.pageId), ...right.map((item) => item.pageId)])].flatMap((pageId) => (sources.get(pageId) === 'remote' ? right : left).filter((item) => item.pageId === pageId))
  const sourceLinks = [...new Set([...local.pageLinks.map((item) => item.sourcePageId), ...remote.pageLinks.map((item) => item.sourcePageId)])].flatMap((pageId) => (sources.get(pageId) === 'remote' ? remote.pageLinks : local.pageLinks).filter((item) => item.sourcePageId === pageId))
  const historyResetAt = (page: Page | undefined) => typeof page?.legacyMetadata?.historyResetAt === 'string'
    ? page.legacyMetadata.historyResetAt
    : undefined
  const revisionPageIds = new Set([
    ...local.revisions.map((item) => item.pageId),
    ...remote.revisions.map((item) => item.pageId),
    ...sources.keys(),
  ])
  const revisions = [...revisionPageIds].flatMap((pageId) => {
    const localResetAt = historyResetAt(localPages.get(pageId))
    const remoteResetAt = historyResetAt(remotePages.get(pageId))
    const localValues = local.revisions.filter((item) => item.pageId === pageId)
    const remoteValues = remote.revisions.filter((item) => item.pageId === pageId)
    if (localResetAt && (!remoteResetAt || localResetAt > remoteResetAt)) return localValues
    if (remoteResetAt && (!localResetAt || remoteResetAt > localResetAt)) return remoteValues
    return latestById(localValues, remoteValues)
  })
  for (const [pageId, source] of sources) if (source === 'remote') {
    const oldDocument = localDocuments.get(pageId); const newDocument = remoteDocuments.get(pageId)
    if (oldDocument && newDocument && documentSignature(oldDocument) !== documentSignature(newDocument)) {
      const revision: PageRevision = { id: crypto.randomUUID(), pageId, pageIcon: localPages.get(pageId)?.icon ?? null, document: oldDocument, createdAt: newDocument.updatedAt, reason: 'import' }
      revisions.push(revision)
    }
  }
  for (const pageId of conflicts) {
    const remoteDocument = remoteDocuments.get(pageId)
    if (remoteDocument && !revisions.some((item) => item.pageId === pageId && documentSignature(item.document) === documentSignature(remoteDocument))) {
      revisions.push({ id: crypto.randomUUID(), pageId, pageIcon: remotePages.get(pageId)?.icon ?? null, document: remoteDocument, createdAt: remoteDocument.updatedAt, reason: 'import' })
    }
  }
  const tombstones = latestById(local.tombstones.map((item) => ({ ...item, updatedAt: item.deletedAt })), remote.tombstones.map((item) => ({ ...item, updatedAt: item.deletedAt }))).map(({ updatedAt: _, ...item }) => item)
  const deletedAt = new Map(tombstones.filter((item) => item.entityType === 'page').map((item) => [item.entityId, item.deletedAt]))
  const deletedSections = new Map(tombstones.filter((item) => item.entityType === 'section').map((item) => [item.entityId, item.deletedAt]))
  const mergedPages = pages.map((page) => {
    const deletionTime = deletedAt.get(page.id)
    const deletionWins = deletionTime && (
      deletionTime >= page.updatedAt
      || localContentUnchangedFromBaseline.get(page.id)
    )
    return deletionWins ? { ...page, deletedAt: deletionTime, syncStatus: 'synced' as const } : page
  })
  const mergedSections = latestById(local.sections, normalizedRemoteSections).filter((section) => !deletedSections.get(section.id) || section.updatedAt > deletedSections.get(section.id)!)
  const effectiveTombstones = tombstones.filter((item) => {
    if (item.entityType !== 'page') return true
    const page = mergedPages.find((candidate) => candidate.id === item.entityId)
    return !page || Boolean(page.deletedAt) || item.deletedAt >= page.updatedAt
  })
  const bundle: NotebookDataBundle = {
    notebooks: importedPrivateNotebook && !localPrivateNotebook ? [...local.notebooks, importedPrivateNotebook] : local.notebooks,
    sections: mergedSections,
    pages: mergedPages,
    documents: [...sources].flatMap(([pageId, source]) => (source === 'remote' ? remoteDocuments : localDocuments).get(pageId) ?? []),
    tags: latestById(local.tags, remote.tags),
    pageTags: sourceItems(local.pageTags, remote.pageTags),
    taskSteps: sourceItems(local.taskSteps, remote.taskSteps),
    assets: sourceItems(local.assets, remote.assets),
    pageLinks: sourceLinks,
    // Reading progress is independent from the winning body revision. A user
    // can read farther on Android without editing there, so selecting progress
    // from the device that won the page-content conflict would move them back.
    readingPositions: latestById(local.readingPositions, remote.readingPositions),
    revisions,
    tombstones: effectiveTombstones,
    knowledgeEntities: [], knowledgeRelations: [], comments: [],
  }
  const contents = new Map<string, Uint8Array>()
  for (const asset of bundle.assets) {
    const source = sources.get(asset.pageId) === 'remote' ? remoteAssets : localAssets
    const content = source.get(asset.id) ?? localAssets.get(asset.id) ?? remoteAssets.get(asset.id)
    if (content) contents.set(asset.id, content)
  }
  return { bundle, contents, conflicts }
}

export function publicationBundleWithRemoteConflicts(merged: NotebookDataBundle, remote: NotebookDataBundle, conflictIds: Set<string>): NotebookDataBundle {
  const replaceByPage = <T extends { pageId: string }>(local: T[], upstream: T[]) => [
    ...local.filter((item) => !conflictIds.has(item.pageId)),
    ...upstream.filter((item) => conflictIds.has(item.pageId)),
  ]
  return {
    ...merged,
    pages: [...merged.pages.filter((item) => !conflictIds.has(item.id)), ...remote.pages.filter((item) => conflictIds.has(item.id))],
    documents: replaceByPage(merged.documents, remote.documents),
    pageTags: replaceByPage(merged.pageTags, remote.pageTags),
    taskSteps: replaceByPage(merged.taskSteps, remote.taskSteps),
    assets: replaceByPage(merged.assets, remote.assets),
    readingPositions: replaceByPage(merged.readingPositions, remote.readingPositions),
    revisions: replaceByPage(merged.revisions, remote.revisions),
    comments: replaceByPage(merged.comments, remote.comments),
    pageLinks: [
      ...merged.pageLinks.filter((item) => !conflictIds.has(item.sourcePageId)),
      ...remote.pageLinks.filter((item) => conflictIds.has(item.sourcePageId)),
    ],
  }
}

export type LegacySyncMode = 'bidirectional' | 'pull' | 'push'

const remoteIndexChanged = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('远端索引在同步期间已变化') || message.includes('远端索引在拉取期间已变化')
}

// Transient transport failures (broken pipe, reset connection) are retried
// like a changed index: the repository is content addressed and the index is
// written last, so an interrupted attempt is either harmless or will be
// detected by the next attempt's expected-index check.
const retryableTransportError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return /EPIPE|ECONNRESET|ECONNREFUSED|socket hang up|连接被重置|连接已断开/i.test(message)
}

export async function retryRemoteIndexChanges<T>(
  operation: (attempt: number) => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  maximumAttempts = 3,
) {
  let lastError: unknown
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      return { value: await operation(attempt), retryCount: attempt }
    } catch (error) {
      lastError = error
      if ((!remoteIndexChanged(error) && !retryableTransportError(error)) || attempt + 1 >= maximumAttempts) throw error
      await wait(150 * (2 ** attempt) + Math.random() * 150)
    }
  }
  throw lastError
}

async function synchronizeLegacySshAttempt(repository: DexieNotebookRepository, workspaceId: string, force = false, mode: LegacySyncMode = 'bidirectional') {
  if (!force && !loadSyncSettings().enabled) return { state: 'offline' as const, skipped: 0, fingerprint: '' }
  const settings = loadLegacySshSettings()
  if (!settings.host || !settings.username || !settings.remotePath) return { state: 'offline' as const, skipped: 0, fingerprint: '' }
  const password = await getLegacySshPassword()
  if (!password) throw new Error('请在设置中填写并保存 SSH 密码')
  if (!window.notebookDesktop) throw new Error('SSH/SFTP 同步仅在 Notebook Next Electron 桌面版中提供')
  const connection = { ...settings, password }
  const localBundle = await repository.exportData(workspaceId)
  const localAssets = new Map(localBundle.assets.map((asset) => [asset.id, asset]))
  const localDocumentsByPage = new Map(localBundle.documents.map((document) => [document.pageId, document]))
  const stateCacheKey = remoteStateCacheKey(connection, workspaceId)
  const cachedRemoteState = loadRemoteStateCache(stateCacheKey)
  const cachedRemoteSignatures = new Map(Object.entries(cachedRemoteState?.signatures ?? {}))
  const knownNoteSignatures = localBundle.pages.flatMap((page) => {
    const signature = cachedRemoteSignatures.get(page.id)
      ?? (typeof page.legacyMetadata?.remoteIndexSignature === 'string' ? page.legacyMetadata.remoteIndexSignature : undefined)
    const document = localDocumentsByPage.get(page.id)
    if (!signature || !document) return []
    const remoteHash = signature.split(':')[1]
    const baselineHash = typeof page.legacyMetadata?.syncBaselineHash === 'string' ? page.legacyMetadata.syncBaselineHash : undefined
    return remoteHash && (remoteHash === baselineHash || remoteHash === sha256Hex(documentSignature(document)))
      ? [{ noteID: page.id, signature }]
      : []
  })
  const outbox = await repository.listOutbox(workspaceId)
  let pulled: LegacySftpPullResult
  let sessionId: string | undefined
  try {
    // C1 fast path: with no pending local changes and a known last-seen remote
    // state, a metadata-only probe decides whether the repository changed at
    // all. Unchanged means the whole decode/merge/encode pipeline is skipped.
    if (mode === 'bidirectional' && outbox.length === 0 && cachedRemoteState !== undefined) {
      pulled = await window.notebookDesktop.legacySftp.pull(connection, { metadataOnly: true, knownNoteSignatures })
      sessionId = pulled.sessionId
      if (!settings.fingerprint && pulled.fingerprint) await saveLegacySshSettings({ ...settings, fingerprint: pulled.fingerprint })
      const probe = remoteStateFromPull(pulled)
      if (remoteStateUnchanged(probe, cachedRemoteState)) {
        return { state: 'synced' as const, skipped: 0, fingerprint: pulled.fingerprint }
      }
    }
    // The probe session (if any) is reused for the full pull below.
    const localContents = await repository.exportAssetContents(new Set(localBundle.pages.map((page) => page.id)))
    const knownObjectHashes = [...localContents].map(([assetId, bytes]) => {
      const declared = localAssets.get(assetId)?.checksum?.toLowerCase()
      return declared && /^[0-9a-f]{64}$/.test(declared) ? declared : sha256Hex(bytes)
    })
    pulled = await window.notebookDesktop.legacySftp.pull(connection, { knownObjectHashes, knownNoteSignatures, sessionId })
    sessionId = pulled.sessionId
    const remoteFiles: ImportFile[] = pulled.files.map((file) => ({ name: file.name, data: file.data }))
    let trustedSettings = settings
    if (!settings.fingerprint && pulled.fingerprint) trustedSettings = await saveLegacySshSettings({ ...settings, fingerprint: pulled.fingerprint })
    const remoteIndexBytes = remoteFiles.find((file) => file.name === 'notes/index.json')?.data
    const remoteSignatures = repositoryEntrySignatures(remoteIndexBytes)
    saveRemoteStateCache(stateCacheKey, remoteStateFromPull(pulled))
    const hasRemoteNotes = remoteFiles.some((file) => /^notes\/[0-9a-f-]{36}\.json$/i.test(file.name))
    const hasMarkdownRepository = hasRemoteNotes || (remoteIndexBytes ? (() => {
      try {
        return (JSON.parse(decoder.decode(remoteIndexBytes)) as { repositoryFormat?: { version?: number } }).repositoryFormat?.version === 3
      } catch {
        return false
      }
    })() : false)
    // C3: remote-referenced object bytes are loaded lazily from IndexedDB
    // instead of exporting the whole attachment store up front.
    const localAssetIdByHash = new Map([...localContents].map(([assetId, bytes]) => [sha256Hex(bytes), assetId]))
    const assetLoader = async (assetId: string, contentHash?: string) => {
      const localId = contentHash ? localAssetIdByHash.get(contentHash) ?? assetId : assetId
      const content = await repository.getAssetContent(localId)
      return content ? new Uint8Array(await content.arrayBuffer()) : undefined
    }
    const decodedRemote = hasMarkdownRepository ? await decodeImport(remoteFiles, workspaceId, password, assetLoader) : undefined
    const merged = decodedRemote ? mergeBundles(localBundle, decodedRemote.bundle, localContents, decodedRemote.assetContents) : { bundle: localBundle, contents: localContents, conflicts: [] }
    const conflictIds = new Set(merged.conflicts)
    if (mode === 'pull') {
      const documents = new Map(merged.bundle.documents.map((document) => [document.pageId, document]))
      const pulledBundle: NotebookDataBundle = {
        ...merged.bundle,
        pages: merged.bundle.pages.map((page) => {
          const document = documents.get(page.id)
          const signature = remoteSignatures.get(page.id)
          const remoteHash = signature?.split(':')[1]
          return document && signature && remoteHash === sha256Hex(documentSignature(document))
            ? { ...page, legacyMetadata: { ...page.legacyMetadata, remoteIndexSignature: signature } }
            : page
        }),
      }
      await repository.importAssetContents(merged.contents)
      await repository.importSyncResult(pulledBundle, localBundle)
      return merged.conflicts.length
        ? { state: 'conflict' as const, skipped: 0, fingerprint: pulled.fingerprint, conflicts: merged.conflicts }
        : { state: 'synced' as const, skipped: 0, fingerprint: pulled.fingerprint }
    }
    const publicationBundle = decodedRemote && conflictIds.size
      ? publicationBundleWithRemoteConflicts(merged.bundle, decodedRemote.bundle, conflictIds)
      : merged.bundle
    const publicationContents = new Map(merged.contents)
    if (decodedRemote && conflictIds.size) {
      for (const asset of decodedRemote.bundle.assets.filter((item) => conflictIds.has(item.pageId))) {
        const content = decodedRemote.assetContents.get(asset.id)
        if (content) publicationContents.set(asset.id, content)
      }
    }
    const publicationDocuments = new Map(publicationBundle.documents.map((document) => [document.pageId, document]))
    const reusableNoteSignatures = new Map(publicationBundle.pages.flatMap((page) => {
      const document = publicationDocuments.get(page.id)
      const signature = remoteSignatures.get(page.id)
      return page.syncStatus === 'synced' && document && signature?.split(':')[1] === sha256Hex(documentSignature(document))
        ? [[page.id, signature] as const]
        : []
    }))
    const encoded = await encodeMarkdownRepository(publicationBundle, publicationContents, legacyDeviceId(), password, reusableNoteSignatures)
    const nextIndex = encoded.files.get('notes/index.json')
    const nextSignatures = repositoryEntrySignatures(nextIndex)
    const remoteObjectHashes = new Set(pulled.objectHashes ?? [])
    const remoteFileMap = new Map(remoteFiles.map((file) => [file.name, file.data]))
    const files = [...encoded.files].flatMap(([name, data]) => {
      const noteMatch = /^notes\/([0-9a-f-]{36})\.json$/i.exec(name)
      if (noteMatch && remoteSignatures.get(noteMatch[1]!) === nextSignatures.get(noteMatch[1]!)) return []
      const objectMatch = /^objects\/[0-9a-f]{2}\/([0-9a-f]{64})$/i.exec(name)
      if (objectMatch && remoteObjectHashes.has(objectMatch[1]!.toLowerCase())) return []
      if (['library.json', 'notes/index.json', 'notes/reading_positions.json', 'notes/assets_manifest.json', 'notes/privacy.json'].includes(name)
        && semanticallyEqualRepositoryJson(name, remoteFileMap.get(name), data)) return []
      return [{ name, data }]
    })
    if (files.length > 0) await window.notebookDesktop.legacySftp.push({ ...trustedSettings, password }, files, pulled.indexHash, { knownObjectHashes: [...remoteObjectHashes], sessionId: pulled.sessionId })
    const documents = new Map(merged.bundle.documents.map((document) => [document.pageId, document]))
    const syncedBundle: NotebookDataBundle = { ...merged.bundle, pages: merged.bundle.pages.map((page) => !conflictIds.has(page.id) && encoded.pageVersions.has(page.id) ? { ...page, legacyVersion: encoded.pageVersions.get(page.id), syncStatus: 'synced', legacyMetadata: { ...page.legacyMetadata, ...(documents.get(page.id) ? { syncBaselineHash: sha256Hex(documentSignature(documents.get(page.id)!)) } : {}), ...(nextSignatures.get(page.id) ? { remoteIndexSignature: nextSignatures.get(page.id) } : {}) } } : page) }
    await repository.importAssetContents(merged.contents)
    await repository.importSyncResult(syncedBundle, localBundle)
    if (merged.conflicts.length) return { state: 'conflict' as const, skipped: encoded.skippedPageIds.length, fingerprint: pulled.fingerprint, conflicts: merged.conflicts }
    return { state: 'synced' as const, skipped: encoded.skippedPageIds.length, fingerprint: pulled.fingerprint }
  } finally {
    if (sessionId) await window.notebookDesktop.legacySftp.release(sessionId).catch(() => undefined)
  }
}

export async function synchronizeLegacySsh(repository: DexieNotebookRepository, workspaceId: string, force = false, mode: LegacySyncMode = 'bidirectional') {
  const { value, retryCount } = await retryRemoteIndexChanges(
    () => synchronizeLegacySshAttempt(repository, workspaceId, force, mode),
  )
  return { ...value, retryCount }
}

export async function publishPreparedLegacyArchive(file: File) {
  const settings = loadLegacySshSettings()
  const password = await getLegacySshPassword()
  if (!settings.host || !settings.username || !settings.remotePath || !password) throw new Error('请先完整填写并保存 SSH 设置和密码')
  if (!window.notebookDesktop) throw new Error('迁移仓库发布仅在 Notebook Next Electron 桌面版中提供')
  const connection = { ...settings, password }
  const pulled = await window.notebookDesktop.legacySftp.pull(connection)
  try {
    const trustedSettings = !settings.fingerprint && pulled.fingerprint ? await saveLegacySshSettings({ ...settings, fingerprint: pulled.fingerprint }) : settings
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
    const files = Object.entries(archive).filter(([name]) => name && !name.endsWith('/')).map(([name, data]) => ({
      name: name.startsWith('repository/') ? name.slice('repository/'.length) : name,
      data,
    }))
    if (!files.some((item) => item.name === 'notes/index.json')) throw new Error('迁移仓库 ZIP 缺少 notes/index.json')
    return window.notebookDesktop.legacySftp.push({ ...trustedSettings, password }, files, pulled.indexHash, { sessionId: pulled.sessionId })
  } finally {
    await window.notebookDesktop.legacySftp.release(pulled.sessionId)
  }
}
