import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CreateItemDialog } from './CreateItemDialog'
import { MovePageDialog } from './MovePageDialog'

describe('dialogs close on Escape', () => {
  it('closes the create dialog from its name field', () => {
    const onClose = vi.fn()
    render(<CreateItemDialog kind="notebook" onClose={onClose} onCreate={async () => {}} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: '笔记本名称' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while an input method is composing', () => {
    const onClose = vi.fn()
    render(<CreateItemDialog kind="notebook" onClose={onClose} onCreate={async () => {}} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: '笔记本名称' }), { key: 'Escape', isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the move dialog without reaching window listeners', () => {
    const onClose = vi.fn()
    const windowListener = vi.fn()
    window.addEventListener('keydown', windowListener)
    const page = { id: 'p1', sectionId: 's1', title: '页面', preview: '', updatedLabel: '', tags: [], kind: 'document' as const }
    render(<MovePageDialog page={page} pages={[page]} notebooks={[]} onClose={onClose} onMove={async () => {}} />)
    fireEvent.keyDown(screen.getByRole('dialog', { name: '移动页面' }), { key: 'Escape' })
    window.removeEventListener('keydown', windowListener)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(windowListener).not.toHaveBeenCalled()
  })
})
