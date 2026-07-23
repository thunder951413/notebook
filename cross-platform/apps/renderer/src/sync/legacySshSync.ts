import type { NotebookDataBundle, PageDocument, PageRevision } from '@notebook/domain'
import type { DexieNotebookRepository } from '@notebook/storage-renderer'
import { encodeMarkdownRepository, sha256Hex } from '@notebook/sync-contract'
import { decodeImport, type ImportFile } from '../data/transfer'
import { getLegacySshPassword, legacyDeviceId, loadLegacySshSettings, saveLegacySshSettings } from './legacySshSettings'
import { loadSyncSettings } from './syncSettings'
import { getSyncToken } from './syncSettings'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const bytesToBase64 = (value: Uint8Array) => {
  let result = ''
  for (let offset = 0; offset < value.length; offset += 0x8000) result += String.fromCharCode(...value.subarray(offset, offset + 0x8000))
  return btoa(result)
}
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

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
  const sources = new Map<string, 'local' | 'remote'>()
  const conflicts: string[] = []
  const pages = [...new Set([...localPages.keys(), ...remotePages.keys()])].flatMap((id) => {
    const left = localPages.get(id); const right = remotePages.get(id)
    if (!left && right) { sources.set(id, 'remote'); return [{ ...right, syncStatus: 'synced' as const }] }
    if (left && !right) { sources.set(id, 'local'); return [left] }
    if (!left || !right) return []
    const localDocument = localDocuments.get(id)
    const remoteDocument = remoteDocuments.get(id)
    const localHash = localDocument ? sha256Hex(documentSignature(localDocument)) : undefined
    const remoteHash = remoteDocument ? sha256Hex(documentSignature(remoteDocument)) : undefined
    const baselineHash = typeof left.legacyMetadata?.syncBaselineHash === 'string' ? left.legacyMetadata.syncBaselineHash : undefined
    const localChanged = left.syncStatus === 'pending' || left.syncStatus === 'conflict' || Boolean(baselineHash && localHash !== baselineHash)
    const remoteChanged = baselineHash ? remoteHash !== baselineHash : (right.legacyVersion ?? 0) >= (left.legacyVersion ?? 0) && remoteHash !== localHash
    if (localHash && remoteHash && localHash !== remoteHash && localChanged && remoteChanged) {
      conflicts.push(id)
      sources.set(id, 'local')
      return [{ ...left, legacyVersion: Math.max(left.legacyVersion ?? 0, right.legacyVersion ?? 0), syncStatus: 'conflict' as const, legacyMetadata: { ...left.legacyMetadata, syncBaselineHash: remoteHash } }]
    }
    const source = selectPage(left, right); sources.set(id, source)
    return [{ ...(source === 'remote' ? right : left), syncStatus: source === 'remote' ? 'synced' as const : left.syncStatus }]
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
  const revisions = latestById(local.revisions, remote.revisions)
  for (const [pageId, source] of sources) if (source === 'remote') {
    const oldDocument = localDocuments.get(pageId); const newDocument = remoteDocuments.get(pageId)
    if (oldDocument && newDocument && documentSignature(oldDocument) !== documentSignature(newDocument)) {
      const revision: PageRevision = { id: crypto.randomUUID(), pageId, document: oldDocument, createdAt: newDocument.updatedAt, reason: 'import' }
      revisions.push(revision)
    }
  }
  for (const pageId of conflicts) {
    const remoteDocument = remoteDocuments.get(pageId)
    if (remoteDocument && !revisions.some((item) => item.pageId === pageId && documentSignature(item.document) === documentSignature(remoteDocument))) {
      revisions.push({ id: crypto.randomUUID(), pageId, document: remoteDocument, createdAt: remoteDocument.updatedAt, reason: 'import' })
    }
  }
  const tombstones = latestById(local.tombstones.map((item) => ({ ...item, updatedAt: item.deletedAt })), remote.tombstones.map((item) => ({ ...item, updatedAt: item.deletedAt }))).map(({ updatedAt: _, ...item }) => item)
  const deletedAt = new Map(tombstones.filter((item) => item.entityType === 'page').map((item) => [item.entityId, item.deletedAt]))
  const mergedPages = pages.map((page) => deletedAt.get(page.id) && deletedAt.get(page.id)! >= page.updatedAt ? { ...page, deletedAt: deletedAt.get(page.id), syncStatus: 'synced' as const } : page)
  const effectiveTombstones = tombstones.filter((item) => {
    if (item.entityType !== 'page') return true
    const page = mergedPages.find((candidate) => candidate.id === item.entityId)
    return !page || Boolean(page.deletedAt) || item.deletedAt >= page.updatedAt
  })
  const bundle: NotebookDataBundle = {
    notebooks: importedPrivateNotebook && !localPrivateNotebook ? [...local.notebooks, importedPrivateNotebook] : local.notebooks,
    sections: latestById(local.sections, normalizedRemoteSections),
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

export async function synchronizeLegacySsh(repository: DexieNotebookRepository, workspaceId: string, force = false) {
  if (!force && !loadSyncSettings().enabled) return { state: 'offline' as const, skipped: 0, fingerprint: '' }
  const settings = loadLegacySshSettings()
  if (!settings.host || !settings.username || !settings.remotePath) return { state: 'offline' as const, skipped: 0, fingerprint: '' }
  const password = await getLegacySshPassword()
  if (!password) throw new Error('请在设置中填写并保存 SSH 密码')
  const connection = { ...settings, password }
  const bridgeUrl = ((import.meta.env.VITE_NOTEBOOK_LOCAL_BRIDGE_URL as string | undefined) ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const bridgeHeaders = async (): Promise<Record<string, string>> => {
    const token = await getSyncToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
  const pullArchive = async () => {
    const response = await fetch(`${bridgeUrl}/v1/local-sftp/pull-archive`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await bridgeHeaders()) }, body: JSON.stringify({ settings: connection }) })
    if (!response.ok) { const value = await response.json().catch(() => undefined) as { detail?: string } | undefined; throw new Error(value?.detail ?? `本地 SSH 助手连接失败：${response.status}`) }
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
    const metadataFile = archive['sync-result.json']
    if (!metadataFile) throw new Error('本地 SSH 助手返回的归档缺少同步元数据')
    const metadata = JSON.parse(strFromU8(metadataFile)) as { indexHash: string; fingerprint: string }
    const remoteFiles: ImportFile[] = Object.entries(archive).filter(([name]) => name.startsWith('repository/')).map(([name, data]) => ({ name: name.slice('repository/'.length), data }))
    return { metadata, remoteFiles }
  }
  let pulled: { indexHash: string; fingerprint: string }
  let remoteFiles: ImportFile[]
  if (window.notebookDesktop) {
    const result = await window.notebookDesktop.legacySftp.pull(connection)
    pulled = result
    remoteFiles = result.files.map((file) => ({ name: file.name, data: base64ToBytes(file.dataBase64) }))
  } else {
    const result = await pullArchive()
    pulled = result.metadata
    remoteFiles = result.remoteFiles
  }
  let trustedSettings = settings
  if (!settings.fingerprint && pulled.fingerprint) trustedSettings = await saveLegacySshSettings({ ...settings, fingerprint: pulled.fingerprint })
  const hasRemoteNotes = remoteFiles.some((file) => /^notes\/[0-9a-f-]{36}\.json$/i.test(file.name))
  const localBundle = await repository.exportData(workspaceId)
  const localContents = await repository.exportAssetContents(new Set(localBundle.pages.map((page) => page.id)))
  const decodedRemote = hasRemoteNotes ? await decodeImport(remoteFiles, workspaceId, password) : undefined
  const merged = decodedRemote ? mergeBundles(localBundle, decodedRemote.bundle, localContents, decodedRemote.assetContents) : { bundle: localBundle, contents: localContents, conflicts: [] }
  await repository.importData(merged.bundle)
  await repository.importAssetContents(merged.contents)
  if (merged.conflicts.length) return { state: 'conflict' as const, skipped: 0, fingerprint: pulled.fingerprint, conflicts: merged.conflicts }
  const encoded = await encodeMarkdownRepository(merged.bundle, merged.contents, legacyDeviceId(), password)
  if (window.notebookDesktop) {
    const files = [...encoded.files].map(([name, data]) => ({ name, dataBase64: bytesToBase64(data) }))
    await window.notebookDesktop.legacySftp.push({ ...trustedSettings, password }, files, pulled.indexHash)
  }
  else {
    const archiveEntries: Record<string, Uint8Array> = {
      'sync-request.json': strToU8(JSON.stringify({ settings: { ...trustedSettings, password }, expectedIndexHash: pulled.indexHash })),
    }
    for (const [name, data] of encoded.files) archiveEntries[`repository/${name}`] = data
    const response = await fetch(`${bridgeUrl}/v1/local-sftp/push-archive`, { method: 'POST', headers: { 'Content-Type': 'application/zip', ...(await bridgeHeaders()) }, body: zipSync(archiveEntries, { level: 1 }) })
    if (!response.ok) { const value = await response.json().catch(() => undefined) as { detail?: string } | undefined; throw new Error(value?.detail ?? `本地 SSH 助手连接失败：${response.status}`) }
  }
  const documents = new Map(merged.bundle.documents.map((document) => [document.pageId, document]))
  const syncedBundle: NotebookDataBundle = { ...merged.bundle, pages: merged.bundle.pages.map((page) => encoded.pageVersions.has(page.id) ? { ...page, legacyVersion: encoded.pageVersions.get(page.id), syncStatus: 'synced', legacyMetadata: { ...page.legacyMetadata, ...(documents.get(page.id) ? { syncBaselineHash: sha256Hex(documentSignature(documents.get(page.id)!)) } : {}) } } : page) }
  await repository.importData(syncedBundle)
  await repository.clearOutbox(workspaceId)
  return { state: 'synced' as const, skipped: encoded.skippedPageIds.length, fingerprint: pulled.fingerprint }
}

export async function publishPreparedLegacyArchive(file: File) {
  const settings = loadLegacySshSettings()
  const password = await getLegacySshPassword()
  if (!settings.host || !settings.username || !settings.remotePath || !password) throw new Error('请先完整填写并保存 SSH 设置和密码')
  const token = await getSyncToken()
  const bridgeUrl = ((import.meta.env.VITE_NOTEBOOK_LOCAL_BRIDGE_URL as string | undefined) ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const connection = bytesToBase64(strToU8(JSON.stringify({ ...settings, password })))
  const response = await fetch(`${bridgeUrl}/v1/local-sftp/publish-prepared-archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'X-Notebook-Ssh-Settings': connection, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file,
  })
  if (!response.ok) { const value = await response.json().catch(() => undefined) as { detail?: string } | undefined; throw new Error(value?.detail ?? `迁移仓库发布失败：${response.status}`) }
  return response.json() as Promise<{ fingerprint: string }>
}
