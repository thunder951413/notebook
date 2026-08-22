import { memo, type CSSProperties, type DragEvent as ReactDragEvent } from 'react'
import { ChevronDown16Regular, ChevronRight16Regular, Star16Filled } from '@fluentui/react-icons'
import type { PageSummary } from '../model'
import { PAGE_TREE_DRAG_TYPE } from '../persistence/localLayout'
import { ActionMenu, ActionMenuDivider } from '../ActionMenu'
import { PageTreeIconButton } from './PageTreeIconButton'

export interface PageTreeDropTarget {
  id: string
  position: 'before' | 'inside' | 'after'
}

/** Menu operations a tree row needs. Hosts pass one stable object. */
export interface PageTreeRowActions {
  createChildPage: (page: PageSummary) => void
  createSiblingPage: (page: PageSummary) => void
  changeIcon: (page: PageSummary) => void
  updatePageProps: (page: PageSummary, patch: Pick<PageSummary, 'icon' | 'favorite'>) => void
  duplicatePage: (page: PageSummary) => void
  /** navigation promotes into a fresh notebook root, pages reorders in-section. */
  promoteToRoot: (page: PageSummary, variant: 'navigation' | 'pages') => void
  requestMove: (page: PageSummary) => void
  trashPage: (page: PageSummary) => void
}

export interface PageTreeRowProps {
  page: PageSummary
  depth: number
  hasChildren: boolean
  /** Precomputed descendant count for the row badge. */
  childCount: number
  pagesInSection: PageSummary[]
  /** navigation renders inside the notebook pane, pages inside the page pane. */
  variant: 'navigation' | 'pages'
  selected: boolean
  expanded: boolean
  dropTarget?: PageTreeDropTarget
  actions: PageTreeRowActions
  /** Receives the row's own page/hasChildren/variant so hosts can pass one stable callback. */
  onActivate: (page: PageSummary, hasChildren: boolean, variant: 'navigation' | 'pages') => void
  onToggleExpanded: (pageId: string) => void
  onPrefetch: (pageId: string, delay?: number) => void
  onPrefetchStop: () => void
  onDropPosition: (event: ReactDragEvent<HTMLElement>, pageId: string) => void
  onDrop: (event: ReactDragEvent<HTMLElement>, page: PageSummary) => void
  onDragEnd: () => void
}

function PageTreeRowImpl({ page, depth, hasChildren, childCount, variant, selected, expanded, dropTarget, actions, onActivate, onToggleExpanded, onPrefetch, onPrefetchStop, onDropPosition, onDrop, onDragEnd }: PageTreeRowProps) {
  const ariaLevel = depth + (variant === 'navigation' ? 2 : 1)
  const menu = <>
    <button onClick={() => actions.createChildPage(page)}>新建子页面</button>
    <button onClick={() => actions.createSiblingPage(page)}>新建同级页面</button>
    <ActionMenuDivider />
    <button onClick={() => actions.changeIcon(page)}>更换图标…</button>
    {page.icon && <button onClick={() => actions.updatePageProps(page, { icon: undefined })}>恢复默认图标</button>}
    <button onClick={() => actions.updatePageProps(page, { favorite: !page.favorite })}>{page.favorite ? '取消收藏' : '收藏'}</button>
    {(!page.notebookRoot || variant === 'pages') && <button onClick={() => actions.duplicatePage(page)}>创建副本</button>}
    {page.parentPageId && <button onClick={() => actions.promoteToRoot(page, variant)}>提升为顶层页面</button>}
    <button onClick={() => actions.requestMove(page)}>{variant === 'navigation' ? '移动到…' : '移动到其他分区…'}</button>
    <ActionMenuDivider />
    <button className="destructive-menu-item" onClick={() => actions.trashPage(page)}>移到回收站</button>
  </>
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
    onClick={() => onActivate(page, hasChildren, variant)}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onActivate(page, hasChildren, variant) }
      if (event.key === 'ArrowRight' && hasChildren && !expanded) { event.preventDefault(); onToggleExpanded(page.id) }
      if (event.key === 'ArrowLeft' && hasChildren && expanded) { event.preventDefault(); onToggleExpanded(page.id) }
    }}
    onDragStart={(event) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(PAGE_TREE_DRAG_TYPE, page.id)
    }}
    onDragOver={(event) => onDropPosition(event, page.id)}
    onDrop={(event) => onDrop(event, page)}
    onDragEnd={onDragEnd}
  >
    <button type="button" className={`page-tree-toggle ${hasChildren ? '' : 'empty'}`} tabIndex={-1} aria-label={hasChildren ? expanded ? '折叠子页面' : '展开子页面' : undefined} onClick={(event) => { event.stopPropagation(); if (hasChildren) onToggleExpanded(page.id) }}>{hasChildren ? expanded ? <ChevronDown16Regular /> : <ChevronRight16Regular /> : <span />}</button>
    <PageTreeIconButton page={page} hasChildren={hasChildren} expanded={expanded} onChange={() => actions.changeIcon(page)} />
    <span className="page-tree-title" title={page.title}>{page.title || '无标题页面'}</span>
    {page.favorite && <Star16Filled className="favorite" />}
    {hasChildren && childCount > 0 && <span className="page-tree-child-count">{childCount}</span>}
  </div>}>
    {menu}
  </ActionMenu>
}

/**
 * Memoized because the workspace re-renders on every keystroke of the search
 * box and every sync-state flip; rows only need to refresh when their own
 * props change. Callers keep callbacks, the actions object and per-version
 * page arrays identity-stable so the default shallow comparison holds.
 */
export const PageTreeRow = memo(PageTreeRowImpl)
