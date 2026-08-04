import { useState } from 'react'
import { Button, Input } from '@fluentui/react-components'

export function CreateItemDialog({ kind, onClose, onCreate }: { kind: 'notebook' | 'rootPage'; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const label = kind === 'notebook' ? '笔记本' : '顶层页面'
  const submit = async () => {
    const normalized = name.trim()
    if (!normalized || saving) return
    setSaving(true)
    try { await onCreate(normalized) } finally { setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog" role="dialog" aria-label={`新建${label}`}><div><h2>新建{label}</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div><Input autoFocus value={name} onChange={(_, data) => setName(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} aria-label={`${label}名称`} placeholder={`输入${label}名称`} /><Button appearance="primary" disabled={!name.trim() || saving} onClick={() => void submit()}>{saving ? '正在创建' : '创建'}</Button></section></div>
}
