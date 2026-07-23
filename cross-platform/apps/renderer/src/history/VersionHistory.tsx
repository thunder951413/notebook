import { useEffect, useState } from 'react'
import { Button, Text } from '@fluentui/react-components'
import type { PageRevision } from '@notebook/domain'

interface VersionHistoryProps {
  pageId: string
  load(pageId: string): Promise<PageRevision[]>
  restore(revisionId: string): Promise<void>
}

export function VersionHistory({ pageId, load, restore }: VersionHistoryProps) {
  const [open, setOpen] = useState(false)
  const [revisions, setRevisions] = useState<PageRevision[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  useEffect(() => { if (open) void load(pageId).then(setRevisions) }, [load, open, pageId])
  const selected = revisions.find((revision) => revision.id === selectedId)
  const preview = selected?.document.markdown ?? (selected ? extractText(selected.document.tiptapJson) : '')
  return <div className="version-history">
    <Button size="small" appearance="subtle" onClick={() => setOpen((value) => !value)}>版本</Button>
    {open && <div className="version-popover"><div><Text weight="semibold">版本历史</Text><Button size="small" appearance="subtle" onClick={() => setOpen(false)}>关闭</Button></div>{revisions.length === 0 ? <p>编辑后会自动保存版本；从旧版迁移的历史会完整保留。</p> : <div className="version-browser"><div className="version-list">{revisions.map((revision) => <button className={revision.id === selectedId ? 'selected' : ''} key={revision.id} onClick={() => setSelectedId(revision.id)}><strong>{new Date(revision.createdAt).toLocaleString()}</strong><span>{revision.reason === 'autosave' ? '自动保存' : revision.reason}</span></button>)}</div><div className="version-preview">{selected ? <><pre>{preview || '（空白版本）'}</pre><Button appearance="primary" onClick={() => { void restore(selected.id).then(() => setOpen(false)) }}>恢复此版本</Button></> : <p>选择一个版本即可预览，确认后再恢复。</p>}</div></div>}</div>}
  </div>
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).join('')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(extractText).filter(Boolean).join('\n')
}
