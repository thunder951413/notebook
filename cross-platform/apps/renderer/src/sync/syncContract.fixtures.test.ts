/**
 * Renderer runner for SyncContractFixtures/webdav-v4/privacy-envelope.json.
 * The renderer encrypts private notebooks for both desktop shells; Android
 * (WebdavPrivacyCipher.kt) must reproduce the same envelopes byte for byte.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebdavPrivacyCipher } from './webdavPrivacy'

// jsdom gives import.meta.url an http: scheme, so locate the repository
// fixtures by walking up from the working directory instead.
function fixturesDirectory() {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    const candidate = join(directory, 'SyncContractFixtures', 'webdav-v4')
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) throw new Error('SyncContractFixtures/webdav-v4 not found')
  }
}
const FIXTURES = fixturesDirectory()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

describe('shared privacy envelope fixtures', () => {
  const value = fixture('privacy-envelope.json')

  it('reproduces every envelope from its salt and iv and decrypts it', async () => {
    const cipher = new WebdavPrivacyCipher(value.secret)
    for (const testCase of value.cases) {
      const context = `${testCase.type}:${testCase.id}:${testCase.op}:${testCase.ver}`
      const envelope = await cipher.encrypt(context, new TextEncoder().encode(testCase.plaintext), fromBase64(testCase.salt), fromBase64(testCase.iv))
      expect(envelope, testCase.name).toEqual(testCase.envelope)
      const payload = await cipher.decryptPayload(testCase.type, testCase.id, testCase.envelope, testCase.op, testCase.ver)
      expect(payload, testCase.name).toEqual(JSON.parse(testCase.plaintext))
    }
  }, 30_000)

  it('rejects envelopes bound to another context, tampered or with unsupported parameters', async () => {
    for (const testCase of value.rejects) {
      const cipher = new WebdavPrivacyCipher(testCase.secret ?? value.secret)
      await expect(cipher.decryptPayload(testCase.type, testCase.id, testCase.envelope, testCase.op, testCase.ver), testCase.name).rejects.toThrow()
    }
  }, 30_000)
})
