import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
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
  Folder20Regular,
  FolderOpen20Regular,
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
  Delete20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
} from '@fluentui/react-icons'
import type { PageSummary } from './model'
import { useWorkspaceData, WORKSPACE_ID } from './data/useWorkspaceData'
import { DocumentEditor } from './editor/DocumentEditor'
import { TaskDetail } from './tasks/TaskDetail'
import { base64ToBytes, bytesToBase64, type ImportFile } from './data/transfer'
import { AttachmentPanel } from './assets/AttachmentPanel'
import { useReminders } from './tasks/useReminders'
import { VersionHistory } from './history/VersionHistory'
import { documentToHtml, documentToMarkdown, htmlToDocument, markdownToDocument } from './editor/extensions'
import { decryptBackup, encryptBackup } from './crypto/encryptedBackup'
import { SettingsCenter } from './settings/SettingsCenter'
import type { AccentColor } from './appearance/accent'
import { configurePrivacyLock, hasPrivacyLock, verifyPrivacyLock } from './crypto/privacyLock'
import { publishPreparedLegacyArchive } from './sync/legacySshSync'
import { ActionMenu, ActionMenuDivider } from './ActionMenu'
import { CommandPalette, type PaletteItem } from './CommandPalette'
import { configureReferenceRuntime } from './editor/referenceRuntime'
import { ReferencePicker } from './editor/ReferencePicker'
import { OPEN_REFERENCE_PICKER_EVENT } from './editor/referenceCommands'
import { BacklinksSidebar } from './editor/BacklinksPanel'
import { OutlineSidebar } from './editor/OutlinePanel'
import { ancestorsOf, descendantsOf, flattenPageTree } from './pageTree'
import { useAbcInputSourceForVimNormal } from './editor/vimInputSource'
import { referenceTargetElement } from './editor/referenceContent'
import { ReferenceHelpDialog } from './editor/ReferenceHelpDialog'
import type { NotebookReferenceTarget } from '@notebook/sync-contract'
import { findQuickCaptureTarget } from './workspaceNavigation'
import { emptyPageVisitHistory, pageVisitTarget, recordPageVisit } from './pageVisitHistory'
import { installRendererDiagnostics, recordDiagnosticEvent } from './diagnostics/diagnostics'
import { useAutomationBridge } from './automation/automationBridge'
import { AIWorkspace } from './ai-workspace/AIWorkspace'

const syncLabels = { offline: '仅保存在本机', syncing: '正在同步', synced: '同步完成', conflict: '同步冲突', error: '同步失败' } as const
const emptyPage: PageSummary = { id: '', sectionId: '', title: '未选择页面', preview: '', updatedLabel: '', tags: [], kind: 'document' }
type RightPanel = 'outline' | 'backlinks'
type ViewportPosition = { scrollTop?: number; fraction: number }
const LOCAL_READING_POSITIONS_KEY = 'notebook-local-reading-positions-v1'

export interface AppProps {
  theme?: 'light' | 'dark'
  accentColor?: AccentColor
  onAccentColorChange?: (color: AccentColor) => void
  onToggleTheme?: () => void
}

