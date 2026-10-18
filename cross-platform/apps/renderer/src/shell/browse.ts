import type { PageSummary } from '../model'

/**
 * Finding and arranging many notes; the same rules as the Android app
 * (reference/NoteBrowse.kt and TodoReminders.kt) so both feel identical:
 *
 * - search: several words (all must match), "exact phrases", -exclusions,
 *   #tags, and pinyin / pinyin initials for Chinese titles;
 * - results ranked by title match first, newer first within a tier;
 * - pinned (favorite) notes above date sections (Apple Notes);
 * - todos by due state, badge = overdue + due today (Things / Reminders).
 */

export interface SearchQuery {
  terms: string[]
  excluded: string[]
  tags: string[]
}

export const emptySearchQuery: SearchQuery = { terms: [], excluded: [], tags: [] }

export function parseSearchQuery(raw: string): SearchQuery {
  const terms: string[] = []
  const excluded: string[] = []
  const tags: string[] = []
  for (const match of raw.trim().matchAll(/(-?)"([^"]+)"|(\S+)/g)) {
    const phrase = match[2]?.trim()
    if (phrase) {
      ;(match[1] === '-' ? excluded : terms).push(phrase)
      continue
    }
    const token = match[3] ?? ''
    if (token.length > 1 && token.startsWith('-')) excluded.push(token.slice(1))
    else if (token.length > 1 && (token.startsWith('#') || token.startsWith('＃'))) tags.push(token.slice(1))
    else if (token && token !== '-') terms.push(token)
  }
  const unique = (values: string[]) => [...new Set(values)]
  return { terms: unique(terms), excluded: unique(excluded), tags: unique(tags) }
}

export const isEmptyQuery = (query: SearchQuery) => !query.terms.length && !query.excluded.length && !query.tags.length

// ---------------------------------------------------------------------------
// Pinyin: "hgly" or "hanguo" finds 韩国旅游. The converter loads lazily so the
// first paint never waits for its dictionary; until then pinyin simply
// does not match.

type PinyinConverter = (text: string) => string[]
interface PinyinKeys { full: string; initials: string }

let pinyinConverter: PinyinConverter | undefined
let pinyinLoading: Promise<void> | undefined
const pinyinCache = new Map<string, PinyinKeys | null>()
const HAN = /[㐀-鿿]/
const ASCII_TERM = /^[a-z]{2,}$/i

/** Test hook; production code calls {@link loadPinyin}. */
export function installPinyin(converter: PinyinConverter | undefined) {
  pinyinConverter = converter
  pinyinCache.clear()
}

export function loadPinyin(): Promise<void> {
  pinyinLoading ??= import('pinyin-pro')
    .then(({ pinyin }) => installPinyin((text) => pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[]))
    .catch(() => undefined)
  return pinyinLoading
}

export const pinyinReady = () => Boolean(pinyinConverter)

function pinyinKeys(text: string): PinyinKeys | null {
  if (!pinyinConverter || !HAN.test(text)) return null
  const cached = pinyinCache.get(text)
  if (cached !== undefined) return cached
  let keys: PinyinKeys | null = null
  try {
    const syllables = pinyinConverter(text).map((part) => part.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean)
    keys = { full: syllables.join(''), initials: syllables.map((part) => part[0]).join('') }
  } catch {
    keys = null
  }
  if (pinyinCache.size > 20_000) pinyinCache.clear()
  pinyinCache.set(text, keys)
  return keys
}

/** True when an ASCII keyword matches the text's pinyin or its initials. */
export function pinyinMatches(text: string, term: string): boolean {
  if (!ASCII_TERM.test(term)) return false
  const keys = pinyinKeys(text)
  if (!keys) return false
  const needle = term.toLowerCase()
  return keys.initials.includes(needle) || keys.full.includes(needle)
}

// ---------------------------------------------------------------------------
// Matching and ranking

export interface BrowseContext {
  /** Notebook name for a page, searched and shown in rows. */
  notebookName: (page: PageSummary) => string
}

