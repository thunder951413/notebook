import { useState } from 'react'
import { Button, Input } from '@fluentui/react-components'

export function PrivacyPasswordDialog({ mode, onClose, onSubmit }: { mode: 'setup' | 'unlock'; onClose: () => void; onSubmit: (passphrase: string) => Promise<void> }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const valid = mode === 'unlock' ? Boolean(passphrase) : passphrase.length >= 8 && passphrase === confirmation
  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(undefined)
    try { await onSubmit(passphrase) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法解锁隐私笔记本') } finally { setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog privacy-dialog" role="dialog" aria-label={mode === 'setup' ? '设置隐私密码' : '解锁隐私笔记本'}><div><h2>{mode === 'setup' ? '设置此设备的隐私密码' : '解锁隐私笔记本'}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><p>{mode === 'setup' ? '旧版密码只保存在 macOS 钥匙串中，不能从导出包读取。请为当前设备设置一个至少 8 个字符的新密码。' : '解锁仅对本次应用会话有效；重新打开应用后会自动锁定。'}</p><Input type="password" autoFocus value={passphrase} onChange={(_, data) => setPassphrase(data.value)} onKeyDown={(event) => { if (event.key === 'Enter' && mode === 'unlock') void submit() }} aria-label="隐私密码" placeholder="输入隐私密码" />{mode === 'setup' && <Input type="password" value={confirmation} onChange={(_, data) => setConfirmation(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label="确认隐私密码" placeholder="再次输入隐私密码" />}{mode === 'setup' && confirmation && passphrase !== confirmation && <p role="alert">两次输入的密码不一致</p>}{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!valid || saving} onClick={() => void submit()}>{saving ? '正在处理' : mode === 'setup' ? '设置并解锁' : '解锁'}</Button></section></div>
}
