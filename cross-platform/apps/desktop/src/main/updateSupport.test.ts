import { describe, expect, it } from 'vitest'
import { findLatestElectronRelease, isNewerRelease, normalizeReleaseVersion, readableUpdateError } from './updateSupport'

describe('GitHub release version handling', () => {
  it('normalizes common GitHub tag formats', () => {
    expect(normalizeReleaseVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeReleaseVersion('release-2.0.1')).toBe('2.0.1')
    expect(normalizeReleaseVersion(' 3.4.5-beta.2 ')).toBe('3.4.5-beta.2')
  })

  it('only reports a strictly newer release', () => {
    expect(isNewerRelease('0.1.0', 'v0.1.1')).toBe(true)
    expect(isNewerRelease('1.2.3', 'v1.2.3')).toBe(false)
    expect(isNewerRelease('2.0.0', 'v1.9.9')).toBe(false)
    expect(isNewerRelease('1.0.0-beta.1', 'v1.0.0')).toBe(true)
  })

  it('maps common updater failures to actionable messages', () => {
    expect(readableUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toContain('网络')
    expect(readableUpdateError(new Error('sha512 checksum mismatch'))).toContain('完整性')
    expect(readableUpdateError(new Error('signature not signed'))).toContain('签名')
  })

  it('ignores legacy releases without Electron update metadata', () => {
    const releases = [
      { tag_name: 'v1.1.12', html_url: 'legacy', assets: [{ name: 'Notebook-v1.1.12-adhoc.zip' }] },
      { tag_name: 'v2.0.1', html_url: 'electron', assets: [{ name: 'latest-mac.yml' }] },
    ]
    expect(findLatestElectronRelease(releases, 'darwin')?.tag_name).toBe('v2.0.1')
    expect(findLatestElectronRelease(releases, 'win32')).toBeUndefined()
  })
})
