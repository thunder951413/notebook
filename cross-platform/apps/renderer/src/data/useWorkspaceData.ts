import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Asset, Notebook, Page, PageDocument, Section } from '@notebook/domain'
import { indexPageForRetrieval } from '../ai/client'
import { decodeImport, encodeExport, type ImportFile } from './transfer'
import { documentToMarkdown, htmlToDocument, markdownToDocument } from '../editor/extensions'
import { DexieNotebookRepository, NotebookRendererDatabase } from '@notebook/storage-renderer'
import type { NotebookSummary, PageSummary } from '../model'
import { DEFAULT_WORKSPACE_ID } from '../sync/syncSettings'
import { synchronizeLegacySsh } from '../sync/legacySshSync'
import { legacyDeviceId } from '../sync/legacySshSettings'
import { markdownToEditorCache } from '@notebook/sync-contract'

export const WORKSPACE_ID = DEFAULT_WORKSPACE_ID
const db = new NotebookRendererDatabase(import.meta.env.VITE_NOTEBOOK_DATABASE_NAME ?? 'notebook-next')
const repository = new DexieNotebookRepository(db)
const pageMutationQueues = new Map<string, Promise<unknown>>()
const isEmptyEditorCache = (value: Record<string, unknown>) => value.type === 'doc' && Array.isArray(value.content) && value.content.length === 0

