import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input } from '@fluentui/react-components'
import { Document20Regular, Search20Regular } from '@fluentui/react-icons'
import type { PageSummary } from '../model'
import { createReferenceId, type NotebookReferenceTarget } from '@notebook/sync-contract'
import { insertNotebookReference } from './referenceCommands'

type ContentNode = { type?: string; attrs?: Record<string, unknown>; text?: string; content?: ContentNode[] }
type Candidate = {
  key: string
  kind: 'block' | 'group'
  title: string
  subtitle: string
  fullContent: string
  targetId?: string
  path?: number[]
}
type CandidatePreview = {
  candidate: Candidate
  left: number
  top: number
}

function fullBlockContent(node: ContentNode): string {
  if (node.text) return node.text
  const children = (node.content ?? []).filter((child) => child.type !== 'blockAnchor')
  if (node.type === 'doc' || node.type === 'blockGroup') {
    return children.map(fullBlockContent).filter(Boolean).join('\n\n')
  }
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
    return children.map(fullBlockContent).join('')
  }
  return children.map(fullBlockContent).filter(Boolean).join('\n')
}

function compactPreview(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 140) : '暂无摘要'
}

function referenceCandidates(document: Record<string, unknown>): Candidate[] {
  const result: Candidate[] = []
  const visit = (node: ContentNode, path: number[]) => {
    if (node.type === 'blockGroup') {
      const groupId = typeof node.attrs?.groupId === 'string' ? node.attrs.groupId : ''
      const fullContent = fullBlockContent(node).trim()
      if (groupId) result.push({
        key: `group:${groupId}`,
        kind: 'group',
        targetId: groupId,
        title: typeof node.attrs?.title === 'string' && node.attrs.title ? node.attrs.title : '连续内容',
        subtitle: fullContent.replace(/\s+/g, ' ').slice(0, 100),
        fullContent: fullContent || '这个连续内容块目前没有文字',
      })
    }
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
      const anchor = node.content?.find((child) => child.type === 'blockAnchor')
      const anchorId = typeof anchor?.attrs?.anchorId === 'string' ? anchor.attrs.anchorId : undefined
      const fullContent = fullBlockContent(node).trim()
      const text = fullContent.replace(/\s+/g, ' ')
      if (text) result.push({
        key: `${path.join('.')}:${anchorId ?? text.slice(0, 24)}`,
        kind: 'block',
        targetId: anchorId,
        path,
        title: node.type === 'heading' ? `标题 · ${text.slice(0, 70)}` : node.type === 'codeBlock' ? `代码 · ${text.slice(0, 70)}` : text.slice(0, 70),
        subtitle: node.type === 'heading' ? '标题及定位点' : '单个内容块',
        fullContent,
      })
    }
    node.content?.forEach((child, index) => visit(child, [...path, index]))
  }
  visit(document as ContentNode, [])
  return result.slice(0, 300)
}

function addAnchor(document: Record<string, unknown>, path: number[], anchorId: string) {
  const clone = structuredClone(document) as ContentNode
  let node = clone
  for (const index of path) {
    const child = node.content?.[index]
    if (!child) throw new Error('目标段落已经变化，请重新选择')
    node = child
  }
  node.content = [...(node.content ?? []), { type: 'blockAnchor', attrs: { anchorId } }]
  return clone as Record<string, unknown>
}

function wrapTopLevelRange(document: Record<string, unknown>, paths: number[][], groupId: string, title?: string) {
  const indexes = paths.map((path) => path.length === 1 ? path[0]! : -1).sort((left, right) => left - right)
  if (!indexes.length || indexes.some((index) => index < 0)) {
    throw new Error('连续内容目前只支持顶层段落、标题或代码块')
  }
  const clone = structuredClone(document) as ContentNode
  const content = clone.content ?? []
  const first = indexes[0]!
  const selected = content.slice(first, indexes[indexes.length - 1]! + 1)
  if (selected.some((node) => node.type === 'blockGroup')) throw new Error('不能创建交叉或嵌套的连续块组')
  content.splice(first, selected.length, {
    type: 'blockGroup',
    attrs: { groupId, title: title?.trim() || null },
    content: selected,
  })
  clone.content = content
  return clone as Record<string, unknown>
}

