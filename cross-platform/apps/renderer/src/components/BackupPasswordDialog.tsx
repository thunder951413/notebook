import { useState } from 'react'
import { Button, Input } from '@fluentui/react-components'

export function BackupPasswordDialog({ mode, filename, onClose, onSubmit }: { mode: 'create' | 'unlock'; filename?: string; onClose: () => void; onSubmit: (passphrase: string) => Promise<void> }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const valid = passphrase.length >= 10 && (mode === 'unlock' || passphrase === confirmation)
  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(undefined)
    try { await onSubmit(passphrase) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法处理加密备份') } finally { setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={mode === 'create' ? '创建加密备份' : '解锁加密备份'}><div><h2>{mode === 'create' ? '创建加密备份' : `解锁 ${filename ?? '加密备份'}`}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><p>口令至少 10 个字符。口令不会离开此设备，也无法由服务端找回。</p><Input type="password" autoFocus value={passphrase} onChange={(_, data) => setPassphrase(data.value)} aria-label="备份口令" placeholder="输入备份口令" />{mode === 'create' && <Input type="password" value={confirmation} onChange={(_, data) => setConfirmation(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label="确认备份口令" placeholder="再次输入口令" />}{mode === 'create' && confirmation && passphrase !== confirmation && <p role="alert">两次输入的口令不一致</p>}{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!valid || saving} onClick={() => void submit()}>{saving ? '正在处理' : mode === 'create' ? '导出加密备份' : '解锁并导入'}</Button></section></div>
}
