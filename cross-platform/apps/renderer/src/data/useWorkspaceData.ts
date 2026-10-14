import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Asset, Notebook, Page, PageDocument, Section } from '@notebook/domain'
import { indexPageForRetrieval } from '../ai/client'
import { decodeImport, encodeExport, type ImportFile } from './transfer'
import { documentToMarkdown, htmlToDocument, markdownToDocument } from '../editor/extensions'
import type { NotebookSummary } from '../model'
import { legacyDeviceId } from '../sync/legacySshSettings'
import { normalizeReferenceTargetIds, renameWikiLinks } from '@notebook/sync-contract'
import { decodeImportedText, importedTitle, plainTextToMarkdown, stripRepeatedTitle, TEXT_IMPORT_MAX_BYTES, textImportKind, type TextImportSkip } from './textImport'
import { pageLinksFromMarkdown } from './referenceIndex'
import { findTitleBacklinks, planWikiLinkRename, wikiTitleResolver } from './wikiLinkMaintenance'
import { showToast } from '../components/toast'
import { applyPendingPatch, replaceById, withRecords, withoutIds } from './pageState'
import { notebookRootSectionId, withoutNotebookRootMarker } from './notebookPageRoots'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'
import { treePageIds, WORKSPACE_ID, repository, db, documentLoadPromises, isEmptyEditorCache, REFERENCE_INDEX_VERSION_KEY, emptyEditorDocument, recordDocumentFailure, ensureNotebookPageRoots, ensurePagePrivacyMatchesNotebook, editorDocumentFromStorage, rebuildReferenceIndex, enqueuePageMutation } from './workspaceStore'
import { seedNotebooks, seedSections, seedPages, tagMap, toPageSummary, demoSeedAllowed } from './workspaceSeed'
import { useWorkspaceSync } from './useWorkspaceSync'
import { usePageTreeMoves } from './usePageTreeMoves'

export { WORKSPACE_ID, STARTUP_NOTEBOOK_ID, STARTUP_SECTION_ID, STARTUP_PAGE_ID, automationRepository } from './workspaceStore'

let lastDocumentSaveDiagnosticAt = 0