export function pageMatches(page: PageSummary, query: SearchQuery, context: BrowseContext): boolean {
  if (isEmptyQuery(query)) return true
  const haystack = `${page.title}\n${page.preview}\n${page.tags.join(' ')}\n${context.notebookName(page)}`.toLocaleLowerCase()
  for (const term of query.terms) {
    if (!haystack.includes(term.toLocaleLowerCase()) && !pinyinMatches(page.title, term)) return false
  }
  for (const term of query.excluded) {
    if (haystack.includes(term.toLocaleLowerCase())) return false
  }
  for (const tag of query.tags) {
    const wanted = tag.toLocaleLowerCase()
    if (!page.tags.some((value) => value.toLocaleLowerCase().startsWith(wanted))) return false
  }
  return true
}

const timeOf = (value: string | undefined) => {
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

export const updatedTime = (page: PageSummary) => timeOf(page.updatedAt)

export const RECENT_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000
export const RECENT_SYNC_MIN = 5

/**
 * Synced notes from the last day, newest first; topped up to the five most
 * recent synced notes when fewer than five fall inside the day.
 */
export function recentlySynced(pages: PageSummary[], now: number): PageSummary[] {
  const synced = pages.filter((page) => page.syncStatus === 'synced').sort((left, right) => updatedTime(right) - updatedTime(left))
  const withinDay = synced.filter((page) => now - updatedTime(page) <= RECENT_SYNC_WINDOW_MS)
  return withinDay.length >= RECENT_SYNC_MIN ? withinDay : synced.slice(0, RECENT_SYNC_MIN)
}
export const createdTime = (page: PageSummary) => timeOf(page.createdAt ?? page.updatedAt)

/** Title matches first, then notebook; newer first within a tier. */
export function rankSearchHits(pages: PageSummary[], query: SearchQuery, context: BrowseContext): PageSummary[] {
  const score = (page: PageSummary) => {
    const title = page.title.toLocaleLowerCase()
    let value = 0
    query.terms.forEach((raw, index) => {
      const term = raw.toLocaleLowerCase()
      if (title === term) value += 400
      else if (title.startsWith(term)) value += index === 0 ? 250 : 120
      else if (title.includes(term)) value += 100
      else if (pinyinMatches(page.title, raw)) value += 90
      else if (context.notebookName(page).toLocaleLowerCase().includes(term)) value += 20
    })
    if (query.terms.length && query.terms.every((term) => title.includes(term.toLocaleLowerCase()))) value += 150
    if (page.favorite) value += 5
    return value
  }
  return pages
    .map((page) => ({ page, score: score(page), time: updatedTime(page) }))
    .sort((left, right) => right.score - left.score || right.time - left.time)
    .map((entry) => entry.page)
}

// ---------------------------------------------------------------------------
// Dates

const DAY_MS = 24 * 60 * 60 * 1000

export function startOfToday(now = Date.now()): number {
  const value = new Date(now)
  value.setHours(0, 0, 0, 0)
  return value.getTime()
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Apple Notes style section label. */
export function dateGroupLabel(timestamp: number, now = Date.now()): string {
  const today = startOfToday(now)
  if (timestamp >= today) return '今天'
  if (timestamp >= today - DAY_MS) return '昨天'
  if (timestamp >= today - 6 * DAY_MS) return '最近 7 天'
  if (timestamp >= today - 29 * DAY_MS) return '最近 30 天'
  const value = new Date(timestamp)
  const current = new Date(now)
  return value.getFullYear() === current.getFullYear() ? `${value.getMonth() + 1} 月` : `${value.getFullYear()} 年 ${value.getMonth() + 1} 月`
}

/** Short, scannable time for list rows. */
export function relativeDateLabel(timestamp: number, now = Date.now()): string {
  if (!timestamp) return ''
  const today = startOfToday(now)
  const value = new Date(timestamp)
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`
  if (timestamp >= today) return time
  if (timestamp >= today - DAY_MS) return `昨天 ${time}`
  if (value.getFullYear() === new Date(now).getFullYear()) return `${value.getMonth() + 1}月${value.getDate()}日`
  return `${value.getFullYear()}/${value.getMonth() + 1}/${value.getDate()}`
}

// ---------------------------------------------------------------------------
// Todos

/** When a todo needs attention: its due time, or the reminder without one. */
export function attentionAt(page: PageSummary): number | undefined {
  const value = timeOf(page.dueAt) || timeOf(page.reminderAt)
  return value || undefined
}

export const isOpenTodo = (page: PageSummary) => page.kind === 'task' && !page.completedAt

const isEndOfDay = (timestamp: number) => {
  const value = new Date(timestamp)
  return value.getHours() === 23 && value.getMinutes() === 59
}

/** "Due today" todos are stored at 23:59; they are not overdue during the day. */
const isEndOfDayToday = (timestamp: number, now: number) => {
  const endOfToday = startOfToday(now) + DAY_MS
  return timestamp >= endOfToday - 60_000 && timestamp < endOfToday && now < endOfToday
}

export const SOON_WINDOW_MS = 2 * 60 * 60 * 1000

export interface TodoDigest {
  overdue: PageSummary[]
  dueToday: PageSummary[]
  /** Overdue or due within two hours, soonest first: banner candidates. */
  attention: PageSummary[]
  /** Actionable count for badges: overdue + due today. */
  badge: number
}

export function todoDigest(pages: PageSummary[], now = Date.now()): TodoDigest {
  const endOfToday = startOfToday(now) + DAY_MS
  const open = pages.filter((page) => isOpenTodo(page) && attentionAt(page) !== undefined)
  const by = (left: PageSummary, right: PageSummary) => attentionAt(left)! - attentionAt(right)!
  const overdue = open.filter((page) => attentionAt(page)! < now && !isEndOfDayToday(attentionAt(page)!, now)).sort(by)
  const overdueIds = new Set(overdue.map((page) => page.id))
  const dueToday = open.filter((page) => !overdueIds.has(page.id) && attentionAt(page)! < endOfToday).sort(by)
  const attention = open.filter((page) => attentionAt(page)! <= now + SOON_WINDOW_MS).sort(by)
  return { overdue, dueToday, attention, badge: overdue.length + dueToday.length }
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later' | 'done'

/** Human wording: "已逾期 2 天", "15:00 到期 · 还有 40 分钟", "今天到期". */
export function dueDescription(page: PageSummary, now = Date.now()): { label: string; tone: DueTone } | undefined {
  if (page.kind !== 'task') return undefined
  if (page.completedAt) return { label: '已完成', tone: 'done' }
  const timestamp = attentionAt(page)
  if (timestamp === undefined) return undefined
  const value = new Date(timestamp)
  const clock = `${pad(value.getHours())}:${pad(value.getMinutes())}`
  const today = startOfToday(now)
  if (timestamp < now && !isEndOfDayToday(timestamp, now)) {
    const late = now - timestamp
    const label = late < 60 * 60_000 ? `已逾期 ${Math.max(1, Math.floor(late / 60_000))} 分钟`
      : late < DAY_MS ? `已逾期 ${Math.floor(late / (60 * 60_000))} 小时`
      : `已逾期 ${Math.floor(late / DAY_MS)} 天`
    return { label, tone: 'overdue' }
  }
  if (isEndOfDay(timestamp) && timestamp < today + DAY_MS) return { label: '今天到期', tone: 'today' }
  if (timestamp - now < 60 * 60_000) return { label: `${clock} 到期 · 还有 ${Math.max(1, Math.floor((timestamp - now) / 60_000))} 分钟`, tone: 'soon' }
  if (timestamp < today + DAY_MS) return { label: `今天 ${clock} 到期`, tone: 'today' }
  if (timestamp < today + 2 * DAY_MS) return { label: isEndOfDay(timestamp) ? '明天到期' : `明天 ${clock} 到期`, tone: 'later' }
  return { label: `${relativeDateLabel(timestamp, now)} 到期`, tone: 'later' }
}

/** Todo sections in due order (Todoist / TickTick). */
export function todoGroupLabel(page: PageSummary, now = Date.now()): string {
  if (page.completedAt) return '已完成'
  const at = attentionAt(page)
  if (at === undefined) return '无截止日期'
  const today = startOfToday(now)
  if (at < now && !isEndOfDayToday(at, now)) return '已逾期'
  if (at < today + DAY_MS) return '今天'
  if (at < today + 2 * DAY_MS) return '明天'
  if (at < today + 7 * DAY_MS) return '7 天内'
  return '以后'
}

const TODO_GROUP_ORDER = ['已逾期', '今天', '明天', '7 天内', '以后', '无截止日期', '已完成']

// ---------------------------------------------------------------------------
// Ordering and sections

export type ListOrder = 'updated' | 'created' | 'title' | 'due'

export const listOrderLabels: Record<ListOrder, string> = {
  updated: '最近编辑',
  created: '创建时间',
  title: '标题',
  due: '截止时间',
}

const titleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function sortPages(pages: PageSummary[], order: ListOrder, now = Date.now()): PageSummary[] {
  const list = [...pages]
  if (order === 'title') return list.sort((left, right) => titleCollator.compare(left.title, right.title))
  if (order === 'created') return list.sort((left, right) => createdTime(right) - createdTime(left))
  if (order === 'due') {
    return list.sort((left, right) => {
      const leftGroup = TODO_GROUP_ORDER.indexOf(todoGroupLabel(left, now))
      const rightGroup = TODO_GROUP_ORDER.indexOf(todoGroupLabel(right, now))
      if (leftGroup !== rightGroup) return leftGroup - rightGroup
      const leftAt = attentionAt(left) ?? Number.MAX_SAFE_INTEGER
      const rightAt = attentionAt(right) ?? Number.MAX_SAFE_INTEGER
      if (left.completedAt || right.completedAt) return timeOf(right.completedAt) - timeOf(left.completedAt)
      return leftAt - rightAt || Number(Boolean(right.important)) - Number(Boolean(left.important)) || updatedTime(right) - updatedTime(left)
    })
  }
  return list.sort((left, right) => updatedTime(right) - updatedTime(left))
}

export interface ListSection {
  key: string
  label: string
  pages: PageSummary[]
}

/**
 * Pinned notes first, then sections that follow the order: dates for time
 * orders, due state for todos, one plain section for titles and search.
 */
export function buildSections(pages: PageSummary[], order: ListOrder, options: { pinFavorites: boolean; grouped: boolean; now?: number }): ListSection[] {
  const now = options.now ?? Date.now()
  const sorted = sortPages(pages, order, now)
  const sections: ListSection[] = []
  const pinned = options.pinFavorites ? sorted.filter((page) => page.favorite) : []
  const rest = pinned.length ? sorted.filter((page) => !page.favorite) : sorted
  if (pinned.length) sections.push({ key: 'pinned', label: '置顶', pages: pinned })
  if (!options.grouped || order === 'title') {
    if (rest.length) sections.push({ key: 'all', label: pinned.length ? '笔记' : '', pages: rest })
    return sections
  }
  const labelFor = order === 'due'
    ? (page: PageSummary) => todoGroupLabel(page, now)
    : (page: PageSummary) => dateGroupLabel(order === 'created' ? createdTime(page) : updatedTime(page), now)
  let current: ListSection | undefined
  for (const page of rest) {
    const label = labelFor(page)
    if (!current || current.label !== label) {
      current = { key: `group:${label}`, label, pages: [] }
      sections.push(current)
    }
    current.pages.push(page)
  }
  return sections
}

/** Tag names with note counts, most used first. */
export function tagCounts(pages: PageSummary[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const page of pages) for (const tag of page.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || titleCollator.compare(left.name, right.name))
}
