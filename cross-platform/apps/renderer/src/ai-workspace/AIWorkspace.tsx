import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Button, Switch } from '@fluentui/react-components'
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
import {
  retrieveNotebookLibrary,
  retrievalResultToAIContext,
  type NotebookRetrievalChunk,
} from '../ai/libraryRetrieval'
import { documentToMarkdown } from '../editor/extensions'
import { pageLocation } from '../automation/workspaceReview'
import type { NotebookAgentProposalInput } from '../automation/automationBridge'

type ReviewDecision = 'accepted' | 'rejected'
type DiffView = 'editorial' | 'side-by-side' | 'unified'
type AssistantMode = 'ask' | 'edit'
type CompactPane = 'changes' | 'review' | 'chat'
type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  mode?: AssistantMode
  content: string
  pageIds?: string[]
  failed?: boolean
  sources?: NotebookRetrievalChunk[]
  retrievalWarnings?: string[]
}

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
  searchWorkspace(query: string, limit?: number): Promise<PageSummary[]>
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
  searchWorkspace,
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
  const [diffView, setDiffView] = useState<DiffView>('editorial')
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('ask')
  const [compactPane, setCompactPane] = useState<CompactPane>('chat')
  const [leftWidth, setLeftWidth] = useState(300)
  const [rightWidth, setRightWidth] = useState(380)
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: crypto.randomUUID(), role: 'system', content: 'AI 的建议会先进入暂存区。只有你批准的页面才会写入历史并参加同步。' },
  ])
  const [mentionedPageIds, setMentionedPageIds] = useState<string[]>(currentPage.id && !currentPage.locked ? [currentPage.id] : [])
  const [writebackPageId, setWritebackPageId] = useState(currentPage.locked ? '' : currentPage.id)
  const [contextScope, setContextScope] = useState<NotebookAIContextScope>('embeds')
  const [libraryRetrievalEnabled, setLibraryRetrievalEnabled] = useState(true)
  const [chatState, setChatState] = useState<'idle' | 'streaming' | 'error'>('idle')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>()
  const abortRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    if (proposal) setProposalId(proposal.id)
  }, [proposal])
  useEffect(() => {
    if (!proposal) return
    setSelectedChangeId((current) => current && proposal.changes.some((change) => change.id === current) ? current : proposal.changes[0]?.id)
    setDecisions(Object.fromEntries(proposal.changes.map((change) => {
      if (proposal.rejectedChangeIds?.includes(change.id) || proposal.status === 'rejected') return [change.id, 'rejected' as const]
      return [change.id, 'accepted' as const]
    })))
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
    if (!normalized || chatState === 'streaming' || abortRef.current) return
    const roots = mentionedPageIds.length ? mentionedPageIds : currentPage.id && !currentPage.locked ? [currentPage.id] : []
    if (!roots.length && !libraryRetrievalEnabled) {
      setStatus('请先用 @ 指定至少一篇笔记，或启用“检索笔记库”。')
      return
    }
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', mode: 'ask', content: normalized, pageIds: roots }
    const assistantId = crypto.randomUUID()
    setMessages((value) => [...value, userMessage, { id: assistantId, role: 'assistant', mode: 'ask', content: '' }])
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
      let retrievalWarnings: string[] = []
      if (libraryRetrievalEnabled) {
        setMessages((value) => value.map((message) => message.id === assistantId
          ? { ...message, content: '正在本机检索相关笔记…' }
          : message))
        let retrievalChunks: NotebookRetrievalChunk[] = []
        try {
          const candidates = (await boundedSearch(searchWorkspace(normalized, 20), controller.signal))
            .filter((page) => !roots.includes(page.id) && !page.locked && page.kind !== 'task')
          const retrieval = await retrieveNotebookLibrary({
            query: normalized,
            candidatePages: candidates,
            loadDocument,
            signal: controller.signal,
          })
          retrievalWarnings = retrieval.warnings
          retrievalChunks = retrieval.chunks
          if (retrieval.chunks.length) bundles.push(retrievalResultToAIContext(retrieval))
        } catch (error) {
          controller.signal.throwIfAborted()
          retrievalWarnings = [error instanceof Error && error.message === '本地检索超时'
            ? '本地索引仍在准备，本次已改用 @ 上下文；稍后重试可使用检索结果'
            : '本地检索暂时不可用，本次已改用 @ 上下文']
        }
        setMessages((value) => value.map((message) => message.id === userMessage.id
          ? { ...message, sources: retrievalChunks, retrievalWarnings }
          : message.id === assistantId ? { ...message, content: '' } : message))
      }
      if (!bundles.length) throw new Error('本地没有检索到相关笔记。请换一个更具体的问题，或用 @ 指定页面。')
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
        setMessages((value) => value.map((message) => message.id === assistantId ? {
          ...message,
          content: error instanceof Error ? error.message : 'AI 服务暂时不可用。',
          failed: true,
        } : message))
        setChatState('error')
      }
    } finally {
      abortRef.current = undefined
    }
  }

  const createAgentProposal = async () => {
    const normalized = prompt.trim()
    if (!normalized || chatState === 'streaming' || abortRef.current) return
    const roots = mentionedPageIds.length ? mentionedPageIds : currentPage.id && !currentPage.locked ? [currentPage.id] : []
    if (!roots.length) {
      setStatus('请先用 @ 指定允许 AI 修改的文章。')
      return
    }
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', mode: 'edit', content: normalized, pageIds: roots }
    const assistantId = crypto.randomUUID()
    setMessages((value) => [...value, userMessage, { id: assistantId, role: 'assistant', mode: 'edit', content: '正在生成结构化修改提案…' }])
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
      setCompactPane('changes')
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
      setCompactPane('changes')
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
  const changeGroups = useMemo(
    () => proposal ? groupProposalChanges(proposal.changes, pages, notebooks) : [],
    [notebooks, pages, proposal],
  )
  const selectedChangeIndex = proposal && selectedChange
    ? proposal.changes.findIndex((change) => change.id === selectedChange.id)
    : -1
  const proposalCounts = useMemo(
    () => proposal ? summarizeProposalChanges(proposal.changes) : undefined,
    [proposal],
  )
  const latestRetrieval = [...messages].reverse().find((message) => message.role === 'user' && message.sources)
  const activityText = chatState === 'streaming'
    ? assistantMode === 'ask' ? '正在检索并组织回答' : '正在生成结构化修改草案'
    : proposal?.status === 'pending'
      ? `${proposal.changes.length} 项草案等待审阅`
      : latestRetrieval?.sources?.length
        ? `上次问答使用了 ${latestRetrieval.sources.length} 个本机片段`
        : '问答不写入；修改先进入暂存区'

  const selectChange = (changeId: string) => {
    setSelectedChangeId(changeId)
    setCompactPane('review')
  }

  const selectAdjacentChange = (offset: -1 | 1) => {
    if (!proposal?.changes.length || selectedChangeIndex < 0) return
    const next = proposal.changes[selectedChangeIndex + offset]
    if (next) selectChange(next.id)
  }

  const toggleDecision = (changeId: string) => {
    setDecisions((value) => ({
      ...value,
      [changeId]: value[changeId] === 'rejected' ? 'accepted' : 'rejected',
    }))
  }

  const submitPrompt = () => assistantMode === 'ask' ? send() : createAgentProposal()

  return <section className="ai-workspace" aria-label="Notebook AI 校订台">
    <header className="ai-workspace-topbar">
      <div className="ai-workspace-identity">
        <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onClose}>返回笔记</Button>
        <span className="ai-workspace-orb"><Bot20Filled /></span>
        <span><strong>AI 校订台</strong><small>讨论、生成草案、逐项审阅</small></span>
        <span className="ai-workspace-count">{pendingCount} 项待审阅</span>
      </div>
      <div className="ai-workspace-batch-actions">
        {proposal && <select aria-label="AI 修改批次" value={proposal.id} onChange={(event) => setProposalId(event.currentTarget.value)}>
          {proposals.map((item) => <option key={item.id} value={item.id}>{statusLabel(item.status)} · {item.title}（{item.changes.length}）</option>)}
        </select>}
        <Button disabled={!proposal || proposal.status !== 'pending' || busy} onClick={() => void discardProposal()}>放弃整批</Button>
        <Button appearance="primary" icon={<Checkmark20Regular />} disabled={!proposal || proposal.status !== 'pending' || !acceptedCount || busy} onClick={() => void applyAccepted()}>
          {proposal?.status === 'applied' ? `已应用 ${proposal.acceptedChangeIds?.length ?? proposal.changes.length} 项` : `应用 ${acceptedCount} 项`}
        </Button>
      </div>
    </header>
    {status && <div className="ai-workspace-status" role="status">{status}</div>}
    <nav className="ai-compact-nav" aria-label="AI 工作区面板">
      <button className={compactPane === 'changes' ? 'selected' : ''} onClick={() => setCompactPane('changes')}>变化 {proposal?.changes.length ?? 0}</button>
      <button className={compactPane === 'review' ? 'selected' : ''} onClick={() => setCompactPane('review')}>校订</button>
      <button className={compactPane === 'chat' ? 'selected' : ''} onClick={() => setCompactPane('chat')}>AI 协作</button>
    </nav>
    <div
      className="ai-workspace-grid"
      style={{ '--ai-change-width': `${leftWidth}px`, '--ai-chat-width': `${rightWidth}px` } as CSSProperties}
    >
      <aside className={`ai-change-pane ${compactPane === 'changes' ? 'compact-active' : ''}`}>
        <header>
          <div><strong>本批变化</strong><small>按笔记本与页面层级排列</small></div>
          <span>{proposal?.changes.length ?? 0}</span>
        </header>
        {proposalCounts && <div className="ai-change-summary" aria-label="变化统计">
          {proposalCounts.modified > 0 && <span><b>{proposalCounts.modified}</b> 修改</span>}
          {proposalCounts.created > 0 && <span><b>{proposalCounts.created}</b> 新建</span>}
          {proposalCounts.moved > 0 && <span><b>{proposalCounts.moved}</b> 移动/改名</span>}
          {proposalCounts.deleted > 0 && <span><b>{proposalCounts.deleted}</b> 删除</span>}
        </div>}
        {!proposal && <div className="ai-workspace-empty">
          <Bot20Filled />
          <strong>还没有修改草案</strong>
          <p>到“AI 协作”选择“修改笔记”，用 @ 授权页面后生成草案。</p>
          <Button size="small" onClick={() => setCompactPane('chat')}>去 AI 协作</Button>
        </div>}
        {proposal && <div className="ai-change-list">
          {changeGroups.map((group) => <section className="ai-change-group" key={group.id}>
            <header><span>{group.emoji}</span><strong>{group.label}</strong><small>{group.items.length}</small></header>
            {group.items.map(({ change, depth }) => {
              const decision = decisions[change.id] ?? 'accepted'
              return <button
                type="button"
                key={change.id}
                className={`ai-change-row ${selectedChange?.id === change.id ? 'selected' : ''} ${decision}`}
                style={{ '--ai-tree-depth': depth } as CSSProperties}
                onClick={() => selectChange(change.id)}
              >
                <span className={`ai-change-kind ${changeKind(change).tone}`}>{changeKind(change).label}</span>
                <span><strong>{change.after.title}</strong><small>{changeSummary(change, pages, notebooks)}</small></span>
                <span className="ai-change-decision">{decisionLabel(proposal.status, decision)}</span>
              </button>
            })}
          </section>)}
        </div>}
        {proposal && <footer>
          <small>检查点 {new Date(proposal.createdAt).toLocaleString()}</small>
          <small>{statusLabel(proposal.status)}</small>
        </footer>}
      </aside>
      <PaneResizer value={leftWidth} min={240} max={520} direction={1} onChange={setLeftWidth} label="调整变化目录宽度" />
      <main className={`ai-diff-pane ${compactPane === 'review' ? 'compact-active' : ''}`}>
        {!selectedChange ? <div className="ai-workspace-empty">
          <Document20Regular />
          <strong>选择一项变化开始校订</strong>
          <p>标题、层级与正文差异会分别展示；没有批准前不会改动笔记。</p>
        </div> : <>
          <header className="ai-diff-header">
            <div className="ai-diff-title">
              <span className={`ai-change-kind ${changeKind(selectedChange).tone}`}>{changeKind(selectedChange).label}</span>
              <div><strong>{selectedChange.after.title}</strong><small>{changeSummary(selectedChange, pages, notebooks)}</small></div>
            </div>
            <div className="ai-diff-tools">
              <div className="ai-diff-view-toggle" role="group" aria-label="差异显示方式">
                <button className={diffView === 'editorial' ? 'selected' : ''} onClick={() => setDiffView('editorial')}>校订</button>
                <button className={diffView === 'side-by-side' ? 'selected' : ''} onClick={() => setDiffView('side-by-side')}>并排</button>
                <button className={diffView === 'unified' ? 'selected' : ''} onClick={() => setDiffView('unified')}>源码</button>
              </div>
              {selectedChange.type !== 'create-page' && <Button size="small" appearance="subtle" onClick={() => onOpenPage(selectedChange.after.pageId)}>打开原笔记</Button>}
            </div>
          </header>
          <MetadataDiff change={selectedChange} pages={pages} notebooks={notebooks} />
          <MarkdownDiff change={selectedChange} view={diffView} />
          <footer className="ai-review-footer">
            <div>
              <Button size="small" appearance="subtle" disabled={selectedChangeIndex <= 0} onClick={() => selectAdjacentChange(-1)}>上一项</Button>
              <span>{selectedChangeIndex + 1} / {proposal?.changes.length ?? 0}</span>
              <Button size="small" appearance="subtle" disabled={!proposal || selectedChangeIndex >= proposal.changes.length - 1} onClick={() => selectAdjacentChange(1)}>下一项</Button>
            </div>
            {proposal?.status === 'pending' ? <Button
              size="small"
              appearance={decisions[selectedChange.id] === 'rejected' ? 'primary' : 'secondary'}
              icon={decisions[selectedChange.id] === 'rejected' ? <Checkmark20Regular /> : <Dismiss20Regular />}
              onClick={() => toggleDecision(selectedChange.id)}
            >
              {decisions[selectedChange.id] === 'rejected' ? '恢复此项' : '忽略此项'}
            </Button> : <span className="ai-review-readonly">{decisionLabel(proposal?.status ?? 'stale', decisions[selectedChange.id] ?? 'accepted')}</span>}
          </footer>
        </>}
      </main>
      <PaneResizer value={rightWidth} min={320} max={620} direction={-1} onChange={setRightWidth} label="调整 AI 对话宽度" />
      <aside className={`ai-chat-pane ${compactPane === 'chat' ? 'compact-active' : ''}`}>
        <header>
          <div><span className="ai-workspace-orb"><Bot20Filled /></span><div><strong>AI 协作</strong><small>{activityText}</small></div></div>
          <Button size="small" appearance="subtle" disabled={chatState === 'streaming'} onClick={() => {
            setMessages([])
            setMentionedPageIds(currentPage.id && !currentPage.locked ? [currentPage.id] : [])
            setStatus(undefined)
          }}>新对话</Button>
        </header>
        <div className="ai-assistant-mode" role="group" aria-label="AI 使用方式">
          <button disabled={chatState === 'streaming'} className={assistantMode === 'ask' ? 'selected' : ''} onClick={() => setAssistantMode('ask')}>
            <strong>问笔记库</strong><small>检索并回答，不修改</small>
          </button>
          <button disabled={chatState === 'streaming'} className={assistantMode === 'edit' ? 'selected' : ''} onClick={() => setAssistantMode('edit')}>
            <strong>修改笔记</strong><small>仅操作 @ 授权页面</small>
          </button>
        </div>
        <div className="ai-chat-context">
          <span>{assistantMode === 'ask' ? '指定参考' : '允许修改'}</span>
          {mentionedPageIds.map((id) => {
            const page = pages.find((item) => item.id === id)
            return page && <button key={id} title="移出上下文" onClick={() => setMentionedPageIds((value) => value.filter((item) => item !== id))}>@{page.title} ×</button>
          })}
          <select aria-label="AI 引用展开范围" value={contextScope} onChange={(event) => setContextScope(event.currentTarget.value as NotebookAIContextScope)}>
            <option value="current">仅指定页面</option>
            <option value="embeds">含嵌入内容</option>
            <option value="all">含全部链接</option>
          </select>
          {assistantMode === 'ask' && <Switch
            className="ai-library-retrieval-switch"
            checked={libraryRetrievalEnabled}
            disabled={chatState === 'streaming'}
            onChange={(_, data) => setLibraryRetrievalEnabled(data.checked)}
            label="检索笔记库"
          />}
          {assistantMode === 'ask' && <select aria-label="AI 回答暂存目标" value={writebackPageId} onChange={(event) => setWritebackPageId(event.currentTarget.value)}>
            {(mentionedPageIds.length ? mentionedPageIds : currentPage.id && !currentPage.locked ? [currentPage.id] : []).flatMap((id) => pages.find((page) => page.id === id && !page.locked) ?? []).map((page) => <option key={page.id} value={page.id}>可暂存到：{page.title}</option>)}
          </select>}
          <small className="ai-chat-scope-note">
            {assistantMode === 'ask'
              ? libraryRetrievalEnabled ? '本机先筛选，只发送相关片段；回答不会自动写入' : '只发送 @ 指定内容；回答不会自动写入'
              : '修改权限严格限定在 @ 页面；生成结果只进入草案'}
          </small>
        </div>
        <div className="ai-chat-messages">
          {messages.length === 0 && <div className="ai-chat-welcome"><Bot20Filled /><strong>{assistantMode === 'ask' ? '根据笔记库回答' : '安全地整理笔记'}</strong><p>{assistantMode === 'ask'
            ? '直接提问可在本机检索相关片段；用 @ 可以明确指定参考页面。每次回答都会显示实际使用的来源。'
            : '先用 @ 指定允许修改的页面，再说明改名、移动、整理或改写要求。所有结果都要经过左侧逐项审阅。'}</p></div>}
          {messages.map((message) => <article key={message.id} className={`ai-chat-message ${message.role}${message.failed ? ' error' : ''}`}>
            <header>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Notebook AI' : '安全边界'}</header>
            <p>{message.content || (chatState === 'streaming' ? '正在生成…' : '')}</p>
            {message.sources && (message.sources.length > 0 || message.retrievalWarnings?.length) && <RetrievedSources
              sources={message.sources}
              warnings={message.retrievalWarnings}
              onOpenPage={onOpenPage}
            />}
            {message.role === 'assistant' && message.mode !== 'edit' && message.content && !message.failed && chatState !== 'streaming' && <div>
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
            placeholder={assistantMode === 'ask' ? '询问笔记库，或输入 @ 指定参考页面…' : '先输入 @ 授权页面，再说明要如何修改…'}
            aria-label={assistantMode === 'ask' ? '向笔记库提问' : '说明笔记修改要求'}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !mentionCandidates.length) {
                event.preventDefault()
                void submitPrompt()
              }
            }}
          />
          <footer>
            <span>{assistantMode === 'ask' ? 'Enter 发送 · Shift+Enter 换行' : '修改先暂存，批准后才产生历史与同步'}</span>
            {chatState === 'streaming'
              ? <Button icon={<Dismiss20Regular />} onClick={() => abortRef.current?.abort()}>停止</Button>
              : <Button
                appearance="primary"
                icon={assistantMode === 'ask' ? <Send20Regular /> : <Bot20Filled />}
                disabled={!prompt.trim()}
                onClick={() => void submitPrompt()}
              >
                {assistantMode === 'ask' ? '发送问题' : '生成修改草案'}
              </Button>}
          </footer>
        </div>
      </aside>
    </div>
  </section>
}

