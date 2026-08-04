import { Document20Regular, FolderOpen20Regular } from '@fluentui/react-icons'
import type { PageSummary } from '../model'

export function EmptyParentPageHint({ pages, onOpen }: { pages: PageSummary[]; onOpen: (pageId: string) => void }) {
  const visiblePages = pages.slice(0, 6)
  return <aside className="empty-parent-page-hint" role="note" aria-label="目录页提示">
    <FolderOpen20Regular />
    <div className="empty-parent-page-copy">
      <strong>这是一个目录页</strong>
      <span>正文暂时为空，下方有 {pages.length} 篇子笔记。可以打开子笔记，或直接在下面开始输入。</span>
    </div>
    <nav aria-label="子笔记快捷入口">
      {visiblePages.map((page) => <button key={page.id} type="button" onClick={() => onOpen(page.id)}><Document20Regular />{page.title || '无标题页面'}</button>)}
      {pages.length > visiblePages.length && <span>还有 {pages.length - visiblePages.length} 篇</span>}
    </nav>
  </aside>
}
