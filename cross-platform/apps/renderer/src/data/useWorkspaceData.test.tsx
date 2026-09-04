import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { automationRepository, useWorkspaceData } from './useWorkspaceData'
import * as webdavSync from '../sync/webdavSync'

afterEach(() => vi.restoreAllMocks())

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
