import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Checkmark12Filled, LockClosed12Regular, Pin12Filled, Star12Filled } from '@fluentui/react-icons'
import type { PageSummary } from '../model'
import { ActionMenu, ActionMenuDivider } from '../ActionMenu'
import { dueDescription, relativeDateLabel, type ListSection } from './browse'
import { hasPrimaryKey } from './keys'

export type ListDensity = 'cards' | 'compact'

/** Context-menu entries as data; the list renders them. */
export type NoteMenuItem = { label: string; run: () => void; destructive?: boolean } | 'divider'

function renderMenu(items: NoteMenuItem[]): ReactNode {
  return items.map((item, index) => item === 'divider'
    ? <ActionMenuDivider key={`divider-${index}`} />
    : <button key={item.label} className={item.destructive ? 'destructive-menu-item' : undefined} onClick={item.run}>{item.label}</button>)
}

type Row =
  | { type: 'header'; key: string; label: string; count: number }
  | { type: 'page'; key: string; page: PageSummary }

const HEADER_HEIGHT = 30
const ROW_HEIGHT: Record<ListDensity, { note: number; task: number }> = {
  cards: { note: 82, task: 56 },
  compact: { note: 34, task: 34 },
}
const OVERSCAN_PX = 480

function rowHeight(row: Row, density: ListDensity) {
  if (row.type === 'header') return HEADER_HEIGHT
  return row.page.kind === 'task' ? ROW_HEIGHT[density].task : ROW_HEIGHT[density].note
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Marks every search word in the text (case-insensitive). */
export function highlightText(text: string, terms: string[]): ReactNode {
  const words = terms.filter((term) => term.trim())
  if (!text || !words.length) return text
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi')
  return text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)
}

export interface NoteRowProps {
  page: PageSummary
  density: ListDensity
  selected: boolean
  terms: string[]
  showNotebook: boolean
  notebookName: string
  timestamp: number
  now: number
  onOpen: (page: PageSummary, focusEditor: boolean) => void
  onToggleTodo: (page: PageSummary) => void
  onPrefetch?: (pageId: string) => void
  menu: (page: PageSummary) => NoteMenuItem[]
}

