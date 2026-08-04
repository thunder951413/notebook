import type { CSSProperties, DragEvent as ReactDragEvent, ReactNode } from 'react'
import { ChevronDown16Regular, ChevronRight16Regular, Star16Filled } from '@fluentui/react-icons'
import type { PageSummary } from '../model'
import { descendantsOf } from '../pageTree'
import { PAGE_TREE_DRAG_TYPE } from '../persistence/localLayout'
import { ActionMenu } from '../ActionMenu'
import { PageTreeIconButton } from './PageTreeIconButton'

export interface PageTreeDropTarget {
  id: string
  position: 'before' | 'inside' | 'after'
}

export interface PageTreeRowProps {
  page: PageSummary
  depth: number
  hasChildren: boolean
  pagesInSection: PageSummary[]
  /** navigation renders inside the notebook pane, pages inside the page pane. */
  variant: 'navigation' | 'pages'
  selected: boolean
  expanded: boolean
  dropTarget?: PageTreeDropTarget
  /** Context-menu contents, rendered inside the row's ActionMenu. */
  menu: ReactNode
  onActivate: () => void
  onToggleExpanded: () => void
  onIconChange: () => void
  onPrefetch: (pageId: string, delay?: number) => void
  onPrefetchStop: () => void
  onDropPosition: (event: ReactDragEvent<HTMLElement>, pageId: string) => void
  onDrop: (event: ReactDragEvent<HTMLElement>, page: PageSummary) => void
  onDragEnd: () => void
}

export function PageTreeRow({ page, depth, hasChildren, pagesInSection, variant, selected, expanded, dropTarget, menu, onActivate, onToggleExpanded, onIconChange, onPrefetch, onPrefetchStop, onDropPosition, onDrop, onDragEnd }: PageTreeRowProps) {
  const ariaLevel = depth + (variant === 'navigation' ? 2 : 1)
  return <ActionMenu openOnContext label={`${page.title}页面操作`} trigger={<div
    role="treeitem"
    tabIndex={0}
    aria-level={ariaLevel}
    aria-selected={selected}
    aria-expanded={hasChildren ? expanded : undefined}
    draggable
    className={`page-tree-row ${variant === 'navigation' ? 'unified-page-row' : ''} ${selected ? 'selected' : ''} ${dropTarget?.id === page.id ? `drop-${dropTarget.position}` : ''}`}
    style={{ '--page-depth': depth } as CSSProperties}
    onPointerEnter={() => onPrefetch(page.id)}
    onPointerLeave={onPrefetchStop}
    onFocus={() => onPrefetch(page.id, 0)}
    onClick={onActivate}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onActivate() }
      if (event.key === 'ArrowRight' && hasChildren && !expanded) { event.preventDefault(); onToggleExpanded() }
      if (event.key === 'ArrowLeft' && hasChildren && expanded) { event.preventDefault(); onToggleExpanded() }
    }}
    onDragStart={(event) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(PAGE_TREE_DRAG_TYPE, page.id)
    }}
    onDragOver={(event) => onDropPosition(event, page.id)}
    onDrop={(event) => onDrop(event, page)}
    onDragEnd={onDragEnd}
  >
    <button type="button" className={`page-tree-toggle ${hasChildren ? '' : 'empty'}`} tabIndex={-1} aria-label={hasChildren ? expanded ? '折叠子页面' : '展开子页面' : undefined} onClick={(event) => { event.stopPropagation(); if (hasChildren) onToggleExpanded() }}>{hasChildren ? expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular /> : <span />}</button>
    <PageTreeIconButton page={page} hasChildren={hasChildren} expanded={expanded} onChange={onIconChange} />
    <span className="page-tree-title" title={page.title}>{page.title || '无标题页面'}</span>
    {page.favorite && <Star16Filled className="favorite" />}
    {hasChildren && <span className="page-tree-child-count">{descendantsOf(pagesInSection, page.id).size}</span>}
  </div>}>
    {menu}
  </ActionMenu>
}
