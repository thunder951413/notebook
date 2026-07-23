const encoder = new TextEncoder()
const MAGIC = encoder.encode('NBX1')

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 310_000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function encryptBackup(data: Uint8Array, passphrase: string) {
  if (passphrase.length < 10) throw new Error('加密口令至少需要 10 个字符')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await deriveKey(passphrase, salt), data as BufferSource))
  const output = new Uint8Array(MAGIC.length + salt.length + iv.length + encrypted.length)
  output.set(MAGIC); output.set(salt, 4); output.set(iv, 20); output.set(encrypted, 32)
  return output
}

export async function decryptBackup(data: Uint8Array, passphrase: string) {
  if (!MAGIC.every((value, index) => data[index] === value) || data.length < 33) throw new Error('不是有效的 Notebook 加密备份')
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(20, 32) as BufferSource }, await deriveKey(passphrase, data.slice(4, 20)), data.slice(32) as BufferSource))
  } catch {
    throw new Error('口令错误或备份已损坏')
  }
}
