import { beforeEach, expect, test } from 'vitest'
import {
  AI_PROVIDER_PRESETS,
  defaultAIProviderSettings,
  readAIProviderSettings,
  saveAIProviderSettings,
} from './providerSettings'

beforeEach(() => localStorage.clear())

test('defaults to a disabled OpenAI-compatible provider', () => {
  expect(readAIProviderSettings()).toEqual(defaultAIProviderSettings())
})

test('stores only non-secret provider configuration', () => {
  const saved = saveAIProviderSettings({
    enabled: true,
    provider: 'deepseek',
    baseUrl: `${AI_PROVIDER_PRESETS.deepseek.baseUrl}/`,
    model: ` ${AI_PROVIDER_PRESETS.deepseek.model} `,
  })
  expect(saved.baseUrl).toBe(AI_PROVIDER_PRESETS.deepseek.baseUrl)
  expect(readAIProviderSettings()).toEqual(saved)
  expect(localStorage.getItem('notebook-ai-provider-v1')).not.toContain('key')
})

test('rejects plaintext provider endpoints', () => {
  expect(() => saveAIProviderSettings({ enabled: true, provider: 'custom', baseUrl: 'http://example.com/v1', model: 'model' })).toThrow('HTTPS')
})
