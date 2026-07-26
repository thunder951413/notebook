import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AIProviderSettingsPanel } from './AIProviderSettings'

const originalDesktop = window.notebookDesktop

afterEach(() => {
  Object.defineProperty(window, 'notebookDesktop', { configurable: true, value: originalDesktop })
  localStorage.clear()
  vi.restoreAllMocks()
})

test('shows provider configuration without reading a stored key into the renderer', async () => {
  const hasKey = vi.fn(async (provider: string) => provider === 'openai')
  Object.defineProperty(window, 'notebookDesktop', {
    configurable: true,
    value: {
      ai: { complete: vi.fn(), cancel: vi.fn(), hasKey, setKey: vi.fn(), deleteKey: vi.fn() },
    },
  })
  render(<AIProviderSettingsPanel />)
  expect(screen.getByRole('combobox')).toHaveValue('openai')
  await waitFor(() => expect(screen.getByPlaceholderText('已安全保存在本机；留空即不修改')).toBeInTheDocument())
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'deepseek' } })
  await waitFor(() => expect(hasKey).toHaveBeenCalledWith('deepseek', 'https://api.deepseek.com'))
  expect(screen.getByDisplayValue('deepseek-v4-flash')).toBeInTheDocument()
})