function enqueuePageMutation<T>(pageId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = pageMutationQueues.get(pageId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(mutation)
  pageMutationQueues.set(pageId, operation)
  return operation.finally(() => {
    if (pageMutationQueues.get(pageId) === operation) pageMutationQueues.delete(pageId)
  })
}

const timestamps = { createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z' }
const seedNotebooks: Notebook[] = [
  { id: 'personal', workspaceId: WORKSPACE_ID, name: '我的笔记本', emoji: '📓', sortOrder: 0, ...timestamps },
  { id: 'team', workspaceId: WORKSPACE_ID, name: '产品团队', emoji: '👥', sortOrder: 1, ...timestamps },
]
const seedSections: Section[] = [
  { id: 'inbox', notebookId: 'personal', name: '快速记录', color: '#7c3aed', sortOrder: 0, ...timestamps },
  { id: 'research', notebookId: 'personal', name: '研究与阅读', color: '#2563eb', sortOrder: 1, ...timestamps },
  { id: 'projects', notebookId: 'personal', name: '项目', color: '#0f766e', sortOrder: 2, ...timestamps },
  { id: 'product', notebookId: 'team', name: '产品设计', color: '#c2410c', sortOrder: 0, ...timestamps },
  { id: 'meetings', notebookId: 'team', name: '会议记录', color: '#be185d', sortOrder: 1, ...timestamps },
]
const seedPages: Page[] = [
  { id: 'vision', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'document', title: 'Notebook Next 产品愿景', preview: '把笔记、任务、AI 与跨设备编辑放进同一个可靠的工作区。', favorite: true, syncStatus: 'local', ...timestamps },
  { id: 'ai-workflow', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'document', title: 'AI 工作流设计', preview: '选择内容后可以总结、解释、改写，并把结果安全地写回当前笔记。', favorite: false, syncStatus: 'local', ...timestamps },
  { id: 'migration', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'document', title: '旧版本数据迁移', preview: '保留 UUID、附件校验、墓碑与版本历史，并提供迁移前快照。', favorite: false, syncStatus: 'local', ...timestamps },
  { id: 'task-review', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'task', title: '完成跨平台编辑器验收', preview: '验证表格、代码、附件、离线保存和三平台输入法。', favorite: false, important: true, dueAt: '2026-07-22T10:00:00.000Z', syncStatus: 'local', ...timestamps },
  { id: 'task-migration', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'task', title: '演练旧数据迁移', preview: '使用共享契约夹具完成 macOS → Next → Android 往返。', favorite: false, syncStatus: 'local', ...timestamps },
]

const tagMap: Record<string, string[]> = {
  vision: ['产品', '愿景'], 'ai-workflow': ['AI', '交互'], migration: ['迁移', '可靠性'],
}

const toPageSummary = (page: Page): PageSummary => ({
  id: page.id,
  sectionId: page.sectionId ?? '',
  title: page.title,
  preview: page.preview,
  updatedLabel: page.updatedAt.startsWith('2026-07-21') ? '刚刚' : new Date(page.updatedAt).toLocaleDateString(),
  tags: tagMap[page.id] ?? [],
  favorite: page.favorite,
  kind: page.kind,
  completedAt: page.completedAt,
  dueAt: page.dueAt,
  important: page.important,
  reminderAt: page.reminderAt,
  recurrenceRule: page.recurrenceRule,
  locked: page.locked,
  syncStatus: page.syncStatus,
})

export function useWorkspaceData() {
  const [notebookRecords, setNotebookRecords] = useState<Notebook[]>(seedNotebooks)
  const [sectionRecords, setSectionRecords] = useState<Section[]>(seedSections)
  const [pageRecords, setPageRecords] = useState<Page[]>(seedPages)
  const [trashRecords, setTrashRecords] = useState<Page[]>([])
  const [pageTags, setPageTags] = useState<Record<string, string[]>>(tagMap)
  const [documents, setDocuments] = useState<Record<string, Record<string, unknown>>>({})
  const loadedDocumentIds = useRef(new Set<string>())
  const [syncState, setSyncState] = useState<'offline' | 'syncing' | 'synced' | 'conflict' | 'error'>('offline')
  const [syncError, setSyncError] = useState<string>()
  const syncRunning = useRef(false)
  const privateNotebookIds = useMemo(() => new Set(notebookRecords.filter((notebook) => notebook.locked).map((notebook) => notebook.id)), [notebookRecords])
  const privateSectionIds = useMemo(() => new Set(sectionRecords.filter((section) => privateNotebookIds.has(section.notebookId)).map((section) => section.id)), [privateNotebookIds, sectionRecords])

  const reload = useCallback(async () => {
    const documentIds = [...loadedDocumentIds.current]
    const [loadedNotebooks, loadedPages, loadedDocuments] = await Promise.all([
      repository.listNotebooks(WORKSPACE_ID), repository.listPages({ includeDeleted: true, limit: 500 }),
      Promise.all(documentIds.map(async (pageId) => ({ document: await repository.getPageDocument(pageId), assets: await repository.listAssets(pageId) }))),
    ])
    const loadedSections = (await Promise.all(loadedNotebooks.map((item) => repository.listSections(item.id)))).flat()
    setNotebookRecords(loadedNotebooks)
    setSectionRecords(loadedSections)
    const livePages = loadedPages.items.filter((page) => !page.deletedAt)
    setPageRecords(livePages)
    setTrashRecords(loadedPages.items.filter((page) => page.deletedAt))
    const tags = await repository.listTags(WORKSPACE_ID)
    const names = new Map(tags.map((tag) => [tag.id, tag.name]))
    const associations = await Promise.all(livePages.map(async (page) => [page.id, (await repository.listPageTags(page.id)).flatMap((item) => names.get(item.tagId) ?? [])] as const))
    setPageTags(Object.fromEntries(associations))
    if (documentIds.length) {
      setDocuments((current) => {
        const next = { ...current }
        documentIds.forEach((pageId, index) => {
          const { document, assets } = loadedDocuments[index]!
          if (document) next[pageId] = document.markdown !== undefined && isEmptyEditorCache(document.tiptapJson)
            ? markdownToEditorCache(document.markdown, assets)
            : document.tiptapJson
          else delete next[pageId]
        })
        return next
      })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await repository.recoverDrafts()
      if ((await repository.listNotebooks(WORKSPACE_ID)).length === 0 && await db.tombstones.count() === 0) {
        await db.transaction('rw', db.notebooks, db.sections, db.pages, async () => {
          await db.notebooks.bulkPut(seedNotebooks)
          await db.sections.bulkPut(seedSections)
          await db.pages.bulkPut(seedPages)
        })
      }
      if (!cancelled) await reload()
    })()
    return () => { cancelled = true }
  }, [reload])

  const syncNow = useCallback(async (options?: { signal?: AbortSignal; force?: boolean }) => {
      if (syncRunning.current) return false
      syncRunning.current = true
      setSyncState('syncing')
      setSyncError(undefined)
      try {
        const result = await synchronizeLegacySsh(repository, WORKSPACE_ID, options?.force)
        setSyncState(result.state)
        if (result.state !== 'offline') await reload()
        return result.state !== 'offline'
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setSyncState('error')
          setSyncError(error instanceof Error ? error.message : '同步失败')
        }
        return false
      } finally { syncRunning.current = false }
  }, [reload])

  useEffect(() => {
    const controller = new AbortController()
    const sync = () => { void syncNow({ signal: controller.signal }) }
    sync()
    const timer = window.setInterval(sync, 60_000)
    window.addEventListener('online', sync)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('online', sync) }
  }, [syncNow])

  const notebooks = useMemo<NotebookSummary[]>(() => notebookRecords.map((notebook) => ({
    id: notebook.id,
    name: notebook.name,
    emoji: notebook.emoji ?? '📒',
    locked: notebook.locked,
    sections: sectionRecords.filter((section) => section.notebookId === notebook.id).map((section) => ({
      id: section.id,
      name: section.name,
      color: section.color ?? '#7c3aed',
      pageCount: pageRecords.filter((page) => page.sectionId === section.id && page.kind !== 'task' && !page.deletedAt).length,
    })),
  })), [notebookRecords, sectionRecords, pageRecords])

  const pages = useMemo(() => pageRecords.map((page) => ({ ...toPageSummary(page), tags: pageTags[page.id] ?? toPageSummary(page).tags, locked: page.locked || privateSectionIds.has(page.sectionId ?? '') })), [pageRecords, pageTags, privateSectionIds])
  const trashPages = useMemo(() => trashRecords.map((page) => ({ ...toPageSummary(page), locked: page.locked || privateSectionIds.has(page.sectionId ?? '') })), [privateSectionIds, trashRecords])

  const loadDocument = useCallback(async (pageId: string) => {
    loadedDocumentIds.current.add(pageId)
    if (documents[pageId]) return documents[pageId]
    const document = await repository.getPageDocument(pageId)
    if (!document) return undefined
    const tiptapJson = document.markdown !== undefined && isEmptyEditorCache(document.tiptapJson)
      ? markdownToEditorCache(document.markdown, await repository.listAssets(pageId))
      : document.tiptapJson
    setDocuments((current) => ({ ...current, [pageId]: tiptapJson }))
    return tiptapJson
  }, [documents])

  const saveDocument = useCallback(async (pageId: string, tiptapJson: Record<string, unknown>) => {
    loadedDocumentIds.current.add(pageId)
    const updatedAt = new Date().toISOString()
    const document: PageDocument = { pageId, schemaVersion: 3, markdown: documentToMarkdown(tiptapJson), tiptapJson, updatedAt }
    await repository.stageDraft(document)
    await enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page) return
      await repository.savePage({ ...page, updatedAt, syncStatus: 'pending' }, document)
      setDocuments((current) => ({ ...current, [pageId]: tiptapJson }))
      if (!page.locked && !privateSectionIds.has(page.sectionId ?? '')) void indexPageForRetrieval(WORKSPACE_ID, pageId, page.title, extractDocumentText(tiptapJson)).catch(() => undefined)
    })
  }, [privateSectionIds])

  const stageDocument = useCallback(async (pageId: string, tiptapJson: Record<string, unknown>) => {
    const updatedAt = new Date().toISOString()
    await repository.stageDraft({ pageId, schemaVersion: 3, markdown: documentToMarkdown(tiptapJson), tiptapJson, updatedAt })
  }, [])

  const createPage = useCallback(async (sectionId: string, kind: Page['kind'] = 'document') => {
    const now = new Date().toISOString()
    const page: Page = { id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, sectionId, kind, title: kind === 'task' ? '新任务' : '无标题页面', preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending', locked: privateSectionIds.has(sectionId) }
    await repository.savePage(page)
    await reload()
    return page.id
  }, [privateSectionIds, reload])

  const createNotebook = useCallback(async (name: string) => {
    const now = new Date().toISOString()
    const notebook: Notebook = { id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, name, emoji: '📒', sortOrder: notebookRecords.length, createdAt: now, updatedAt: now }
    await repository.saveNotebook(notebook); await reload(); return notebook.id
  }, [notebookRecords.length, reload])

  const createSection = useCallback(async (notebookId: string, name: string) => {
    const now = new Date().toISOString()
    const section: Section = { id: crypto.randomUUID(), notebookId, name, color: '#7c3aed', sortOrder: sectionRecords.filter((item) => item.notebookId === notebookId).length, createdAt: now, updatedAt: now }
    await repository.saveSection(section); await reload(); return section.id
  }, [reload, sectionRecords])

  const renameNotebook = useCallback(async (notebookId: string, name: string) => {
    const notebook = notebookRecords.find((item) => item.id === notebookId)
    if (!notebook) throw new Error('笔记本不存在')
    await repository.saveNotebook({ ...notebook, name, updatedAt: new Date().toISOString() })
    await reload()
  }, [notebookRecords, reload])

  const deleteNotebook = useCallback(async (notebookId: string) => {
    await repository.deleteNotebook(notebookId, new Date().toISOString(), legacyDeviceId())
    await reload()
  }, [reload])

  const renameSection = useCallback(async (sectionId: string, name: string) => {
    const section = sectionRecords.find((item) => item.id === sectionId)
    if (!section) throw new Error('分区不存在')
    await repository.saveSection({ ...section, name, updatedAt: new Date().toISOString() })
    await reload()
  }, [reload, sectionRecords])

  const deleteSection = useCallback(async (sectionId: string) => {
    await repository.deleteSection(sectionId, new Date().toISOString(), legacyDeviceId())
    await reload()
  }, [reload])

  const duplicatePage = useCallback(async (pageId: string) => {
    const id = crypto.randomUUID()
    await repository.duplicatePage(pageId, id, new Date().toISOString())
    await reload()
    return id
  }, [reload])

  const updatePage = useCallback(async (pageId: string, patch: Partial<Page>) => {
    await enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page) throw new Error(`Page not found: ${pageId}`)
      await repository.savePage({ ...page, ...patch, id: page.id, updatedAt: new Date().toISOString(), syncStatus: 'pending' })
      await reload()
    })
  }, [reload])

  const loadTaskSteps = useCallback((pageId: string) => repository.listTaskSteps(pageId), [])
  const saveTaskSteps = useCallback((pageId: string, steps: import('@notebook/domain').TaskStep[]) => repository.saveTaskSteps(pageId, steps), [])

  const importFiles = useCallback(async (files: ImportFile[], sectionId: string) => {
    const textFiles = files.filter((file) => /\.(md|markdown|txt|html?)$/i.test(file.name))
    for (const file of textFiles) {
      const now = new Date().toISOString()
      const id = crypto.randomUUID()
      const source = new TextDecoder().decode(file.data)
      const documentJson = /\.html?$/i.test(file.name) ? htmlToDocument(source) : markdownToDocument(source)
      const title = file.name.replace(/\.(md|markdown|txt|html?)$/i, '') || '导入页面'
      const page: Page = { id, workspaceId: WORKSPACE_ID, sectionId, kind: 'document', title, preview: extractDocumentText(documentJson).slice(0, 240), favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending' }
      await repository.savePage(page, { pageId: id, schemaVersion: 3, markdown: /\.html?$/i.test(file.name) ? documentToMarkdown(documentJson) : source, tiptapJson: documentJson, updatedAt: now })
    }
    const bundleFiles = files.filter((file) => !/\.(md|markdown|txt|html?)$/i.test(file.name))
    const decoded = bundleFiles.length ? await decodeImport(bundleFiles, WORKSPACE_ID) : undefined
    if (decoded) {
      await repository.importData(decoded.bundle)
      await repository.importAssetContents(decoded.assetContents)
      await repository.queueImportedData(decoded.bundle)
    }
    await reload()
    return textFiles.length + (decoded?.bundle.pages.length ?? 0)
  }, [reload])

  const exportWorkspace = useCallback(async () => {
    const bundle = await repository.exportData(WORKSPACE_ID)
    return encodeExport(bundle, await repository.exportAssetContents(new Set(bundle.pages.map((page) => page.id))))
  }, [])
  const loadAssets = useCallback((pageId: string) => repository.listAssets(pageId), [])
  const saveAsset = useCallback(async (pageId: string, file: File) => {
    const kind: Asset['kind'] = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'file'
    const asset: Asset = { id: crypto.randomUUID(), pageId, kind, filename: file.name, mimeType: file.type || 'application/octet-stream', byteSize: file.size, createdAt: new Date().toISOString() }
    await repository.saveAsset(asset, file)
    return asset
  }, [])
  const openAsset = useCallback(async (asset: Asset) => {
    const content = await repository.getAssetContent(asset.id)
    if (!content) throw new Error('附件内容尚未下载到本机')
    const url = URL.createObjectURL(content)
    const link = Object.assign(document.createElement('a'), { href: url, download: asset.filename })
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }, [])
  const getAssetContent = useCallback((assetId: string) => repository.getAssetContent(assetId), [])
  const searchWorkspace = useCallback(async (query: string, limit?: number, includeLocked = false) => {
    const results = await repository.searchWorkspace(WORKSPACE_ID, query, includeLocked ? limit : undefined)
    const visible = includeLocked ? results : results.filter((page) => !page.locked && !privateSectionIds.has(page.sectionId ?? ''))
    return limit == null ? visible : visible.slice(0, limit)
  }, [privateSectionIds])
  const moveToTrash = useCallback(async (pageId: string) => { await repository.movePageToTrash(pageId, new Date().toISOString(), legacyDeviceId()); await reload() }, [reload])
  const restorePage = useCallback(async (pageId: string) => { await repository.restorePage(pageId); await reload() }, [reload])
  const purgePage = useCallback(async (pageId: string) => { await repository.purgePage(pageId, new Date().toISOString(), legacyDeviceId()); await reload() }, [reload])
  const loadRevisions = useCallback((pageId: string) => repository.listRevisions(pageId), [])
  const restoreRevision = useCallback(async (revisionId: string) => { const document = await repository.restoreRevision(revisionId); setDocuments((current) => ({ ...current, [document.pageId]: document.tiptapJson })); await reload(); return document.pageId }, [reload])
  const loadReadingPosition = useCallback((pageId: string) => repository.getReadingPosition(pageId), [])
  const saveReadingPosition = useCallback(async (pageId: string, viewportOffsetFraction: number) => {
    const previous = await repository.getReadingPosition(pageId)
    await repository.saveReadingPosition({
      id: pageId,
      pageId,
      anchorUtf16Offset: previous?.anchorUtf16Offset ?? 0,
      viewportOffsetFraction: Math.max(0, Math.min(1, viewportOffsetFraction)),
      updatedAt: new Date().toISOString(),
      deviceId: legacyDeviceId(),
    })
  }, [])
  return { notebooks, pages, trashPages, documents, syncState, syncError, syncNow, loadDocument, saveDocument, stageDocument, createPage, createNotebook, createSection, renameNotebook, deleteNotebook, renameSection, deleteSection, duplicatePage, updatePage, loadTaskSteps, saveTaskSteps, importFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, moveToTrash, restorePage, purgePage, loadRevisions, restoreRevision, loadReadingPosition, saveReadingPosition }
}

function extractDocumentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractDocumentText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(extractDocumentText).filter(Boolean).join(' ')
}