export function App({ theme = 'light', accentColor = 'purple', onAccentColorChange, onToggleTheme }: AppProps) {
  const { notebooks, pages, trashPages, documents, referenceIndexRevision, syncState, syncError, syncNow, reloadWorkspace, loadDocument, saveDocument, stageDocument, loadBacklinks, loadUnlinkedMentions, createPage, createNotebook, createSection, renameNotebook, deleteNotebook, duplicatePage, updatePage, movePageInTree, promotePageToNotebookRoot, reorderNotebookRoot, loadTaskSteps, saveTaskSteps, importFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, moveToTrash, restorePage, purgePage, loadRevisions, createManualRevision, resetRevisionHistory, restoreRevision, loadReadingPosition, saveReadingPosition } = useWorkspaceData()
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
  const documentPrefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const readingPositions = useRef(new Map<string, ViewportPosition>(Object.entries(readLocalReadingPositions())))
  const [loadedReadingPosition, setLoadedReadingPosition] = useState<{ pageId: string; position: ViewportPosition }>()
  const [activeArea, setActiveArea] = useState('notes')
  const [activeNotebook, setActiveNotebook] = useState('team')
  const [expandedNotebook, setExpandedNotebook] = useState<string | undefined>('team')
  const [activeSection, setActiveSection] = useState('product')
  const [activePage, setActivePage] = useState(() => new URLSearchParams(location.hash.slice(1)).get('page') ?? 'vision')
  const [pageHistory, setPageHistory] = useState(emptyPageVisitHistory)
  const historyNavigationTarget = useRef<string | undefined>(undefined)

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
  const [pageDropTarget, setPageDropTarget] = useState<{ id: string; position: 'before' | 'inside' | 'after' }>()
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
  const sectionPages = useMemo(() => accessiblePages.filter((page) => page.kind !== 'task' && page.sectionId === activeSection), [accessiblePages, activeSection])
  const matchingTreeIds = useMemo(() => {
    if (!query.trim()) return undefined
    const normalized = query.trim().toLocaleLowerCase()
    return new Set(accessiblePages.filter((page) => page.kind !== 'task' && `${page.title} ${page.preview} ${page.tags.join(' ')}`.toLocaleLowerCase().includes(normalized)).map((page) => page.id))
  }, [accessiblePages, query])
  const visibleTreePages = useMemo(() => flattenPageTree(sectionPages, expandedPageIds, matchingTreeIds), [expandedPageIds, matchingTreeIds, sectionPages])

  const currentPage = [...accessiblePages, ...accessibleTrashPages].find((page) => page.id === activePage) ?? accessiblePages[0] ?? accessibleTrashPages[0] ?? emptyPage
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

  useEffect(() => { if (hasCurrentPage) void loadDocument(currentPage.id) }, [currentPage.id, hasCurrentPage, loadDocument])
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
      void saveReadingPosition(pageId, position.fraction)
    }
  }, [activeArea, currentPage.id, hasCurrentPage, loadReadingPosition, saveReadingPosition])
  useEffect(() => {
    if (activeArea !== 'notes' || !hasCurrentPage || currentPage.kind === 'task') return
    if (historyNavigationTarget.current === currentPage.id) {
      historyNavigationTarget.current = undefined
      return
    }
    setPageHistory((history) => recordPageVisit(history, currentPage.id))
  }, [activeArea, currentPage.id, currentPage.kind, hasCurrentPage])
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

  const runImport = async (files: ImportFile[]) => {
    try {
      const encryptedIndex = files.findIndex((file) => file.name.toLocaleLowerCase().endsWith('.nbx'))
      if (encryptedIndex >= 0) {
        const file = files[encryptedIndex]!
        setEncryptedImportRequest({ file, rest: files.filter((_, index) => index !== encryptedIndex) })
        return
      }
      const count = await importFiles(files, activeSection)
      setTransferMessage(`已导入 ${count} 个页面`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '导入失败'
      setTransferMessage(message)
      recordDiagnosticEvent({ level: 'error', category: 'data', action: 'import', status: 'failed', message })
    }
  }

  const chooseImport = () => {
    if (window.notebookDesktop) {
      void window.notebookDesktop.files.pickOpen().then((files) => runImport(files.map((file) => ({ name: file.name, data: base64ToBytes(file.dataBase64) }))))
    } else importInput.current?.click()
  }

  const runExport = async () => {
    const data = await exportWorkspace()
    const name = `notebook-next-${new Date().toISOString().slice(0, 10)}.zip`
    if (window.notebookDesktop) {
      const saved = await window.notebookDesktop.files.pickSave(name, bytesToBase64(data))
      setTransferMessage(saved ? '备份已导出' : undefined)
      recordDiagnosticEvent({ level: 'info', category: 'data', action: 'save-export', status: saved ? 'success' : 'cancelled' })
      return
    }
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: name })
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    setTransferMessage('备份已导出')
  }

  const runEncryptedExport = async (passphrase: string) => {
    const data = await encryptBackup(await exportWorkspace(), passphrase)
    const name = `notebook-next-${new Date().toISOString().slice(0, 10)}.nbx`
    if (window.notebookDesktop) {
      const saved = await window.notebookDesktop.files.pickSave(name, bytesToBase64(data))
      if (!saved) {
        recordDiagnosticEvent({ level: 'info', category: 'data', action: 'encrypted-export', status: 'cancelled' })
        return
      }
    }
    else { const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' })); Object.assign(window.document.createElement('a'), { href: url, download: name }).click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000) }
    setTransferMessage('加密备份已导出')
    recordDiagnosticEvent({ level: 'info', category: 'data', action: 'encrypted-export', status: 'success' })
  }

  const saveCurrentDocument = async (format: 'md' | 'html') => {
    const documentJson = documents[currentPage.id] ?? { type: 'doc', content: [{ type: 'paragraph' }] }
    const text = format === 'md' ? documentToMarkdown(documentJson) : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(currentPage.title)}</title><style>body{max-width:820px;margin:40px auto;font:16px/1.7 system-ui}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}</style><body><h1>${escapeHtml(currentPage.title)}</h1>${documentToHtml(documentJson)}</body></html>`
    const bytes = new TextEncoder().encode(text)
    const filename = `${currentPage.title.replace(/[\\/:*?"<>|]/g, '_')}.${format}`
    if (window.notebookDesktop) await window.notebookDesktop.files.pickSave(filename, bytesToBase64(bytes))
    else { const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: format === 'md' ? 'text/markdown' : 'text/html' })); Object.assign(window.document.createElement('a'), { href: url, download: filename }).click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000) }
  }

  const selectArea = (area: 'notes' | 'tasks' | 'trash') => {
    setActiveArea(area)
    setQuery('')
    if (area === 'notes') {
      const firstPage = accessiblePages.find((page) => page.kind !== 'task' && page.sectionId === activeSection)
      if (firstPage) setActivePage(firstPage.id)
      return
    }
    if (area === 'tasks') {
      setPagesOpen(true)
      const firstTask = accessiblePages.find((page) => page.kind === 'task')
      if (firstTask) setActivePage(firstTask.id)
      return
    }
    setPagesOpen(true)
    if (accessibleTrashPages[0]) setActivePage(accessibleTrashPages[0].id)
  }

  const toggleNavigation = () => {
    if (navigationOpen) {
      setNavOpen(false)
      setPagesOpen(false)
      return
    }
    setPagesOpen(true)
    if (activeArea === 'notes') setNavOpen(true)
  }

  const openRecentPage = (pageId: string) => {
    const page = accessiblePages.find((candidate) => candidate.id === pageId)
    if (!page) return
    const notebook = notebooks.find((candidate) => candidate.sections.some((section) => section.id === page.sectionId))
    setActiveArea('notes')
    setActivePage(page.id)
    setActiveSection(page.sectionId)
    if (notebook) { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id) }
  }

  const navigatePageHistory = (direction: -1 | 1) => {
    const result = pageVisitTarget(pageHistory, direction, (pageId) => accessibleDocumentPageIds.has(pageId))
    if (!result.pageId) return
    historyNavigationTarget.current = result.pageId
    setPageHistory(result.history)
    openRecentPage(result.pageId)
  }

  const togglePageExpanded = (pageId: string) => {
    const collapsing = expandedPageIds.has(pageId)
    const descendants = descendantsOf(accessiblePages, pageId)
    if (collapsing && descendants.has(activePage)) setActivePage(pageId)
    setExpandedPageIds((current) => {
      const next = new Set(current)
      if (next.has(pageId)) {
        next.delete(pageId)
        // Descendant expansion state is not useful while its ancestor is
        // collapsed and was the source of the former top-level re-open race.
        for (const id of descendants) next.delete(id)
      }
      else next.add(pageId)
      return next
    })
  }

  const createTreePage = async (parentPageId?: string) => {
    const sectionId = parentPageId
      ? accessiblePages.find((page) => page.id === parentPageId)?.sectionId
      : currentSection?.id
    if (!sectionId) return
    const id = await createPage(sectionId, 'document', parentPageId)
    setActiveSection(sectionId)
    if (parentPageId) setExpandedPageIds((current) => new Set([...current, parentPageId]))
    setActivePage(id)
  }

  const createTopLevelPage = async (name = '无标题页面') => {
    if (!currentNotebook) return
    const created = await createSection(currentNotebook.id, name)
    setActiveNotebook(currentNotebook.id)
    setExpandedNotebook(currentNotebook.id)
    setActiveSection(created.sectionId)
    setActivePage(created.pageId)
  }

  const setDropPosition = (event: ReactDragEvent<HTMLElement>, pageId: string) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height)
    setPageDropTarget({ id: pageId, position: ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside' })
  }

  const movePageRelative = async (sourceId: string, target: PageSummary, position: 'before' | 'inside' | 'after') => {
    if (!sourceId || sourceId === target.id) return
    const source = accessiblePages.find((page) => page.id === sourceId)
    if (!source || descendantsOf(accessiblePages, sourceId).has(target.id)) return
    const targetOwner = notebooks.find((notebook) => notebook.sections.some((section) => section.id === target.sectionId))
    if (source.notebookRoot && target.notebookRoot && position !== 'inside') {
      const sectionId = await reorderNotebookRoot(sourceId, target.id, position)
      if (sectionId) setActiveSection(sectionId)
      if (targetOwner) { setActiveNotebook(targetOwner.id); setExpandedNotebook(targetOwner.id) }
      return
    }
    if (!source.notebookRoot && target.notebookRoot && position !== 'inside') {
      const sectionId = await promotePageToNotebookRoot(sourceId, target.id, position)
      setActiveSection(sectionId)
      if (targetOwner) { setActiveNotebook(targetOwner.id); setExpandedNotebook(targetOwner.id) }
      return
    }
    const parentPageId = position === 'inside' ? target.id : target.parentPageId
    const sectionId = target.sectionId
    const siblings = accessiblePages
      .filter((page) => page.kind !== 'task' && page.sectionId === sectionId && page.parentPageId === parentPageId && page.id !== sourceId)
      .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.title.localeCompare(right.title, 'zh-CN'))
    let sortOrder: number
    if (position === 'inside') {
      sortOrder = Math.max(0, ...siblings.map((page) => page.sortOrder ?? 0)) + 1000
    } else {
      const targetIndex = siblings.findIndex((page) => page.id === target.id)
      const insertionIndex = Math.max(0, targetIndex + (position === 'after' ? 1 : 0))
      const previous = siblings[insertionIndex - 1]?.sortOrder
      const next = siblings[insertionIndex]?.sortOrder
      sortOrder = previous !== undefined && next !== undefined ? (previous + next) / 2
        : previous !== undefined ? previous + 1000
          : next !== undefined ? next - 1000
            : 1000
    }
    await movePageInTree(sourceId, sectionId, parentPageId, sortOrder)
    if (parentPageId) setExpandedPageIds((current) => new Set([...current, parentPageId!]))
    setActiveSection(sectionId)
    if (targetOwner) { setActiveNotebook(targetOwner.id); setExpandedNotebook(targetOwner.id) }
  }

  const dropPage = async (event: ReactDragEvent<HTMLElement>, target: PageSummary) => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData(PAGE_TREE_DRAG_TYPE)
    const position = pageDropTarget?.id === target.id ? pageDropTarget.position : 'inside'
    setPageDropTarget(undefined)
    await movePageRelative(sourceId, target, position)
  }

  const trashPage = async (pageId: string, alwaysConfirm = false) => {
    const page = accessiblePages.find((candidate) => candidate.id === pageId)
    if (!page) return
    const backlinks = await loadBacklinks(pageId)
    const referencedBy = new Set(backlinks.map((link) => link.sourcePageId)).size
    const descendantCount = descendantsOf(accessiblePages, pageId).size
    const description = referencedBy > 0
      ? `“${page.title}”被 ${referencedBy} 篇页面引用${descendantCount ? `，并包含 ${descendantCount} 篇子页面` : ''}。移到回收站后，这些位置会显示为失效引用，但恢复页面即可重新生效。仍要继续吗？`
      : descendantCount ? `将“${page.title}”及其 ${descendantCount} 篇子页面一起移到回收站？` : `将“${page.title}”移到回收站？`
    if ((alwaysConfirm || referencedBy > 0) && !window.confirm(description)) return
    await moveToTrash(pageId)
    if (pageId === currentPage.id) setActivePage(accessiblePages.find((candidate) => candidate.id !== pageId)?.id ?? '')
  }

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
    const section = notebook.sections[0]
    if (!section) return
    setActiveSection(section.id)
    const page = pages.find((candidate) => candidate.kind !== 'task' && candidate.sectionId === section.id)
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

  const searchPalettePageIds = useCallback(async (searchTerm: string) => (
    await searchWorkspace(searchTerm, 50, privacyUnlocked)
  ).map((page) => page.id), [privacyUnlocked, searchWorkspace])

  const paletteItems = (() => {
    const commands: Array<PaletteItem | false | undefined> = [
      currentSection && activeArea === 'notes' && { id: 'command:new-page', group: 'command', title: '新建页面', subtitle: currentSection.name, keywords: '笔记 新建 markdown', run: () => { void createPage(currentSection.id).then(setActivePage) } },
      currentSection && activeArea === 'notes' && { id: 'command:daily-note', group: 'command', title: '打开今天的日记', subtitle: '同一天只创建一篇', keywords: '每日笔记 日记 journal daily', run: () => { void openDailyNote() } },
      currentSection && activeArea === 'notes' && { id: 'command:template-meeting', group: 'command', title: '从模板新建会议记录', subtitle: '议题、结论、行动项', keywords: '模板 template meeting', run: () => { void createPageFromMarkdown('会议记录', `## 会议信息

- 时间：
- 参与人：

## 议题


## 结论


## 行动项

- [ ]
`) } },
      currentSection && activeArea === 'notes' && { id: 'command:template-project', group: 'command', title: '从模板新建项目计划', subtitle: '目标、里程碑、风险与任务', keywords: '模板 template project', run: () => { void createPageFromMarkdown('项目计划', `## 目标


## 里程碑

- [ ]

## 风险


## 下一步

- [ ]
`) } },
      currentSection && activeArea === 'notes' && { id: 'command:web-clip', group: 'command', title: '从剪贴板剪藏网页', subtitle: '保留正文结构，移除网页字体、颜色和布局', keywords: '网页剪藏 clipboard html markdown', run: () => { void clipFromClipboard() } },
      currentSection && { id: 'command:new-task', group: 'command', title: '新建任务', subtitle: currentSection.name, keywords: '待办 todo', run: () => { selectArea('tasks'); void createPage(currentSection.id, 'task').then(setActivePage) } },
      { id: 'command:new-notebook', group: 'command', title: '新建笔记本', keywords: '工作区', run: () => setCreateRequest('notebook') },
      currentNotebook && (!currentNotebook.locked || privacyUnlocked) && { id: 'command:new-section', group: 'command', title: '新建顶层页面', subtitle: currentNotebook.name, keywords: '根页面 文件夹 分类', run: () => setCreateRequest('rootPage') },
      { id: 'command:sync', group: 'command', title: syncState === 'syncing' ? '正在同步' : '立即同步', subtitle: syncLabels[syncState], keywords: 'ssh sftp 服务器 推送 拉取', run: () => { if (syncState !== 'syncing') void syncNow({ force: true }) } },
      { id: 'command:notes', group: 'command', title: '打开笔记', keywords: '页面', run: () => selectArea('notes') },
      { id: 'command:tasks', group: 'command', title: '打开任务', keywords: '待办 todo', run: () => selectArea('tasks') },
      { id: 'command:trash', group: 'command', title: '打开回收站', keywords: '删除 恢复', run: () => selectArea('trash') },
      { id: 'command:reference-help', group: 'command', title: '双链使用说明', subtitle: '页面链接、块引用与内容嵌入', keywords: '双链 双链说明 使用说明 帮助 教程 双向链接 wiki link backlink 引用 嵌入 [[', run: () => setReferenceHelpOpen(true) },
      hasActivePage && activeArea === 'notes' && { id: 'command:vim', group: 'command', title: vimEnabled ? '关闭 Vim 模式' : '启用 Vim 模式', keywords: 'normal insert esc', run: () => setVimEnabled((value) => !value) },
      { id: 'command:navigation', group: 'command', title: navigationOpen ? '隐藏导航窗格' : '显示导航窗格', keywords: '侧栏 左侧', run: toggleNavigation },
      { id: 'command:ai', group: 'command', title: '打开 AI 工作区', subtitle: '审阅全部笔记变化、逐行差异和 AI 对话', keywords: '智能 总结 修改 对比 @', run: () => setAiWorkspaceOpen(true) },
      hasActivePage && activeArea === 'notes' && { id: 'command:focus', group: 'command', title: focusMode ? '退出聚焦模式' : '进入聚焦模式', keywords: '全屏 最大化', run: () => setFocusMode((value) => !value) },
      { id: 'command:settings', group: 'command', title: '打开设置', keywords: '偏好 配置', run: () => { setSettingsPage('general'); setSettingsOpen(true) } },
      { id: 'command:import', group: 'command', title: '导入文件或备份', keywords: '迁移 markdown zip nbx', run: chooseImport },
      { id: 'command:export', group: 'command', title: '导出完整备份', keywords: '备份 zip', run: () => { void runExport() } },
      hasActivePage && activeArea !== 'trash' && { id: 'command:delete-page', group: 'command', title: '将当前页面移到回收站', subtitle: currentPage.title, keywords: '删除 笔记 任务', dangerous: true, confirmDescription: `“${currentPage.title}”将移到回收站；如果其他页面引用了它，引用位置会显示失效提示。之后仍可恢复。`, confirmLabel: '移到回收站', run: () => { void trashPage(currentPage.id) } },
      hasActivePage && activeArea === 'trash' && { id: 'command:restore-page', group: 'command', title: '恢复当前页面', subtitle: currentPage.title, keywords: '撤销 删除', run: () => { void restorePage(currentPage.id).then(() => { selectArea('notes'); setActivePage(currentPage.id) }) } },
      hasActivePage && activeArea === 'trash' && { id: 'command:purge-page', group: 'command', title: '永久删除当前页面', subtitle: currentPage.title, keywords: '彻底 清除', dangerous: true, confirmDescription: `“${currentPage.title}”及其历史和附件引用将被永久删除，无法恢复。`, confirmLabel: '永久删除', run: () => { void purgePage(currentPage.id).then(() => setActivePage(accessibleTrashPages.find((page) => page.id !== currentPage.id)?.id ?? accessiblePages[0]?.id ?? '')) } },
      currentNotebook && activeArea === 'notes' && (!currentNotebook.locked || privacyUnlocked) && { id: 'command:delete-notebook', group: 'command', title: '删除当前笔记本及全部内容', subtitle: currentNotebook.name, keywords: '工作区 永久', dangerous: true, confirmDescription: `“${currentNotebook.name}”中的全部分区、页面、任务、附件和历史版本都会被删除，无法撤销。`, confirmLabel: '删除整个笔记本', run: () => { void deleteNotebook(currentNotebook.id) } },
    ]
    const recentOrder = new Map([...recentPageIds].reverse().map((id, index) => [id, index]))
    const pageItems = [...accessiblePages].sort((left, right) => (recentOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (recentOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)).map<PaletteItem>((page) => ({
      id: `page:${page.id}`,
      group: 'page',
      title: page.title,
      subtitle: `${page.kind === 'task' ? '任务' : '页面'} · ${notebooks.flatMap((notebook) => notebook.sections).find((section) => section.id === page.sectionId)?.name ?? '未分类'}`,
      keywords: `${page.preview} ${page.tags.join(' ')}`,
      recent: recentOrder.has(page.id),
      run: () => {
        if (page.kind === 'task') { setActiveArea('tasks'); setActivePage(page.id); setPagesOpen(true) }
        else openRecentPage(page.id)
      },
    }))
    const openSettings = (page: 'general' | 'data' | 'services') => { setSettingsPage(page); setSettingsOpen(true) }
    const settings: PaletteItem[] = [
      { id: 'setting:general', group: 'setting', title: '常规设置', subtitle: '外观、主题和工作状态', keywords: '颜色 深色 浅色 快速记录', run: () => openSettings('general') },
      { id: 'setting:updates', group: 'setting', title: '检查应用更新', subtitle: '从 GitHub Release 检查 macOS、Windows 或 Linux 新版本', keywords: '升级 版本 release github update', run: () => { openSettings('general'); window.setTimeout(() => { void window.notebookDesktop?.updates.check() }, 0) } },
      { id: 'setting:data', group: 'setting', title: '数据与备份', subtitle: '导入、导出和数据目录', keywords: '迁移 markdown html pdf nbx zip', run: () => openSettings('data') },
      { id: 'setting:sync', group: 'setting', title: '同步与连接', subtitle: 'SSH/SFTP 服务器设置', keywords: '远端 地址 端口 密码 主机指纹 android', run: () => openSettings('services') },
      { id: 'setting:privacy', group: 'setting', title: '隐私笔记本', subtitle: '解锁、密码与加密说明', keywords: '安全 锁定 AES', run: () => openSettings('services') },
      { id: 'setting:ai', group: 'setting', title: 'AI 与协作服务', subtitle: '查看本机服务状态', keywords: '智能 hocuspocus yjs', run: () => openSettings('services') },
    ]
    return [...commands.filter((item): item is PaletteItem => Boolean(item)), ...pageItems, ...settings]
  })()

  const scheduleDocumentPrefetch = (pageId: string, delay = 160) => {
    clearTimeout(documentPrefetchTimer.current)
    if (documents[pageId]) return
    documentPrefetchTimer.current = setTimeout(() => { void loadDocument(pageId) }, delay)
  }

  const renderTreePage = (page: PageSummary, depth: number, hasChildren: boolean, pagesInSection: PageSummary[]) => (
    <ActionMenu openOnContext key={page.id} label={`${page.title}页面操作`} trigger={<div
      role="treeitem"
      tabIndex={0}
      aria-level={depth + 2}
      aria-selected={activePage === page.id}
      aria-expanded={hasChildren ? expandedPageIds.has(page.id) : undefined}
      draggable
      className={`page-tree-row unified-page-row ${activePage === page.id ? 'selected' : ''} ${pageDropTarget?.id === page.id ? `drop-${pageDropTarget.position}` : ''}`}
      style={{ '--page-depth': depth } as CSSProperties}
      onPointerEnter={() => scheduleDocumentPrefetch(page.id)}
      onPointerLeave={() => clearTimeout(documentPrefetchTimer.current)}
      onFocus={() => scheduleDocumentPrefetch(page.id, 0)}
      onClick={() => {
        setActivePage(page.id)
        setActiveSection(page.sectionId)
        const owner = notebooks.find((notebook) => notebook.sections.some((section) => section.id === page.sectionId))
        if (owner) { setActiveNotebook(owner.id); setExpandedNotebook(owner.id) }
        if (window.matchMedia('(max-width: 680px)').matches) { setNavOpen(false); setPagesOpen(false) }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActivePage(page.id) }
        if (event.key === 'ArrowRight' && hasChildren && !expandedPageIds.has(page.id)) { event.preventDefault(); togglePageExpanded(page.id) }
        if (event.key === 'ArrowLeft' && hasChildren && expandedPageIds.has(page.id)) { event.preventDefault(); togglePageExpanded(page.id) }
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(PAGE_TREE_DRAG_TYPE, page.id)
      }}
      onDragOver={(event) => setDropPosition(event, page.id)}
      onDrop={(event) => { void dropPage(event, page) }}
      onDragEnd={() => setPageDropTarget(undefined)}
    >
      <button type="button" className={`page-tree-toggle ${hasChildren ? '' : 'empty'}`} tabIndex={-1} aria-label={hasChildren ? expandedPageIds.has(page.id) ? '折叠子页面' : '展开子页面' : undefined} onClick={(event) => { event.stopPropagation(); if (hasChildren) togglePageExpanded(page.id) }}>{hasChildren ? expandedPageIds.has(page.id) ? <ChevronDown16Regular /> : <ChevronRight16Regular /> : <span />}</button>
      <PageTreeIconButton page={page} hasChildren={hasChildren} expanded={expandedPageIds.has(page.id)} onChange={() => setIconPickerPage(page)} />
      <span className="page-tree-title" title={page.title}>{page.title || '无标题页面'}</span>
      {page.favorite && <Star16Filled className="favorite" />}
      {hasChildren && <span className="page-tree-child-count">{descendantsOf(pagesInSection, page.id).size}</span>}
    </div>}>
      <button onClick={() => { void createTreePage(page.id) }}>新建子页面</button>
      <button onClick={() => {
        if (page.notebookRoot) {
          setActiveNotebook(notebooks.find((notebook) => notebook.sections.some((section) => section.id === page.sectionId))?.id ?? activeNotebook)
          setCreateRequest('rootPage')
        } else void createTreePage(page.parentPageId)
      }}>新建同级页面</button>
      <ActionMenuDivider />
      <button onClick={() => setIconPickerPage(page)}>更换图标…</button>
      {page.icon && <button onClick={() => void updatePage(page.id, { icon: undefined })}>恢复默认图标</button>}
      <button onClick={() => void updatePage(page.id, { favorite: !page.favorite })}>{page.favorite ? '取消收藏' : '收藏'}</button>
      {!page.notebookRoot && <button onClick={() => void duplicatePage(page.id).then((id) => { setActivePage(id); setActiveSection(page.sectionId) })}>创建副本</button>}
      {page.parentPageId && <button onClick={() => {
        void promotePageToNotebookRoot(page.id).then((sectionId) => {
          setActivePage(page.id)
          setActiveSection(sectionId)
        })
      }}>提升为顶层页面</button>}
      <button onClick={() => setMovePageRequest(page)}>移动到…</button>
      <ActionMenuDivider />
      <button className="destructive-menu-item" onClick={() => { void trashPage(page.id, true) }}>移到回收站</button>
    </ActionMenu>
  )

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <input ref={importInput} hidden type="file" accept=".md,.markdown,.txt,.html,.htm,.json,.zip,.nbx,application/json,application/zip" multiple onChange={(event) => { const selected = [...(event.target.files ?? [])]; void Promise.all(selected.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))).then(runImport); event.target.value = '' }} />
      {aiWorkspaceOpen ? <AIWorkspace
        currentPage={currentPage}
        pages={accessiblePages.filter((page) => page.kind !== 'task')}
        trashPages={accessibleTrashPages}
        notebooks={notebooks.filter((notebook) => !notebook.locked || privacyUnlocked)}
        proposals={publicAutomationProposals}
        documents={documents}
        privacyUnlocked={privacyUnlocked}
        loadDocument={loadDocument}
        loadAssets={loadAssets}
        onClose={() => setAiWorkspaceOpen(false)}
        onOpenPage={(pageId) => {
          setAiWorkspaceOpen(false)
          openRecentPage(pageId)
        }}
        onCreateWriteback={createAutomationWriteback}
        onCreateAgentProposal={createAutomationAgentProposal}
        onApplyProposal={applyAutomationProposal}
        onRejectProposal={rejectAutomationProposal}
      /> : <div className={`workspace-grid ${navigationOpen ? '' : 'navigation-collapsed'} ${aiOpen ? '' : 'ai-collapsed'}`} style={{ '--notebook-pane-width': `${notebookWidth}px`, '--ai-pane-width': `${aiWidth}px` } as CSSProperties}>
        <aside className="app-rail" aria-label="主要功能">
          <div className="app-mark" role="img" aria-label="Notebook">N</div>
          <RailButton label={navigationOpen ? '隐藏导航窗格' : '显示导航窗格'} selected={false} pressed={navigationOpen} icon={<Navigation20Regular />} onClick={toggleNavigation} />
          <RailButton label="笔记" selected={activeArea === 'notes'} icon={activeArea === 'notes' ? <Document20Filled /> : <Document20Regular />} onClick={() => selectArea('notes')} />
          <RailButton label="任务" selected={activeArea === 'tasks'} icon={<CheckmarkCircle20Regular />} onClick={() => selectArea('tasks')} />
          <RailButton label="回收站" selected={activeArea === 'trash'} icon={<Delete20Regular />} onClick={() => selectArea('trash')} />
          <span className="rail-spacer" />
          <RailButton label="设置" selected={settingsOpen} icon={<Settings20Regular />} onClick={() => { setSettingsPage('general'); setSettingsOpen(true) }} />
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
                      {notebook.locked && !privacyUnlocked ? <button onClick={() => requestPrivacyAccess(notebook.id)}>解锁笔记本</button> : <><button onClick={() => setRenameRequest({ kind: 'notebook', id: notebook.id, name: notebook.name })}>重命名笔记本</button><button onClick={() => { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id); setCreateRequest('rootPage') }}>新建顶层页面</button><ActionMenuDivider /><button className="destructive-menu-item" onClick={() => { if (window.confirm(`删除笔记本“${notebook.name}”及其中全部页面、任务、附件和历史版本？此操作无法撤销。`)) void deleteNotebook(notebook.id).catch((error: unknown) => window.alert(error instanceof Error ? error.message : '无法删除笔记本')) }}>删除笔记本及全部内容</button></>}
                    </ActionMenu>
                    {expanded && notebook.sections.map((section) => {
                      const pagesInSection = accessiblePages.filter((page) => page.kind !== 'task' && page.sectionId === section.id)
                      const treeRows = flattenPageTree(pagesInSection, expandedPageIds, matchingTreeIds)
                      if (treeRows.length === 0) return null
                      return <Fragment key={section.id}>
                        {treeRows.map(({ page, depth, hasChildren }) => renderTreePage(page, depth, hasChildren, pagesInSection))}
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
              <ActionMenu openOnContext key={page.id} label={`${page.title}页面操作`} trigger={<div
                role="treeitem"
                tabIndex={0}
                aria-level={depth + 1}
                aria-selected={activePage === page.id}
                aria-expanded={hasChildren ? expandedPageIds.has(page.id) : undefined}
                draggable
                className={`page-tree-row ${activePage === page.id ? 'selected' : ''} ${pageDropTarget?.id === page.id ? `drop-${pageDropTarget.position}` : ''}`}
                style={{ '--page-depth': depth } as CSSProperties}
                onPointerEnter={() => scheduleDocumentPrefetch(page.id)}
                onPointerLeave={() => clearTimeout(documentPrefetchTimer.current)}
                onFocus={() => scheduleDocumentPrefetch(page.id, 0)}
                onClick={() => {
                  setActivePage(page.id)
                  setActiveSection(page.sectionId)
                  const owner = notebooks.find((notebook) => notebook.sections.some((section) => section.id === page.sectionId))
                  if (owner) setActiveNotebook(owner.id)
                  if (window.matchMedia('(max-width: 680px)').matches) setPagesOpen(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActivePage(page.id) }
                  if (event.key === 'ArrowRight' && hasChildren && !expandedPageIds.has(page.id)) { event.preventDefault(); togglePageExpanded(page.id) }
                  if (event.key === 'ArrowLeft' && hasChildren && expandedPageIds.has(page.id)) { event.preventDefault(); togglePageExpanded(page.id) }
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(PAGE_TREE_DRAG_TYPE, page.id)
                }}
                onDragOver={(event) => setDropPosition(event, page.id)}
                onDrop={(event) => { void dropPage(event, page) }}
                onDragEnd={() => setPageDropTarget(undefined)}
              >
                <button type="button" className={`page-tree-toggle ${hasChildren ? '' : 'empty'}`} tabIndex={-1} aria-label={expandedPageIds.has(page.id) ? '折叠子页面' : '展开子页面'} onClick={(event) => { event.stopPropagation(); if (hasChildren) togglePageExpanded(page.id) }}>{hasChildren ? expandedPageIds.has(page.id) ? <ChevronDown16Regular /> : <ChevronRight16Regular /> : <span />}</button>
                <PageTreeIconButton page={page} hasChildren={hasChildren} expanded={expandedPageIds.has(page.id)} onChange={() => setIconPickerPage(page)} />
                <span className="page-tree-title" title={page.title}>{page.title || '无标题页面'}</span>
                {page.favorite && <Star16Filled className="favorite" />}
                {hasChildren && <span className="page-tree-child-count">{descendantsOf(sectionPages, page.id).size}</span>}
              </div>}>
                <button onClick={() => { void createTreePage(page.id) }}>新建子页面</button>
                <button onClick={() => { void createTreePage(page.parentPageId) }}>新建同级页面</button>
                <ActionMenuDivider />
                <button onClick={() => setIconPickerPage(page)}>更换图标…</button>
                {page.icon && <button onClick={() => void updatePage(page.id, { icon: undefined })}>恢复默认图标</button>}
                <button onClick={() => void updatePage(page.id, { favorite: !page.favorite })}>{page.favorite ? '取消收藏' : '收藏'}</button>
                <button onClick={() => void duplicatePage(page.id).then((id) => { setActivePage(id); setActiveSection(page.sectionId) })}>创建副本</button>
                {page.parentPageId && <button onClick={() => {
                  const roots = sectionPages.filter((item) => !item.parentPageId && item.id !== page.id)
                  void movePageInTree(page.id, page.sectionId, undefined, Math.max(0, ...roots.map((item) => item.sortOrder ?? 0)) + 1000)
                }}>提升为顶层页面</button>}
                <button onClick={() => setMovePageRequest(page)}>移动到其他分区…</button>
                <ActionMenuDivider />
                <button className="destructive-menu-item" onClick={() => { void trashPage(page.id, true) }}>移到回收站</button>
              </ActionMenu>
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
                {activeArea === 'trash' ? <><button onClick={() => void restorePage(page.id)}>恢复页面</button><ActionMenuDivider /><button className="destructive-menu-item" onClick={() => { if (window.confirm(`永久删除“${page.title}”？此操作无法撤销。`)) void purgePage(page.id) }}>永久删除</button></> : <>
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
              {activeArea === 'notes' && !sectionIsEmpty && <><div className="page-utilities"><AttachmentPanel pageId={currentPage.id} loadAssets={loadAssets} saveAsset={saveAsset} openAsset={openAsset} /><VersionHistory pageId={currentPage.id} currentMarkdown={documents[currentPage.id] ? documentToMarkdown(documents[currentPage.id]!) : ''} load={loadRevisions} create={async (pageId) => { const current = documents[pageId]; if (current) await saveDocument(pageId, current); return createManualRevision(pageId) }} restore={(revisionId) => restoreRevision(revisionId).then((pageId) => { setRestoreToken(`${pageId}:${Date.now()}`) })} /></div><span className="editor-action-divider" /></>}
              <ActionMenu label="同步状态详情" trigger={<Button
                className={`compact-sync-button ${syncState === 'syncing' ? 'syncing' : showSyncCompleted ? 'sync-complete' : syncState === 'synced' ? 'idle' : syncState}`}
                appearance="subtle"
                icon={<span className="sync-visual-icon" aria-hidden="true">{syncState === 'syncing' ? null : showSyncCompleted ? <span className="sync-checkmark">✓</span> : <ArrowSync20Regular />}</span>}
                aria-label={`同步状态：${syncLabels[syncState]}`}
                title={showSyncCompleted ? '同步完成' : syncLabels[syncState]}
              />}>
                <div className="sync-status-detail">
                  <strong>{syncLabels[syncState]}</strong>
                  <span>{syncState === 'offline' ? '尚未启用或配置 SSH 同步，当前修改只保存在本机。' : syncState === 'syncing' ? '正在与 SSH 服务器交换最新数据。' : syncState === 'synced' ? '本机与远端服务器已完成最近一次同步。' : syncState === 'conflict' ? '检测到多设备同时修改，请打开相关笔记的版本历史处理。' : '最近一次同步没有完成。'}</span>
                  {(syncState === 'error' || syncState === 'conflict') && <code>{syncError ?? (syncState === 'conflict' ? accessiblePages.filter((page) => page.syncStatus === 'conflict').map((page) => page.title).join('、') || '存在尚未处理的同步冲突。' : '没有提供更详细的错误信息。')}</code>}
                </div>
                <ActionMenuDivider />
                <button disabled={syncState === 'syncing'} onClick={() => void syncNow({ force: true })}>{syncState === 'syncing' ? '正在同步…' : '立即同步'}</button>
                <button onClick={() => { setSettingsPage('services'); setSettingsOpen(true) }}>打开同步设置</button>
              </ActionMenu>
              {activeArea === 'notes' && !sectionIsEmpty && <Button appearance="subtle" icon={<Delete20Regular />} aria-label="移到回收站" title="移到回收站" onClick={() => { void trashPage(currentPage.id) }} />}
              <Button appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="进入聚焦模式" title="聚焦页面（F11）" onClick={() => setFocusMode(true)} />
              <Button appearance="subtle" icon={theme === 'dark' ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />} aria-label={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'} title={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'} onClick={onToggleTheme} />
            </div>
          </div>
          <section className="document-surface">
            {currentPage.syncStatus === 'conflict' && <div className="sync-conflict-banner" role="alert"><strong>检测到其他设备也修改了此笔记</strong><span>当前正文保持本机版本，远端版本已安全保存在“版本”中。继续编辑可保留本机版本；从版本历史恢复远端版本可采用远端内容。</span></div>}
            {activeArea === 'trash' ? (accessibleTrashPages.length ? <div className="trash-detail"><Delete20Regular /><h2>{currentPage.title}</h2><p>页面仍保留在本机，可以恢复到原分区或永久删除。</p><div><Button appearance="primary" onClick={() => { void restorePage(currentPage.id).then(() => { selectArea('notes'); setActivePage(currentPage.id) }) }}>恢复页面</Button><Button appearance="secondary" onClick={() => { if (window.confirm('永久删除后无法恢复，确定继续吗？')) void purgePage(currentPage.id).then(() => setActivePage(accessibleTrashPages.find((page) => page.id !== currentPage.id)?.id ?? accessiblePages[0]?.id ?? '')) }}>永久删除</Button></div></div> : <ModePlaceholder icon={<Delete20Regular />} title="回收站是空的" description="移到回收站的页面会显示在这里。" />) : activeArea === 'tasks' ? (visiblePages.length ? <TaskDetail task={currentPage} loadSteps={loadTaskSteps} saveSteps={saveTaskSteps} updateTask={(patch) => updatePage(currentPage.id, patch)} /> : <ModePlaceholder icon={<CheckmarkCircle20Regular />} title="还没有任务" description="创建任务后，可以在这里集中跟踪状态、截止时间和步骤。" {...(currentSection ? { actionLabel: '新建任务', onAction: () => { void createPage(activeSection, 'task').then(setActivePage) } } : {})} />) : !currentSection ? <ModePlaceholder icon={<Document20Regular />} title="工作区是空的" description="新建一个笔记本后，再创建分区和页面。" actionLabel="新建笔记本" onAction={() => setCreateRequest('notebook')} /> : sectionIsEmpty ? <ModePlaceholder icon={<Document20Regular />} title="这个分区还没有页面" description="创建一篇新页面，开始记录会议、想法或资料。" actionLabel="新建页面" onAction={() => { void createPage(activeSection).then(setActivePage) }} /> : <>
            {!currentDocument ? <div className="document-loading" role="status" aria-live="polite">
              <span className="document-loading-spinner" />
              <strong>正在准备笔记…</strong>
              <span>大型笔记会并行解析，完成后可正常编辑。</span>
            </div> : <DocumentEditor
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
                clearTimeout(readingPositionTimer.current)
                readingPositionTimer.current = setTimeout(() => {
                  writeLocalReadingPositions(readingPositions.current)
                  void saveReadingPosition(pageId, position.fraction)
                }, 350)
              }}
            />}
            </>}
          </section>
        </main>

        <aside className={`right-sidebar ${aiOpen ? 'open' : 'collapsed'}`} aria-label="右侧工具栏">
          {aiOpen && <div className="right-sidebar-panel">
            <PanelResizer label="调整右侧面板宽度" value={aiWidth} min={280} max={520} onChange={setAiWidth} resetValue={320} side="left" />
            {rightPanel === 'outline' && <OutlineSidebar document={documents[currentPage.id]} />}
            {rightPanel === 'backlinks' && <BacklinksSidebar pageId={currentPage.id} pages={accessiblePages} load={loadBacklinks} loadMentions={loadUnlinkedMentions} openPage={openRecentPage} refreshKey={referenceIndexRevision} />}
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
      {settingsOpen && <SettingsCenter
        initialPage={settingsPage}
        theme={theme}
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
        onClose={() => setSettingsOpen(false)}
        onToggleTheme={() => onToggleTheme?.()}
        onAccentColorChange={(color) => onAccentColorChange?.(color)}
        onSyncNow={async (mode) => Boolean(await syncNow({ force: true, mode }))}
        onPublishSshArchive={async (file) => { await publishPreparedLegacyArchive(file) }}
        onImport={chooseImport}
        onExportPage={(format) => { void saveCurrentDocument(format) }}
        onPrint={() => { setSettingsOpen(false); window.setTimeout(() => window.print(), 0) }}
        onExportWorkspace={() => { void runExport().catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '导出失败')) }}
        onExportEncrypted={() => { setSettingsOpen(false); setEncryptedExportOpen(true) }}
        onResetHistory={resetRevisionHistory}
        onChooseDataRoot={window.notebookDesktop ? () => { void window.notebookDesktop?.storage.chooseDataRoot().catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '数据目录更改失败')) } : undefined}
        onPrivacyAction={() => { if (privacyUnlocked) lockPrivacy(); else { setSettingsOpen(false); requestPrivacyAccess() } }}
      />}
      <CommandPalette
        open={commandPaletteOpen}
        items={paletteItems}
        searchPageIds={searchPalettePageIds}
        onClose={() => setCommandPaletteOpen(false)}
      />
      {referenceHelpOpen && <ReferenceHelpDialog onClose={() => setReferenceHelpOpen(false)} />}
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
      {encryptedExportOpen && <BackupPasswordDialog mode="create" onClose={() => setEncryptedExportOpen(false)} onSubmit={async (passphrase) => { await runEncryptedExport(passphrase); setEncryptedExportOpen(false) }} />}
      {encryptedImportRequest && <BackupPasswordDialog mode="unlock" filename={encryptedImportRequest.file.name} onClose={() => setEncryptedImportRequest(undefined)} onSubmit={async (passphrase) => {
        const request = encryptedImportRequest
        const decrypted = await decryptBackup(request.file.data, passphrase)
        setEncryptedImportRequest(undefined)
        await runImport([...request.rest, { name: request.file.name.replace(/\.nbx$/i, '.zip'), data: decrypted }])
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
      {referencePickerOpen && <ReferencePicker pages={accessiblePages} currentPageId={currentPage.id} loadDocument={loadDocument} saveDocument={saveDocument} onClose={() => setReferencePickerOpen(false)} />}
    </div>
  )
}

const PAGE_ICON_GROUPS = [
  { label: '文档', icons: ['📄', '📝', '📒', '📓', '📔', '📕', '📗', '📘', '📙', '📚', '📖', '🔖'] },
  { label: '工作', icons: ['✅', '📌', '📋', '📅', '🗓️', '💼', '🎯', '🚀', '💡', '⚙️', '🧪', '🔧'] },
  { label: '主题', icons: ['🏠', '👤', '👥', '💬', '❤️', '⭐', '🌱', '🌍', '🎨', '🎵', '📷', '🔐'] },
] as const

function PageTreeIconButton({ page, hasChildren, expanded, onChange }: { page: PageSummary; hasChildren: boolean; expanded: boolean; onChange(): void }) {
  const label = page.icon ? `${page.title}的图标：${page.icon}` : `${page.title}使用默认${hasChildren ? '文件夹' : '文档'}图标`
  return <button type="button" className={`page-tree-icon-button ${page.icon ? 'custom' : ''}`} aria-label={`${label}，点击更换`} title={`${label}；点击更换`} onClick={(event) => {
    event.stopPropagation()
    onChange()
  }}>
    {page.icon
      ? <span className="page-tree-emoji" aria-hidden="true">{page.icon}</span>
      : hasChildren
        ? expanded ? <FolderOpen20Regular aria-hidden="true" /> : <Folder20Regular aria-hidden="true" />
        : <Document20Regular aria-hidden="true" />}
  </button>
}

function PageIconPicker({ page, onClose, onSelect }: { page: PageSummary; onClose(): void; onSelect(icon: string | undefined): Promise<void> }) {
  const [customIcon, setCustomIcon] = useState(page.icon ?? '')
  const [saving, setSaving] = useState(false)
  const choose = async (icon: string | undefined) => {
    if (saving) return
    setSaving(true)
    try { await onSelect(icon) } finally { setSaving(false) }
  }
  const normalizedCustomIcon = customIcon.trim().slice(0, 32)
  return <div className="settings-backdrop page-icon-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="settings-dialog page-icon-dialog" role="dialog" aria-modal="true" aria-label={`更换“${page.title}”的图标`}>
      <header><div><span className="page-icon-preview" aria-hidden="true">{page.icon || '📄'}</span><div><h2>页面图标</h2><p>{page.title || '无标题页面'}</p></div></div><Button appearance="subtle" onClick={onClose}>取消</Button></header>
      <div className="page-icon-groups">
        {PAGE_ICON_GROUPS.map((group) => <section key={group.label}><h3>{group.label}</h3><div className="page-icon-grid">
          {group.icons.map((icon) => <button key={icon} type="button" className={page.icon === icon ? 'selected' : ''} aria-label={`使用 ${icon}`} aria-pressed={page.icon === icon} disabled={saving} onClick={() => void choose(icon)}>{icon}</button>)}
        </div></section>)}
      </div>
      <label className="page-icon-custom"><span>粘贴其他 Emoji</span><div><Input value={customIcon} maxLength={32} aria-label="自定义 Emoji" placeholder="例如 🧭" onChange={(_, data) => setCustomIcon(data.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && normalizedCustomIcon) void choose(normalizedCustomIcon)
        if (event.key === 'Escape') onClose()
      }} /><Button appearance="primary" disabled={!normalizedCustomIcon || saving} onClick={() => void choose(normalizedCustomIcon)}>使用</Button></div></label>
      <Button appearance="subtle" disabled={!page.icon || saving} onClick={() => void choose(undefined)}>恢复自动文档/文件夹图标</Button>
    </section>
  </div>
}

