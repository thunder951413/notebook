import { markdownToPlainText } from '@notebook/storage-renderer'
import { documentToMarkdown, htmlToDocument } from '../editor/extensions'
import { plainTextToMarkdown, stripRepeatedTitle, type TextImportKind } from './textImport'

/** Markdown is the durable body; build its editor cache lazily on opening. */
export function prepareImportedDocument(source: string, kind: TextImportKind, title?: string) {
  const tiptapJson = kind === 'html' ? htmlToDocument(source) : { type: 'doc', content: [] }
  const markdown = kind === 'html'
    ? documentToMarkdown(tiptapJson)
    : kind === 'text' ? plainTextToMarkdown(source)
      : title === undefined ? source : stripRepeatedTitle(source, title)
  // List previews must not parse or traverse a book-sized document.
  const preview = markdownToPlainText(markdown.slice(0, 4096)).slice(0, 240)
  return { markdown, tiptapJson, preview }
}
