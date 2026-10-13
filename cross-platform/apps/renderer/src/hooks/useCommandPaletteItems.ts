import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PaletteItem } from '../CommandPalette'
import type { NotebookSummary, PageSummary } from '../model'
import type { LegacySyncMode } from '../sync/legacySshSync'

export const syncLabels = { offline: '仅保存在本机', syncing: '正在同步', synced: '同步完成', conflict: '同步冲突', error: '同步失败' } as const

export interface CommandPaletteOptions {
  syncState: keyof typeof syncLabels
  currentSection: { id: string; name: string } | undefined
  activeArea: string
  currentNotebook: NotebookSummary | undefined
  hasActivePage: boolean
  focusMode: boolean
  vimEnabled: boolean
  privacyUnlocked: boolean
  navigationOpen: boolean
  recentPageIds: string[]
  accessiblePages: PageSummary[]
  accessibleTrashPages: PageSummary[]
  notebooks: NotebookSummary[]
  currentPage: PageSummary
  createPage: (sectionId: string, kind?: 'document' | 'task', parentPageId?: string) => Promise<string>
  openDailyNote: () => Promise<void>
  createPageFromMarkdown: (title: string, markdown: string) => Promise<void>
  clipFromClipboard: () => Promise<void>
  selectArea: (area: 'notes' | 'tasks' | 'trash') => void
  openRecentPage: (pageId: string) => void
  toggleNavigation: () => void
  syncNow: (options?: { signal?: AbortSignal; force?: boolean; mode?: LegacySyncMode; scope?: { pageId: string } }) => Promise<boolean>
  chooseImport: () => void
  runExport: () => Promise<void>
  trashPage: (pageId: string, alwaysConfirm?: boolean) => Promise<unknown>
  restorePage: (pageId: string) => Promise<unknown>
  purgePage: (pageId: string) => Promise<unknown>
  deleteNotebook: (notebookId: string) => Promise<unknown>
  searchWorkspace: (query: string, limit?: number, includeLocked?: boolean) => Promise<Array<{ id: string }>>
  setCreateRequest: Dispatch<SetStateAction<'notebook' | 'rootPage' | undefined>>
  setReferenceHelpOpen: Dispatch<SetStateAction<boolean>>
  setVimEnabled: Dispatch<SetStateAction<boolean>>
  setAiWorkspaceOpen: Dispatch<SetStateAction<boolean>>
  setFocusMode: Dispatch<SetStateAction<boolean>>
  setSettingsPage: Dispatch<SetStateAction<'general' | 'data' | 'services'>>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setActiveArea: Dispatch<SetStateAction<string>>
  setActivePage: Dispatch<SetStateAction<string>>
  setPagesOpen: Dispatch<SetStateAction<boolean>>
}

/**
 * Builds the unified command palette: commands, recent-first page entries and
 * settings shortcuts. Pure assembly of state into PaletteItems, so the palette
 * behavior can change without touching the tree or editor code.
 */
