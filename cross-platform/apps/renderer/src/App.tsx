import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Button,
  Input,
} from '@fluentui/react-components'
import {
  ArrowLeft20Regular,
  ArrowReply20Regular,
  ArrowRight20Regular,
  ArrowSortDownLines20Regular,
  Bot20Regular,
  CheckmarkCircle20Regular,
  ChevronLeft20Regular,
  ChevronRight16Regular,
  Compose20Regular,
  Delete20Regular,
  Dismiss12Regular,
  Document20Regular,
  FullScreenMinimize20Regular,
  Link20Regular,
  LockClosed16Regular,
  LockOpen16Regular,
  MoreHorizontal20Regular,
  PanelLeft20Regular,
  Search16Regular,
  TextBulletListLtr20Regular,
  TextBulletListSquare20Regular,
} from '@fluentui/react-icons'
import type { PageSummary } from './model'
import { AIWorkspace, AttachmentPanel, BacklinksSidebar, CommandPalette, OutlineSidebar, ReferenceHelpDialog, ReferencePicker, SettingsCenter, TaskDetail, VersionHistory } from './app/lazyPanels'
import { layoutForWidth, readPreference, writePreference, type ShellLayout } from './shell/preferences'
import { useSyncCompletedFlash } from './hooks/useSyncCompletedFlash'
import { useReadingPositions } from './hooks/useReadingPositions'
import { useShellShortcuts } from './hooks/useShellShortcuts'
import { useNoteListBrowse } from './hooks/useNoteListBrowse'
import { useLifecycleSync } from './hooks/useLifecycleSync'
import { useDesktopMigrationAndUpdates } from './hooks/useDesktopMigrationAndUpdates'
import { FullTextSearch, OPEN_FULL_TEXT_SEARCH_EVENT, findInDocument, openFullTextSearch } from './search/FullTextSearch'
import { useWorkspaceData, WORKSPACE_ID, automationRepository, STARTUP_NOTEBOOK_ID, STARTUP_SECTION_ID, STARTUP_PAGE_ID } from './data/useWorkspaceData'
import type { ImportFile } from './data/transfer'
import { useReminders } from './tasks/useReminders'
import { documentToMarkdown, htmlToDocument, markdownToDocument } from './editor/extensions'
import { decryptBackup } from './crypto/encryptedBackup'
import type { AccentColor } from './appearance/accent'
import type { ThemePreference } from './appearance/theme'
import { configurePrivacyLock, hasPrivacyLock, verifyPrivacyLock } from './crypto/privacyLock'
import { migrateSshToWebdav, queueFullWebdavRepublish, resetWebdavReadPositions } from './sync/webdavSync'
import { lastSyncSuccess, relativeTime } from './sync/syncErrors'
import { ActionMenu, ActionMenuDivider } from './ActionMenu'
import { DocumentEditor } from './editor/DocumentEditor'
import { configureReferenceRuntime } from './editor/referenceRuntime'
import { OPEN_REFERENCE_PICKER_EVENT } from './editor/referenceCommands'
import { ancestorsOf, descendantCountsOf, descendantsOf, flattenPageTree } from './pageTree'
import { useAbcInputSourceForVimNormal } from './editor/vimInputSource'
import { referenceTargetElement } from './editor/referenceContent'
import type { NotebookReferenceTarget } from '@notebook/sync-contract'
import { findQuickCaptureTarget } from './workspaceNavigation'
import { emptyPageVisitHistory, pageVisitTarget, recordPageVisit } from './pageVisitHistory'
import { installRendererDiagnostics } from './diagnostics/diagnostics'
import { useAutomationBridge } from './automation/automationBridge'
import { BackupPasswordDialog } from './components/BackupPasswordDialog'
import { ConfirmDialogHost, requestConfirm } from './components/confirmDialog'
import { ToastHost, showToast } from './components/toast'
import { CreateItemDialog } from './components/CreateItemDialog'
import { EmptyParentPageHint } from './components/EmptyParentPageHint'
import { ModePlaceholder } from './components/ModePlaceholder'
import { ImportDialog, type ImportTarget } from './components/ImportDialog'
import { AssistantView } from './ai-assistant/AssistantView'
import { applyPlan, type PlanApi } from './ai/organizeApply'
import { emptyScope, type AssistantScope } from './ai/assistant'
import { MovePageDialog } from './components/MovePageDialog'
import { PageIconPicker } from './components/PageIconPicker'
import { PageTreeRow, type PageTreeDropTarget, type PageTreeRowActions } from './components/PageTreeRow'
import { PanelResizer } from './components/PanelResizer'
import { Sidebar, readScope, writeScope, type ListScope } from './shell/Sidebar'
import { VirtualNoteList, type ListDensity, type NoteMenuItem } from './shell/NoteList'
import { DueBanner } from './shell/DueBanner'
import { listOrderLabels, loadPinyin, pinyinReady, type ListOrder } from './shell/browse'
import './shell/shell.css'
import { PrivacyPasswordDialog } from './components/PrivacyPasswordDialog'
import { RenameItemDialog } from './components/RenameItemDialog'
import { syncLabels, useCommandPaletteItems } from './hooks/useCommandPaletteItems'
import { usePageNavigation } from './hooks/usePageNavigation'
import { usePageTreeActions } from './hooks/usePageTreeActions'
import { chooseImport, runEncryptedExport, runExport, runImport, saveCurrentDocument, type FileTransferContext } from './data/fileTransfer'
import {
  EXPANDED_PAGES_KEY,
  LAYOUT_KEY,
  RECENT_PAGES_KEY,
  VIM_MODE_KEY,
  readExpandedPageIds,
  readLayout,
  readRecentPageIds,
  readVimEnabled,
  type RightPanel,
} from './persistence/localLayout'


const emptyPage: PageSummary = { id: '', sectionId: '', title: '未选择页面', preview: '', updatedLabel: '', tags: [], kind: 'document' }
const emptyPageList: PageSummary[] = []


export interface AppProps {
  theme?: 'light' | 'dark'
  themePreference?: ThemePreference
  accentColor?: AccentColor
  onAccentColorChange?: (color: AccentColor) => void
  onThemePreferenceChange?: (preference: ThemePreference) => void
}

