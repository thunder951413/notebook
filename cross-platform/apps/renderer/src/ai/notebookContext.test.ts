import { expect, test, vi } from 'vitest'
import { buildNotebookAIContext } from './notebookContext'
import { markdownToDocument } from '../editor/extensions'

const pages = [
  { id: 'root', sectionId: 'notes', title: '根页面', preview: '', updatedLabel: '', tags: [] },
  { id: 'embed', sectionId: 'notes', title: '嵌入页面', preview: '', updatedLabel: '', tags: [] },
  { id: 'link', sectionId: 'notes', title: '链接页面', preview: '', updatedLabel: '', tags: [] },
]
const documents: Record<string, Record<string, unknown>> = {
  root: markdownToDocument('根正文\n\n![[page:embed]]\n\n[[page:link]]'),
  embed: markdownToDocument('嵌入正文'),
  link: markdownToDocument('链接正文'),
}

test('expands embeds by default and all links only when requested', async () => {
  const common = {
    rootPageId: 'root',
    pages,
    trashPages: [],
    privacyUnlocked: false,
    loadDocument: vi.fn(async (pageId: string) => documents[pageId]),
    loadAssets: vi.fn().mockResolvedValue([]),
  }
  const embeds = await buildNotebookAIContext({ ...common, scope: 'embeds' })
  expect(embeds.items.map((item) => item.pageId)).toEqual(['root', 'embed'])
  const all = await buildNotebookAIContext({ ...common, scope: 'all' })
  expect(all.items.map((item) => item.pageId)).toEqual(['root', 'embed', 'link'])
})

test('never includes locked content even when the local privacy notebook is unlocked', async () => {
  const lockedDocument = markdownToDocument('绝不能发送的隐私正文')
  const result = await buildNotebookAIContext({
    rootPageId: 'root',
    scope: 'embeds',
    pages: [
      { id: 'root', sectionId: 'notes', title: '公开页', preview: '', updatedLabel: '', tags: [] },
      { id: 'private', sectionId: 'private', title: '隐私页', preview: '', updatedLabel: '', tags: [], locked: true },
    ],
    trashPages: [],
    privacyUnlocked: true,
    loadDocument: vi.fn(async (pageId: string) => pageId === 'root' ? markdownToDocument('公开正文\n\n![[page:private]]') : lockedDocument),
    loadAssets: vi.fn().mockResolvedValue([]),
  })
  expect(result.markdown).toContain('公开正文')
  expect(result.markdown).not.toContain('绝不能发送')
  expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'locked' })]))
})
