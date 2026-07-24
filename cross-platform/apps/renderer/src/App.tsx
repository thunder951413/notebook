import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  Button,
  Input,
  Text,
} from '@fluentui/react-components'
import {
  Add20Regular,
  ArrowReply20Regular,
  ArrowSync20Regular,
  Bot20Filled,
  Bot20Regular,
  CheckmarkCircle20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Document20Filled,
  Document20Regular,
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
import { semanticSearch, streamNotebookAnswer } from './ai/client'
import { TaskDetail } from './tasks/TaskDetail'
import { base64ToBytes, bytesToBase64, type ImportFile } from './data/transfer'
import { AttachmentPanel } from './assets/AttachmentPanel'
import { useReminders } from './tasks/useReminders'
import { VersionHistory } from './history/VersionHistory'
import { documentToHtml, documentToMarkdown, htmlToDocument, markdownToDocument } from './editor/extensions'
import { decryptBackup, encryptBackup } from './crypto/encryptedBackup'
import { SettingsCenter } from './settings/SettingsCenter'
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

const syncLabels = { offline: '仅保存在本机', syncing: '正在同步', synced: '同步完成', conflict: '同步冲突', error: '同步失败' } as const
const emptyPage: PageSummary = { id: '', sectionId: '', title: '未选择页面', preview: '', updatedLabel: '', tags: [], kind: 'document' }
type RightPanel = 'outline' | 'backlinks' | 'ai'
type ViewportPosition = { scrollTop?: number; fraction: number }
const LOCAL_READING_POSITIONS_KEY = 'notebook-local-reading-positions-v1'

export interface AppProps { theme?: 'light' | 'dark'; onToggleTheme?: () => void }

export function App({ theme = 'light', onToggleTheme }: AppProps) {
  const { notebooks, pages, trashPages, documents, syncState, syncError, syncNow, loadDocument, saveDocument, stageDocument, loadBacklinks, loadUnlinkedMentions, createPage, createNotebook, createSection, renameNotebook, deleteNotebook, renameSection, deleteSection, duplicatePage, updatePage, movePageInTree, loadTaskSteps, saveTaskSteps, importFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, moveToTrash, restorePage, purgePage, loadRevisions, restoreRevision, loadReadingPosition, saveReadingPosition } = useWorkspaceData()
  const importInput = useRef<HTMLInputElement>(null)
  const readingPositionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const documentPrefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const readingPositions = useRef(new Map<string, ViewportPosition>(Object.entries(readLocalReadingPositions())))
  const [loadedReadingPosition, setLoadedReadingPosition] = useState<{ pageId: string; position: ViewportPosition }>()
  const [activeArea, setActiveArea] = useState('notes')
  const [activeNotebook, setActiveNotebook] = useState('team')
  const [expandedNotebook, setExpandedNotebook] = useState<string | undefined>('team')
  const [activeSection, setActiveSection] = useState('product')
  const [activePage, setActivePage] = useState(() => new URLSearchParams(location.hash.slice(1)).get('page') ?? 'vision')
  const [recentPageIds, setRecentPageIds] = useState<string[]>(() => readRecentPageIds())
  const [vimEnabled, setVimEnabled] = useState(readVimEnabled)
  const [vimCommandMode, setVimCommandMode] = useState(readVimEnabled)
  const [aiOpen, setAiOpen] = useState(() => readLayout().aiOpen ?? (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1301px)').matches))
  const [rightPanel, setRightPanel] = useState<RightPanel>(() => readLayout().rightPanel ?? 'ai')
  const [navOpen, setNavOpen] = useState(() => readLayout().navOpen ?? true)
  const [pagesOpen, setPagesOpen] = useState(() => readLayout().pagesOpen ?? true)
  const [focusMode, setFocusMode] = useState(false)
  const [notebookWidth, setNotebookWidth] = useState(() => Math.min(520, Math.max(320, readLayout().notebookWidth ?? 0, readLayout().pageWidth ?? 0)))
  const [aiWidth, setAiWidth] = useState(() => readLayout().aiWidth ?? 320)
  const [query, setQuery] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiState, setAiState] = useState<'idle' | 'streaming' | 'error'>('idle')
  const [transferMessage, setTransferMessage] = useState<string>()
  const [restoreToken, setRestoreToken] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<'general' | 'data' | 'services'>('general')
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [dataRoot, setDataRoot] = useState<{ path: string; source: 'default' | 'environment' | 'command-line' | 'saved' }>()
  const [createRequest, setCreateRequest] = useState<'notebook' | 'section'>()
  const [renameRequest, setRenameRequest] = useState<{ kind: 'notebook' | 'section'; id: string; name: string }>()
  const [movePageRequest, setMovePageRequest] = useState<PageSummary>()
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
  const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(() => new Set(['product']))
  const [pageDropTarget, setPageDropTarget] = useState<{ id: string; position: 'before' | 'inside' | 'after' }>()
  const [referenceNavigationTarget, setReferenceNavigationTarget] = useState<NotebookReferenceTarget>()
  const accessiblePages = useMemo(() => privacyUnlocked ? pages : pages.filter((page) => !page.locked), [pages, privacyUnlocked])
  const accessibleTrashPages = useMemo(() => privacyUnlocked ? trashPages : trashPages.filter((page) => !page.locked), [privacyUnlocked, trashPages])
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

  useEffect(() => {
    if (!activePage) return
    const ancestors = ancestorsOf(sectionPages, activePage)
    if (!ancestors.length || ancestors.every((id) => expandedPageIds.has(id))) return
    setExpandedPageIds((current) => new Set([...current, ...ancestors]))
  }, [activePage, expandedPageIds, sectionPages])
  useEffect(() => {
    if (!activeSection || expandedSectionIds.has(activeSection)) return
    setExpandedSectionIds((current) => new Set([...current, activeSection]))
  }, [activeSection, expandedSectionIds])
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
    let cancelled = false
    const local = readingPositions.current.get(pageId)
    setLoadedReadingPosition(local ? { pageId, position: local } : undefined)
    if (!local) void loadReadingPosition(pageId).then((position) => {
      if (cancelled || !position) return
      const restored = { fraction: position.viewportOffsetFraction }
      readingPositions.current.delete(pageId)
      readingPositions.current.set(pageId, restored)
      setLoadedReadingPosition({ pageId, position: restored })
    })
    return () => {
      cancelled = true
      clearTimeout(readingPositionTimer.current)
      const position = readingPositions.current.get(pageId)
      if (!position) return
      writeLocalReadingPositions(readingPositions.current)
      void saveReadingPosition(pageId, position.fraction)
    }
  }, [activeArea, currentPage.id, hasCurrentPage, loadReadingPosition, saveReadingPosition])
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
    setActiveArea('notes')
    setActiveNotebook('personal')
    setActiveSection('inbox')
    void createPage('inbox').then(setActivePage)
  }), [createPage])
  useEffect(() => window.notebookDesktop?.events.onCommandPalette(() => setCommandPaletteOpen(true)), [])

  const askAI = (prompt = aiPrompt) => {
    const normalized = prompt.trim()
    if (!normalized || aiState === 'streaming' || !hasCurrentPage) return
    setAiPrompt(normalized)
    setAiAnswer('')
    setAiState('streaming')
    void Promise.all([searchWorkspace(normalized, 5, privacyUnlocked), semanticSearch(WORKSPACE_ID, normalized, 5)]).then(([matches, semantic]) => {
      const accessibleIds = new Set(accessiblePages.map((page) => page.id))
      const visibleSemantic = semantic.filter((page) => accessibleIds.has(page.id))
      const context = [{ id: currentPage.id, title: currentPage.title, excerpt: currentPage.preview }, ...visibleSemantic, ...matches.map((page) => ({ id: page.id, title: page.title, excerpt: page.preview }))].filter((page, index, all) => all.findIndex((item) => item.id === page.id) === index).slice(0, 8)
      return streamNotebookAnswer(normalized, context, (token) => setAiAnswer((current) => current + token))
    }).then(() => setAiState('idle')).catch((error: unknown) => {
      setAiAnswer(error instanceof TypeError || (error instanceof Error && error.message === 'Failed to fetch')
        ? 'AI 服务暂时不可用。请确认本机 AI 服务已启动，或稍后再试。'
        : error instanceof Error ? error.message : 'AI 服务暂时不可用，请稍后再试。')
      setAiState('error')
    })
  }

  const applyAiAnswer = async (replace: boolean) => {
    if (!aiAnswer.trim() || aiState === 'streaming' || !hasCurrentPage) return
    const current = documents[currentPage.id] ?? { type: 'doc', content: [{ type: 'paragraph' }] }
    const markdown = replace ? aiAnswer.trim() : `${documentToMarkdown(current).trimEnd()}\n\n${aiAnswer.trim()}`.trim()
    await saveDocument(currentPage.id, markdownToDocument(markdown))
  }

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
      setTransferMessage(error instanceof Error ? error.message : '导入失败')
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
    if (window.notebookDesktop) await window.notebookDesktop.files.pickSave(name, bytesToBase64(data))
    else { const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' })); Object.assign(window.document.createElement('a'), { href: url, download: name }).click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000) }
    setTransferMessage('加密备份已导出')
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

  const togglePageExpanded = (pageId: string) => {
    const collapsing = expandedPageIds.has(pageId)
    if (collapsing && descendantsOf(sectionPages, pageId).has(activePage)) setActivePage(pageId)
    setExpandedPageIds((current) => {
      const next = new Set(current)
      if (next.has(pageId)) next.delete(pageId)
      else next.add(pageId)
      return next
    })
  }

  const createTreePage = async (parentPageId?: string) => {
    if (!currentSection) return
    const id = await createPage(currentSection.id, 'document', parentPageId)
    if (parentPageId) setExpandedPageIds((current) => new Set([...current, parentPageId]))
    setActivePage(id)
  }

  const setDropPosition = (event: ReactDragEvent<HTMLElement>, pageId: string) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height)
    setPageDropTarget({ id: pageId, position: ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside' })
  }

  const dropPage = async (event: ReactDragEvent<HTMLElement>, target: PageSummary) => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData(PAGE_TREE_DRAG_TYPE)
    const position = pageDropTarget?.id === target.id ? pageDropTarget.position : 'inside'
    setPageDropTarget(undefined)
    if (!sourceId || sourceId === target.id) return
    const source = accessiblePages.find((page) => page.id === sourceId)
    if (!source || descendantsOf(accessiblePages, sourceId).has(target.id)) return
    let parentPageId = position === 'inside' ? target.id : target.parentPageId
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

  const searchPalettePageIds = useCallback(async (query: string) => (
    await searchWorkspace(query, 50, privacyUnlocked)
  ).map((page) => page.id), [privacyUnlocked, searchWorkspace])

  const paletteItems = useMemo<PaletteItem[]>(() => {
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
      currentNotebook && (!currentNotebook.locked || privacyUnlocked) && { id: 'command:new-section', group: 'command', title: '新建分区', subtitle: currentNotebook.name, keywords: '文件夹 分类', run: () => setCreateRequest('section') },
      { id: 'command:sync', group: 'command', title: syncState === 'syncing' ? '正在同步' : '立即同步', subtitle: syncLabels[syncState], keywords: 'ssh sftp 服务器 推送 拉取', run: () => { if (syncState !== 'syncing') void syncNow({ force: true }) } },
      { id: 'command:notes', group: 'command', title: '打开笔记', keywords: '页面', run: () => selectArea('notes') },
      { id: 'command:tasks', group: 'command', title: '打开任务', keywords: '待办 todo', run: () => selectArea('tasks') },
      { id: 'command:trash', group: 'command', title: '打开回收站', keywords: '删除 恢复', run: () => selectArea('trash') },
      { id: 'command:reference-help', group: 'command', title: '双链使用说明', subtitle: '页面链接、块引用与内容嵌入', keywords: '双链 双链说明 使用说明 帮助 教程 双向链接 wiki link backlink 引用 嵌入 [[', run: () => setReferenceHelpOpen(true) },
      hasActivePage && activeArea === 'notes' && { id: 'command:vim', group: 'command', title: vimEnabled ? '关闭 Vim 模式' : '启用 Vim 模式', keywords: 'normal insert esc', run: () => setVimEnabled((value) => !value) },
      { id: 'command:navigation', group: 'command', title: navigationOpen ? '隐藏导航窗格' : '显示导航窗格', keywords: '侧栏 左侧', run: toggleNavigation },
      hasActivePage && { id: 'command:ai', group: 'command', title: aiOpen && rightPanel === 'ai' ? '关闭 AI 助手' : '打开 AI 助手', keywords: '智能 总结', run: () => {
        if (aiOpen && rightPanel === 'ai') setAiOpen(false)
        else { setRightPanel('ai'); setAiOpen(true) }
      } },
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
      { id: 'setting:data', group: 'setting', title: '数据与备份', subtitle: '导入、导出和数据目录', keywords: '迁移 markdown html pdf nbx zip', run: () => openSettings('data') },
      { id: 'setting:sync', group: 'setting', title: '同步与连接', subtitle: 'SSH/SFTP 服务器设置', keywords: '远端 地址 端口 密码 主机指纹 android', run: () => openSettings('services') },
      { id: 'setting:privacy', group: 'setting', title: '隐私笔记本', subtitle: '解锁、密码与加密说明', keywords: '安全 锁定 AES', run: () => openSettings('services') },
      { id: 'setting:ai', group: 'setting', title: 'AI 与协作服务', subtitle: '查看本机服务状态', keywords: '智能 hocuspocus yjs', run: () => openSettings('services') },
    ]
    return [...commands.filter((item): item is PaletteItem => Boolean(item)), ...pageItems, ...settings]
  }, [accessiblePages, accessibleTrashPages, activeArea, aiOpen, createPage, currentNotebook, currentPage.id, currentPage.title, currentSection, deleteNotebook, focusMode, hasActivePage, navigationOpen, notebooks, pagesOpen, privacyUnlocked, purgePage, recentPageIds, restorePage, rightPanel, syncNow, syncState, vimEnabled])

  const scheduleDocumentPrefetch = (pageId: string, delay = 160) => {
    clearTimeout(documentPrefetchTimer.current)
    if (documents[pageId]) return
    documentPrefetchTimer.current = setTimeout(() => { void loadDocument(pageId) }, delay)
  }

  const deleteSectionAndSelectFallback = async (sectionId: string, sectionName: string) => {
    if (!window.confirm(`删除分区“${sectionName}”及其中全部页面、子页面、任务、附件和历史版本？此操作无法撤销。`)) return
    const fallback = notebooks
      .flatMap((notebook) => notebook.sections.map((section) => ({ notebookId: notebook.id, section })))
      .filter((item) => item.section.id !== sectionId)
      .sort((left, right) => Number(right.notebookId === activeNotebook) - Number(left.notebookId === activeNotebook))[0]
    await deleteSection(sectionId)
    setExpandedSectionIds((current) => {
      const next = new Set(current)
      next.delete(sectionId)
      return next
    })
    if (activeSection !== sectionId) return
    if (!fallback) {
      setActiveSection('')
      setActivePage('')
      return
    }
    setActiveNotebook(fallback.notebookId)
    setExpandedNotebook(fallback.notebookId)
    setActiveSection(fallback.section.id)
    setExpandedSectionIds((current) => new Set([...current, fallback.section.id]))
    setActivePage(pages.find((page) => page.sectionId === fallback.section.id && !page.parentPageId)?.id
      ?? pages.find((page) => page.sectionId === fallback.section.id)?.id
      ?? '')
  }

  const renderTreePage = (page: PageSummary, depth: number, hasChildren: boolean, pagesInSection: PageSummary[]) => (
    <ActionMenu openOnContext key={page.id} label={`${page.title}页面操作`} trigger={<div
      role="treeitem"
      tabIndex={0}
      aria-level={depth + 3}
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
      {activePage === page.id ? <Document20Filled className="page-tree-icon" /> : <Document20Regular className="page-tree-icon" />}
      <span className="page-tree-title" title={page.title}>{page.title || '无标题页面'}</span>
      {page.favorite && <Star16Filled className="favorite" />}
      {hasChildren && <span className="page-tree-child-count">{descendantsOf(pagesInSection, page.id).size}</span>}
    </div>}>
      <button onClick={() => { void createTreePage(page.id) }}>新建子页面</button>
      <button onClick={() => { void createTreePage(page.parentPageId) }}>新建同级页面</button>
      <ActionMenuDivider />
      <button onClick={() => void updatePage(page.id, { favorite: !page.favorite })}>{page.favorite ? '取消收藏' : '收藏'}</button>
      <button onClick={() => void duplicatePage(page.id).then((id) => { setActivePage(id); setActiveSection(page.sectionId) })}>创建副本</button>
      {page.parentPageId && <button onClick={() => {
        const roots = pagesInSection.filter((item) => !item.parentPageId && item.id !== page.id)
        void movePageInTree(page.id, page.sectionId, undefined, Math.max(0, ...roots.map((item) => item.sortOrder ?? 0)) + 1000)
      }}>提升为顶层页面</button>}
      <button onClick={() => setMovePageRequest(page)}>移动到其他分区…</button>
      <ActionMenuDivider />
      <button className="destructive-menu-item" onClick={() => { void trashPage(page.id, true) }}>移到回收站</button>
    </ActionMenu>
  )

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <input ref={importInput} hidden type="file" accept=".md,.markdown,.txt,.html,.htm,.json,.zip,.nbx,application/json,application/zip" multiple onChange={(event) => { const selected = [...(event.target.files ?? [])]; void Promise.all(selected.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))).then(runImport); event.target.value = '' }} />
      <div className={`workspace-grid ${navigationOpen ? '' : 'navigation-collapsed'} ${aiOpen ? '' : 'ai-collapsed'}`} style={{ '--notebook-pane-width': `${notebookWidth}px`, '--ai-pane-width': `${aiWidth}px` } as CSSProperties}>
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
                <Button appearance="subtle" size="small" icon={<Add20Regular />} aria-label="新建顶层页面" disabled={!currentSection} onClick={() => { void createTreePage() }} />
                <ActionMenu label="文档树操作" trigger={<Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label="文档树菜单" />}>
                  <button onClick={() => setExpandedSectionIds(new Set(notebooks.flatMap((notebook) => notebook.sections.map((section) => section.id))))}>展开全部分区</button>
                  <button onClick={() => setExpandedPageIds(new Set(accessiblePages.filter((page) => page.kind !== 'task').map((page) => page.id)))}>展开全部页面</button>
                  <button onClick={() => { setExpandedSectionIds(new Set()); setExpandedPageIds(new Set()) }}>折叠全部</button>
                  <ActionMenuDivider />
                  <button onClick={() => setCreateRequest('section')}>新建分区</button>
                  <button onClick={() => setCreateRequest('notebook')}>新建笔记本</button>
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
                      {notebook.locked && !privacyUnlocked ? <button onClick={() => requestPrivacyAccess(notebook.id)}>解锁笔记本</button> : <><button onClick={() => setRenameRequest({ kind: 'notebook', id: notebook.id, name: notebook.name })}>重命名笔记本</button><button onClick={() => { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id); setCreateRequest('section') }}>新建分区</button><ActionMenuDivider /><button className="destructive-menu-item" onClick={() => { if (window.confirm(`删除笔记本“${notebook.name}”及其中全部分区、页面、任务、附件和历史版本？此操作无法撤销。`)) void deleteNotebook(notebook.id).catch((error: unknown) => window.alert(error instanceof Error ? error.message : '无法删除笔记本')) }}>删除笔记本及全部内容</button></>}
                    </ActionMenu>
                    {expanded && notebook.sections.map((section) => {
                      const pagesInSection = accessiblePages.filter((page) => page.kind !== 'task' && page.sectionId === section.id)
                      const treeRows = flattenPageTree(pagesInSection, expandedPageIds, matchingTreeIds)
                      const sectionExpanded = expandedSectionIds.has(section.id)
                      const searchActive = Boolean(query.trim())
                      if (searchActive && treeRows.length === 0 && !section.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return null
                      return <div className="section-tree-group" key={section.id} role="treeitem" aria-label={section.name} aria-expanded={sectionExpanded} aria-level={2}>
                        <ActionMenu openOnContext label={`${section.name}分区操作`} trigger={<div className={`tree-row section-row ${activeSection === section.id ? 'active-section' : ''}`}>
                          <button type="button" className={`section-tree-toggle ${pagesInSection.length ? '' : 'empty'}`} aria-label={pagesInSection.length ? sectionExpanded ? `折叠${section.name}` : `展开${section.name}` : undefined} onClick={() => setExpandedSectionIds((current) => {
                            const next = new Set(current)
                            if (next.has(section.id)) next.delete(section.id); else next.add(section.id)
                            return next
                          })}>{pagesInSection.length ? sectionExpanded ? <ChevronDown16Regular /> : <ChevronRight16Regular /> : <span />}</button>
                          <button type="button" className="section-tree-main" onClick={() => {
                            setActiveNotebook(notebook.id)
                            setActiveSection(section.id)
                            setExpandedSectionIds((current) => new Set([...current, section.id]))
                            const firstPage = pagesInSection.find((page) => !page.parentPageId) ?? pagesInSection[0]
                            if (firstPage) setActivePage(firstPage.id)
                          }}>
                            <span className="section-dot" style={{ background: section.color }} />
                            <span>{section.name}</span><span className="tree-count">{notebook.locked && !privacyUnlocked ? '—' : section.pageCount}</span>
                          </button>
                        </div>}>
                          <button onClick={() => { setActiveNotebook(notebook.id); setActiveSection(section.id); setExpandedSectionIds((current) => new Set([...current, section.id])); void createPage(section.id).then(setActivePage) }}>新建顶层页面</button>
                          <button onClick={() => setRenameRequest({ kind: 'section', id: section.id, name: section.name })}>重命名分区</button>
                          <ActionMenuDivider />
                          <button className="destructive-menu-item" onClick={() => { void deleteSectionAndSelectFallback(section.id, section.name).catch((error: unknown) => window.alert(error instanceof Error ? error.message : '无法删除分区')) }}>删除分区及全部内容</button>
                        </ActionMenu>
                        {sectionExpanded && <div role="group" className="section-page-tree">
                          {treeRows.length ? treeRows.map(({ page, depth, hasChildren }) => renderTreePage(page, depth, hasChildren, pagesInSection)) : <div className="inline-tree-empty">{searchActive ? '没有匹配页面' : '暂无页面'}</div>}
                        </div>}
                      </div>
                    })}
                  </div>
                )
              })}
            </nav>
            <div className="pane-footer"><Button appearance="subtle" icon={<Add20Regular />} disabled={!currentNotebook} onClick={() => setCreateRequest('section')}>新建分区</Button><Button appearance="subtle" icon={<Add20Regular />} onClick={() => setCreateRequest('notebook')}>新建笔记本</Button></div>
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
                {activePage === page.id ? <Document20Filled className="page-tree-icon" /> : <Document20Regular className="page-tree-icon" />}
                <span className="page-tree-title" title={page.title}>{page.title || '无标题页面'}</span>
                {page.favorite && <Star16Filled className="favorite" />}
                {hasChildren && <span className="page-tree-child-count">{descendantsOf(sectionPages, page.id).size}</span>}
              </div>}>
                <button onClick={() => { void createTreePage(page.id) }}>新建子页面</button>
                <button onClick={() => { void createTreePage(page.parentPageId) }}>新建同级页面</button>
                <ActionMenuDivider />
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
            <div className="breadcrumb"><span>{activeArea === 'notes' ? currentSection?.name ?? currentNotebook?.name ?? '工作区' : '我的知识库'}</span>{activeArea === 'notes' && hasActivePage && currentPageAncestors.map((ancestor) => <Fragment key={ancestor.id}><ChevronRight16Regular /><button className="breadcrumb-page" title={ancestor.title} onClick={() => setActivePage(ancestor.id)}>{ancestor.title}</button></Fragment>)}<ChevronRight16Regular />{activeArea === 'notes' ? hasActivePage ? <Input key={`${currentPage.id}:${currentPage.title}`} className="breadcrumb-title-input" defaultValue={currentPage.title} aria-label="页面标题" onBlur={(event) => { const title = event.currentTarget.value.trim(); if (title && title !== currentPage.title) void updatePage(currentPage.id, { title }) }} /> : <span>未选择页面</span> : <span>{activeArea === 'tasks' ? '所有任务' : '已删除页面'}</span>}</div>
            {activeArea === 'notes' && hasActivePage ? <div className="editor-mode-controls">
              <Button className={`vim-toggle ${vimEnabled && vimCommandMode ? 'selected' : ''}`} appearance="subtle" aria-pressed={vimEnabled} size="small" title={vimEnabled ? vimCommandMode ? 'Vim NORMAL：i 进入编辑' : 'Vim INSERT：Esc 返回普通模式' : '启用 Vim 模式'} onClick={() => setVimEnabled((value) => { const next = !value; setVimCommandMode(next); return next })}>Vim</Button>
            </div> : <div className="area-toolbar-label">{activeArea === 'notes' ? '未选择页面' : activeArea === 'tasks' ? `${visiblePages.length} 项任务` : `${accessibleTrashPages.length} 个页面`}</div>}
            <div className="editor-actions">
              {activeArea === 'notes' && !sectionIsEmpty && <><div className="page-utilities"><AttachmentPanel pageId={currentPage.id} loadAssets={loadAssets} saveAsset={saveAsset} openAsset={openAsset} /><VersionHistory pageId={currentPage.id} currentMarkdown={documents[currentPage.id] ? documentToMarkdown(documents[currentPage.id]!) : ''} load={loadRevisions} restore={(revisionId) => restoreRevision(revisionId).then((pageId) => { setRestoreToken(`${pageId}:${Date.now()}`) })} /></div><span className="editor-action-divider" /></>}
              <ActionMenu label="同步状态详情" trigger={<Button className={`compact-sync-button ${syncState}`} appearance="subtle" icon={<ArrowSync20Regular />} aria-label={`同步状态：${syncLabels[syncState]}`} title={syncLabels[syncState]} />}>
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
            {rightPanel === 'backlinks' && <BacklinksSidebar pageId={currentPage.id} pages={accessiblePages} load={loadBacklinks} loadMentions={loadUnlinkedMentions} openPage={openRecentPage} />}
            {rightPanel === 'ai' && <div className="ai-pane" role="region" aria-label="AI 助手">
              <div className="ai-header"><div className="ai-title"><span className="ai-orb"><Bot20Filled /></span><div><Text weight="semibold">Notebook AI</Text><Text size={200}>基于当前页面</Text></div></div><div className="ai-header-actions"><ActionMenu label="AI 操作" trigger={<Button appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="AI 菜单" />}><button onClick={() => { setAiAnswer(''); setAiPrompt(''); setAiState('idle') }}>新建对话</button><button onClick={() => { setAiAnswer(''); setAiPrompt('') }}>清空上下文</button></ActionMenu></div></div>
              <div className="context-card"><Text size={200} weight="semibold">当前上下文</Text><div className="context-page"><Document20Regular /><span><strong>{hasActivePage ? currentPage.title : '未选择页面'}</strong><small>{hasActivePage ? `页面 · ${currentSection?.name ?? '当前分区'}` : '请先新建或选择页面'}</small></span></div></div>
              <div className="ai-conversation"><div className="ai-message"><div className="ai-message-icon"><Bot20Filled /></div><div><p>{aiAnswer || '我可以基于这篇页面帮助你继续工作。'}</p>{!aiAnswer && <div className="suggestion-grid"><button onClick={() => askAI('把当前页面总结为执行计划')}>总结为执行计划</button><button onClick={() => askAI('找出当前方案缺失的风险')}>找出缺失的风险</button><button onClick={() => askAI('整理当前页面的关键概念和大纲')}>整理关键概念</button><button onClick={() => askAI('把当前页面改写为结构清晰的产品文档')}>改写为产品文档</button></div>}{aiState === 'streaming' && <span className="streaming-indicator">正在生成…</span>}{aiAnswer && aiState === 'idle' && <div className="ai-writeback"><Button size="small" onClick={() => void applyAiAnswer(false)}>追加到笔记</Button><Button size="small" appearance="subtle" onClick={() => { if (window.confirm('这会用 AI 结果替换当前正文，并自动保留一个历史版本。确定继续吗？')) void applyAiAnswer(true) }}>替换正文</Button></div>}</div></div></div>
              <div className="ai-composer"><textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askAI() } }} placeholder="询问此页面，输入 @ 引用其他内容…" aria-label="询问 Notebook AI" /><div><Text size={200}>当前页面作为引用来源</Text><Button appearance="primary" icon={<Bot20Regular />} disabled={aiState === 'streaming' || !aiPrompt.trim()} onClick={() => askAI()}>{aiState === 'streaming' ? '生成中' : '发送'}</Button></div></div>
            </div>}
          </div>}
          <nav className="right-sidebar-rail" aria-label="页面辅助工具">
            <Button appearance="subtle" icon={<PanelRight20Regular />} aria-label={aiOpen ? '隐藏右侧面板' : '显示右侧面板'} title={aiOpen ? '隐藏右侧面板' : '显示右侧面板'} aria-pressed={aiOpen} onClick={() => setAiOpen((value) => !value)} />
            <span className="right-sidebar-divider" />
            <Button className={aiOpen && rightPanel === 'outline' ? 'selected' : ''} appearance="subtle" icon={<TextBulletListSquare20Regular />} aria-label="大纲" title="大纲" disabled={!hasActivePage || activeArea !== 'notes'} onClick={() => { setRightPanel('outline'); setAiOpen(true) }} />
            <Button appearance="subtle" icon={<Link20Regular />} aria-label="双链" title="插入双链" disabled={!hasActivePage || activeArea !== 'notes'} onClick={() => setReferencePickerOpen(true)} />
            <Button className={aiOpen && rightPanel === 'backlinks' ? 'selected' : ''} appearance="subtle" icon={<ArrowReply20Regular />} aria-label="引用" title="查看引用" disabled={!hasActivePage || activeArea !== 'notes'} onClick={() => { setRightPanel('backlinks'); setAiOpen(true) }} />
            <Button className={aiOpen && rightPanel === 'ai' ? 'selected' : ''} appearance="subtle" icon={aiOpen && rightPanel === 'ai' ? <Bot20Filled /> : <Bot20Regular />} aria-label="AI" title="AI 助手" disabled={!hasActivePage} onClick={() => { setRightPanel('ai'); setAiOpen(true) }} />
          </nav>
        </aside>
      </div>
      {focusMode && <Button className="focus-exit" appearance="primary" shape="circular" icon={<FullScreenMinimize20Regular />} aria-label="退出聚焦模式" title="退出聚焦模式（Esc）" onClick={() => setFocusMode(false)} />}
      {settingsOpen && <SettingsCenter
        initialPage={settingsPage}
        theme={theme}
        syncState={syncState}
        syncError={syncError}
        currentPageTitle={currentPage.title}
        transferMessage={transferMessage}
        dataRoot={dataRoot}
        desktop={Boolean(window.notebookDesktop)}
        aiService={import.meta.env.VITE_NOTEBOOK_AI_URL}
        collaborationService={import.meta.env.VITE_NOTEBOOK_COLLAB_URL}
        privacyAvailable={notebooks.some((notebook) => notebook.locked)}
        privacyConfigured={privacyConfigured}
        privacyUnlocked={privacyUnlocked}
        onClose={() => setSettingsOpen(false)}
        onToggleTheme={() => onToggleTheme?.()}
        onSyncNow={async (mode) => Boolean(await syncNow({ force: true, mode }))}
        onPublishSshArchive={async (file) => { await publishPreparedLegacyArchive(file) }}
        onImport={chooseImport}
        onExportPage={(format) => { void saveCurrentDocument(format) }}
        onPrint={() => { setSettingsOpen(false); window.setTimeout(() => window.print(), 0) }}
        onExportWorkspace={() => { void runExport().catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '导出失败')) }}
        onExportEncrypted={() => { setSettingsOpen(false); setEncryptedExportOpen(true) }}
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
        else setActiveSection(await createSection(activeNotebook, name))
        setCreateRequest(undefined)
      }} />}
      {renameRequest && <RenameItemDialog request={renameRequest} onClose={() => setRenameRequest(undefined)} onRename={async (name) => {
        if (renameRequest.kind === 'notebook') await renameNotebook(renameRequest.id, name)
        else await renameSection(renameRequest.id, name)
        setRenameRequest(undefined)
      }} />}
      {movePageRequest && <MovePageDialog page={movePageRequest} notebooks={notebooks.filter((notebook) => !notebook.locked || privacyUnlocked)} onClose={() => setMovePageRequest(undefined)} onMove={async (sectionId) => {
        const roots = accessiblePages.filter((page) => page.sectionId === sectionId && !page.parentPageId && page.id !== movePageRequest.id)
        await movePageInTree(movePageRequest.id, sectionId, undefined, Math.max(0, ...roots.map((page) => page.sortOrder ?? 0)) + 1000)
        if (movePageRequest.id === activePage && activeArea === 'notes') setActiveSection(sectionId)
        setMovePageRequest(undefined)
      }} />}
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

