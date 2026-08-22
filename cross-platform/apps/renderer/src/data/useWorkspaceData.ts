import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Asset, Notebook, Page, PageDocument, Section } from '@notebook/domain'
import { indexPageForRetrieval } from '../ai/client'
import { decodeImport, encodeExport, type ImportFile } from './transfer'
import { documentToMarkdown, htmlToDocument, markdownToDocument } from '../editor/extensions'
import { DexieNotebookRepository, NotebookRendererDatabase } from '@notebook/storage-renderer'
import type { NotebookSummary, PageSummary } from '../model'
import { DEFAULT_WORKSPACE_ID, loadSyncSettings } from '../sync/syncSettings'
import { synchronizeLegacySsh, type LegacySyncMode } from '../sync/legacySshSync'
import { legacyDeviceId, loadSyncBackend } from '../sync/legacySshSettings'
import { synchronizeWebdav } from '../sync/webdavSync'
import { normalizeReferenceTargetIds } from '@notebook/sync-contract'
import { parseMarkdownForEditor } from './markdownParser'
import { pageLinksFromMarkdown } from './referenceIndex'
import { formatUpdatedLabel } from '../updatedLabel'
import { applyPendingPatch, replaceById, withRecords, withoutIds } from './pageState'
import { notebookRootSectionId, planNotebookPageRootMigration, withoutNotebookRootMarker } from './notebookPageRoots'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'
import { lockedForSection, planPagePrivacyNormalization } from './privacyPlacement'
import { AUTO_SYNC_DEBOUNCE_MS, createQuietSyncScheduler, createSyncStateFinalizer, schedulePendingSyncBatch, type SettledSyncState } from '../sync/syncLifecycle'

export const WORKSPACE_ID = DEFAULT_WORKSPACE_ID
// A fresh install opens on the bundled sample workspace so the first screen has
// content. These IDs seed the database below and are the single source of truth
// for the app shell's initial selection.
export const STARTUP_NOTEBOOK_ID = 'team'
export const STARTUP_SECTION_ID = 'product'
export const STARTUP_PAGE_ID = 'vision'
const db = new NotebookRendererDatabase(import.meta.env.VITE_NOTEBOOK_DATABASE_NAME ?? 'notebook-next')
const repository = new DexieNotebookRepository(db)
export const automationRepository = repository
const pageMutationQueues = new Map<string, Promise<unknown>>()
const documentLoadPromises = new Map<string, Promise<Record<string, unknown> | undefined>>()
const isEmptyEditorCache = (value: Record<string, unknown>) => value.type === 'doc' && Array.isArray(value.content) && value.content.length === 0
const REFERENCE_INDEX_VERSION_KEY = 'notebook-reference-index-version'
const emptyEditorDocument = () => ({ type: 'doc', content: [{ type: 'paragraph' }] })
let notebookRootMigration: Promise<void> | undefined
let pagePrivacyNormalization: Promise<void> | undefined
let lastDocumentSaveDiagnosticAt = 0

async function ensureNotebookPageRoots() {
  if (notebookRootMigration) return notebookRootMigration
  notebookRootMigration = (async () => {
    const notebooks = await repository.listNotebooks(WORKSPACE_ID)
    const sections = (await Promise.all(notebooks.map((notebook) => repository.listSections(notebook.id)))).flat()
    const pages: Page[] = []
    let cursor: string | undefined
    do {
      const batch = await repository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: true, limit: 500, cursor })
      pages.push(...batch.items)
      cursor = batch.nextCursor
    } while (cursor)
    const now = new Date().toISOString()
    const migration = planNotebookPageRootMigration(sections, pages, WORKSPACE_ID, now, () => crypto.randomUUID())
    for (const root of migration.roots) {
      await repository.savePage(root, {
        pageId: root.id,
        schemaVersion: 3,
        markdown: '',
        tiptapJson: emptyEditorDocument(),
        updatedAt: now,
      })
    }
    for (const page of migration.reparented) await repository.savePage(page)
  })().finally(() => { notebookRootMigration = undefined })
  return notebookRootMigration
}

async function ensurePagePrivacyMatchesNotebook() {
  if (pagePrivacyNormalization) return pagePrivacyNormalization
  pagePrivacyNormalization = (async () => {
    const notebooks = await repository.listNotebooks(WORKSPACE_ID)
    const sections = (await Promise.all(notebooks.map((notebook) => repository.listSections(notebook.id)))).flat()
    const pages: Page[] = []
    let cursor: string | undefined
    do {
      const batch = await repository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: true, limit: 500, cursor })
      pages.push(...batch.items)
      cursor = batch.nextCursor
    } while (cursor)
    const changedAt = new Date().toISOString()
    const changed = planPagePrivacyNormalization(pages, sections, notebooks, changedAt)
    for (const page of changed) await repository.savePage(page)
    if (changed.length) recordDiagnosticEvent({ level: 'info', category: 'privacy', action: 'normalize-page-placement', status: 'success', message: `${changed.length} pages` })
  })().finally(() => { pagePrivacyNormalization = undefined })
  return pagePrivacyNormalization
}

function editorCacheVersion(document: PageDocument, assets: Asset[]) {
  const assetVersion = assets
    .map((asset) => `${asset.id}:${asset.checksum}`)
    .sort()
    .join('|')
  return `${document.updatedAt}:${document.markdown?.length ?? 0}:${assetVersion}`
}

