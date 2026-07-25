import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AIProviderSettingsPanel } from './AIProviderSettings'

const originalDesktop = window.notebookDesktop

afterEach(() => {
  Object.defineProperty(window, 'notebookDesktop', { configurable: true, value: originalDesktop })
  localStorage.clear()
  vi.restoreAllMocks()
})

test('shows provider configuration without exposing a stored key', async () => {
  const get = vi.fn(async (key: string) => key === 'ai-provider-key:openai' ? 'secret-value' : undefined)
  Object.defineProperty(window, 'notebookDesktop', {
    configurable: true,
    value: {
      ai: { complete: vi.fn() },
      secrets: { get, set: vi.fn(), delete: vi.fn() },
    },
  })
  render(<AIProviderSettingsPanel />)
  expect(screen.getByRole('combobox')).toHaveValue('openai')
  await waitFor(() => expect(screen.getByPlaceholderText('已安全保存在本机；留空即不修改')).toBeInTheDocument())
  expect(screen.queryByDisplayValue('secret-value')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'deepseek' } })
  await waitFor(() => expect(get).toHaveBeenCalledWith('ai-provider-key:deepseek'))
  expect(screen.getByDisplayValue('deepseek-v4-flash')).toBeInTheDocument()
})
