import { useState } from 'react'
import { Button, Input } from '@fluentui/react-components'

export function RenameItemDialog({ request, onClose, onRename }: { request: { kind: 'notebook'; name: string }; onClose: () => void; onRename: (name: string) => Promise<void> }) {
  const [name, setName] = useState(request.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const label = '笔记本'
  const submit = async () => {
    const normalized = name.trim()
    if (!normalized || normalized === request.name || saving) return
    setSaving(true)
    setError(undefined)
    try { await onRename(normalized) } catch (cause) { setError(cause instanceof Error ? cause.message : `无法重命名${label}`); setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={`重命名${label}`}><div><h2>重命名{label}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><Input autoFocus value={name} onChange={(_, data) => setName(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label={`${label}名称`} />{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!name.trim() || name.trim() === request.name || saving} onClick={() => void submit()}>{saving ? '正在保存' : '保存'}</Button></section></div>
}
