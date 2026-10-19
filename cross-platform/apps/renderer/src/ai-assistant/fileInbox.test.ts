import { expect, test, vi } from 'vitest'
import type { InboxEntry } from '../ai/inbox'
import type { NotebookSummary, PageSummary } from '../model'
import type { InboxFiling } from './InboxDialog'
import { fileInbox, type FileInboxContext } from './fileInbox'

const entry = (id: string, markdown = '正文'): InboxEntry => ({ id, source: '测试', kind: 'note', title: id, markdown })
const filing = (id: string, extra: Partial<InboxFiling> = {}): InboxFiling => ({ entry: entry(id), title: `标题 ${id}`, tags: [], location: { key: 'sec-1', sectionId: 'sec-1', label: '笔记本' }, ...extra })

function context(overrides: Partial<FileInboxContext['ops']> = {}) {
  let next = 0
  const ops = {
    createPage: vi.fn(async () => `page-${++next}`),
    createSection: vi.fn(async () => ({ pageId: `root-${++next}`, sectionId: 'sec-new' })),
    updatePage: vi.fn(async () => undefined),
    saveDocument: vi.fn(async () => undefined),
    saveAsset: vi.fn(async () => ({ id: 'asset-1' })),
    setPageTagNames: vi.fn(async () => undefined),
    ...overrides,
  }
  const value: FileInboxContext = { ops, pages: [] as PageSummary[], notebooks: [] as NotebookSummary[], expandPage: vi.fn(), reload: vi.fn(async () => undefined) }
  return { ops, value }
}

test('files each entry, tags it, reports progress and reloads once', async () => {
  const { ops, value } = context()
  const progress = vi.fn()
  const outcome = await fileInbox([filing('a', { tags: ['读书'] }), filing('b')], progress, value)
  expect(outcome.created).toEqual([{ entryId: 'a', pageId: 'page-1' }, { entryId: 'b', pageId: 'page-2' }])
  expect(outcome.failed).toEqual([])
  expect(ops.setPageTagNames).toHaveBeenCalledTimes(1)
  expect(ops.setPageTagNames).toHaveBeenCalledWith('page-1', ['读书'])
  expect(progress.mock.calls).toEqual([[1, 2], [2, 2]])
  expect(value.reload).toHaveBeenCalledTimes(1)
})

test('one failing entry is reported without stopping the rest', async () => {
  const saveDocument = vi.fn().mockRejectedValueOnce(new Error('磁盘已满')).mockResolvedValue(undefined)
  const { value } = context({ saveDocument })
  const outcome = await fileInbox([filing('a'), filing('b')], () => undefined, value)
  expect(outcome.failed).toEqual([{ entryId: 'a', message: '磁盘已满' }])
  expect(outcome.created.map((item) => item.entryId)).toEqual(['b'])
})

test('a new folder is created once and shared by entries filed into it', async () => {
  const { ops, value } = context()
  const location = { key: 'sec-1', sectionId: 'sec-1', parentPageId: 'parent', label: '父页面' }
  await fileInbox([filing('a', { location, newFolder: '收纳' }), filing('b', { location, newFolder: '收纳' })], () => undefined, value)
  // folder page + two notes
  expect(ops.createPage).toHaveBeenCalledTimes(3)
  expect(value.expandPage).toHaveBeenCalledWith(expect.stringMatching(/^page-/))
})

test('attachments are saved as assets and linked in the body', async () => {
  const { ops, value } = context()
  const attachment = { name: '图.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }
  await fileInbox([filing('a', { entry: { ...entry('a', ''), kind: 'image', attachment } })], () => undefined, value)
  expect(ops.saveAsset).toHaveBeenCalledWith('page-1', expect.any(File))
  expect(ops.updatePage).toHaveBeenCalledWith('page-1', { preview: '图.png' })
})
