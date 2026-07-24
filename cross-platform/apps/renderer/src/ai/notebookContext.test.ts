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
