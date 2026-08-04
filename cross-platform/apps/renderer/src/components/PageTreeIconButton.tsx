import { Document20Regular, Folder20Regular, FolderOpen20Regular } from '@fluentui/react-icons'
import type { PageSummary } from '../model'

export function PageTreeIconButton({ page, hasChildren, expanded, onChange }: { page: PageSummary; hasChildren: boolean; expanded: boolean; onChange(): void }) {
  const label = page.icon ? `${page.title}的图标：${page.icon}` : `${page.title}使用默认${hasChildren ? '文件夹' : '文档'}图标`
  return <button type="button" className={`page-tree-icon-button ${page.icon ? 'custom' : ''}`} aria-label={`${label}，点击更换`} title={`${label}；点击更换`} onClick={(event) => {
    event.stopPropagation()
    onChange()
  }}>
    {page.icon
      ? <span className="page-tree-emoji" aria-hidden="true">{page.icon}</span>
      : hasChildren
        ? expanded ? <FolderOpen20Regular aria-hidden="true" /> : <Folder20Regular aria-hidden="true" />
        : <Document20Regular aria-hidden="true" />}
  </button>
}
