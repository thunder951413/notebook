export type WorkspaceMode = 'document' | 'source'

export interface NotebookSection {
  id: string
  name: string
  color: string
  pageCount: number
}

export interface NotebookSummary {
  id: string
  name: string
  emoji: string
  locked?: boolean
  sections: NotebookSection[]
}

export interface PageSummary {
  id: string
  sectionId: string
  title: string
  preview: string
  updatedLabel: string
  tags: string[]
  favorite?: boolean
  kind?: 'document' | 'task'
  completedAt?: string
  dueAt?: string
  important?: boolean
  reminderAt?: string
  recurrenceRule?: string
  locked?: boolean
}

export const notebooks: NotebookSummary[] = [
  {
    id: 'personal',
    name: '我的笔记本',
    emoji: '📓',
    sections: [
      { id: 'inbox', name: '快速记录', color: '#7c3aed', pageCount: 8 },
      { id: 'research', name: '研究与阅读', color: '#2563eb', pageCount: 16 },
      { id: 'projects', name: '项目', color: '#0f766e', pageCount: 11 },
    ],
  },
  {
    id: 'team',
    name: '产品团队',
    emoji: '👥',
    sections: [
      { id: 'product', name: '产品设计', color: '#c2410c', pageCount: 24 },
      { id: 'meetings', name: '会议记录', color: '#be185d', pageCount: 32 },
    ],
  },
]

export const pages: PageSummary[] = [
  {
    id: 'vision',
    sectionId: 'product',
    title: 'Notebook Next 产品愿景',
    preview: '把笔记、任务、AI 与跨设备编辑放进同一个可靠的工作区。',
    updatedLabel: '刚刚',
    tags: ['产品', '愿景'],
    favorite: true,
  },
  {
    id: 'ai-workflow',
    sectionId: 'product',
    title: 'AI 工作流设计',
    preview: '选择内容后可以总结、解释、改写，并把结果安全地写回当前笔记。',
    updatedLabel: '昨天',
    tags: ['AI', '交互'],
  },
  {
    id: 'migration',
    sectionId: 'product',
    title: '旧版本数据迁移',
    preview: '保留 UUID、附件校验、墓碑与版本历史，并提供迁移前快照。',
    updatedLabel: '7 月 18 日',
    tags: ['迁移', '可靠性'],
  },
]
