import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Button } from '@fluentui/react-components'
import DOMPurify from 'dompurify'
import { ArrowUp20Filled, Copy20Regular, DocumentAdd20Regular, Filter20Regular, Search20Regular, Sparkle20Regular, Stop20Filled } from '@fluentui/react-icons'
import type { NotebookSummary, PageSummary } from '../model'
import { flattenPageTree } from '../pageTree'
import { documentToHtml, markdownToDocument } from '../editor/extensions'
import { readAIProviderSettings } from '../ai/providerSettings'
import {
  ASSISTANT_CONTEXT_CHARACTERS,
  ASSISTANT_TASKS,
  assistantMessages,
  citedSources,
  countCharacters,
  emptyScope,
  loadMergedNotes,
  mergedMarkdown,
  numberedContext,
  pagePath,
  parseSearchResults,
  resolveScope,
  scopeIsEmpty,
  scopeLabel,
  searchMessages,
  type AssistantScope,
  type AssistantTask,
  type ContextSource,
  type MergedNote,
  exportMarkdown,
  exportTitle,
  type ExportItem,
} from '../ai/assistant'
import { retrieveNotebookLibrary } from '../ai/libraryRetrieval'
import { completeAI } from '../ai/completion'
import type { PlanGroup } from '../ai/organize'
import type { ApplyOutcome } from '../ai/organizeApply'
import { OrganizePanel } from './OrganizePanel'
import { QuizPanel } from './QuizPanel'
import { RewritePanel } from './RewritePanel'
import { credentialStoreName } from '../shell/keys'

type Tab = 'ask' | 'generate' | 'search' | 'merge' | 'organize' | 'rewrite' | 'quiz'
type Message = { id: string; role: 'user' | 'assistant'; content: string; sources?: ContextSource[]; failed?: boolean; task?: AssistantTask }
type SearchHit = { page: PageSummary; path: string; reason: string }

export interface AssistantViewProps {
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  tags: Array<{ name: string; count: number }>
  initialScope?: AssistantScope
  loadMarkdown(pageId: string): Promise<string | undefined>
  loadDocument(pageId: string): Promise<Record<string, unknown> | undefined>
  openPage(pageId: string): void
  createNote(title: string, markdown: string, target?: { sectionId: string; parentPageId?: string }): Promise<string>
  openAISettings(): void
  /** Applies an accepted organizing/rewriting plan to the workspace. */
  applyPlan(groups: PlanGroup[], onProgress: (done: number, total: number) => void): Promise<ApplyOutcome>
}

const SCOPE_KEY = 'notebook-assistant-scope-v1'

function readSavedScope(): AssistantScope | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? 'null') as AssistantScope | null
    return value && Array.isArray(value.notebookIds) ? { ...emptyScope(), ...value } : undefined
  } catch {
    return undefined
  }
}

const complete = completeAI

