import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import type { NotebookSummary, PageSummary } from '../model'
import { QUIZ_DECK_KEY, readDeck } from '../ai/quiz'
import { QuizPanel } from './QuizPanel'

const completeAI = vi.hoisted(() => vi.fn())
vi.mock('../ai/completion', () => ({ AI_NOT_CONFIGURED: 'AI_NOT_CONFIGURED', completeAI }))

const page = (id: string, title: string): PageSummary => ({ id, sectionId: 's1', title, preview: '', updatedLabel: '', tags: [], kind: 'document', updatedAt: '2026-10-14T00:00:00Z' })
const notebooks = [{ id: 'n1', name: '工作', emoji: '📒', sections: [{ id: 's1', name: '默认', color: '', pageCount: 0 }] }] as NotebookSummary[]
const pages = [page('a', 'uboot 编译'), page('b', '杂记')]
const loadMarkdown = vi.fn(async (id: string) => id === 'a' ? '编译 uboot 先配置 defconfig，然后运行 make -j8，产物是 u-boot.bin。' : '短')

function renderPanel(openPage = vi.fn()) {
  return render(<FluentProvider theme={webLightTheme}>
    <QuizPanel scopedPages={pages} pages={pages} notebooks={notebooks} scopeLabel="全部笔记" loadMarkdown={loadMarkdown} applyPlan={vi.fn()} openPage={openPage} onNeedsSetup={vi.fn()} />
  </FluentProvider>)
}

beforeEach(() => {
  localStorage.clear()
  completeAI.mockReset()
})

test('generates cards from the picked notes, then studies and grades them', async () => {
  completeAI.mockResolvedValue('{"cards":[{"question":"uboot 编译的命令？","answer":"`make -j8`"},{"question":"产物文件名？","answer":"u-boot.bin"}]}')
  renderPanel()
  expect(screen.getByRole('button', { name: '今天没有要复习的' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '为 2 篇出题' }))
  expect(await screen.findByText('新增 2 张题目')).toBeInTheDocument()
  // The 1-line note is too short to ask about, and the model was only asked once.
  expect(screen.getByRole('alert')).toHaveTextContent('“杂记”内容太少')
  expect(completeAI).toHaveBeenCalledTimes(1)
  expect(readDeck()).toHaveLength(2)

  fireEvent.click(screen.getByRole('button', { name: /开始复习（2 张）/ }))
  const card = screen.getByRole('article', { name: '题目' })
  expect(within(card).getByText('uboot 编译的命令？')).toBeInTheDocument()
  expect(within(card).queryByText('u-boot.bin')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('你的答案'), { target: { value: 'make' } })
  fireEvent.click(screen.getByRole('button', { name: /显示答案/ }))
  expect(within(card).getByText('make -j8')).toBeInTheDocument()
  expect(within(card).getByText('make')).toBeInTheDocument()

  // Grade with the keyboard: "good" schedules the card for tomorrow.
  fireEvent.keyDown(window, { key: '3' })
  await waitFor(() => expect(within(screen.getByRole('article', { name: '题目' })).getByText('产物文件名？')).toBeInTheDocument())
  expect(readDeck().filter((item) => item.reps === 1)).toHaveLength(1)

  // "again" puts the card at the end of the pass, so the same card comes straight back.
  fireEvent.keyDown(window, { key: ' ' })
  fireEvent.keyDown(window, { key: '1' })
  expect(within(screen.getByRole('article', { name: '题目' })).getByText('产物文件名？')).toBeInTheDocument()
  expect(readDeck().find((item) => item.question === '产物文件名？')).toMatchObject({ reps: 0, lapses: 1 })
})

test('practising everything does not change the schedule, and cards can be deleted', async () => {
  localStorage.setItem(QUIZ_DECK_KEY, JSON.stringify([{ id: 'c1', pageId: 'a', pageTitle: 'uboot 编译', question: '问题一', answer: '答案一', createdAt: 1, due: Date.now() + 10 * 86_400_000, interval: 5, ease: 2.5, reps: 2, lapses: 0, lastReviewed: 2 }]))
  const openPage = vi.fn()
  renderPanel(openPage)
  expect(screen.getByRole('button', { name: '今天没有要复习的' })).toBeDisabled()
  const before = localStorage.getItem(QUIZ_DECK_KEY)
  fireEvent.click(screen.getByRole('button', { name: '全部练习一遍' }))
  fireEvent.click(screen.getByRole('button', { name: '来自《uboot 编译》' }))
  expect(openPage).toHaveBeenCalledWith('a')
  fireEvent.click(screen.getByRole('button', { name: /显示答案/ }))
  fireEvent.click(screen.getByRole('button', { name: /^简单/ }))
  expect(await screen.findByText('这一轮完成了')).toBeInTheDocument()
  expect(localStorage.getItem(QUIZ_DECK_KEY)).toBe(before)

  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  fireEvent.click(screen.getByRole('button', { name: '全部练习一遍' }))
  fireEvent.click(screen.getByRole('button', { name: /显示答案/ }))
  fireEvent.click(screen.getByRole('button', { name: '删除这张' }))
  expect(await screen.findByText('没有题目了')).toBeInTheDocument()
  expect(readDeck()).toEqual([])
})
