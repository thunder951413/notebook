import { describe, expect, it } from 'vitest'
import { decryptBackup, encryptBackup } from './encryptedBackup'

describe('encrypted backups', () => {
  it('round-trips binary data and rejects a wrong passphrase', async () => {
    const source = new TextEncoder().encode('Notebook Next 加密备份往返测试')
    const encrypted = await encryptBackup(source, 'correct-passphrase')

    expect(new TextDecoder().decode(await decryptBackup(encrypted, 'correct-passphrase'))).toBe(
      'Notebook Next 加密备份往返测试',
    )
    await expect(decryptBackup(encrypted, 'wrong-passphrase')).rejects.toThrow('口令错误或备份已损坏')
  })
})
