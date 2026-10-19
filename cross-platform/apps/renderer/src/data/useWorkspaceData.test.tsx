import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { automationRepository, useWorkspaceData } from './useWorkspaceData'
import * as webdavSync from '../sync/webdavSync'

afterEach(() => vi.restoreAllMocks())

test('chapter saves preserve unseen content, reject concurrent changes, and retain a recovery version', async () => {
  const { result } = await renderLoadedWorkspace()
  const first = '# 第一章\n\n原始正文\n\n'
  const tail = '# 后续章节\n\n' + '未加载的正文。\n\n'.repeat(30_000)
  const source = first + tail
  let id = ''
  await act(async () => {
    id = (await result.current.importTextFiles([{ name: '章节测试.md', data: new TextEncoder().encode(source) }], { sectionId: 'product' })).createdIds[0]!
    await result.current.loadDocument(id)
  })
  expect(result.current.documents[id]?.type).toBe('notebook-large-document')
  let updated = ''
  await act(async () => {
    const saved = await result.current.saveDocumentSection(id, source, 0, first.length, '# 第一章\n\n修改完成')
    updated = saved.markdown
    expect(updated.slice(saved.end)).toBe(tail)
  })
  expect((await automationRepository.getPageDocument(id))?.markdown).toBe(updated)
  expect((await automationRepository.getPageDocument(id))?.tiptapJson).toEqual({ type: 'doc', content: [] })
  await act(async () => {
    await expect(result.current.saveDocumentSection(id, source, 0, first.length, '过时的编辑')).rejects.toThrow('正文已有其他更新')
  })
  expect((await automationRepository.getPageDocument(id))?.markdown).toBe(updated)
  const recovery = await automationRepository.db.revisions.get(`chapter-recovery:${id}`)
  expect(recovery?.document.markdown).toContain('过时的编辑')
  expect(recovery?.document.markdown?.endsWith(tail)).toBe(true)
})

test.each(['text-dialog', 'backup-entry'])('%s imports a full large Markdown note with a lazy editor cache', async (entry) => {
  const { result } = await renderLoadedWorkspace()
  const source = '# 大书\n\n' + '完整正文，保留段落。\n\n'.repeat(110_000) + '结束标记'
  const file = { name: 'large.md', data: new TextEncoder().encode(source) }
  let id: string | undefined
  await act(async () => {
    if (entry === 'text-dialog') {
      const outcome = await result.current.importTextFiles([file], { sectionId: 'product' })
      expect(outcome.skipped).toEqual([])
      id = outcome.createdIds[0]
    } else {
      expect(await result.current.importFiles([file], 'product')).toBe(1)
    }
  })
  id ??= result.current.pages.find((page) => page.title === 'large')?.id
  expect(id).toBeDefined()
  const stored = await automationRepository.getPageDocument(id!)
  expect(stored?.markdown).toBe(source)
  expect(stored?.tiptapJson).toEqual({ type: 'doc', content: [] })
})

test('a reading position keeps the exact anchor only when the reader supplied one', async () => {
  const { result } = await renderLoadedWorkspace()
  const pageId = result.current.pages[0]!.id
  await act(async () => { await result.current.saveReadingPosition(pageId, 0.5, 123_456) })
  expect(await automationRepository.getReadingPosition(pageId)).toMatchObject({ viewportOffsetFraction: 0.5, anchorUtf16Offset: 123_456 })
  await act(async () => { await result.current.saveReadingPosition(pageId, 0.7) })
  expect(await automationRepository.getReadingPosition(pageId)).toMatchObject({ viewportOffsetFraction: 0.7, anchorUtf16Offset: 0 })
})

// `referenceIndexRevision` only advances at the end of a full reload, so
// waiting for it guarantees the startup load has finished.
async function renderLoadedWorkspace() {
  const rendered = renderHook(() => useWorkspaceData())
  await waitFor(() => expect(rendered.result.current.referenceIndexRevision).toBeGreaterThan(0))
  return rendered
}

test('updatePage mirrors the patched page locally without a full library reload', async () => {
  const { result } = await renderLoadedWorkspace()
  const listTagsSpy = vi.spyOn(automationRepository, 'listTags')
  await act(async () => {
    await result.current.updatePage('vision', { favorite: true })
  })
  expect(listTagsSpy).not.toHaveBeenCalled()
  expect(result.current.pages.find((page) => page.id === 'vision')?.favorite).toBe(true)
})

