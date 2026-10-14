import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { DocumentEditor } from './DocumentEditor'

const session = vi.hoisted(() => ({
  document: {},
  status: 'offline' as const,
  readOnly: false,
}))

test('shows read-only access and blocks Vim editing for a collaboration viewer', async () => {
  session.readOnly = true
  try {
    const onChange = vi.fn()
    render(<DocumentEditor workspaceId="workspace" pageId="viewer-page" pageTitle="只读" vimEnabled onChange={onChange} content={{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '可读取的正文' }] }] }} />)
    const body = await screen.findByLabelText('页面正文')
    expect(body).toHaveAttribute('contenteditable', 'false')
    expect(screen.getByText('实时协作 · 只读访问')).toBeInTheDocument()
    for (const key of ['Escape', 'x', 'd', 'd', 'o', 'Enter']) fireEvent.keyDown(body, { key })
    expect(body).toHaveTextContent('可读取的正文')
    expect(onChange).not.toHaveBeenCalled()
  } finally {
    session.readOnly = false
  }
})

vi.mock('../collaboration/useCollaborativeDocument', () => ({
  useCollaborativeDocument: () => session,
}))

test('does not restore an old reading position again after an autosave', async () => {
  const content = {
    type: 'doc',
    content: Array.from({ length: 160 }, (_, index) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `长文第 ${index + 1} 段` }],
    })),
  }
  const viewportPosition = { scrollTop: 120, fraction: 0.025 }
  const props = {
    workspaceId: 'workspace',
    pageId: 'long-page',
    pageTitle: '长文',
    viewportPosition,
    onViewportChange: vi.fn(),
  }
  const { container, rerender } = render(<DocumentEditor {...props} content={content} />)
  await screen.findByLabelText('页面正文')
  const body = container.querySelector('.document-editor-body') as HTMLDivElement
  Object.defineProperties(body, {
    scrollHeight: { configurable: true, value: 5_000 },
    clientHeight: { configurable: true, value: 500 },
  })

  await new Promise((resolve) => window.setTimeout(resolve, 760))
  expect(body.scrollTop).toBe(120)

  body.scrollTop = 4_200
  fireEvent.scroll(body)
  fireEvent.keyDown(screen.getByLabelText('页面正文'), { key: 'Enter' })

  // Storage returns a fresh object after accepting the autosave. It represents
  // the same editor state and must not replay the page's initial scroll offset.
  rerender(<DocumentEditor {...props} content={structuredClone(content)} />)
  await new Promise((resolve) => window.setTimeout(resolve, 760))
  expect(body.scrollTop).toBe(4_200)
})

test('does not report a zero position when the user types during the restore window', async () => {
  const content = {
    type: 'doc',
    content: Array.from({ length: 160 }, (_, index) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `长文第 ${index + 1} 段` }],
    })),
  }
  const onViewportChange = vi.fn()
  const { container } = render(
    <DocumentEditor
      workspaceId="workspace"
      pageId="long-page"
      pageTitle="长文"
      viewportPosition={{ scrollTop: 120, fraction: 0.025 }}
      onViewportChange={onViewportChange}
      content={content}
    />,
  )
  await screen.findByLabelText('页面正文')
  const body = container.querySelector('.document-editor-body') as HTMLDivElement
  Object.defineProperties(body, {
    scrollHeight: { configurable: true, value: 5_000 },
    clientHeight: { configurable: true, value: 500 },
  })

  // The user starts typing before the scheduled restore completes. The restore
  // window must not publish scrollTop 0 back to the caller, which would
  // overwrite the saved reading position with "top of page".
  fireEvent.keyDown(screen.getByLabelText('页面正文'), { key: 'Enter' })
  await new Promise((resolve) => window.setTimeout(resolve, 760))
  expect(body.scrollTop).toBe(0)
  expect(onViewportChange).not.toHaveBeenCalledWith({ scrollTop: 0, fraction: 0 })
})