function renderMarkdown(markdown: string) {
  try {
    // The answer is model output: sanitize before it reaches the DOM.
    return DOMPurify.sanitize(documentToHtml(markdownToDocument(markdown)), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] }).replace(/\[(\d{1,3})\]/g, '<button type="button" class="assistant-cite" data-source="$1">$1</button>')
  } catch {
    return markdown.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function formatCount(characters: number) {
  return characters >= 10_000 ? `约 ${(characters / 10_000).toFixed(1)} 万字` : `约 ${characters} 字`
}

/**
 * The AI assistant: choose notebooks, folders, notes or tags as the scope,
 * then ask questions, generate summaries, search by meaning, or merge the
 * notes into one Markdown document to copy, save or send to the AI.
 */
export function AssistantView({ pages, notebooks, tags, initialScope, loadMarkdown, loadDocument, openPage, createNote, openAISettings, applyPlan }: AssistantViewProps) {
  const [scope, setScope] = useState<AssistantScope>(() => initialScope ?? readSavedScope() ?? emptyScope())
  useEffect(() => { try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope)) } catch { /* storage unavailable */ } }, [scope])
  const allNotes = useMemo(() => pages.filter((page) => page.kind !== 'task' && !page.locked), [pages])
  const scopedPages = useMemo(() => scopeIsEmpty(scope) ? allNotes : resolveScope(scope, pages, notebooks), [allNotes, notebooks, pages, scope])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('ask')
  // Organize/rewrite/quiz results are expensive (or a session in progress): keep the panels alive across tab switches.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set())
  useEffect(() => { if ((tab === 'organize' || tab === 'rewrite' || tab === 'quiz') && !visited.has(tab)) setVisited(new Set([...visited, tab])) }, [tab, visited])
  // Export: pick answers, then turn them into one new note.
  const [exporting, setExporting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [exportOpen, setExportOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [needsSetup, setNeedsSetup] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>()
  const [merged, setMerged] = useState<MergedNote[]>()
  const abort = useRef<AbortController | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  const configured = readAIProviderSettings().enabled && Boolean(window.notebookDesktop?.ai)
  const label = scopeIsEmpty(scope) ? '全部笔记' : scopeLabel(scope, pages, notebooks)

  useEffect(() => { setMerged(undefined); setHits(undefined) }, [scopedPages])
  useEffect(() => { const element = scrollRef.current; if (element) element.scrollTop = element.scrollHeight }, [messages, busy])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(undefined), 3_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const ensureMerged = async (signal?: AbortSignal) => {
    if (merged) return merged
    const notes = await loadMergedNotes(scopedPages, pages, notebooks, loadMarkdown, signal)
    setMerged(notes)
    return notes
  }

  /** Whole notes when they fit; otherwise the passages most related to the request. */
  const buildContext = async (request: string, signal: AbortSignal) => {
    const notes = await ensureMerged(signal)
    if (countCharacters(notes) <= ASSISTANT_CONTEXT_CHARACTERS || !request.trim()) {
      return numberedContext(notes.map((note) => ({ pageId: note.page.id, title: note.page.title, path: note.path, markdown: note.markdown })))
    }
    const retrieved = await retrieveNotebookLibrary({ query: request, candidatePages: scopedPages, loadDocument, maxPages: scopedPages.length, maxChunks: 60, maxCharacters: ASSISTANT_CONTEXT_CHARACTERS, signal })
    const items = retrieved.chunks.map((chunk) => {
      const page = pages.find((item) => item.id === chunk.pageId)
      return { pageId: chunk.pageId, title: chunk.pageTitle, path: page ? pagePath(page, pages, notebooks) : chunk.pageTitle, markdown: `${chunk.headingPath.length ? `（${chunk.headingPath.join(' › ')}）\n` : ''}${chunk.markdown}` }
    })
    return { ...numberedContext(items), truncated: true }
  }

  const run = async (task: AssistantTask, request: string) => {
    if (busy) return
    if (!scopedPages.length) { setNotice('范围里没有笔记'); return }
    const controller = new AbortController()
    abort.current = controller
    setNotice(undefined)
    setNeedsSetup(false)
    const title = task === 'ask' || task === 'custom' ? request : `${ASSISTANT_TASKS.find((item) => item.id === task)?.label ?? ''}${request.trim() ? `：${request.trim()}` : ''}`
    const history = messages.filter((message) => !message.failed).map((message) => ({ role: message.role, content: message.content }))
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: title, task }])
    setInput('')
    try {
      setBusy('正在读取笔记…')
      const context = await buildContext(task === 'ask' || task === 'custom' ? request : '', controller.signal)
      setBusy('AI 正在思考…')
      const answer = await complete(assistantMessages(task, request, context, task === 'ask' ? history : []), controller.signal)
      const cited = new Set(citedSources(answer))
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: answer, task, sources: context.sources.filter((source) => cited.has(source.index)) }])
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: '已停止。', failed: true }])
      } else if (error instanceof Error && error.message === 'AI_NOT_CONFIGURED') {
        setNeedsSetup(true)
        setMessages((current) => current.slice(0, -1))
      } else {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: error instanceof Error ? error.message : 'AI 请求失败', failed: true }])
      }
    } finally {
      setBusy(undefined)
      abort.current = undefined
    }
  }

  const search = async (query: string) => {
    if (busy || !query.trim()) return
    const controller = new AbortController()
    abort.current = controller
    setNotice(undefined)
    setBusy('正在搜索…')
    try {
      const retrieved = await retrieveNotebookLibrary({ query, candidatePages: scopedPages, loadDocument, maxPages: scopedPages.length, maxChunks: 80, maxCharacters: 60_000, signal: controller.signal })
      // Keyword matches first; the AI then judges meaning over a wider set.
      const byPage = new Map<string, { excerpt: string }>()
      for (const chunk of retrieved.chunks) if (!byPage.has(chunk.pageId)) byPage.set(chunk.pageId, { excerpt: chunk.markdown.slice(0, 160) })
      const keywordHits: SearchHit[] = [...byPage.entries()].flatMap(([pageId, value]) => {
        const page = pages.find((item) => item.id === pageId)
        return page ? [{ page, path: pagePath(page, pages, notebooks), reason: value.excerpt }] : []
      })
      if (!configured) { setHits(keywordHits); return }
      setBusy('AI 正在按意思筛选…')
      const candidates = scopedPages.slice(0, 200).map((page, index) => ({
        index: index + 1,
        title: page.title || '无标题页面',
        path: pagePath(page, pages, notebooks),
        excerpt: (byPage.get(page.id)?.excerpt ?? page.preview ?? '').replace(/\s+/g, ' ').slice(0, 160),
      }))
      const ranked = parseSearchResults(await complete(searchMessages(query, candidates), controller.signal))
      const aiHits = ranked.flatMap(({ index, reason }) => {
        const page = scopedPages[index - 1]
        return page ? [{ page, path: pagePath(page, pages, notebooks), reason }] : []
      })
      const seen = new Set(aiHits.map((hit) => hit.page.id))
      setHits([...aiHits, ...keywordHits.filter((hit) => !seen.has(hit.page.id))])
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error && error.message !== 'AI_NOT_CONFIGURED' ? error.message : '搜索失败')
    } finally {
      setBusy(undefined)
      abort.current = undefined
    }
  }

  const prepareMerge = async () => {
    if (busy) return
    setBusy('正在合并…')
    try { await ensureMerged() } finally { setBusy(undefined) }
  }

  const copy = async (text: string, what = '已复制') => {
    try { await navigator.clipboard.writeText(text); setNotice(what) } catch { setNotice('无法写入剪贴板') }
  }
  const saveAsNote = async (title: string, markdown: string) => {
    const pageId = await createNote(title.slice(0, 60) || 'AI 回答', markdown)
    setNotice('已存为新笔记')
    openPage(pageId)
  }
  const saveFile = async (markdown: string) => {
    const name = `${label.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40) || '合并的笔记'}.md`
    const desktop = window.notebookDesktop
    if (desktop) {
      const saved = await desktop.files.pickSave(name, bytesToBase64(new TextEncoder().encode(markdown)))
      if (saved) setNotice('已保存')
      return
    }
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }))
    Object.assign(document.createElement('a'), { href: url, download: name }).click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  const onCite = (event: MouseEvent<HTMLDivElement>, sources: ContextSource[] | undefined) => {
    const link = (event.target as HTMLElement).closest('a')
    if (link) {
      // Never navigate the app window; web links open in the browser.
      event.preventDefault()
      const href = link.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) void window.notebookDesktop?.external.open(href)
      return
    }
    const target = (event.target as HTMLElement).closest('[data-source]') as HTMLElement | null
    if (!target) return
    const source = sources?.find((item) => item.index === Number(target.dataset.source))
    if (source) openPage(source.pageId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (tab === 'ask' && input.trim()) void run('ask', input.trim())
      if (tab === 'search') void search(input)
      if (tab === 'generate' && input.trim()) void run('custom', input.trim())
    }
  }
  const mergedText = merged ? mergedMarkdown(merged, label) : ''
  const planProps = { scopedPages, pages, notebooks, scopeLabel: label, loadMarkdown, applyPlan, openPage, onNeedsSetup: () => setNeedsSetup(true) }

  return <section className="assistant" aria-label="AI 助手">
    <header className="assistant-header" data-tauri-drag-region>
      <div className="assistant-title" data-tauri-drag-region><Sparkle20Regular /><h2>AI 助手</h2></div>
      {(tab === 'ask' || tab === 'generate') && messages.some((message) => message.role === 'assistant' && !message.failed) && <button type="button" className={`assistant-export ${exporting ? 'active' : ''}`} onClick={() => {
        if (exporting) { setExporting(false); setPicked(new Set()); return }
        const last = [...messages].reverse().find((message) => message.role === 'assistant' && !message.failed)
        setPicked(new Set(last ? [last.id] : []))
        setExporting(true)
      }}><DocumentAdd20Regular />{exporting ? '取消导出' : '导出'}</button>}
      <button type="button" className={`assistant-scope ${pickerOpen ? 'open' : ''}`} aria-expanded={pickerOpen} onClick={() => setPickerOpen((value) => !value)}>
        <Filter20Regular />
        <span className="assistant-scope-label">范围：{label}</span>
        <span className="assistant-scope-count">{scopedPages.length} 篇</span>
      </button>
    </header>
    {pickerOpen && <ScopePicker scope={scope} pages={pages} notebooks={notebooks} tags={tags} onChange={setScope} onDone={() => setPickerOpen(false)} />}
    <div className="assistant-tabs" role="tablist" aria-label="AI 功能">
      {([['ask', '问答'], ['generate', '生成'], ['search', '搜索'], ['merge', '合并'], ['organize', '整理'], ['rewrite', '改写'], ['quiz', '测验']] as const).map(([id, name]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => { setTab(id); setNotice(undefined) }}>{name}</button>)}
    </div>
    {needsSetup && <div className="assistant-setup" role="note">
      <strong>还没有配置 AI</strong>
      <span>在设置里选择 DeepSeek、OpenAI 或自定义接口，填入 API Key 并打开开关。Key 只保存在本机{credentialStoreName()}里。</span>
      <Button appearance="primary" size="small" onClick={openAISettings}>打开 AI 设置</Button>
    </div>}

    {(tab === 'ask' || tab === 'generate') && <div className="assistant-thread" ref={scrollRef}>
      {!messages.length && <div className="assistant-empty">
        {tab === 'ask'
          ? <><strong>基于选中的笔记提问</strong><span>例如“uboot 的编译步骤是什么？”回答会标出依据来自哪篇笔记，点编号可以打开它。</span></>
          : <><strong>基于选中的笔记生成内容</strong><span>选择下面的一种，或者直接写你的要求。</span></>}
        {!configured && <Button size="small" onClick={openAISettings}>配置 AI</Button>}
      </div>}
      {messages.map((message) => <article key={message.id} className={`assistant-message ${message.role} ${message.failed ? 'failed' : ''} ${exporting && message.role === 'assistant' && !message.failed ? 'selectable' : ''} ${picked.has(message.id) ? 'picked' : ''}`}>
        {exporting && message.role === 'assistant' && !message.failed && <label className="assistant-pick"><input type="checkbox" checked={picked.has(message.id)} onChange={() => setPicked((current) => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next })} />选择这条回复</label>}
        {message.role === 'user'
          ? <p>{message.content}</p>
          : <>
            <div className="assistant-answer" onClick={(event) => onCite(event, message.sources)} dangerouslySetInnerHTML={{ __html: message.failed ? message.content.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!) : renderMarkdown(message.content) }} />
            {!!message.sources?.length && <ol className="assistant-sources" aria-label="来源">
              {message.sources.map((source) => <li key={source.index}><button type="button" onClick={() => openPage(source.pageId)}><span className="assistant-cite">{source.index}</span>{source.title}<small>{source.path}</small></button></li>)}
            </ol>}
            {!message.failed && !exporting && <div className="assistant-message-actions">
              <button type="button" onClick={() => void copy(message.content)}><Copy20Regular />复制</button>
              <button type="button" onClick={() => void saveAsNote(messages[messages.indexOf(message) - 1]?.content ?? 'AI 回答', message.content)}><DocumentAdd20Regular />存为笔记</button>
            </div>}
          </>}
      </article>)}
      {busy && <div className="assistant-busy" role="status">{busy}</div>}
    </div>}

    {tab === 'generate' && <div className="assistant-presets">
      {ASSISTANT_TASKS.map((task) => <button key={task.id} type="button" disabled={Boolean(busy)} onClick={() => void run(task.id, input)}>{task.label}</button>)}
    </div>}

    {tab === 'search' && <div className="assistant-results">
      {busy && <div className="assistant-busy" role="status">{busy}</div>}
      {!hits && !busy && <div className="assistant-empty"><strong>在范围里找笔记</strong><span>{configured ? '可以描述你要找的内容，AI 会按意思匹配，不只是关键词。' : '按关键词搜索；配置 AI 后还能按意思查找。'}</span></div>}
      {hits && !hits.length && <div className="assistant-empty"><strong>没有找到</strong><span>换个说法，或扩大范围。</span></div>}
      {hits && hits.length > 0 && <>
        <div className="assistant-results-bar"><span>{hits.length} 篇</span><button type="button" onClick={() => { setScope({ ...emptyScope(), extraPageIds: hits.map((hit) => hit.page.id) }); setTab('ask') }}>用这些笔记提问</button></div>
        <ul>{hits.map((hit) => <li key={hit.page.id}><button type="button" onClick={() => openPage(hit.page.id)}>
          <strong>{hit.page.title || '无标题页面'}</strong><small>{hit.path}</small>{hit.reason && <span>{hit.reason}</span>}
        </button></li>)}</ul>
      </>}
    </div>}

    {tab === 'merge' && <div className="assistant-merge">
      {!merged ? <div className="assistant-empty">
        <strong>把 {scopedPages.length} 篇笔记合并成一份 Markdown</strong>
        <span>按目录顺序排列，每篇以标题开头并注明位置。可以复制、存为文件、存为笔记，或拿去问 AI。</span>
        <Button appearance="primary" size="small" disabled={Boolean(busy) || !scopedPages.length} onClick={() => void prepareMerge()}>{busy ?? '合并'}</Button>
      </div> : <>
        <div className="assistant-results-bar">
          <span>{merged.length} 篇 · {formatCount(countCharacters(merged))}</span>
          <div className="assistant-merge-actions">
            <button type="button" onClick={() => void copy(mergedText, '已复制合并后的 Markdown')}><Copy20Regular />复制</button>
            <button type="button" onClick={() => void saveFile(mergedText)}>存为 .md 文件</button>
            <button type="button" onClick={() => void saveAsNote(`合并：${label}`, mergedText)}><DocumentAdd20Regular />存为笔记</button>
            <button type="button" onClick={() => setTab('ask')}><Sparkle20Regular />拿去问 AI</button>
          </div>
        </div>
        <pre className="assistant-merge-preview">{mergedText.length > 40_000 ? `${mergedText.slice(0, 40_000)}\n\n…（预览只显示前 4 万字，复制和保存的是全部内容）` : mergedText}</pre>
      </>}
    </div>}

    {(tab === 'organize' || visited.has('organize')) && <div className="assistant-plan" hidden={tab !== 'organize'}>
      <OrganizePanel {...planProps} />
    </div>}
    {(tab === 'rewrite' || visited.has('rewrite')) && <div className="assistant-plan" hidden={tab !== 'rewrite'}>
      <RewritePanel {...planProps} />
    </div>}
    {(tab === 'quiz' || visited.has('quiz')) && <div className="assistant-plan" hidden={tab !== 'quiz'}>
      <QuizPanel {...planProps} />
    </div>}

    {exporting && <div className="assistant-export-bar">
      <span>已选 {picked.size} 条回复</span>
      <button type="button" onClick={() => setPicked(new Set(messages.filter((message) => message.role === 'assistant' && !message.failed).map((message) => message.id)))}>全选</button>
      <Button appearance="primary" size="small" disabled={!picked.size} onClick={() => setExportOpen(true)}>生成笔记</Button>
    </div>}
    {exportOpen && <ExportNoteDialog
      items={messages.flatMap((message, index) => message.role === 'assistant' && picked.has(message.id) ? [{ question: messages[index - 1]?.content ?? 'AI 回答', answer: message.content, sources: message.sources ?? [] }] : [])}
      pages={pages}
      notebooks={notebooks}
      defaultSectionId={scopedPages[0]?.sectionId}
      onClose={() => setExportOpen(false)}
      onSave={async (title, markdown, target) => {
        const pageId = await createNote(title, markdown, target)
        setExportOpen(false)
        setExporting(false)
        setPicked(new Set())
        openPage(pageId)
      }}
    />}
    {(tab === 'ask' || tab === 'generate' || tab === 'search') && !exporting && <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); if (tab === 'search') void search(input); else if (input.trim()) void run(tab === 'ask' ? 'ask' : 'custom', input.trim()) }}>
      {tab === 'search' && <Search20Regular className="assistant-composer-icon" />}
      <textarea
        aria-label={tab === 'ask' ? '问题' : tab === 'search' ? '要找的内容' : '要求'}
        rows={1}
        value={input}
        placeholder={tab === 'ask' ? `向 ${scopedPages.length} 篇笔记提问…` : tab === 'search' ? '描述要找的内容…' : '写下要求，例如“整理成给新同事看的入门文档”'}
        onChange={(event) => setInput(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {busy && tab !== 'search'
        ? <button type="button" className="assistant-send" aria-label="停止" onClick={() => abort.current?.abort()}><Stop20Filled /></button>
        : <button type="submit" className="assistant-send" aria-label="发送" disabled={!input.trim() || Boolean(busy)}><ArrowUp20Filled /></button>}
    </form>}
    {notice && <div className="assistant-notice" role="status">{notice}</div>}
  </section>
}

