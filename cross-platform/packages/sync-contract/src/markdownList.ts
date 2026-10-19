import { OrderedList, TaskList, ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'

const firstListLine = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s+.*$`)

/** Avoid splitting the remaining book just to reject a non-list paragraph. */
export const NotebookMarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...OrderedList.config.markdownTokenizer!,
    tokenize(source, tokens, lexer) {
      const end = source.indexOf('\n')
      if (!firstListLine.test(source.slice(0, end < 0 ? undefined : end))) return undefined
      return OrderedList.config.markdownTokenizer!.tokenize(source, tokens, lexer)
    },
  },
})

export const NotebookMarkdownTaskList = TaskList.extend({
  markdownTokenizer: {
    ...TaskList.config.markdownTokenizer!,
    tokenize(source, tokens, lexer) {
      // The upstream parser also accepts leading blank lines.
      if (!/^\s*[-+*][^\S\n]+\[[ xX]\][^\S\n]+/.test(source)) return undefined
      return TaskList.config.markdownTokenizer!.tokenize(source, tokens, lexer)
    },
  },
})
