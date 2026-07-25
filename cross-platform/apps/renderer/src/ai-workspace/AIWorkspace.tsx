import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@fluentui/react-components'
import {
  ArrowLeft20Regular,
  Bot20Filled,
  Checkmark20Regular,
  Dismiss20Regular,
  Document20Regular,
  Send20Regular,
} from '@fluentui/react-icons'
import type { Asset, AutomationProposal, AutomationProposalChange } from '@notebook/domain'
import type { AIContextBundle } from '@notebook/sync-contract'
import { diffLines } from 'diff'
import type { NotebookSummary, PageSummary } from '../model'
import { buildNotebookAIContext, type NotebookAIContextScope } from '../ai/notebookContext'
import { requestNotebookProposal, streamNotebookAnswer } from '../ai/client'
import { documentToMarkdown } from '../editor/extensions'
import { pageLocation } from '../automation/workspaceReview'
import type { NotebookAgentProposalInput } from '../automation/automationBridge'

type ReviewDecision = 'accepted' | 'rejected'
type DiffView = 'side-by-side' | 'unified'
type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; pageIds?: string[] }

interface AIWorkspaceProps {
  currentPage: PageSummary
  pages: PageSummary[]
  trashPages: PageSummary[]
  notebooks: NotebookSummary[]
  proposals: AutomationProposal[]
  documents: Record<string, Record<string, unknown>>
  privacyUnlocked: boolean
  loadDocument(pageId: string): Promise<Record<string, unknown> | undefined>
  loadAssets(pageId: string): Promise<Asset[]>
  onClose(): void
  onOpenPage(pageId: string): void
  onCreateWriteback(input: { pageId: string; markdown: string; title: string; explanation?: string }): Promise<string>
  onCreateAgentProposal(input: NotebookAgentProposalInput): Promise<string>
  onApplyProposal(proposalId: string, acceptedChangeIds?: string[]): Promise<void>
  onRejectProposal(proposalId: string): Promise<void>
}

