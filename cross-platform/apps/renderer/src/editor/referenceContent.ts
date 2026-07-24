import type { NotebookReferenceTarget } from '@notebook/sync-contract'

export type ReferenceContentNode = {
  type?: string
  attrs?: Record<string, unknown>
  content?: ReferenceContentNode[]
  text?: string
}

function normalizedText(node: ReferenceContentNode): string {
  if (node.type === 'blockAnchor') return ''
  if (node.text) return node.text
  return (node.content ?? []).map(normalizedText).join(' ')
}

function compact(value: string, limit = 120) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

export function findReferencedFragment(
  document: Record<string, unknown>,
  target: NotebookReferenceTarget,
): Record<string, unknown> | undefined {
  if (target.kind === 'page') return document
  const visit = (node: ReferenceContentNode): ReferenceContentNode | undefined => {
    if (target.kind === 'group' && node.type === 'blockGroup' && node.attrs?.groupId === target.targetId) {
      return { type: 'doc', content: node.content ?? [] }
    }
    if (target.kind === 'block' && node.content?.some((child) => child.type === 'blockAnchor' && child.attrs?.anchorId === target.targetId)) {
      return { ...node, content: node.content.filter((child) => child.type !== 'blockAnchor') }
    }
    for (const child of node.content ?? []) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  const found = visit(document as ReferenceContentNode)
  return found?.type === 'doc'
    ? found as Record<string, unknown>
    : found
      ? { type: 'doc', content: [found] }
      : undefined
}

export function referenceDynamicLabel(
  document: Record<string, unknown> | undefined,
  target: NotebookReferenceTarget,
  pageTitle: string,
) {
  if (target.kind === 'page' || !document) return pageTitle
  if (target.kind === 'group') {
    let groupTitle = ''
    const visit = (node: ReferenceContentNode) => {
      if (node.type === 'blockGroup' && node.attrs?.groupId === target.targetId) {
        groupTitle = typeof node.attrs.title === 'string' ? node.attrs.title.trim() : ''
        return true
      }
      return (node.content ?? []).some(visit)
    }
    visit(document as ReferenceContentNode)
    if (groupTitle) return groupTitle
  }
  const fragment = findReferencedFragment(document, target)
  return fragment ? compact(normalizedText(fragment as ReferenceContentNode)) || pageTitle : pageTitle
}

export function referenceTargetElement(root: ParentNode, target: NotebookReferenceTarget): HTMLElement | undefined {
  if (target.kind === 'page') return undefined
  const attribute = target.kind === 'block' ? 'data-block-anchor' : 'data-block-group'
  const exact = Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`))
    .find((element) => element.getAttribute(attribute) === target.targetId)
  if (!exact) return undefined
  return target.kind === 'block'
    ? exact.closest<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote') ?? exact
    : exact
}
