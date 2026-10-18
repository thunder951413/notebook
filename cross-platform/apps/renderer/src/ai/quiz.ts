/**
 * 测验: Anki-style flash cards generated from notes. The model writes
 * question/answer cards; the learner flips each one and grades their own
 * recall, and a small spaced-repetition scheduler decides when it comes back.
 *
 * Pure functions plus a localStorage-backed deck. Cards are a local study aid:
 * they are not part of the notes and are never synced.
 */
import type { ChatMessage } from './organize'

export interface QuizCard {
  id: string
  pageId: string
  pageTitle: string
  question: string
  answer: string
  createdAt: number
  /** When the card is next due (ms since epoch). New cards are due at once. */
  due: number
  /** Days until the next review at the last grade; 0 while (re)learning. */
  interval: number
  ease: number
  /** Consecutive successful reviews. */
  reps: number
  lapses: number
  lastReviewed?: number
}

export type Grade = 'again' | 'hard' | 'good' | 'easy'
export const GRADES: Array<{ id: Grade; label: string }> = [
  { id: 'again', label: '忘了' },
  { id: 'hard', label: '吃力' },
  { id: 'good', label: '记得' },
  { id: 'easy', label: '简单' },
]

export const CARDS_PER_NOTE_CHOICES = [3, 5, 8] as const
/** Longer notes are cut so the model sees the whole excerpt. */
export const QUIZ_NOTE_CHARACTERS = 12_000
export const QUIZ_MAX_NOTES = 30
export const SESSION_LIMIT = 50

const DAY = 86_400_000
const MINUTE = 60_000
const MIN_EASE = 1.3
const STARTING_EASE = 2.5
const MAX_QUESTION = 300
const MAX_ANSWER = 1_200

// ---------------------------------------------------------------- generation

