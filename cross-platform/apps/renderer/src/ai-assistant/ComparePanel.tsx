import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import { compareNotes, GROUP_KIND_LABEL, type CompareNote, type CompareResult, type PlanGroup, type ResultBlock, type SourceBlock } from '../ai/organize'
import type { ApplyOutcome } from '../ai/organizeApply'

const SOURCE_LABEL: Record<SourceBlock['status'], string> = { kept: '相同', rewritten: '改写', scattered: '分散到多处', missing: '未找到', trivial: '' }
const RESULT_LABEL: Record<ResultBlock['status'], string> = { kept: '相同', rewritten: '改写', added: '新增', trivial: '' }

type Active = { side: 'before' | 'after'; key: string } | undefined

function issueCount(result: CompareResult) {
  return result.stats.missing
}

/**
 * Side-by-side review of an organizing or rewriting plan, in the spirit of
 * Beyond Compare: every paragraph on the left says where it went on the
 * right (or that it was not found), every paragraph on the right says where
 * it came from (or that the AI added it). Groups are accepted one by one.
 */
export function ComparePanel({ groups, onBack, onApply, onOpenPage }: {
  groups: PlanGroup[]
  onBack(): void
  onApply(groups: PlanGroup[], onProgress: (done: number, total: number) => void): Promise<ApplyOutcome>
  onOpenPage(pageId: string): void
}) {
  const results = useMemo(() => new Map(groups.map((group) => [group.id, compareNotes(group.before, group.after)])), [groups])
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set(groups.filter((group) => issueCount(results.get(group.id)!) === 0).map((group) => group.id)))
  const [selectedId, setSelectedId] = useState(groups[0]?.id)
  const [onlyChanges, setOnlyChanges] = useState(false)
  const [active, setActive] = useState<Active>()
  const [applying, setApplying] = useState<string>()
  const [outcome, setOutcome] = useState<ApplyOutcome>()
  const [error, setError] = useState<string>()
  const group = groups.find((item) => item.id === selectedId) ?? groups[0]
  const result = group ? results.get(group.id)! : undefined
  const totals = useMemo(() => [...results.values()].reduce((sum, item) => ({ missing: sum.missing + item.stats.missing, added: sum.added + item.stats.added }), { missing: 0, added: 0 }), [results])
  const scrollRoot = useRef<HTMLDivElement>(null)
  useEffect(() => { setActive(undefined) }, [selectedId])

  const counterpart = (side: 'before' | 'after', key: string) => {
    if (!result) return undefined
    const block = side === 'before' ? result.before.find((item) => item.key === key) : result.after.find((item) => item.key === key)
    return block?.match ? `${block.match.noteKey}:${block.match.index}` : undefined
  }
  const select = (side: 'before' | 'after', key: string) => {
    setActive({ side, key })
    const other = counterpart(side, key)
    if (!other) return
    requestAnimationFrame(() => scrollRoot.current?.querySelector(`[data-side="${side === 'before' ? 'after' : 'before'}"][data-key="${CSS.escape(other)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  const highlighted = active ? new Set([`${active.side}:${active.key}`, ...(counterpart(active.side, active.key) ? [`${active.side === 'before' ? 'after' : 'before'}:${counterpart(active.side, active.key)}`] : [])]) : new Set<string>()

  const apply = async () => {
    const chosen = groups.filter((item) => accepted.has(item.id))
    if (!chosen.length || applying) return
    setError(undefined)
    setApplying('正在应用…')
    try {
      setOutcome(await onApply(chosen, (done, total) => setApplying(`正在应用 ${done} / ${total}`)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '应用失败')
    } finally {
      setApplying(undefined)
    }
  }

  if (outcome) {
    const titles = new Map(groups.map((item) => [item.id, item.title]))
    return <div className="compare-done" role="status">
      <strong>已应用 {outcome.applied.length} 项{outcome.failed.length ? `，${outcome.failed.length} 项没有应用` : ''}</strong>
      {outcome.applied.length > 0 && <span>被改写的笔记都存了一个历史版本，可在“版本”里找回；合并掉的原笔记在回收站。</span>}
      {outcome.failed.length > 0 && <ul>{outcome.failed.map((item) => <li key={item.groupId}>{titles.get(item.groupId) ?? item.title}：{item.message}</li>)}</ul>}
      {outcome.created[0] && <Button size="small" onClick={() => onOpenPage(outcome.created[0]!)}>打开新建的笔记</Button>}
      <Button appearance="primary" size="small" onClick={onBack}>完成</Button>
    </div>
  }

  return <div className="compare" aria-label="对比审阅">
    <aside className="compare-groups" aria-label="整理方案">
      <div className="compare-groups-head">
        <span>方案 {groups.length} 项</span>
        <button type="button" onClick={() => setAccepted(accepted.size === groups.length ? new Set() : new Set(groups.map((item) => item.id)))}>{accepted.size === groups.length ? '全不选' : '全选'}</button>
      </div>
      <ul>
        {groups.map((item) => {
          const stats = results.get(item.id)!.stats
          return <li key={item.id} className={item.id === group?.id ? 'selected' : undefined}>
            <input type="checkbox" aria-label={`应用“${item.title}”`} checked={accepted.has(item.id)} onChange={() => setAccepted((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} />
            <button type="button" onClick={() => setSelectedId(item.id)}>
              <span className={`compare-kind ${item.kind}`}>{GROUP_KIND_LABEL[item.kind]}</span>
              <span className="compare-group-title">{item.title}</span>
              {stats.missing > 0 && <span className="compare-badge missing" title="可能丢失的段落">{stats.missing}</span>}
            </button>
          </li>
        })}
      </ul>
    </aside>

    {group && result && <section className="compare-main">
      <header className="compare-head">
        <div>
          <strong>{GROUP_KIND_LABEL[group.kind]}：{group.title}</strong>
          {group.reason && <span>{group.reason}</span>}
        </div>
        <div className="compare-stats" aria-label="段落去向统计">
          <span className="kept">相同 {result.stats.kept}</span>
          <span className="rewritten">改写 {result.stats.rewritten}</span>
          {result.stats.scattered > 0 && <span className="scattered">分散 {result.stats.scattered}</span>}
          <span className={`missing ${result.stats.missing ? 'alert' : ''}`}>未找到 {result.stats.missing}</span>
          <span className="added">新增 {result.stats.added}</span>
          <label><input type="checkbox" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.currentTarget.checked)} />只看差异</label>
        </div>
      </header>
      <PlacementChanges group={group} onOpenPage={onOpenPage} />
      <div className="compare-columns" ref={scrollRoot}>
        <Column side="before" title="整理前" notes={group.before} blocks={result.before} otherNotes={group.after} onlyChanges={onlyChanges} highlighted={highlighted} onSelect={select} />
        <Column side="after" title="整理后" notes={group.after} blocks={result.after} otherNotes={group.before} onlyChanges={onlyChanges} highlighted={highlighted} onSelect={select} />
      </div>
    </section>}

    <footer className="compare-foot">
      <Button appearance="subtle" size="small" onClick={onBack} disabled={Boolean(applying)}>返回建议</Button>
      <span>
        {totals.missing > 0 ? `共有 ${totals.missing} 段在整理后没有找到，含这些段落的项默认不勾选，请先核对。` : '所有原文段落都能在整理后找到。'}
        {totals.added > 0 ? ` AI 新加了 ${totals.added} 段。` : ''}
      </span>
      {error && <span role="alert" className="compare-error">{error}</span>}
      <Button appearance="primary" size="small" disabled={!accepted.size || Boolean(applying)} onClick={() => void apply()}>{applying ?? `应用选中的 ${accepted.size} 项`}</Button>
    </footer>
  </div>
}

function PlacementChanges({ group, onOpenPage }: { group: PlanGroup; onOpenPage(pageId: string): void }) {
  const rows = group.after.flatMap((after) => {
    const before = group.before.find((item) => item.key === after.key)
    const moved = before && before.location !== after.location
    const tagsChanged = before && (before.tags ?? []).join('|') !== (after.tags ?? []).join('|')
    if (!moved && !tagsChanged && before) return []
    return [{ before, after, moved, tagsChanged }]
  })
  if (!rows.length) return null
  return <ul className="compare-placement">
    {rows.map(({ before, after, moved, tagsChanged }) => <li key={after.key}>
      {before ? <button type="button" onClick={() => onOpenPage(after.key)}>{after.title || '无标题'}</button> : <strong>新建《{after.title}》</strong>}
      {moved && <span>位置：{before!.location} <b>→</b> {after.location}</span>}
      {!before && <span>放在：{after.location}</span>}
      {tagsChanged && <span className="compare-tags">标签：{tagDiff(before!.tags ?? [], after.tags ?? [])}</span>}
    </li>)}
  </ul>
}

function tagDiff(before: string[], after: string[]) {
  const removed = before.filter((tag) => !after.includes(tag))
  const added = after.filter((tag) => !before.includes(tag))
  const kept = after.filter((tag) => before.includes(tag))
  return <>
    {kept.map((tag) => <i key={`k${tag}`}>#{tag}</i>)}
    {added.map((tag) => <i key={`a${tag}`} className="added">+#{tag}</i>)}
    {removed.map((tag) => <i key={`r${tag}`} className="removed">−#{tag}</i>)}
  </>
}

function Column({ side, title, notes, blocks, otherNotes, onlyChanges, highlighted, onSelect }: {
  side: 'before' | 'after'
  title: string
  notes: CompareNote[]
  blocks: Array<SourceBlock | ResultBlock>
  otherNotes: CompareNote[]
  onlyChanges: boolean
  highlighted: Set<string>
  onSelect(side: 'before' | 'after', key: string): void
}) {
  const otherTitle = (key?: string) => otherNotes.find((note) => note.key === key)?.title
  return <div className="compare-col" data-column={side}>
    <div className="compare-col-head">{title}</div>
    {notes.map((note) => {
      const own = blocks.filter((block) => block.noteKey === note.key)
      let hidden = 0
      const rows: React.ReactNode[] = []
      const flushHidden = (key: string) => { if (hidden) rows.push(<div key={`gap-${key}`} className="compare-gap">… {hidden} 段相同 …</div>); hidden = 0 }
      for (const block of own) {
        if (onlyChanges && (block.status === 'kept' || block.status === 'trivial')) { hidden += 1; continue }
        flushHidden(block.key)
        const destination = block.match && block.match.noteKey !== note.key ? otherTitle(block.match.noteKey) : undefined
        const label = side === 'before' ? SOURCE_LABEL[(block as SourceBlock).status] : RESULT_LABEL[(block as ResultBlock).status]
        const score = block.status === 'rewritten' ? ` ${Math.round(block.score * 100)}%` : ''
        rows.push(<button
          type="button"
          key={block.key}
          data-side={side}
          data-key={block.key}
          className={`compare-block ${block.status} ${highlighted.has(`${side}:${block.key}`) ? 'active' : ''}`}
          onClick={() => onSelect(side, block.key)}
        >
          <span className="compare-block-text">{block.markdown}</span>
          {label && <span className="compare-block-tag">{label}{score}{destination ? (side === 'before' ? ` → 《${destination}》` : ` ← 《${destination}》`) : ''}</span>}
        </button>)
      }
      flushHidden(`end-${note.key}`)
      return <section key={note.key} className="compare-note">
        <header><strong>{note.title || '无标题'}</strong>{note.location && <small>{note.location}</small>}</header>
        {own.length ? rows : <div className="compare-gap">（空白）</div>}
      </section>
    })}
  </div>
}
