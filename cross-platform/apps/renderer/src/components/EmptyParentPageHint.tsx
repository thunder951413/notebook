import { ChevronRight16Regular, Document20Regular, FolderOpen20Regular } from '@fluentui/react-icons'
import type { PageSummary } from '../model'

export interface EmptyParentPageProps {
  title: string
  icon?: string
  pages: PageSummary[]
  /** Direct children per page id, for the "N 个子笔记" of children that are folders themselves. */
  childCounts: ReadonlyMap<string, number>
  onOpen: (pageId: string) => void
  /** Start writing a body: the overview gives way to the editor. */
  onCompose: () => void
}

/**
 * What a note with no body but sub-notes shows instead of a blank editor: its
 * sub-notes, as a list. Writing a body stays one click away.
 */
export function EmptyParentPage({ title, icon, pages, childCounts, onOpen, onCompose }: EmptyParentPageProps) {
  const name = title.trim() || '无标题'
  return <aside className="empty-parent-page" role="note" aria-label="目录页提示">
    <header className="empty-parent-page-head">
      <span className="empty-parent-page-icon" aria-hidden="true">{icon || <FolderOpen20Regular />}</span>
      <div>
        <h2>{name}</h2>
        <p><strong>这是一个目录页</strong> · {pages.length} 个子笔记</p>
      </div>
    </header>
    <nav aria-label="子笔记快捷入口">
      <ul>
        {pages.map((page) => {
          const nested = childCounts.get(page.id) ?? 0
          return <li key={page.id}>
            <button type="button" onClick={() => onOpen(page.id)}>
              <span className="empty-parent-page-glyph" aria-hidden="true">{page.icon || (nested ? <FolderOpen20Regular /> : <Document20Regular />)}</span>
              <span className="empty-parent-page-text">
                <span className="empty-parent-page-name">{page.title.trim() || '无标题页面'}</span>
                <small>{page.preview.trim() || (nested ? `${nested} 个子笔记` : '没有更多内容')}</small>
              </span>
              {nested > 0 && <span className="empty-parent-page-count" title={`${nested} 个子笔记`}>{nested}</span>}
              <ChevronRight16Regular aria-hidden="true" />
            </button>
          </li>
        })}
      </ul>
    </nav>
    <button type="button" className="empty-parent-page-compose" onClick={onCompose}>添加正文…</button>
  </aside>
}