test('trash, restore and purge keep both page lists consistent without reloading', async () => {
  const { result } = await renderLoadedWorkspace()
  const listTagsSpy = vi.spyOn(automationRepository, 'listTags')

  await act(async () => {
    await result.current.moveToTrash('ai-workflow')
  })
  expect(listTagsSpy).not.toHaveBeenCalled()
  expect(result.current.pages.some((page) => page.id === 'ai-workflow')).toBe(false)
  expect(result.current.trashPages.some((page) => page.id === 'ai-workflow')).toBe(true)

  await act(async () => {
    await result.current.restorePage('ai-workflow')
  })
  expect(listTagsSpy).not.toHaveBeenCalled()
  expect(result.current.pages.some((page) => page.id === 'ai-workflow')).toBe(true)
  expect(result.current.trashPages.some((page) => page.id === 'ai-workflow')).toBe(false)

  await act(async () => {
    await result.current.moveToTrash('migration')
    await result.current.purgePage('migration')
  })
  expect(listTagsSpy).not.toHaveBeenCalled()
  expect(result.current.pages.some((page) => page.id === 'migration')).toBe(false)
  expect(result.current.trashPages.some((page) => page.id === 'migration')).toBe(false)
})

test('renaming a top-level page also renames its transparent section locally', async () => {
  const { result } = await renderLoadedWorkspace()
  const root = result.current.pages.find((page) => page.notebookRoot)
  expect(root).toBeDefined()
  await act(async () => {
    await result.current.updatePage(root!.id, { title: '产品愿景（改）' })
  })
  const renamed = result.current.pages.find((page) => page.id === root!.id)
  expect(renamed?.title).toBe('产品愿景（改）')
  const owningSection = result.current.notebooks
    .flatMap((notebook) => notebook.sections)
    .find((section) => section.id === root!.sectionId)
  expect(owningSection?.name).toBe('产品愿景（改）')
})

test('conflicts report failure, suppress automatic retries, and forward explicit local recovery mode', async () => {
  window.localStorage.setItem('notebook-sync-settings-v1', JSON.stringify({ enabled: false }))
  window.localStorage.setItem('notebook-sync-backend-v1', 'webdav')
  const synchronize = vi.spyOn(webdavSync, 'synchronizeWebdav').mockResolvedValue({ state: 'conflict', conflicts: 1, skipped: 0 })
  const { result, unmount } = await renderLoadedWorkspace()
  try {
    await act(async () => { expect(await result.current.syncNow({ force: true })).toBe(false) })
    expect(result.current.syncState).toBe('conflict')
    await act(async () => { expect(await result.current.syncNow()).toBe(false) })
    expect(result.current.syncState).toBe('conflict')
    window.localStorage.setItem('notebook-sync-settings-v1', JSON.stringify({ enabled: true }))
    await act(async () => { expect(await result.current.syncNow()).toBe(false) })
    expect(synchronize).toHaveBeenCalledTimes(1)
    expect(result.current.syncState).toBe('conflict')
    synchronize.mockResolvedValue({ state: 'synced', conflicts: 0, skipped: 0 })
    await act(async () => { expect(await result.current.syncNow({ force: true, mode: 'push' })).toBe(true) })
    expect(synchronize).toHaveBeenLastCalledWith(automationRepository, expect.any(String), undefined, undefined, 'push', expect.any(Function))
    expect(result.current.syncState).toBe('synced')
  } finally {
    unmount()
    window.localStorage.removeItem('notebook-sync-settings-v1')
    window.localStorage.removeItem('notebook-sync-backend-v1')
  }
})

