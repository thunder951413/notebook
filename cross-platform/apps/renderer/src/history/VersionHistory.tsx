import { useEffect, useState } from 'react'
import { Button, Text } from '@fluentui/react-components'
import type { PageRevision } from '@notebook/domain'
import { diffLines } from 'diff'

interface VersionHistoryProps {
  pageId: string
  currentMarkdown: string
  load(pageId: string): Promise<PageRevision[]>
  restore(revisionId: string): Promise<void>
}

export function VersionHistory({ pageId, currentMarkdown, load, restore }: VersionHistoryProps) {
  const [open, setOpen] = useState(false)
  const [revisions, setRevisions] = useState<PageRevision[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [view, setView] = useState<'preview' | 'diff'>('preview')
  useEffect(() => {
    if (!open) return
    void load(pageId).then((items) => {
      setRevisions(items)
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id)
    })
  }, [load, open, pageId])
  const selected = revisions.find((revision) => revision.id === selectedId)
  const preview = selected?.document.markdown ?? (selected ? extractText(selected.document.tiptapJson) : '')
  const differences = selected ? diffLines(preview, currentMarkdown) : []
  const selectedIndex = selected ? revisions.findIndex((revision) => revision.id === selected.id) : -1
  return <div className="version-history">
    <Button size="small" appearance="subtle" onClick={() => setOpen((value) => !value)}>版本</Button>
    {open && <div className="version-popover"><div><span><Text weight="semibold">版本历史</Text><small>{revisions.length ? `共 ${revisions.length} 个版本` : '暂无版本'}</small></span><Button size="small" appearance="subtle" onClick={() => setOpen(false)}>关闭</Button></div>{revisions.length === 0 ? <p>编辑后会自动保存版本；从旧版迁移的历史会完整保留。</p> : <div className="version-browser"><div className="version-list">{revisions.map((revision, index) => <button className={revision.id === selectedId ? 'selected' : ''} key={revision.id} onClick={() => setSelectedId(revision.id)}><strong>{new Date(revision.createdAt).toLocaleString()}</strong><span>版本 {revisions.length - index} · {revisionLabel(revision.reason)}</span></button>)}</div><div className="version-preview">{selected ? <><header><div><strong>版本 {revisions.length - selectedIndex}</strong><small>{new Date(selected.createdAt).toLocaleString()} · {revisionLabel(selected.reason)}</small></div><div><Button size="small" appearance={view === 'preview' ? 'primary' : 'subtle'} onClick={() => setView('preview')}>内容</Button><Button size="small" appearance={view === 'diff' ? 'primary' : 'subtle'} onClick={() => setView('diff')}>与当前差异</Button></div></header>{view === 'preview' ? <pre>{preview || '（空白版本）'}</pre> : <div className="version-diff" aria-label="版本差异">{differences.every((part) => !part.added && !part.removed) ? <p>此版本与当前正文相同。</p> : differences.map((part, index) => <pre className={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'} key={`${index}:${part.value.slice(0, 16)}`}>{part.value || ' '}</pre>)}</div>}<Button appearance="primary" onClick={() => { void restore(selected.id).then(() => setOpen(false)) }}>恢复此版本</Button></> : <p>选择一个版本即可预览，确认后再恢复。</p>}</div></div>}</div>}
  </div>
}

function revisionLabel(reason: PageRevision['reason']) {
  return reason === 'autosave' ? '自动保存' : reason === 'manual' ? '手动保存' : reason === 'restore' ? '恢复产生' : '导入版本'
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).join('')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(extractText).filter(Boolean).join('\n')
}