const LAYOUT_KEY = 'notebook-layout-v1'
const RECENT_PAGES_KEY = 'notebook-recent-pages-v1'
const VIM_MODE_KEY = 'notebook-vim-mode-v1'
const EXPANDED_PAGES_KEY = 'notebook-expanded-pages-v1'
const PAGE_TREE_DRAG_TYPE = 'application/x-notebook-page-id'
type SavedLayout = { navOpen?: boolean; pagesOpen?: boolean; aiOpen?: boolean; rightPanel?: RightPanel; notebookWidth?: number; pageWidth?: number; aiWidth?: number }

function readLayout(): SavedLayout {
  try { return JSON.parse(globalThis.localStorage?.getItem(LAYOUT_KEY) ?? '{}') as SavedLayout } catch { return {} }
}

function readLocalReadingPositions(): Record<string, ViewportPosition> {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(LOCAL_READING_POSITIONS_KEY) ?? '{}') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([pageId, raw]) => {
      if (!raw || typeof raw !== 'object') return []
      const position = raw as Record<string, unknown>
      const fraction = Number(position.fraction)
      const scrollTop = Number(position.scrollTop)
      if (!Number.isFinite(fraction)) return []
      return [[pageId, {
        fraction: Math.max(0, Math.min(1, fraction)),
        ...(Number.isFinite(scrollTop) && scrollTop >= 0 ? { scrollTop } : {}),
      } satisfies ViewportPosition]]
    }).slice(-500))
  } catch {
    return {}
  }
}