export function AIWorkspace({
  currentPage,
  pages,
  trashPages,
  notebooks,
  proposals,
  documents,
  privacyUnlocked,
  loadDocument,
  loadAssets,
  onClose,
  onOpenPage,
  onCreateWriteback,
  onCreateAgentProposal,
  onApplyProposal,
  onRejectProposal,
}: AIWorkspaceProps) {
  const pending = useMemo(() => proposals.filter((proposal) => proposal.status === 'pending'), [proposals])
  const [proposalId, setProposalId] = useState<string>()
  const proposal = proposals.find((item) => item.id === proposalId)
    ?? pending[0]
    ?? proposals[0]
  const [selectedChangeId, setSelectedChangeId] = useState<string>()
  const selectedChange = proposal?.changes.find((change) => change.id === selectedChangeId) ?? proposal?.changes[0]
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>({})
  const [diffView, setDiffView] = useState<DiffView>('side-by-side')
  const [leftWidth, setLeftWidth] = useState(300)
  const [rightWidth, setRightWidth] = useState(380)
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: crypto.randomUUID(), role: 'system', content: 'AI 的建议会先进入暂存区。只有你批准的页面才会写入历史并参加同步。' },
  ])
  const [mentionedPageIds, setMentionedPageIds] = useState<string[]>(currentPage.id && !currentPage.locked ? [currentPage.id] : [])
  const [writebackPageId, setWritebackPageId] = useState(currentPage.locked ? '' : currentPage.id)
  const [contextScope, setContextScope] = useState<NotebookAIContextScope>('embeds')
  const [chatState, setChatState] = useState<'idle' | 'streaming' | 'error'>('idle')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>()
  const abortRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    if (proposal) setProposalId(proposal.id)
  }, [proposal])
  useEffect(() => {
    if (!proposal) return
    setSelectedChangeId((current) => current && proposal.changes.some((change) => change.id === current) ? current : proposal.changes[0]?.id)
    setDecisions(Object.fromEntries(proposal.changes.map((change) => [change.id, 'accepted' as const])))
  }, [proposal])
  useEffect(() => {
    const available = mentionedPageIds.length ? mentionedPageIds : currentPage.id && !currentPage.locked ? [currentPage.id] : []
    if (!available.includes(writebackPageId)) setWritebackPageId(available[0] ?? '')
  }, [currentPage.id, currentPage.locked, mentionedPageIds, writebackPageId])

  const mentionQuery = mentionSearch(prompt)
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === undefined) return []
    const normalized = mentionQuery.toLocaleLowerCase()
    return pages
      .filter((page) => page.kind !== 'task' && !page.locked && !mentionedPageIds.includes(page.id))
      .filter((page) => !normalized || `${page.title} ${page.preview}`.toLocaleLowerCase().includes(normalized))
      .slice(0, 12)
  }, [mentionQuery, mentionedPageIds, pages])

  const selectMention = (page: PageSummary) => {
    setPrompt((value) => replaceMentionQuery(value, `@${page.title} `))
    setMentionedPageIds((value) => value.includes(page.id) ? value : [...value, page.id])
  }

  const send = async () => {
    const normalized = prompt.trim()
    if (!normalized || chatState === 'streaming') return
    const roots = mentionedPageIds.length ? mentionedPageIds : currentPage.id && !currentPage.locked ? [currentPage.id] : []
    if (!roots.length) {
      setStatus('请先用 @ 指定至少一篇笔记。')
      return
    }
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: normalized, pageIds: roots }
    const assistantId = crypto.randomUUID()
    setMessages((value) => [...value, userMessage, { id: assistantId, role: 'assistant', content: '' }])
    setPrompt('')
    setChatState('streaming')
    setStatus(undefined)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const bundles = await Promise.all(roots.map((rootPageId) => buildNotebookAIContext({
        rootPageId,
        scope: contextScope,
        pages,
        trashPages,
        privacyUnlocked,
        loadDocument,
        loadAssets,
      })))
      const context = mergeContextBundles(bundles)
      await streamNotebookAnswer(normalized, context, (token) => {
        setMessages((value) => value.map((message) => message.id === assistantId ? { ...message, content: message.content + token } : message))
      }, controller.signal)
      setChatState('idle')
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((value) => value.map((message) => message.id === assistantId && !message.content ? { ...message, content: '已停止生成。' } : message))
        setChatState('idle')
      } else {
        setMessages((value) => value.map((message) => message.id === assistantId ? { ...message, content: error instanceof Error ? error.message : 'AI 服务暂时不可用。' } : message))
        setChatState('error')
      }
    } finally {
      abortRef.current = undefined
    }
  }

  const createAgentProposal = async () => {
    const normalized = prompt.trim()
    if (!normalized || chatState === 'streaming') return
    const roots = mentionedPageIds.length ? mentionedPageIds : currentPage.id && !currentPage.locked ? [currentPage.id] : []
    if (!roots.length) {
      setStatus('请先用 @ 指定允许 AI 修改的文章。')
      return
    }
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: normalized, pageIds: roots }
    const assistantId = crypto.randomUUID()
    setMessages((value) => [...value, userMessage, { id: assistantId, role: 'assistant', content: '正在生成结构化修改提案…' }])
    setPrompt('')
    setChatState('streaming')
    setStatus(undefined)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const bundles = await Promise.all(roots.map((rootPageId) => buildNotebookAIContext({
        rootPageId,
        scope: contextScope,
        pages,
        trashPages,
        privacyUnlocked,
        loadDocument,
        loadAssets,
      })))
      const context = mergeContextBundles(bundles)
      const input = await requestNotebookProposal(normalized, context, {
        notebooks: notebooks.filter((notebook) => !notebook.locked).map((notebook) => ({
          id: notebook.id,
          name: notebook.name,
          sections: notebook.sections.map((section) => ({ id: section.id, name: section.name })),
        })),
        pages: pages.filter((page) => !page.locked && roots.includes(page.id)).map((page) => ({
          id: page.id,
          title: page.title,
          sectionId: page.sectionId,
          parentPageId: page.parentPageId,
        })),
      }, roots, controller.signal)
      const id = await onCreateAgentProposal(input)
      setProposalId(id)
      setMessages((value) => value.map((message) => message.id === assistantId ? {
        ...message,
        content: `已生成“${input.title}”，包含 ${input.operations.length} 项变化。尚未写入笔记，请在左侧逐项审阅。`,
      } : message))
      setStatus('结构化修改已进入暂存区；未批准的项目不会进入历史或同步。')
      setChatState('idle')
    } catch (error) {
      setMessages((value) => value.map((message) => message.id === assistantId ? {
        ...message,
        content: controller.signal.aborted ? '已停止生成。' : error instanceof Error ? error.message : '生成修改提案失败。',
      } : message))
      setChatState(controller.signal.aborted ? 'idle' : 'error')
    } finally {
      abortRef.current = undefined
    }
  }

  const stageAnswer = async (message: ChatMessage, mode: 'replace' | 'append') => {
    const targetPage = pages.find((page) => page.id === writebackPageId)
    if (!targetPage?.id || targetPage.locked || !message.content.trim()) return
    setBusy(true)
    setStatus(undefined)
    try {
      const editor = documents[targetPage.id] ?? await loadDocument(targetPage.id)
      const before = editor ? documentToMarkdown(editor) : ''
      const markdown = mode === 'replace'
        ? message.content.trim()
        : `${before.trimEnd()}\n\n${message.content.trim()}`.trim()
      const id = await onCreateWriteback({
        pageId: targetPage.id,
        markdown,
        title: `${mode === 'replace' ? 'AI 改写' : 'AI 追加'}：${targetPage.title}`,
        explanation: `由 Notebook AI 对话生成；上下文包含 ${mentionedPageIds.length || 1} 篇页面。`,
      })
      setProposalId(id)
      setStatus('修改已进入暂存区，尚未写入笔记。请在左侧选择页面并审阅差异。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '创建暂存修改失败')
    } finally {
      setBusy(false)
    }
  }

  const applyAccepted = async () => {
    if (!proposal || proposal.status !== 'pending') return
    const accepted = proposal.changes.filter((change) => decisions[change.id] !== 'rejected').map((change) => change.id)
    if (!accepted.length) {
      setStatus('没有已接受的修改；可以放弃整批提案。')
      return
    }
    const acceptedDeletes = proposal.changes.filter((change) => accepted.includes(change.id) && change.type === 'delete-page')
    if (acceptedDeletes.length && !window.confirm(`将把 ${acceptedDeletes.length} 篇页面移到回收站，并连同其他已接受修改一起应用。确定继续吗？`)) return
    setBusy(true)
    setStatus(undefined)
    try {
      await onApplyProposal(proposal.id, accepted)
      setStatus(`已应用 ${accepted.length} 项；${proposal.changes.length - accepted.length} 项已拒绝。修改已写入历史并进入正常同步队列。`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '应用 AI 修改失败')
    } finally {
      setBusy(false)
    }
  }

  const discardProposal = async () => {
    if (!proposal || proposal.status !== 'pending') return
    if (!window.confirm('放弃整批暂存修改？现有笔记不会发生变化。')) return
    setBusy(true)
    try {
      await onRejectProposal(proposal.id)
      setStatus('已放弃整批暂存修改，笔记与同步队列均未改变。')
    } finally {
      setBusy(false)
    }
  }

  const acceptedCount = proposal?.changes.filter((change) => decisions[change.id] !== 'rejected').length ?? 0
  const pendingCount = pending.reduce((total, item) => total + item.changes.length, 0)

  return <section className="ai-workspace" aria-label="Notebook AI 工作区">
    <header className="ai-workspace-topbar">
      <div>
        <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onClose}>返回笔记</Button>
        <span className="ai-workspace-orb"><Bot20Filled /></span>
        <strong>Notebook AI</strong>
        <span className="ai-workspace-count">{pendingCount} 项待审阅</span>
      </div>
      <div>
        {proposal && <select aria-label="AI 修改批次" value={proposal.id} onChange={(event) => setProposalId(event.currentTarget.value)}>
          {proposals.map((item) => <option key={item.id} value={item.id}>{statusLabel(item.status)} · {item.title}（{item.changes.length}）</option>)}
        </select>}
        <Button disabled={!proposal || proposal.status !== 'pending' || busy} onClick={() => void discardProposal()}>放弃整批</Button>
        <Button appearance="primary" icon={<Checkmark20Regular />} disabled={!proposal || proposal.status !== 'pending' || !acceptedCount || busy} onClick={() => void applyAccepted()}>
          应用已接受的 {acceptedCount} 项
        </Button>
      </div>
    </header>
    {status && <div className="ai-workspace-status" role="status">{status}</div>}
    <div
      className="ai-workspace-grid"
      style={{ '--ai-change-width': `${leftWidth}px`, '--ai-chat-width': `${rightWidth}px` } as CSSProperties}
    >
      <aside className="ai-change-pane">
        <header><div><strong>变化的笔记</strong><small>只显示本批次受影响页面</small></div><span>{proposal?.changes.length ?? 0}</span></header>
        {!proposal && <div className="ai-workspace-empty">还没有修改提案。可在右侧与 AI 对话，或让外部 AI 通过本机接口提交。</div>}
        {proposal && <div className="ai-change-list">
          {proposal.changes.map((change) => {
            const decision = decisions[change.id] ?? 'accepted'
            return <button
              type="button"
              key={change.id}
              className={`ai-change-row ${selectedChange?.id === change.id ? 'selected' : ''} ${decision}`}
              onClick={() => setSelectedChangeId(change.id)}
            >
              <span className={`ai-change-kind ${changeKind(change).tone}`}>{changeKind(change).label}</span>
              <span><strong>{change.after.title}</strong><small>{changeSummary(change, pages, notebooks)}</small></span>
              <span className="ai-change-decision">{decision === 'accepted' ? '接受' : '拒绝'}</span>
            </button>
          })}
        </div>}
        {proposal && <footer><small>基线：{new Date(proposal.createdAt).toLocaleString()}</small><small>{proposal.source}</small></footer>}
      </aside>
      <PaneResizer value={leftWidth} min={240} max={520} direction={1} onChange={setLeftWidth} label="调整变化目录宽度" />
      <main className="ai-diff-pane">
        {!selectedChange ? <div className="ai-workspace-empty">从左侧选择一篇变化的笔记查看差异。</div> : <>
          <header className="ai-diff-header">
            <div>
              <span className={`ai-change-kind ${changeKind(selectedChange).tone}`}>{changeKind(selectedChange).label}</span>
              <div><strong>{selectedChange.after.title}</strong><small>{changeSummary(selectedChange, pages, notebooks)}</small></div>
            </div>
            <div>
              <div className="ai-diff-view-toggle">
                <button className={diffView === 'side-by-side' ? 'selected' : ''} onClick={() => setDiffView('side-by-side')}>并排</button>
                <button className={diffView === 'unified' ? 'selected' : ''} onClick={() => setDiffView('unified')}>统一</button>
              </div>
              {selectedChange.type !== 'create-page' && <Button size="small" appearance="subtle" onClick={() => onOpenPage(selectedChange.after.pageId)}>打开原笔记</Button>}
              <Button size="small" icon={decisions[selectedChange.id] === 'rejected' ? <Checkmark20Regular /> : <Dismiss20Regular />} onClick={() => setDecisions((value) => ({ ...value, [selectedChange.id]: value[selectedChange.id] === 'rejected' ? 'accepted' : 'rejected' }))}>
                {decisions[selectedChange.id] === 'rejected' ? '改为接受' : '拒绝此项'}
              </Button>
            </div>
          </header>
          <MetadataDiff change={selectedChange} pages={pages} notebooks={notebooks} />
          <MarkdownDiff change={selectedChange} view={diffView} />
        </>}
      </main>
      <PaneResizer value={rightWidth} min={320} max={620} direction={-1} onChange={setRightWidth} label="调整 AI 对话宽度" />
      <aside className="ai-chat-pane">
        <header><div><span className="ai-workspace-orb"><Bot20Filled /></span><div><strong>AI 对话</strong><small>使用 @ 指定页面；回答和操作都先暂存</small></div></div><Button size="small" appearance="subtle" onClick={() => { setMessages([]); setMentionedPageIds(currentPage.id && !currentPage.locked ? [currentPage.id] : []); setStatus(undefined) }}>新对话</Button></header>
        <div className="ai-chat-context">
          <span>上下文</span>
          {mentionedPageIds.map((id) => {
            const page = pages.find((item) => item.id === id)
            return page && <button key={id} title="移出上下文" onClick={() => setMentionedPageIds((value) => value.filter((item) => item !== id))}>@{page.title} ×</button>
          })}
          <select aria-label="AI 引用展开范围" value={contextScope} onChange={(event) => setContextScope(event.currentTarget.value as NotebookAIContextScope)}>
            <option value="current">仅指定页面</option>
            <option value="embeds">加嵌入内容</option>
            <option value="all">加全部链接内容</option>
          </select>
          <select aria-label="AI 回答暂存目标" value={writebackPageId} onChange={(event) => setWritebackPageId(event.currentTarget.value)}>
            {(mentionedPageIds.length ? mentionedPageIds : currentPage.id && !currentPage.locked ? [currentPage.id] : []).flatMap((id) => pages.find((page) => page.id === id && !page.locked) ?? []).map((page) => <option key={page.id} value={page.id}>写入：{page.title}</option>)}
          </select>
        </div>
        <div className="ai-chat-messages">
          {messages.length === 0 && <div className="ai-chat-welcome"><Bot20Filled /><strong>先讨论，再审阅修改</strong><p>用 <kbd>@</kbd> 指定一篇或多篇笔记。AI 回答可暂存为当前笔记的替换或追加内容；外部 AI 提交的批量改名、移动、新建与删除也会出现在左侧。</p></div>}
          {messages.map((message) => <article key={message.id} className={`ai-chat-message ${message.role}`}>
            <header>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Notebook AI' : '安全边界'}</header>
            <p>{message.content || (chatState === 'streaming' ? '正在生成…' : '')}</p>
            {message.role === 'assistant' && message.content && chatState !== 'streaming' && <div>
              <Button size="small" disabled={busy || !writebackPageId} onClick={() => void stageAnswer(message, 'append')}>暂存为追加</Button>
              <Button size="small" appearance="subtle" disabled={busy || !writebackPageId} onClick={() => void stageAnswer(message, 'replace')}>暂存为替换</Button>
            </div>}
          </article>)}
        </div>
        <div className="ai-chat-composer">
          {mentionCandidates.length > 0 && <div className="ai-mention-menu" role="listbox" aria-label="@ 页面">
            {mentionCandidates.map((page) => <button key={page.id} role="option" onMouseDown={(event) => { event.preventDefault(); selectMention(page) }}>
              <Document20Regular /><span><strong>{page.title}</strong><small>{page.preview || '暂无摘要'}</small></span>
            </button>)}
          </div>}
          <textarea
            value={prompt}
            placeholder="输入 @ 指定文章，然后说明希望 AI 如何处理…"
            aria-label="与 Notebook AI 对话"
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !mentionCandidates.length) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <footer>
            <span>所有写入先暂存，批准后才产生历史与同步</span>
            {chatState === 'streaming'
              ? <Button icon={<Dismiss20Regular />} onClick={() => abortRef.current?.abort()}>停止</Button>
              : <span className="ai-chat-actions">
                <Button icon={<Bot20Filled />} disabled={!prompt.trim()} onClick={() => void createAgentProposal()}>生成修改提案</Button>
                <Button appearance="primary" icon={<Send20Regular />} disabled={!prompt.trim()} onClick={() => void send()}>发送</Button>
              </span>}
          </footer>
        </div>
      </aside>
    </div>
  </section>
}

