import type { PageSummary } from './model'

export interface VisibleTreePage {
  page: PageSummary
  depth: number
  hasChildren: boolean
}

const comparePages = (left: PageSummary, right: PageSummary) =>
  (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER)
  || left.title.localeCompare(right.title, 'zh-CN')

export function descendantsOf(pages: PageSummary[], pageId: string) {
  const children = new Map<string, string[]>()
  for (const page of pages) {
    if (!page.parentPageId) continue
    const bucket = children.get(page.parentPageId) ?? []
    bucket.push(page.id)
    children.set(page.parentPageId, bucket)
  }
  const result = new Set<string>([pageId])
  const queue = [...(children.get(pageId) ?? [])]
  while (queue.length) {
    const id = queue.shift()!
    if (result.has(id)) continue
    result.add(id)
    queue.push(...(children.get(id) ?? []))
  }
  result.delete(pageId)
  return result
}

export function ancestorsOf(pages: PageSummary[], pageId: string) {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const result: string[] = []
  const seen = new Set<string>()
  let cursor = byId.get(pageId)?.parentPageId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    result.unshift(cursor)
    cursor = byId.get(cursor)?.parentPageId
  }
  return result
}

/**
 * Descendant count per page in one pass over the tree. Tree rows show this as
 * a child-count badge; computing it per row during render costs O(n²).
 * Malformed parent cycles are simply unreachable from the roots and end at 0.
 */
export function descendantCountsOf(pages: PageSummary[]) {
  const knownIds = new Set(pages.map((page) => page.id))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const page of pages) {
    if (!page.parentPageId || !knownIds.has(page.parentPageId)) roots.push(page.id)
    else {
      const bucket = children.get(page.parentPageId) ?? []
      bucket.push(page.id)
      children.set(page.parentPageId, bucket)
    }
  }
  const counts = new Map<string, number>()
  for (const page of pages) counts.set(page.id, 0)
  const visited = new Set<string>()
  const path: string[] = []
  const visit = (pageId: string) => {
    if (visited.has(pageId)) return
    visited.add(pageId)
    for (const ancestorId of path) counts.set(ancestorId, (counts.get(ancestorId) ?? 0) + 1)
    path.push(pageId)
    for (const childId of children.get(pageId) ?? []) visit(childId)
    path.pop()
  }
  for (const root of roots) visit(root)
  return counts
}

export function flattenPageTree(pages: PageSummary[], expanded: Set<string>, matchingIds?: Set<string>): VisibleTreePage[] {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const children = new Map<string, PageSummary[]>()
  const rootKey = ''
  for (const page of pages) {
    const parent = page.parentPageId && byId.has(page.parentPageId) ? page.parentPageId : rootKey
    const bucket = children.get(parent) ?? []
    bucket.push(page)
    children.set(parent, bucket)
  }
  for (const bucket of children.values()) bucket.sort(comparePages)
  const included = matchingIds ? new Set(matchingIds) : undefined
  if (included) {
    for (const id of matchingIds!) for (const ancestor of ancestorsOf(pages, id)) included.add(ancestor)
  }
  const result: VisibleTreePage[] = []
  const visiting = new Set<string>()
  const visit = (parentId: string, depth: number) => {
    for (const page of children.get(parentId) ?? []) {
      if (visiting.has(page.id) || (included && !included.has(page.id))) continue
      visiting.add(page.id)
      const hasChildren = (children.get(page.id) ?? []).some((child) => !included || included.has(child.id))
      result.push({ page, depth, hasChildren })
      if (hasChildren && (expanded.has(page.id) || Boolean(matchingIds))) visit(page.id, depth + 1)
      visiting.delete(page.id)
    }
  }
  visit(rootKey, 0)
  return result
}
