import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createContentExtensions } from './extensions'

describe('code block Vim editing', () => {
  let editor: Editor | undefined

  afterEach(() => editor?.destroy())

  it('keeps repeated Enter presses inside a code block', () => {
    editor = new Editor({
      extensions: createContentExtensions(),
      content: {
        type: 'doc',
        content: [{
          type: 'codeBlock',
          content: [{ type: 'text', text: 'iii' }],
        }],
      },
    })
    editor.commands.focus('end')

    for (let count = 0; count < 4; count += 1) {
      const previousText = editor.state.doc.textContent
      expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock')
      expect(editor.commands.keyboardShortcut('Enter')).toBe(true)
      expect(editor.state.doc.textContent).toBe(`${previousText}\n`)
    }

    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock')
  })
})
