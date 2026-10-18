import { useState, type ReactNode, type Ref } from 'react'
import {
  Add16Regular,
  ArrowSync20Regular,
  CheckmarkCircle20Regular,
  Delete20Regular,
  DocumentMultiple20Regular,
  NumberSymbol16Regular,
  PanelLeft20Regular,
  Sparkle20Regular,
  Pin20Regular,
  Settings20Regular,
} from '@fluentui/react-icons'

export type ListScope =
  | { kind: 'all' }
  | { kind: 'recent' }
  | { kind: 'favorites' }
  | { kind: 'tasks' }
  | { kind: 'trash' }
  | { kind: 'notebook'; id: string }
  | { kind: 'tag'; name: string }

export const sameScope = (left: ListScope, right: ListScope) => {
  if (left.kind !== right.kind) return false
  if (left.kind === 'notebook' && right.kind === 'notebook') return left.id === right.id
  if (left.kind === 'tag' && right.kind === 'tag') return left.name === right.name
  return true
}

const SCOPE_KEY = 'notebook-list-scope-v1'

export function readScope(): ListScope {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(SCOPE_KEY) ?? 'null') as ListScope | null
    if (value && ['all', 'recent', 'favorites', 'tasks', 'trash'].includes(value.kind)) return { kind: value.kind } as ListScope
    if (value?.kind === 'notebook' && typeof value.id === 'string') return value
    if (value?.kind === 'tag' && typeof value.name === 'string') return value
  } catch { /* storage unavailable or corrupt */ }
  return { kind: 'all' }
}

export function writeScope(scope: ListScope) {
  try { globalThis.localStorage?.setItem(SCOPE_KEY, JSON.stringify(scope)) } catch { /* storage unavailable */ }
}

interface SidebarItemProps {
  icon: ReactNode
  label: string
  count?: number
  badge?: number
  badgeTone?: 'alert' | 'normal'
  selected: boolean
  onClick: () => void
}

function SidebarItem({ icon, label, count, badge, badgeTone = 'normal', selected, onClick }: SidebarItemProps) {
  return <button type="button" className={`sidebar-item ${selected ? 'selected' : ''}`} aria-current={selected ? 'page' : undefined} onClick={onClick}>
    <span className="sidebar-item-icon">{icon}</span>
    <span className="sidebar-item-label">{label}</span>
    {badge ? <span className={`sidebar-badge ${badgeTone}`} aria-label={`${badge} 项需要处理`}>{badge}</span> : count !== undefined && <span className="sidebar-count">{count}</span>}
  </button>
}

export interface SidebarProps {
  scope: ListScope
  onScope: (scope: ListScope) => void
  counts: { all: number; recent: number; favorites: number; tasks: number; taskBadge: number; taskOverdue: boolean; trash: number }
  tags: Array<{ name: string; count: number }>
  notebooks: ReactNode
  syncStatus: ReactNode
  settingsRef?: Ref<HTMLButtonElement>
  onSettings: () => void
  onHide: () => void
  onNewNotebook: () => void
  resizer?: ReactNode
  assistantOpen?: boolean
  onAssistant?: () => void
}

/**
 * Source list in the frosted window material (Apple Notes / Mail): smart
 * collections, notebooks with their page trees, tags, and the sync state.
 */
export function Sidebar({ scope, onScope, counts, tags, notebooks, syncStatus, settingsRef, onSettings, onHide, onNewNotebook, resizer, assistantOpen = false, onAssistant }: SidebarProps) {
  const [allTags, setAllTags] = useState(false)
  const shownTags = allTags ? tags : tags.slice(0, 8)
  return <nav className="app-sidebar" aria-label="导航">
    <div className="sidebar-titlebar" data-tauri-drag-region>
      <button type="button" className="toolbar-icon-button" aria-label="隐藏边栏" title="隐藏边栏（⌃⌘S）" onClick={onHide}><PanelLeft20Regular /></button>
    </div>
    <div className="sidebar-scroll">
      <div className="sidebar-group" role="group" aria-label="笔记">
        <SidebarItem icon={<DocumentMultiple20Regular />} label="全部笔记" count={counts.all} selected={!assistantOpen && scope.kind === 'all'} onClick={() => onScope({ kind: 'all' })} />
        <SidebarItem icon={<ArrowSync20Regular />} label="最近同步" count={counts.recent} selected={!assistantOpen && scope.kind === 'recent'} onClick={() => onScope({ kind: 'recent' })} />
        <SidebarItem icon={<Pin20Regular />} label="置顶" count={counts.favorites} selected={!assistantOpen && scope.kind === 'favorites'} onClick={() => onScope({ kind: 'favorites' })} />
        <SidebarItem icon={<CheckmarkCircle20Regular />} label="待办" count={counts.tasks} badge={counts.taskBadge} badgeTone={counts.taskOverdue ? 'alert' : 'normal'} selected={!assistantOpen && scope.kind === 'tasks'} onClick={() => onScope({ kind: 'tasks' })} />
        <SidebarItem icon={<Delete20Regular />} label="回收站" count={counts.trash || undefined} selected={!assistantOpen && scope.kind === 'trash'} onClick={() => onScope({ kind: 'trash' })} />
        {onAssistant && <SidebarItem icon={<Sparkle20Regular />} label="AI 助手" selected={assistantOpen} onClick={onAssistant} />}
      </div>
      <div className="sidebar-group" role="group" aria-label="笔记本">
        <div className="sidebar-group-title"><span>笔记本</span><button type="button" className="sidebar-group-action" aria-label="新建笔记本" title="新建笔记本" onClick={onNewNotebook}><Add16Regular /></button></div>
        {notebooks}
      </div>
      {tags.length > 0 && <div className="sidebar-group" role="group" aria-label="标签">
        <div className="sidebar-group-title"><span>标签</span></div>
        {shownTags.map((tag) => <SidebarItem
          key={tag.name}
          icon={<NumberSymbol16Regular />}
          label={tag.name}
          count={tag.count}
          selected={scope.kind === 'tag' && scope.name === tag.name}
          onClick={() => onScope({ kind: 'tag', name: tag.name })}
        />)}
        {tags.length > 8 && <button type="button" className="sidebar-more" onClick={() => setAllTags((value) => !value)}>{allTags ? '收起' : `显示全部 ${tags.length} 个标签`}</button>}
      </div>}
    </div>
    <div className="sidebar-footer">
      {syncStatus}
      <button ref={settingsRef} type="button" className="toolbar-icon-button" aria-label="设置" title="设置（⌘,）" onClick={onSettings}><Settings20Regular /></button>
    </div>
    {resizer}
  </nav>
}