function writeLocalReadingPositions(positions: Map<string, ViewportPosition>) {
  try {
    globalThis.localStorage?.setItem(LOCAL_READING_POSITIONS_KEY, JSON.stringify(Object.fromEntries([...positions].slice(-500))))
  } catch {
    // Reading position is a convenience cache; IndexedDB still keeps the
    // synchronized fractional fallback if localStorage is unavailable.
  }
}

function readRecentPageIds(): string[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(RECENT_PAGES_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-12) : []
  } catch { return [] }
}

function readExpandedPageIds(): Set<string> {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(EXPANDED_PAGES_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch { return new Set() }
}

function readVimEnabled() {
  try { return globalThis.localStorage?.getItem(VIM_MODE_KEY) === 'true' } catch { return false }
}

function PanelResizer({ label, value, min, max, resetValue, onChange, side = 'right' }: { label: string; value: number; min: number; max: number; resetValue: number; onChange: (value: number) => void; side?: 'left' | 'right' }) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startValue = value
    const move = (moveEvent: PointerEvent) => onChange(clamp(startValue + (moveEvent.clientX - startX) * (side === 'left' ? -1 : 1)))
    const stop = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', stop); document.body.classList.remove('resizing-panel') }
    document.body.classList.add('resizing-panel')
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop, { once: true })
  }
  return <div className={`panel-resizer ${side}`} role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} onPointerDown={beginResize} onDoubleClick={() => onChange(resetValue)} onKeyDown={(event) => {
    const direction = side === 'left' ? -1 : 1
    if (event.key === 'ArrowLeft') { event.preventDefault(); onChange(clamp(value - 10 * direction)) }
    if (event.key === 'ArrowRight') { event.preventDefault(); onChange(clamp(value + 10 * direction)) }
    if (event.key === 'Home') { event.preventDefault(); onChange(min) }
    if (event.key === 'End') { event.preventDefault(); onChange(max) }
  }}><span /></div>
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function RailButton({ label, selected, pressed = selected, icon, onClick }: { label: string; selected: boolean; pressed?: boolean; icon: React.ReactElement; onClick: () => void }) {
  return <button className={`rail-button ${selected ? 'selected' : ''}`} aria-label={label} aria-pressed={pressed} title={label} onClick={onClick}>{icon}</button>
}

