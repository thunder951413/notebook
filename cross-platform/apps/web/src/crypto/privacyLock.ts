const STORAGE_KEY = 'notebook-private-lock-v1'
const ITERATIONS = 210_000

interface PrivacyLockRecord {
  version: 1
  salt: string
  verifier: string
  iterations: number
}

const bytesToBase64 = (value: Uint8Array) => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

function readRecord(): PrivacyLockRecord | undefined {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '') as PrivacyLockRecord
    if (parsed.version !== 1 || !parsed.salt || !parsed.verifier || !Number.isSafeInteger(parsed.iterations)) return undefined
    return parsed
  } catch { return undefined }
}

async function derive(passphrase: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, material, 256)
  return new Uint8Array(bits)
}

export const hasPrivacyLock = () => Boolean(readRecord())

export async function configurePrivacyLock(passphrase: string) {
  if (passphrase.length < 8) throw new Error('隐私密码至少需要 8 个字符')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const verifier = await derive(passphrase, salt, ITERATIONS)
  const record: PrivacyLockRecord = { version: 1, salt: bytesToBase64(salt), verifier: bytesToBase64(verifier), iterations: ITERATIONS }
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(record))
}

export async function verifyPrivacyLock(passphrase: string) {
  const record = readRecord()
  if (!record) return false
  const expected = base64ToBytes(record.verifier)
  const actual = await derive(passphrase, base64ToBytes(record.salt), record.iterations)
  if (actual.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index]! ^ expected[index]!
  return difference === 0
}

export function removePrivacyLock() {
  globalThis.localStorage?.removeItem(STORAGE_KEY)
}
