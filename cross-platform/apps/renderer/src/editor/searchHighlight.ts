import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const searchHighlightKey = new PluginKey<DecorationSet>('notebookSearchHighlight')

/** Ranges of every (case-insensitive) occurrence of the terms in text nodes. */
export function findTextMatches(doc: EditorState['doc'], terms: string[]) {
  const words = terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean)
  const matches: Array<{ from: number; to: number }> = []
  if (!words.length) return matches
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return
    const text = node.text.toLocaleLowerCase()
    for (const word of words) {
      for (let index = text.indexOf(word); index >= 0; index = text.indexOf(word, index + word.length)) {
        matches.push({ from: position + index, to: position + index + word.length })
      }
    }
  })
  return matches.sort((left, right) => left.from - right.from)
}

/**
 * Transient highlight of search hits in the open note. Cleared by the next
 * edit; the first hit is selected and scrolled into view.
 */
export const SearchHighlight = Extension.create({
  name: 'notebookSearchHighlight',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: searchHighlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, current) => {
          const next = transaction.getMeta(searchHighlightKey) as DecorationSet | undefined
          if (next) return next
          return transaction.docChanged ? DecorationSet.empty : current.map(transaction.mapping, transaction.doc)
        },
      },
      props: { decorations: (state) => searchHighlightKey.getState(state) },
    })]
  },
})

export function highlightSearchTerms(state: EditorState, terms: string[]): Transaction | undefined {
  const matches = findTextMatches(state.doc, terms)
  if (!matches.length) return undefined
  const decorations = DecorationSet.create(state.doc, matches.map(({ from, to }) => Decoration.inline(from, to, { class: 'search-hit-highlight' })))
  const first = matches[0]!
  return state.tr
    .setMeta(searchHighlightKey, decorations)
    .setSelection(TextSelection.create(state.doc, first.from, first.to))
    .setMeta('addToHistory', false)
    .scrollIntoView()
}

export function clearSearchHighlight(state: EditorState) {
  return state.tr.setMeta(searchHighlightKey, DecorationSet.empty).setMeta('addToHistory', false)
}