const NoteRow = memo(function NoteRow({ page, density, selected, terms, showNotebook, notebookName, timestamp, now, onOpen, onToggleTodo, onPrefetch, menu }: NoteRowProps) {
  const task = page.kind === 'task'
  const due = task ? dueDescription(page, now) : undefined
  const title = page.title.trim() || '无标题'
  const meta = <>
    {task ? due && <span className={`note-row-due ${due.tone}`}>{due.label}</span> : <time>{relativeDateLabel(timestamp, now)}</time>}
    {showNotebook && notebookName && <span className="note-row-notebook">{notebookName}</span>}
    {density === 'cards' && page.tags.slice(0, 2).map((tag) => <span key={tag} className="note-row-tag">#{tag}</span>)}
    {page.syncStatus === 'conflict' && <span className="note-row-conflict" title="同步冲突">冲突</span>}
  </>
  return <ActionMenu openOnContext label={`${title}操作`} trigger={<div
    role="option"
    aria-selected={selected}
    tabIndex={-1}
    className={`note-row ${density} ${task ? 'task' : 'note'} ${selected ? 'selected' : ''} ${page.completedAt ? 'completed' : ''}`}
    data-page-id={page.id}
    onClick={() => onOpen(page, false)}
    onDoubleClick={() => onOpen(page, true)}
    onMouseEnter={task || !onPrefetch ? undefined : () => onPrefetch(page.id)}
  >
    {task && <button
      type="button"
      className={`todo-check ${page.completedAt ? 'checked' : ''} ${due?.tone ?? ''}`}
      aria-label={page.completedAt ? '标记为未完成' : '标记为完成'}
      onClick={(event) => { event.stopPropagation(); onToggleTodo(page) }}
      onDoubleClick={(event) => event.stopPropagation()}
    >{page.completedAt && <Checkmark12Filled />}</button>}
    <div className="note-row-body">
      <div className="note-row-title">
        <span className="note-row-title-text">{highlightText(title, terms)}</span>
        {page.favorite && !task && <Pin12Filled className="note-row-pin" aria-label="已置顶" />}
        {page.important && task && <Star12Filled className="note-row-important" aria-label="重要" />}
        {page.locked && <LockClosed12Regular className="note-row-lock" aria-label="私密" />}
        {density === 'compact' && !task && <time className="note-row-time">{relativeDateLabel(timestamp, now)}</time>}
        {density === 'compact' && task && due && <span className={`note-row-due ${due.tone}`}>{due.label}</span>}
      </div>
      {density === 'cards' && !task && <p className="note-row-preview">{highlightText(page.preview.trim() || '没有更多内容', terms)}</p>}
      {density === 'cards' && <div className="note-row-meta">{meta}</div>}
    </div>
  </div>}>{renderMenu(menu(page))}</ActionMenu>
})

export interface VirtualNoteListProps {
  sections: ListSection[]
  density: ListDensity
  selectedId?: string
  terms: string[]
  showNotebook: boolean
  notebookName: (page: PageSummary) => string
  timeOf: (page: PageSummary) => number
  now: number
  onOpen: (page: PageSummary, focusEditor: boolean) => void
  onToggleTodo: (page: PageSummary) => void
  onDelete?: (page: PageSummary) => void
  /** Hover intent: load the note body before the click. */
  onPrefetch?: (pageId: string) => void
  menu: (page: PageSummary) => NoteMenuItem[]
  /** Changes when the list's content changes completely (scope switch): scroll to top. */
  resetKey: string
}

/**
 * Windowed list: only rows near the viewport exist in the DOM, so libraries
 * with thousands of notes scroll at display refresh rate. Rows have fixed
 * heights per density; the current section title floats above the rows and
 * is pushed up by the next one (iOS style).
 */
export function VirtualNoteList({ sections, density, selectedId, terms, showNotebook, notebookName, timeOf, now, onOpen, onToggleTodo, onDelete, onPrefetch, menu, resetKey }: VirtualNoteListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 900 })
  const frame = useRef(0)

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    for (const section of sections) {
      if (section.label) result.push({ type: 'header', key: section.key, label: section.label, count: section.pages.length })
      for (const page of section.pages) result.push({ type: 'page', key: page.id, page })
    }
    return result
  }, [sections])
  const offsets = useMemo(() => {
    const values: number[] = [0]
    for (const row of rows) values.push(values[values.length - 1]! + rowHeight(row, density))
    return values
  }, [density, rows])
  const total = offsets[rows.length] ?? 0
  const pageRows = useMemo(() => rows.flatMap((row, index) => row.type === 'page' ? [{ page: row.page, index }] : []), [rows])

  const measure = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setViewport((current) => current.top === element.scrollTop && current.height === element.clientHeight ? current : { top: element.scrollTop, height: element.clientHeight })
  }, [])

  useLayoutEffect(() => {
    measure()
    const element = scrollRef.current
    if (!element) return
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    measure()
  }, [measure, resetKey])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const onScroll = () => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(measure)
  }

  // Binary search for the first row that ends below the window start.
  const firstVisible = (() => {
    const start = Math.max(0, viewport.top - OVERSCAN_PX)
    let low = 0
    let high = rows.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (offsets[middle + 1]! <= start) low = middle + 1
      else high = middle
    }
    return low
  })()
  const end = viewport.top + viewport.height + OVERSCAN_PX
  const visible: number[] = []
  for (let index = firstVisible; index < rows.length && offsets[index]! < end; index += 1) visible.push(index)

  // Floating section title.
  let stickyIndex = -1
  let nextHeaderOffset = Number.POSITIVE_INFINITY
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.type !== 'header') continue
    if (offsets[index]! <= viewport.top) stickyIndex = index
    else { nextHeaderOffset = offsets[index]!; break }
  }
  const stickyRow = stickyIndex >= 0 ? rows[stickyIndex] as Extract<Row, { type: 'header' }> : undefined
  const stickyPush = Math.min(0, nextHeaderOffset - viewport.top - HEADER_HEIGHT)

  const scrollRowIntoView = useCallback((index: number) => {
    const element = scrollRef.current
    if (!element || index < 0) return
    const top = offsets[index]!
    const bottom = offsets[index + 1]!
    const headerSpace = HEADER_HEIGHT
    if (top - headerSpace < element.scrollTop) element.scrollTop = Math.max(0, top - headerSpace)
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }, [offsets])

  // Keep the selection visible when it changes from outside (search, history),
  // but not on every list update: the latest rows are read through a ref.
  const latest = useRef({ pageRows, scrollRowIntoView })
  latest.current = { pageRows, scrollRowIntoView }
  useEffect(() => {
    if (!selectedId) return
    const row = latest.current.pageRows.find((candidate) => candidate.page.id === selectedId)
    if (row) latest.current.scrollRowIntoView(row.index)
  }, [selectedId])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const position = pageRows.findIndex((row) => row.page.id === selectedId)
    const move = (next: number) => {
      const target = pageRows[Math.max(0, Math.min(pageRows.length - 1, next))]
      if (!target) return
      event.preventDefault()
      onOpen(target.page, false)
      scrollRowIntoView(target.index)
    }
    if (event.key === 'ArrowDown' || (event.key === 'j' && !event.metaKey && !event.ctrlKey)) move(position + 1)
    else if (event.key === 'ArrowUp' || (event.key === 'k' && !event.metaKey && !event.ctrlKey)) move(position < 0 ? 0 : position - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(pageRows.length - 1)
    else if (event.key === 'Enter' && position >= 0) {
      event.preventDefault()
      onOpen(pageRows[position]!.page, true)
    } else if (((event.key === 'Backspace' && hasPrimaryKey(event)) || event.key === 'Delete') && position >= 0 && onDelete) {
      event.preventDefault()
      onDelete(pageRows[position]!.page)
    }
  }

  return <div className="virtual-list-frame">
    {stickyRow && <div className="note-list-section sticky" style={{ transform: `translateY(${stickyPush}px)` }} aria-hidden="true">
      <span>{stickyRow.label}</span><span className="note-list-section-count">{stickyRow.count}</span>
    </div>}
    <div ref={scrollRef} className="note-list-scroll" role="listbox" aria-label="笔记" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
      <div className="note-list-canvas" style={{ height: total }}>
        {visible.map((index) => {
          const row = rows[index]!
          const style = { transform: `translateY(${offsets[index]}px)`, height: rowHeight(row, density) }
          if (row.type === 'header') {
            return <div key={row.key} className="note-list-section" style={style} role="presentation">
              <span>{row.label}</span><span className="note-list-section-count">{row.count}</span>
            </div>
          }
          return <div key={row.key} className="note-list-slot" style={style}>
            <NoteRow
              page={row.page}
              density={density}
              selected={row.page.id === selectedId}
              terms={terms}
              showNotebook={showNotebook}
              notebookName={notebookName(row.page)}
              timestamp={timeOf(row.page)}
              now={now}
              onOpen={onOpen}
              onToggleTodo={onToggleTodo}
              onPrefetch={onPrefetch}
              menu={menu}
            />
          </div>
        })}
      </div>
    </div>
  </div>
}
