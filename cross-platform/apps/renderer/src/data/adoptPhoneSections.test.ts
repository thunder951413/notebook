import { beforeEach, expect, test } from 'vitest'
import { adoptOrphanPhoneSections, db, ensureNotebookPageRoots, repository, WORKSPACE_ID } from './workspaceStore'

const at = '2026-10-16T00:00:00.000Z'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

test('a library made on the phone under the Android default notebook joins the main notebook and gets its tree root', async () => {
  await repository.saveNotebook({ id: 'work', workspaceId: WORKSPACE_ID, name: '工作', emoji: '📒', sortOrder: 0, createdAt: at, updatedAt: at })
  await repository.saveNotebook({ id: 'life', workspaceId: WORKSPACE_ID, name: '生活', emoji: '📗', sortOrder: 1, createdAt: at, updatedAt: at })
  await repository.saveSection({ id: 'w1', notebookId: 'work', name: '驱动', color: '', sortOrder: 0, createdAt: at, updatedAt: at })
  await repository.saveSection({ id: 'w2', notebookId: 'work', name: '编译', color: '', sortOrder: 1, createdAt: at, updatedAt: at })
  await repository.saveSection({ id: 'l1', notebookId: 'life', name: '旅行', color: '', sortOrder: 0, createdAt: at, updatedAt: at })
  // As synced from the phone: the section's notebook does not exist here.
  await db.sections.put({ id: 'novel', notebookId: 'personal', name: '小说', color: '', sortOrder: 5, createdAt: at, updatedAt: at })
  await db.pages.put({ id: 'p1', workspaceId: WORKSPACE_ID, sectionId: 'novel', kind: 'document', title: '第一章', preview: '', favorite: false, createdAt: at, updatedAt: at, syncStatus: 'synced', sortOrder: 1000 })

  expect(await adoptOrphanPhoneSections()).toBe(1)
  const section = await db.sections.get('novel')
  expect(section).toMatchObject({ notebookId: 'work', sortOrder: 2 })
  expect((await db.syncOutbox.toArray()).some((change) => change.entityType === 'section' && change.entityId === 'novel')).toBe(true)

  await ensureNotebookPageRoots()
  const root = (await db.pages.where('sectionId').equals('novel').toArray()).find((page) => page.title === '小说')
  expect(root).toBeDefined()
  expect((await db.pages.get('p1'))?.parentPageId).toBe(root!.id)
  expect(await adoptOrphanPhoneSections()).toBe(0)
})