function boundedSearch<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs = 6_000) {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    const timer = window.setTimeout(() => finish(() => reject(new Error('本地检索超时'))), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
  })
}

function RetrievedSources({
  sources,
  warnings,
  onOpenPage,
}: {
  sources: NotebookRetrievalChunk[]
  warnings?: string[]
  onOpenPage(pageId: string): void
}) {
  const pageCount = new Set(sources.map((source) => source.pageId)).size
  return <details className="ai-chat-sources">
    <summary>{sources.length
      ? `已发送 ${sources.length} 个相关片段 · 来自 ${pageCount} 篇笔记`
      : '本次未发送检索片段'}</summary>
    <div className="ai-chat-source-list">
      {sources.map((source) => <article key={source.id}>
        <button type="button" onClick={() => onOpenPage(source.pageId)}>
          {source.pageTitle}{source.headingPath.length ? ` › ${source.headingPath.join(' › ')}` : ''}
        </button>
        <pre>{source.markdown}</pre>
      </article>)}
      {warnings && warnings.length > 0 && <small>{warnings.join('；')}</small>}
    </div>
  </details>
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

export function changeSummary(change: AutomationProposalChange, pages: PageSummary[], notebooks: NotebookSummary[]) {
  if (change.type === 'delete-page') return '将移到回收站'
  if (change.type === 'create-page') return locationForState(change.after, pages, notebooks)
  const before = change.before ? locationForState(change.before, pages, notebooks) : '不存在'
  const after = locationForState(change.after, pages, notebooks)
  if (before !== after) return `${before} → ${after}`
  if (change.before?.title !== change.after.title) return `${change.before?.title} → ${change.after.title}`
  if (change.before?.sortOrder !== change.after.sortOrder) {
    return change.before?.markdown !== change.after.markdown ? '同级顺序与正文修改' : '同级顺序调整'
  }
  return '正文修改'
}

function locationForState(
  state: AutomationProposalChange['after'],
  pages: PageSummary[],
  notebooks: NotebookSummary[],
) {
  const existing = pages.find((page) => page.id === state.pageId)
  const page: PageSummary = {
    ...(existing ?? {
      id: state.pageId,
      preview: '',
      updatedLabel: '',
      tags: [],
      kind: 'document' as const,
    }),
    sectionId: state.sectionId ?? existing?.sectionId ?? '',
    parentPageId: state.parentPageId,
    sortOrder: state.sortOrder,
    title: state.title,
  }
  return pageLocation(state.pageId, [...pages.filter((item) => item.id !== state.pageId), page], notebooks)
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

interface ProposalChangeGroup {
  id: string
  label: string
  emoji: string
  items: Array<{ change: AutomationProposalChange; depth: number }>
}

export function groupProposalChanges(
  changes: AutomationProposalChange[],
  pages: PageSummary[],
  notebooks: NotebookSummary[],
): ProposalChangeGroup[] {
  const proposedPages = new Map(pages.map((page) => [page.id, page]))
  for (const change of changes) {
    const existing = proposedPages.get(change.after.pageId)
    proposedPages.set(change.after.pageId, {
      ...(existing ?? pageFromChange(change)),
      title: change.after.title,
      sectionId: change.after.sectionId ?? existing?.sectionId ?? '',
      parentPageId: change.after.parentPageId,
      sortOrder: change.after.sortOrder,
    })
  }
  const sectionToNotebook = new Map(notebooks.flatMap((notebook) =>
    notebook.sections.map((section) => [section.id, notebook] as const)))
  const groups = new Map<string, ProposalChangeGroup>()
  const depthOf = (pageId: string) => {
    let depth = 0
    let parentId = proposedPages.get(pageId)?.parentPageId
    const visited = new Set([pageId])
    while (parentId && !visited.has(parentId) && depth < 8) {
      visited.add(parentId)
      depth += 1
      parentId = proposedPages.get(parentId)?.parentPageId
    }
    return depth
  }
  for (const change of changes) {
    const existing = proposedPages.get(change.after.pageId)
    const sectionId = change.after.sectionId ?? existing?.sectionId ?? change.before?.sectionId ?? ''
    const notebook = sectionToNotebook.get(sectionId)
    const id = notebook?.id ?? 'unassigned'
    const group = groups.get(id) ?? {
      id,
      label: notebook?.name ?? '未归类页面',
      emoji: notebook?.emoji || '📄',
      items: [],
    }
    group.items.push({ change, depth: depthOf(change.after.pageId) })
    groups.set(id, group)
  }
  const notebookOrder = new Map(notebooks.map((notebook, index) => [notebook.id, index]))
  return [...groups.values()].sort((left, right) =>
    (notebookOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (notebookOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
}

export function summarizeProposalChanges(changes: AutomationProposalChange[]) {
  const summary = { modified: 0, created: 0, moved: 0, deleted: 0 }
  for (const change of changes) {
    if (change.type === 'create-page') summary.created += 1
    else if (change.type === 'delete-page') summary.deleted += 1
    else if (
      change.before?.title !== change.after.title
      || change.before?.sectionId !== change.after.sectionId
      || change.before?.parentPageId !== change.after.parentPageId
      || change.before?.sortOrder !== change.after.sortOrder
    ) summary.moved += 1
    else summary.modified += 1
  }
  return summary
}

function MetadataDiff({ change, pages, notebooks }: { change: AutomationProposalChange; pages: PageSummary[]; notebooks: NotebookSummary[] }) {
  const beforeLocation = change.before ? locationForState(change.before, pages, notebooks) : '不存在'
  const afterLocation = change.type === 'delete-page' ? '回收站' : locationForState(change.after, pages, notebooks)
  const rows = [
    change.before?.title !== change.after.title && ['标题', change.before?.title ?? '不存在', change.after.title],
    (change.before?.sectionId !== change.after.sectionId || change.before?.parentPageId !== change.after.parentPageId || change.type === 'delete-page') && ['位置', beforeLocation, afterLocation],
    change.type !== 'delete-page' && change.before?.sortOrder !== change.after.sortOrder && ['顺序', formatSortOrder(change.before?.sortOrder), formatSortOrder(change.after.sortOrder)],
  ].filter((row): row is string[] => Boolean(row))
  if (!rows.length) return null
  return <div className="ai-metadata-diff">
    {rows.map(([label, before, after]) => <div key={label}><strong>{label}</strong><span>{before}</span><b>→</b><span>{after}</span></div>)}
  </div>
}

function formatSortOrder(value?: number) {
  return value === undefined ? '未指定' : `排序值 ${value}`
}

interface VisibleDiffPart {
  value: string
  kind: 'added' | 'removed' | 'unchanged' | 'omitted'
  omittedLines?: number
}

export function compactDiffParts(
  parts: Array<{ value: string; added?: boolean; removed?: boolean }>,
  changedLineBudget = 1_600,
): VisibleDiffPart[] {
  const result: VisibleDiffPart[] = []
  let remainingChangedLines = changedLineBudget
  for (const part of parts) {
    const lines = toLines(part.value)
    const kind = part.added ? 'added' : part.removed ? 'removed' : 'unchanged'
    if (kind === 'unchanged' && lines.length > 12) {
      result.push({ value: lines.slice(0, 4).join('\n'), kind })
      result.push({ value: '', kind: 'omitted', omittedLines: lines.length - 8 })
      result.push({ value: lines.slice(-4).join('\n'), kind })
      continue
    }
    if (kind !== 'unchanged' && lines.length > remainingChangedLines) {
      if (remainingChangedLines > 0) result.push({ value: lines.slice(0, remainingChangedLines).join('\n'), kind })
      result.push({ value: '', kind: 'omitted', omittedLines: lines.length - Math.max(0, remainingChangedLines) })
      remainingChangedLines = 0
      continue
    }
    result.push({ value: part.value, kind })
    if (kind !== 'unchanged') remainingChangedLines -= lines.length
  }
  return result
}

function MarkdownDiff({ change, view }: { change: AutomationProposalChange; view: DiffView }) {
  const before = change.before?.markdown ?? ''
  const after = change.type === 'delete-page' ? '' : change.after.markdown
  const parts = useMemo(() => diffLines(before, after), [after, before])
  if (parts.every((part) => !part.added && !part.removed)) return <div className="ai-diff-no-content">正文没有变化；请审阅上方的标题或层级差异。</div>
  const visibleParts = compactDiffParts(parts)
  const omittedLines = visibleParts.reduce((total, part) => total + (part.omittedLines ?? 0), 0)
  const notice = omittedLines > 0 && <div className="ai-diff-limit-note">为保证超大笔记流畅，已折叠 {omittedLines} 行未变化或超长差异；可打开原笔记查看完整正文。</div>
  if (view === 'editorial') return <div className="ai-editorial-diff" aria-label="校订正文差异">
    {notice}
    <div className="ai-editorial-paper">
      {visibleParts.map((part, index) => part.kind === 'omitted'
        ? <div className="ai-diff-omitted" key={index}>··· {part.omittedLines} 行已折叠 ···</div>
        : part.kind === 'unchanged'
          ? <pre className="unchanged" key={index}>{part.value}</pre>
          : <section className={part.kind} key={index}>
            <header>{part.kind === 'removed' ? '原文' : '建议'}</header>
            <pre>{part.value}</pre>
          </section>)}
    </div>
  </div>
  if (view === 'unified') return <div className="ai-unified-diff" aria-label="统一正文差异">
    {notice}
    {visibleParts.map((part, index) => part.kind === 'omitted'
      ? <div className="ai-diff-omitted" key={index}>··· {part.omittedLines} 行已折叠 ···</div>
      : <pre key={index} className={part.kind}>{prefixLines(part.value, part.kind === 'added' ? '+ ' : part.kind === 'removed' ? '- ' : '  ')}</pre>)}
  </div>
  const beforeRows: Array<{ value: string; kind: string }> = []
  const afterRows: Array<{ value: string; kind: string }> = []
  for (const part of visibleParts) {
    if (part.kind === 'omitted') {
      const label = `··· ${part.omittedLines} 行已折叠 ···`
      beforeRows.push({ value: label, kind: 'omitted' })
      afterRows.push({ value: label, kind: 'omitted' })
      continue
    }
    const lines = toLines(part.value)
    if (part.kind === 'added') {
      beforeRows.push(...lines.map(() => ({ value: '', kind: 'empty' })))
      afterRows.push(...lines.map((value) => ({ value, kind: 'added' })))
    } else if (part.kind === 'removed') {
      beforeRows.push(...lines.map((value) => ({ value, kind: 'removed' })))
      afterRows.push(...lines.map(() => ({ value: '', kind: 'empty' })))
    } else {
      beforeRows.push(...lines.map((value) => ({ value, kind: 'unchanged' })))
      afterRows.push(...lines.map((value) => ({ value, kind: 'unchanged' })))
    }
  }
  return <div className="ai-side-diff" aria-label="并排正文差异">
    <div>{notice}<header>修改前</header>{beforeRows.map((row, index) => <pre key={index} className={row.kind}><span>{row.kind === 'omitted' ? '·' : index + 1}</span>{row.value || ' '}</pre>)}</div>
    <div><header>修改后</header>{afterRows.map((row, index) => <pre key={index} className={row.kind}><span>{row.kind === 'omitted' ? '·' : index + 1}</span>{row.value || ' '}</pre>)}</div>
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

function decisionLabel(status: AutomationProposal['status'], decision: ReviewDecision) {
  if (status === 'pending') return decision === 'accepted' ? '保留' : '忽略'
  if (status === 'applied') return decision === 'accepted' ? '已应用' : '未应用'
  if (status === 'rejected') return '已放弃'
  return '已过期'
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