export function App({ theme = 'light', themePreference = 'system', accentColor = 'purple', onAccentColorChange, onThemePreferenceChange }: AppProps) {
  const { notebooks, pages, trashPages, documents, referenceIndexRevision, syncState, syncError, syncProgress, syncNow, requestBoundarySync, reloadWorkspace, loadDocument, saveDocument, stageDocument, loadBacklinks, loadUnlinkedMentions, createPage, createNotebook, createSection, renameNotebook, deleteNotebook, duplicatePage, updatePage, movePageInTree, promotePageToNotebookRoot, reorderNotebookRoot, loadTaskSteps, saveTaskSteps, importFiles, importTextFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, searchWorkspaceHits, searchWorkspaceCandidates, moveToTrash, restorePage, purgePage, loadRevisions, createManualRevision, resetRevisionHistory, restoreRevision, loadReadingPosition, saveReadingPosition, getPageUpdatedAt, setPageTagNames } = useWorkspaceData()
  const {
    proposals: automationProposals,
    createAutomationAgentProposal,
    createAutomationWriteback,
    applyAutomationProposal,
    rejectAutomationProposal,
  } = useAutomationBridge(reloadWorkspace)
  const importInput = useRef<HTMLInputElement>(null)
  const syncRepair = useMemo(() => ({
    status: async () => ({
      pending: await automationRepository.db.syncOutbox.where('workspaceId').equals(WORKSPACE_ID).count(),
      conflictCopies: pages.filter((page) => page.title.includes('（冲突副本')).length,
    }),
    resetReadPositions: () => resetWebdavReadPositions(automationRepository),
    republishAll: () => queueFullWebdavRepublish(automationRepository, WORKSPACE_ID),
  }), [pages])
  const documentPrefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [activeArea, setActiveArea] = useState('notes')
  const [activeNotebook, setActiveNotebook] = useState(STARTUP_NOTEBOOK_ID)
  const [expandedNotebook, setExpandedNotebook] = useState<string | undefined>(STARTUP_NOTEBOOK_ID)
  const [activeSection, setActiveSection] = useState(STARTUP_SECTION_ID)
  const [activePage, setActivePage] = useState(() => new URLSearchParams(location.hash.slice(1)).get('page') ?? STARTUP_PAGE_ID)
  const [pageHistory, setPageHistory] = useState(emptyPageVisitHistory)
  const activePageRef = useRef(activePage)
  activePageRef.current = activePage

  useEffect(() => installRendererDiagnostics(), [])
  const showSyncCompleted = useSyncCompletedFlash(syncState)
  const [recentPageIds, setRecentPageIds] = useState<string[]>(() => readRecentPageIds())
  const [vimEnabled, setVimEnabled] = useState(readVimEnabled)
  const [vimCommandMode, setVimCommandMode] = useState(readVimEnabled)
  const [aiOpen, setAiOpen] = useState(() => readLayout().aiOpen ?? (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1301px)').matches))
  const [rightPanel, setRightPanel] = useState<RightPanel>(() => {
    const saved = readLayout().rightPanel
    return saved === 'outline' || saved === 'backlinks' ? saved : 'outline'
  })
  const [aiWorkspaceOpen, setAiWorkspaceOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(() => readLayout().navOpen ?? true)
  const [pagesOpen, setPagesOpen] = useState(() => readLayout().pagesOpen ?? true)
  // 'tree': the user is navigating with the notebook tree, so the note list
  // (which would repeat the same pages) steps aside. 'list': All notes,
  // Pinned, To-dos, Trash, tags and search, where the list is the point.
  const [browse, setBrowse] = useState<'tree' | 'list'>(() => readLayout().browse ?? 'list')
  // AI assistant replaces the editor while open; `key` remounts it for a new scope.
  const [assistant, setAssistant] = useState<{ key: number; scope?: AssistantScope }>()
  const openAssistant = (scope?: AssistantScope) => { setAssistant({ key: Date.now(), scope }); setStackView('editor') }
  const [focusMode, setFocusMode] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(360, Math.max(200, readLayout().sidebarWidth ?? 248)))
  const [listWidth, setListWidth] = useState(() => Math.min(480, Math.max(260, readLayout().listWidth ?? 320)))
  const [aiWidth, setAiWidth] = useState(() => readLayout().aiWidth ?? 320)
  const [query, setQuery] = useState('')
  const [transferMessage, setTransferMessage] = useState<string>()
  const [restoreToken, setRestoreToken] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<'general' | 'data' | 'services'>('general')
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    // The trigger remains mounted while the lazily loaded dialog unmounts.
    // Restore focus from its owner, after React has removed the modal.
    requestAnimationFrame(() => settingsTriggerRef.current?.focus())
  }, [])
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  // Full-text search panel: undefined when closed, else its initial query.
  const [fullTextQuery, setFullTextQuery] = useState<string>()
  useEffect(() => {
    const open = (event: Event) => setFullTextQuery(String((event as CustomEvent<string>).detail ?? ''))
    window.addEventListener(OPEN_FULL_TEXT_SEARCH_EVENT, open)
    return () => window.removeEventListener(OPEN_FULL_TEXT_SEARCH_EVENT, open)
  }, [])
  const [dataRoot, setDataRoot] = useState<{ path: string; source: 'default' | 'environment' | 'command-line' | 'saved' }>()
  const [createRequest, setCreateRequest] = useState<'notebook' | 'rootPage'>()
  const [renameRequest, setRenameRequest] = useState<{ kind: 'notebook'; id: string; name: string }>()
  const [movePageRequest, setMovePageRequest] = useState<PageSummary>()
  const [iconPickerPage, setIconPickerPage] = useState<PageSummary>()
  const [encryptedExportOpen, setEncryptedExportOpen] = useState(false)
  const [encryptedImportRequest, setEncryptedImportRequest] = useState<{ file: ImportFile; rest: ImportFile[] }>()
  const [privacyUnlocked, setPrivacyUnlocked] = useState(false)
  const searchHits = useCallback((text: string) => searchWorkspaceHits(text, privacyUnlocked), [privacyUnlocked, searchWorkspaceHits])
  const [privacyConfigured, setPrivacyConfigured] = useState(() => hasPrivacyLock())
  const [privacyPrompt, setPrivacyPrompt] = useState<{ mode: 'setup' | 'unlock'; notebookId?: string }>()
  const [referencePickerOpen, setReferencePickerOpen] = useState(false)
  const [referenceHelpOpen, setReferenceHelpOpen] = useState(false)
  const [expandedPageIds, setExpandedPageIds] = useState<Set<string>>(readExpandedPageIds)
  const [pageDropTarget, setPageDropTarget] = useState<PageTreeDropTarget>()
  const [referenceNavigationTarget, setReferenceNavigationTarget] = useState<NotebookReferenceTarget>()
  // Three-pane browsing (sidebar → note list → editor), as on the phone.
  const [scope, setScope] = useState<ListScope>(readScope)
  const [searchAll, setSearchAll] = useState(false)
  const [notesOrder, setNotesOrder] = useState<ListOrder>(() => readPreference('notebook-notes-order', 'updated', ['updated', 'created', 'title'] as const))
  const [tasksOrder, setTasksOrder] = useState<ListOrder>(() => readPreference('notebook-tasks-order', 'due', ['due', 'updated', 'created', 'title'] as const))
  const [density, setDensity] = useState<ListDensity>(() => readPreference('notebook-list-density', 'cards', ['cards', 'compact'] as const))
  const [grouped, setGrouped] = useState(() => readPreference('notebook-list-grouped', 'on', ['on', 'off'] as const) === 'on')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [pinyinVersion, setPinyinVersion] = useState(0)
  const [layout, setLayout] = useState<ShellLayout>(() => layoutForWidth(window.innerWidth))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [stackView, setStackView] = useState<'list' | 'editor'>('list')
  const listSearchRef = useRef<HTMLInputElement>(null)
  const accessiblePages = useMemo(() => privacyUnlocked ? pages : pages.filter((page) => !page.locked), [pages, privacyUnlocked])
  const accessibleTrashPages = useMemo(() => privacyUnlocked ? trashPages : trashPages.filter((page) => !page.locked), [privacyUnlocked, trashPages])
  const publicAutomationProposals = useMemo(() => {
    const publicSectionIds = new Set(notebooks.filter((notebook) => !notebook.locked).flatMap((notebook) => notebook.sections.map((section) => section.id)))
    const publicPageIds = new Set(pages.filter((page) => !page.locked && publicSectionIds.has(page.sectionId)).map((page) => page.id))
    return automationProposals.filter((proposal) => proposal.changes.every((change) => (
        change.type === 'create-page'
          ? Boolean(change.after.sectionId && publicSectionIds.has(change.after.sectionId))
          : publicPageIds.has(change.after.pageId)
      )))
  }, [automationProposals, notebooks, pages])
  useReminders(accessiblePages, (pageId, patch) => updatePage(pageId, patch))

  useEffect(() => {
    useAbcInputSourceForVimNormal(vimEnabled, vimCommandMode)
  }, [vimCommandMode, vimEnabled])
  // Operation feedback used to be visible only inside the settings dialog;
  // surface it as a toast wherever it was produced.
  useEffect(() => {
    if (transferMessage) showToast(transferMessage)
  }, [transferMessage])
  // Safety net: async operations without an explicit catch still reach the user.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof DOMException && event.reason.name === 'AbortError') return
      const message = event.reason instanceof Error ? event.reason.message : typeof event.reason === 'string' && event.reason ? event.reason : undefined
      if (message) showToast(message, { kind: 'error' })
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  // Grouped once per library change so tree rows receive a stable array
  // identity (inline filters would break their memoization every render).
  const pagesBySection = useMemo(() => {
    const map = new Map<string, PageSummary[]>()
    for (const page of accessiblePages) {
      if (page.kind === 'task') continue
      const bucket = map.get(page.sectionId) ?? []
      bucket.push(page)
      map.set(page.sectionId, bucket)
    }
    return map
  }, [accessiblePages])
  const sectionPages = useMemo(() => pagesBySection.get(activeSection) ?? emptyPageList, [activeSection, pagesBySection])
  // Per-section descendant counts, merged into one map. Rows render the badge
  // from this instead of walking the subtree on every render.
  const pageDescendantCounts = useMemo(() => {
    const merged = new Map<string, number>()
    for (const sectionPagesList of pagesBySection.values()) {
      for (const [pageId, count] of descendantCountsOf(sectionPagesList)) merged.set(pageId, count)
    }
    return merged
  }, [pagesBySection])

  const currentPage = useMemo(() => [...accessiblePages, ...accessibleTrashPages].find((page) => page.id === activePage) ?? accessiblePages[0] ?? accessibleTrashPages[0] ?? emptyPage, [activePage, accessiblePages, accessibleTrashPages])
  const hasCurrentPage = Boolean(currentPage.id)
  const currentDocument = documents[currentPage.id]
  const currentNotebook = notebooks.find((notebook) => notebook.id === activeNotebook) ?? notebooks[0]
  const currentSection = notebooks.flatMap((notebook) => notebook.sections).find((section) => section.id === activeSection)
  const hasActivePage = hasCurrentPage && (activeArea === 'notes'
    ? accessiblePages.some((page) => page.id === currentPage.id && page.kind !== 'task' && page.sectionId === activeSection)
    : activeArea === 'tasks'
      ? accessiblePages.some((page) => page.id === currentPage.id && page.kind === 'task')
      : accessibleTrashPages.some((page) => page.id === currentPage.id))
  const navigationOpen = navOpen || pagesOpen
  const currentPageAncestors = useMemo(() => ancestorsOf(sectionPages, currentPage.id).flatMap((id) => sectionPages.find((page) => page.id === id) ?? []), [currentPage.id, sectionPages])
  const currentPageChildren = useMemo(() => accessiblePages
    .filter((page) => page.kind !== 'task' && page.parentPageId === currentPage.id)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0)), [accessiblePages, currentPage.id])
  const currentDocumentIsEmpty = useMemo(() => currentDocument ? documentToMarkdown(currentDocument).trim().length === 0 : false, [currentDocument])
  const accessibleDocumentPageIds = useMemo(() => new Set(accessiblePages.filter((page) => page.kind !== 'task').map((page) => page.id)), [accessiblePages])
  const previousPageVisit = pageVisitTarget(pageHistory, -1, (pageId) => accessibleDocumentPageIds.has(pageId)).pageId
  const nextPageVisit = pageVisitTarget(pageHistory, 1, (pageId) => accessibleDocumentPageIds.has(pageId)).pageId

  useEffect(() => {
    if (!activePage) return
    const ancestors = ancestorsOf(sectionPages, activePage)
    if (!ancestors.length || ancestors.every((id) => expandedPageIds.has(id))) return
    setExpandedPageIds((current) => new Set([...current, ...ancestors]))
  }, [activePage, expandedPageIds, sectionPages])
  useEffect(() => {
    globalThis.localStorage?.setItem(EXPANDED_PAGES_KEY, JSON.stringify([...expandedPageIds]))
  }, [expandedPageIds])

  // Switching away from a note is the natural moment to upload its edits;
  // the sync policy keeps automatic uploads at least a minute apart.
  const previousOpenPage = useRef(currentPage.id)
  useEffect(() => {
    if (previousOpenPage.current === currentPage.id) return
    previousOpenPage.current = currentPage.id
    requestBoundarySync()
  }, [currentPage.id, requestBoundarySync])
  // Opening a note is deliberately local: fetching/pushing on every page
  // switch causes substantial WebDAV traffic for normal navigation.
  useEffect(() => {
    if (!hasCurrentPage) return
    void loadDocument(currentPage.id)
  }, [currentPage.id, hasCurrentPage, loadDocument])
  useEffect(() => () => clearTimeout(documentPrefetchTimer.current), [])
  const { loadedReadingPosition, flushDirtyReadingPositions, recordViewportPosition } = useReadingPositions({ activeArea, pageId: currentPage.id, hasCurrentPage, loadReadingPosition, saveReadingPosition })

  useLifecycleSync(syncNow, flushDirtyReadingPositions)
  useEffect(() => {
    if (activeArea !== 'notes' || !hasCurrentPage || currentPage.kind === 'task') return
    setRecentPageIds((current) => {
      if (current.includes(currentPage.id)) return current
      const next = [...current, currentPage.id].slice(-12)
      globalThis.localStorage?.setItem(RECENT_PAGES_KEY, JSON.stringify(next))
      return next
    })
  }, [activeArea, currentPage.id, currentPage.kind, hasCurrentPage])
  useEffect(() => {
    const target = referenceNavigationTarget
    if (!target || target.pageId !== currentPage.id || target.kind === 'page' || !documents[target.pageId]) return
    let frame = 0
    let attempts = 0
    const locate = () => {
      const element = referenceTargetElement(document, target)
      if (!element && attempts++ < 30) {
        frame = requestAnimationFrame(locate)
        return
      }
      if (!element) {
        setTransferMessage('引用的段落或连续内容已经不存在')
        setReferenceNavigationTarget(undefined)
        return
      }
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      element.classList.add('reference-target-highlight')
      window.setTimeout(() => element.classList.remove('reference-target-highlight'), 1_800)
      setReferenceNavigationTarget(undefined)
    }
    frame = requestAnimationFrame(locate)
    return () => cancelAnimationFrame(frame)
  }, [currentPage.id, documents, referenceNavigationTarget])
  useEffect(() => {
    if (settingsOpen && window.notebookDesktop) void window.notebookDesktop.storage.getInfo().then(setDataRoot)
  }, [settingsOpen])
  useEffect(() => {
    const followHash = () => { const pageId = new URLSearchParams(location.hash.slice(1)).get('page'); if (pageId) setActivePage(pageId) }
    window.addEventListener('hashchange', followHash)
    return () => window.removeEventListener('hashchange', followHash)
  }, [])
  useEffect(() => {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify({ navOpen, pagesOpen, aiOpen, rightPanel, sidebarWidth, listWidth, aiWidth, browse }))
  }, [aiOpen, aiWidth, browse, listWidth, navOpen, pagesOpen, rightPanel, sidebarWidth])
  useEffect(() => {
    globalThis.localStorage?.setItem(VIM_MODE_KEY, vimEnabled ? 'true' : 'false')
  }, [vimEnabled])
  useEffect(() => {
    const open = () => { if (hasActivePage && activeArea === 'notes') setReferencePickerOpen(true) }
    window.addEventListener(OPEN_REFERENCE_PICKER_EVENT, open)
    return () => window.removeEventListener(OPEN_REFERENCE_PICKER_EVENT, open)
  }, [activeArea, hasActivePage])

  // The inspector (outline / references) starts closed on smaller windows.
  useEffect(() => {
    const panelQuery = window.matchMedia('(max-width: 1300px)')
    const adaptLayout = () => { if (panelQuery.matches) setAiOpen(false) }
    adaptLayout()
    panelQuery.addEventListener('change', adaptLayout)
    return () => panelQuery.removeEventListener('change', adaptLayout)
  }, [])
  const showRightPanel = (open: boolean) => setAiOpen(open)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const editingWithVim = Boolean(target?.closest('.document-editor-content'))
      const paletteShortcut = event.key.toLocaleLowerCase() === 'p' && (event.metaKey || (event.ctrlKey && (event.shiftKey || !editingWithVim)))
      if (paletteShortcut) {
        event.preventDefault()
        setCommandPaletteOpen((value) => !value)
        return
      }
      if (event.key === 'Escape' && focusMode) setFocusMode(false)
      if (event.key === 'F11') {
        event.preventDefault()
        setFocusMode((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusMode])

  useEffect(() => window.notebookDesktop?.events.onQuickCapture(() => {
    const target = findQuickCaptureTarget(notebooks)
    if (!target) {
      setTransferMessage('请先创建一个可用的笔记本和分区')
      return
    }
    setActiveArea('notes')
    setActiveNotebook(target.notebookId)
    setActiveSection(target.sectionId)
    void createPage(target.sectionId).then(setActivePage)
  }), [createPage, notebooks])
  useEffect(() => window.notebookDesktop?.events.onCommandPalette(() => setCommandPaletteOpen(true)), [])
  useDesktopMigrationAndUpdates(syncNow, () => { setSettingsPage('general'); setSettingsOpen(true) })

  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const scheduleDocumentPrefetch = useCallback((pageId: string, delay = 160) => {
    clearTimeout(documentPrefetchTimer.current)
    if (documentsRef.current[pageId]) return
    documentPrefetchTimer.current = setTimeout(() => { void loadDocument(pageId) }, delay)
  }, [loadDocument])
  const stopDocumentPrefetch = useCallback(() => clearTimeout(documentPrefetchTimer.current), [])
  const clearDropTarget = useCallback(() => setPageDropTarget(undefined), [])

  const navigation = usePageNavigation({
    accessiblePages,
    accessibleTrashPages,
    accessibleDocumentPageIds,
    activeArea,
    activeSection,
    navigationOpen,
    pageHistory,
    notebooks,
    setActiveArea,
    setActivePage,
    setActiveSection,
    setActiveNotebook,
    setExpandedNotebook,
    setNavOpen,
    setPagesOpen,
    setQuery,
    setPageHistory,
    setExpandedPageIds,
    onPageActivated: () => {
      if (layout !== 'wide') setDrawerOpen(false)
      if (layout === 'narrow') setStackView('editor')
    },
  })
  const { toggleNavigation, openRecentPage, navigatePageHistory, activateTreePage, historyNavigationTarget } = navigation
  useEffect(() => {
    if (activeArea !== 'notes' || !hasCurrentPage || currentPage.kind === 'task') return
    if (historyNavigationTarget.current === currentPage.id) {
      historyNavigationTarget.current = undefined
      return
    }
    setPageHistory((history) => recordPageVisit(history, currentPage.id))
  }, [activeArea, currentPage.id, currentPage.kind, hasCurrentPage, historyNavigationTarget])

  const treeActions = usePageTreeActions({
    accessiblePages,
    notebooks,
    currentSection,
    currentNotebook,
    expandedPageIds,
    activePage,
    pageDropTarget,
    createPage,
    createSection,
    movePageInTree,
    promotePageToNotebookRoot,
    reorderNotebookRoot,
    setActivePage,
    setActiveSection,
    setActiveNotebook,
    setExpandedNotebook,
    setExpandedPageIds,
    setPageDropTarget,
    onMoveError: (message) => showToast(message, { kind: 'error' }),
  })
  const { togglePageExpanded, createTreePage, createTopLevelPage, setDropPosition, movePageRelative, dropPage } = treeActions

  const trashPage = async (pageId: string, alwaysConfirm = false): Promise<boolean> => {
    const page = accessiblePages.find((candidate) => candidate.id === pageId)
    if (!page) return false
    const backlinks = await loadBacklinks(pageId)
    const referencedBy = new Set(backlinks.map((link) => link.sourcePageId)).size
    const descendantCount = descendantsOf(accessiblePages, pageId).size
    const description = referencedBy > 0
      ? `“${page.title}”被 ${referencedBy} 篇页面引用${descendantCount ? `，并包含 ${descendantCount} 篇子页面` : ''}。移到回收站后，这些位置会显示为失效引用，但恢复页面即可重新生效。仍要继续吗？`
      : descendantCount ? `将“${page.title}”及其 ${descendantCount} 篇子页面一起移到回收站？` : `将“${page.title}”移到回收站？`
    if ((alwaysConfirm || referencedBy > 0) && !(await requestConfirm({ title: '移到回收站', description, confirmLabel: '移到回收站', destructive: true }))) return false
    await moveToTrash(pageId)
    if (pageId === currentPage.id) setActivePage(accessiblePages.find((candidate) => candidate.id !== pageId)?.id ?? '')
    return true
  }

  // Row menus capture the current library, but PageTreeRow needs a stable
  // actions object to stay memoized: forward every call through a latest-ref.
  const latestRowHandlersRef = useRef<PageTreeRowActions | undefined>(undefined)
  latestRowHandlersRef.current = {
    createChildPage: (page) => { void createTreePage(page.id) },
    createSiblingPage: (page) => {
      if (page.notebookRoot) {
        setActiveNotebook(notebooks.find((owner) => owner.sections.some((ownerSection) => ownerSection.id === page.sectionId))?.id ?? activeNotebook)
        setCreateRequest('rootPage')
        return
      }
      void createTreePage(page.parentPageId)
    },
    changeIcon: (page) => setIconPickerPage(page),
    updatePageProps: (page, patch) => { void updatePage(page.id, patch) },
    duplicatePage: (page) => { void duplicatePage(page.id).then((id) => { setActivePage(id); setActiveSection(page.sectionId) }) },
    promoteToRoot: (page, variant) => {
      if (variant === 'pages') {
        const roots = sectionPages.filter((item) => !item.parentPageId && item.id !== page.id)
        void movePageInTree(page.id, page.sectionId, undefined, Math.max(0, ...roots.map((item) => item.sortOrder ?? 0)) + 1000)
        return
      }
      void promotePageToNotebookRoot(page.id).then((sectionId) => { setActivePage(page.id); setActiveSection(sectionId) })
    },
    requestMove: (page) => setMovePageRequest(page),
    trashPage: (page) => { void trashPage(page.id, true) },
    importInto: (page) => { pendingImportTarget.current = { sectionId: page.sectionId, parentPageId: page.id }; chooseImport(transferContextRef.current!) },
  }
  const pendingImportTarget = useRef<ImportTarget | undefined>(undefined)
  const [textImport, setTextImport] = useState<{ files: ImportFile[]; target?: ImportTarget }>()
  const rowActionsRef = useRef<PageTreeRowActions | undefined>(undefined)
  if (!rowActionsRef.current) {
    rowActionsRef.current = {
      createChildPage: (page) => latestRowHandlersRef.current?.createChildPage(page),
      createSiblingPage: (page) => latestRowHandlersRef.current?.createSiblingPage(page),
      changeIcon: (page) => latestRowHandlersRef.current?.changeIcon(page),
      updatePageProps: (page, patch) => latestRowHandlersRef.current?.updatePageProps(page, patch),
      duplicatePage: (page) => latestRowHandlersRef.current?.duplicatePage(page),
      promoteToRoot: (page, variant) => latestRowHandlersRef.current?.promoteToRoot(page, variant),
      requestMove: (page) => latestRowHandlersRef.current?.requestMove(page),
      trashPage: (page) => latestRowHandlersRef.current?.trashPage(page),
      importInto: (page) => latestRowHandlersRef.current?.importInto?.(page),
    }
  }
  const rowActions = rowActionsRef.current

  const createPageFromMarkdown = async (title: string, markdown: string) => {
    if (!currentSection) return
    const pageId = await createPage(currentSection.id)
    await updatePage(pageId, { title, preview: markdown.replace(/[#>*_`\-[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180) })
    await saveDocument(pageId, markdownToDocument(markdown))
    setActiveArea('notes')
    setActivePage(pageId)
  }

  const createNoteFromAssistant = async (title: string, markdown: string, target?: { sectionId: string; parentPageId?: string }) => {
    const sectionId = target?.sectionId ?? currentSection?.id ?? notebooks.find((notebook) => !notebook.locked)?.sections[0]?.id
    if (!sectionId) throw new Error('还没有笔记本')
    const pageId = await createPage(sectionId, 'document', target?.parentPageId)
    if (target?.parentPageId) setExpandedPageIds((current) => current.has(target.parentPageId!) ? current : new Set([...current, target.parentPageId!]))
    await updatePage(pageId, { title, preview: markdown.replace(/[#>*_`\-[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180) })
    await saveDocument(pageId, markdownToDocument(markdown))
    return pageId
  }

  // Applying an AI plan chains many mutations; always call the latest
  // workspace functions (each step reloads the records the next one reads).
  const planOps = useRef({ createPage, updatePage, saveDocument, movePageInTree, moveToTrash, createManualRevision, getPageUpdatedAt, setPageTagNames })
  planOps.current = { createPage, updatePage, saveDocument, movePageInTree, moveToTrash, createManualRevision, getPageUpdatedAt, setPageTagNames }
  const planApi = useMemo<PlanApi>(() => {
    const preview = (markdown: string) => markdown.replace(/[#>*_`\-[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
    return {
      pageUpdatedAt: (pageId) => planOps.current.getPageUpdatedAt(pageId),
      async createPage(title, markdown, sectionId, parentPageId) {
        const pageId = await planOps.current.createPage(sectionId, 'document', parentPageId)
        await planOps.current.updatePage(pageId, { title, preview: preview(markdown) })
        await planOps.current.saveDocument(pageId, markdownToDocument(markdown))
        return pageId
      },
      async updatePage(pageId, change) {
        await planOps.current.updatePage(pageId, { ...(change.title !== undefined ? { title: change.title } : {}), ...(change.markdown !== undefined ? { preview: preview(change.markdown) } : {}) })
        if (change.markdown !== undefined) await planOps.current.saveDocument(pageId, markdownToDocument(change.markdown))
      },
      movePage: (pageId, sectionId, parentPageId, sortOrder) => planOps.current.movePageInTree(pageId, sectionId, parentPageId, sortOrder),
      setTags: (pageId, tags) => planOps.current.setPageTagNames(pageId, tags),
      trash: (pageId) => planOps.current.moveToTrash(pageId),
      snapshot: async (pageId) => { await planOps.current.createManualRevision(pageId) },
    }
  }, [])

  const openDailyNote = async () => {
    const now = new Date()
    const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('/', '-')
    const title = `${date} 日记`
    const existing = accessiblePages.find((page) => page.kind !== 'task' && page.title === title)
    if (existing) { openRecentPage(existing.id); return }
    await createPageFromMarkdown(title, `## 今日重点\n\n- [ ] \n\n## 随手记录\n\n\n## 今日回顾\n\n`)
  }

  const clipFromClipboard = async () => {
    if (!currentSection) return
    try {
      let html = ''
      let text = ''
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text()
          if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text()
        }
      } else {
        text = await navigator.clipboard.readText()
      }
      if (!html && !text.trim()) throw new Error('剪贴板中没有可剪藏的文字或网页内容')
      const parsed = html ? new DOMParser().parseFromString(html, 'text/html') : undefined
      const title = parsed?.querySelector('h1')?.textContent?.trim() || parsed?.title.trim() || text.trim().split(/\r?\n/)[0]?.slice(0, 80) || '网页剪藏'
      const pageId = await createPage(currentSection.id)
      const documentJson = html ? htmlToDocument(html) : markdownToDocument(text)
      await updatePage(pageId, { title, preview: (parsed?.body.textContent ?? text).replace(/\s+/g, ' ').trim().slice(0, 180) })
      await saveDocument(pageId, documentJson)
      setActiveArea('notes')
      setActivePage(pageId)
      setTransferMessage('已从剪贴板剪藏为 Markdown；网页字体、颜色和布局已移除')
    } catch (error) {
      setTransferMessage(error instanceof Error ? error.message : '无法读取剪贴板')
    }
  }

  const transferContext = useMemo<FileTransferContext>(() => ({
    activeSectionId: activeSection,
    currentPageTitle: currentPage.title,
    currentPageDocument: documents[currentPage.id],
    importFiles,
    exportWorkspace,
    onMessage: setTransferMessage,
    onEncryptedImportRequest: setEncryptedImportRequest,
    onTextImportRequest: (files) => {
      const target = pendingImportTarget.current ?? (hasActivePage && activeArea === 'notes' ? { sectionId: currentPage.sectionId, parentPageId: currentPage.parentPageId } : activeSection ? { sectionId: activeSection } : undefined)
      pendingImportTarget.current = undefined
      setTextImport({ files, target })
    },
    browserFileInput: importInput,
  }), [activeArea, activeSection, currentPage.id, currentPage.parentPageId, currentPage.sectionId, currentPage.title, documents, exportWorkspace, hasActivePage, importFiles, importInput])
  const transferContextRef = useRef<FileTransferContext | undefined>(undefined)
  transferContextRef.current = transferContext

  const palette = useCommandPaletteItems({
    syncState,
    currentSection,
    activeArea,
    currentNotebook,
    hasActivePage,
    focusMode,
    vimEnabled,
    privacyUnlocked,
    navigationOpen,
    recentPageIds,
    accessiblePages,
    accessibleTrashPages,
    notebooks,
    currentPage,
    createPage,
    openDailyNote,
    createPageFromMarkdown,
    clipFromClipboard,
    selectArea: (area) => chooseScope(area === 'notes' ? { kind: 'all' } : { kind: area }),
    openRecentPage,
    toggleNavigation,
    syncNow,
    chooseImport: () => chooseImport(transferContext),
    runExport: () => runExport(transferContext),
    trashPage,
    restorePage,
    purgePage,
    deleteNotebook,
    searchWorkspace,
    setCreateRequest,
    setReferenceHelpOpen,
    setVimEnabled,
    setAiWorkspaceOpen,
    setFocusMode,
    setSettingsPage,
    setSettingsOpen,
    setActiveArea,
    setActivePage,
    setPagesOpen,
  })
  const { paletteItems, searchPalettePageIds } = palette

  useEffect(() => {
    configureReferenceRuntime({
      pages,
      accessiblePageIds: new Set(accessiblePages.map((page) => page.id)),
      documents,
      loadDocument,
      openPage: (target) => {
        const page = accessiblePages.find((candidate) => candidate.id === target.pageId)
        if (!page) return
        const notebook = notebooks.find((candidate) => candidate.sections.some((section) => section.id === page.sectionId))
        setActiveArea('notes')
        setActivePage(page.id)
        setReferenceNavigationTarget(target)
        setActiveSection(page.sectionId)
        if (notebook) { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id) }
      },
      createPageForTitle: async (title) => {
        // A link to a note that does not exist yet: create it next to the
        // note that links to it and open it.
        const source = accessiblePages.find((candidate) => candidate.id === activePageRef.current)
        const sectionId = source?.kind !== 'task' && source?.sectionId ? source.sectionId : findQuickCaptureTarget(notebooks)?.sectionId
        if (!sectionId) { showToast('请先创建一个笔记本', { kind: 'error' }); return }
        try {
          const pageId = await createPage(sectionId, 'document', undefined, title)
          const notebook = notebooks.find((candidate) => candidate.sections.some((section) => section.id === sectionId))
          setActiveArea('notes')
          setActiveSection(sectionId)
          setActivePage(pageId)
          if (notebook) { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id) }
          showToast(`已创建笔记“${title}”`)
        } catch (error) {
          showToast(error instanceof Error ? error.message : '无法创建笔记', { kind: 'error' })
        }
      },
    })
  }, [accessiblePages, createPage, documents, loadDocument, notebooks, pages])

  const activateNotebook = (notebookId: string) => {
    const notebook = notebooks.find((candidate) => candidate.id === notebookId)
    if (!notebook) return
    setActiveArea('notes')
    setExpandedNotebook(notebook.id)
    setActiveNotebook(notebook.id)
    const firstSection = notebook.sections[0]
    if (!firstSection) return
    setActiveSection(firstSection.id)
    const firstPage = pages.find((page) => page.kind !== 'task' && page.sectionId === firstSection.id)
    if (firstPage) setActivePage(firstPage.id)
  }

  useEffect(() => {
    if (notebooks.some((notebook) => notebook.id === activeNotebook) || !notebooks[0]) return
    const notebook = notebooks[0]
    setActiveNotebook(notebook.id)
    setExpandedNotebook(notebook.id)
    const firstSection = notebook.sections[0]
    if (!firstSection) return
    setActiveSection(firstSection.id)
    const page = pages.find((candidate) => candidate.kind !== 'task' && candidate.sectionId === firstSection.id)
    setActivePage(page?.id ?? '')
  }, [activeNotebook, notebooks, pages])

  const requestPrivacyAccess = (notebookId?: string) => {
    if (privacyUnlocked) { if (notebookId) activateNotebook(notebookId); return }
    setPrivacyPrompt({ mode: privacyConfigured ? 'unlock' : 'setup', notebookId })
  }

  const lockPrivacy = () => {
    setPrivacyUnlocked(false)
    const privateNotebook = notebooks.find((notebook) => notebook.id === activeNotebook && notebook.locked)
    if (!privateNotebook) return
    const fallbackNotebook = notebooks.find((notebook) => !notebook.locked)
    if (fallbackNotebook) activateNotebook(fallbackNotebook.id)
  }

  // ---------------------------------------------------------------------------
  // Note list: scope → search or sections → rows.

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    const onResize = () => setLayout(layoutForWidth(window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => { window.clearInterval(timer); window.removeEventListener('resize', onResize) }
  }, [])
  useEffect(() => { if (layout === 'wide') setDrawerOpen(false) }, [layout])
  useEffect(() => {
    if (!query.trim() || pinyinReady()) return
    let cancelled = false
    void loadPinyin().then(() => { if (!cancelled) setPinyinVersion((value) => value + 1) })
    return () => { cancelled = true }
  }, [query])

  const { notebookBySection, notebookName, documentPages, taskPages, scopeNotebook, listScope, searching, listOrder, listSections, listPages, listTerms, listTimeOf, tags, digest, banner, bannerItems, scopeTitle, openTodoCount, favoriteCount, notebookCounts, scopeSubtitle } = useNoteListBrowse({ notebooks, accessiblePages, accessibleTrashPages, scope, privacyUnlocked, query, searchAll, notesOrder, tasksOrder, grouped, nowMs, pinyinVersion })

  const focusEditor = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.document-editor-content')?.focus({ preventScroll: true })
  }))

  const chooseScope = (next: ListScope) => {
    setScope(next)
    writeScope(next)
    setQuery('')
    setSearchAll(false)
    setAssistant(undefined)
    setBrowse(next.kind === 'notebook' ? 'tree' : 'list')
    if (next.kind === 'notebook') {
      setActiveNotebook(next.id)
      setExpandedNotebook(next.id)
    }
    const area = next.kind === 'tasks' ? 'tasks' : next.kind === 'trash' ? 'trash' : 'notes'
    setActiveArea(area)
    if (layout !== 'wide') setDrawerOpen(false)
    if (layout === 'narrow') setStackView('list')
  }

  // Keep the open note when it belongs to the new list; otherwise open the
  // list's first item (Apple Notes). Narrow layouts wait for a tap instead.
  const scopeKey = `${listScope.kind}:${listScope.kind === 'notebook' ? listScope.id : listScope.kind === 'tag' ? listScope.name : ''}`
  // Only on scope switches; ordinary list updates keep the selection, so the
  // latest values are read through a ref.
  const scopeSwitchRef = useRef({ listPages, layout, activePage })
  scopeSwitchRef.current = { listPages, layout, activePage }
  useEffect(() => {
    const { listPages: current, layout: currentLayout, activePage: selected } = scopeSwitchRef.current
    if (currentLayout === 'narrow' || current.some((page) => page.id === selected)) return
    const first = current[0]
    if (first) listHandlersRef.current.open(first, false)
  }, [scopeKey])

  const listHandlersRef = useRef({
    open: (_page: PageSummary, _focus: boolean) => {},
    toggleTodo: (_page: PageSummary) => {},
    remove: (_page: PageSummary) => {},
    menu: (_page: PageSummary): NoteMenuItem[] => [],
  })
  listHandlersRef.current = {
    open: (page, focus) => {
      if (listScope.kind === 'trash') setActiveArea('trash')
      else if (page.kind === 'task') setActiveArea('tasks')
      else {
        setActiveArea('notes')
        setActiveSection(page.sectionId)
        const owner = notebookBySection.get(page.sectionId)
        if (owner) setActiveNotebook(owner.id)
      }
      setActivePage(page.id)
      if (layout === 'narrow') setStackView('editor')
      if (focus && page.kind !== 'task') focusEditor()
    },
    toggleTodo: (page) => {
      const completedAt = page.completedAt ? undefined : new Date().toISOString()
      void updatePage(page.id, { completedAt }).then(() => {
        if (completedAt) showToast(`已完成“${page.title || '待办'}”`, { action: { label: '撤销', run: () => { void updatePage(page.id, { completedAt: undefined }) } } })
      })
    },
    remove: (page) => {
      if (listScope.kind === 'trash') return
      const position = listPages.findIndex((candidate) => candidate.id === page.id)
      const neighbor = listPages[position + 1] ?? listPages[position - 1]
      void trashPage(page.id).then((trashed) => {
        if (!trashed) return
        if (page.id === activePage && neighbor) listHandlersRef.current.open(neighbor, false)
        showToast(`已将“${page.title || '无标题'}”移到回收站`, { action: { label: '撤销', run: () => { void restorePage(page.id).then(() => setActivePage(page.id)) } } })
      }).catch((error: unknown) => showToast(error instanceof Error ? error.message : '无法移到回收站', { kind: 'error' }))
    },
    menu: (page) => listScope.kind === 'trash' ? [
      { label: '恢复', run: () => { void restorePage(page.id) } },
      'divider',
      { label: '永久删除', destructive: true, run: () => { void (async () => {
        if (!(await requestConfirm({ title: `永久删除“${page.title}”？`, description: '此操作无法撤销。', confirmLabel: '永久删除', destructive: true }))) return
        try { await purgePage(page.id) } catch (error) { showToast(error instanceof Error ? error.message : '无法永久删除', { kind: 'error' }) }
      })() } },
    ] : page.kind === 'task' ? [
      { label: page.completedAt ? '标记为未完成' : '标记为完成', run: () => listHandlersRef.current.toggleTodo(page) },
      { label: page.important ? '取消重要' : '标记为重要', run: () => { void updatePage(page.id, { important: !page.important }) } },
      page.reminderAt
        ? { label: '清除提醒', run: () => { void updatePage(page.id, { reminderAt: undefined, recurrenceRule: undefined }) } }
        : { label: '1 小时后提醒', run: () => { void updatePage(page.id, { reminderAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }) } },
      'divider',
      { label: '移到回收站', destructive: true, run: () => listHandlersRef.current.remove(page) },
    ] : [
      { label: page.favorite ? '取消置顶' : '置顶', run: () => { void updatePage(page.id, { favorite: !page.favorite }) } },
      { label: '创建副本', run: () => { void duplicatePage(page.id).then((id) => { setActivePage(id); setActiveSection(page.sectionId) }) } },
      { label: '移动到…', run: () => setMovePageRequest(page) },
      'divider',
      { label: '移到回收站', destructive: true, run: () => listHandlersRef.current.remove(page) },
    ],
  }
  const openFromList = useCallback((page: PageSummary, focus: boolean) => listHandlersRef.current.open(page, focus), [])
  const toggleTodoFromList = useCallback((page: PageSummary) => listHandlersRef.current.toggleTodo(page), [])
  const removeFromList = useCallback((page: PageSummary) => listHandlersRef.current.remove(page), [])
  const listMenu = useCallback((page: PageSummary) => listHandlersRef.current.menu(page), [])

  const createInScope = async () => {
    setQuery('')
    try {
      if (listScope.kind === 'tasks') {
        const sectionId = activeSection || findQuickCaptureTarget(notebooks)?.sectionId
        if (!sectionId) { showToast('请先创建一个笔记本', { kind: 'error' }); return }
        const id = await createPage(sectionId, 'task')
        setActiveArea('tasks')
        setActivePage(id)
      } else if (listScope.kind === 'notebook' && scopeNotebook) {
        await createTopLevelPage()
        setActiveArea('notes')
        focusEditor()
      } else {
        const target = findQuickCaptureTarget(notebooks)
        if (!target) { setCreateRequest('notebook'); return }
        const id = await createPage(target.sectionId)
        if (listScope.kind === 'trash') chooseScope({ kind: 'all' })
        setActiveArea('notes')
        setActiveNotebook(target.notebookId)
        setActiveSection(target.sectionId)
        setActivePage(id)
        focusEditor()
      }
      if (layout === 'narrow') setStackView('editor')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法新建', { kind: 'error' })
    }
  }

  // Rapid entry: the new todo stays in the list; the field keeps focus.
  const addTodo = async (title: string) => {
    const sectionId = activeSection || findQuickCaptureTarget(notebooks)?.sectionId
    if (!sectionId) { showToast('请先创建一个笔记本', { kind: 'error' }); return }
    try {
      const id = await createPage(sectionId, 'task')
      await updatePage(id, { title })
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法添加待办', { kind: 'error' })
    }
  }

  const sidebarVisible = layout === 'wide' ? navOpen : drawerOpen
  const toggleSidebar = () => { if (layout === 'wide') setNavOpen((value) => !value); else setDrawerOpen((value) => !value) }
  // Notebooks work like drives: pick one, and its pages fill the tree below,
  // starting at the left edge instead of being indented under the notebook.
  const activeDrive = notebooks.find((notebook) => notebook.id === expandedNotebook && (!notebook.locked || privacyUnlocked))
  const listVisible = !assistant && (layout === 'narrow' ? stackView === 'list' : pagesOpen && browse === 'list')
  const showList = () => { setBrowse('list'); setPagesOpen(true) }
  const onTreeActivate = useCallback((page: PageSummary, hasChildren: boolean, closeOnNarrow: 'navigation' | 'pages') => {
    setBrowse('tree')
    setAssistant(undefined)
    // Leaving To-dos or Trash: the list (when shown again) should list notes.
    setScope((current) => current.kind === 'tasks' || current.kind === 'trash' ? { kind: 'all' } : current)
    activateTreePage(page, hasChildren, closeOnNarrow)
  }, [activateTreePage])

  // Mac shortcuts: ⌘N new, ⌘F search, ⌃⌘S sidebar, ⌃⌘L note list, ⌘, settings.
  useShellShortcuts({
    create: () => { void createInScope() },
    toggleSidebar,
    toggleList: () => { if (layout === 'narrow') setStackView((view) => view === 'list' ? 'editor' : 'list'); else if (listVisible) setPagesOpen(false); else showList() },
    search: () => {
      if (layout === 'narrow') setStackView('list')
      else showList()
      requestAnimationFrame(() => { listSearchRef.current?.focus(); listSearchRef.current?.select() })
    },
    settings: () => { setSettingsPage('general'); setSettingsOpen(true) },
    fullTextSearch: () => setFullTextQuery((current) => current ?? (query.trim() || '')),
  })

  const syncDot = syncState === 'syncing' ? 'syncing' : syncState === 'error' ? 'error' : syncState === 'conflict' ? 'conflict' : syncState === 'offline' ? 'offline' : 'synced'
  const syncText = syncState === 'syncing' ? (syncProgress ?? '正在同步…')
    : syncState === 'synced' ? `已同步 · ${relativeTime(lastSyncSuccess(), nowMs)}`
    : syncState === 'offline' ? '未开启同步'
    : syncState === 'conflict' ? '有同步冲突'
    : '同步未完成'

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <input ref={importInput} hidden type="file" accept=".md,.markdown,.txt,.html,.htm,.json,.zip,.nbx,application/json,application/zip" multiple onChange={(event) => { const selected = [...(event.target.files ?? [])]; void Promise.all(selected.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))).then((files) => runImport(transferContext, files)); event.target.value = '' }} />
      {aiWorkspaceOpen ? <Suspense fallback={null}><AIWorkspace
        currentPage={currentPage}
        pages={accessiblePages.filter((page) => page.kind !== 'task')}
        trashPages={accessibleTrashPages}
        notebooks={notebooks.filter((notebook) => !notebook.locked || privacyUnlocked)}
        proposals={publicAutomationProposals}
        documents={documents}
        privacyUnlocked={privacyUnlocked}
        loadDocument={loadDocument}
        loadAssets={loadAssets}
        searchWorkspace={async (searchText, limit) => {
          const summaries = new Map(accessiblePages.map((page) => [page.id, page]))
          return (await searchWorkspaceCandidates(searchText, limit)).flatMap((page) => summaries.get(page.id) ?? [])
        }}
        onClose={() => setAiWorkspaceOpen(false)}
        onOpenPage={(pageId) => {
          setAiWorkspaceOpen(false)
          openRecentPage(pageId)
        }}
        onCreateWriteback={createAutomationWriteback}
        onCreateAgentProposal={createAutomationAgentProposal}
        onApplyProposal={applyAutomationProposal}
        onRejectProposal={rejectAutomationProposal}
      /></Suspense> : <div className={`workspace-grid shell layout-${layout} ${sidebarVisible ? 'sidebar-open' : 'sidebar-closed'} ${listVisible ? 'list-open' : 'list-closed'} ${layout === 'narrow' ? `stack-${stackView}` : ''} ${assistant ? 'assistant-open' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px`, '--list-width': `${listWidth}px`, '--ai-pane-width': `${aiWidth}px` } as CSSProperties}>
        {layout !== 'wide' && drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />}
        <Sidebar
          scope={layout !== 'narrow' && !listVisible ? { kind: 'notebook', id: '' } : listScope}
          onScope={chooseScope}
          counts={{ all: documentPages.length, favorites: favoriteCount, tasks: openTodoCount, taskBadge: digest.badge, taskOverdue: digest.overdue.length > 0, trash: accessibleTrashPages.length }}
          tags={tags}
          settingsRef={settingsTriggerRef}
          onSettings={() => { setSettingsPage('general'); setSettingsOpen(true) }}
          onHide={toggleSidebar}
          onNewNotebook={() => setCreateRequest('notebook')}
          assistantOpen={Boolean(assistant)}
          onAssistant={() => { if (layout !== 'wide') setDrawerOpen(false); openAssistant() }}
          notebooks={<div className="sidebar-tree" role="tree" aria-label="笔记本" onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPageDropTarget(undefined) }}>
              {notebooks.map((notebook) => {
                const expanded = expandedNotebook === notebook.id && (!notebook.locked || privacyUnlocked)
                return (
                  <div key={notebook.id} className="notebook-drive">
                    <ActionMenu openOnContext label={`${notebook.name}笔记本操作`} trigger={<button type="button" className={`sidebar-item notebook-item ${expanded ? 'selected' : ''} ${notebook.locked ? 'private' : ''}`} aria-pressed={expanded} aria-label={notebook.locked && !privacyUnlocked ? `${notebook.name}（已锁定）` : notebook.name} onClick={() => {
                      if (notebook.locked && !privacyUnlocked) { requestPrivacyAccess(notebook.id); return }
                      if (expanded) { setBrowse('tree'); return }
                      chooseScope({ kind: 'notebook', id: notebook.id })
                    }}>
                      <span className="sidebar-item-icon notebook-emoji">{notebook.emoji || '📒'}</span>
                      <span className="sidebar-item-label">{notebook.name}</span>
                      {notebook.locked && <span className="notebook-lock-state" title={privacyUnlocked ? '已解锁' : '已锁定'}>{privacyUnlocked ? <LockOpen16Regular /> : <LockClosed16Regular />}</span>}
                      {(!notebook.locked || privacyUnlocked) && <span className="sidebar-count">{notebookCounts.get(notebook.id) ?? 0}</span>}
                    </button>}>
                      {notebook.locked && !privacyUnlocked ? <button onClick={() => requestPrivacyAccess(notebook.id)}>解锁笔记本</button> : <><button onClick={() => setRenameRequest({ kind: 'notebook', id: notebook.id, name: notebook.name })}>重命名笔记本</button><button onClick={() => { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id); setCreateRequest('rootPage') }}>新建顶层页面</button>{notebook.sections[0] && <button onClick={() => { pendingImportTarget.current = { sectionId: notebook.sections[0]!.id }; chooseImport(transferContext) }}>导入 Markdown / 文本…</button>}<ActionMenuDivider /><button className="destructive-menu-item" onClick={() => { void (async () => {
                      if (!(await requestConfirm({ title: `删除笔记本“${notebook.name}”？`, description: '将删除其中全部页面、任务、附件和历史版本，此操作无法撤销。', confirmLabel: '删除笔记本', destructive: true }))) return
                      try {
                        await deleteNotebook(notebook.id)
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : '无法删除笔记本', { kind: 'error' })
                      }
                    })() }}>删除笔记本及全部内容</button></>}
                    </ActionMenu>
                  </div>
                )
              })}
              {activeDrive && <div className="sidebar-drive-tree" role="group" aria-label={activeDrive.name}>
                {activeDrive && activeDrive.sections.map((section) => {
                  const pagesInSection = pagesBySection.get(section.id) ?? emptyPageList
                  const treeRows = flattenPageTree(pagesInSection, expandedPageIds)
                  if (treeRows.length === 0) return null
                  return <div key={section.id} className="sidebar-page-tree">
                    {treeRows.map(({ page, depth, hasChildren }) => <PageTreeRow
                      key={page.id}
                      page={page}
                      depth={depth}
                      hasChildren={hasChildren}
                      childCount={pageDescendantCounts.get(page.id) ?? 0}
                      pagesInSection={pagesInSection}
                      variant="navigation"
                      selected={activePage === page.id}
                      expanded={expandedPageIds.has(page.id)}
                      dropTarget={pageDropTarget?.id === page.id ? pageDropTarget : undefined}
                      actions={rowActions}
                      onActivate={onTreeActivate}
                      onToggleExpanded={togglePageExpanded}
                      onPrefetch={scheduleDocumentPrefetch}
                      onPrefetchStop={stopDocumentPrefetch}
                      onDropPosition={setDropPosition}
                      onDrop={dropPage}
                      onDragEnd={clearDropTarget}
                    />)}
                  </div>
                })}
              </div>}
            </div>}
          syncStatus={<ActionMenu label="同步状态详情" trigger={<button type="button" className={`sidebar-sync ${showSyncCompleted ? 'synced just-finished' : syncDot}`} aria-label={`同步状态：${syncLabels[syncState]}`}>
              <span className="sync-dot" aria-hidden="true" />
              <span className="sidebar-sync-text">{showSyncCompleted ? '同步完成' : syncText}</span>
            </button>}>
                <div className="sync-status-detail">
                  <strong>{syncLabels[syncState]}</strong>
                  <span>{syncState === 'offline' ? '自动同步未启用或尚未配置，当前修改保存在本机。' : syncState === 'syncing' ? syncProgress ?? '正在与坚果云交换最新数据。' : syncState === 'synced' ? `本机与坚果云已同步（${relativeTime(lastSyncSuccess())}）。` : syncState === 'conflict' ? '同步版本存在冲突，自动重试已暂停。请到同步设置选择处理方式。' : `最近一次同步没有完成，本机修改已安全保存，稍后会自动重试。上次成功：${relativeTime(lastSyncSuccess())}。`}</span>
                  {(syncState === 'error' || syncState === 'conflict') && <code>{syncError ?? (syncState === 'conflict' ? accessiblePages.filter((page) => page.syncStatus === 'conflict').map((page) => page.title).join('、') || '存在尚未处理的同步冲突。' : '没有提供更详细的错误信息。')}</code>}
                </div>
                <ActionMenuDivider />
                <button disabled={syncState === 'syncing'} onClick={() => void syncNow({ force: true })}>{syncState === 'syncing' ? '正在同步…' : '立即同步'}</button>
                <button onClick={() => { setSettingsPage('services'); setSettingsOpen(true) }}>打开同步设置</button>
            </ActionMenu>}
          resizer={layout === 'wide' && sidebarVisible ? <PanelResizer label="调整边栏宽度" value={sidebarWidth} min={200} max={360} onChange={setSidebarWidth} resetValue={248} /> : undefined}
        />

        <section className="note-list-pane" aria-label="笔记列表">
          <header className="note-list-header" data-tauri-drag-region>
            {!sidebarVisible && <button type="button" className="toolbar-icon-button" aria-label="显示边栏" title="显示边栏（⌃⌘S）" onClick={toggleSidebar}><PanelLeft20Regular /></button>}
            <div className="note-list-titles" data-tauri-drag-region>
              <h2 data-tauri-drag-region>{scopeTitle}</h2>
              <span data-tauri-drag-region>{scopeSubtitle}</span>
            </div>
            <ActionMenu label="排序与显示" trigger={<button type="button" className="toolbar-icon-button" aria-label="排序与显示" title="排序与显示"><ArrowSortDownLines20Regular /></button>}>
              <span className="action-menu-heading">排序方式</span>
              {(listScope.kind === 'tasks' ? ['due', 'updated', 'created', 'title'] as const : ['updated', 'created', 'title'] as const).map((order) => <button key={order} className={listOrder === order ? 'selected' : undefined} onClick={() => {
                if (listScope.kind === 'tasks') { setTasksOrder(order); writePreference('notebook-tasks-order', order) }
                else { setNotesOrder(order); writePreference('notebook-notes-order', order) }
              }}>{listOrderLabels[order]}</button>)}
              <ActionMenuDivider />
              <button className={grouped ? 'selected' : undefined} onClick={() => { setGrouped(!grouped); writePreference('notebook-list-grouped', grouped ? 'off' : 'on') }}>{listScope.kind === 'tasks' ? '按截止状态分组' : '按日期分组'}</button>
              <button className={density === 'compact' ? 'selected' : undefined} onClick={() => { const next = density === 'compact' ? 'cards' : 'compact'; setDensity(next); writePreference('notebook-list-density', next) }}>紧凑列表</button>
            </ActionMenu>
            {listScope.kind !== 'trash' && <button type="button" className="toolbar-icon-button" aria-label={listScope.kind === 'tasks' ? '新建待办' : '新建笔记'} title={`${listScope.kind === 'tasks' ? '新建待办' : '新建笔记'}（⌘N）`} onClick={() => { void createInScope() }}><Compose20Regular /></button>}
          </header>
          <div className="note-list-search">
            <Search16Regular aria-hidden="true" />
            <input
              ref={listSearchRef}
              type="text"
              value={query}
              spellCheck={false}
              placeholder={listScope.kind === 'tasks' ? '搜索待办' : listScope.kind === 'trash' ? '搜索回收站' : '搜索：多个词、"短语"、-排除、#标签'}
              aria-label="搜索"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { setQuery(''); event.currentTarget.blur() }
                else if ((event.key === 'ArrowDown' || event.key === 'Enter') && listPages[0]) {
                  event.preventDefault()
                  openFromList(listPages[0], event.key === 'Enter')
                  if (event.key === 'ArrowDown') document.querySelector<HTMLElement>('.note-list-scroll')?.focus()
                }
              }}
            />
            {query ? <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { setQuery(''); listSearchRef.current?.focus() }}><Dismiss12Regular /></button> : <kbd>⌘F</kbd>}
          </div>
          {searching && listScope.kind !== 'all' && listScope.kind !== 'trash' && <div className="search-scope" role="radiogroup" aria-label="搜索范围">
            <button type="button" role="radio" aria-checked={!searchAll} className={!searchAll ? 'selected' : undefined} onClick={() => setSearchAll(false)}>仅{scopeTitle}</button>
            <button type="button" role="radio" aria-checked={searchAll} className={searchAll ? 'selected' : undefined} onClick={() => setSearchAll(true)}>全部笔记</button>
          </div>}
          {searching && <button type="button" className="search-full-text" onClick={() => openFullTextSearch(query.trim())}><Search16Regular aria-hidden="true" />在正文中搜索“{query.trim()}”<kbd>⌘⇧F</kbd></button>}
          {!searching && (listScope.kind === 'all' || listScope.kind === 'tasks') && <DueBanner
            items={bannerItems}
            now={nowMs}
            onOpen={(page) => openFromList(page, false)}
            onComplete={(page) => toggleTodoFromList(page)}
            onSnooze={(page) => banner.snooze(page, 60)}
            onDismiss={(page) => banner.dismiss(page)}
            onShowAll={() => { chooseScope({ kind: 'tasks' }); setTasksOrder('due') }}
          />}
          {listScope.kind === 'tasks' && !searching && <form className="todo-quick-add" onSubmit={(event) => {
            event.preventDefault()
            const input = event.currentTarget.elements.namedItem('todo-title') as HTMLInputElement
            const title = input.value.trim()
            if (title) void addTodo(title).then(() => { input.value = '' })
          }}>
            <span className="todo-check" aria-hidden="true" />
            <input name="todo-title" type="text" placeholder="添加待办，按回车保存" aria-label="添加待办" autoComplete="off" />
          </form>}
          {listPages.length ? <VirtualNoteList
            sections={listSections}
            density={density}
            selectedId={activePage}
            terms={listTerms}
            showNotebook={listScope.kind !== 'notebook'}
            notebookName={notebookName}
            timeOf={listTimeOf}
            now={nowMs}
            onOpen={openFromList}
            onToggleTodo={toggleTodoFromList}
            onDelete={removeFromList}
            onPrefetch={scheduleDocumentPrefetch}
            menu={listMenu}
            resetKey={`${scopeKey}|${searching ? 'search' : listOrder}`}
          /> : <div className="note-list-empty">
            {searching ? <>
              <strong>没有找到“{query.trim()}”</strong>
              <span>试试更短的关键词或拼音首字母。</span>
              {listScope.kind !== 'all' && !searchAll && <button type="button" onClick={() => setSearchAll(true)}>搜索全部笔记</button>}
            </> : listScope.kind === 'tasks' ? <>
              <strong>没有待办</strong>
              <span>记下要做的事，到期前会在这里提醒。</span>
              <button type="button" onClick={() => { void createInScope() }}>新建待办</button>
            </> : listScope.kind === 'trash' ? <>
              <strong>回收站是空的</strong>
              <span>移到回收站的笔记会保留在这里，可以随时恢复。</span>
            </> : listScope.kind === 'favorites' ? <>
              <strong>还没有置顶的笔记</strong>
              <span>在笔记上点右键，选择“置顶”。</span>
            </> : <>
              <strong>这里还没有笔记</strong>
              <span>{documentPages.length ? '按 ⌘N 新建一篇。' : '已经在坚果云保存过笔记？连接后会自动恢复到这里。'}</span>
              {notebooks.length > 0 && <button type="button" onClick={() => { void createInScope() }}>新建笔记</button>}
              {!documentPages.length && <button type="button" className="secondary" onClick={() => { setSettingsPage('services'); setSettingsOpen(true) }}>连接坚果云</button>}
            </>}
          </div>}
          {layout !== 'narrow' && listVisible && <PanelResizer label="调整笔记列表宽度" value={listWidth} min={260} max={480} onChange={setListWidth} resetValue={320} />}
        </section>

        {assistant ? <main className="content-pane assistant-pane"><AssistantView
          key={assistant.key}
          pages={accessiblePages}
          notebooks={notebooks.filter((notebook) => !notebook.locked || privacyUnlocked)}
          tags={tags}
          initialScope={assistant.scope}
          loadMarkdown={async (pageId) => { const document = await loadDocument(pageId); return document ? documentToMarkdown(document) : undefined }}
          loadDocument={loadDocument}
          openPage={(pageId) => { setAssistant(undefined); setBrowse('tree'); openRecentPage(pageId) }}
          createNote={createNoteFromAssistant}
          openAISettings={() => { setSettingsPage('services'); setSettingsOpen(true) }}
          applyPlan={async (groups, onProgress) => {
            try { return await applyPlan(groups, planApi, onProgress) } finally { await reloadWorkspace() }
          }}
        /></main> : <main className="content-pane">
          <div className="editor-toolbar" data-tauri-drag-region>
            <div className="toolbar-leading" data-tauri-drag-region>
              {layout === 'narrow' && <button type="button" className="toolbar-back" onClick={() => setStackView('list')}><ChevronLeft20Regular /><span>{scopeTitle}</span></button>}
              {layout !== 'narrow' && !listVisible && !sidebarVisible && <button type="button" className="toolbar-icon-button" aria-label="显示边栏" title="显示边栏（⌃⌘S）" onClick={toggleSidebar}><PanelLeft20Regular /></button>}
              {layout !== 'narrow' && !listVisible && <button type="button" className="toolbar-icon-button" aria-label="显示笔记列表" title="显示笔记列表（⌃⌘L）" onClick={showList}><TextBulletListLtr20Regular /></button>}
              {activeArea === 'notes' && hasActivePage && <>
              <div className="page-history-controls" role="group" aria-label="笔记浏览历史">
                <Button appearance="subtle" size="small" icon={<ArrowLeft20Regular />} aria-label="后退到上一笔记" title="后退到上一笔记" disabled={!previousPageVisit} onClick={() => navigatePageHistory(-1)} />
                <Button appearance="subtle" size="small" icon={<ArrowRight20Regular />} aria-label="前进到下一笔记" title="前进到下一笔记" disabled={!nextPageVisit} onClick={() => navigatePageHistory(1)} />
              </div>
              </>}
            </div>
            <div className="breadcrumb" data-tauri-drag-region><span>{activeArea === 'notes' ? currentNotebook?.name ?? '工作区' : '我的知识库'}</span>{activeArea === 'notes' && hasActivePage && currentPageAncestors.map((ancestor) => <Fragment key={ancestor.id}><ChevronRight16Regular /><button className="breadcrumb-page" title={ancestor.title} onClick={() => setActivePage(ancestor.id)}>{ancestor.title}</button></Fragment>)}<ChevronRight16Regular />{activeArea === 'notes' ? hasActivePage ? <Input key={`${currentPage.id}:${currentPage.title}`} className="breadcrumb-title-input" defaultValue={currentPage.title} aria-label="页面标题" onBlur={(event) => { const title = event.currentTarget.value.trim(); if (title && title !== currentPage.title) void updatePage(currentPage.id, { title }) }} /> : <span>未选择页面</span> : <span>{activeArea === 'tasks' ? '所有任务' : '已删除页面'}</span>}</div>
            <div className="editor-actions">
              {activeArea === 'notes' && hasActivePage && <>
                <div className="page-utilities"><Suspense fallback={null}><AttachmentPanel pageId={currentPage.id} loadAssets={loadAssets} saveAsset={saveAsset} openAsset={openAsset} /><VersionHistory pageId={currentPage.id} currentMarkdown={documents[currentPage.id] ? documentToMarkdown(documents[currentPage.id]!) : ''} load={loadRevisions} create={async (pageId) => { const current = documents[pageId]; if (current) await saveDocument(pageId, current); return createManualRevision(pageId) }} restore={(revisionId) => restoreRevision(revisionId).then((pageId) => { setRestoreToken(`${pageId}:${Date.now()}`) })} /></Suspense></div>
                <button type="button" className={`toolbar-icon-button ${aiOpen && rightPanel === 'outline' ? 'selected' : ''}`} aria-label="大纲" title="大纲" aria-pressed={aiOpen && rightPanel === 'outline'} onClick={() => { if (aiOpen && rightPanel === 'outline') showRightPanel(false); else { setRightPanel('outline'); showRightPanel(true) } }}><TextBulletListSquare20Regular /></button>
                <button type="button" className={`toolbar-icon-button ${aiOpen && rightPanel === 'backlinks' ? 'selected' : ''}`} aria-label="引用" title="被哪些笔记引用" aria-pressed={aiOpen && rightPanel === 'backlinks'} onClick={() => { if (aiOpen && rightPanel === 'backlinks') showRightPanel(false); else { setRightPanel('backlinks'); showRightPanel(true) } }}><ArrowReply20Regular /></button>
                <button type="button" className="toolbar-icon-button" aria-label="插入双链" title="插入双链" onClick={() => setReferencePickerOpen(true)}><Link20Regular /></button>
                <button type="button" className={`vim-chip ${vimEnabled ? 'enabled' : ''} ${vimEnabled && vimCommandMode ? 'selected' : ''}`} aria-pressed={vimEnabled} title={vimEnabled ? vimCommandMode ? 'Vim NORMAL：i 进入编辑，点击关闭 Vim' : 'Vim INSERT：Esc 返回普通模式，点击关闭 Vim' : '启用 Vim 模式'} onClick={() => setVimEnabled((value) => { const next = !value; setVimCommandMode(next); return next })}>Vim</button>
              </>}
              <button type="button" className="toolbar-icon-button" aria-label="AI" title="用 AI 处理这篇笔记（含子笔记）" onClick={() => openAssistant({ ...emptyScope(), pageIds: [currentPage.id] })}><Bot20Regular /></button>
              <ActionMenu label="更多操作" trigger={<button type="button" className="toolbar-icon-button" aria-label="更多操作" title="更多操作"><MoreHorizontal20Regular /></button>}>
                {activeArea === 'notes' && hasActivePage && <>
                  <button onClick={() => void updatePage(currentPage.id, { favorite: !currentPage.favorite })}>{currentPage.favorite ? '取消置顶' : '置顶'}</button>
                  <button onClick={() => setMovePageRequest(currentPage)}>移动到…</button>
                  <ActionMenuDivider />
                </>}
                <button onClick={() => setFocusMode(true)}>专注模式（F11）</button>
                {layout !== 'narrow' && <button onClick={() => { if (listVisible) setPagesOpen(false); else showList() }}>{listVisible ? '隐藏笔记列表' : '显示笔记列表'}（⌃⌘L）</button>}
                <ActionMenuDivider />
                <span className="action-menu-heading">外观</span>
                <button className={themePreference === 'light' ? 'selected' : undefined} onClick={() => onThemePreferenceChange?.('light')}>浅色</button>
                <button className={themePreference === 'dark' ? 'selected' : undefined} onClick={() => onThemePreferenceChange?.('dark')}>深色</button>
                <button className={themePreference === 'system' ? 'selected' : undefined} onClick={() => onThemePreferenceChange?.('system')}>跟随系统</button>
                {activeArea === 'notes' && hasActivePage && <>
                  <ActionMenuDivider />
                  <button className="destructive-menu-item" onClick={() => listHandlersRef.current.remove(currentPage)}>移到回收站</button>
                </>}
              </ActionMenu>
            </div>
          </div>
          <section className="document-surface">
            {currentPage.syncStatus === 'conflict' && <div className="sync-conflict-banner" role="alert"><strong>此笔记存在尚未处理的同步冲突</strong><span>本机内容未被覆盖。请到“设置 → 同步状态与修复”处理；继续编辑不会自动解决冲突。</span></div>}
            {activeArea === 'trash' ? (accessibleTrashPages.length ? <div className="trash-detail"><Delete20Regular /><h2>{currentPage.title}</h2><p>页面仍保留在本机，可以恢复到原分区或永久删除。</p><div><Button appearance="primary" onClick={() => { void restorePage(currentPage.id).then(() => { chooseScope({ kind: 'all' }); setActivePage(currentPage.id) }) }}>恢复页面</Button><Button appearance="secondary" onClick={() => { void (async () => {
                  if (!(await requestConfirm({ title: `永久删除“${currentPage.title}”？`, description: '永久删除后无法恢复，确定继续吗？', confirmLabel: '永久删除', destructive: true }))) return
                  try {
                    await purgePage(currentPage.id)
                    setActivePage(accessibleTrashPages.find((page) => page.id !== currentPage.id)?.id ?? accessiblePages[0]?.id ?? '')
                  } catch (error) {
                    showToast(error instanceof Error ? error.message : '无法永久删除页面', { kind: 'error' })
                  }
                })() }}>永久删除</Button></div></div> : <ModePlaceholder icon={<Delete20Regular />} title="回收站是空的" description="移到回收站的页面会显示在这里。" />) : activeArea === 'tasks' ? (hasActivePage ? <Suspense fallback={null}><TaskDetail key={currentPage.id} task={currentPage} loadSteps={loadTaskSteps} saveSteps={saveTaskSteps} updateTask={(patch) => updatePage(currentPage.id, patch)} /></Suspense> : <ModePlaceholder icon={<CheckmarkCircle20Regular />} title={taskPages.length ? '选择一项待办' : '还没有待办'} description={taskPages.length ? '从列表中选择，或按 ⌘N 新建。' : '记下要做的事，可以设置截止时间和提醒。'} actionLabel="新建待办" onAction={() => { void createInScope() }} />) : !notebooks.length ? <ModePlaceholder icon={<Document20Regular />} title="还没有笔记本" description="新建一个笔记本，或在设置中连接坚果云恢复已有笔记。" actionLabel="新建笔记本" onAction={() => setCreateRequest('notebook')} /> : !hasActivePage ? <ModePlaceholder icon={<Document20Regular />} title={documentPages.length ? '选择一篇笔记' : '这里还没有笔记'} description={documentPages.length ? '从列表中选择，或按 ⌘N 新建。' : '新建第一篇笔记，开始记录想法、会议或资料。'} actionLabel="新建笔记" onAction={() => { void createInScope() }} /> : <div key={currentPage.id} className="document-transition">
            {!currentDocument ? <div className="document-loading" role="status" aria-live="polite">
              <span className="document-loading-spinner" />
              <strong>正在准备笔记…</strong>
              <span>大型笔记会并行解析，完成后可正常编辑。</span>
            </div> : <>
              {currentDocumentIsEmpty && currentPageChildren.length > 0 && <EmptyParentPageHint pages={currentPageChildren} onOpen={openRecentPage} />}
              <DocumentEditor
              key={`${currentPage.id}:${restoreToken.startsWith(`${currentPage.id}:`) ? restoreToken : ''}`}
              workspaceId={WORKSPACE_ID}
              pageId={currentPage.id}
              pageTitle={currentPage.title}
              content={currentDocument}
              onDraft={(json) => stageDocument(currentPage.id, json)}
              onChange={(json) => saveDocument(currentPage.id, json)}
              loadAsset={getAssetContent}
              saveAsset={saveAsset}
              forceRestore={restoreToken.startsWith(`${currentPage.id}:`)}
              vimEnabled={vimEnabled}
              onVimCommandModeChange={setVimCommandMode}
              viewportPosition={loadedReadingPosition?.pageId === currentPage.id ? loadedReadingPosition.position : undefined}
              onViewportChange={(position) => recordViewportPosition(currentPage.id, position)}
              />
            </>}
            </div>}
          </section>
        </main>}

        {!assistant && aiOpen && activeArea === 'notes' && hasActivePage && <aside className="right-sidebar open" aria-label="大纲与引用">
          <div className="right-sidebar-panel">
            <PanelResizer label="调整右侧面板宽度" value={aiWidth} min={240} max={460} onChange={setAiWidth} resetValue={280} side="left" />
            {rightPanel === 'outline' && <Suspense fallback={null}><OutlineSidebar document={documents[currentPage.id]} /></Suspense>}
            {rightPanel === 'backlinks' && <Suspense fallback={null}><BacklinksSidebar pageId={currentPage.id} pages={accessiblePages} load={loadBacklinks} loadMentions={loadUnlinkedMentions} openPage={openRecentPage} refreshKey={referenceIndexRevision} /></Suspense>}
          </div>
        </aside>}
      </div>}
      {focusMode && <Button className="focus-exit" appearance="primary" shape="circular" icon={<FullScreenMinimize20Regular />} aria-label="退出聚焦模式" title="退出聚焦模式（Esc）" onClick={() => setFocusMode(false)} />}
      {settingsOpen && <Suspense fallback={null}><SettingsCenter
        initialPage={settingsPage}
        theme={theme}
        themePreference={themePreference}
        accentColor={accentColor}
        syncState={syncState}
        syncError={syncError}
        syncProgress={syncProgress}
        currentPageTitle={currentPage.title}
        transferMessage={transferMessage}
        dataRoot={dataRoot}
        desktop={Boolean(window.notebookDesktop)}
        aiService={import.meta.env.VITE_NOTEBOOK_AI_URL}
        collaborationService={import.meta.env.VITE_NOTEBOOK_COLLAB_URL}
        automationProposals={publicAutomationProposals}
        automationNotebooks={notebooks.filter((notebook) => !notebook.locked)}
        automationPages={pages.filter((page) => !page.locked)}
        onApplyAutomationProposal={applyAutomationProposal}
        onRejectAutomationProposal={rejectAutomationProposal}
        privacyAvailable={notebooks.some((notebook) => notebook.locked)}
        privacyConfigured={privacyConfigured}
        privacyUnlocked={privacyUnlocked}
        onClose={closeSettings}
        onThemePreferenceChange={(preference) => onThemePreferenceChange?.(preference)}
        onAccentColorChange={(color) => onAccentColorChange?.(color)}
        onSyncNow={async (mode) => Boolean(await syncNow({ force: true, mode }))}
        onMigrateFromSsh={async () => migrateSshToWebdav(automationRepository, WORKSPACE_ID)}
        syncRepair={syncRepair}
        onImport={() => chooseImport(transferContext)}
        onExportPage={(format) => { void saveCurrentDocument(transferContext, format) }}
        onPrint={() => { setSettingsOpen(false); window.setTimeout(() => window.print(), 0) }}
        onExportWorkspace={() => { void runExport(transferContext).catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '导出失败')) }}
        onExportEncrypted={() => { setSettingsOpen(false); setEncryptedExportOpen(true) }}
        onResetHistory={resetRevisionHistory}
        onChooseDataRoot={window.notebookDesktop ? () => { void window.notebookDesktop?.storage.chooseDataRoot().catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '数据目录更改失败')) } : undefined}
        onPrivacyAction={() => { if (privacyUnlocked) lockPrivacy(); else { setSettingsOpen(false); requestPrivacyAccess() } }}
      /></Suspense>}
      {fullTextQuery !== undefined && <FullTextSearch
        initialQuery={fullTextQuery}
        search={searchHits}
        notebookName={(sectionId) => notebookBySection.get(sectionId)?.name ?? ''}
        onClose={() => setFullTextQuery(undefined)}
        onOpen={(hit) => {
          setFullTextQuery(undefined)
          if (hit.page.kind === 'task') { setActiveArea('tasks'); setActivePage(hit.page.id) }
          else openRecentPage(hit.page.id)
          if (layout === 'narrow') setStackView('editor')
          findInDocument({ pageId: hit.page.id, terms: hit.terms })
        }}
      />}
      <Suspense fallback={null}><CommandPalette
        open={commandPaletteOpen}
        items={paletteItems}
        searchPageIds={searchPalettePageIds}
        onClose={() => setCommandPaletteOpen(false)}
      /></Suspense>
      {referenceHelpOpen && <Suspense fallback={null}><ReferenceHelpDialog onClose={() => setReferenceHelpOpen(false)} /></Suspense>}
      {createRequest && <CreateItemDialog kind={createRequest} onClose={() => setCreateRequest(undefined)} onCreate={async (name) => {
        if (createRequest === 'notebook') { const notebookId = await createNotebook(name); setActiveNotebook(notebookId); setExpandedNotebook(notebookId) }
        else {
          const created = await createSection(activeNotebook, name)
          setActiveSection(created.sectionId)
          setActivePage(created.pageId)
          setExpandedNotebook(activeNotebook)
        }
        setCreateRequest(undefined)
      }} />}
      {renameRequest && <RenameItemDialog request={renameRequest} onClose={() => setRenameRequest(undefined)} onRename={async (name) => {
        await renameNotebook(renameRequest.id, name)
        setRenameRequest(undefined)
      }} />}
      {textImport && <ImportDialog
        files={textImport.files}
        pages={accessiblePages}
        notebooks={notebooks.filter((notebook) => !notebook.locked || privacyUnlocked)}
        initialTarget={textImport.target}
        onClose={() => setTextImport(undefined)}
        onImport={async (files, target) => {
          const outcome = await importTextFiles(files, target)
          if (target.parentPageId) setExpandedPageIds((current) => current.has(target.parentPageId!) ? current : new Set([...current, target.parentPageId!]))
          if (outcome.createdIds[0]) openRecentPage(outcome.createdIds[0])
          return outcome
        }}
      />}
      {movePageRequest && <MovePageDialog page={movePageRequest} pages={accessiblePages.filter((page) => page.kind !== 'task')} notebooks={notebooks.filter((notebook) => !notebook.locked || privacyUnlocked)} onClose={() => setMovePageRequest(undefined)} onMove={async (targetPageId, position) => {
        const target = accessiblePages.find((page) => page.id === targetPageId)
        if (!target) throw new Error('目标页面不存在')
        await movePageRelative(movePageRequest.id, target, position)
        setMovePageRequest(undefined)
      }} />}
      {iconPickerPage && <PageIconPicker
        page={iconPickerPage}
        onClose={() => setIconPickerPage(undefined)}
        onSelect={async (icon) => {
          await updatePage(iconPickerPage.id, { icon })
          setIconPickerPage(undefined)
        }}
      />}
      {encryptedExportOpen && <BackupPasswordDialog mode="create" onClose={() => setEncryptedExportOpen(false)} onSubmit={async (passphrase) => { await runEncryptedExport(transferContext, passphrase); setEncryptedExportOpen(false) }} />}
      {encryptedImportRequest && <BackupPasswordDialog mode="unlock" filename={encryptedImportRequest.file.name} onClose={() => setEncryptedImportRequest(undefined)} onSubmit={async (passphrase) => {
        const request = encryptedImportRequest
        const decrypted = await decryptBackup(request.file.data, passphrase)
        setEncryptedImportRequest(undefined)
        await runImport(transferContext, [...request.rest, { name: request.file.name.replace(/\.nbx$/i, '.zip'), data: decrypted }])
      }} />}
      {privacyPrompt && <PrivacyPasswordDialog mode={privacyPrompt.mode} onClose={() => setPrivacyPrompt(undefined)} onSubmit={async (passphrase) => {
        if (privacyPrompt.mode === 'setup') {
          await configurePrivacyLock(passphrase)
          setPrivacyConfigured(true)
        } else if (!(await verifyPrivacyLock(passphrase))) throw new Error('密码不正确')
        const notebookId = privacyPrompt.notebookId
        setPrivacyUnlocked(true)
        setPrivacyPrompt(undefined)
        if (notebookId) window.setTimeout(() => activateNotebook(notebookId), 0)
      }} />}
      {referencePickerOpen && <Suspense fallback={null}><ReferencePicker pages={accessiblePages} currentPageId={currentPage.id} loadDocument={loadDocument} saveDocument={saveDocument} onClose={() => setReferencePickerOpen(false)} /></Suspense>}
      <ConfirmDialogHost />
      <ToastHost />
    </div>
  )
}