export function useCommandPaletteItems(options: CommandPaletteOptions) {
  const { accessiblePages, accessibleTrashPages, currentPage, currentSection, currentNotebook, hasActivePage, activeArea, recentPageIds, notebooks } = options

  const searchPalettePageIds = useCallback(async (searchTerm: string) => (
    await options.searchWorkspace(searchTerm, 50, options.privacyUnlocked)
  ).map((page) => page.id), [options])

  const paletteItems: PaletteItem[] = (() => {
    const commands: Array<PaletteItem | false | undefined> = [
      currentSection && activeArea === 'notes' && { id: 'command:new-page', group: 'command', title: '新建页面', subtitle: currentSection.name, keywords: '笔记 新建 markdown', run: () => { void options.createPage(currentSection.id).then(options.setActivePage) } },
      currentSection && activeArea === 'notes' && { id: 'command:daily-note', group: 'command', title: '打开今天的日记', subtitle: '同一天只创建一篇', keywords: '每日笔记 日记 journal daily', run: () => { void options.openDailyNote() } },
      currentSection && activeArea === 'notes' && { id: 'command:template-meeting', group: 'command', title: '从模板新建会议记录', subtitle: '议题、结论、行动项', keywords: '模板 template meeting', run: () => { void options.createPageFromMarkdown('会议记录', `## 会议信息

- 时间：
- 参与人：

## 议题


## 结论


## 行动项

- [ ]
`) } },
      currentSection && activeArea === 'notes' && { id: 'command:template-project', group: 'command', title: '从模板新建项目计划', subtitle: '目标、里程碑、风险与任务', keywords: '模板 template project', run: () => { void options.createPageFromMarkdown('项目计划', `## 目标


## 里程碑

- [ ]

## 风险


## 下一步

- [ ]
`) } },
      currentSection && activeArea === 'notes' && { id: 'command:web-clip', group: 'command', title: '从剪贴板剪藏网页', subtitle: '保留正文结构，移除网页字体、颜色和布局', keywords: '网页剪藏 clipboard html markdown', run: () => { void options.clipFromClipboard() } },
      currentSection && { id: 'command:new-task', group: 'command', title: '新建任务', subtitle: currentSection.name, keywords: '待办 todo', run: () => { options.selectArea('tasks'); void options.createPage(currentSection.id, 'task').then(options.setActivePage) } },
      { id: 'command:new-notebook', group: 'command', title: '新建笔记本', keywords: '工作区', run: () => options.setCreateRequest('notebook') },
      currentNotebook && (!currentNotebook.locked || options.privacyUnlocked) && { id: 'command:new-section', group: 'command', title: '新建顶层页面', subtitle: currentNotebook.name, keywords: '根页面 文件夹 分类', run: () => options.setCreateRequest('rootPage') },
      { id: 'command:sync', group: 'command', title: options.syncState === 'syncing' ? '正在同步' : '立即同步', subtitle: syncLabels[options.syncState], keywords: 'ssh sftp 服务器 推送 拉取', run: () => { if (options.syncState !== 'syncing') void options.syncNow({ force: true }) } },
      { id: 'command:notes', group: 'command', title: '打开笔记', keywords: '页面', run: () => options.selectArea('notes') },
      { id: 'command:tasks', group: 'command', title: '打开任务', keywords: '待办 todo', run: () => options.selectArea('tasks') },
      { id: 'command:trash', group: 'command', title: '打开回收站', keywords: '删除 恢复', run: () => options.selectArea('trash') },
      { id: 'command:reference-help', group: 'command', title: '双链使用说明', subtitle: '页面链接、块引用与内容嵌入', keywords: '双链 双链说明 使用说明 帮助 教程 双向链接 wiki link backlink 引用 嵌入 [[', run: () => options.setReferenceHelpOpen(true) },
      hasActivePage && activeArea === 'notes' && { id: 'command:vim', group: 'command', title: options.vimEnabled ? '关闭 Vim 模式' : '启用 Vim 模式', keywords: 'normal insert esc', run: () => options.setVimEnabled((value) => !value) },
      { id: 'command:navigation', group: 'command', title: options.navigationOpen ? '隐藏导航窗格' : '显示导航窗格', keywords: '侧栏 左侧', run: options.toggleNavigation },
      { id: 'command:ai', group: 'command', title: '打开 AI 工作区', subtitle: '审阅全部笔记变化、逐行差异和 AI 对话', keywords: '智能 总结 修改 对比 @', run: () => options.setAiWorkspaceOpen(true) },
      hasActivePage && activeArea === 'notes' && { id: 'command:focus', group: 'command', title: options.focusMode ? '退出聚焦模式' : '进入聚焦模式', keywords: '全屏 最大化', run: () => options.setFocusMode((value) => !value) },
      { id: 'command:settings', group: 'command', title: '打开设置', keywords: '偏好 配置', run: () => { options.setSettingsPage('general'); options.setSettingsOpen(true) } },
      { id: 'command:import', group: 'command', title: '导入文件或备份', keywords: '迁移 markdown zip nbx', run: options.chooseImport },
      { id: 'command:export', group: 'command', title: '导出完整备份', keywords: '备份 zip', run: () => { void options.runExport() } },
      hasActivePage && activeArea !== 'trash' && { id: 'command:delete-page', group: 'command', title: '将当前页面移到回收站', subtitle: currentPage.title, keywords: '删除 笔记 任务', dangerous: true, confirmDescription: `“${currentPage.title}”将移到回收站；如果其他页面引用了它，引用位置会显示失效提示。之后仍可恢复。`, confirmLabel: '移到回收站', run: () => { void options.trashPage(currentPage.id) } },
      hasActivePage && activeArea === 'trash' && { id: 'command:restore-page', group: 'command', title: '恢复当前页面', subtitle: currentPage.title, keywords: '撤销 删除', run: () => { void options.restorePage(currentPage.id).then(() => { options.selectArea('notes'); options.setActivePage(currentPage.id) }) } },
      hasActivePage && activeArea === 'trash' && { id: 'command:purge-page', group: 'command', title: '永久删除当前页面', subtitle: currentPage.title, keywords: '彻底 清除', dangerous: true, confirmDescription: `“${currentPage.title}”及其历史和附件引用将被永久删除，无法恢复。`, confirmLabel: '永久删除', run: () => { void options.purgePage(currentPage.id).then(() => options.setActivePage(accessibleTrashPages.find((page) => page.id !== currentPage.id)?.id ?? accessiblePages[0]?.id ?? '')) } },
      currentNotebook && activeArea === 'notes' && (!currentNotebook.locked || options.privacyUnlocked) && { id: 'command:delete-notebook', group: 'command', title: '删除当前笔记本及全部内容', subtitle: currentNotebook.name, keywords: '工作区 永久', dangerous: true, confirmDescription: `“${currentNotebook.name}”中的全部分区、页面、任务、附件和历史版本都会被删除，无法撤销。`, confirmLabel: '删除整个笔记本', run: () => { void options.deleteNotebook(currentNotebook.id) } },
    ]
    const recentOrder = new Map([...recentPageIds].reverse().map((id, index) => [id, index]))
    const pageItems = [...accessiblePages].sort((left, right) => (recentOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (recentOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)).map<PaletteItem>((page) => ({
      id: `page:${page.id}`,
      group: 'page',
      title: page.title,
      subtitle: `${page.kind === 'task' ? '任务' : '页面'} · ${notebooks.flatMap((notebook) => notebook.sections).find((section) => section.id === page.sectionId)?.name ?? '未分类'}`,
      keywords: `${page.preview} ${page.tags.join(' ')}`,
      recent: recentOrder.has(page.id),
      run: () => {
        if (page.kind === 'task') { options.setActiveArea('tasks'); options.setActivePage(page.id); options.setPagesOpen(true) }
        else options.openRecentPage(page.id)
      },
    }))
    const openSettings = (page: 'general' | 'data' | 'services') => { options.setSettingsPage(page); options.setSettingsOpen(true) }
    const settings: PaletteItem[] = [
      { id: 'setting:general', group: 'setting', title: '常规设置', subtitle: '外观、主题和工作状态', keywords: '颜色 深色 浅色 快速记录', run: () => openSettings('general') },
      { id: 'setting:updates', group: 'setting', title: '检查应用更新', subtitle: '从 GitHub Release 检查 macOS、Windows 或 Linux 新版本', keywords: '升级 版本 release github update', run: () => { openSettings('general'); window.setTimeout(() => { void window.notebookDesktop?.updates.check() }, 0) } },
      { id: 'setting:data', group: 'setting', title: '数据与备份', subtitle: '导入、导出和数据目录', keywords: '迁移 markdown html pdf nbx zip', run: () => openSettings('data') },
      { id: 'setting:sync', group: 'setting', title: '同步与连接', subtitle: 'SSH/SFTP 服务器设置', keywords: '远端 地址 端口 密码 主机指纹 android', run: () => openSettings('services') },
      { id: 'setting:privacy', group: 'setting', title: '隐私笔记本', subtitle: '解锁、密码与加密说明', keywords: '安全 锁定 AES', run: () => openSettings('services') },
      { id: 'setting:ai', group: 'setting', title: 'AI 与协作服务', subtitle: '查看本机服务状态', keywords: '智能 hocuspocus yjs', run: () => openSettings('services') },
    ]
    return [...commands.filter((item): item is PaletteItem => Boolean(item)), ...pageItems, ...settings]
  })()

  return { paletteItems, searchPalettePageIds }
}
