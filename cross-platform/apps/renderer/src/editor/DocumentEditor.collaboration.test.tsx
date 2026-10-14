import { act, render, screen } from '@testing-library/react'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import type { CollaborativeDocumentSession } from '../collaboration/useCollaborativeDocument'
import { DocumentEditor } from './DocumentEditor'

const state = vi.hoisted(() => ({ session: undefined as CollaborativeDocumentSession | undefined }))
vi.mock('../collaboration/useCollaborativeDocument', () => ({ useCollaborativeDocument: () => state.session }))
// Caret presence does not affect document synchronization; the real Yjs/Tiptap
// collaboration extension remains active in these hydration regressions.
vi.mock('@tiptap/extension-collaboration-caret', async () => {
  const { Extension } = await import('@tiptap/core')
  return { default: Extension.create({ name: 'testCollaborationCaret' }) }
})

beforeEach(() => {
  state.session = { document: new Y.Doc(), provider: {} as HocuspocusProvider, status: 'connecting', readOnly: true, synced: false }
})
afterEach(() => { state.session?.document.destroy() })

const cached = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '本机缓存正文' }] }] }

function putRemoteText(document: Y.Doc, text: string) {
  const paragraph = new Y.XmlElement('paragraph')
  const body = new Y.XmlText()
  body.insert(0, text)
  paragraph.insert(0, [body])
  document.getXmlFragment('default').insert(0, [paragraph])
}

test('hydrates a new shared document from local content after an editor is authenticated and initially synchronized', async () => {
  const props = { workspaceId: 'workspace-a', pageId: 'page-a', pageTitle: 'Page', content: cached }
  const { rerender } = render(<DocumentEditor {...props} />)
  state.session = { ...state.session!, status: 'connected', readOnly: false, synced: true }
  rerender(<DocumentEditor {...props} />)
  expect(await screen.findByLabelText('页面正文')).toHaveTextContent('本机缓存正文')
  expect(state.session.document.getXmlFragment('default').toString()).toContain('本机缓存正文')
})

test('a viewer shows the shared body, receives subsequent updates and never injects stale local content', async () => {
  putRemoteText(state.session!.document, '远端权威正文')
  state.session = { ...state.session!, status: 'connected', synced: true }
  const props = { workspaceId: 'workspace-a', pageId: 'page-a', pageTitle: 'Page' }
  const { rerender } = render(<DocumentEditor {...props} content={cached} />)
  const body = await screen.findByLabelText('页面正文')
  expect(body).toHaveTextContent('远端权威正文')
  expect(body).toHaveAttribute('contenteditable', 'false')
  rerender(<DocumentEditor {...props} forceRestore content={{ ...cached, content: [{ type: 'paragraph', content: [{ type: 'text', text: '禁止写入的旧版本' }] }] }} />)
  expect(body).toHaveTextContent('远端权威正文')
  act(() => {
    const paragraph = state.session!.document.getXmlFragment('default').get(0) as Y.XmlElement
    ;(paragraph.get(0) as Y.XmlText).insert(0, '后续更新 ')
  })
  expect(body).toHaveTextContent('后续更新 远端权威正文')
  expect(state.session.document.getXmlFragment('default').toString()).not.toContain('本机缓存正文')
  expect(state.session.document.getXmlFragment('default').toString()).not.toContain('禁止写入的旧版本')
})

test('downgrading an open editor makes it read-only without replacing the shared content', async () => {
  putRemoteText(state.session!.document, '正在阅读的正文')
  state.session = { ...state.session!, status: 'connected', readOnly: false, synced: true }
  const props = { workspaceId: 'workspace-a', pageId: 'page-a', pageTitle: 'Page', content: cached }
  const { rerender } = render(<DocumentEditor {...props} />)
  const body = await screen.findByLabelText('页面正文')
  expect(body).toHaveAttribute('contenteditable', 'true')
  state.session = { ...state.session!, readOnly: true }
  rerender(<DocumentEditor {...props} />)
  expect(body).toHaveAttribute('contenteditable', 'false')
  expect(body).toHaveTextContent('正在阅读的正文')
})