function CreateItemDialog({ kind, onClose, onCreate }: { kind: 'notebook' | 'section'; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const label = kind === 'notebook' ? '笔记本' : '分区'
  const submit = async () => {
    const normalized = name.trim()
    if (!normalized || saving) return
    setSaving(true)
    try { await onCreate(normalized) } finally { setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={`新建${label}`}><div><h2>新建{label}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><Input autoFocus value={name} onChange={(_, data) => setName(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label={`${label}名称`} placeholder={`输入${label}名称`} /><Button appearance="primary" disabled={!name.trim() || saving} onClick={() => void submit()}>{saving ? '正在创建' : '创建'}</Button></section></div>
}

function RenameItemDialog({ request, onClose, onRename }: { request: { kind: 'notebook' | 'section'; name: string }; onClose: () => void; onRename: (name: string) => Promise<void> }) {
  const [name, setName] = useState(request.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const label = request.kind === 'notebook' ? '笔记本' : '分区'
  const submit = async () => {
    const normalized = name.trim()
    if (!normalized || normalized === request.name || saving) return
    setSaving(true)
    setError(undefined)
    try { await onRename(normalized) } catch (cause) { setError(cause instanceof Error ? cause.message : `无法重命名${label}`); setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={`重命名${label}`}><div><h2>重命名{label}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><Input autoFocus value={name} onChange={(_, data) => setName(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label={`${label}名称`} />{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!name.trim() || name.trim() === request.name || saving} onClick={() => void submit()}>{saving ? '正在保存' : '保存'}</Button></section></div>
}

function MovePageDialog({ page, notebooks, onClose, onMove }: { page: PageSummary; notebooks: Array<{ id: string; name: string; sections: Array<{ id: string; name: string }> }>; onClose: () => void; onMove: (sectionId: string) => Promise<void> }) {
  const sections = notebooks.flatMap((notebook) => notebook.sections.map((section) => ({ ...section, notebookName: notebook.name })))
  const [sectionId, setSectionId] = useState(page.sectionId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!sectionId || sectionId === page.sectionId || saving) return
    setSaving(true)
    setError(undefined)
    try { await onMove(sectionId) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法移动页面'); setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label="移动到分区"><div><h2>移动“{page.title}”</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><label className="dialog-field"><span>目标分区</span><select autoFocus aria-label="目标分区" value={sectionId} onChange={(event) => setSectionId(event.currentTarget.value)}>{sections.map((section) => <option key={section.id} value={section.id}>{section.notebookName} / {section.name}</option>)}</select></label>{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!sectionId || sectionId === page.sectionId || saving} onClick={() => void submit()}>{saving ? '正在移动' : '移动'}</Button></section></div>
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