test('joins automatic events during a sync, skips warm idle triggers, and does not reload an unchanged workspace', async () => {
  window.localStorage.setItem('notebook-sync-settings-v1', JSON.stringify({ enabled: false }))
  window.localStorage.setItem('notebook-sync-backend-v1', 'webdav')
  const { result, unmount } = await renderLoadedWorkspace()
  let resolveSync!: (value: webdavSync.WebdavSyncResult) => void
  const synchronize = vi.spyOn(webdavSync, 'synchronizeWebdav').mockImplementation(() => new Promise((resolve) => { resolveSync = resolve }))
  const reload = vi.spyOn(automationRepository, 'listTags')
  vi.spyOn(automationRepository, 'hasPendingSyncChanges').mockResolvedValue(false)
  try {
    window.localStorage.setItem('notebook-sync-settings-v1', JSON.stringify({ enabled: true }))
    await act(async () => {
      const manual = result.current.syncNow({ force: true })
      const focus = result.current.syncNow({ reason: 'foreground' })
      const blur = result.current.syncNow({ reason: 'background' })
      expect(focus).toBe(manual)
      expect(blur).toBe(manual)
      resolveSync({ state: 'synced', conflicts: 0, skipped: 0, changed: false })
      await manual
    })
    expect(synchronize).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    for (const reason of ['foreground', 'background', 'shutdown'] as const) {
      await act(async () => { expect(await result.current.syncNow({ reason })).toBe(false) })
    }
    expect(result.current.syncState).toBe('synced')
    expect(synchronize).toHaveBeenCalledTimes(1)
    synchronize.mockResolvedValue({ state: 'synced', conflicts: 0, skipped: 0, changed: false })
    await act(async () => { expect(await result.current.syncNow({ force: true })).toBe(true) })
    expect(synchronize).toHaveBeenCalledTimes(2)
  } finally {
    unmount()
    window.localStorage.removeItem('notebook-sync-settings-v1')
    window.localStorage.removeItem('notebook-sync-backend-v1')
  }
})

test('renaming a page rewrites [[title]] links to it and title links show up as backlinks', async () => {
  const { result } = await renderLoadedWorkspace()
  const { markdownToDocument } = await import('../editor/extensions')
  const { WORKSPACE_ID } = await import('./useWorkspaceData')
  let target = ''
  let source = ''
  await act(async () => {
    target = await result.current.createPage('product', 'document', undefined, '链接目标笔记')
    source = await result.current.createPage('product', 'document', undefined, '来源笔记')
  })
  // The source links to the target by title (stored as plain GFM text).
  await act(async () => {
    await result.current.saveDocument(source, markdownToDocument('参考 [[链接目标笔记]] 与 [[链接目标笔记|别名]]。'))
  })
  const backlinks = await result.current.loadBacklinks(target)
  expect(backlinks.map((link) => link.sourcePageId)).toEqual([source])
  expect(backlinks[0]!.excerpt).toContain('[[链接目标笔记]]')

  await act(async () => {
    await result.current.updatePage(target, { title: '改名后的笔记' })
  })
  const stored = await automationRepository.getPageDocument(source)
  expect(stored?.markdown).toContain('参考 [[改名后的笔记]] 与 [[改名后的笔记|别名]]。')
  expect(result.current.documents[source] && JSON.stringify(result.current.documents[source])).toContain('改名后的笔记')
  expect((await result.current.loadBacklinks(target)).map((link) => link.sourcePageId)).toEqual([source])
  const outbox = await automationRepository.listOutbox(WORKSPACE_ID, 1000)
  expect(outbox.some((item) => item.entityType === 'document' && item.entityId === source)).toBe(true)
})

test('a title link to a missing note can create it with that title', async () => {
  const { result } = await renderLoadedWorkspace()
  let created = ''
  await act(async () => {
    created = await result.current.createPage('product', 'document', undefined, '新的想法')
  })
  expect(result.current.pages.find((page) => page.id === created)?.title).toBe('新的想法')
})

test('emptying the trash purges every trashed page but never notes that were not trashed', async () => {
  const { result } = await renderLoadedWorkspace()
  await act(async () => {
    await result.current.moveToTrash('ai-workflow')
    await result.current.moveToTrash('vision')
  })
  expect(result.current.trashPages.map((page) => page.id).sort()).toEqual(['ai-workflow', 'vision'])
  const keep = result.current.pages.map((page) => page.id).filter((id) => id !== 'ai-workflow' && id !== 'vision')
  expect(keep.length).toBeGreaterThan(0)

  let purged = 0
  await act(async () => {
    purged = await result.current.emptyTrash(new Set(result.current.trashPages.map((page) => page.id)))
  })
  expect(purged).toBe(2)
  expect(result.current.trashPages).toEqual([])
  expect(result.current.pages.map((page) => page.id)).toEqual(expect.arrayContaining(keep))
})
