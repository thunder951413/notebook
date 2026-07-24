import { expect, test } from 'vitest'
import { findQuickCaptureTarget } from './workspaceNavigation'

test('uses an available inbox-like section instead of hardcoded demo ids', () => {
  expect(findQuickCaptureTarget([
    { id: 'private', name: '隐私', emoji: '🔒', locked: true, sections: [{ id: 'private-inbox', name: '快速记录', color: '', pageCount: 0 }] },
    { id: 'work', name: '工作', emoji: '📓', sections: [{ id: 'ideas', name: '想法', color: '', pageCount: 0 }, { id: 'capture', name: '收件箱', color: '', pageCount: 0 }] },
  ])).toEqual({ notebookId: 'work', sectionId: 'capture' })
})

test('falls back to the first unlocked section and handles an empty workspace', () => {
  expect(findQuickCaptureTarget([
    { id: 'work', name: '工作', emoji: '📓', sections: [{ id: 'notes', name: '资料', color: '', pageCount: 0 }] },
  ])).toEqual({ notebookId: 'work', sectionId: 'notes' })
  expect(findQuickCaptureTarget([])).toBeUndefined()
})
