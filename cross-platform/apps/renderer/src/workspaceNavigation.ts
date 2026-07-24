import type { NotebookSummary } from './model'

export interface QuickCaptureTarget {
  notebookId: string
  sectionId: string
}

export function findQuickCaptureTarget(notebooks: NotebookSummary[]): QuickCaptureTarget | undefined {
  const available = notebooks.filter((notebook) => !notebook.locked && notebook.sections.length > 0)
  const preferred = available
    .flatMap((notebook) => notebook.sections.map((section) => ({ notebook, section })))
    .find(({ section }) => /(^|[\s_-])(inbox|quick)([\s_-]|$)|快速记录|收件箱/i.test(`${section.id} ${section.name}`))
  const fallbackNotebook = available[0]
  const fallbackSection = fallbackNotebook?.sections[0]
  const target = preferred ?? (fallbackNotebook && fallbackSection ? { notebook: fallbackNotebook, section: fallbackSection } : undefined)
  return target ? { notebookId: target.notebook.id, sectionId: target.section.id } : undefined
}
