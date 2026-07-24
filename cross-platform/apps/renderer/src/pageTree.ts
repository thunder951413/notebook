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