function ModePlaceholder({ icon, title, description, actionLabel = '开始使用', onAction }: { icon: React.ReactNode; title: string; description: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="mode-placeholder"><div>{icon}</div><h2>{title}</h2><p>{description}</p>{onAction && <Button appearance="primary" onClick={onAction}>{actionLabel}</Button>}</div>
}

function CreateItemDialog({ kind, onClose, onCreate }: { kind: 'notebook' | 'rootPage'; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const label = kind === 'notebook' ? '笔记本' : '顶层页面'
  const submit = async () => {
    const normalized = name.trim()
    if (!normalized || saving) return
    setSaving(true)
    try { await onCreate(normalized) } finally { setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={`新建${label}`}><div><h2>新建{label}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><Input autoFocus value={name} onChange={(_, data) => setName(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label={`${label}名称`} placeholder={`输入${label}名称`} /><Button appearance="primary" disabled={!name.trim() || saving} onClick={() => void submit()}>{saving ? '正在创建' : '创建'}</Button></section></div>
}

function RenameItemDialog({ request, onClose, onRename }: { request: { kind: 'notebook'; name: string }; onClose: () => void; onRename: (name: string) => Promise<void> }) {
  const [name, setName] = useState(request.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const label = '笔记本'
  const submit = async () => {
    const normalized = name.trim()
    if (!normalized || normalized === request.name || saving) return
    setSaving(true)
    setError(undefined)
    try { await onRename(normalized) } catch (cause) { setError(cause instanceof Error ? cause.message : `无法重命名${label}`); setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={`重命名${label}`}><div><h2>重命名{label}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><Input autoFocus value={name} onChange={(_, data) => setName(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label={`${label}名称`} />{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!name.trim() || name.trim() === request.name || saving} onClick={() => void submit()}>{saving ? '正在保存' : '保存'}</Button></section></div>
}

function MovePageDialog({ page, pages, notebooks, onClose, onMove }: {
  page: PageSummary
  pages: PageSummary[]
  notebooks: Array<{ id: string; name: string; sections: Array<{ id: string; name: string }> }>
  onClose: () => void
  onMove: (targetPageId: string, position: 'before' | 'inside' | 'after') => Promise<void>
}) {
  const excluded = new Set([page.id, ...descendantsOf(pages, page.id)])
  const targets = notebooks.flatMap((notebook) => notebook.sections.flatMap((section) => {
    const sectionPages = pages.filter((candidate) => candidate.sectionId === section.id && !excluded.has(candidate.id))
    return flattenPageTree(sectionPages, new Set(sectionPages.map((candidate) => candidate.id))).map(({ page: candidate, depth }) => ({
      page: candidate,
      label: `${notebook.name} / ${'\u00a0\u00a0'.repeat(depth)}${candidate.title || '无标题页面'}`,
    }))
  }))
  const [targetPageId, setTargetPageId] = useState(targets[0]?.page.id ?? '')
  const [position, setPosition] = useState<'before' | 'inside' | 'after'>('inside')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!targetPageId || saving) return
    setSaving(true)
    setError(undefined)
    try { await onMove(targetPageId, position) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法移动页面'); setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog move-page-dialog" role="dialog" aria-label="移动页面"><div><h2>移动“{page.title}”</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div>{targets.length ? <><label className="dialog-field"><span>目标页面</span><select autoFocus aria-label="目标页面" value={targetPageId} onChange={(event) => setTargetPageId(event.currentTarget.value)}>{targets.map((target) => <option key={target.page.id} value={target.page.id}>{target.label}</option>)}</select></label><label className="dialog-field"><span>放置位置</span><select aria-label="放置位置" value={position} onChange={(event) => setPosition(event.currentTarget.value as 'before' | 'inside' | 'after')}><option value="inside">作为目标页面的子页面</option><option value="before">放在目标页面之前</option><option value="after">放在目标页面之后</option></select></label></> : <p>没有可用的目标页面。</p>}{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!targetPageId || saving} onClick={() => void submit()}>{saving ? '正在移动' : '移动到这里'}</Button></section></div>
}

function BackupPasswordDialog({ mode, filename, onClose, onSubmit }: { mode: 'create' | 'unlock'; filename?: string; onClose: () => void; onSubmit: (passphrase: string) => Promise<void> }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const valid = passphrase.length >= 10 && (mode === 'unlock' || passphrase === confirmation)
  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(undefined)
    try { await onSubmit(passphrase) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法处理加密备份') } finally { setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={mode === 'create' ? '创建加密备份' : '解锁加密备份'}><div><h2>{mode === 'create' ? '创建加密备份' : `解锁 ${filename ?? '加密备份'}`}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><p>口令至少 10 个字符。口令不会离开此设备，也无法由服务端找回。</p><Input type="password" autoFocus value={passphrase} onChange={(_, data) => setPassphrase(data.value)} aria-label="备份口令" placeholder="输入备份口令" />{mode === 'create' && <Input type="password" value={confirmation} onChange={(_, data) => setConfirmation(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label="确认备份口令" placeholder="再次输入口令" />}{mode === 'create' && confirmation && passphrase !== confirmation && <p role="alert">两次输入的口令不一致</p>}{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!valid || saving} onClick={() => void submit()}>{saving ? '正在处理' : mode === 'create' ? '导出加密备份' : '解锁并导入'}</Button></section></div>
}

function PrivacyPasswordDialog({ mode, onClose, onSubmit }: { mode: 'setup' | 'unlock'; onClose: () => void; onSubmit: (passphrase: string) => Promise<void> }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const valid = mode === 'unlock' ? Boolean(passphrase) : passphrase.length >= 8 && passphrase === confirmation
  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(undefined)
    try { await onSubmit(passphrase) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法解锁隐私笔记本') } finally { setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog privacy-dialog" role="dialog" aria-label={mode === 'setup' ? '设置隐私密码' : '解锁隐私笔记本'}><div><h2>{mode === 'setup' ? '设置此设备的隐私密码' : '解锁隐私笔记本'}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><p>{mode === 'setup' ? '旧版密码只保存在 macOS 钥匙串中，不能从导出包读取。请为当前设备设置一个至少 8 个字符的新密码。' : '解锁仅对本次应用会话有效；重新打开应用后会自动锁定。'}</p><Input type="password" autoFocus value={passphrase} onChange={(_, data) => setPassphrase(data.value)} onKeyDown={(event) => { if (event.key === 'Enter' && mode === 'unlock') void submit() }} aria-label="隐私密码" placeholder="输入隐私密码" />{mode === 'setup' && <Input type="password" value={confirmation} onChange={(_, data) => setConfirmation(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label="确认隐私密码" placeholder="再次输入隐私密码" />}{mode === 'setup' && confirmation && passphrase !== confirmation && <p role="alert">两次输入的密码不一致</p>}{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!valid || saving} onClick={() => void submit()}>{saving ? '正在处理' : mode === 'setup' ? '设置并解锁' : '解锁'}</Button></section></div>
}
