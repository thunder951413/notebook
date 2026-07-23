import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import {
  Badge,
  Button,
  Input,
  Text,
} from '@fluentui/react-components'
import {
  Add20Regular,
  Bot20Filled,
  Bot20Regular,
  CheckmarkCircle20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Document20Filled,
  Document20Regular,
  Edit20Regular,
  FullScreenMaximize20Regular,
  FullScreenMinimize20Regular,
  LockClosed20Regular,
  LockOpen20Regular,
  MoreHorizontal20Regular,
  Navigation20Regular,
  PanelRight20Regular,
  Search20Regular,
  Settings20Regular,
  Star16Filled,
  Delete20Regular,
} from '@fluentui/react-icons'
import type { PageSummary, WorkspaceMode } from './model'
import { useWorkspaceData, WORKSPACE_ID } from './data/useWorkspaceData'
import { DocumentEditor } from './editor/DocumentEditor'
import { semanticSearch, streamNotebookAnswer } from './ai/client'
import { TaskDetail } from './tasks/TaskDetail'
import { base64ToBytes, bytesToBase64, type ImportFile } from './data/transfer'
import { AttachmentPanel } from './assets/AttachmentPanel'
import { useReminders } from './tasks/useReminders'
import { VersionHistory } from './history/VersionHistory'
import { documentToHtml, documentToMarkdown } from './editor/extensions'
import { decryptBackup, encryptBackup } from './crypto/encryptedBackup'
import { SettingsCenter } from './settings/SettingsCenter'
import { configurePrivacyLock, hasPrivacyLock, verifyPrivacyLock } from './crypto/privacyLock'
import { publishPreparedLegacyArchive } from './sync/legacySshSync'
import { ActionMenu, ActionMenuDivider } from './ActionMenu'

const MarkdownSourceEditor = lazy(() => import('./editor/MarkdownSourceEditor'))

const modeLabels: Record<WorkspaceMode, string> = {
  document: '页面',
  source: 'Markdown',
}

export interface AppProps { theme?: 'light' | 'dark'; onToggleTheme?: () => void }

