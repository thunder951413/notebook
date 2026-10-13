import { afterEach, describe, expect, test } from 'vitest'
import type { PageSummary } from '../model'
import { buildSections, dateGroupLabel, dueDescription, installPinyin, pageMatches, parseSearchQuery, rankSearchHits, relativeDateLabel, sortPages, tagCounts, todoDigest, todoGroupLabel } from './browse'

const now = new Date(2026, 9, 13, 14, 0).getTime()
const at = (days: number, hours = 12, minutes = 0) => {
  const value = new Date(now)
  value.setDate(value.getDate() + days)
  value.setHours(hours, minutes, 0, 0)
  return value.toISOString()
}

const page = (id: string, patch: Partial<PageSummary> = {}): PageSummary => ({
  id, sectionId: 's', title: id, preview: '', updatedLabel: '', tags: [], kind: 'document', updatedAt: at(0, 9), createdAt: at(-30), ...patch,
})
const context = { notebookName: (value: PageSummary) => value.sectionId === 'travel' ? '旅行' : '工作' }

afterEach(() => installPinyin(undefined))

describe('search query', () => {
  test('parses words, phrases, exclusions and tags', () => {
    expect(parseSearchQuery('首尔 "明洞 美食" -酒店 #旅行 ＃计划 -"旧 方案"')).toEqual({
      terms: ['首尔', '明洞 美食'], excluded: ['酒店', '旧 方案'], tags: ['旅行', '计划'],
    })
    expect(parseSearchQuery('  -  # ')).toEqual({ terms: ['#'], excluded: [], tags: [] })
  })

  test('every word must match; exclusions and tags filter', () => {
    const korea = page('韩国旅行', { preview: '首尔 明洞 酒店', tags: ['旅行'], sectionId: 'travel' })
    expect(pageMatches(korea, parseSearchQuery('首尔 明洞'), context)).toBe(true)
    expect(pageMatches(korea, parseSearchQuery('首尔 东京'), context)).toBe(false)
    expect(pageMatches(korea, parseSearchQuery('首尔 -酒店'), context)).toBe(false)
    expect(pageMatches(korea, parseSearchQuery('#旅'), context)).toBe(true)
    expect(pageMatches(korea, parseSearchQuery('#工作'), context)).toBe(false)
    expect(pageMatches(korea, parseSearchQuery('旅行'), context)).toBe(true)
  })

  test('pinyin and initials match Chinese titles once the converter is installed', () => {
    const korea = page('韩国旅行')
    expect(pageMatches(korea, parseSearchQuery('hgly'), context)).toBe(false)
    installPinyin((text) => [...text].map((char) => ({ 韩: 'han', 国: 'guo', 旅: 'lv', 行: 'xing' } as Record<string, string>)[char] ?? char))
    expect(pageMatches(korea, parseSearchQuery('hgly'), context)).toBe(false)
    expect(pageMatches(korea, parseSearchQuery('hglx'), context)).toBe(true)
    expect(pageMatches(korea, parseSearchQuery('hanguo'), context)).toBe(true)
    expect(pageMatches(korea, parseSearchQuery('x'), context)).toBe(false)
  })

  test('ranks title hits above body hits, newer first within a tier', () => {
    const pages = [
      page('body', { preview: '会议纪要', updatedAt: at(0, 13) }),
      page('会议纪要 旧', { updatedAt: at(-3) }),
      page('会议纪要', { updatedAt: at(-5) }),
      page('周会议纪要', { updatedAt: at(0, 10) }),
    ]
    expect(rankSearchHits(pages, parseSearchQuery('会议纪要'), context).map((value) => value.id)).toEqual(['会议纪要', '会议纪要 旧', '周会议纪要', 'body'])
  })
})