export function ReferencePicker({
  pages,
  currentPageId,
  loadDocument,
  saveDocument,
  onClose,
}: {
  pages: PageSummary[]
  currentPageId: string
  loadDocument: (pageId: string) => Promise<Record<string, unknown> | undefined>
  saveDocument: (pageId: string, document: Record<string, unknown>) => Promise<void>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [pageId, setPageId] = useState(currentPageId)
  const [document, setDocument] = useState<Record<string, unknown> | null>()
  const [embed, setEmbed] = useState(true)
  const [alias, setAlias] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [selectedCandidateKeys, setSelectedCandidateKeys] = useState<string[]>([])
  const [candidatePreview, setCandidatePreview] = useState<CandidatePreview>()
  const previewCloseTimer = useRef<number | undefined>(undefined)
  const visiblePages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return pages.filter((page) => page.kind !== 'task' && (!normalized || `${page.title} ${page.preview}`.toLocaleLowerCase().includes(normalized))).slice(0, 100)
  }, [pages, query])
  const candidates = useMemo(() => document ? referenceCandidates(document) : [], [document])
  const selectedPage = pages.find((page) => page.id === pageId)

  useEffect(() => {
    let cancelled = false
    setDocument(undefined)
    setError(undefined)
    setSelectedCandidateKeys([])
    setCandidatePreview(undefined)
    void loadDocument(pageId).then((value) => { if (!cancelled) setDocument(value ?? null) }).catch((cause) => {
      if (!cancelled) setError(`读取目标失败：${cause instanceof Error ? cause.message : '无法读取目标页面'}`)
    })
    return () => { cancelled = true }
  }, [loadDocument, pageId])

  useEffect(() => () => {
    if (previewCloseTimer.current !== undefined) window.clearTimeout(previewCloseTimer.current)
  }, [])

  const cancelPreviewClose = () => {
    if (previewCloseTimer.current === undefined) return
    window.clearTimeout(previewCloseTimer.current)
    previewCloseTimer.current = undefined
  }

  const openCandidatePreview = (candidate: Candidate, element: HTMLElement) => {
    cancelPreviewClose()
    const bounds = element.getBoundingClientRect()
    const previewWidth = Math.min(400, window.innerWidth - 24)
    const previewHeight = Math.min(360, window.innerHeight - 24)
    const gap = 10
    const left = bounds.right + gap + previewWidth <= window.innerWidth - 12
      ? bounds.right + gap
      : Math.max(12, bounds.left - previewWidth - gap)
    const top = Math.max(12, Math.min(bounds.top, window.innerHeight - previewHeight - 12))
    setCandidatePreview({ candidate, left, top })
  }

  const schedulePreviewClose = () => {
    cancelPreviewClose()
    previewCloseTimer.current = window.setTimeout(() => {
      setCandidatePreview(undefined)
      previewCloseTimer.current = undefined
    }, 120)
  }

  const finish = (target: NotebookReferenceTarget) => {
    insertNotebookReference({ target, embed, ...(alias.trim() ? { alias: alias.trim() } : {}) })
    onClose()
  }

  const chooseCandidate = async (candidate: Candidate) => {
    if (!selectedPage || loading) return
    setLoading(true)
    setError(undefined)
    try {
      if (embed && selectedPage.id === currentPageId) throw new Error('当前页面不能嵌入自身，请选择其他页面或切换为只显示链接')
      if (candidate.kind === 'group' && candidate.targetId) {
        finish({ pageId: selectedPage.id, kind: 'group', targetId: candidate.targetId })
        return
      }
      if (!candidate.path || !document) throw new Error('目标内容尚未载入')
      const targetId = candidate.targetId ?? createReferenceId('b')
      if (!candidate.targetId) {
        const next = addAnchor(document, candidate.path, targetId)
        await saveDocument(selectedPage.id, next)
      }
      finish({ pageId: selectedPage.id, kind: 'block', targetId })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建引用')
    } finally {
      setLoading(false)
    }
  }

  const createGroup = async () => {
    if (!selectedPage || !document || loading) return
    setLoading(true)
    setError(undefined)
    try {
      const selected = candidates.filter((candidate) => selectedCandidateKeys.includes(candidate.key))
      const paths = selected.flatMap((candidate) => candidate.kind === 'block' && candidate.path ? [candidate.path] : [])
      const selectable = candidates.filter((candidate) => candidate.kind === 'block' && candidate.path?.length === 1)
      const visibleIndexes = selected.map((candidate) => selectable.findIndex((item) => item.key === candidate.key)).sort((left, right) => left - right)
      const visiblyAdjacent = visibleIndexes.every((index, position) => position === 0 || index === visibleIndexes[position - 1]! + 1)
      if (paths.length < 2 || paths.length !== selected.length || !visiblyAdjacent) {
        throw new Error('请在右侧列表中选择连续的两个或多个内容块')
      }
      if (embed && selectedPage.id === currentPageId) throw new Error('当前页面不能嵌入自身')
      const groupId = createReferenceId('g')
      await saveDocument(selectedPage.id, wrapTopLevelRange(document, paths, groupId, alias))
      finish({ pageId: selectedPage.id, kind: 'group', targetId: groupId })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建连续块组')
    } finally {
      setLoading(false)
    }
  }

  return <div className="settings-backdrop reference-picker-backdrop" role="presentation">
    <section className="settings-dialog reference-picker" role="dialog" aria-modal="true" aria-label="插入双链">
      <header><div><h2>插入双链</h2><p>可链接或嵌入整篇、单个内容块、连续内容；动态显示会随原文更新。</p></div><Button appearance="subtle" onClick={onClose}>取消</Button></header>
      <div className="reference-picker-options">
        <label><input type="radio" checked={embed} onChange={() => setEmbed(true)} /> 嵌入原文内容</label>
        <label><input type="radio" checked={!embed} onChange={() => setEmbed(false)} /> 动态链接</label>
        <Input value={alias} onChange={(_, data) => setAlias(data.value)} placeholder="固定显示文字（留空则随目标更新）" aria-label="引用显示文字" />
      </div>
      <div className="reference-picker-grid">
        <div className="reference-page-column">
          <Input autoFocus contentBefore={<Search20Regular />} value={query} onChange={(_, data) => setQuery(data.value)} placeholder="搜索页面" aria-label="搜索引用页面" />
          <div className="reference-page-list">
            {visiblePages.map((page) => <button key={page.id} className={page.id === pageId ? 'selected' : ''} onClick={() => setPageId(page.id)}><Document20Regular /><span><strong>{page.title}</strong><small>{compactPreview(page.preview)}</small></span></button>)}
          </div>
        </div>
        <div className="reference-target-column">
          <div className="reference-target-heading"><strong>{selectedPage?.title ?? '选择页面'}</strong><div><Button size="small" appearance="subtle" disabled={selectedCandidateKeys.length < 2 || loading} onClick={() => void createGroup()}>{embed ? '嵌入所选段落' : '链接所选段落'}</Button><Button size="small" appearance="primary" disabled={!selectedPage || (embed && selectedPage.id === currentPageId)} onClick={() => selectedPage && finish({ pageId: selectedPage.id, kind: 'page' })}>{embed ? '嵌入整篇' : '链接整篇'}</Button></div></div>
          {embed && selectedPage?.id === currentPageId && <p className="reference-hint">当前页面不能嵌入自身，但可以创建普通链接或选择其他页面。</p>}
          <div className="reference-target-list" onScroll={() => setCandidatePreview(undefined)}>
            {document === undefined && !error && <p>正在读取页面内容…</p>}
            {document === null && !error && <p>这个页面还没有正文，可以先链接整篇。</p>}
            {document && candidates.length === 0 && <p>这个页面还没有可引用的正文。</p>}
            {candidates.map((candidate) => <div
              className="reference-target-row"
              key={candidate.key}
              onMouseEnter={(event) => openCandidatePreview(candidate, event.currentTarget)}
              onMouseLeave={schedulePreviewClose}
              onFocus={(event) => openCandidatePreview(candidate, event.currentTarget)}
              onBlur={schedulePreviewClose}
            >
              {candidate.kind === 'block' && candidate.path?.length === 1 ? <input type="checkbox" checked={selectedCandidateKeys.includes(candidate.key)} aria-label={`选择${candidate.title}`} onChange={(event) => {
                const checked = event.currentTarget.checked
                setSelectedCandidateKeys((current) => checked ? [...current, candidate.key] : current.filter((key) => key !== candidate.key))
              }} /> : <span className="reference-target-checkbox-spacer" />}
              <button disabled={loading || (embed && selectedPage?.id === currentPageId)} onClick={() => void chooseCandidate(candidate)}><span><strong>{candidate.title}</strong><small>{candidate.subtitle}</small></span><em>{embed ? candidate.kind === 'group' ? '嵌入连续内容' : '嵌入此段' : candidate.kind === 'group' ? '链接连续内容' : '链接此段'}</em></button>
            </div>)}
          </div>
        </div>
      </div>
      {error && <p className="reference-error" role="alert">{error}</p>}
    </section>
    {candidatePreview && createPortal(<aside
        className="reference-candidate-preview"
        role="tooltip"
        aria-label="块完整内容"
        style={{ left: candidatePreview.left, top: candidatePreview.top }}
        onMouseEnter={cancelPreviewClose}
        onMouseLeave={schedulePreviewClose}
      >
        <header>
          <strong>{candidatePreview.candidate.kind === 'group' ? '连续内容预览' : '内容块预览'}</strong>
          <span>完整内容</span>
        </header>
        <div>{candidatePreview.candidate.fullContent}</div>
      </aside>, window.document.body)}
  </div>
}
