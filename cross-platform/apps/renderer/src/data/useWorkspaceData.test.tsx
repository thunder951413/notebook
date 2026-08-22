import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { automationRepository, useWorkspaceData } from './useWorkspaceData'

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