async function editorDocumentFromStorage(document: PageDocument, assets: Asset[]) {
  if (document.markdown === undefined || !isEmptyEditorCache(document.tiptapJson)) return document.tiptapJson
  const version = editorCacheVersion(document, assets)
  const cached = await repository.getEditorCache(document.pageId, version)
  if (cached) return cached
  const parsed = await parseMarkdownForEditor(document.markdown, assets)
  void repository.saveEditorCache(document.pageId, version, parsed)
  return parsed
}

async function rebuildReferenceIndex() {
  const pages = await repository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: false, limit: 10_000 })
  for (const page of pages.items) {
    const document = await repository.getPageDocument(page.id)
    if (!document) continue
    const markdown = document.markdown ?? documentToMarkdown(document.tiptapJson)
    await repository.replaceDerivedPageLinks(page.id, pageLinksFromMarkdown(page.id, markdown, document.updatedAt))
  }
}

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
  { id: STARTUP_NOTEBOOK_ID, workspaceId: WORKSPACE_ID, name: '产品团队', emoji: '👥', sortOrder: 1, ...timestamps },
]
const seedSections: Section[] = [
  { id: 'inbox', notebookId: 'personal', name: '快速记录', color: '#7c3aed', sortOrder: 0, ...timestamps },
  { id: 'research', notebookId: 'personal', name: '研究与阅读', color: '#2563eb', sortOrder: 1, ...timestamps },
  { id: 'projects', notebookId: 'personal', name: '项目', color: '#0f766e', sortOrder: 2, ...timestamps },
  { id: 'product', notebookId: STARTUP_NOTEBOOK_ID, name: '产品设计', color: '#c2410c', sortOrder: 0, ...timestamps },
  { id: 'meetings', notebookId: 'team', name: '会议记录', color: '#be185d', sortOrder: 1, ...timestamps },
]
const seedPages: Page[] = [
  { id: STARTUP_PAGE_ID, workspaceId: WORKSPACE_ID, sectionId: STARTUP_SECTION_ID, kind: 'document', title: 'Notebook Next 产品愿景', preview: '把笔记、任务、AI 与跨设备编辑放进同一个可靠的工作区。', favorite: true, syncStatus: 'local', ...timestamps },
  { id: 'ai-workflow', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'document', title: 'AI 工作流设计', preview: '选择内容后可以总结、解释、改写，并把结果安全地写回当前笔记。', favorite: false, syncStatus: 'local', ...timestamps },
  { id: 'migration', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'document', title: '旧版本数据迁移', preview: '保留 UUID、附件校验、墓碑与版本历史，并提供迁移前快照。', favorite: false, syncStatus: 'local', ...timestamps },
  { id: 'task-review', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'task', title: '完成跨平台编辑器验收', preview: '验证表格、代码、附件、离线保存和三平台输入法。', favorite: false, important: true, dueAt: '2026-07-22T10:00:00.000Z', syncStatus: 'local', ...timestamps },
  { id: 'task-migration', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'task', title: '演练旧数据迁移', preview: '使用共享契约夹具完成 macOS → Next → Android 往返。', favorite: false, syncStatus: 'local', ...timestamps },
]

const tagMap: Record<string, string[]> = {
  [STARTUP_PAGE_ID]: ['产品', '愿景'], 'ai-workflow': ['AI', '交互'], migration: ['迁移', '可靠性'],
}

