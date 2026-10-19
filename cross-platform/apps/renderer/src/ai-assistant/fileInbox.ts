import type { Page } from '@notebook/domain'
import { documentFromMarkdown } from '../data/importedDocument'
import { entryBody } from '../ai/inbox'
import type { NotebookSummary, PageSummary } from '../model'
import type { InboxFiling, InboxOutcome } from './InboxDialog'

/** The workspace operations filing needs; App passes its latest ones on every call. */
export interface FileInboxOperations {
  createPage: (sectionId: string, kind?: Page['kind'], parentPageId?: string) => Promise<string>
  createSection: (notebookId: string, title: string) => Promise<{ pageId: string; sectionId: string }>
  updatePage: (pageId: string, patch: Partial<PageSummary>) => Promise<unknown>
  saveDocument: (pageId: string, document: Record<string, unknown>) => Promise<unknown>
  saveAsset: (pageId: string, file: File) => Promise<{ id: string }>
  setPageTagNames: (pageId: string, names: string[]) => Promise<unknown>
}

export interface FileInboxContext {
  ops: FileInboxOperations
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  expandPage: (pageId: string) => void
  reload: () => Promise<unknown>
}

/** AI 收纳: create the filed notes one by one, reporting per-entry failures instead of stopping. */
export async function fileInbox(items: InboxFiling[], onProgress: (done: number, total: number) => void, { ops, pages, notebooks, expandPage, reload }: FileInboxContext): Promise<InboxOutcome> {
  const outcome: InboxOutcome = { created: [], failed: [] }
  const folders = new Map<string, { sectionId: string; parentPageId: string }>()
  const preview = (markdown: string) => markdown.replace(/!?\[([^\]]*)\]\(notebook-asset:[^)]*\)/g, '$1').replace(/[#>*_`\-[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
  /** A new page at a location: a top-level page of a notebook, or a child of a note. */
  const place = async (title: string, location: { sectionId: string; parentPageId?: string; notebookId?: string }) => {
    if (location.notebookId && !location.parentPageId) {
      const created = await ops.createSection(location.notebookId, title)
      return { pageId: created.pageId, sectionId: created.sectionId }
    }
    const pageId = await ops.createPage(location.sectionId, 'document', location.parentPageId)
    await ops.updatePage(pageId, { title })
    return { pageId, sectionId: location.sectionId }
  }
  for (const [index, item] of items.entries()) {
    try {
      let target: { sectionId: string; parentPageId?: string; notebookId?: string } = item.location
      if (item.newFolder) {
        const key = `${item.location.key}|${item.newFolder}`
        const existing = folders.get(key) ?? (() => {
          const found = pages.find((page) => page.kind !== 'task' && page.title.trim() === item.newFolder && (item.location.parentPageId ? page.parentPageId === item.location.parentPageId : page.notebookRoot && notebooks.find((notebook) => notebook.id === item.location.notebookId)?.sections.some((section) => section.id === page.sectionId)))
          return found ? { sectionId: found.sectionId, parentPageId: found.id } : undefined
        })()
        let folder: { sectionId: string; parentPageId: string }
        if (existing) folder = existing
        else {
          const created = await place(item.newFolder, item.location)
          folder = { sectionId: created.sectionId, parentPageId: created.pageId }
        }
        folders.set(key, folder)
        target = folder
      }
      const { pageId } = await place(item.title, target)
      const asset = item.entry.attachment ? await ops.saveAsset(pageId, new File([item.entry.attachment.data as BlobPart], item.entry.attachment.name, { type: item.entry.attachment.mimeType })) : undefined
      const body = entryBody(item.entry, asset?.id)
      await ops.updatePage(pageId, { preview: preview(body) })
      await ops.saveDocument(pageId, documentFromMarkdown(body))
      if (item.tags.length) await ops.setPageTagNames(pageId, item.tags)
      if (target.parentPageId) expandPage(target.parentPageId)
      outcome.created.push({ entryId: item.entry.id, pageId })
    } catch (error) {
      outcome.failed.push({ entryId: item.entry.id, message: error instanceof Error ? error.message : '保存失败' })
    }
    onProgress(index + 1, items.length)
  }
  await reload()
  return outcome
}
