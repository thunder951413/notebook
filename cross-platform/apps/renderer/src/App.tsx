import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Button,
  Input,
  Text,
} from '@fluentui/react-components'
import {
  Add20Regular,
  ArrowLeft20Regular,
  ArrowReply20Regular,
  ArrowRight20Regular,
  ArrowSync20Regular,
  Bot20Regular,
  CheckmarkCircle20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Document20Filled,
  Document20Regular,
  Delete20Regular,
  FullScreenMaximize20Regular,
  FullScreenMinimize20Regular,
  LockClosed20Regular,
  LockOpen20Regular,
  Link20Regular,
  MoreHorizontal20Regular,
  Navigation20Regular,
  PanelRight20Regular,
  Search20Regular,
  Settings20Regular,
  Star16Filled,
  TextBulletListSquare20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
} from '@fluentui/react-icons'
import type { PageSummary } from './model'
import { useWorkspaceData, WORKSPACE_ID, automationRepository, STARTUP_NOTEBOOK_ID, STARTUP_SECTION_ID, STARTUP_PAGE_ID } from './data/useWorkspaceData'
import type { ImportFile } from './data/transfer'
import { useReminders } from './tasks/useReminders'
import { documentToMarkdown, htmlToDocument, markdownToDocument } from './editor/extensions'
import { decryptBackup } from './crypto/encryptedBackup'
import type { AccentColor } from './appearance/accent'
import type { ThemePreference } from './appearance/theme'
import { configurePrivacyLock, hasPrivacyLock, verifyPrivacyLock } from './crypto/privacyLock'
import { migrateSshToWebdav } from './sync/webdavSync'
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
import { registerAfterFlushHandler, registerFlushHandler } from './data/flushCoordinator'
import { createBackgroundSyncGate } from './sync/syncLifecycle'
import { useAutomationBridge } from './automation/automationBridge'
import { BackupPasswordDialog } from './components/BackupPasswordDialog'
import { ConfirmDialogHost, requestConfirm } from './components/confirmDialog'
import { ToastHost, showToast } from './components/toast'
import { CreateItemDialog } from './components/CreateItemDialog'
import { EmptyParentPageHint } from './components/EmptyParentPageHint'
import { ModePlaceholder } from './components/ModePlaceholder'
import { MovePageDialog } from './components/MovePageDialog'
import { PageIconPicker } from './components/PageIconPicker'
import { PageTreeRow, type PageTreeDropTarget, type PageTreeRowActions } from './components/PageTreeRow'
import { PanelResizer } from './components/PanelResizer'
import { PrivacyPasswordDialog } from './components/PrivacyPasswordDialog'
import { RailButton } from './components/RailButton'
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
  readLocalReadingPositions,
  readRecentPageIds,
  readVimEnabled,
  writeLocalReadingPositions,
  type RightPanel,
  type ViewportPosition,
} from './persistence/localLayout'

