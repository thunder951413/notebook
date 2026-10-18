/** Authenticated private entities and attachment bytes shared with Android. */
const ITERATIONS = 310_000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
interface Envelope { version: number; algorithm: string; kdf: string; iterations: number; salt: string; iv: string; ciphertext: string }
export const ENCRYPTED_MARKER = '$encrypted'
function base64(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}
function fromBase64(value: string): Uint8Array {
  try { return Uint8Array.from(atob(value), character => character.charCodeAt(0)) }
  catch { throw new PrivacyError('bad-format', '隐私同步密文格式不正确') }
}
/** Why a private record could not be read: no key configured, a key that does not fit, or damaged data. */
export class PrivacyError extends Error {
  constructor(readonly code: 'needs-key' | 'bad-key' | 'bad-format', message: string) { super(message) }
}
export function isEncryptedPayload(payload: Record<string, unknown>): boolean { return Object.hasOwn(payload, ENCRYPTED_MARKER) }
export class WebdavPrivacyCipher {
  private readonly salt = crypto.getRandomValues(new Uint8Array(16))
  private readonly keys = new Map<string, Promise<CryptoKey>>()
  constructor(private readonly secret: string) {}
  private key(salt: Uint8Array): Promise<CryptoKey> {
    if (!this.secret) throw new PrivacyError('needs-key', '请配置两端相同的隐私同步密钥')
    const name = base64(salt)
    let value = this.keys.get(name)
    if (!value) {
      value = crypto.subtle.importKey('raw', encoder.encode(this.secret), 'PBKDF2', false, ['deriveKey'])
        .then(key => crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt.slice().buffer, iterations: ITERATIONS, hash: 'SHA-256' }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
      if (this.keys.size >= 32) this.keys.clear()
      this.keys.set(name, value)
    }
    return value
  }
  async encrypt(context: string, data: Uint8Array, salt = this.salt, iv = crypto.getRandomValues(new Uint8Array(12))): Promise<Record<string, unknown>> {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.slice().buffer, additionalData: encoder.encode(`notebook-webdav-private-v1\0${context}`), tagLength: 128 }, await this.key(salt), data.slice().buffer)
    return { [ENCRYPTED_MARKER]: { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) } }
  }
  async decrypt(context: string, payload: Record<string, unknown>): Promise<Uint8Array> {
    const envelope = payload[ENCRYPTED_MARKER] as Envelope | undefined
    if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== ITERATIONS
      || typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') throw new PrivacyError('bad-format', '不支持的隐私同步密文格式')
    const salt = fromBase64(envelope.salt), iv = fromBase64(envelope.iv), ciphertext = fromBase64(envelope.ciphertext)
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new PrivacyError('bad-format', '隐私同步密文格式不正确')
    const key = await this.key(salt)
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.slice().buffer, additionalData: encoder.encode(`notebook-webdav-private-v1\0${context}`), tagLength: 128 }, key, ciphertext.slice().buffer)) }
    catch { throw new PrivacyError('bad-key', '隐私同步密钥不匹配或密文损坏；数据和同步位置已保留') }
  }
  async encryptPayload(type: string, id: string, payload: Record<string, unknown>, operation = 'upsert', version = 0): Promise<Record<string, unknown>> { return this.encrypt(`${type}:${id}:${operation}:${version}`, encoder.encode(JSON.stringify(payload))) }
  async decryptPayload(type: string, id: string, payload: Record<string, unknown>, operation = 'upsert', version = 0): Promise<Record<string, unknown>> {
    const value: unknown = JSON.parse(decoder.decode(await this.decrypt(`${type}:${id}:${operation}:${version}`, payload)))
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new PrivacyError('bad-format', '隐私同步内容不正确')
    return value as Record<string, unknown>
  }
}
