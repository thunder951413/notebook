import { useEffect, useMemo, useRef, useState } from 'react'
import MiniSearch from 'minisearch'
import { Button, Input } from '@fluentui/react-components'
import {
  Document20Regular,
  Search20Regular,
  Settings20Regular,
  Star16Filled,
  Star16Regular,
  WindowConsole20Regular,
} from '@fluentui/react-icons'

export type PaletteGroup = 'command' | 'page' | 'setting'

export interface PaletteItem {
  id: string
  group: PaletteGroup
  title: string
  subtitle?: string
  keywords?: string
  recent?: boolean
  dangerous?: boolean
  confirmDescription?: string
  confirmLabel?: string
  run: () => void | Promise<void>
}

interface CommandPaletteProps {
  open: boolean
  items: PaletteItem[]
  searchPageIds?: (query: string) => Promise<string[]>
  onClose: () => void
}

const PINNED_KEY = 'notebook-command-pins-v1'
const RECENT_COMMANDS_KEY = 'notebook-recent-commands-v1'
const groupLabels: Record<PaletteGroup, string> = { command: '命令', page: '页面', setting: '设置' }
const groupIcons = { command: <WindowConsole20Regular />, page: <Document20Regular />, setting: <Settings20Regular /> }

export function CommandPalette({ open, items, searchPageIds, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string>()
  const [confirmItem, setConfirmItem] = useState<PaletteItem>()
  const [contentPageIds, setContentPageIds] = useState<string[]>([])
  const [pinnedIds, setPinnedIds] = useState<string[]>(readStringList(PINNED_KEY))
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>(readStringList(RECENT_COMMANDS_KEY))
  const inputRef = useRef<HTMLInputElement>(null)

  const index = useMemo(() => {
    const next = new MiniSearch({ fields: ['title', 'subtitle', 'keywords'], storeFields: ['id'], searchOptions: { fuzzy: 0.25, prefix: true, boost: { title: 4, keywords: 2 } } })
    next.addAll(items.map((item) => ({ id: item.id, title: item.title, subtitle: item.subtitle ?? '', keywords: item.keywords ?? '' })))
    return next
  }, [items])

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized) {
      const byId = new Map(items.map((item) => [item.id, item]))
      const localMatches = index.search(normalized)
        .map((result) => byId.get(String(result.id)))
        .filter((item): item is PaletteItem => Boolean(item))
      const contentMatches = contentPageIds.flatMap((id) => byId.get(`page:${id}`) ?? [])
      return [...new Map([...localMatches, ...contentMatches].map((item) => [item.id, item])).values()]
        .sort((left, right) => matchPriority(left, normalized) - matchPriority(right, normalized))
    }
    const pinned = new Map(pinnedIds.map((id, position) => [id, position]))
    const recentCommands = new Map(recentCommandIds.map((id, position) => [id, position]))
    return [...items].sort((left, right) => {
      if (left.group !== right.group) return groupOrder(left.group) - groupOrder(right.group)
      if (left.group === 'command') {
        const leftPinned = pinned.get(left.id)
        const rightPinned = pinned.get(right.id)
        if (leftPinned !== undefined || rightPinned !== undefined) return (leftPinned ?? Number.MAX_SAFE_INTEGER) - (rightPinned ?? Number.MAX_SAFE_INTEGER)
        const leftRecent = recentCommands.get(left.id)
        const rightRecent = recentCommands.get(right.id)
        if (leftRecent !== undefined || rightRecent !== undefined) return (leftRecent ?? Number.MAX_SAFE_INTEGER) - (rightRecent ?? Number.MAX_SAFE_INTEGER)
      }
      if (left.group === 'page' && left.recent !== right.recent) return left.recent ? -1 : 1
      return 0
    })
  }, [contentPageIds, index, items, pinnedIds, query, recentCommandIds])

  const grouped = useMemo(() => (['command', 'page', 'setting'] as PaletteGroup[]).map((group) => ({
    group,
    items: visibleItems.filter((item) => item.group === group).slice(0, group === 'setting' ? 6 : 10),
  })).filter((section) => section.items.length), [visibleItems])
  const flatItems = grouped.flatMap((section) => section.items)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setContentPageIds([])
    setConfirmItem(undefined)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    const normalized = query.trim()
    if (!open || !normalized || !searchPageIds) {
      setContentPageIds([])
      return
    }
    let cancelled = false
    setContentPageIds([])
    const timer = window.setTimeout(() => {
      void searchPageIds(normalized).then((ids) => {
        if (!cancelled) setContentPageIds(ids)
      }).catch(() => {
        if (!cancelled) setContentPageIds([])
      })
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, searchPageIds])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return
      event.preventDefault()
      if (confirmItem) { setConfirmItem(undefined); window.requestAnimationFrame(() => inputRef.current?.focus()) }
      else onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [confirmItem, onClose, open])

  useEffect(() => {
    if (!open || !flatItems.length) { setActiveId(undefined); return }
    if (!flatItems.some((item) => item.id === activeId)) {
      const normalized = query.trim().toLocaleLowerCase()
      const directPage = normalized ? flatItems.find((item) => item.group === 'page' && item.title.trim().toLocaleLowerCase() === normalized)
        ?? flatItems.find((item) => item.group === 'page' && item.title.trim().toLocaleLowerCase().startsWith(normalized)) : undefined
      setActiveId((directPage ?? flatItems[0])?.id)
    }
  }, [activeId, flatItems, open, query])

  if (!open) return null

  const execute = (item: PaletteItem) => {
    if (item.dangerous) {
      setConfirmItem(item)
      return
    }
    if (item.group === 'command') {
      setRecentCommandIds((current) => {
        const next = [item.id, ...current.filter((id) => id !== item.id)].slice(0, 12)
        globalThis.localStorage?.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next))
        return next
      })
    }
    onClose()
    void Promise.resolve(item.run())
  }

  const confirmDangerous = () => {
    if (!confirmItem) return
    const item = confirmItem
    setConfirmItem(undefined)
    onClose()
    void Promise.resolve(item.run())
  }

  const togglePinned = (id: string) => {
    setPinnedIds((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      globalThis.localStorage?.setItem(PINNED_KEY, JSON.stringify(next))
      window.requestAnimationFrame(() => inputRef.current?.focus())
      return next
    })
  }

  const moveActive = (direction: -1 | 1) => {
    if (!flatItems.length) return
    const current = Math.max(0, flatItems.findIndex((item) => item.id === activeId))
    setActiveId(flatItems[(current + direction + flatItems.length) % flatItems.length]?.id)
  }

  return <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
      {confirmItem ? <div className="command-confirmation" role="alertdialog" aria-label="确认危险操作">
        <div className="command-confirmation-icon">!</div>
        <h2>{confirmItem.title}</h2>
        <p>{confirmItem.confirmDescription ?? '这项操作会修改或删除数据，请确认是否继续。'}</p>
        <div><Button autoFocus onClick={() => { setConfirmItem(undefined); window.requestAnimationFrame(() => inputRef.current?.focus()) }}>取消</Button><Button appearance="primary" onClick={confirmDangerous}>{confirmItem.confirmLabel ?? '确认执行'}</Button></div>
      </div> : <>
        <div className="command-palette-search"><Search20Regular /><Input ref={inputRef} value={query} onChange={(_, data) => { setQuery(data.value); setActiveId(undefined) }} placeholder="搜索命令、页面标题、正文和设置…" aria-label="搜索命令、页面和设置" onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1) }
          if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1) }
          if (event.key === 'Enter') { event.preventDefault(); const item = flatItems.find((candidate) => candidate.id === activeId); if (item) execute(item) }
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
        }} /><kbd>⌘P</kbd></div>
        <div className="command-palette-results" role="listbox" aria-label="命令面板结果" aria-activedescendant={activeId ? `palette-${activeId}` : undefined}>
          {grouped.length ? grouped.map((section) => <section key={section.group} className="command-palette-group">
            <header>{groupIcons[section.group]}<span>{groupLabels[section.group]}</span></header>
            {section.items.map((item) => <div key={item.id} id={`palette-${item.id}`} className={`command-palette-row ${activeId === item.id ? 'active' : ''} ${item.dangerous ? 'dangerous' : ''}`} role="option" aria-selected={activeId === item.id} onMouseMove={() => setActiveId(item.id)}>
              <button className="command-palette-main-action" onClick={() => execute(item)}><span><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}</span>{item.recent && item.group === 'page' && <em>最近</em>}{item.dangerous && <em>需确认</em>}</button>
              {item.group === 'command' && <button className="command-pin" aria-label={pinnedIds.includes(item.id) ? `取消固定：${item.title}` : `固定命令：${item.title}`} title={pinnedIds.includes(item.id) ? '取消固定' : '固定到顶部'} onClick={() => togglePinned(item.id)}>{pinnedIds.includes(item.id) ? <Star16Filled /> : <Star16Regular />}</button>}
            </div>)}
          </section>) : <div className="command-palette-empty"><Search20Regular /><strong>没有匹配结果</strong><span>尝试输入页面标题、正文内容、功能名称或设置项。</span></div>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></footer>
      </>}
    </section>
  </div>
}

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function groupOrder(group: PaletteGroup) {
  return group === 'command' ? 0 : group === 'page' ? 1 : 2
}

function matchPriority(item: PaletteItem, query: string) {
  const title = item.title.trim().toLocaleLowerCase()
  if (title === query) return item.group === 'page' ? 0 : 1
  if (title.startsWith(query)) return item.group === 'page' ? 2 : 3
  return 4
}
