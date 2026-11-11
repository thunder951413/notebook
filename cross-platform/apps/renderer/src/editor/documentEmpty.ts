import { isLargeDocument } from '../data/largeDocument'

const EMPTY_CONTAINER_TYPES = new Set(['doc', 'paragraph', 'blockGroup'])

/**
 * Fast early-exit emptiness check for an open document. Avoids serializing the
 * entire Tiptap AST to Markdown on every keystroke just to decide whether an
 * empty parent note should display its child-page overview.
 */
export function isDocumentEmpty(document: Record<string, unknown> | undefined): boolean {
  if (!document) return true
  if (isLargeDocument(document)) return !/\S/.test(document.markdown)

  const isNodeEmpty = (node: Record<string, unknown>): boolean => {
    const type = typeof node.type === 'string' ? node.type : ''
    if (type === 'text') return typeof node.text !== 'string' || !/\S/.test(node.text)
    if (type === 'hardBreak') return true
    if (!EMPTY_CONTAINER_TYPES.has(type)) return false
    if (type === 'blockGroup') {
      const attrs = node.attrs as Record<string, unknown> | undefined
      if (typeof attrs?.title === 'string' && /\S/.test(attrs.title)) return false
    }
    const content = node.content
    if (!Array.isArray(content) || content.length === 0) return true
    for (const child of content) {
      if (child && typeof child === 'object' && !isNodeEmpty(child as Record<string, unknown>)) {
        return false
      }
    }
    return true
  }

  return isNodeEmpty(document)
}
