import { beforeEach, describe, expect, test } from 'vitest'
import { QUIZ_DECK_KEY, addCards, deckStats, dueQueue, gradeCard, newCard, nextIntervalLabel, parseQuizCards, quizMessages, readDeck, shuffled, writeDeck } from './quiz'

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 18)
const card = (extra: Partial<ReturnType<typeof newCard>> = {}) => ({ ...newCard({ pageId: 'p1', pageTitle: 'uboot', question: 'Q', answer: 'A' }, now, 'c1'), ...extra })

describe('generation', () => {
  test('parse keeps valid, distinct question/answer pairs and tolerates fences', () => {
    const parsed = parseQuizCards('```json\n{"cards":[{"question":" uboot 用什么命令编译？ ","answer":"make -j8"},{"question":"uboot用什么命令编译","answer":"重复"},{"question":"没有答案"},{"answer":"没有问题"},{"question":"烧录工具？","answer":"fastboot"}]}\n```')
    expect(parsed).toEqual([{ question: 'uboot 用什么命令编译？', answer: 'make -j8' }, { question: '烧录工具？', answer: 'fastboot' }])
    expect(parseQuizCards('不是 JSON')).toEqual([])
    expect(parseQuizCards('{"cards":"x"}')).toEqual([])
    expect(parseQuizCards('{"cards":[{"question":"a","answer":"b"},{"question":"c","answer":"d"}]}', 1)).toHaveLength(1)
  })
  test('the prompt carries the note, the count and the extra request, and cuts very long notes', () => {
    const [system, user] = quizMessages({ title: '编译', markdown: 'x'.repeat(13_000) }, 5, '多考命令')
    expect(system!.content).toContain('JSON')
    expect(user!.content).toContain('《编译》')
    expect(user!.content).toContain('5 张卡片')
    expect(user!.content).toContain('多考命令')
    expect(user!.content).toContain('已截断')
  })
  test('cards already in the deck for the same note are not added twice', () => {
    const first = card({ question: 'uboot 用什么命令编译？' })
    const { deck, added } = addCards([first], [
      card({ id: 'c2', question: 'uboot用什么命令编译' }),
      card({ id: 'c3', question: '烧录工具？' }),
      card({ id: 'c4', pageId: 'p2', question: 'uboot 用什么命令编译？' }),
    ])
    expect(added).toBe(2)
    expect(deck.map((item) => item.id)).toEqual(['c1', 'c3', 'c4'])
  })
})

describe('scheduling', () => {
  test('a new card is due at once; good grows 1 → 3 days → by ease', () => {
    let current = card()
    expect(deckStats([current], now)).toEqual({ total: 1, due: 1, fresh: 1 })
    current = gradeCard(current, 'good', now)
    expect(current).toMatchObject({ interval: 1, reps: 1, due: now + DAY })
    expect(deckStats([current], now)).toEqual({ total: 1, due: 0, fresh: 0 })
    current = gradeCard(current, 'good', now + DAY)
    expect(current.interval).toBe(3)
    current = gradeCard(current, 'good', now + 4 * DAY)
    expect(current.interval).toBe(Math.round(3 * 2.5))
  })
  test('again returns in ten minutes, resets the streak, counts a lapse and lowers ease', () => {
    const learned = gradeCard(gradeCard(card(), 'good', now), 'good', now)
    const lapsed = gradeCard(learned, 'again', now)
    expect(lapsed).toMatchObject({ reps: 0, interval: 0, lapses: 1, due: now + 600_000 })
    expect(lapsed.ease).toBeCloseTo(2.3)
    expect(gradeCard({ ...lapsed, ease: 1.3 }, 'again', now).ease).toBe(1.3)
  })
  test('hard is shorter than good and easy is longer; intervals always move forward', () => {
    const learned = { ...card(), reps: 3, interval: 10 }
    const hard = gradeCard(learned, 'hard', now).interval
    const good = gradeCard(learned, 'good', now).interval
    const easy = gradeCard(learned, 'easy', now).interval
    expect(hard).toBeLessThan(good)
    expect(good).toBeLessThan(easy)
    expect(gradeCard({ ...learned, interval: 1 }, 'hard', now).interval).toBeGreaterThan(1)
  })
  test('interval labels', () => {
    expect(nextIntervalLabel(card(), 'again', now)).toBe('10 分钟')
    expect(nextIntervalLabel(card(), 'good', now)).toBe('1 天')
    expect(nextIntervalLabel({ ...card(), reps: 5, interval: 40 }, 'easy', now)).toMatch(/个月$/)
  })
  test('the study queue is the due cards, most overdue first, capped', () => {
    const cards = [card({ id: 'a', due: now - DAY }), card({ id: 'b', due: now + DAY }), card({ id: 'c', due: now - 3 * DAY }), card({ id: 'd', due: now })]
    expect(dueQueue(cards, now).map((item) => item.id)).toEqual(['c', 'a', 'd'])
    expect(dueQueue(cards, now, 2).map((item) => item.id)).toEqual(['c', 'a'])
  })
  test('shuffle keeps every card and does not touch the input', () => {
    const input = [1, 2, 3, 4, 5]
    expect([...shuffled(input, () => 0.3)].sort()).toEqual(input)
    expect(input).toEqual([1, 2, 3, 4, 5])
  })
})

describe('storage', () => {
  beforeEach(() => localStorage.clear())
  test('round-trips the deck and drops damaged entries', () => {
    expect(readDeck()).toEqual([])
    const reviewed = gradeCard(card(), 'good', now)
    expect(writeDeck([reviewed, card({ id: 'c2' })])).toBe(true)
    expect(readDeck()).toEqual([reviewed, card({ id: 'c2' })])
    localStorage.setItem(QUIZ_DECK_KEY, JSON.stringify([{ id: 'x' }, null, 5, { id: 'ok', pageId: 'p', question: 'q', answer: 'a', ease: 0.1 }]))
    const [only, ...rest] = readDeck()
    expect(rest).toEqual([])
    expect(only).toMatchObject({ id: 'ok', ease: 1.3, interval: 0, reps: 0 })
    localStorage.setItem(QUIZ_DECK_KEY, 'not json')
    expect(readDeck()).toEqual([])
  })
})
