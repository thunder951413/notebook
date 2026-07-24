import { vi } from 'vitest'
import { configureReferenceRuntime, openReferencedTarget, resolveNotebookReference, subscribeToReferenceRuntime } from './referenceRuntime'

const page = {
  id: 'target',
  sectionId: 'notes',
  title: '目标页面',
  preview: '',
  updatedLabel: '刚刚',
  tags: [],
  favorite: false,
  kind: 'document' as const,
}

test('only refreshes references whose target document changed', () => {
  const targetListener = vi.fn()
  const otherListener = vi.fn()
  const targetDocument = { type: 'doc', content: [] }
  const otherDocument = { type: 'doc', content: [{ type: 'paragraph' }] }
  const pages = [page]
  const accessiblePageIds = new Set(['target', 'other'])

  configureReferenceRuntime({ pages, accessiblePageIds, documents: { target: targetDocument, other: otherDocument } })
  const unsubscribeTarget = subscribeToReferenceRuntime('target', targetListener)
  const unsubscribeOther = subscribeToReferenceRuntime('other', otherListener)

  configureReferenceRuntime({
    pages,
    accessiblePageIds,
    documents: { target: { type: 'doc', content: [{ type: 'paragraph' }] }, other: otherDocument },
  })

  expect(targetListener).toHaveBeenCalledTimes(1)
  expect(otherListener).not.toHaveBeenCalled()
  unsubscribeTarget()
  unsubscribeOther()
})

test('does not load a linked page body unless an embed needs it', async () => {
  const loadDocument = vi.fn().mockResolvedValue({ type: 'doc', content: [] })
  configureReferenceRuntime({
    pages: [page],
    accessiblePageIds: new Set(['target']),
    documents: {},
    loadDocument,
  })

  expect(await resolveNotebookReference({ pageId: 'target', kind: 'page' })).toMatchObject({ status: 'ready', title: '目标页面' })
  expect(loadDocument).not.toHaveBeenCalled()
  expect(await resolveNotebookReference({ pageId: 'target', kind: 'page' }, true)).toHaveProperty('document')
  expect(loadDocument).toHaveBeenCalledTimes(1)
})

test('reports locked, deleted and restored targets without exposing stale content', async () => {
  configureReferenceRuntime({
    pages: [page],
    accessiblePageIds: new Set(),
    documents: { target: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '隐私正文' }] }] } },
  })
  expect(await resolveNotebookReference({ pageId: 'target', kind: 'page' }, true)).toEqual({
    status: 'locked',
    pageId: 'target',
    title: '隐私内容已锁定',
  })

  configureReferenceRuntime({ pages: [], accessiblePageIds: new Set(), documents: {} })
  expect(await resolveNotebookReference({ pageId: 'target', kind: 'page' })).toMatchObject({ status: 'missing' })

  configureReferenceRuntime({ pages: [page], accessiblePageIds: new Set(['target']), documents: {} })
  expect(await resolveNotebookReference({ pageId: 'target', kind: 'page' })).toMatchObject({ status: 'ready', title: '目标页面' })
})

test('passes the full block target through navigation so the destination can be positioned', () => {
  const openPage = vi.fn()
  const target = { pageId: 'target', kind: 'block' as const, targetId: 'b-one' }
  configureReferenceRuntime({ pages: [page], accessiblePageIds: new Set(['target']), documents: {}, openPage })
  openReferencedTarget(target)
  expect(openPage).toHaveBeenCalledWith(target)
})
