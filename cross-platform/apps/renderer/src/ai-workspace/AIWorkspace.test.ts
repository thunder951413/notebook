import { describe, expect, test } from 'vitest'
import { mentionSearch, replaceMentionQuery } from './AIWorkspace'

describe('AI workspace @ mentions', () => {
  test('finds the active article query without treating earlier mentions as active', () => {
    expect(mentionSearch('整理 @项目总览')).toBe('项目总览')
    expect(mentionSearch('@项目总览 请结合 @风险')).toBe('风险')
    expect(mentionSearch('@项目总览 请总结')).toBeUndefined()
  })

  test('replaces only the active mention query and keeps the surrounding request', () => {
    expect(replaceMentionQuery('请比较 @项', '@项目总览 ')).toBe('请比较 @项目总览 ')
    expect(replaceMentionQuery('@A 与 @B草稿', '@B正式版 ')).toBe('@A 与 @B正式版 ')
  })
})
