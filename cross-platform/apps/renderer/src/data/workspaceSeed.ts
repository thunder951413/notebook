import type { Notebook, Page, Section } from '@notebook/domain'
import type { PageSummary } from '../model'
import { formatUpdatedLabel } from '../updatedLabel'
import { notebookRootSectionId } from './notebookPageRoots'
import { STARTUP_NOTEBOOK_ID, STARTUP_PAGE_ID, STARTUP_SECTION_ID, WORKSPACE_ID } from './workspaceStore'

/** Sample workspace for a fresh Electron install, and page → summary mapping. */
const timestamps = { createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z' }
export const seedNotebooks: Notebook[] = [
  { id: 'personal', workspaceId: WORKSPACE_ID, name: '我的笔记本', emoji: '📓', sortOrder: 0, ...timestamps },
  { id: STARTUP_NOTEBOOK_ID, workspaceId: WORKSPACE_ID, name: '产品团队', emoji: '👥', sortOrder: 1, ...timestamps },
]
export const seedSections: Section[] = [
  { id: 'inbox', notebookId: 'personal', name: '快速记录', color: '#7c3aed', sortOrder: 0, ...timestamps },
  { id: 'research', notebookId: 'personal', name: '研究与阅读', color: '#2563eb', sortOrder: 1, ...timestamps },
  { id: 'projects', notebookId: 'personal', name: '项目', color: '#0f766e', sortOrder: 2, ...timestamps },
  { id: 'product', notebookId: STARTUP_NOTEBOOK_ID, name: '产品设计', color: '#c2410c', sortOrder: 0, ...timestamps },
  { id: 'meetings', notebookId: 'team', name: '会议记录', color: '#be185d', sortOrder: 1, ...timestamps },
]
export const seedPages: Page[] = [
  { id: STARTUP_PAGE_ID, workspaceId: WORKSPACE_ID, sectionId: STARTUP_SECTION_ID, kind: 'document', title: 'Notebook Next 产品愿景', preview: '把笔记、任务、AI 与跨设备编辑放进同一个可靠的工作区。', favorite: true, syncStatus: 'local', ...timestamps },
  { id: 'ai-workflow', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'document', title: 'AI 工作流设计', preview: '选择内容后可以总结、解释、改写，并把结果安全地写回当前笔记。', favorite: false, syncStatus: 'local', ...timestamps },
  { id: 'migration', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'document', title: '旧版本数据迁移', preview: '保留 UUID、附件校验、墓碑与版本历史，并提供迁移前快照。', favorite: false, syncStatus: 'local', ...timestamps },
  { id: 'task-review', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'task', title: '完成跨平台编辑器验收', preview: '验证表格、代码、附件、离线保存和三平台输入法。', favorite: false, important: true, syncStatus: 'local', ...timestamps },
  { id: 'task-migration', workspaceId: WORKSPACE_ID, sectionId: 'product', kind: 'task', title: '演练旧数据迁移', preview: '使用共享契约夹具完成 macOS → Next → Android 往返。', favorite: false, syncStatus: 'local', ...timestamps },
]

export const tagMap: Record<string, string[]> = {
  [STARTUP_PAGE_ID]: ['产品', '愿景'], 'ai-workflow': ['AI', '交互'], migration: ['迁移', '可靠性'],
}

export const toPageSummary = (page: Page): PageSummary => ({
  id: page.id,
  sectionId: page.sectionId ?? '',
  icon: page.icon,
  notebookRoot: Boolean(notebookRootSectionId(page)),
  parentPageId: page.parentPageId,
  sortOrder: page.sortOrder,
  treeUpdatedAt: page.treeUpdatedAt,
  title: page.title,
  preview: page.preview,
  updatedLabel: formatUpdatedLabel(page.updatedAt),
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
  tags: tagMap[page.id] ?? [],
  favorite: page.favorite,
  kind: page.kind,
  completedAt: page.completedAt,
  dueAt: page.dueAt,
  important: page.important,
  reminderAt: page.reminderAt,
  recurrenceRule: page.recurrenceRule,
  locked: page.locked,
  syncStatus: page.syncStatus,
})

/** The desktop (Tauri) app starts empty and restores the real library from WebDAV. */
export const demoSeedAllowed = () => globalThis.document?.documentElement.dataset.shell !== 'tauri'

