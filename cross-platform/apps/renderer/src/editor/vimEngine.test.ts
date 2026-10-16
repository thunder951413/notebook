import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from 'prosemirror-state'
import { createContentExtensions } from './extensions'
import { createVimState, resetVimRegister, runVimKey, type VimOutcome } from './vimEngine'

const paragraph = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })

describe('Vim normal mode engine', () => {
  let editor: Editor | undefined
  afterEach(() => { editor?.destroy(); resetVimRegister() })

  function open(lines: string[], cursor = 1) {
    editor = new Editor({ extensions: createContentExtensions(), content: { type: 'doc', content: lines.map(paragraph) } })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cursor)))
    const state = createVimState()
    const host = { moveVertical: (view: Editor['view'], direction: -1 | 1) => {
      const $head = view.state.selection.$head
      const target = direction > 0 ? $head.after() + 1 : $head.before() - 1
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target), direction)))
    }, openLine: () => undefined }
    return {
      keys(sequence: string): VimOutcome {
        let outcome: VimOutcome = 'handled'
        for (const key of sequence) outcome = runVimKey(editor!.view, state, key, host)
        return outcome
      },
      lines: () => editor!.state.doc.content.content.map((node) => node.textContent),
      head: () => editor!.state.selection.head,
    }
  }

  it('moves with counts and word motions', () => {
    const vim = open(['one two three'])
    vim.keys('2w')
    expect(vim.head()).toBe(9)
    vim.keys('b')
    expect(vim.head()).toBe(5)
    vim.keys('e')
    expect(vim.head()).toBe(7)
    vim.keys('$')
    expect(vim.head()).toBe(13)
    vim.keys('0')
    expect(vim.head()).toBe(1)
  })

  it('composes operators with motions and counts', () => {
    const vim = open(['one two three four'])
    vim.keys('dw')
    expect(vim.lines()).toEqual(['two three four'])
    vim.keys('2dw')
    expect(vim.lines()).toEqual(['four'])
  })

  it('changes words like cw/ce and enters insert mode', () => {
    const vim = open(['alpha beta'])
    expect(vim.keys('cw')).toBe('insert')
    expect(vim.lines()).toEqual([' beta'])
  })

  it('supports d$, D, dd with counts and dgg / dG', () => {
    const vim = open(['a1', 'b2', 'c3', 'd4', 'e5'], 2)
    vim.keys('l')
    vim.keys('D')
    expect(vim.lines()[0]).toBe('a')
    vim.keys('2dd')
    expect(vim.lines()).toEqual(['c3', 'd4', 'e5'])
    vim.keys('dG')
    expect(vim.lines()).toEqual([''])
  })

  it('works with text objects', () => {
    const vim = open(['say "hello world" now', ''], 8)
    vim.keys('di"')
    expect(vim.lines()[0]).toBe('say "" now')
    const second = open(['foo bar baz'], 6)
    second.keys('diw')
    expect(second.lines()).toEqual(['foo  baz'])
    second.keys('daw')
    expect(second.lines()).toEqual(['foo'])
  })

  it('yanks and puts charwise and linewise text', () => {
    const vim = open(['one', 'two'])
    vim.keys('yyjp')
    expect(vim.lines()).toEqual(['one', 'two', 'one'])
    vim.keys('ggyw$p')
    expect(vim.lines()[0]).toBe('oneone')
  })

  it('ddp swaps lines and P puts above', () => {
    const vim = open(['first', 'second'])
    vim.keys('ddp')
    expect(vim.lines()).toEqual(['second', 'first'])
    vim.keys('P')
    expect(vim.lines()).toEqual(['second', 'first', 'first'])
  })

  it('x, X, s with counts and redo/undo outcomes', () => {
    const vim = open(['abcdef'])
    vim.keys('3x')
    expect(vim.lines()).toEqual(['def'])
    expect(vim.keys('u')).toBe('undo')
    expect(vim.keys('/')).toBe('search')
  })

  it('treats each row of a code block as a line', () => {
    editor = new Editor({
      extensions: createContentExtensions(),
      content: { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'a\nb\nc' }] }] },
    })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)))
    const state = createVimState()
    const host = { moveVertical: () => undefined, openLine: () => undefined }
    for (const key of 'dd') runVimKey(editor.view, state, key, host)
    expect(editor.state.doc.textContent).toBe('a\nc')
  })
})

const wellFormed = (value: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)

describe('Vim engine edge cases', () => {
  let editor: Editor | undefined
  afterEach(() => { editor?.destroy(); resetVimRegister() })
  function open(lines: string[], cursor: number) {
    editor = new Editor({ extensions: createContentExtensions(), content: { type: 'doc', content: lines.map(paragraph) } })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cursor)))
    const state = createVimState()
    const host = { moveVertical: () => undefined, openLine: () => undefined }
    return {
      keys(sequence: string) { for (const key of sequence) runVimKey(editor!.view, state, key, host) },
      text: () => editor!.state.doc.textContent,
      head: () => editor!.state.selection.head,
    }
  }

  it('treats an emoji as one character for x, l, h and counts', () => {
    const vim = open(['a😀b'], 2)
    vim.keys('x')
    expect(vim.text()).toBe('ab')
    const second = open(['a😀😀b'], 1)
    second.keys('l')
    expect(second.head()).toBe(2)
    second.keys('l')
    expect(second.head()).toBe(4)
    second.keys('h')
    expect(second.head()).toBe(2)
    const third = open(['😀😀x'], 1)
    third.keys('2x')
    expect(third.text()).toBe('x')
    for (const value of [vim.text(), second.text(), third.text()]) expect(wellFormed(value)).toBe(true)
  })

  it('never leaves a lone surrogate after dw, D or cw next to an emoji', () => {
    const vim = open(['hi 😀😀 there'], 1)
    vim.keys('wdw')
    expect(wellFormed(vim.text())).toBe(true)
    const second = open(['x😀'], 2)
    second.keys('D')
    expect(wellFormed(second.text())).toBe(true)
  })
})
