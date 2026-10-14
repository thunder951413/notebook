import { useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import type { NotebookSummary, PageSummary } from '../model'
import { pagePath } from '../ai/assistant'
import { AI_NOT_CONFIGURED, completeAI } from '../ai/completion'
import {
  analysisMessages,
  categoryGroup,
  cleanModelMarkdown,
  mergeGroup,
  mergeMessages,
  parseSplit,
  parseSuggestions,
  splitGroup,
  splitMessages,
  tagGroup,
  type OrganizeNote,
  type OrganizeSuggestions,
  type PlanContext,
  type PlanGroup,
} from '../ai/organize'
import type { ApplyOutcome } from '../ai/organizeApply'
import { ComparePanel } from './ComparePanel'

/** Analysis sees at most this many notes (each still gets a useful excerpt). */
export const ORGANIZE_MAX_NOTES = 200

export interface PlanPanelProps {
  scopedPages: PageSummary[]
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  scopeLabel: string
  loadMarkdown(pageId: string): Promise<string | undefined>
  applyPlan(groups: PlanGroup[], onProgress: (done: number, total: number) => void): Promise<ApplyOutcome>
  openPage(pageId: string): void
  onNeedsSetup(): void
}

/** Notes that can be reorganized: no tasks, private notes or notebook roots. */
export function organizablePages(pages: PageSummary[]) {
  return pages.filter((page) => page.kind !== 'task' && !page.locked && !page.notebookRoot)
}

export async function loadOrganizeNotes(scoped: PageSummary[], pages: PageSummary[], notebooks: NotebookSummary[], loadMarkdown: (pageId: string) => Promise<string | undefined>, signal: AbortSignal): Promise<OrganizeNote[]> {
  const notes: OrganizeNote[] = []
  for (const page of scoped) {
    signal.throwIfAborted()
    notes.push({ index: notes.length + 1, page, path: pagePath(page, pages, notebooks), markdown: (await loadMarkdown(page.id)) ?? '' })
  }
  return notes
}

export function failureMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return '已停止'
  if (error instanceof Error) return error.message === AI_NOT_CONFIGURED ? '还没有配置 AI' : error.message
  return 'AI 请求失败'
}

type Picks = { categories: Set<number>; tags: Set<number>; merges: Set<number>; splits: Set<number> }
const allPicked = (suggestions: OrganizeSuggestions): Picks => ({
  categories: new Set(suggestions.categories.map((_, index) => index)),
  tags: new Set(suggestions.tags.map((_, index) => index)),
  merges: new Set(suggestions.merges.map((_, index) => index)),
  splits: new Set(suggestions.splits.map((_, index) => index)),
})

/**
 * AI 整理: the model reads the notes in scope and proposes categories, tags,
 * merges and splits. Accepted suggestions become a plan that is reviewed in
 * the compare view before anything changes.
 */