const toPageSummary = (page: Page): PageSummary => ({
  id: page.id,
  sectionId: page.sectionId ?? '',
  icon: page.icon,
  notebookRoot: Boolean(notebookRootSectionId(page)),
  parentPageId: page.parentPageId,
  sortOrder: page.sortOrder,
  treeUpdatedAt: page.treeUpdatedAt,
  title: page.title,
  preview: page.preview,
  updatedLabel: formatUpdatedLabel(page.updatedAt),
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
  const [referenceIndexRevision, setReferenceIndexRevision] = useState(0)
  const documentsRef = useRef(documents)
  const loadedDocumentIds = useRef(new Set<string>())
  // Latest-record mirrors for callbacks that must not depend on state identity.
  const sectionRecordsRef = useRef(sectionRecords)
  const pageRecordsRef = useRef(pageRecords)
  const trashRecordsRef = useRef(trashRecords)
  sectionRecordsRef.current = sectionRecords
  pageRecordsRef.current = pageRecords
  trashRecordsRef.current = trashRecords
  const [syncState, setSyncState] = useState<'offline' | 'syncing' | 'synced' | 'conflict' | 'error'>('offline')
  const [syncError, setSyncError] = useState<string>()
  const settledSyncState = useRef<SettledSyncState>('offline')
  const syncRunning = useRef(false)
  const syncTask = useRef<Promise<boolean> | undefined>(undefined)
  const queuedSyncTask = useRef<Promise<boolean> | undefined>(undefined)
  const syncScheduler = useRef<ReturnType<typeof createQuietSyncScheduler> | undefined>(undefined)
  const privateNotebookIds = useMemo(() => new Set(notebookRecords.filter((notebook) => notebook.locked).map((notebook) => notebook.id)), [notebookRecords])
  const privateSectionIds = useMemo(() => new Set(sectionRecords.filter((section) => privateNotebookIds.has(section.notebookId)).map((section) => section.id)), [privateNotebookIds, sectionRecords])

  useEffect(() => {
    documentsRef.current = documents
  }, [documents])

  const reload = useCallback(async () => {
    await ensureNotebookPageRoots()
    await ensurePagePrivacyMatchesNotebook()
    const documentIds = [...loadedDocumentIds.current]
    const loadEveryPage = async () => {
      const items: Page[] = []
      let cursor: string | undefined
      do {
        const batch = await repository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: true, limit: 500, cursor })
        items.push(...batch.items)
        cursor = batch.nextCursor
      } while (cursor)
      return items
    }
    const [loadedNotebooks, loadedPages, loadedDocuments] = await Promise.all([
      repository.listNotebooks(WORKSPACE_ID), loadEveryPage(),
      Promise.all(documentIds.map(async (pageId) => {
        const [document, assets] = await Promise.all([repository.getPageDocument(pageId), repository.listAssets(pageId)])
        if (!document) return { document, assets }
        return { document: { ...document, tiptapJson: await editorDocumentFromStorage(document, assets) }, assets }
      })),
    ])
    const loadedSections = (await Promise.all(loadedNotebooks.map((item) => repository.listSections(item.id)))).flat()
    setNotebookRecords(loadedNotebooks)
    setSectionRecords(loadedSections)
    const livePages = loadedPages.filter((page) => !page.deletedAt)
    setPageRecords(livePages)
    setTrashRecords(loadedPages.filter((page) => page.deletedAt))
    const tags = await repository.listTags(WORKSPACE_ID)
    const names = new Map(tags.map((tag) => [tag.id, tag.name]))
    const associations = await Promise.all(livePages.map(async (page) => [page.id, (await repository.listPageTags(page.id)).flatMap((item) => names.get(item.tagId) ?? [])] as const))
    setPageTags(Object.fromEntries(associations))
    if (documentIds.length) {
      setDocuments((current) => {
        const next = { ...current }
        documentIds.forEach((pageId, index) => {
          const { document } = loadedDocuments[index]!
          if (document) next[pageId] = document.tiptapJson
          // A legacy/seed page may not have a persisted body yet. Keep the
          // already-open empty editor instead of replacing it with a permanent
          // loading placeholder during an overlapping library refresh.
          else if (!next[pageId]) next[pageId] = emptyEditorDocument()
        })
        return next
      })
    }
    setReferenceIndexRevision((current) => current + 1)
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
      if (!cancelled) recordDiagnosticEvent({ level: 'info', category: 'workspace', action: 'loaded', status: 'success' })
      if (!cancelled && globalThis.localStorage?.getItem(REFERENCE_INDEX_VERSION_KEY) !== '1') {
        await rebuildReferenceIndex()
        globalThis.localStorage?.setItem(REFERENCE_INDEX_VERSION_KEY, '1')
      }
    })()
    return () => { cancelled = true }
  }, [reload])

  const syncNow = useCallback((options?: { signal?: AbortSignal; force?: boolean; mode?: LegacySyncMode; scope?: { pageId: string } }): Promise<boolean> => {
      if (syncTask.current) {
        // A blur/focus may make a durable change while a quiet-period sync is
        // already in flight. Coalesce one follow-up so that change is not
        // left behind until another unrelated edit occurs.
        if (!queuedSyncTask.current) {
          queuedSyncTask.current = syncTask.current.then(() => {
            queuedSyncTask.current = undefined
            return syncNow(options)
          })
        }
        return queuedSyncTask.current
      }
      syncScheduler.current?.cancel()
      const operation = (async () => {
      // The auto-sync switch gates every automatic trigger (startup, opening
      // a note, debounced edit sync); the manual toolbar button forces through.
      if (!options?.force && !loadSyncSettings().enabled) {
        setSyncState('offline')
        return false
      }
      syncRunning.current = true
      const startedAt = performance.now()
      const mode = options?.mode ?? 'bidirectional'
      const stateFinalizer = createSyncStateFinalizer(settledSyncState.current, (state) => {
        settledSyncState.current = state
        setSyncState(state)
      })
      setSyncState('syncing')
      setSyncError(undefined)
      recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'run', status: 'started', message: mode })
      try {
        const result = loadSyncBackend() === 'webdav'
          ? await synchronizeWebdav(repository, WORKSPACE_ID, options?.signal, options?.scope)
          : await synchronizeLegacySsh(repository, WORKSPACE_ID, options?.force, options?.mode)
        stateFinalizer.complete(result.state)
        if (result.state !== 'offline') await reload()
        // WebDAV acknowledges one bounded outbox batch at a time. Acking 200
        // items does not create another Dexie record, so schedule the next
        // batch explicitly instead of leaving the tail stranded forever. The
        // same quiet period prevents v4's whole-journal rewrite from becoming
        // an in-flight request storm.
        if (result.state === 'synced') await schedulePendingSyncBatch(
          () => repository.hasPendingSyncChanges(WORKSPACE_ID),
          () => syncScheduler.current?.request(),
        )
        const retryCount = 'retryCount' in result ? result.retryCount : 0
        recordDiagnosticEvent({
          level: result.state === 'conflict' ? 'warning' : 'info',
          category: 'sync',
          action: 'run',
          status: result.state === 'synced' ? 'success' : result.state === 'conflict' ? 'failed' : 'info',
          message: retryCount ? `${result.state} · 远端并发更新后自动重试 ${retryCount} 次` : result.state,
          durationMs: performance.now() - startedAt,
        })
        return result.state !== 'offline'
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          const message = error instanceof Error ? error.message : '同步失败'
          stateFinalizer.complete('error')
          setSyncError(message)
          recordDiagnosticEvent({ level: 'error', category: 'sync', action: 'run', status: 'failed', message, durationMs: performance.now() - startedAt })
        } else {
          recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'run', status: 'cancelled', durationMs: performance.now() - startedAt })
        }
        return false
      } finally {
        // Commit the terminal state at the actual end of the run. Keeping this
        // in finally prevents an aborted lifecycle request or an overlapping
        // reload from leaving the toolbar permanently stuck on `syncing` even
        // though the transport already completed (and logged success).
        stateFinalizer.finish()
        syncRunning.current = false
      }
      })()
      syncTask.current = operation
      void operation.finally(() => {
        if (syncTask.current === operation) syncTask.current = undefined
      })
      return operation
  }, [reload])

  // Sync once at startup and whenever the network comes back. No periodic
  // polling: durable outbox writes schedule their own quiet-period sync.
  useEffect(() => {
    const controller = new AbortController()
    const sync = () => { void syncNow({ signal: controller.signal }) }
    sync()
    window.addEventListener('online', sync)
    return () => { controller.abort(); window.removeEventListener('online', sync) }
  }, [syncNow])

  // Every durable outbox append gets one 30-second quiet-period sync. Draft
  // and scroll-local writes do not enter this path until explicitly flushed.
  useEffect(() => {
    const scheduler = createQuietSyncScheduler(() => { void syncNow() }, AUTO_SYNC_DEBOUNCE_MS)
    syncScheduler.current = scheduler
    return () => {
      scheduler.cancel()
      if (syncScheduler.current === scheduler) syncScheduler.current = undefined
    }
  }, [syncNow])

  const requestSyncSoon = useCallback(() => { syncScheduler.current?.request() }, [])

  useEffect(() => {
    const onOutboxAppend = () => { requestSyncSoon() }
    const event = repository.db.syncOutbox.hook('creating')
    event.subscribe(onOutboxAppend)
    return () => {
      event.unsubscribe(onOutboxAppend)
    }
  }, [requestSyncSoon])

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
    if (documentsRef.current[pageId]) return documentsRef.current[pageId]
    const inFlight = documentLoadPromises.get(pageId)
    if (inFlight) return inFlight
    const operation = (async () => {
      const document = await repository.getPageDocument(pageId)
      if (!document) {
        const empty = emptyEditorDocument()
        setDocuments((current) => ({ ...current, [pageId]: empty }))
        return empty
      }
      const assets = document.markdown !== undefined && isEmptyEditorCache(document.tiptapJson)
        ? await repository.listAssets(pageId)
        : []
      const tiptapJson = await editorDocumentFromStorage(document, assets)
      setDocuments((current) => current[pageId] === tiptapJson ? current : ({ ...current, [pageId]: tiptapJson }))
      return tiptapJson
    })()
    documentLoadPromises.set(pageId, operation)
    try {
      return await operation
    } finally {
      if (documentLoadPromises.get(pageId) === operation) documentLoadPromises.delete(pageId)
    }
  }, [])

  const saveDocument = useCallback(async (pageId: string, tiptapJson: Record<string, unknown>) => {
    loadedDocumentIds.current.add(pageId)
    const updatedAt = new Date().toISOString()
    const normalized = normalizeReferenceTargetIds(tiptapJson)
    const document: PageDocument = { pageId, schemaVersion: 3, markdown: documentToMarkdown(normalized), tiptapJson: normalized, updatedAt }
    await repository.stageDraft(document)
    await enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page) return
      await repository.savePage({ ...page, updatedAt, syncStatus: 'pending' }, document)
      await repository.replaceDerivedPageLinks(pageId, pageLinksFromMarkdown(pageId, document.markdown!, updatedAt))
      setReferenceIndexRevision((current) => current + 1)
      setDocuments((current) => ({ ...current, [pageId]: normalized }))
      if (Date.now() - lastDocumentSaveDiagnosticAt > 30_000) {
        lastDocumentSaveDiagnosticAt = Date.now()
        recordDiagnosticEvent({ level: 'info', category: 'page', action: 'autosave', status: 'success' })
      }
      if (!page.locked && !privateSectionIds.has(page.sectionId ?? '')) void indexPageForRetrieval(WORKSPACE_ID, pageId, page.title, extractDocumentText(normalized)).catch(() => undefined)
    })
  }, [privateSectionIds])

  const stageDocument = useCallback(async (pageId: string, tiptapJson: Record<string, unknown>) => {
    const updatedAt = new Date().toISOString()
    await repository.stageDraft({ pageId, schemaVersion: 3, markdown: documentToMarkdown(tiptapJson), tiptapJson, updatedAt })
  }, [])

  const loadBacklinks = useCallback((pageId: string) => repository.listBacklinks(pageId), [])
  const loadUnlinkedMentions = useCallback(async (pageId: string, signal?: AbortSignal) => {
    const target = pageRecords.find((page) => page.id === pageId)
    const title = target?.title.trim()
    if (!target || !title || title.length < 2) return []
    const normalizedTitle = title.toLocaleLowerCase()
    if (signal?.aborted) return []
    const candidateIds = new Set(pageRecords
      .filter((source) => source.id !== pageId && !source.deletedAt && !source.locked && !privateSectionIds.has(source.sectionId ?? ''))
      .map((source) => source.id))
    // Reuse the incremental workspace search cache to narrow the candidate
    // set. Exact verification below prevents fuzzy search results from being
    // reported as mentions while avoiding one IndexedDB read per page.
    const candidates = (await repository.searchWorkspaceCandidates(WORKSPACE_ID, title, Math.max(50, candidateIds.size)))
      .filter((source) => candidateIds.has(source.id))
    const mentions: { pageId: string; excerpt: string }[] = []
    for (let offset = 0; offset < candidates.length; offset += 8) {
      if (signal?.aborted) return []
      const batch = candidates.slice(offset, offset + 8)
      const candidateDocuments = await Promise.all(batch.map((source) => repository.getPageDocument(source.id)))
      batch.forEach((source, index) => {
        const document = candidateDocuments[index]
        if (!document) return
        const markdown = document.markdown ?? documentToMarkdown(document.tiptapJson)
        const withoutReferences = markdown.replace(/!?\[\[[^\]]+\]\]/g, '')
        const matchIndex = withoutReferences.toLocaleLowerCase().indexOf(normalizedTitle)
        if (matchIndex < 0) return
        mentions.push({
          pageId: source.id,
          excerpt: withoutReferences.slice(Math.max(0, matchIndex - 38), matchIndex + title.length + 70).replace(/\s+/g, ' ').trim(),
        })
      })
      if (offset + 8 < candidates.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    }
    return mentions
  }, [pageRecords, privateSectionIds])

  const createPage = useCallback(async (sectionId: string, kind: Page['kind'] = 'document', parentPageId?: string) => {
    const now = new Date().toISOString()
    const siblings = pageRecords.filter((item) => item.sectionId === sectionId && item.parentPageId === parentPageId && !item.deletedAt)
    const sortOrder = Math.max(0, ...siblings.map((item) => item.sortOrder ?? 0)) + 1000
    const page: Page = { id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, sectionId, parentPageId, sortOrder, treeUpdatedAt: now, kind, title: kind === 'task' ? '新任务' : '无标题页面', preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending', locked: privateSectionIds.has(sectionId) }
    const tiptapJson = emptyEditorDocument()
    const document: PageDocument = { pageId: page.id, schemaVersion: 3, markdown: '', tiptapJson, updatedAt: now }
    // Create the page and its canonical empty body together. Updating the local
    // React state directly avoids a full-library reload and ensures a new page
    // opens as an editor immediately rather than showing a loading placeholder.
    await repository.savePage(page, document)
    loadedDocumentIds.current.add(page.id)
    setPageRecords((current) => [page, ...current])
    setDocuments((current) => ({ ...current, [page.id]: tiptapJson }))
    recordDiagnosticEvent({ level: 'info', category: 'page', action: 'create', status: 'success', message: kind })
    return page.id
  }, [pageRecords, privateSectionIds])

  const createNotebook = useCallback(async (name: string) => {
    const now = new Date().toISOString()
    const notebook: Notebook = { id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, name, emoji: '📒', sortOrder: notebookRecords.length, createdAt: now, updatedAt: now }
    await repository.saveNotebook(notebook); await reload(); return notebook.id
  }, [notebookRecords.length, reload])

  const createSection = useCallback(async (notebookId: string, name: string) => {
    const now = new Date().toISOString()
    const section: Section = { id: crypto.randomUUID(), notebookId, name, color: '#7c3aed', sortOrder: sectionRecords.filter((item) => item.notebookId === notebookId).length, createdAt: now, updatedAt: now }
    const root: Page = {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      sectionId: section.id,
      sortOrder: section.sortOrder * 1000,
      treeUpdatedAt: now,
      kind: 'document',
      title: name,
      preview: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending',
      legacyMetadata: { notebookRootSectionId: section.id },
    }
    const tiptapJson = emptyEditorDocument()
    await repository.saveSection(section)
    await repository.savePage(root, { pageId: root.id, schemaVersion: 3, markdown: '', tiptapJson, updatedAt: now })
    loadedDocumentIds.current.add(root.id)
    setDocuments((current) => ({ ...current, [root.id]: tiptapJson }))
    await reload()
    return { sectionId: section.id, pageId: root.id }
  }, [reload, sectionRecords])

  const renameNotebook = useCallback(async (notebookId: string, name: string) => {
    const notebook = notebookRecords.find((item) => item.id === notebookId)
    if (!notebook) throw new Error('笔记本不存在')
    await repository.saveNotebook({ ...notebook, name, updatedAt: new Date().toISOString() })
    await reload()
  }, [notebookRecords, reload])

  const deleteNotebook = useCallback(async (notebookId: string) => {
    await repository.deleteNotebook(notebookId, new Date().toISOString(), legacyDeviceId())
    recordDiagnosticEvent({ level: 'warning', category: 'notebook', action: 'delete', status: 'success' })
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
    recordDiagnosticEvent({ level: 'warning', category: 'section', action: 'delete', status: 'success' })
    await reload()
  }, [reload])

  const duplicatePage = useCallback(async (pageId: string) => {
    const id = crypto.randomUUID()
    const copy = await repository.duplicatePage(pageId, id, new Date().toISOString())
    const legacyMetadata = withoutNotebookRootMarker(copy.legacyMetadata)
    if (legacyMetadata !== copy.legacyMetadata) await repository.savePage({ ...copy, legacyMetadata })
    await reload()
    return id
  }, [reload])

  const updatePage = useCallback(async (pageId: string, patch: Partial<Page>) => {
    await enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page) throw new Error(`Page not found: ${pageId}`)
      if (Object.prototype.hasOwnProperty.call(patch, 'icon') && patch.icon !== page.icon) {
        await repository.createManualRevision(pageId)
      }
      const updatedAt = new Date().toISOString()
      const saved = applyPendingPatch(page, patch, updatedAt)
      await repository.savePage(saved)
      // A top-level page owns a transparent legacy Section whose name follows
      // the title, so the rename touches two records.
      let renamedSection: Section | undefined
      const rootSectionId = notebookRootSectionId(page)
      if (rootSectionId && typeof patch.title === 'string') {
        const section = sectionRecordsRef.current.find((item) => item.id === rootSectionId)
        if (section) {
          renamedSection = { ...section, name: patch.title, updatedAt }
          await repository.saveSection(renamedSection)
        }
      }
      // Mirror just the touched records; reloading the entire library for a
      // favorite/icon/reminder toggle cost a full scan plus one read per page.
      setPageRecords((current) => replaceById(current, saved))
      if (renamedSection) setSectionRecords((current) => replaceById(current, renamedSection))
      setReferenceIndexRevision((current) => current + 1)
    })
  }, [])

  const movePageInTree = useCallback(async (pageId: string, sectionId: string, parentPageId: string | undefined, sortOrder: number) => {
    await enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page) throw new Error(`Page not found: ${pageId}`)
      if (parentPageId === pageId) throw new Error('页面不能成为自己的子页面')
      const livePages = pageRecords.filter((item) => !item.deletedAt)
      let cursor = parentPageId
      const seen = new Set<string>()
      while (cursor) {
        if (cursor === pageId) throw new Error('不能把父页面移动到自己的子页面下')
        if (seen.has(cursor)) throw new Error('检测到无效的页面循环')
        seen.add(cursor)
        cursor = livePages.find((item) => item.id === cursor)?.parentPageId
      }
      const now = new Date().toISOString()
      const rootSectionId = notebookRootSectionId(page)
      const targetLocked = lockedForSection(sectionId, sectionRecords, notebookRecords)
      await repository.savePage({
        ...page,
        sectionId,
        locked: targetLocked,
        parentPageId,
        sortOrder,
        treeUpdatedAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        legacyMetadata: rootSectionId ? withoutNotebookRootMarker(page.legacyMetadata) : page.legacyMetadata,
      })
      if (page.sectionId !== sectionId) {
        const subtreeIds = new Set(treePageIds(livePages, pageId).slice(1))
        // A top-level page owns a transparent legacy Section. When it becomes
        // a child, move every remaining record (including tasks) out before
        // deleting that now-empty compatibility bucket.
        if (rootSectionId) {
          for (const item of livePages) {
            if (item.sectionId === rootSectionId && item.id !== pageId) subtreeIds.add(item.id)
          }
        }
        for (const descendantId of subtreeIds) {
          const descendant = livePages.find((item) => item.id === descendantId)
          if (descendant) await repository.savePage({ ...descendant, sectionId, locked: targetLocked, treeUpdatedAt: now, updatedAt: now, syncStatus: 'pending' })
        }
        if (rootSectionId) await repository.deleteSection(rootSectionId, now, legacyDeviceId())
      }
      await reload()
    })
  }, [notebookRecords, pageRecords, reload, sectionRecords])

  const promotePageToNotebookRoot = useCallback(async (pageId: string, targetRootPageId?: string, position: 'before' | 'after' = 'after') => {
    return enqueuePageMutation(pageId, async () => {
      const page = await repository.getPage(pageId)
      if (!page || page.deletedAt) throw new Error('找不到要提升的页面')
      const sourceSection = sectionRecords.find((item) => item.id === page.sectionId)
      if (!sourceSection) throw new Error('页面不属于有效笔记本')
      const targetRoot = targetRootPageId ? pageRecords.find((item) => item.id === targetRootPageId) : undefined
      const targetSection = targetRoot ? sectionRecords.find((item) => item.id === targetRoot.sectionId) : undefined
      const notebookId = targetSection?.notebookId ?? sourceSection.notebookId
      const notebookSections = sectionRecords
        .filter((item) => item.notebookId === notebookId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
      const targetIndex = targetSection ? notebookSections.findIndex((item) => item.id === targetSection.id) : -1
      const insertionIndex = targetIndex < 0 ? notebookSections.length : targetIndex + (position === 'after' ? 1 : 0)
      const previousOrder = notebookSections[insertionIndex - 1]?.sortOrder
      const nextOrder = notebookSections[insertionIndex]?.sortOrder
      const sectionOrder = previousOrder !== undefined && nextOrder !== undefined ? (previousOrder + nextOrder) / 2
        : previousOrder !== undefined ? previousOrder + 1
          : nextOrder !== undefined ? nextOrder - 1
            : 0
      const now = new Date().toISOString()
      const targetLocked = notebookRecords.find((item) => item.id === notebookId)?.locked ? true : undefined
      const section: Section = {
        id: crypto.randomUUID(),
        notebookId,
        name: page.title,
        color: sourceSection.color,
        sortOrder: sectionOrder,
        createdAt: now,
        updatedAt: now,
      }
      await repository.saveSection(section)
      const descendants = treePageIds(pageRecords.filter((item) => !item.deletedAt), pageId).slice(1)
      await repository.savePage({
        ...page,
        sectionId: section.id,
        locked: targetLocked,
        parentPageId: undefined,
        treeUpdatedAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        legacyMetadata: {
          ...withoutNotebookRootMarker(page.legacyMetadata),
          notebookRootSectionId: section.id,
        },
      })
      for (const descendantId of descendants) {
        const descendant = pageRecords.find((item) => item.id === descendantId)
        if (descendant) await repository.savePage({ ...descendant, sectionId: section.id, locked: targetLocked, treeUpdatedAt: now, updatedAt: now, syncStatus: 'pending' })
      }
      await reload()
      return section.id
    })
  }, [notebookRecords, pageRecords, reload, sectionRecords])

  const reorderNotebookRoot = useCallback(async (pageId: string, targetRootPageId: string, position: 'before' | 'after') => {
    const page = await repository.getPage(pageId)
    const target = await repository.getPage(targetRootPageId)
    const sourceSectionId = page ? notebookRootSectionId(page) : undefined
    const targetSectionId = target ? notebookRootSectionId(target) : undefined
    if (!page || !target || !sourceSectionId || !targetSectionId || sourceSectionId === targetSectionId) return page?.sectionId
    const sourceSection = sectionRecords.find((item) => item.id === sourceSectionId)
    const targetSection = sectionRecords.find((item) => item.id === targetSectionId)
    if (!sourceSection || !targetSection) throw new Error('顶层页面位置无效')
    const siblings = sectionRecords
      .filter((item) => item.notebookId === targetSection.notebookId && item.id !== sourceSection.id)
      .sort((left, right) => left.sortOrder - right.sortOrder)
    const targetIndex = siblings.findIndex((item) => item.id === targetSection.id)
    const insertionIndex = Math.max(0, targetIndex + (position === 'after' ? 1 : 0))
    const previousOrder = siblings[insertionIndex - 1]?.sortOrder
    const nextOrder = siblings[insertionIndex]?.sortOrder
    const sortOrder = previousOrder !== undefined && nextOrder !== undefined ? (previousOrder + nextOrder) / 2
      : previousOrder !== undefined ? previousOrder + 1
        : nextOrder !== undefined ? nextOrder - 1
          : 0
    const now = new Date().toISOString()
    const targetLocked = notebookRecords.find((item) => item.id === targetSection.notebookId)?.locked ? true : undefined
    await repository.saveSection({ ...sourceSection, notebookId: targetSection.notebookId, sortOrder, updatedAt: now })
    const sectionPages = await repository.listPages({ workspaceId: WORKSPACE_ID, sectionId: sourceSection.id, includeDeleted: true, limit: 500 })
    for (const sectionPage of sectionPages.items) {
      await repository.savePage({
        ...sectionPage,
        locked: targetLocked,
        sortOrder: sectionPage.id === page.id ? sortOrder * 1000 : sectionPage.sortOrder,
        treeUpdatedAt: now,
        updatedAt: sectionPage.id === page.id ? now : sectionPage.updatedAt,
        syncStatus: 'pending',
      })
    }
    await reload()
    return sourceSection.id
  }, [notebookRecords, reload, sectionRecords])

  const loadTaskSteps = useCallback((pageId: string) => repository.listTaskSteps(pageId), [])
  const saveTaskSteps = useCallback((pageId: string, steps: import('@notebook/domain').TaskStep[]) => repository.saveTaskSteps(pageId, steps), [])

  const importFiles = useCallback(async (files: ImportFile[], sectionId: string) => {
    const textFiles = files.filter((file) => /\.(md|markdown|txt|html?)$/i.test(file.name))
    const firstOrder = Math.max(0, ...pageRecords.filter((page) => page.sectionId === sectionId && !page.parentPageId && !page.deletedAt).map((page) => page.sortOrder ?? 0)) + 1000
    for (const [index, file] of textFiles.entries()) {
      const now = new Date().toISOString()
      const id = crypto.randomUUID()
      const source = new TextDecoder().decode(file.data)
      const documentJson = /\.html?$/i.test(file.name) ? htmlToDocument(source) : markdownToDocument(source)
      const title = file.name.replace(/\.(md|markdown|txt|html?)$/i, '') || '导入页面'
      const page: Page = { id, workspaceId: WORKSPACE_ID, sectionId, sortOrder: firstOrder + index * 1000, treeUpdatedAt: now, kind: 'document', title, preview: extractDocumentText(documentJson).slice(0, 240), favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending' }
      await repository.savePage(page, { pageId: id, schemaVersion: 3, markdown: /\.html?$/i.test(file.name) ? documentToMarkdown(documentJson) : source, tiptapJson: documentJson, updatedAt: now })
    }
    const bundleFiles = files.filter((file) => !/\.(md|markdown|txt|html?)$/i.test(file.name))
    const decoded = bundleFiles.length ? await decodeImport(bundleFiles, WORKSPACE_ID) : undefined
    if (decoded) await repository.restoreCompleteBackup(decoded.bundle, decoded.assetContents)
    await reload()
    const imported = textFiles.length + (decoded?.bundle.pages.length ?? 0)
    recordDiagnosticEvent({ level: 'info', category: 'data', action: 'import', status: 'success', message: `${imported} 个页面` })
    return imported
  }, [pageRecords, reload])

  const exportWorkspace = useCallback(async () => {
    const startedAt = performance.now()
    const bundle = await repository.exportData(WORKSPACE_ID)
    const result = await encodeExport(bundle, await repository.exportAssetContents(new Set(bundle.pages.map((page) => page.id))))
    recordDiagnosticEvent({ level: 'info', category: 'data', action: 'export', status: 'success', message: `${bundle.pages.length} 个页面`, durationMs: performance.now() - startedAt })
    return result
  }, [])
  const loadAssets = useCallback((pageId: string) => repository.listAssets(pageId), [])
  const saveAsset = useCallback(async (pageId: string, file: File) => {
    const kind: Asset['kind'] = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'file'
    const asset: Asset = { id: crypto.randomUUID(), pageId, kind, filename: file.name, mimeType: file.type || 'application/octet-stream', byteSize: file.size, createdAt: new Date().toISOString() }
    await repository.saveAsset(asset, file)
    recordDiagnosticEvent({ level: 'info', category: 'asset', action: 'save', status: 'success', message: `${kind} · ${file.size} bytes` })
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
  const searchWorkspaceCandidates = useCallback(async (query: string, limit = 50) => {
    const results = await repository.searchWorkspaceCandidates(WORKSPACE_ID, query, limit)
    return results.filter((page) => !page.locked && !privateSectionIds.has(page.sectionId ?? '')).slice(0, limit)
  }, [privateSectionIds])
  const moveToTrash = useCallback(async (pageId: string) => {
    const ids = new Set(treePageIds(pageRecordsRef.current, pageId))
    const deletedAt = new Date().toISOString()
    for (const id of [...ids].reverse()) await repository.movePageToTrash(id, deletedAt, legacyDeviceId())
    recordDiagnosticEvent({ level: 'warning', category: 'page', action: 'trash', status: 'success', message: `${ids.size} 个页面` })
    // Read the moved records back so the mirror matches storage exactly.
    const trashed: Page[] = []
    for (const id of ids) {
      const page = await repository.getPage(id)
      if (page?.deletedAt) trashed.push(page)
    }
    setPageRecords((current) => withoutIds(current, ids))
    setTrashRecords((current) => withRecords(current, trashed))
    setReferenceIndexRevision((current) => current + 1)
  }, [])
  const restorePage = useCallback(async (pageId: string) => {
    const ids = new Set(treePageIds(trashRecordsRef.current, pageId))
    for (const id of ids) await repository.restorePage(id)
    recordDiagnosticEvent({ level: 'info', category: 'page', action: 'restore', status: 'success', message: `${ids.size} 个页面` })
    const restored: Page[] = []
    for (const id of ids) {
      const page = await repository.getPage(id)
      if (page && !page.deletedAt) restored.push(page)
    }
    setTrashRecords((current) => withoutIds(current, ids))
    setPageRecords((current) => withRecords(current, restored))
    setReferenceIndexRevision((current) => current + 1)
  }, [])
  const purgePage = useCallback(async (pageId: string) => {
    const page = trashRecordsRef.current.find((item) => item.id === pageId) ?? await repository.getPage(pageId)
    const rootSectionId = page ? notebookRootSectionId(page) : undefined
    if (rootSectionId) {
      await repository.deleteSection(rootSectionId, new Date().toISOString(), legacyDeviceId())
      // The section cascade purges every page that lives in it, trashed or not.
      setPageRecords((current) => current.filter((item) => item.sectionId !== rootSectionId))
      setSectionRecords((current) => current.filter((item) => item.id !== rootSectionId))
      setTrashRecords((current) => current.filter((item) => item.sectionId !== rootSectionId))
      recordDiagnosticEvent({ level: 'warning', category: 'page', action: 'purge', status: 'success' })
      setReferenceIndexRevision((current) => current + 1)
      return
    }
    const ids = new Set(treePageIds(trashRecordsRef.current, pageId))
    const deletedAt = new Date().toISOString()
    for (const id of [...ids].reverse()) await repository.purgePage(id, deletedAt, legacyDeviceId())
    recordDiagnosticEvent({ level: 'warning', category: 'page', action: 'purge', status: 'success', message: `${ids.size} 个页面` })
    setTrashRecords((current) => withoutIds(current, ids))
    setReferenceIndexRevision((current) => current + 1)
  }, [])
  const loadRevisions = useCallback((pageId: string) => repository.listRevisions(pageId), [])
  const createManualRevision = useCallback((pageId: string) => repository.createManualRevision(pageId), [])
  const resetRevisionHistory = useCallback(async () => {
    const result = await repository.resetRevisionHistory(WORKSPACE_ID)
    await reload()
    return result
  }, [reload])
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
  return { notebooks, pages, trashPages, documents, referenceIndexRevision, syncState, syncError, syncNow, reloadWorkspace: reload, loadDocument, saveDocument, stageDocument, loadBacklinks, loadUnlinkedMentions, createPage, createNotebook, createSection, renameNotebook, deleteNotebook, renameSection, deleteSection, duplicatePage, updatePage, movePageInTree, promotePageToNotebookRoot, reorderNotebookRoot, loadTaskSteps, saveTaskSteps, importFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, searchWorkspaceCandidates, moveToTrash, restorePage, purgePage, loadRevisions, createManualRevision, resetRevisionHistory, restoreRevision, loadReadingPosition, saveReadingPosition }
}

function treePageIds(records: Page[], rootId: string) {
  const result: string[] = []
  const queue = [rootId]
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...records.filter((page) => page.parentPageId === id).map((page) => page.id))
  }
  return result
}

function extractDocumentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractDocumentText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(extractDocumentText).filter(Boolean).join(' ')
}
