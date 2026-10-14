import { useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import { AI_NOT_CONFIGURED, completeAI } from '../ai/completion'
import { cleanModelMarkdown, REWRITE_MODES, rewriteGroup, rewriteMessages, type PlanGroup, type RewriteMode } from '../ai/organize'
import { pagePath } from '../ai/assistant'
import { ComparePanel } from './ComparePanel'
import { failureMessage, organizablePages, type PlanPanelProps } from './OrganizePanel'

/** Longer notes risk the model cutting its answer short; rewrite those in parts. */
export const REWRITE_MAX_CHARACTERS = 24_000
export const REWRITE_MAX_NOTES = 30

/**
 * AI 改写: each picked note is rewritten on its own (grouping related content,
 * polishing terse or spoken wording, or both), then reviewed side by side.
 */
export function RewritePanel({ scopedPages, pages, notebooks, loadMarkdown, applyPlan, openPage, onNeedsSetup }: PlanPanelProps) {
  const candidates = organizablePages(scopedPages)
  const [mode, setMode] = useState<RewriteMode>('both')
  const [request, setRequest] = useState('')
  const [groups, setGroups] = useState<PlanGroup[]>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const abort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => abort.current?.abort(), [])
  // The pick list starts over (first notes picked) whenever the scope changes.
  const scopeKey = candidates.map((page) => page.id).join(',')
  const [pickState, setPickState] = useState<{ key: string; ids: Set<string> }>()
  const picked = pickState?.key === scopeKey ? pickState.ids : new Set(candidates.slice(0, REWRITE_MAX_NOTES).map((page) => page.id))
  const setPicked = (next: Set<string> | ((current: Set<string>) => Set<string>)) => setPickState({ key: scopeKey, ids: typeof next === 'function' ? next(picked) : next })

  const run = async () => {
    if (busy || !picked.size) return
    const controller = new AbortController()
    abort.current = controller
    setError(undefined)
    const context = { pages, notebooks, newId: () => crypto.randomUUID() }
    const chosen = candidates.filter((page) => picked.has(page.id))
    const built: PlanGroup[] = []
    const problems: string[] = []
    try {
      for (const [position, page] of chosen.entries()) {
        const title = page.title || '无标题'
        setBusy(`AI 正在改写 ${position + 1} / ${chosen.length}：${title}`)
        const markdown = (await loadMarkdown(page.id)) ?? ''
        if (!markdown.trim()) { problems.push(`“${title}”是空白笔记`); continue }
        if (markdown.length > REWRITE_MAX_CHARACTERS) { problems.push(`“${title}”太长（${markdown.length} 字），请先拆分`); continue }
        try {
          const answer = await completeAI(rewriteMessages({ title: page.title, markdown }, mode, request), controller.signal)
          const group = rewriteGroup({ index: position + 1, page, path: pagePath(page, pages, notebooks), markdown }, cleanModelMarkdown(answer, page.title), mode, context)
          if (group) built.push(group)
          else problems.push(`“${title}”没有需要改的地方`)
        } catch (cause) {
          if (controller.signal.aborted) throw cause
          if (cause instanceof Error && cause.message === AI_NOT_CONFIGURED) { onNeedsSetup(); throw cause }
          problems.push(`“${title}”改写失败：${failureMessage(cause)}`)
        }
      }
    } catch (cause) {
      problems.push(failureMessage(cause))
    } finally {
      setBusy(undefined)
    }
    if (problems.length) setError(problems.join('；'))
    // Whatever finished before a stop is still worth reviewing.
    if (built.length) setGroups(built)
  }

  if (groups) {
    return <ComparePanel groups={groups} onBack={() => setGroups(undefined)} onApply={applyPlan} onOpenPage={openPage} />
  }

  const toggle = (id: string) => setPicked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const tooMany = picked.size > REWRITE_MAX_NOTES

  return <div className="organize">
    <div className="organize-scroll">
      <div className="organize-rewrite">
        <div className="organize-modes" role="radiogroup" aria-label="改写方式">
          {REWRITE_MODES.map((item) => <label key={item.id} className={`organize-mode ${mode === item.id ? 'selected' : ''}`}>
            <input type="radio" name="rewrite-mode" checked={mode === item.id} onChange={() => setMode(item.id)} />
            <strong>{item.label}</strong>
            <span>{item.hint}</span>
          </label>)}
        </div>
        <textarea className="organize-request" rows={2} value={request} placeholder="补充要求（可选），例如“用第三人称”“保留英文术语”" onChange={(event) => setRequest(event.currentTarget.value)} />
        <div className="assistant-results-bar">
          <span>选了 {picked.size} / {candidates.length} 篇，每篇单独改写{tooMany ? `；一次最多 ${REWRITE_MAX_NOTES} 篇` : ''}</span>
          <button type="button" onClick={() => setPicked(picked.size ? new Set() : new Set(candidates.slice(0, REWRITE_MAX_NOTES).map((page) => page.id)))}>{picked.size ? '全不选' : '全选'}</button>
        </div>
        {!candidates.length && <div className="assistant-empty"><strong>范围里没有笔记</strong></div>}
        <ul className="organize-picklist">
          {candidates.map((page) => <li key={page.id}><label>
            <input type="checkbox" checked={picked.has(page.id)} onChange={() => toggle(page.id)} />
            <span>{page.title || '无标题'}</span>
            <small>{pagePath(page, pages, notebooks)}</small>
          </label></li>)}
        </ul>
      </div>
      {busy && <div className="assistant-busy organize-busy" role="status">{busy}</div>}
      {error && <div className="organize-error" role="alert">{error}</div>}
    </div>
    <footer className="organize-foot">
      <span>改写结果会先显示对比，确认后才替换原文；替换前自动保存一个历史版本。</span>
      {busy && <Button size="small" onClick={() => abort.current?.abort()}>停止</Button>}
      <Button appearance="primary" size="small" disabled={!picked.size || tooMany || Boolean(busy)} onClick={() => void run()}>{busy ? '改写中…' : `改写 ${picked.size} 篇`}</Button>
    </footer>
  </div>
}