export function quizMessages(note: { title: string; markdown: string }, count: number, request = ''): ChatMessage[] {
  const body = note.markdown.length > QUIZ_NOTE_CHARACTERS ? `${note.markdown.slice(0, QUIZ_NOTE_CHARACTERS)}\n…（已截断）` : note.markdown
  return [
    {
      role: 'system',
      content: [
        '你帮用户把一篇笔记做成记忆卡片（类似 Anki），让用户通过自测熟悉笔记里的信息。',
        '只出能从笔记原文直接得到答案的题，不要编造，不要依赖笔记以外的知识。',
        '每张卡片只考一个知识点：问题要单独拿出来也看得懂（不要写“上文提到的”“这篇笔记里的”）；答案简短准确，只给答案本身，需要时可以带一行补充。',
        '优先考：定义、步骤顺序、命令与参数、数字与名称、原因与区别。不要考无关紧要的细节，也不要出重复的题。',
        '只输出一个 JSON 对象，不要输出其他文字。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `笔记《${note.title || '无标题'}》：\n\n${body}\n\n请出 ${count} 张卡片${request.trim() ? `。额外要求：${request.trim()}` : ''}。笔记内容太少时可以少出，不要凑数。\n输出格式：\n{"cards":[{"question":"问题","answer":"答案"}]}`,
    },
  ]
}

function jsonObject(content: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content)?.[1]
  const raw = fenced ?? /\{[\s\S]*\}/.exec(content)?.[0]
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Normalised question text, used to spot a card that is already in the deck. */
export const questionKey = (question: string) => question.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** Valid question/answer pairs from the model's reply; malformed or repeated ones are dropped. */
export function parseQuizCards(content: string, limit = 12): Array<{ question: string; answer: string }> {
  const list = jsonObject(content)?.cards
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const cards: Array<{ question: string; answer: string }> = []
  for (const item of list as Array<Record<string, unknown>>) {
    const question = typeof item?.question === 'string' ? item.question.trim().slice(0, MAX_QUESTION) : ''
    const answer = typeof item?.answer === 'string' ? item.answer.trim().slice(0, MAX_ANSWER) : ''
    const key = questionKey(question)
    if (!question || !answer || !key || seen.has(key)) continue
    seen.add(key)
    cards.push({ question, answer })
    if (cards.length >= limit) break
  }
  return cards
}

export function newCard(source: { pageId: string; pageTitle: string; question: string; answer: string }, now: number, id: string = crypto.randomUUID()): QuizCard {
  return { id, ...source, createdAt: now, due: now, interval: 0, ease: STARTING_EASE, reps: 0, lapses: 0 }
}

/** Adds cards for a note, skipping questions the deck already has for it. */
export function addCards(deck: QuizCard[], additions: QuizCard[]): { deck: QuizCard[]; added: number } {
  const known = new Set(deck.map((card) => `${card.pageId}:${questionKey(card.question)}`))
  const fresh = additions.filter((card) => {
    const key = `${card.pageId}:${questionKey(card.question)}`
    if (known.has(key)) return false
    known.add(key)
    return true
  })
  return { deck: [...deck, ...fresh], added: fresh.length }
}

// ---------------------------------------------------------------- scheduling

/**
 * SM-2 flavoured scheduling. A forgotten card returns in ten minutes (and goes
 * to the back of the current session); a remembered one waits one day, then
 * three, then grows by its ease factor.
 */
export function gradeCard(card: QuizCard, grade: Grade, now: number): QuizCard {
  const reviewed = { ...card, lastReviewed: now }
  if (grade === 'again') {
    return { ...reviewed, reps: 0, interval: 0, lapses: card.lapses + 1, ease: Math.max(MIN_EASE, card.ease - 0.2), due: now + 10 * MINUTE }
  }
  let days: number
  let ease = card.ease
  if (grade === 'hard') {
    days = card.reps === 0 ? 1 : Math.max(card.interval + 1, Math.round(card.interval * 1.2))
    ease = Math.max(MIN_EASE, ease - 0.15)
  } else if (grade === 'good') {
    days = card.reps === 0 ? 1 : card.reps === 1 ? 3 : Math.max(card.interval + 1, Math.round(card.interval * ease))
  } else {
    days = card.reps === 0 ? 4 : Math.max(card.interval + 2, Math.round(card.interval * ease * 1.3))
    ease += 0.15
  }
  return { ...reviewed, reps: card.reps + 1, interval: days, ease, due: now + days * DAY }
}

/** Human wording for how long a grade would postpone a card, e.g. "10 分钟", "3 天". */
export function nextIntervalLabel(card: QuizCard, grade: Grade, now: number): string {
  const next = gradeCard(card, grade, now)
  if (grade === 'again') return '10 分钟'
  return next.interval >= 60 ? `${Math.round(next.interval / 30)} 个月` : `${next.interval} 天`
}

export const isNew = (card: QuizCard) => card.lastReviewed === undefined
export const isDue = (card: QuizCard, now: number) => card.due <= now

export interface DeckStats { total: number; due: number; fresh: number }
export function deckStats(cards: QuizCard[], now: number): DeckStats {
  return { total: cards.length, due: cards.filter((card) => isDue(card, now)).length, fresh: cards.filter(isNew).length }
}

/** Cards to study now: the most overdue first, at most `limit`. */
export function dueQueue(cards: QuizCard[], now: number, limit = SESSION_LIMIT): QuizCard[] {
  return cards.filter((card) => isDue(card, now)).sort((a, b) => a.due - b.due || a.createdAt - b.createdAt).slice(0, limit)
}

/** Every card in random order, for cramming without touching the schedule. */
export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  }
  return copy
}

// ------------------------------------------------------------------- storage

export const QUIZ_DECK_KEY = 'notebook-quiz-deck-v1'

function validCard(value: unknown): QuizCard | undefined {
  if (!value || typeof value !== 'object') return undefined
  const card = value as Record<string, unknown>
  const text = (key: string) => typeof card[key] === 'string' ? card[key] as string : ''
  const number = (key: string, fallback: number) => Number.isFinite(card[key]) ? card[key] as number : fallback
  const id = text('id')
  const pageId = text('pageId')
  const question = text('question')
  const answer = text('answer')
  if (!id || !pageId || !question || !answer) return undefined
  const createdAt = number('createdAt', 0)
  return {
    id, pageId, question, answer,
    pageTitle: text('pageTitle'),
    createdAt,
    due: number('due', createdAt),
    interval: Math.max(0, number('interval', 0)),
    ease: Math.max(MIN_EASE, number('ease', STARTING_EASE)),
    reps: Math.max(0, number('reps', 0)),
    lapses: Math.max(0, number('lapses', 0)),
    ...(Number.isFinite(card.lastReviewed) ? { lastReviewed: card.lastReviewed as number } : {}),
  }
}

export function readDeck(): QuizCard[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(QUIZ_DECK_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.flatMap((item) => validCard(item) ?? []) : []
  } catch {
    return []
  }
}

/** Returns false when the browser refused the write (e.g. storage full). */
export function writeDeck(cards: QuizCard[]): boolean {
  try {
    globalThis.localStorage?.setItem(QUIZ_DECK_KEY, JSON.stringify(cards))
    return true
  } catch {
    return false
  }
}
