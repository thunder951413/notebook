import { type PlanGroup, type PlanLocation, type PlanOp } from './organize'

/** What applying a plan needs from the workspace. */
export interface PlanApi {
  pageUpdatedAt(pageId: string): Promise<string | undefined>
  createPage(title: string, markdown: string, sectionId: string, parentPageId: string | undefined): Promise<string>
  updatePage(pageId: string, change: { title?: string; markdown?: string }): Promise<void>
  movePage(pageId: string, sectionId: string, parentPageId: string | undefined, sortOrder: number): Promise<void>
  setTags(pageId: string, tags: string[]): Promise<void>
  trash(pageId: string): Promise<void>
  /** Version-history snapshot before a page's text is replaced. */
  snapshot(pageId: string): Promise<void>
}

export interface ApplyOutcome {
  applied: string[]
  failed: Array<{ groupId: string; title: string; message: string }>
  created: string[]
}

/**
 * Applies the accepted groups. Each group is checked first: if a note it
 * rewrites changed since the plan was made, the group is skipped. Order:
 * create → rewrite → move → tags → trash, so new folders exist before notes
 * move into them and children leave merged notes before those are trashed.
 */
export async function applyPlan(groups: PlanGroup[], api: PlanApi, onProgress?: (done: number, total: number) => void): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { applied: [], failed: [], created: [] }
  const ready: PlanGroup[] = []
  for (const group of groups) {
    const stale = await staleNote(group, api)
    if (stale) outcome.failed.push({ groupId: group.id, title: group.title, message: `“${stale}”在生成方案后被修改过，请重新生成` })
    else ready.push(group)
  }
  const ops = ready.flatMap((group) => group.ops.map((op) => ({ op, group })))
  const total = ops.length
  let done = 0
  const refs = new Map<string, string>()
  const failedGroups = new Set<string>()
  const step = async (kind: PlanOp['kind'], run: (op: PlanOp) => Promise<void>) => {
    for (const { op, group } of ops) {
      if (op.kind !== kind || failedGroups.has(group.id)) continue
      try {
        await run(op)
      } catch (error) {
        failedGroups.add(group.id)
        outcome.failed.push({ groupId: group.id, title: group.title, message: error instanceof Error ? error.message : '应用失败' })
      }
      done += 1
      onProgress?.(done, total)
    }
  }
  const parentOf = (location: PlanLocation) => {
    if (!location.parentRef) return location.parentPageId
    const id = refs.get(location.parentRef)
    if (!id) throw new Error('上级目录没有创建成功')
    return id
  }
  const resolveLinks = (markdown: string) => markdown.replace(/\{\{notebook-ref:([^}]+)\}\}/g, (match, ref: string) => refs.get(ref) ?? match)

  await step('create', async (op) => {
    if (op.kind !== 'create') return
    const id = await api.createPage(op.title, op.markdown, op.location.sectionId, parentOf(op.location))
    refs.set(op.ref, id)
    outcome.created.push(id)
    await api.movePage(id, op.location.sectionId, parentOf(op.location), op.location.sortOrder)
  })
  await step('update', async (op) => {
    if (op.kind !== 'update') return
    if (op.markdown !== undefined) await api.snapshot(op.pageId)
    const markdown = op.markdown === undefined ? undefined : resolveLinks(op.markdown)
    if (markdown && /\{\{notebook-ref:/.test(markdown)) throw new Error('拆分出的笔记没有全部创建成功')
    await api.updatePage(op.pageId, { title: op.title, markdown })
  })
  await step('move', async (op) => {
    if (op.kind !== 'move') return
    await api.movePage(op.pageId, op.location.sectionId, parentOf(op.location), op.location.sortOrder)
  })
  await step('tags', async (op) => { if (op.kind === 'tags') await api.setTags(op.pageId, op.tags) })
  await step('trash', async (op) => { if (op.kind === 'trash') await api.trash(op.pageId) })
  for (const group of ready) if (!failedGroups.has(group.id)) outcome.applied.push(group.id)
  return outcome
}

async function staleNote(group: PlanGroup, api: PlanApi): Promise<string | undefined> {
  for (const op of group.ops) {
    if ((op.kind !== 'update' && op.kind !== 'trash') || !op.expectedUpdatedAt) continue
    const current = await api.pageUpdatedAt(op.pageId)
    if (current !== op.expectedUpdatedAt) return group.before.find((note) => note.key === op.pageId)?.title || '一篇笔记'
  }
  return undefined
}
