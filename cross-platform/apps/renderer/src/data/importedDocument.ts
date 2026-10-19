import { markdownToPlainText } from '@notebook/storage-renderer'
import type { MarkdownAssetReference } from '@notebook/sync-contract'
import { documentToMarkdown, htmlToDocument, markdownToDocument } from '../editor/extensions'
import { LARGE_DOCUMENT_CHARACTERS, largeDocument } from './largeDocument'
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

/**
 * The document to hand to saveDocument for Markdown the app already holds.
 * Book-sized text stays a source handle: parsing it into a rich tree and
 * serializing it back blocks the window for minutes and gains nothing.
 */
export function documentFromMarkdown(markdown: string, assets: MarkdownAssetReference[] = []): Record<string, unknown> {
  if (!import.meta.env.VITE_NOTEBOOK_COLLAB_URL && markdown.length >= LARGE_DOCUMENT_CHARACTERS) return largeDocument(markdown, assets)
  return markdownToDocument(markdown)
}