export function OrganizePanel({ scopedPages, pages, notebooks, scopeLabel, loadMarkdown, applyPlan, openPage, onNeedsSetup }: PlanPanelProps) {
  const candidates = organizablePages(scopedPages)
  const [request, setRequest] = useState('')
  const [notes, setNotes] = useState<OrganizeNote[]>()
  const [suggestions, setSuggestions] = useState<OrganizeSuggestions>()
  const [picks, setPicks] = useState<Picks>()
  const [groups, setGroups] = useState<PlanGroup[]>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const abort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => abort.current?.abort(), [])
  // A different scope makes old suggestions meaningless.
  const scopeKey = candidates.map((page) => page.id).join(',')
  // (Not while reviewing: applying a plan itself changes the notes in scope.)
  const reviewing = useRef(false)
  reviewing.current = Boolean(groups)
  useEffect(() => { if (!reviewing.current) { setNotes(undefined); setSuggestions(undefined); setError(undefined) } }, [scopeKey])

  const context = (): PlanContext => ({ pages, notebooks, newId: () => crypto.randomUUID() })
  const titleOf = (index: number) => notes?.find((note) => note.index === index)?.page.title || '无标题'

  const analyze = async () => {
    if (busy) return
    const controller = new AbortController()
    abort.current = controller
    setError(undefined)
    try {
      setBusy('正在读取笔记…')
      const loaded = await loadOrganizeNotes(candidates.slice(0, ORGANIZE_MAX_NOTES), pages, notebooks, loadMarkdown, controller.signal)
      setBusy(`AI 正在分析 ${loaded.length} 篇笔记…`)
      const existingTags = [...new Set(pages.flatMap((page) => page.tags))]
      const answer = await completeAI(analysisMessages(loaded, existingTags, request), controller.signal)
      const parsed = parseSuggestions(answer, loaded.length)
      setNotes(loaded)
      setSuggestions(parsed)
      setPicks(allPicked(parsed))
    } catch (cause) {
      if (cause instanceof Error && cause.message === AI_NOT_CONFIGURED) onNeedsSetup()
      setError(failureMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const buildPlan = async () => {
    if (!notes || !suggestions || !picks || busy) return
    const controller = new AbortController()
    abort.current = controller
    setError(undefined)
    const planContext = context()
    const built: PlanGroup[] = []
    const problems: string[] = []
    const merges = suggestions.merges.filter((_, index) => picks.merges.has(index))
    const splits = suggestions.splits.filter((_, index) => picks.splits.has(index))
    const aiSteps = merges.length + splits.length
    let step = 0
    try {
      for (const category of suggestions.categories.filter((_, index) => picks.categories.has(index))) {
        const group = categoryGroup(category, notes, planContext)
        if (group) built.push(group)
      }
      for (const merge of merges) {
        step += 1
        setBusy(`AI 正在合并 ${step} / ${aiSteps}：${merge.title}`)
        const sources = merge.notes.map((index) => notes.find((note) => note.index === index)).filter((note): note is OrganizeNote => Boolean(note))
        try {
          const answer = await completeAI(mergeMessages(merge.title, sources.map((note) => ({ title: note.page.title, markdown: note.markdown })), request), controller.signal)
          const group = mergeGroup(merge, notes, cleanModelMarkdown(answer, merge.title), planContext)
          if (group) built.push(group)
        } catch (cause) {
          if (controller.signal.aborted) throw cause
          problems.push(`合并“${merge.title}”失败：${failureMessage(cause)}`)
        }
      }
      for (const split of splits) {
        step += 1
        const note = notes.find((item) => item.index === split.note)
        if (!note) continue
        setBusy(`AI 正在拆分 ${step} / ${aiSteps}：${note.page.title || '无标题'}`)
        try {
          const answer = await completeAI(splitMessages({ title: note.page.title, markdown: note.markdown }, split.parts), controller.signal)
          const group = splitGroup(split, notes, parseSplit(answer), planContext)
          if (group) built.push(group)
          else problems.push(`“${note.page.title || '无标题'}”的拆分结果无法识别`)
        } catch (cause) {
          if (controller.signal.aborted) throw cause
          problems.push(`拆分“${note.page.title || '无标题'}”失败：${failureMessage(cause)}`)
        }
      }
      for (const tag of suggestions.tags.filter((_, index) => picks.tags.has(index))) {
        const group = tagGroup(tag, notes, planContext)
        if (group) built.push(group)
      }
      if (problems.length) setError(problems.join('；'))
      if (built.length) setGroups(built)
      else if (!problems.length) setError('选中的建议不需要改动任何笔记')
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  if (groups) {
    return <ComparePanel
      groups={groups}
      onBack={() => setGroups(undefined)}
      onApply={async (accepted, onProgress) => {
        const outcome = await applyPlan(accepted, onProgress)
        // The notes changed: the next round starts from a fresh analysis.
        if (outcome.applied.length) { setSuggestions(undefined); setNotes(undefined) }
        return outcome
      }}
      onOpenPage={openPage}
    />
  }

  const toggle = (key: keyof Picks, index: number) => setPicks((current) => {
    if (!current) return current
    const next = new Set(current[key])
    if (next.has(index)) next.delete(index); else next.add(index)
    return { ...current, [key]: next }
  })
  const pickedCount = picks ? picks.categories.size + picks.tags.size + picks.merges.size + picks.splits.size : 0
  const nothing = suggestions && !suggestions.categories.length && !suggestions.tags.length && !suggestions.merges.length && !suggestions.splits.length

  return <div className="organize">
    <div className="organize-scroll">
      {!suggestions ? <div className="assistant-empty organize-intro">
        <strong>整理 {Math.min(candidates.length, ORGANIZE_MAX_NOTES)} 篇笔记</strong>
        <span>AI 会分析“{scopeLabel}”里的笔记，建议类别和标签，指出哪些笔记适合合并、哪些适合拆开。生成方案后先在对比视图里核对每一段内容的去向，确认后才会改动。</span>
        {candidates.length > ORGANIZE_MAX_NOTES && <span className="organize-warn">范围里有 {candidates.length} 篇，只分析前 {ORGANIZE_MAX_NOTES} 篇；可以缩小范围分批整理。</span>}
        <textarea className="organize-request" rows={2} value={request} placeholder="补充要求（可选），例如“按项目分类，标签用英文”" onChange={(event) => setRequest(event.currentTarget.value)} />
        <div className="organize-actions">
          <Button appearance="primary" size="small" disabled={Boolean(busy) || !candidates.length} onClick={() => void analyze()}>{busy ? '分析中…' : '开始分析'}</Button>
          {busy && <Button size="small" onClick={() => abort.current?.abort()}>停止</Button>}
        </div>
      </div> : <div className="organize-suggestions">
        <div className="assistant-results-bar">
          <span>分析了 {notes?.length ?? 0} 篇笔记</span>
          <button type="button" disabled={Boolean(busy)} onClick={() => { setSuggestions(undefined); setNotes(undefined) }}>重新分析</button>
        </div>
        {nothing && <div className="assistant-empty"><strong>没有需要整理的地方</strong><span>可以换个范围，或在补充要求里说明想怎么整理。</span></div>}
        {suggestions.categories.length > 0 && <section className="organize-section">
          <h3>建议类别<small>每类建一个目录，笔记移进去；已有同名目录时直接使用</small></h3>
          {suggestions.categories.map((category, index) => <label key={index} className="organize-item">
            <input type="checkbox" checked={picks?.categories.has(index) ?? false} onChange={() => toggle('categories', index)} />
            <div>
              <strong>{category.name}</strong>{category.description && <span>{category.description}</span>}
              <ul className="organize-notes">{category.notes.map((note) => <li key={note}>{titleOf(note)}</li>)}</ul>
            </div>
          </label>)}
        </section>}
        {suggestions.merges.length > 0 && <section className="organize-section">
          <h3>可以合并<small>AI 写成一篇新笔记，原笔记移到回收站，它们的下级笔记挂到新笔记下</small></h3>
          {suggestions.merges.map((merge, index) => <label key={index} className="organize-item">
            <input type="checkbox" checked={picks?.merges.has(index) ?? false} onChange={() => toggle('merges', index)} />
            <div>
              <strong>{merge.title}</strong>{merge.reason && <span>{merge.reason}</span>}
              <ul className="organize-notes">{merge.notes.map((note) => <li key={note}>{titleOf(note)}</li>)}</ul>
            </div>
          </label>)}
        </section>}
        {suggestions.splits.length > 0 && <section className="organize-section">
          <h3>可以拆分<small>拆出的部分成为原笔记的下级笔记，原笔记保留其余内容和链接</small></h3>
          {suggestions.splits.map((split, index) => <label key={index} className="organize-item">
            <input type="checkbox" checked={picks?.splits.has(index) ?? false} onChange={() => toggle('splits', index)} />
            <div>
              <strong>{titleOf(split.note)}</strong>{split.reason && <span>{split.reason}</span>}
              <ul className="organize-notes">{split.parts.map((part, position) => <li key={position}>{part.title}{part.summary && <small>{part.summary}</small>}</li>)}</ul>
            </div>
          </label>)}
        </section>}
        {suggestions.tags.length > 0 && <section className="organize-section">
          <h3>标签</h3>
          {suggestions.tags.map((tag, index) => <label key={index} className="organize-item compact">
            <input type="checkbox" checked={picks?.tags.has(index) ?? false} onChange={() => toggle('tags', index)} />
            <div className="organize-tag-row">
              <strong>{titleOf(tag.note)}</strong>
              {tag.add.map((name) => <i key={`a${name}`} className="added">+#{name}</i>)}
              {tag.remove.map((name) => <i key={`r${name}`} className="removed">−#{name}</i>)}
            </div>
          </label>)}
        </section>}
      </div>}
      {busy && <div className="assistant-busy organize-busy" role="status">{busy}</div>}
      {error && <div className="organize-error" role="alert">{error}</div>}
    </div>
    {suggestions && !nothing && <footer className="organize-foot">
      <span>{picks?.merges.size || picks?.splits.size ? '合并和拆分需要 AI 逐项生成内容，可能要一会儿。' : '生成方案后会先显示对比，不会直接改动笔记。'}</span>
      {busy && <Button size="small" onClick={() => abort.current?.abort()}>停止</Button>}
      <Button appearance="primary" size="small" disabled={!pickedCount || Boolean(busy)} onClick={() => void buildPlan()}>生成方案并对比（{pickedCount}）</Button>
    </footer>}
  </div>
}
