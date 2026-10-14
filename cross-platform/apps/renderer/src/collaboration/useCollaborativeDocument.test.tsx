import { act, renderHook, waitFor } from '@testing-library/react'
import { WebSocketStatus, type HocuspocusProviderConfiguration } from '@hocuspocus/provider'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import { useCollaborativeDocument } from './useCollaborativeDocument'

const state = vi.hoisted(() => {
  vi.stubEnv('VITE_NOTEBOOK_COLLAB_URL', 'ws://127.0.0.1:1234')
  return { providers: [] as Array<{ configuration: HocuspocusProviderConfiguration; destroy: ReturnType<typeof vi.fn> }> }
})

vi.mock('@hocuspocus/provider', async importOriginal => ({
  ...await importOriginal<typeof import('@hocuspocus/provider')>(),
  HocuspocusProvider: class {
    destroy = vi.fn()
    constructor(public configuration: HocuspocusProviderConfiguration) { state.providers.push(this) }
  },
}))

afterEach(() => { state.providers.length = 0 })
afterAll(() => { vi.unstubAllEnvs() })

test('keeps the document read-only until authenticated and preserves refreshed permissions across status and sync events', async () => {
  const { result, unmount } = renderHook(() => useCollaborativeDocument('workspace-a', 'page-a'))
  await waitFor(() => expect(result.current?.status).toBe('connecting'))
  expect(result.current?.readOnly).toBe(true)
  const provider = state.providers[0]!
  expect(provider.configuration.name).toBe('workspace-a:page:page-a')

  act(() => { provider.configuration.onAuthenticated!({ scope: 'readonly' }) })
  act(() => { provider.configuration.onSynced!({ state: true }) })
  act(() => { provider.configuration.onStatus!({ status: WebSocketStatus.Connected }) })
  expect(result.current).toMatchObject({ readOnly: true, synced: true, status: 'connected' })

  act(() => { provider.configuration.onAuthenticated!({ scope: 'read-write' }) })
  expect(result.current?.readOnly).toBe(false)
  act(() => { provider.configuration.onAuthenticated!({ scope: 'readonly' }) })
  act(() => { provider.configuration.onStatus!({ status: WebSocketStatus.Disconnected }) })
  expect(result.current?.readOnly).toBe(true)
  unmount()
  expect(provider.destroy).toHaveBeenCalledOnce()
})

test('keeps failed authentication read-only', async () => {
  const { result } = renderHook(() => useCollaborativeDocument('workspace-a', 'page-a'))
  await waitFor(() => expect(state.providers).toHaveLength(1))
  act(() => { state.providers[0]!.configuration.onAuthenticationFailed!({ reason: 'Unauthorized' }) })
  act(() => { state.providers[0]!.configuration.onStatus!({ status: WebSocketStatus.Disconnected }) })
  act(() => { state.providers[0]!.configuration.onSynced!({ state: false }) })
  expect(result.current).toMatchObject({ status: 'error', readOnly: true })
})