export function App({ theme = 'light', onToggleTheme }: AppProps) {
  const { notebooks, pages, trashPages, documents, syncState, syncError, syncNow, loadDocument, saveDocument, createPage, createNotebook, createSection, renameNotebook, renameSection, deleteSection, duplicatePage, updatePage, loadTaskSteps, saveTaskSteps, importFiles, exportWorkspace, loadAssets, saveAsset, openAsset, getAssetContent, searchWorkspace, moveToTrash, restorePage, purgePage, loadRevisions, restoreRevision, loadReadingPosition, saveReadingPosition } = useWorkspaceData()
  const importInput = useRef<HTMLInputElement>(null)
  const documentSurface = useRef<HTMLElement>(null)
  const readingPositionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [activeArea, setActiveArea] = useState('notes')
  const [activeNotebook, setActiveNotebook] = useState('team')
  const [expandedNotebook, setExpandedNotebook] = useState<string | undefined>('team')
  const [activeSection, setActiveSection] = useState('product')
  const [activePage, setActivePage] = useState(() => new URLSearchParams(location.hash.slice(1)).get('page') ?? 'vision')
  const [recentPageIds, setRecentPageIds] = useState<string[]>(() => readRecentPageIds())
  const [mode, setMode] = useState<WorkspaceMode>('document')
  const [aiOpen, setAiOpen] = useState(() => readLayout().aiOpen ?? (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1301px)').matches))
  const [navOpen, setNavOpen] = useState(() => readLayout().navOpen ?? true)
  const [pagesOpen, setPagesOpen] = useState(() => readLayout().pagesOpen ?? true)
  const [focusMode, setFocusMode] = useState(false)
  const [notebookWidth, setNotebookWidth] = useState(() => readLayout().notebookWidth ?? 236)
  const [pageWidth, setPageWidth] = useState(() => readLayout().pageWidth ?? 300)
  const [aiWidth, setAiWidth] = useState(() => readLayout().aiWidth ?? 320)
  const [query, setQuery] = useState('')
  const [globalQuery, setGlobalQuery] = useState('')
  const [globalResultIds, setGlobalResultIds] = useState<string[]>()
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiState, setAiState] = useState<'idle' | 'streaming' | 'error'>('idle')
  const [transferMessage, setTransferMessage] = useState<string>()
  const [restoreToken, setRestoreToken] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  const accessiblePages = useMemo(() => privacyUnlocked ? pages : pages.filter((page) => !page.locked), [pages, privacyUnlocked])
  const accessibleTrashPages = useMemo(() => privacyUnlocked ? trashPages : trashPages.filter((page) => !page.locked), [privacyUnlocked, trashPages])
  useReminders(accessiblePages)

  const visiblePages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const filtered = (activeArea === 'trash' ? accessibleTrashPages : accessiblePages).filter((page) => {
      if (globalResultIds) return globalResultIds.includes(page.id)
      if (activeArea === 'trash') return !normalized || `${page.title} ${page.preview}`.toLocaleLowerCase().includes(normalized)
      if (activeArea === 'tasks' ? page.kind !== 'task' : page.kind === 'task' || page.sectionId !== activeSection) return false
      if (!normalized) return true
      return `${page.title} ${page.preview} ${page.tags.join(' ')}`.toLocaleLowerCase().includes(normalized)
    })
    return pageSort === 'title' ? [...filtered].sort((left, right) => left.title.localeCompare(right.title, 'zh-CN')) : filtered
  }, [accessiblePages, accessibleTrashPages, activeArea, activeSection, globalResultIds, pageSort, query])

  const currentPage = [...accessiblePages, ...accessibleTrashPages].find((page) => page.id === activePage) ?? accessiblePages[0] ?? accessibleTrashPages[0]!
  const currentDocumentReady = Boolean(documents[currentPage.id])
  const currentNotebook = notebooks.find((notebook) => notebook.id === activeNotebook) ?? notebooks[0]
  const currentSection = notebooks.flatMap((notebook) => notebook.sections).find((section) => section.id === activeSection)
  const sectionIsEmpty = activeArea === 'notes' && !accessiblePages.some((page) => page.kind !== 'task' && page.sectionId === activeSection)
  const showNotebookPane = activeArea === 'notes' && navOpen
  const showPagePane = pagesOpen
  const navigationOpen = showNotebookPane || showPagePane
  const recentPages = useMemo(() => recentPageIds.map((id) => accessiblePages.find((page) => page.id === id && page.kind !== 'task')).filter((page): page is NonNullable<typeof page> => Boolean(page)), [accessiblePages, recentPageIds])

  useEffect(() => { void loadDocument(currentPage.id) }, [currentPage.id, loadDocument])
  useEffect(() => {
    if (activeArea !== 'notes') return
    let cancelled = false
    void loadReadingPosition(currentPage.id).then((position) => {
      if (cancelled || !position) return
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const surface = documentSurface.current
        if (!cancelled && surface) surface.scrollTop = position.viewportOffsetFraction * Math.max(0, surface.scrollHeight - surface.clientHeight)
      }))
    })
    return () => { cancelled = true }
  }, [activeArea, currentDocumentReady, currentPage.id, loadReadingPosition, mode])
  useEffect(() => {
    if (activeArea !== 'notes' || currentPage.kind === 'task') return
    setRecentPageIds((current) => {
      if (current.includes(currentPage.id)) return current
      const next = [...current, currentPage.id].slice(-12)
      globalThis.localStorage?.setItem(RECENT_PAGES_KEY, JSON.stringify(next))
      return next
    })
  }, [activeArea, currentPage.id, currentPage.kind])
  useEffect(() => {
    if (settingsOpen && window.notebookDesktop) void window.notebookDesktop.storage.getInfo().then(setDataRoot)
  }, [settingsOpen])
  useEffect(() => {
    const followHash = () => { const pageId = new URLSearchParams(location.hash.slice(1)).get('page'); if (pageId) setActivePage(pageId) }
    window.addEventListener('hashchange', followHash)
    return () => window.removeEventListener('hashchange', followHash)
  }, [])
  useEffect(() => {
    const normalized = globalQuery.trim()
    if (!normalized) { setGlobalResultIds(undefined); return }
    const timer = window.setTimeout(() => { void searchWorkspace(normalized, undefined, privacyUnlocked).then((results) => setGlobalResultIds(results.map((page) => page.id))) }, 180)
    return () => window.clearTimeout(timer)
  }, [globalQuery, privacyUnlocked, searchWorkspace])

  useEffect(() => {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify({ navOpen, pagesOpen, aiOpen, notebookWidth, pageWidth, aiWidth }))
  }, [aiOpen, aiWidth, navOpen, notebookWidth, pageWidth, pagesOpen])

  useEffect(() => {
    if (window.matchMedia('(max-width: 1180px)').matches) setNavOpen(false)
    if (window.matchMedia('(max-width: 680px)').matches) setPagesOpen(false)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
    setMode('document')
    void createPage('inbox').then(setActivePage)
  }), [createPage])

  const askAI = (prompt = aiPrompt) => {
    const normalized = prompt.trim()
    if (!normalized || aiState === 'streaming') return
    setAiPrompt(normalized)
    setAiAnswer('')
    setAiState('streaming')
    void Promise.all([searchWorkspace(normalized, 5, privacyUnlocked), semanticSearch(WORKSPACE_ID, normalized, 5)]).then(([matches, semantic]) => {
      const accessibleIds = new Set(accessiblePages.map((page) => page.id))
      const visibleSemantic = semantic.filter((page) => accessibleIds.has(page.id))
      const context = [{ id: currentPage.id, title: currentPage.title, excerpt: currentPage.preview }, ...visibleSemantic, ...matches.map((page) => ({ id: page.id, title: page.title, excerpt: page.preview }))].filter((page, index, all) => all.findIndex((item) => item.id === page.id) === index).slice(0, 8)
      return streamNotebookAnswer(normalized, context, (token) => setAiAnswer((current) => current + token))
    }).then(() => setAiState('idle')).catch((error: unknown) => {
      setAiAnswer(error instanceof Error ? error.message : 'AI 服务暂时不可用')
      setAiState('error')
    })
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
    setGlobalQuery('')
    if (area === 'notes') {
      setMode('document')
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
    setMode('document')
    if (notebook) { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id) }
  }

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
      <header className="titlebar">
        <div className="titlebar-brand">
          <Button appearance="subtle" icon={<Navigation20Regular />} aria-label={navigationOpen ? '隐藏导航窗格' : '显示导航窗格'} title={navigationOpen ? '隐藏导航窗格' : '显示导航窗格'} aria-pressed={navigationOpen} onClick={toggleNavigation} />
          <div className="app-mark">N</div>
          <Text weight="semibold">Notebook</Text>
        </div>
        <div className="global-search">
          <Input value={globalQuery} onChange={(_, data) => setGlobalQuery(data.value)} contentBefore={<Search20Regular />} placeholder="搜索页面和内容" aria-label="全局搜索" />
        </div>
        <div className="titlebar-actions">
          <Badge appearance="tint" color={syncState === 'error' || syncState === 'conflict' ? 'danger' : syncState === 'offline' ? 'informative' : 'success'} icon={<CheckmarkCircle20Regular />}>{{ offline: '离线可用', syncing: '同步中', synced: '已同步', conflict: '有冲突', error: '同步失败' }[syncState]}</Badge>
        </div>
        <input ref={importInput} hidden type="file" accept=".md,.markdown,.txt,.html,.htm,.json,.zip,.nbx,application/json,application/zip" multiple onChange={(event) => { const selected = [...(event.target.files ?? [])]; void Promise.all(selected.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))).then(runImport); event.target.value = '' }} />
      </header>

      <div className={`workspace-grid ${showNotebookPane ? '' : 'nav-collapsed'} ${showPagePane ? '' : 'pages-collapsed'} ${aiOpen ? '' : 'ai-collapsed'}`} style={{ '--notebook-pane-width': `${notebookWidth}px`, '--page-pane-width': `${pageWidth}px`, '--ai-pane-width': `${aiWidth}px` } as CSSProperties}>
        <aside className="app-rail" aria-label="主要功能">
          <RailButton label="笔记" selected={activeArea === 'notes'} icon={activeArea === 'notes' ? <Document20Filled /> : <Document20Regular />} onClick={() => selectArea('notes')} />
          <RailButton label="任务" selected={activeArea === 'tasks'} icon={<CheckmarkCircle20Regular />} onClick={() => selectArea('tasks')} />
          <RailButton label="AI 助手" selected={aiOpen} icon={aiOpen ? <Bot20Filled /> : <Bot20Regular />} onClick={() => setAiOpen((value) => !value)} />
          <RailButton label="回收站" selected={activeArea === 'trash'} icon={<Delete20Regular />} onClick={() => selectArea('trash')} />
          <span className="rail-spacer" />
          <RailButton label="设置" selected={settingsOpen} icon={<Settings20Regular />} onClick={() => setSettingsOpen(true)} />
        </aside>

        {showNotebookPane && (
          <aside className="notebook-pane panel-border" aria-label="笔记本和分区">
            <div className="pane-heading">
              <div><Text size={200}>工作区</Text><Text weight="semibold" size={400}>我的知识库</Text></div>
            </div>
            <nav className="notebook-tree">
              {notebooks.map((notebook) => {
                const expanded = expandedNotebook === notebook.id && (!notebook.locked || privacyUnlocked)
                return (
                  <div key={notebook.id}>
                    <ActionMenu openOnContext label={`${notebook.name}笔记本操作`} trigger={<button className={`tree-row notebook-row ${activeNotebook === notebook.id ? 'active-parent' : ''} ${notebook.locked ? 'private-notebook-row' : ''}`} aria-expanded={expanded} aria-label={notebook.locked && !privacyUnlocked ? `${notebook.name}（已锁定）` : notebook.name} onClick={() => {
                      if (notebook.locked && !privacyUnlocked) { requestPrivacyAccess(notebook.id); return }
                      if (expanded && activeNotebook === notebook.id) { setExpandedNotebook(undefined); return }
                      activateNotebook(notebook.id)
                    }}>
                      {expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                      <span>{notebook.emoji}</span><span>{notebook.name}</span>{notebook.locked && <span className="notebook-lock-state" title={privacyUnlocked ? '已解锁' : '已锁定'}>{privacyUnlocked ? <LockOpen20Regular /> : <LockClosed20Regular />}</span>}
                    </button>}>
                      {notebook.locked && !privacyUnlocked ? <button onClick={() => requestPrivacyAccess(notebook.id)}>解锁笔记本</button> : <><button onClick={() => setRenameRequest({ kind: 'notebook', id: notebook.id, name: notebook.name })}>重命名笔记本</button><button onClick={() => { setActiveNotebook(notebook.id); setExpandedNotebook(notebook.id); setCreateRequest('section') }}>新建分区</button></>}
                    </ActionMenu>
                    {expanded && notebook.sections.map((section) => (
                      <ActionMenu openOnContext key={section.id} label={`${section.name}分区操作`} trigger={<button className={`tree-row section-row ${activeSection === section.id ? 'selected' : ''}`} onClick={() => { setActiveSection(section.id); const firstPage = pages.find((page) => page.kind !== 'task' && page.sectionId === section.id); if (firstPage) setActivePage(firstPage.id); if (window.matchMedia('(max-width: 1180px)').matches) setNavOpen(false); if (window.matchMedia('(max-width: 680px)').matches) setPagesOpen(true) }}>
                        <span className="section-dot" style={{ background: section.color }} />
                        <span>{section.name}</span><span className="tree-count">{notebook.locked && !privacyUnlocked ? '—' : section.pageCount}</span>
                      </button>}>
                        <button onClick={() => { setActiveNotebook(notebook.id); setActiveSection(section.id); void createPage(section.id).then(setActivePage) }}>新建页面</button>
                        <button onClick={() => setRenameRequest({ kind: 'section', id: section.id, name: section.name })}>重命名分区</button>
                        <ActionMenuDivider />
                        <button className="destructive-menu-item" disabled={section.pageCount > 0} onClick={() => { if (window.confirm(`删除空分区“${section.name}”？`)) void deleteSection(section.id).catch((error: unknown) => window.alert(error instanceof Error ? error.message : '无法删除分区')) }}>{section.pageCount > 0 ? '删除分区（需先清空）' : '删除空分区'}</button>
                      </ActionMenu>
                    ))}
                  </div>
                )
              })}
            </nav>
            <div className="pane-footer"><Button appearance="subtle" icon={<Add20Regular />} onClick={() => setCreateRequest('section')}>新建分区</Button><Button appearance="subtle" icon={<Add20Regular />} onClick={() => setCreateRequest('notebook')}>新建笔记本</Button></div>
            <PanelResizer label="调整笔记本导航宽度" value={notebookWidth} min={180} max={380} onChange={setNotebookWidth} resetValue={236} />
          </aside>
        )}

        {showPagePane && <aside className="page-pane panel-border" aria-label="页面列表">
          <div className="page-pane-header">
            <div className="page-title-row"><Text size={500} weight="semibold">{activeArea === 'tasks' ? '所有任务' : activeArea === 'trash' ? '回收站' : currentSection?.name ?? '页面'}</Text><div className="page-header-actions">{activeArea !== 'trash' && <Button appearance="subtle" size="small" icon={<Add20Regular />} aria-label={activeArea === 'tasks' ? '新建任务' : '新建页面'} onClick={() => { void createPage(activeSection, activeArea === 'tasks' ? 'task' : 'document').then(setActivePage) }} />}<ActionMenu label="页面列表操作" trigger={<Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label="页面列表菜单" />}><button onClick={() => setPageSort(pageSort === 'recent' ? 'title' : 'recent')}>{pageSort === 'recent' ? '按标题排序' : '恢复原始顺序'}</button><button onClick={() => setCompactPages((value) => !value)}>{compactPages ? '显示页面摘要' : '使用紧凑列表'}</button><button onClick={() => setPagesOpen(false)}>隐藏页面列表</button></ActionMenu></div></div>
            <Input value={query} onChange={(_, data) => setQuery(data.value)} contentBefore={<Search20Regular />} placeholder={activeArea === 'tasks' ? '搜索任务' : activeArea === 'trash' ? '搜索回收站' : '搜索此分区'} aria-label={activeArea === 'tasks' ? '搜索任务' : activeArea === 'trash' ? '搜索回收站' : '搜索此分区'} />
          </div>
          <div className={`page-list ${compactPages ? 'compact' : ''}`}>
            {visiblePages.length === 0 && <div className="page-list-empty"><Document20Regular /><strong>{query || globalResultIds ? '没有匹配的页面' : activeArea === 'trash' ? '回收站是空的' : '这个分区还没有页面'}</strong><span>{query || globalResultIds ? '尝试更短的关键词，或清除搜索条件。' : activeArea === 'trash' ? '删除的页面会临时保存在这里。' : '使用上方按钮创建第一篇内容。'}</span></div>}
            {visiblePages.map((page) => (
              <ActionMenu openOnContext key={page.id} label={`${page.title}页面操作`} trigger={<button className={`page-card ${activePage === page.id ? 'selected' : ''}`} onClick={() => {
                if (activeArea === 'notes') {
                  setActivePage(page.id)
                  setActiveSection(page.sectionId)
                  const owner = notebooks.find((notebook) => notebook.sections.some((section) => section.id === page.sectionId))
                  if (owner) setActiveNotebook(owner.id)
                  setMode('document')
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
                  <button className="destructive-menu-item" onClick={() => { if (window.confirm(`将“${page.title}”移到回收站？`)) void moveToTrash(page.id) }}>移到回收站</button>
                </>}
              </ActionMenu>
            ))}
          </div>
          <PanelResizer label="调整页面列表宽度" value={pageWidth} min={240} max={460} onChange={setPageWidth} resetValue={300} />
        </aside>}

        <main className="content-pane">
          <div className="section-tabs">
            {activeArea === 'notes' ? <div className="recent-page-tabs" role="tablist" aria-label="最近打开的笔记"><span className="recent-tabs-label">最近</span>{recentPages.map((page) => { const selected = page.id === currentPage.id && !sectionIsEmpty; return <button key={page.id} role="tab" aria-selected={selected} className={selected ? 'selected' : ''} title={page.title} onClick={() => openRecentPage(page.id)}>{page.title}</button> })}</div> : <div className="area-heading"><span>{activeArea === 'tasks' ? '任务' : '回收站'}</span><small>{activeArea === 'tasks' ? '集中管理全部笔记本中的任务' : '恢复或永久删除页面'}</small></div>}
          </div>
          <div className="editor-toolbar">
            <div className="breadcrumb"><span>{activeArea === 'notes' ? currentNotebook?.name ?? '笔记本' : '我的知识库'}</span><ChevronRight16Regular />{activeArea === 'notes' ? <Input key={`${currentPage.id}:${currentPage.title}`} className="breadcrumb-title-input" defaultValue={currentPage.title} aria-label="页面标题" onBlur={(event) => { const title = event.currentTarget.value.trim(); if (title && title !== currentPage.title) void updatePage(currentPage.id, { title }) }} /> : <span>{activeArea === 'tasks' ? '所有任务' : '已删除页面'}</span>}</div>
            {activeArea === 'notes' ? <div className="view-switcher" role="group" aria-label="页面视图">
              {(Object.keys(modeLabels) as WorkspaceMode[]).map((item) => <Button key={item} className={mode === item ? 'selected' : ''} appearance="subtle" aria-pressed={mode === item} size="small" icon={item === 'document' ? <Edit20Regular /> : <Document20Regular />} onClick={() => setMode(item)}>{modeLabels[item]}</Button>)}
            </div> : <div className="area-toolbar-label">{activeArea === 'tasks' ? `${visiblePages.length} 项任务` : `${accessibleTrashPages.length} 个页面`}</div>}
            <div className="editor-actions">{activeArea === 'notes' && !sectionIsEmpty && <><div className="page-utilities"><AttachmentPanel pageId={currentPage.id} loadAssets={loadAssets} saveAsset={saveAsset} openAsset={openAsset} /><VersionHistory pageId={currentPage.id} load={loadRevisions} restore={(revisionId) => restoreRevision(revisionId).then((pageId) => { setRestoreToken(`${pageId}:${Date.now()}`) })} /></div><span className="editor-action-divider" /><Button appearance="subtle" icon={<Delete20Regular />} aria-label="移到回收站" title="移到回收站" onClick={() => { void moveToTrash(currentPage.id).then(() => setActivePage(accessiblePages.find((page) => page.id !== currentPage.id)?.id ?? '')) }} /></>}<Button appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="进入聚焦模式" title="聚焦页面（F11）" onClick={() => setFocusMode(true)} /></div>
          </div>
          <section ref={documentSurface} className="document-surface" onScroll={(event) => {
            if (activeArea !== 'notes') return
            const surface = event.currentTarget
            const fraction = surface.scrollTop / Math.max(1, surface.scrollHeight - surface.clientHeight)
            const pageId = currentPage.id
            clearTimeout(readingPositionTimer.current)
            readingPositionTimer.current = setTimeout(() => { void saveReadingPosition(pageId, fraction) }, 450)
          }}>
            {currentPage.syncStatus === 'conflict' && <div className="sync-conflict-banner" role="alert"><strong>检测到其他设备也修改了此笔记</strong><span>当前正文保持本机版本，远端版本已安全保存在“版本”中。继续编辑可保留本机版本；从版本历史恢复远端版本可采用远端内容。</span></div>}
            {activeArea === 'trash' ? (accessibleTrashPages.length ? <div className="trash-detail"><Delete20Regular /><h2>{currentPage.title}</h2><p>页面仍保留在本机，可以恢复到原分区或永久删除。</p><div><Button appearance="primary" onClick={() => { void restorePage(currentPage.id).then(() => { selectArea('notes'); setActivePage(currentPage.id) }) }}>恢复页面</Button><Button appearance="secondary" onClick={() => { if (window.confirm('永久删除后无法恢复，确定继续吗？')) void purgePage(currentPage.id).then(() => setActivePage(accessibleTrashPages.find((page) => page.id !== currentPage.id)?.id ?? accessiblePages[0]?.id ?? '')) }}>永久删除</Button></div></div> : <ModePlaceholder icon={<Delete20Regular />} title="回收站是空的" description="移到回收站的页面会显示在这里。" />) : activeArea === 'tasks' ? (visiblePages.length ? <TaskDetail task={currentPage} loadSteps={loadTaskSteps} saveSteps={saveTaskSteps} updateTask={(patch) => updatePage(currentPage.id, patch)} /> : <ModePlaceholder icon={<CheckmarkCircle20Regular />} title="还没有任务" description="创建任务后，可以在这里集中跟踪状态、截止时间和步骤。" actionLabel="新建任务" onAction={() => { void createPage(activeSection, 'task').then(setActivePage) }} />) : sectionIsEmpty ? <ModePlaceholder icon={<Document20Regular />} title="这个分区还没有页面" description="创建一篇新页面，开始记录会议、想法或资料。" actionLabel="新建页面" onAction={() => { void createPage(activeSection).then(setActivePage) }} /> : <>
            {mode === 'document' && <DocumentEditor
              key={`${currentPage.id}:${restoreToken.startsWith(`${currentPage.id}:`) ? restoreToken : ''}`}
              workspaceId={WORKSPACE_ID}
              pageId={currentPage.id}
              pageTitle={currentPage.title}
              content={documents[currentPage.id] ?? (currentPage.id === 'vision' ? undefined : { type: 'doc', content: [{ type: 'paragraph' }] })}
              onChange={(json) => { void saveDocument(currentPage.id, json) }}
              loadAsset={getAssetContent}
              saveImage={(file) => saveAsset(currentPage.id, file)}
              forceRestore={restoreToken.startsWith(`${currentPage.id}:`)}
            />}
            <Suspense fallback={<ModePlaceholder icon={<Document20Regular />} title="正在加载 Markdown" description="正在准备源码编辑器。" />}>
              {mode === 'source' && <MarkdownSourceEditor key={currentPage.id} workspaceId={WORKSPACE_ID} pageId={currentPage.id} content={documents[currentPage.id] ?? { type: 'doc', content: [{ type: 'paragraph' }] }} onChange={(json) => { void saveDocument(currentPage.id, json) }} />}
            </Suspense>
            </>}
          </section>
        </main>

        {aiOpen && <aside className="ai-pane panel-border" aria-label="AI 助手">
          <PanelResizer label="调整 AI 面板宽度" value={aiWidth} min={280} max={520} onChange={setAiWidth} resetValue={320} side="left" />
          <div className="ai-header"><div className="ai-title"><span className="ai-orb"><Bot20Filled /></span><div><Text weight="semibold">Notebook AI</Text><Text size={200}>基于当前页面</Text></div></div><div className="ai-header-actions"><ActionMenu label="AI 操作" trigger={<Button appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="AI 菜单" />}><button onClick={() => { setAiAnswer(''); setAiPrompt(''); setAiState('idle') }}>新建对话</button><button onClick={() => { setAiAnswer(''); setAiPrompt('') }}>清空上下文</button></ActionMenu><Button appearance="subtle" icon={<PanelRight20Regular />} aria-label="关闭 AI 助手" title="关闭 AI 助手" onClick={() => setAiOpen(false)} /></div></div>
          <div className="context-card"><Text size={200} weight="semibold">当前上下文</Text><div className="context-page"><Document20Regular /><span><strong>{currentPage.title}</strong><small>页面 · {currentSection?.name ?? '当前分区'}</small></span></div></div>
          <div className="ai-conversation"><div className="ai-message"><div className="ai-message-icon"><Bot20Filled /></div><div><p>{aiAnswer || '我可以基于这篇页面帮助你继续工作。'}</p>{!aiAnswer && <div className="suggestion-grid"><button onClick={() => askAI('把当前页面总结为执行计划')}>总结为执行计划</button><button onClick={() => askAI('找出当前方案缺失的风险')}>找出缺失的风险</button><button onClick={() => askAI('整理当前页面的关键概念和大纲')}>整理关键概念</button><button onClick={() => askAI('把当前页面改写为结构清晰的产品文档')}>改写为产品文档</button></div>}{aiState === 'streaming' && <span className="streaming-indicator">正在生成…</span>}</div></div></div>
          <div className="ai-composer"><textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askAI() } }} placeholder="询问此页面，输入 @ 引用其他内容…" aria-label="询问 Notebook AI" /><div><Text size={200}>当前页面作为引用来源</Text><Button appearance="primary" icon={<Bot20Regular />} disabled={aiState === 'streaming' || !aiPrompt.trim()} onClick={() => askAI()}>{aiState === 'streaming' ? '生成中' : '发送'}</Button></div></div>
        </aside>}
      </div>
      {focusMode && <Button className="focus-exit" appearance="primary" shape="circular" icon={<FullScreenMinimize20Regular />} aria-label="退出聚焦模式" title="退出聚焦模式（Esc）" onClick={() => setFocusMode(false)} />}
      {settingsOpen && <SettingsCenter
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
        onSyncNow={async () => Boolean(await syncNow({ force: true }))}
        onPublishSshArchive={async (file) => { await publishPreparedLegacyArchive(file) }}
        onImport={chooseImport}
        onExportPage={(format) => { void saveCurrentDocument(format) }}
        onPrint={() => { setSettingsOpen(false); window.setTimeout(() => window.print(), 0) }}
        onExportWorkspace={() => { void runExport().catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '导出失败')) }}
        onExportEncrypted={() => { setSettingsOpen(false); setEncryptedExportOpen(true) }}
        onChooseDataRoot={window.notebookDesktop ? () => { void window.notebookDesktop?.storage.chooseDataRoot().catch((error: unknown) => setTransferMessage(error instanceof Error ? error.message : '数据目录更改失败')) } : undefined}
        onPrivacyAction={() => { if (privacyUnlocked) lockPrivacy(); else { setSettingsOpen(false); requestPrivacyAccess() } }}
      />}
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
        await updatePage(movePageRequest.id, { sectionId })
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
    </div>
  )
}

const LAYOUT_KEY = 'notebook-layout-v1'
const RECENT_PAGES_KEY = 'notebook-recent-pages-v1'
type SavedLayout = { navOpen?: boolean; pagesOpen?: boolean; aiOpen?: boolean; notebookWidth?: number; pageWidth?: number; aiWidth?: number }

function readLayout(): SavedLayout {
  try { return JSON.parse(globalThis.localStorage?.getItem(LAYOUT_KEY) ?? '{}') as SavedLayout } catch { return {} }
}

function readRecentPageIds(): string[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(RECENT_PAGES_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-12) : []
  } catch { return [] }
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

function RailButton({ label, selected, icon, onClick }: { label: string; selected: boolean; icon: React.ReactElement; onClick: () => void }) {
  return <button className={`rail-button ${selected ? 'selected' : ''}`} aria-label={label} aria-pressed={selected} title={label} onClick={onClick}>{icon}</button>
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