export function useWorkspaceData() {
  const [notebookRecords, setNotebookRecords] = useState<Notebook[]>(() => demoSeedAllowed() ? seedNotebooks : [])
  const [sectionRecords, setSectionRecords] = useState<Section[]>(() => demoSeedAllowed() ? seedSections : [])
  const [pageRecords, setPageRecords] = useState<Page[]>(() => demoSeedAllowed() ? seedPages : [])
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
      if (demoSeedAllowed() && (await repository.listNotebooks(WORKSPACE_ID)).length === 0 && await db.tombstones.count() === 0) {
        await db.transaction('rw', db.notebooks, db.sections, db.pages, async () => {
          await db.notebooks.bulkPut(seedNotebooks)
          await db.sections.bulkPut(seedSections)
          await db.pages.bulkPut(seedPages)
        })
      }
      if (!cancelled) await reload()
      if (!cancelled) recordDiagnosticEvent({ level: 'info', category: 'workspace', action: 'loaded', status: 'success' })
      if (!cancelled && globalThis.localStorage?.getItem(REFERENCE_INDEX_VERSION_KEY) !== '2') {
        await rebuildReferenceIndex()
        globalThis.localStorage?.setItem(REFERENCE_INDEX_VERSION_KEY, '2')
      }
    })()
    return () => { cancelled = true }
  }, [reload])

  const { syncState, syncError, syncProgress, syncNow, requestBoundarySync } = useWorkspaceSync(reload)


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
    const startedAt = Date.now()
    try {
      loadedDocumentIds.current.add(pageId)
      const updatedAt = new Date().toISOString()
      const normalized = normalizeReferenceTargetIds(tiptapJson)
      const document: PageDocument = { pageId, schemaVersion: 3, markdown: documentToMarkdown(normalized), tiptapJson: normalized, updatedAt }
      await repository.stageDraft(document)
      await enqueuePageMutation(pageId, async () => {
        const page = await repository.getPage(pageId)
        if (!page) return
        // Opening a note can normalize the editor structure without changing
        // its text. That is not an edit: keep the note's date and do not
        // queue an upload.
        const stored = await repository.getPageDocument(pageId)
        if (stored?.markdown !== undefined && stored.markdown === document.markdown) {
          const draft = await repository.db?.drafts.get(pageId)
          if (draft && draft.document.updatedAt === updatedAt) await repository.db?.drafts.delete(pageId)
          setDocuments((current) => current[pageId] === normalized ? current : ({ ...current, [pageId]: normalized }))
          return
        }
        await repository.savePage({ ...page, updatedAt, syncStatus: 'pending' }, document)
        await repository.replaceDerivedPageLinks(pageId, pageLinksFromMarkdown(pageId, document.markdown!, updatedAt, wikiTitleResolver(pageRecordsRef.current)))
        setReferenceIndexRevision((current) => current + 1)
        setDocuments((current) => ({ ...current, [pageId]: normalized }))
        if (Date.now() - lastDocumentSaveDiagnosticAt > 30_000) {
          lastDocumentSaveDiagnosticAt = Date.now()
          recordDiagnosticEvent({ level: 'info', category: 'page', action: 'autosave', status: 'success' })
        }
        if (!page.locked && !privateSectionIds.has(page.sectionId ?? '')) void indexPageForRetrieval(WORKSPACE_ID, pageId, page.title, extractDocumentText(normalized)).catch(() => undefined)
      })
    } catch (error) {
      recordDocumentFailure('autosave', error, startedAt)
      throw error
    }
  }, [privateSectionIds])

  const stageDocument = useCallback(async (pageId: string, tiptapJson: Record<string, unknown>) => {
    const startedAt = Date.now()
    try {
      const updatedAt = new Date().toISOString()
      await repository.stageDraft({ pageId, schemaVersion: 3, markdown: documentToMarkdown(tiptapJson), tiptapJson, updatedAt })
    } catch (error) {
      recordDocumentFailure('draft-stage', error, startedAt)
      throw error
    }
  }, [])

  const loadBacklinks = useCallback(async (pageId: string) => {
    const indexed = await repository.listBacklinks(pageId)
    const target = pageRecordsRef.current.find((page) => page.id === pageId)
    if (!target) return indexed
    // Title links to a page created after the linking note was saved are not
    // in the stored index yet; find them by title.
    const byTitle = await findTitleBacklinks(repository, target, pageRecordsRef.current, (page) => Boolean(page.locked) || privateSectionIds.has(page.sectionId ?? ''))
    const known = new Set(indexed.map((link) => link.id))
    return [...indexed, ...byTitle.filter((link) => !known.has(link.id))]
  }, [privateSectionIds])
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

  const createPage = useCallback(async (sectionId: string, kind: Page['kind'] = 'document', parentPageId?: string, title?: string) => {
    const now = new Date().toISOString()
    const siblings = pageRecords.filter((item) => item.sectionId === sectionId && item.parentPageId === parentPageId && !item.deletedAt)
    const sortOrder = Math.max(0, ...siblings.map((item) => item.sortOrder ?? 0)) + 1000
    const page: Page = { id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, sectionId, parentPageId, sortOrder, treeUpdatedAt: now, kind, title: title?.trim() || (kind === 'task' ? '新任务' : '无标题页面'), preview: '', favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending', locked: privateSectionIds.has(sectionId) }
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

  /** Keeps `[[old title]]` links pointing at a renamed page. */
  const updateTitleLinksAfterRename = useCallback(async (oldTitle: string, newTitle: string, pagesAfterRename: Page[]) => {
    const plan = await planWikiLinkRename(repository, oldTitle, newTitle, pagesAfterRename)
    let updatedPages = 0
    for (const item of plan) {
      await enqueuePageMutation(item.page.id, async () => {
        const current = await repository.getPage(item.page.id)
        const stored = await repository.getPageDocument(item.page.id)
        if (!current || stored?.markdown === undefined) return
        // Rewrite the stored body: it may have changed since the scan.
        const fresh = renameWikiLinks(stored.markdown, oldTitle, newTitle)
        if (!fresh.count) return
        const updatedAt = new Date().toISOString()
        const tiptapJson = normalizeReferenceTargetIds(markdownToDocument(fresh.markdown))
        await repository.savePage({ ...current, updatedAt, syncStatus: 'pending' }, { pageId: current.id, schemaVersion: 3, markdown: fresh.markdown, tiptapJson, updatedAt })
        await repository.replaceDerivedPageLinks(current.id, pageLinksFromMarkdown(current.id, fresh.markdown, updatedAt, wikiTitleResolver(pagesAfterRename)))
        setPageRecords((records) => records.map((page) => page.id === current.id ? { ...page, updatedAt, syncStatus: 'pending' } : page))
        if (loadedDocumentIds.current.has(current.id)) setDocuments((loaded) => ({ ...loaded, [current.id]: tiptapJson }))
        updatedPages += 1
      })
    }
    if (updatedPages) {
      setReferenceIndexRevision((current) => current + 1)
      showToast(`已更新 ${updatedPages} 篇笔记中指向“${newTitle}”的链接`)
    }
    return updatedPages
  }, [])

  const updatePage = useCallback(async (pageId: string, patch: Partial<Page>) => {
    const renamed = await enqueuePageMutation(pageId, async () => {
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
      return typeof patch.title === 'string' && page.title !== saved.title ? { from: page.title, to: saved.title, saved } : undefined
    })
    if (renamed) await updateTitleLinksAfterRename(renamed.from, renamed.to, replaceById(pageRecordsRef.current, renamed.saved))
  }, [updateTitleLinksAfterRename])

  const { movePageInTree, promotePageToNotebookRoot, reorderNotebookRoot } = usePageTreeMoves({ notebookRecords, sectionRecords, pageRecords, reload })


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

  /**
   * Imports loose Markdown / plain-text / HTML files as notes under a chosen
   * place in the tree (a notebook's top level, or inside a page). Files that
   * cannot be imported are reported instead of failing the whole batch.
   */
  const importTextFiles = useCallback(async (files: ImportFile[], target: { sectionId: string; parentPageId?: string }) => {
    const skipped: TextImportSkip[] = []
    const createdIds: string[] = []
    const siblings = pageRecordsRef.current.filter((page) => page.sectionId === target.sectionId && page.parentPageId === target.parentPageId && !page.deletedAt)
    let sortOrder = Math.max(0, ...siblings.map((page) => page.sortOrder ?? 0)) + 1000
    const locked = privateSectionIds.has(target.sectionId) || Boolean(target.parentPageId && pageRecordsRef.current.find((page) => page.id === target.parentPageId)?.locked)
    for (const file of files) {
      const kind = textImportKind(file.name)
      if (!kind) { skipped.push({ name: file.name, reason: '不支持的格式' }); continue }
      if (file.data.byteLength > TEXT_IMPORT_MAX_BYTES) { skipped.push({ name: file.name, reason: '超过 5 MB' }); continue }
      const source = decodeImportedText(file.data)
      if (!source.trim()) { skipped.push({ name: file.name, reason: '空文件' }); continue }
      try {
        const title = importedTitle(file.name, source, kind)
        const documentJson = kind === 'html' ? htmlToDocument(source) : markdownToDocument(kind === 'text' ? plainTextToMarkdown(source) : stripRepeatedTitle(source, title))
        const markdown = documentToMarkdown(documentJson)
        const now = new Date().toISOString()
        const id = crypto.randomUUID()
        const page: Page = { id, workspaceId: WORKSPACE_ID, sectionId: target.sectionId, parentPageId: target.parentPageId, sortOrder, treeUpdatedAt: now, kind: 'document', title, preview: extractDocumentText(documentJson).slice(0, 240), favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending', ...(locked ? { locked: true } : {}) }
        await repository.savePage(page, { pageId: id, schemaVersion: 3, markdown, tiptapJson: documentJson, updatedAt: now })
        await repository.replaceDerivedPageLinks(id, pageLinksFromMarkdown(id, markdown, now, wikiTitleResolver(pageRecordsRef.current)))
        createdIds.push(id)
        sortOrder += 1000
      } catch (error) {
        skipped.push({ name: file.name, reason: error instanceof Error ? error.message.slice(0, 60) : '无法解析' })
      }
    }
    if (createdIds.length) await reload()
    recordDiagnosticEvent({ level: skipped.length ? 'warning' : 'info', category: 'data', action: 'import', status: 'success', message: `${createdIds.length} 个页面，跳过 ${skipped.length} 个` })
    return { createdIds, skipped }
  }, [privateSectionIds, reload])

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
  return { notebooks, pages, trashPages, documents, referenceIndexRevision, syncState, syncError, syncProgress, syncNow, requestBoundarySync, reloadWorkspace: reload, loadDocument, saveDocument, stageDocument, loadBacklinks, loadUnlinkedMentions, createPage, createNotebook, createSection, renameNotebook, deleteNotebook, renameSection, deleteSection, duplicatePage, updatePage, movePageInTree, promotePageToNotebookRoot, reorderNotebookRoot, loadTaskSteps, saveTaskSteps, importFiles, importTextFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, searchWorkspaceCandidates, moveToTrash, restorePage, purgePage, loadRevisions, createManualRevision, resetRevisionHistory, restoreRevision, loadReadingPosition, saveReadingPosition }
}


function extractDocumentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractDocumentText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(extractDocumentText).filter(Boolean).join(' ')
}