/** Checkbox tree of notebooks, pages (a page includes its children) and tags. */
function ScopePicker({ scope, pages, notebooks, tags, onChange, onDone }: {
  scope: AssistantScope
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  tags: Array<{ name: string; count: number }>
  onChange(scope: AssistantScope): void
  onDone(): void
}) {
  const [filter, setFilter] = useState('')
  // Notes and tags are two ways of picking; a note in either counts.
  const [mode, setMode] = useState<'notes' | 'tags'>(() => scope.tagNames.length && !scope.pageIds.length && !scope.notebookIds.length ? 'tags' : 'notes')
  const toggle = (key: 'notebookIds' | 'pageIds' | 'tagNames', value: string) => {
    const list = scope[key]
    onChange({ ...scope, extraPageIds: [], [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] })
  }
  const pickedPages = new Set(scope.pageIds)
  const coveredBy = (page: PageSummary): boolean => {
    let cursor = page.parentPageId ? pages.find((item) => item.id === page.parentPageId) : undefined
    for (let guard = 0; cursor && guard < 32; guard += 1) {
      if (pickedPages.has(cursor.id)) return true
      cursor = cursor.parentPageId ? pages.find((item) => item.id === cursor!.parentPageId) : undefined
    }
    return false
  }
  const query = filter.trim().toLowerCase()
  return <div className="assistant-picker" role="group" aria-label="选择范围">
    <div className="assistant-picker-bar">
      <div className="assistant-picker-modes" role="tablist" aria-label="选择方式">
        <button type="button" role="tab" aria-selected={mode === 'notes'} className={mode === 'notes' ? 'selected' : undefined} onClick={() => setMode('notes')}>按笔记{scope.notebookIds.length + scope.pageIds.length ? `（${scope.notebookIds.length + scope.pageIds.length}）` : ''}</button>
        <button type="button" role="tab" aria-selected={mode === 'tags'} className={mode === 'tags' ? 'selected' : undefined} onClick={() => setMode('tags')}>按标签{scope.tagNames.length ? `（${scope.tagNames.length}）` : ''}</button>
      </div>
      <input type="search" value={filter} placeholder={mode === 'tags' ? '筛选标签' : '筛选笔记'} aria-label={mode === 'tags' ? '筛选标签' : '筛选笔记'} onChange={(event) => setFilter(event.currentTarget.value)} />
      <button type="button" onClick={() => onChange(emptyScope())}>全部笔记</button>
      <button type="button" className="primary" onClick={onDone}>完成</button>
    </div>
    {mode === 'tags' ? <div className="assistant-picker-tree">
      <div className="assistant-picker-hint">带任一勾选标签的笔记都会用上；也可以同时按笔记勾选。</div>
      {tags.filter((tag) => !query || tag.name.toLowerCase().includes(query)).map((tag) => <label key={tag.name} className="assistant-picker-row"><input type="checkbox" checked={scope.tagNames.includes(tag.name)} onChange={() => toggle('tagNames', tag.name)} /><span>#{tag.name}</span><small>{tag.count} 篇</small></label>)}
      {!tags.length && <div className="assistant-picker-hint">还没有标签。</div>}
    </div> : <div className="assistant-picker-tree">
      {notebooks.filter((notebook) => !notebook.locked).map((notebook) => {
        const notebookPicked = scope.notebookIds.includes(notebook.id)
        const rows = notebook.sections.flatMap((section) => {
          const sectionPages = pages.filter((page) => page.sectionId === section.id && page.kind !== 'task' && !page.locked)
          return flattenPageTree(sectionPages, new Set(sectionPages.map((page) => page.id)))
        }).filter(({ page }) => !query || page.title.toLowerCase().includes(query))
        return <div key={notebook.id} className="assistant-picker-notebook">
          <label className="assistant-picker-row notebook"><input type="checkbox" checked={notebookPicked} onChange={() => toggle('notebookIds', notebook.id)} /><span>{notebook.emoji} {notebook.name}</span></label>
          {rows.map(({ page, depth }) => {
            const inherited = notebookPicked || coveredBy(page)
            return <label key={page.id} className="assistant-picker-row" style={{ paddingLeft: query ? 8 : 8 + depth * 14 }}>
              <input type="checkbox" checked={inherited || pickedPages.has(page.id)} disabled={inherited} onChange={() => toggle('pageIds', page.id)} />
              <span>{page.title || '无标题页面'}</span>
            </label>
          })}
        </div>
      })}
    </div>}
  </div>
}

/** Title and place for a note built from selected answers. */
function ExportNoteDialog({ items, pages, notebooks, defaultSectionId, onClose, onSave }: {
  items: ExportItem[]
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  defaultSectionId?: string
  onClose(): void
  onSave(title: string, markdown: string, target: { sectionId: string; parentPageId?: string }): Promise<void>
}) {
  const targets = useMemo(() => notebooks.filter((notebook) => !notebook.locked).flatMap((notebook) => notebook.sections.flatMap((section) => {
    const sectionPages = pages.filter((page) => page.sectionId === section.id && page.kind !== 'task' && !page.locked)
    return [
      { key: `section:${section.id}`, target: { sectionId: section.id }, label: `${notebook.name}（顶层）` },
      ...flattenPageTree(sectionPages, new Set(sectionPages.map((page) => page.id))).map(({ page, depth }) => ({ key: `page:${page.id}`, target: { sectionId: section.id, parentPageId: page.id }, label: `${notebook.name} / ${'\u00a0\u00a0'.repeat(depth)}${page.title || '无标题页面'}` })),
    ]
  })), [notebooks, pages])
  const [title, setTitle] = useState(() => exportTitle(items))
  const [targetKey, setTargetKey] = useState(() => targets.find((item) => item.key === `section:${defaultSectionId}`)?.key ?? targets[0]?.key ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const save = async () => {
    const target = targets.find((item) => item.key === targetKey)?.target
    if (!target || busy) return
    setBusy(true)
    try { await onSave(title.trim() || 'AI 回答', exportMarkdown(items), target) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法生成笔记'); setBusy(false) }
  }
  return <div className="settings-backdrop" role="presentation">
    <section className="settings-dialog create-item-dialog" role="dialog" aria-label="生成笔记">
      <div><h2>把 {items.length} 条回复生成笔记</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div>
      <label className="dialog-field"><span>标题</span><input aria-label="标题" value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label className="dialog-field"><span>放到</span><select aria-label="放到" value={targetKey} onChange={(event) => setTargetKey(event.currentTarget.value)}>{targets.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <p className="settings-note">每条回复以对应的问题为小标题，末尾附上来源笔记的链接。</p>
      {error && <p role="alert">{error}</p>}
      <Button appearance="primary" disabled={!targetKey || busy} onClick={() => void save()}>{busy ? '正在生成…' : '生成并打开'}</Button>
    </section>
  </div>
}