function changeKind(change: AutomationProposalChange): { label: string; tone: string } {
  if (change.type === 'delete-page') return { label: 'D', tone: 'deleted' }
  if (change.type === 'create-page') return { label: 'A', tone: 'created' }
  const renamed = change.before?.title !== change.after.title
  const moved = change.before?.sectionId !== change.after.sectionId
    || change.before?.parentPageId !== change.after.parentPageId
    || change.before?.sortOrder !== change.after.sortOrder
  const content = change.before?.markdown !== change.after.markdown
  if (renamed && moved) return { label: 'R↕', tone: 'moved' }
  if (renamed) return { label: 'R', tone: 'renamed' }
  if (moved) return { label: '↕', tone: 'moved' }
  return { label: content ? 'M' : '·', tone: 'modified' }
}

function changeSummary(change: AutomationProposalChange, pages: PageSummary[], notebooks: NotebookSummary[]) {
  if (change.type === 'delete-page') return '将移到回收站'
  if (change.type === 'create-page') return pageLocation(change.after.pageId, [...pages, pageFromChange(change)], notebooks)
  const before = change.before ? pageLocation(change.before.pageId, pages, notebooks) : '不存在'
  const afterPages = pages.map((page) => page.id === change.after.pageId ? {
    ...page,
    title: change.after.title,
    sectionId: change.after.sectionId ?? page.sectionId,
    parentPageId: change.after.parentPageId,
    sortOrder: change.after.sortOrder,
  } : page)
  const after = pageLocation(change.after.pageId, afterPages, notebooks)
  if (before !== after) return `${before} → ${after}`
  if (change.before?.title !== change.after.title) return `${change.before?.title} → ${change.after.title}`
  return '正文修改'
}

