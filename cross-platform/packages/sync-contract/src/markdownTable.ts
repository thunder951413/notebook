import { Table } from '@tiptap/extension-table'

function tableHeaderEnd(source: string) {
  const firstEnd = source.indexOf('\n')
  if (firstEnd < 0) return -1
  const secondEnd = source.indexOf('\n', firstEnd + 1)
  const separator = source.slice(firstEnd + 1, secondEnd < 0 ? undefined : secondEnd)
  return separator.includes('|') && /^[ \t|:]*-[ \t|:-]*$/.test(separator) ? firstEnd : -1
}

/** Same table lookahead as Tiptap, inspecting only the first two lines. */
export function markdownTableStart(source: string) {
  const end = tableHeaderEnd(source)
  return end >= 0 && source.slice(0, end).includes('|') ? 0 : -1
}

// Tiptap 3.28 splits the entire remaining document for every block's table
// lookahead. A book with tens of thousands of paragraphs becomes quadratic.
// Keep its pipe-in-code handling, but never split prose suffixes into lines.
export const NotebookMarkdownTable = Table.extend({
  markdownTokenizer: {
    ...Table.config.markdownTokenizer!,
    start: markdownTableStart,
    tokenize(source, tokens, lexer) {
      // A one-column table may omit pipes from the header, while its body
      // still needs the upstream code-span pipe repair.
      if (tableHeaderEnd(source) < 0) return undefined
      return Table.config.markdownTokenizer!.tokenize(source, tokens, lexer)
    },
  },
})
