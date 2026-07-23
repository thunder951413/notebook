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
  useEffect(() => { if (open) void load(pageId).then(setRevisions) }, [load, open, pageId])
  return <div className="version-history">
    <Button size="small" appearance="subtle" onClick={() => setOpen((value) => !value)}>版本</Button>
    {open && <div className="version-popover"><div><Text weight="semibold">版本历史</Text><Button size="small" appearance="subtle" onClick={() => setOpen(false)}>关闭</Button></div>{revisions.length === 0 ? <p>编辑后会自动保存版本；从旧版迁移的历史会完整保留。</p> : revisions.map((revision) => <button key={revision.id} onClick={() => { void restore(revision.id).then(() => setOpen(false)) }}><strong>{new Date(revision.createdAt).toLocaleString()}</strong><span>{revision.reason === 'autosave' ? '自动保存' : revision.reason}</span></button>)}</div>}
  </div>
}