describe('dates', () => {
  test('section and row labels', () => {
    expect(dateGroupLabel(Date.parse(at(0, 1)), now)).toBe('今天')
    expect(dateGroupLabel(Date.parse(at(-1)), now)).toBe('昨天')
    expect(dateGroupLabel(Date.parse(at(-5)), now)).toBe('最近 7 天')
    expect(dateGroupLabel(Date.parse(at(-20)), now)).toBe('最近 30 天')
    expect(dateGroupLabel(new Date(2026, 1, 3).getTime(), now)).toBe('2 月')
    expect(dateGroupLabel(new Date(2025, 11, 3).getTime(), now)).toBe('2025 年 12 月')
    expect(relativeDateLabel(Date.parse(at(0, 9, 5)), now)).toBe('09:05')
    expect(relativeDateLabel(Date.parse(at(-1, 22, 30)), now)).toBe('昨天 22:30')
    expect(relativeDateLabel(new Date(2026, 1, 3).getTime(), now)).toBe('2月3日')
  })

  test('pinned first, then date sections in order', () => {
    const sections = buildSections([
      page('old', { updatedAt: at(-40) }),
      page('pin', { favorite: true, updatedAt: at(-90) }),
      page('today', { updatedAt: at(0, 13) }),
      page('yesterday', { updatedAt: at(-1) }),
    ], 'updated', { pinFavorites: true, grouped: true, now })
    expect(sections.map((section) => [section.label, section.pages.map((value) => value.id)])).toEqual([
      ['置顶', ['pin']], ['今天', ['today']], ['昨天', ['yesterday']], ['9 月', ['old']],
    ])
  })

  test('title order is one alphabetical section', () => {
    const sections = buildSections([page('b'), page('a'), page('C')], 'title', { pinFavorites: false, grouped: true, now })
    expect(sections).toHaveLength(1)
    expect(sections[0]!.pages.map((value) => value.id)).toEqual(['a', 'b', 'C'])
  })
})

describe('todos', () => {
  const todos = [
    page('late', { kind: 'task', dueAt: at(-2) }),
    page('today', { kind: 'task', dueAt: at(0, 23, 59) }),
    page('soon', { kind: 'task', dueAt: at(0, 14, 40) }),
    page('tomorrow', { kind: 'task', dueAt: at(1, 9) }),
    page('none', { kind: 'task' }),
    page('done', { kind: 'task', dueAt: at(-1), completedAt: at(-1) }),
    page('note', { dueAt: at(-1) }),
  ]

  test('badge counts overdue and due today only', () => {
    const digest = todoDigest(todos, now)
    expect(digest.overdue.map((value) => value.id)).toEqual(['late'])
    expect(digest.dueToday.map((value) => value.id)).toEqual(['soon', 'today'])
    expect(digest.badge).toBe(3)
    expect(digest.attention.map((value) => value.id)).toEqual(['late', 'soon'])
  })

  test('due wording and groups', () => {
    const byId = Object.fromEntries(todos.map((value) => [value.id, value]))
    expect(dueDescription(byId.late!, now)).toEqual({ label: '已逾期 2 天', tone: 'overdue' })
    expect(dueDescription(byId.today!, now)).toEqual({ label: '今天到期', tone: 'today' })
    expect(dueDescription(byId.soon!, now)).toEqual({ label: '14:40 到期 · 还有 40 分钟', tone: 'soon' })
    expect(dueDescription(byId.tomorrow!, now)).toEqual({ label: '明天 09:00 到期', tone: 'later' })
    expect(dueDescription(byId.done!, now)?.tone).toBe('done')
    expect(dueDescription(byId.note!, now)).toBeUndefined()
    expect(todos.map((value) => todoGroupLabel(value, now))).toEqual(['已逾期', '今天', '今天', '明天', '无截止日期', '已完成', '已逾期'])
  })

  test('due order sorts by state, then time', () => {
    expect(sortPages(todos.filter((value) => value.kind === 'task'), 'due', now).map((value) => value.id)).toEqual(['late', 'soon', 'today', 'tomorrow', 'none', 'done'])
  })
})

test('tag counts, most used first', () => {
  expect(tagCounts([page('a', { tags: ['旅行', '计划'] }), page('b', { tags: ['旅行'] })])).toEqual([{ name: '旅行', count: 2 }, { name: '计划', count: 1 }])
})
