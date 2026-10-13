import { useCallback, useState } from 'react'
import { AlertUrgent20Regular, Clock20Regular, Dismiss16Regular } from '@fluentui/react-icons'
import type { PageSummary } from '../model'
import { attentionAt, dueDescription } from './browse'

const BANNER_KEY = 'notebook-todo-banner-v1'

interface BannerState {
  snooze: Record<string, number>
  dismiss: Record<string, number>
}

function readBannerState(): BannerState {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(BANNER_KEY) ?? 'null') as Partial<BannerState> | null
    return { snooze: value?.snooze ?? {}, dismiss: value?.dismiss ?? {} }
  } catch {
    return { snooze: {}, dismiss: {} }
  }
}

/**
 * Device-local snooze/dismiss for the due banner. Nothing here touches synced
 * data: dismissing holds until the todo's due time changes.
 */
export function useDueBannerState(now: number) {
  const [state, setState] = useState(readBannerState)
  const save = useCallback((update: (current: BannerState) => BannerState) => {
    setState((current) => {
      const next = update(current)
      // Forget entries older than a week so the map stays small.
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      for (const [id, until] of Object.entries(next.snooze)) if (until < cutoff) delete next.snooze[id]
      try { globalThis.localStorage?.setItem(BANNER_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    })
  }, [])
  const hidden = useCallback((page: PageSummary) => (state.snooze[page.id] ?? 0) > now || state.dismiss[page.id] === (attentionAt(page) ?? 0), [now, state])
  const snooze = useCallback((page: PageSummary, minutes: number) => save((current) => ({ ...current, snooze: { ...current.snooze, [page.id]: Date.now() + minutes * 60_000 } })), [save])
  const dismiss = useCallback((page: PageSummary) => save((current) => ({ ...current, dismiss: { ...current.dismiss, [page.id]: attentionAt(page) ?? 0 } })), [save])
  return { hidden, snooze, dismiss }
}

export interface DueBannerProps {
  items: PageSummary[]
  now: number
  onOpen: (page: PageSummary) => void
  onComplete: (page: PageSummary) => void
  onSnooze: (page: PageSummary) => void
  onDismiss: (page: PageSummary) => void
  onShowAll: () => void
}

/** Preview of todos that are overdue or due within two hours. */
export function DueBanner({ items, now, onOpen, onComplete, onSnooze, onDismiss, onShowAll }: DueBannerProps) {
  const first = items[0]
  if (!first) return null
  const due = dueDescription(first, now)
  const late = due?.tone === 'overdue'
  return <div className={`due-banner ${late ? 'late' : ''}`} role="status">
    <span className="due-banner-icon">{late ? <AlertUrgent20Regular /> : <Clock20Regular />}</span>
    <button type="button" className="due-banner-main" onClick={() => onOpen(first)}>
      <strong>{first.title.trim() || '无标题待办'}</strong>
      <span>{due?.label}{items.length > 1 ? ` · 还有 ${items.length - 1} 项` : ''}</span>
    </button>
    <div className="due-banner-actions">
      <button type="button" onClick={() => onComplete(first)}>完成</button>
      <button type="button" onClick={() => onSnooze(first)} title="1 小时后再提醒">稍后</button>
      {items.length > 1 && <button type="button" onClick={onShowAll}>全部</button>}
      <button type="button" className="due-banner-close" aria-label="不再提醒此项" title="不再提醒此项" onClick={() => onDismiss(first)}><Dismiss16Regular /></button>
    </div>
  </div>
}