function pageFromChange(change: AutomationProposalChange): PageSummary {
  return {
    id: change.after.pageId,
    sectionId: change.after.sectionId ?? '',
    parentPageId: change.after.parentPageId,
    sortOrder: change.after.sortOrder,
    title: change.after.title,
    preview: '',
    updatedLabel: '',
    tags: [],
    kind: 'document',
  }
}

function MetadataDiff({ change, pages, notebooks }: { change: AutomationProposalChange; pages: PageSummary[]; notebooks: NotebookSummary[] }) {
  const beforeLocation = change.before ? pageLocation(change.before.pageId, pages, notebooks) : '不存在'
  const afterLocation = change.type === 'delete-page' ? '回收站' : changeSummary(change, pages, notebooks)
  const rows = [
    change.before?.title !== change.after.title && ['标题', change.before?.title ?? '不存在', change.after.title],
    (change.before?.sectionId !== change.after.sectionId || change.before?.parentPageId !== change.after.parentPageId || change.type === 'delete-page') && ['位置', beforeLocation, afterLocation],
  ].filter((row): row is string[] => Boolean(row))
  if (!rows.length) return null
  return <div className="ai-metadata-diff">
    {rows.map(([label, before, after]) => <div key={label}><strong>{label}</strong><span>{before}</span><b>→</b><span>{after}</span></div>)}
  </div>
}

