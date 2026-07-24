import { describe, expect, it, vi } from 'vitest'
import { useAbcInputSourceForVimNormal } from './vimInputSource'

describe('useAbcInputSourceForVimNormal', () => {
  it('requests ABC when Vim enters NORMAL mode on macOS', () => {
    const useAbc = vi.fn().mockResolvedValue(true)
    expect(useAbcInputSourceForVimNormal(true, true, { platform: 'darwin', inputSource: { useAbc } })).toBe(true)
    expect(useAbc).toHaveBeenCalledOnce()
  })

  it.each([
    ['INSERT mode', true, false, 'darwin'],
    ['Vim disabled', false, false, 'darwin'],
    ['Windows', true, true, 'win32'],
    ['Linux', true, true, 'linux'],
  ])('does not request ABC in %s', (_label, vimEnabled, vimCommandMode, platform) => {
    const useAbc = vi.fn().mockResolvedValue(true)
    expect(useAbcInputSourceForVimNormal(vimEnabled, vimCommandMode, { platform, inputSource: { useAbc } })).toBe(false)
    expect(useAbc).not.toHaveBeenCalled()
  })

  it('contains a rejected native request', async () => {
    const useAbc = vi.fn().mockRejectedValue(new Error('helper unavailable'))
    expect(useAbcInputSourceForVimNormal(true, true, { platform: 'darwin', inputSource: { useAbc } })).toBe(true)
    await Promise.resolve()
  })
})
