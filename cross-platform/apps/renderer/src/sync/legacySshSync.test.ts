import type { NotebookDataBundle, Page, PageDocument } from '@notebook/domain'
import { describe, expect, test, vi } from 'vitest'
import { mergeBundles, publicationBundleWithRemoteConflicts } from './legacySshSync'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const notebookId = '20000000-0000-4000-8000-000000000001'
const pageId = '30000000-0000-4000-8000-000000000001'
const timestamp = '2026-07-22T00:00:00.000Z'

function page(overrides: Partial<Page> = {}): Page {
  return { id: pageId, workspaceId, kind: 'document', title: '页面', preview: '', favorite: false, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced', legacyVersion: 1, ...overrides }
}

function document(text: string, updatedAt = timestamp): PageDocument {
  return { pageId, schemaVersion: 1, tiptapJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, updatedAt }
}

function bundle(currentPage?: Page, currentDocument?: PageDocument): NotebookDataBundle {
  return {
    notebooks: [{ id: notebookId, workspaceId, name: '迁移的笔记', sortOrder: 0, createdAt: timestamp, updatedAt: timestamp }],
    sections: [], pages: currentPage ? [currentPage] : [], documents: currentDocument ? [currentDocument] : [], tags: [], pageTags: [], taskSteps: [], assets: [], pageLinks: [], knowledgeEntities: [], knowledgeRelations: [], readingPositions: [], revisions: [], comments: [], tombstones: [],
  }
}

describe('legacy SSH conflict merge', () => {
  test('keeps a pending local edit when the remote legacy version has not advanced', () => {
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2, title: '本地编辑' }), document('local'))
    const remote = bundle(page({ legacyVersion: 2, title: '远端旧值' }), document('remote'))
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.title).toBe('本地编辑')
    expect(merged.bundle.documents[0]!.tiptapJson).toEqual(document('local').tiptapJson)
  })

  test('stops on concurrent edits, preserves the local body and archives the remote body', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'revision-id' })
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2, title: '本地编辑' }), document('local'))
    const remote = bundle(page({ legacyVersion: 3, updatedAt: '2026-07-22T01:00:00.000Z', title: 'Android 编辑' }), document('remote', '2026-07-22T01:00:00.000Z'))
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.title).toBe('本地编辑')
    expect(merged.bundle.pages[0]!.syncStatus).toBe('conflict')
    expect(merged.conflicts).toEqual([pageId])
    expect(merged.bundle.revisions).toHaveLength(1)
    expect(merged.bundle.revisions[0]!.document.tiptapJson).toEqual(document('remote', '2026-07-22T01:00:00.000Z').tiptapJson)
    vi.unstubAllGlobals()
  })

  test('treats the next explicit local edit as conflict resolution when the remote baseline is unchanged', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'revision-id' })
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2 }), document('local'))
    const remote = bundle(page({ legacyVersion: 3, updatedAt: '2026-07-22T01:00:00.000Z' }), document('remote', '2026-07-22T01:00:00.000Z'))
    const conflicted = mergeBundles(local, remote, new Map(), new Map())
    const resolvedLocal = { ...conflicted.bundle, pages: conflicted.bundle.pages.map((item) => ({ ...item, syncStatus: 'pending' as const, updatedAt: '2026-07-22T02:00:00.000Z' })) }
    const resolved = mergeBundles(resolvedLocal, remote, new Map(), new Map())
    expect(resolved.conflicts).toEqual([])
    expect(resolved.bundle.documents[0]!.tiptapJson).toEqual(document('local').tiptapJson)
    vi.unstubAllGlobals()
  })

  test('lets a newer restored page supersede an older deletion tombstone', () => {
    const local = bundle(page({ updatedAt: '2026-07-22T03:00:00.000Z', syncStatus: 'pending' }), document('restored', '2026-07-22T03:00:00.000Z'))
    const remote = bundle()
    remote.tombstones.push({ id: `page:${pageId}`, workspaceId, entityType: 'page', entityId: pageId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.deletedAt).toBeUndefined()
    expect(merged.bundle.tombstones).toEqual([])
  })

  test('honors a newer remote tombstone instead of resurrecting a deleted note', () => {
    const local = bundle(page({ updatedAt: '2026-07-22T01:00:00.000Z' }), document('local'))
    const remote = bundle()
    remote.tombstones.push({ id: `page:${pageId}`, workspaceId, entityType: 'page', entityId: pageId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.pages[0]!.deletedAt).toBe('2026-07-22T02:00:00.000Z')
    expect(merged.bundle.pages[0]!.syncStatus).toBe('synced')
  })

  test('does not resurrect a section deleted with a notebook cascade', () => {
    const sectionId = '40000000-0000-4000-8000-000000000001'
    const local = bundle()
    local.tombstones.push({ id: `section:${sectionId}`, workspaceId, entityType: 'section', entityId: sectionId, deletedAt: '2026-07-22T02:00:00.000Z', deviceId: 'electron' })
    const remote = bundle()
    remote.sections.push({ id: sectionId, notebookId, name: '远端旧分区', sortOrder: 0, createdAt: timestamp, updatedAt: '2026-07-22T01:00:00.000Z' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.sections).toEqual([])
  })

  test('keeps the newest reading position independently from the winning page body', () => {
    const local = bundle(page({ syncStatus: 'pending', legacyVersion: 2 }), document('local'))
    const remote = bundle(page({ legacyVersion: 1 }), document('remote'))
    local.readingPositions.push({ id: pageId, pageId, anchorUtf16Offset: 10, viewportOffsetFraction: 0.1, updatedAt: '2026-07-22T01:00:00.000Z', deviceId: 'web' })
    remote.readingPositions.push({ id: pageId, pageId, anchorUtf16Offset: 90, viewportOffsetFraction: 0.9, updatedAt: '2026-07-22T02:00:00.000Z', deviceId: 'android' })
    const merged = mergeBundles(local, remote, new Map(), new Map())
    expect(merged.bundle.documents[0]!.tiptapJson).toEqual(document('local').tiptapJson)
    expect(merged.bundle.readingPositions[0]).toMatchObject({ anchorUtf16Offset: 90, deviceId: 'android' })
  })

  test('publishes unrelated edits while leaving a conflicted page at its remote version', () => {
    const otherId = '30000000-0000-4000-8000-000000000099'
    const merged = bundle(page({ syncStatus: 'conflict' }), document('local conflict'))
    merged.pages.push(page({ id: otherId, title: 'unrelated local edit', syncStatus: 'pending' }))
    merged.documents.push({ ...document('unrelated local body'), pageId: otherId })
    const remote = bundle(page({ title: 'remote winner' }), document('remote conflict'))
    const publication = publicationBundleWithRemoteConflicts(merged, remote, new Set([pageId]))
    expect(publication.pages.find((item) => item.id === pageId)?.title).toBe('remote winner')
    expect(publication.documents.find((item) => item.pageId === pageId)?.tiptapJson).toEqual(document('remote conflict').tiptapJson)
    expect(publication.pages.find((item) => item.id === otherId)?.title).toBe('unrelated local edit')
  })
})
