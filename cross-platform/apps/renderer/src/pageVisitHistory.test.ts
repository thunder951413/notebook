import { describe, expect, test } from 'vitest'
import { emptyPageVisitHistory, pageVisitTarget, recordPageVisit } from './pageVisitHistory'

describe('page visit history', () => {
  test('moves backward and forward through actual page visits', () => {
    let history = ['a', 'b', 'c'].reduce((value, pageId) => recordPageVisit(value, pageId), emptyPageVisitHistory())
    let result = pageVisitTarget(history, -1, () => true)
    expect(result.pageId).toBe('b')
    history = result.history
    result = pageVisitTarget(history, 1, () => true)
    expect(result.pageId).toBe('c')
    expect(result.history.index).toBe(2)
  })

  test('drops the forward branch after opening a different page', () => {
    let history = ['a', 'b', 'c'].reduce((value, pageId) => recordPageVisit(value, pageId), emptyPageVisitHistory())
    history = pageVisitTarget(history, -1, () => true).history
    history = recordPageVisit(history, 'd')
    expect(history).toEqual({ entries: ['a', 'b', 'd'], index: 2 })
    expect(pageVisitTarget(history, 1, () => true).pageId).toBeUndefined()
  })

  test('skips pages that are no longer accessible', () => {
    const history = ['a', 'deleted', 'c'].reduce((value, pageId) => recordPageVisit(value, pageId), emptyPageVisitHistory())
    const result = pageVisitTarget(history, -1, (pageId) => pageId !== 'deleted')
    expect(result.pageId).toBe('a')
    expect(result.history.index).toBe(0)
  })
})