function MarkdownDiff({ change, view }: { change: AutomationProposalChange; view: DiffView }) {
  const before = change.before?.markdown ?? ''
  const after = change.type === 'delete-page' ? '' : change.after.markdown
  const parts = useMemo(() => diffLines(before, after), [after, before])
  if (parts.every((part) => !part.added && !part.removed)) return <div className="ai-diff-no-content">正文没有变化；请审阅上方的标题或层级差异。</div>
  if (view === 'unified') return <div className="ai-unified-diff" aria-label="统一正文差异">
    {parts.map((part, index) => <pre key={index} className={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'}>{prefixLines(part.value, part.added ? '+ ' : part.removed ? '- ' : '  ')}</pre>)}
  </div>
  const beforeRows: Array<{ value: string; kind: string }> = []
  const afterRows: Array<{ value: string; kind: string }> = []
  for (const part of parts) {
    const lines = toLines(part.value)
    if (part.added) {
      beforeRows.push(...lines.map(() => ({ value: '', kind: 'empty' })))
      afterRows.push(...lines.map((value) => ({ value, kind: 'added' })))
    } else if (part.removed) {
      beforeRows.push(...lines.map((value) => ({ value, kind: 'removed' })))
      afterRows.push(...lines.map(() => ({ value: '', kind: 'empty' })))
    } else {
      beforeRows.push(...lines.map((value) => ({ value, kind: 'unchanged' })))
      afterRows.push(...lines.map((value) => ({ value, kind: 'unchanged' })))
    }
  }
  return <div className="ai-side-diff" aria-label="并排正文差异">
    <div><header>修改前</header>{beforeRows.map((row, index) => <pre key={index} className={row.kind}><span>{index + 1}</span>{row.value || ' '}</pre>)}</div>
    <div><header>修改后</header>{afterRows.map((row, index) => <pre key={index} className={row.kind}><span>{index + 1}</span>{row.value || ' '}</pre>)}</div>
  </div>
}

function toLines(value: string) {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length ? lines : ['']
}

function prefixLines(value: string, prefix: string) {
  return value.split('\n').map((line, index, lines) => index < lines.length - 1 ? `${prefix}${line}\n` : line).join('')
}

function statusLabel(status: AutomationProposal['status']) {
  return status === 'pending' ? '待审阅' : status === 'applied' ? '已应用' : status === 'rejected' ? '已放弃' : '已过期'
}

export function mentionSearch(value: string) {
  if (/\s$/.test(value)) return undefined
  const match = value.match(/(?:^|\s)@([^\s@\n]*)$/)
  return match?.[1]
}

export function replaceMentionQuery(value: string, replacement: string) {
  return value.replace(/(^|\s)@[^\s@\n]*$/, (_all, prefix: string) => `${prefix}${replacement}`)
}

function mergeContextBundles(bundles: AIContextBundle[]): AIContextBundle {
  const first = bundles[0]!
  const items = [...new Map(bundles.flatMap((bundle) => bundle.items).map((item) => [item.key, item])).values()]
  return {
    ...first,
    items,
    markdown: items.map((item) => `<!-- notebook-ai-source:start key="${item.key}" -->\n来源：${item.title}（${item.pageId}）\n\n${item.markdown}\n<!-- notebook-ai-source:end key="${item.key}" -->`).join('\n\n'),
    warnings: bundles.flatMap((bundle) => bundle.warnings),
    totalCharacters: items.reduce((total, item) => total + item.markdown.length, 0),
    truncated: bundles.some((bundle) => bundle.truncated),
  }
}

function PaneResizer({ value, min, max, direction, onChange, label }: {
  value: number
  min: number
  max: number
  direction: 1 | -1
  onChange(value: number): void
  label: string
}) {
  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX
    const start = value
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => onChange(Math.min(max, Math.max(min, start + (moveEvent.clientX - startX) * direction)))
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  return <div className="ai-pane-resizer" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} onPointerDown={begin} />
}
