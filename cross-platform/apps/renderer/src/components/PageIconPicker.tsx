import { useState } from 'react'
import { Button, Input } from '@fluentui/react-components'
import type { PageSummary } from '../model'

export const PAGE_ICON_GROUPS = [
  { label: '文档', icons: ['📄', '📝', '📒', '📓', '📔', '📕', '📗', '📘', '📙', '📚', '📖', '🔖'] },
  { label: '工作', icons: ['✅', '📌', '📋', '📅', '🗓️', '💼', '🎯', '🚀', '💡', '⚙️', '🧪', '🔧'] },
  { label: '主题', icons: ['🏠', '👤', '👥', '💬', '❤️', '⭐', '🌱', '🌍', '🎨', '🎵', '📷', '🔐'] },
] as const

export function PageIconPicker({ page, onClose, onSelect }: { page: PageSummary; onClose(): void; onSelect(icon: string | undefined): Promise<void> }) {
  const [customIcon, setCustomIcon] = useState(page.icon ?? '')
  const [saving, setSaving] = useState(false)
  const choose = async (icon: string | undefined) => {
    if (saving) return
    setSaving(true)
    try { await onSelect(icon) } finally { setSaving(false) }
  }
  const normalizedCustomIcon = customIcon.trim().slice(0, 32)
  return <div className="settings-backdrop page-icon-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="settings-dialog page-icon-dialog" role="dialog" aria-modal="true" aria-label={`更换“${page.title}”的图标`}>
      <header><div><span className="page-icon-preview" aria-hidden="true">{page.icon || '📄'}</span><div><h2>页面图标</h2><p>{page.title || '无标题页面'}</p></div></div><Button appearance="subtle" onClick={onClose}>取消</Button></header>
      <div className="page-icon-groups">
        {PAGE_ICON_GROUPS.map((group) => <section key={group.label}><h3>{group.label}</h3><div className="page-icon-grid">
          {group.icons.map((icon) => <button key={icon} type="button" className={page.icon === icon ? 'selected' : ''} aria-label={`使用 ${icon}`} aria-pressed={page.icon === icon} disabled={saving} onClick={() => void choose(icon)}>{icon}</button>)}
        </div></section>)}
      </div>
      <label className="page-icon-custom"><span>粘贴其他 Emoji</span><div><Input value={customIcon} maxLength={32} aria-label="自定义 Emoji" placeholder="例如 🧭" onChange={(_, data) => setCustomIcon(data.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && normalizedCustomIcon) void choose(normalizedCustomIcon)
        if (event.key === 'Escape') onClose()
      }} /><Button appearance="primary" disabled={!normalizedCustomIcon || saving} onClick={() => void choose(normalizedCustomIcon)}>使用</Button></div></label>
      <Button appearance="subtle" disabled={!page.icon || saving} onClick={() => void choose(undefined)}>恢复自动文档/文件夹图标</Button>
    </section>
  </div>
}
