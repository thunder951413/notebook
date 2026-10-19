import type { MarkdownAssetReference } from '@notebook/sync-contract'

export const LARGE_DOCUMENT_CHARACTERS = 200_000

/** A renderer-only source handle. Never persist this as a Tiptap document. */
export type LargeDocument = Record<string, unknown> & {
  type: 'notebook-large-document'
  markdown: string
  assets: MarkdownAssetReference[]
}

export function isLargeDocument(value: unknown): value is LargeDocument {
  return !!value && typeof value === 'object'
    && (value as LargeDocument).type === 'notebook-large-document'
    && typeof (value as LargeDocument).markdown === 'string'
}

export function largeDocument(markdown: string, assets: MarkdownAssetReference[] = []): LargeDocument {
  return { type: 'notebook-large-document', markdown, assets }
}

export function replaceMarkdownSection(source: string, start: number, end: number, replacement: string) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) throw new Error('章节位置无效')
  // Preserve the original boundary whitespace. Only the edited section is
  // serialized; every byte outside its range stays untouched.
  const original = source.slice(start, end)
  const leading = original.match(/^\s*/)?.[0] ?? ''
  const trailing = original.trim() ? original.match(/\s*$/)?.[0] ?? '' : ''
  const body = replacement.trim()
  const section = body ? leading + body + (trailing || (end < source.length ? '\n\n' : '')) : leading + trailing
  return { markdown: source.slice(0, start) + section + source.slice(end), end: start + section.length }
}