// Panels that are only visible when opened are loaded on demand so the initial
// render stays lean. The editor, tree rows and rail stay on the critical path.
const TaskDetail = lazy(() => import('./tasks/TaskDetail').then((module) => ({ default: module.TaskDetail })))
const AttachmentPanel = lazy(() => import('./assets/AttachmentPanel').then((module) => ({ default: module.AttachmentPanel })))
const VersionHistory = lazy(() => import('./history/VersionHistory').then((module) => ({ default: module.VersionHistory })))
const SettingsCenter = lazy(() => import('./settings/SettingsCenter').then((module) => ({ default: module.SettingsCenter })))
const CommandPalette = lazy(() => import('./CommandPalette').then((module) => ({ default: module.CommandPalette })))
const ReferencePicker = lazy(() => import('./editor/ReferencePicker').then((module) => ({ default: module.ReferencePicker })))
const BacklinksSidebar = lazy(() => import('./editor/BacklinksPanel').then((module) => ({ default: module.BacklinksSidebar })))
const OutlineSidebar = lazy(() => import('./editor/OutlinePanel').then((module) => ({ default: module.OutlineSidebar })))
const ReferenceHelpDialog = lazy(() => import('./editor/ReferenceHelpDialog').then((module) => ({ default: module.ReferenceHelpDialog })))
const AIWorkspace = lazy(() => import('./ai-workspace/AIWorkspace').then((module) => ({ default: module.AIWorkspace })))

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
  const { notebooks, pages, trashPages, documents, referenceIndexRevision, syncState, syncError, syncNow, reloadWorkspace, loadDocument, saveDocument, stageDocument, loadBacklinks, loadUnlinkedMentions, createPage, createNotebook, createSection, renameNotebook, deleteNotebook, duplicatePage, updatePage, movePageInTree, promotePageToNotebookRoot, reorderNotebookRoot, loadTaskSteps, saveTaskSteps, importFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, searchWorkspaceCandidates, moveToTrash, restorePage, purgePage, loadRevisions, createManualRevision, resetRevisionHistory, restoreRevision, loadReadingPosition, saveReadingPosition } = useWorkspaceData()
  const {
    proposals: automationProposals,
    createAutomationAgentProposal,
    createAutomationWriteback,
    applyAutomationProposal,
    rejectAutomationProposal,
  } = useAutomationBridge(reloadWorkspace)
  const importInput = useRef<HTMLInputElement>(null)
  const previousSyncState = useRef(syncState)
  const syncCompletionTimer = useRef<number | undefined>(undefined)
  const [showSyncCompleted, setShowSyncCompleted] = useState(false)
  const readingPositionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirtyReadingPositionIds = useRef(new Set<string>())
  const documentPrefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const readingPositions = useRef(new Map<string, ViewportPosition>(Object.entries(readLocalReadingPositions())))
  const [loadedReadingPosition, setLoadedReadingPosition] = useState<{ pageId: string; position: ViewportPosition }>()
  const [activeArea, setActiveArea] = useState('notes')
  const [activeNotebook, setActiveNotebook] = useState(STARTUP_NOTEBOOK_ID)
  const [expandedNotebook, setExpandedNotebook] = useState<string | undefined>(STARTUP_NOTEBOOK_ID)
  const [activeSection, setActiveSection] = useState(STARTUP_SECTION_ID)
  const [activePage, setActivePage] = useState(() => new URLSearchParams(location.hash.slice(1)).get('page') ?? STARTUP_PAGE_ID)
  const [pageHistory, setPageHistory] = useState(emptyPageVisitHistory)

  useEffect(() => installRendererDiagnostics(), [])
  useEffect(() => {
    const previous = previousSyncState.current
    previousSyncState.current = syncState
    if (syncCompletionTimer.current) {
      window.clearTimeout(syncCompletionTimer.current)
      syncCompletionTimer.current = undefined
    }
    if (previous === 'syncing' && syncState === 'synced') {
      setShowSyncCompleted(true)
      syncCompletionTimer.current = window.setTimeout(() => {
        setShowSyncCompleted(false)
        syncCompletionTimer.current = undefined
      }, 2_000)
    } else if (syncState !== 'synced') {
      setShowSyncCompleted(false)
    }
    return () => {
      if (syncCompletionTimer.current) window.clearTimeout(syncCompletionTimer.current)
    }
  }, [syncState])
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
  const [focusMode, setFocusMode] = useState(false)
  const [notebookWidth, setNotebookWidth] = useState(() => Math.min(520, Math.max(320, readLayout().notebookWidth ?? 0, readLayout().pageWidth ?? 0)))
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
  const [dataRoot, setDataRoot] = useState<{ path: string; source: 'default' | 'environment' | 'command-line' | 'saved' }>()
  const [createRequest, setCreateRequest] = useState<'notebook' | 'rootPage'>()
  const [renameRequest, setRenameRequest] = useState<{ kind: 'notebook'; id: string; name: string }>()
  const [movePageRequest, setMovePageRequest] = useState<PageSummary>()
  const [iconPickerPage, setIconPickerPage] = useState<PageSummary>()
  const [encryptedExportOpen, setEncryptedExportOpen] = useState(false)
  const [encryptedImportRequest, setEncryptedImportRequest] = useState<{ file: ImportFile; rest: ImportFile[] }>()
  const [pageSort, setPageSort] = useState<'recent' | 'title'>('recent')
  const [compactPages, setCompactPages] = useState(false)
  const [privacyUnlocked, setPrivacyUnlocked] = useState(false)
  const [privacyConfigured, setPrivacyConfigured] = useState(() => hasPrivacyLock())
  const [privacyPrompt, setPrivacyPrompt] = useState<{ mode: 'setup' | 'unlock'; notebookId?: string }>()
  const [referencePickerOpen, setReferencePickerOpen] = useState(false)
  const [referenceHelpOpen, setReferenceHelpOpen] = useState(false)
  const [expandedPageIds, setExpandedPageIds] = useState<Set<string>>(readExpandedPageIds)
  const [pageDropTarget, setPageDropTarget] = useState<PageTreeDropTarget>()
  const [referenceNavigationTarget, setReferenceNavigationTarget] = useState<NotebookReferenceTarget>()
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

  const visiblePages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const filtered = (activeArea === 'trash' ? accessibleTrashPages : accessiblePages).filter((page) => {
      if (activeArea === 'trash') return !normalized || `${page.title} ${page.preview}`.toLocaleLowerCase().includes(normalized)
      if (activeArea === 'tasks' ? page.kind !== 'task' : page.kind === 'task' || page.sectionId !== activeSection) return false
      if (!normalized) return true
      return `${page.title} ${page.preview} ${page.tags.join(' ')}`.toLocaleLowerCase().includes(normalized)
    })
    return pageSort === 'title' ? [...filtered].sort((left, right) => left.title.localeCompare(right.title, 'zh-CN')) : filtered
  }, [accessiblePages, accessibleTrashPages, activeArea, activeSection, pageSort, query])
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
  const matchingTreeIds = useMemo(() => {
    if (!query.trim()) return undefined
    const normalized = query.trim().toLocaleLowerCase()
    return new Set(accessiblePages.filter((page) => page.kind !== 'task' && `${page.title} ${page.preview} ${page.tags.join(' ')}`.toLocaleLowerCase().includes(normalized)).map((page) => page.id))
  }, [accessiblePages, query])
  const visibleTreePages = useMemo(() => flattenPageTree(sectionPages, expandedPageIds, matchingTreeIds), [expandedPageIds, matchingTreeIds, sectionPages])

  const currentPage = useMemo(() => [...accessiblePages, ...accessibleTrashPages].find((page) => page.id === activePage) ?? accessiblePages[0] ?? accessibleTrashPages[0] ?? emptyPage, [activePage, accessiblePages, accessibleTrashPages])
  const hasCurrentPage = Boolean(currentPage.id)
  const currentDocument = documents[currentPage.id]
  const currentNotebook = notebooks.find((notebook) => notebook.id === activeNotebook) ?? notebooks[0]
  const currentSection = notebooks.flatMap((notebook) => notebook.sections).find((section) => section.id === activeSection)
  const sectionIsEmpty = activeArea === 'notes' && (!currentSection || !accessiblePages.some((page) => page.kind !== 'task' && page.sectionId === activeSection))
  const hasActivePage = hasCurrentPage && (activeArea === 'notes'
    ? accessiblePages.some((page) => page.id === currentPage.id && page.kind !== 'task' && page.sectionId === activeSection)
    : activeArea === 'tasks'
      ? accessiblePages.some((page) => page.id === currentPage.id && page.kind === 'task')
      : accessibleTrashPages.some((page) => page.id === currentPage.id))
  const navigationOpen = navOpen || pagesOpen
  const showNotebookPane = activeArea === 'notes' && navigationOpen
  const showPagePane = activeArea !== 'notes' && navigationOpen
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

  // Opening a note is deliberately local: fetching/pushing on every page
  // switch causes substantial WebDAV traffic for normal navigation.
  useEffect(() => {
    if (!hasCurrentPage) return
    void loadDocument(currentPage.id)
  }, [currentPage.id, hasCurrentPage, loadDocument])
  useEffect(() => () => clearTimeout(documentPrefetchTimer.current), [])
  useEffect(() => {
    clearTimeout(readingPositionTimer.current)
    if (activeArea !== 'notes' || !hasCurrentPage) {
      setLoadedReadingPosition(undefined)
      return
    }
    const pageId = currentPage.id
    const savedPositions = readingPositions.current
    let cancelled = false
    const local = savedPositions.get(pageId)
    setLoadedReadingPosition(local ? { pageId, position: local } : undefined)
    if (!local) void loadReadingPosition(pageId).then((position) => {
      if (cancelled || !position) return
      const restored = { fraction: position.viewportOffsetFraction }
      savedPositions.delete(pageId)
      savedPositions.set(pageId, restored)
      setLoadedReadingPosition({ pageId, position: restored })
    })
    return () => {
      cancelled = true
      clearTimeout(readingPositionTimer.current)
      const position = savedPositions.get(pageId)
      if (!position) return
      writeLocalReadingPositions(savedPositions)
    }
  }, [activeArea, currentPage.id, hasCurrentPage, loadReadingPosition])

  const flushDirtyReadingPositions = useCallback(async () => {
    clearTimeout(readingPositionTimer.current)
    writeLocalReadingPositions(readingPositions.current)
    const dirtyIds = [...dirtyReadingPositionIds.current]
    if (!dirtyIds.length) return
    dirtyReadingPositionIds.current.clear()
    try {
      await Promise.all(dirtyIds.map(async (pageId) => {
        const position = readingPositions.current.get(pageId)
        if (position) await saveReadingPosition(pageId, position.fraction)
      }))
    } catch (error) {
      for (const pageId of dirtyIds) dirtyReadingPositionIds.current.add(pageId)
      throw error
    }
  }, [saveReadingPosition])

  useEffect(() => registerFlushHandler(flushDirtyReadingPositions), [flushDirtyReadingPositions])

  useEffect(() => registerAfterFlushHandler(async () => {
    // Quitting must not strand a durable outbox behind an unbounded network
    // request. A timeout leaves the outbox intact for the next launch.
    let timer: number | undefined
    try {
      await Promise.race([
        syncNow(),
        new Promise<void>((resolve) => { timer = window.setTimeout(resolve, 4_000) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }), [syncNow])

  const backgroundSyncGate = useMemo(() => createBackgroundSyncGate(async () => {
    await flushDirtyReadingPositions()
    await syncNow()
  }), [flushDirtyReadingPositions, syncNow])

  useEffect(() => {
    const onFocus = () => {
      backgroundSyncGate.foreground()
      void syncNow()
    }
    const onBlur = () => { backgroundSyncGate.background() }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') backgroundSyncGate.background()
      else backgroundSyncGate.foreground()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [backgroundSyncGate, syncNow])
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
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify({ navOpen, pagesOpen, aiOpen, rightPanel, notebookWidth, aiWidth }))
  }, [aiOpen, aiWidth, navOpen, notebookWidth, pagesOpen, rightPanel])
  useEffect(() => {
    globalThis.localStorage?.setItem(VIM_MODE_KEY, vimEnabled ? 'true' : 'false')
  }, [vimEnabled])
  useEffect(() => {
    const open = () => { if (hasActivePage && activeArea === 'notes') setReferencePickerOpen(true) }
    window.addEventListener(OPEN_REFERENCE_PICKER_EVENT, open)
    return () => window.removeEventListener(OPEN_REFERENCE_PICKER_EVENT, open)
  }, [activeArea, hasActivePage])

  useEffect(() => {
    if (window.matchMedia('(max-width: 1180px)').matches) setNavOpen(false)
    if (window.matchMedia('(max-width: 680px)').matches) setPagesOpen(false)
  }, [])

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
  useEffect(() => window.notebookDesktop?.events.onUpdateCenter?.(() => {
    setSettingsPage('general')
    setSettingsOpen(true)
  }), [])

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
  })
  const { selectArea, toggleNavigation, openRecentPage, navigatePageHistory, activateTreePage, historyNavigationTarget } = navigation
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

  const trashPage = async (pageId: string, alwaysConfirm = false) => {
    const page = accessiblePages.find((candidate) => candidate.id === pageId)
    if (!page) return
    const backlinks = await loadBacklinks(pageId)
    const referencedBy = new Set(backlinks.map((link) => link.sourcePageId)).size
    const descendantCount = descendantsOf(accessiblePages, pageId).size
    const description = referencedBy > 0
      ? `“${page.title}”被 ${referencedBy} 篇页面引用${descendantCount ? `，并包含 ${descendantCount} 篇子页面` : ''}。移到回收站后，这些位置会显示为失效引用，但恢复页面即可重新生效。仍要继续吗？`
      : descendantCount ? `将“${page.title}”及其 ${descendantCount} 篇子页面一起移到回收站？` : `将“${page.title}”移到回收站？`
    if ((alwaysConfirm || referencedBy > 0) && !(await requestConfirm({ title: '移到回收站', description, confirmLabel: '移到回收站', destructive: true }))) return
    await moveToTrash(pageId)
    if (pageId === currentPage.id) setActivePage(accessiblePages.find((candidate) => candidate.id !== pageId)?.id ?? '')
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
  }
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
    browserFileInput: importInput,
  }), [activeSection, currentPage.id, currentPage.title, documents, exportWorkspace, importFiles, importInput])

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
    selectArea,
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
    })
  }, [accessiblePages, documents, loadDocument, notebooks, pages])

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
      /></Suspense> : <div className={`workspace-grid ${navigationOpen ? '' : 'navigation-collapsed'} ${aiOpen ? '' : 'ai-collapsed'}`} style={{ '--notebook-pane-width': `${notebookWidth}px`, '--ai-pane-width': `${aiWidth}px` } as CSSProperties}>
        <aside className="app-rail" aria-label="主要功能">
          <div className="app-mark" role="img" aria-label="Notebook">N</div>
          <RailButton label={navigationOpen ? '隐藏导航窗格' : '显示导航窗格'} selected={false} pressed={navigationOpen} icon={<Navigation20Regular />} onClick={toggleNavigation} />
          <RailButton label="笔记" selected={activeArea === 'notes'} icon={activeArea === 'notes' ? <Document20Filled /> : <Document20Regular />} onClick={() => selectArea('notes')} />
          <RailButton label="任务" selected={activeArea === 'tasks'} icon={<CheckmarkCircle20Regular />} onClick={() => selectArea('tasks')} />
          <RailButton label="回收站" selected={activeArea === 'trash'} icon={<Delete20Regular />} onClick={() => selectArea('trash')} />
          <span className="rail-spacer" />
          <RailButton buttonRef={settingsTriggerRef} label="设置" selected={settingsOpen} icon={<Settings20Regular />} onClick={() => { setSettingsPage('general'); setSettingsOpen(true) }} />
        </aside>

        {showNotebookPane && (
          <aside className="notebook-pane unified-navigation panel-border" aria-label="文档导航">
            <div className="pane-heading">
              <div><Text size={200}>工作区</Text><Text weight="semibold" size={400}>我的知识库</Text></div>
              <div className="navigation-heading-actions">
                <ActionMenu label="新建" trigger={<Button appearance="subtle" size="small" icon={<Add20Regular />} aria-label="新建" />}>
                  <button disabled={!currentNotebook} onClick={() => { void createTopLevelPage() }}>新建页面</button>
                  <button onClick={() => setCreateRequest('notebook')}>新建笔记本</button>
                </ActionMenu>
                <ActionMenu label="文档树操作" trigger={<Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label="文档树菜单" />}>
                  <button onClick={() => setExpandedPageIds(new Set(accessiblePages.filter((page) => page.kind !== 'task').map((page) => page.id)))}>展开全部页面</button>
                  <button onClick={() => setExpandedPageIds(new Set())}>折叠全部</button>
                  <ActionMenuDivider />
                  <button onClick={() => { setNavOpen(false); setPagesOpen(false) }}>隐藏导航栏</button>
                </ActionMenu>
              </div>
            </div>
            <div className="navigation-search"><Input value={query} onChange={(_, data) => setQuery(data.value)} contentBefore={<Search20Regular />} placeholder="搜索文档树" aria-label="搜索文档树" /></div>
            <nav className="notebook-tree unified-document-tree" role="tree" aria-label="文档树" onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPageDropTarget(undefined) }}>
              {notebooks.map((notebook) => {
                const expanded = expandedNotebook === notebook.id && (!notebook.locked || privacyUnlocked)
                return (
                  <div key={notebook.id} role="treeitem" aria-label={notebook.name} aria-expanded={expanded} aria-level={1}>
                    <ActionMenu openOnContext label={`${notebook.name}笔记本操作`} trigger={<button className={`tree-row notebook-row ${activeNotebook === notebook.id ? 'active-parent' : ''} ${notebook.locked ? 'private-notebook-row' : ''}`} aria-expanded={expanded} aria-label={notebook.locked && !privacyUnlocked ? `${notebook.name}（已锁定）` : notebook.name} onClick={() => {
                      if (notebook.locked && !privacyUnlocked) { requestPrivacyAccess(notebook.id); return }
                      if (expanded && activeNotebook === notebook.id) { setExpandedNotebook(undefined); return }
                      activateNotebook(notebook.id)
                    }}>
                      {expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                      <span>{notebook.emoji}</span><span>{notebook.name}</span>{notebook.locked && <span className="notebook-lock-state" title={privacyUnlocked ? '已解锁' : '已锁定'}>{privacyUnlocked ? <LockOpen20Regular /> : <LockClosed20Regular />}</span>}
                    </button>}>
                      {notebook.locked && !privacyUnlocked ? <button onClick={() => requestPrivacyAccess(notebook.id)}>解锁笔记本</button> : <><button onClick={() => setRenameRequest({ kind: 'notebook', id: notebook.id, name: notebook.name })}>重命名笔记本</button><button onClick={() => { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id); setCreateRequest('rootPage') }}>新建顶层页面</button><ActionMenuDivider /><button className="destructive-menu-item" onClick={() => { void (async () => {
                      if (!(await requestConfirm({ title: `删除笔记本“${notebook.name}”？`, description: '将删除其中全部页面、任务、附件和历史版本，此操作无法撤销。', confirmLabel: '删除笔记本', destructive: true }))) return
                      try {
                        await deleteNotebook(notebook.id)
                      } catch (error) {
                        showToast(error instanceof Error ? error.message : '无法删除笔记本', { kind: 'error' })
                      }
                    })() }}>删除笔记本及全部内容</button></>}
                    </ActionMenu>
                    {expanded && notebook.sections.map((section) => {
                      const pagesInSection = pagesBySection.get(section.id) ?? emptyPageList
                      const treeRows = flattenPageTree(pagesInSection, expandedPageIds, matchingTreeIds)
                      if (treeRows.length === 0) return null
                      return <Fragment key={section.id}>
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
                          onActivate={activateTreePage}
                          onToggleExpanded={togglePageExpanded}
                          onPrefetch={scheduleDocumentPrefetch}
                          onPrefetchStop={stopDocumentPrefetch}
                          onDropPosition={setDropPosition}
                          onDrop={dropPage}
                          onDragEnd={clearDropTarget}
                        />)}
                      </Fragment>
                    })}
                  </div>
                )
              })}
            </nav>
            <PanelResizer label="调整导航栏宽度" value={notebookWidth} min={240} max={520} onChange={setNotebookWidth} resetValue={320} />
          </aside>
        )}

        {showPagePane && <aside className="page-pane panel-border" aria-label="页面列表">
          <div className="page-pane-header">
            <div className="page-title-row"><Text size={500} weight="semibold">{activeArea === 'tasks' ? '所有任务' : activeArea === 'trash' ? '回收站' : currentSection?.name ?? '页面'}</Text><div className="page-header-actions">{activeArea !== 'trash' && currentSection && <Button appearance="subtle" size="small" icon={<Add20Regular />} aria-label={activeArea === 'tasks' ? '新建任务' : '新建顶层页面'} onClick={() => { if (activeArea === 'tasks') void createPage(activeSection, 'task').then(setActivePage); else void createTreePage() }} />}<ActionMenu label="页面列表操作" trigger={<Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label="页面列表菜单" />}>{activeArea === 'notes' ? <><button onClick={() => setExpandedPageIds(new Set(sectionPages.map((page) => page.id)))}>展开全部页面</button><button onClick={() => setExpandedPageIds(new Set())}>折叠全部页面</button></> : <><button onClick={() => setPageSort(pageSort === 'recent' ? 'title' : 'recent')}>{pageSort === 'recent' ? '按标题排序' : '恢复原始顺序'}</button><button onClick={() => setCompactPages((value) => !value)}>{compactPages ? '显示页面摘要' : '使用紧凑列表'}</button></>}<button onClick={() => setPagesOpen(false)}>隐藏页面列表</button></ActionMenu></div></div>
            <Input value={query} onChange={(_, data) => setQuery(data.value)} contentBefore={<Search20Regular />} placeholder={activeArea === 'tasks' ? '搜索任务' : activeArea === 'trash' ? '搜索回收站' : '搜索此分区'} aria-label={activeArea === 'tasks' ? '搜索任务' : activeArea === 'trash' ? '搜索回收站' : '搜索此分区'} />
          </div>
          <div className={`page-list ${compactPages ? 'compact' : ''} ${activeArea === 'notes' ? 'document-tree' : ''}`} role={activeArea === 'notes' ? 'tree' : undefined} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPageDropTarget(undefined) }}>
            {(activeArea === 'notes' ? visibleTreePages.length === 0 : visiblePages.length === 0) && <div className="page-list-empty"><Document20Regular /><strong>{query ? '没有匹配的页面' : activeArea === 'trash' ? '回收站是空的' : '这个分区还没有页面'}</strong><span>{query ? '尝试更短的关键词，或清除搜索条件。' : activeArea === 'trash' ? '删除的页面会临时保存在这里。' : '使用上方按钮创建第一篇内容。'}</span></div>}
            {activeArea === 'notes' ? visibleTreePages.map(({ page, depth, hasChildren }) => (
              <PageTreeRow
                key={page.id}
                page={page}
                depth={depth}
                hasChildren={hasChildren}
                childCount={pageDescendantCounts.get(page.id) ?? 0}
                pagesInSection={sectionPages}
                variant="pages"
                selected={activePage === page.id}
                expanded={expandedPageIds.has(page.id)}
                dropTarget={pageDropTarget?.id === page.id ? pageDropTarget : undefined}
                actions={rowActions}
                onActivate={activateTreePage}
                onToggleExpanded={togglePageExpanded}
                onPrefetch={scheduleDocumentPrefetch}
                onPrefetchStop={stopDocumentPrefetch}
                onDropPosition={setDropPosition}
                onDrop={dropPage}
                onDragEnd={clearDropTarget}
              />
            )) : visiblePages.map((page) => (
              <ActionMenu openOnContext key={page.id} label={`${page.title}页面操作`} trigger={<button className={`page-card ${activePage === page.id ? 'selected' : ''}`} onClick={() => {
                if (activeArea === 'notes') {
                  setActivePage(page.id)
                  setActiveSection(page.sectionId)
                  const owner = notebooks.find((notebook) => notebook.sections.some((section) => section.id === page.sectionId))
                  if (owner) setActiveNotebook(owner.id)
                } else setActivePage(page.id)
                if (window.matchMedia('(max-width: 680px)').matches) setPagesOpen(false)
              }}>
                <div className="page-card-title"><span>{page.title}</span>{page.favorite && <Star16Filled className="favorite" />}</div>
                <p>{page.preview}</p>
                <div className="page-card-meta"><span>{page.updatedLabel}</span><span>{page.tags.slice(0, 2).join(' · ')}</span></div>
              </button>}>
                {activeArea === 'trash' ? <><button onClick={() => void restorePage(page.id)}>恢复页面</button><ActionMenuDivider /><button className="destructive-menu-item" onClick={() => { void (async () => {
                  if (!(await requestConfirm({ title: `永久删除“${page.title}”？`, description: '此操作无法撤销。', confirmLabel: '永久删除', destructive: true }))) return
                  try {
                    await purgePage(page.id)
                  } catch (error) {
                    showToast(error instanceof Error ? error.message : '无法永久删除页面', { kind: 'error' })
                  }
                })() }}>永久删除</button></> : <>
                  {page.kind === 'task' && <button onClick={() => void updatePage(page.id, { completedAt: page.completedAt ? undefined : new Date().toISOString() })}>{page.completedAt ? '重新打开任务' : '标记为已完成'}</button>}
                  {page.kind === 'task' && <button onClick={() => void updatePage(page.id, { important: !page.important })}>{page.important ? '取消重要标记' : '标记为重要'}</button>}
                  {page.kind === 'task' && (page.reminderAt ? <button onClick={() => void updatePage(page.id, { reminderAt: undefined, recurrenceRule: undefined })}>清除提醒</button> : <button onClick={() => void updatePage(page.id, { reminderAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() })}>1 小时后提醒</button>)}
                  {page.kind === 'task' && <ActionMenuDivider />}
                  <button onClick={() => void updatePage(page.id, { favorite: !page.favorite })}>{page.favorite ? '取消收藏' : '收藏'}</button>
                  <button onClick={() => void duplicatePage(page.id).then((id) => { setActivePage(id); if (page.kind === 'document') setActiveSection(page.sectionId) })}>创建副本</button>
                  <button onClick={() => setMovePageRequest(page)}>移动到分区…</button>
                  <ActionMenuDivider />
                  <button className="destructive-menu-item" onClick={() => { void trashPage(page.id, true) }}>移到回收站</button>
                </>}
              </ActionMenu>
            ))}
          </div>
          <PanelResizer label="调整导航栏宽度" value={notebookWidth} min={240} max={520} onChange={setNotebookWidth} resetValue={320} />
        </aside>}

        <main className="content-pane">
          <div className="editor-toolbar">
            <div className="breadcrumb"><span>{activeArea === 'notes' ? currentNotebook?.name ?? '工作区' : '我的知识库'}</span>{activeArea === 'notes' && hasActivePage && currentPageAncestors.map((ancestor) => <Fragment key={ancestor.id}><ChevronRight16Regular /><button className="breadcrumb-page" title={ancestor.title} onClick={() => setActivePage(ancestor.id)}>{ancestor.title}</button></Fragment>)}<ChevronRight16Regular />{activeArea === 'notes' ? hasActivePage ? <Input key={`${currentPage.id}:${currentPage.title}`} className="breadcrumb-title-input" defaultValue={currentPage.title} aria-label="页面标题" onBlur={(event) => { const title = event.currentTarget.value.trim(); if (title && title !== currentPage.title) void updatePage(currentPage.id, { title }) }} /> : <span>未选择页面</span> : <span>{activeArea === 'tasks' ? '所有任务' : '已删除页面'}</span>}</div>
            {activeArea === 'notes' && hasActivePage ? <div className="editor-mode-controls">
              <div className="page-history-controls" role="group" aria-label="笔记浏览历史">
                <Button appearance="subtle" size="small" icon={<ArrowLeft20Regular />} aria-label="后退到上一笔记" title="后退到上一笔记" disabled={!previousPageVisit} onClick={() => navigatePageHistory(-1)} />
                <Button appearance="subtle" size="small" icon={<ArrowRight20Regular />} aria-label="前进到下一笔记" title="前进到下一笔记" disabled={!nextPageVisit} onClick={() => navigatePageHistory(1)} />
              </div>
              <Button className={`vim-toggle ${vimEnabled && vimCommandMode ? 'selected' : ''}`} appearance="subtle" aria-pressed={vimEnabled} size="small" title={vimEnabled ? vimCommandMode ? 'Vim NORMAL：i 进入编辑' : 'Vim INSERT：Esc 返回普通模式' : '启用 Vim 模式'} onClick={() => setVimEnabled((value) => { const next = !value; setVimCommandMode(next); return next })}>Vim</Button>
            </div> : <div className="area-toolbar-label">{activeArea === 'notes' ? '未选择页面' : activeArea === 'tasks' ? `${visiblePages.length} 项任务` : `${accessibleTrashPages.length} 个页面`}</div>}
            <div className="editor-actions">
              {activeArea === 'notes' && !sectionIsEmpty && <><div className="page-utilities"><Suspense fallback={null}><AttachmentPanel pageId={currentPage.id} loadAssets={loadAssets} saveAsset={saveAsset} openAsset={openAsset} /><VersionHistory pageId={currentPage.id} currentMarkdown={documents[currentPage.id] ? documentToMarkdown(documents[currentPage.id]!) : ''} load={loadRevisions} create={async (pageId) => { const current = documents[pageId]; if (current) await saveDocument(pageId, current); return createManualRevision(pageId) }} restore={(revisionId) => restoreRevision(revisionId).then((pageId) => { setRestoreToken(`${pageId}:${Date.now()}`) })} /></Suspense></div><span className="editor-action-divider" /></>}
              <ActionMenu label="同步状态详情" trigger={<Button
                className={`compact-sync-button ${syncState === 'syncing' ? 'syncing' : showSyncCompleted ? 'sync-complete' : syncState === 'synced' ? 'idle' : syncState}`}
                appearance="subtle"
                icon={<span className="sync-visual-icon" aria-hidden="true">{syncState === 'syncing' ? null : showSyncCompleted ? <span className="sync-checkmark">✓</span> : <ArrowSync20Regular />}</span>}
                aria-label={`同步状态：${syncLabels[syncState]}`}
                title={showSyncCompleted ? '同步完成' : syncLabels[syncState]}
              />}>
                <div className="sync-status-detail">
                  <strong>{syncLabels[syncState]}</strong>
                  <span>{syncState === 'offline' ? '尚未配置坚果云 WebDAV 同步，当前修改只保存在本机。' : syncState === 'syncing' ? '正在与坚果云交换最新数据。' : syncState === 'synced' ? '本机与坚果云已完成最近一次同步。' : syncState === 'conflict' ? '检测到多设备同时修改，请打开相关笔记的版本历史处理。' : '最近一次同步没有完成。'}</span>
                  {(syncState === 'error' || syncState === 'conflict') && <code>{syncError ?? (syncState === 'conflict' ? accessiblePages.filter((page) => page.syncStatus === 'conflict').map((page) => page.title).join('、') || '存在尚未处理的同步冲突。' : '没有提供更详细的错误信息。')}</code>}
                </div>
                <ActionMenuDivider />
                <button disabled={syncState === 'syncing'} onClick={() => void syncNow({ force: true })}>{syncState === 'syncing' ? '正在同步…' : '立即同步'}</button>
                <button onClick={() => { setSettingsPage('services'); setSettingsOpen(true) }}>打开同步设置</button>
              </ActionMenu>
              {activeArea === 'notes' && !sectionIsEmpty && <Button appearance="subtle" icon={<Delete20Regular />} aria-label="移到回收站" title="移到回收站" onClick={() => { void trashPage(currentPage.id) }} />}
              <Button appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="进入聚焦模式" title="聚焦页面（F11）" onClick={() => setFocusMode(true)} />
              <ActionMenu label="颜色主题" trigger={<Button appearance="subtle" icon={theme === 'dark' ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />} aria-label="颜色主题" title="颜色主题" />}>
                <button className={themePreference === 'light' ? 'selected' : undefined} onClick={() => onThemePreferenceChange?.('light')}>浅色</button>
                <button className={themePreference === 'dark' ? 'selected' : undefined} onClick={() => onThemePreferenceChange?.('dark')}>深色</button>
                <button className={themePreference === 'system' ? 'selected' : undefined} onClick={() => onThemePreferenceChange?.('system')}>跟随系统</button>
              </ActionMenu>
            </div>
          </div>
          <section className="document-surface">
            {currentPage.syncStatus === 'conflict' && <div className="sync-conflict-banner" role="alert"><strong>检测到其他设备也修改了此笔记</strong><span>当前正文保持本机版本，远端版本已安全保存在“版本”中。继续编辑可保留本机版本；从版本历史恢复远端版本可采用远端内容。</span></div>}
            {activeArea === 'trash' ? (accessibleTrashPages.length ? <div className="trash-detail"><Delete20Regular /><h2>{currentPage.title}</h2><p>页面仍保留在本机，可以恢复到原分区或永久删除。</p><div><Button appearance="primary" onClick={() => { void restorePage(currentPage.id).then(() => { selectArea('notes'); setActivePage(currentPage.id) }) }}>恢复页面</Button><Button appearance="secondary" onClick={() => { void (async () => {
                  if (!(await requestConfirm({ title: `永久删除“${currentPage.title}”？`, description: '永久删除后无法恢复，确定继续吗？', confirmLabel: '永久删除', destructive: true }))) return
                  try {
                    await purgePage(currentPage.id)
                    setActivePage(accessibleTrashPages.find((page) => page.id !== currentPage.id)?.id ?? accessiblePages[0]?.id ?? '')
                  } catch (error) {
                    showToast(error instanceof Error ? error.message : '无法永久删除页面', { kind: 'error' })
                  }
                })() }}>永久删除</Button></div></div> : <ModePlaceholder icon={<Delete20Regular />} title="回收站是空的" description="移到回收站的页面会显示在这里。" />) : activeArea === 'tasks' ? (visiblePages.length ? <Suspense fallback={null}><TaskDetail task={currentPage} loadSteps={loadTaskSteps} saveSteps={saveTaskSteps} updateTask={(patch) => updatePage(currentPage.id, patch)} /></Suspense> : <ModePlaceholder icon={<CheckmarkCircle20Regular />} title="还没有任务" description="创建任务后，可以在这里集中跟踪状态、截止时间和步骤。" {...(currentSection ? { actionLabel: '新建任务', onAction: () => { void createPage(activeSection, 'task').then(setActivePage) } } : {})} />) : !currentSection ? <ModePlaceholder icon={<Document20Regular />} title="工作区是空的" description="新建一个笔记本后，再创建分区和页面。" actionLabel="新建笔记本" onAction={() => setCreateRequest('notebook')} /> : sectionIsEmpty ? <ModePlaceholder icon={<Document20Regular />} title="这个分区还没有页面" description="创建一篇新页面，开始记录会议、想法或资料。" actionLabel="新建页面" onAction={() => { void createPage(activeSection).then(setActivePage) }} /> : !hasActivePage ? <ModePlaceholder icon={<Document20Regular />} title="未选择页面" description="从左侧选择一篇页面，或新建页面开始记录。" /> : <>
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
              onViewportChange={(position) => {
                const pageId = currentPage.id
                readingPositions.current.delete(pageId)
                readingPositions.current.set(pageId, position)
                dirtyReadingPositionIds.current.add(pageId)
                clearTimeout(readingPositionTimer.current)
                readingPositionTimer.current = setTimeout(() => {
                  writeLocalReadingPositions(readingPositions.current)
                }, 350)
              }}
              />
            </>}
            </>}
          </section>
        </main>

        <aside className={`right-sidebar ${aiOpen ? 'open' : 'collapsed'}`} aria-label="右侧工具栏">
          {aiOpen && <div className="right-sidebar-panel">
            <PanelResizer label="调整右侧面板宽度" value={aiWidth} min={280} max={520} onChange={setAiWidth} resetValue={320} side="left" />
            {rightPanel === 'outline' && <Suspense fallback={null}><OutlineSidebar document={documents[currentPage.id]} /></Suspense>}
            {rightPanel === 'backlinks' && <Suspense fallback={null}><BacklinksSidebar pageId={currentPage.id} pages={accessiblePages} load={loadBacklinks} loadMentions={loadUnlinkedMentions} openPage={openRecentPage} refreshKey={referenceIndexRevision} /></Suspense>}
          </div>}
          <nav className="right-sidebar-rail" aria-label="页面辅助工具">
            <Button appearance="subtle" icon={<PanelRight20Regular />} aria-label={aiOpen ? '隐藏右侧面板' : '显示右侧面板'} title={aiOpen ? '隐藏右侧面板' : '显示右侧面板'} aria-pressed={aiOpen} onClick={() => setAiOpen((value) => !value)} />
            <span className="right-sidebar-divider" />
            <Button className={aiOpen && rightPanel === 'outline' ? 'selected' : ''} appearance="subtle" icon={<TextBulletListSquare20Regular />} aria-label="大纲" title="大纲" disabled={!hasActivePage || activeArea !== 'notes'} onClick={() => { setRightPanel('outline'); setAiOpen(true) }} />
            <Button appearance="subtle" icon={<Link20Regular />} aria-label="双链" title="插入双链" disabled={!hasActivePage || activeArea !== 'notes'} onClick={() => setReferencePickerOpen(true)} />
            <Button className={aiOpen && rightPanel === 'backlinks' ? 'selected' : ''} appearance="subtle" icon={<ArrowReply20Regular />} aria-label="引用" title="查看引用" disabled={!hasActivePage || activeArea !== 'notes'} onClick={() => { setRightPanel('backlinks'); setAiOpen(true) }} />
            <Button appearance="subtle" icon={<Bot20Regular />} aria-label="AI" title="打开 AI 工作区" onClick={() => setAiWorkspaceOpen(true)} />
          </nav>
        </aside>
      </div>}
      {focusMode && <Button className="focus-exit" appearance="primary" shape="circular" icon={<FullScreenMinimize20Regular />} aria-label="退出聚焦模式" title="退出聚焦模式（Esc）" onClick={() => setFocusMode(false)} />}
      {settingsOpen && <Suspense fallback={null}><SettingsCenter
        initialPage={settingsPage}
        theme={theme}
        themePreference={themePreference}
        accentColor={accentColor}
        syncState={syncState}
        syncError={syncError}
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
        onImport={() => chooseImport(transferContext)}
        onExportPage={(format) => { void saveCurrentDocument(transferContext, format) }}
        onPrint={() => { setSettingsOpen(false); window.setTimeout(() => window.print(), 0) }}
        onExportWorkspace={() => { void runExport(transferContext).catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '导出失败')) }}
        onExportEncrypted={() => { setSettingsOpen(false); setEncryptedExportOpen(true) }}
        onResetHistory={resetRevisionHistory}
        onChooseDataRoot={window.notebookDesktop ? () => { void window.notebookDesktop?.storage.chooseDataRoot().catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '数据目录更改失败')) } : undefined}
        onPrivacyAction={() => { if (privacyUnlocked) lockPrivacy(); else { setSettingsOpen(false); requestPrivacyAccess() } }}
      /></Suspense>}
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
