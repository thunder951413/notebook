interface NotebookSection {
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
  icon?: string
  parentPageId?: string
  sortOrder?: number
  treeUpdatedAt?: string
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
  syncStatus?: 'local' | 'pending' | 'synced' | 'conflict' | 'error'
}
