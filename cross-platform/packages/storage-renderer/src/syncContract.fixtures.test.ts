/**
 * Runner for SyncContractFixtures/webdav-v4/conflict.json: the renderer's
 * merge pipeline (shared by the Tauri and Electron shells) must settle each
 * scenario exactly as Android's WebdavSyncClient does.
 */
import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'vitest'
import type { Page, PageDocument } from '@notebook/domain'
import conflictFixture from '../../../../SyncContractFixtures/webdav-v4/conflict.json'
import { DexieNotebookRepository, NotebookRendererDatabase } from './index'

interface Scenario {
  name: string
  baseline: { markdown: string; version: number }
  localEdit: string | null
  remote: { ver: number; markdown: string; ownDevice: boolean }
  expected: { markdown: string; conflictCopy: string | null; republishedVersion?: number }
}

const opened: NotebookRendererDatabase[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (db) => { db.close(); await db.delete() }))
})

const value = conflictFixture as unknown as { pageTitle: string; scenarios: Scenario[] }
const document = (pageId: string, markdown: string, updatedAt: string): PageDocument => ({ pageId, schemaVersion: 3, markdown, tiptapJson: { type: 'doc', content: [] }, updatedAt })

for (const scenario of value.scenarios) {
  test(`conflict.json: ${scenario.name}`, async () => {
    const db = new NotebookRendererDatabase(`contract-${crypto.randomUUID()}`)
    opened.push(db)
    const repository = new DexieNotebookRepository(db)
    const page: Page = {
      id: 'contract-page', workspaceId: 'workspace-a', sectionId: 'section-a', kind: 'document', title: value.pageTitle, preview: '',
      favorite: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', syncStatus: 'synced',
    }
    await repository.savePage(page, document(page.id, scenario.baseline.markdown, page.updatedAt))
    await db.syncOutbox.clear()
    await db.syncVersions.bulkPut([
      { id: `workspace-a:page:${page.id}`, version: scenario.baseline.version, webdavParentVersion: true },
      { id: `workspace-a:document:${page.id}`, version: scenario.baseline.version, webdavParentVersion: true },
    ])
    if (scenario.localEdit !== null) {
      await repository.savePage({ ...page, syncStatus: 'pending', updatedAt: '2026-01-03T00:00:00.000Z' }, document(page.id, scenario.localEdit, '2026-01-03T00:00:00.000Z'))
    }
    const pagesBefore = await db.pages.count()
    const result = await repository.applyRemoteChanges('workspace-a', [{
      cursor: 1, entityType: 'document', entityId: page.id, version: scenario.remote.ver, operation: 'upsert',
      payload: document(page.id, scenario.remote.markdown, '2026-01-04T00:00:00.000Z') as unknown as Record<string, unknown>,
      ...(scenario.remote.ownDevice ? { ownDevice: true } : {}),
    }], 1, undefined, true, false, { autoResolve: true })

    expect(result.conflicts).toEqual([])
    expect((await repository.getPageDocument(page.id))?.markdown).toBe(scenario.expected.markdown)
    const copyPageId = result.resolved?.find((item) => item.copyPageId)?.copyPageId
    if (scenario.expected.conflictCopy === null) {
      expect(copyPageId).toBeUndefined()
      expect(await db.pages.count()).toBe(pagesBefore)
    } else {
      expect((await repository.getPageDocument(copyPageId!))?.markdown).toBe(scenario.expected.conflictCopy)
      expect((await repository.getPage(copyPageId!))?.title).toContain(value.pageTitle)
    }
    if (scenario.expected.republishedVersion !== undefined) {
      const queued = (await repository.listOutbox('workspace-a')).find((item) => item.entityType === 'document' && item.entityId === page.id)
      expect(queued?.expectedVersion).toBe(scenario.expected.republishedVersion)
    }
  })
}
