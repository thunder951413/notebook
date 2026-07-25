import { describe, expect, test } from 'vitest'
import { buildAutomationHandoffText } from './handoff'

describe('external AI handoff text', () => {
  test('contains executable connection details and the guarded proposal workflow', () => {
    const text = buildAutomationHandoffText({
      baseUrl: 'http://127.0.0.1:49123',
      token: 'secret-token',
    })

    expect(text).toContain('http://127.0.0.1:49123/v1/guide')
    expect(text).toContain('http://127.0.0.1:49123/v1/openapi.json')
    expect(text).toContain('Authorization: Bearer secret-token')
    expect(text).toContain('expectedUpdatedAt')
    expect(text).toContain('POST /v1/proposals')
    expect(text).toContain('逐行差异')
    expect(text).toContain('delete-page 提案')
    expect(text).toContain('不得永久删除')
    expect(text).toContain('没有访问本机 HTTP/终端的能力')
  })
})
