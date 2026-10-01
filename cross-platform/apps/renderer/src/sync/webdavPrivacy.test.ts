import { expect, test } from 'vitest'
import { WebdavPrivacyCipher } from './webdavPrivacy'

const secret = 'interop-key-测试🔐'
const salt = Uint8Array.from({ length: 16 }, (_, index) => index)
const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 16)
const text = '隐私正文\n表格 | 附件\n'
const expected = 'vPxcbI4sRF1znlle9H8zvnxoVYzYcW406m0cI3o8b37tK7Ix7tQCc/c5AnIm'

test('matches the Android PBKDF2 and AES-GCM Unicode wire vector', async () => {
  const cipher = new WebdavPrivacyCipher(secret)
  const envelope = await cipher.encrypt('document:interop-page', new TextEncoder().encode(text), salt, iv)
  expect((envelope.$encrypted as { ciphertext: string }).ciphertext).toBe(expected)
  expect(new TextDecoder().decode(await cipher.decrypt('document:interop-page', envelope))).toBe(text)
})
test('random nonces hide equal content and authenticate both content and ownership', async () => {
  const cipher = new WebdavPrivacyCipher(secret)
  const payload = { markdown: text, filename: 'private.png' }
  const first = await cipher.encryptPayload('document', 'page-a', payload)
  const second = await cipher.encryptPayload('document', 'page-a', payload)
  expect(first).not.toEqual(second)
  expect(JSON.stringify(first)).not.toContain(text)
  expect(await cipher.decryptPayload('document', 'page-a', first)).toEqual(payload)
  await expect(cipher.decryptPayload('document', 'page-b', first)).rejects.toThrow('密文')
  await expect(cipher.decryptPayload('document', 'page-a', first, 'delete')).rejects.toThrow('密文')
  await expect(cipher.decryptPayload('document', 'page-a', first, 'upsert', 9)).rejects.toThrow('密文')
  await expect(new WebdavPrivacyCipher('wrong').decryptPayload('document', 'page-a', first)).rejects.toThrow('密文')
  const changed = structuredClone(first)
  const box = changed.$encrypted as { ciphertext: string }
  box.ciphertext = (box.ciphertext[0] === 'A' ? 'B' : 'A') + box.ciphertext.slice(1)
  await expect(cipher.decryptPayload('document', 'page-a', changed)).rejects.toThrow('密文')
  await expect(new WebdavPrivacyCipher('').decryptPayload('document', 'page-a', first)).rejects.toThrow('密钥')
})
