import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Button, Text } from '@fluentui/react-components'
import type { PageRevision } from '@notebook/domain'
import { diffLines } from 'diff'

interface VersionHistoryProps {
  pageId: string
  currentMarkdown: string
  load(pageId: string): Promise<PageRevision[]>
  create(pageId: string): Promise<PageRevision>
  restore(revisionId: string): Promise<void>
}

export function VersionHistory({ pageId, currentMarkdown, load, create, restore }: VersionHistoryProps) {
  const [open, setOpen] = useState(false)
  const [revisions, setRevisions] = useState<PageRevision[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [view, setView] = useState<'preview' | 'diff'>('preview')
  const [creating, setCreating] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<CSSProperties>()
  // The toolbar clips its overflow (and WebKit clips harder than Chromium), so
  // the popover is portaled out of it and pinned under the toolbar instead.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const box = anchor.current?.closest('.editor-toolbar')?.getBoundingClientRect() ?? anchor.current?.getBoundingClientRect()
      if (!box) return
      const top = box.bottom + 4
      setPlacement({ position: 'fixed', top, right: 12, left: 'auto', width: 'min(680px, calc(100vw - 24px))', maxHeight: `calc(100dvh - ${top + 12}px)` })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])
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
  return <div className="version-history" ref={anchor}>
    <Button size="small" appearance="subtle" onClick={() => setOpen((value) => !value)}>版本</Button>
    {open && createPortal(<div className="version-popover" style={placement}><div><span><Text weight="semibold">版本历史</Text><small>{revisions.length ? `共 ${revisions.length} 个版本` : '暂无版本'}</small></span><span><Button size="small" disabled={creating} onClick={() => { setCreating(true); void create(pageId).then((revision) => { setRevisions((items) => [revision, ...items]); setSelectedId(revision.id) }).finally(() => setCreating(false)) }}>{creating ? '保存中…' : '创建版本'}</Button><Button size="small" appearance="subtle" onClick={() => setOpen(false)}>关闭</Button></span></div>{revisions.length === 0 ? <p>可以创建一个命名时间点；日常编辑也会自动保留历史。</p> : <div className="version-browser"><div className="version-list">{revisions.map((revision, index) => <button className={revision.id === selectedId ? 'selected' : ''} key={revision.id} onClick={() => setSelectedId(revision.id)}><strong>{new Date(revision.createdAt).toLocaleString()}</strong><span>版本 {revisions.length - index} · {revisionLabel(revision.reason)}</span></button>)}</div><div className="version-preview">{selected ? <><header><div><strong>版本 {revisions.length - selectedIndex}</strong><small>{new Date(selected.createdAt).toLocaleString()} · {revisionLabel(selected.reason)}</small></div><div><Button size="small" appearance={view === 'preview' ? 'primary' : 'subtle'} onClick={() => setView('preview')}>内容</Button><Button size="small" appearance={view === 'diff' ? 'primary' : 'subtle'} onClick={() => setView('diff')}>与当前差异</Button></div></header>{view === 'preview' ? <pre>{preview || '（空白版本）'}</pre> : <div className="version-diff" aria-label="版本差异">{differences.every((part) => !part.added && !part.removed) ? <p>此版本与当前正文相同。</p> : differences.map((part, index) => <pre className={part.added ? 'added' : part.removed ? 'removed' : 'unchanged'} key={`${index}:${part.value.slice(0, 16)}`}>{part.value || ' '}</pre>)}</div>}<Button appearance="primary" onClick={() => { void restore(selected.id).then(() => setOpen(false)) }}>恢复此版本</Button></> : <p>选择一个版本即可预览，确认后再恢复。</p>}</div></div>}</div>, anchor.current?.closest('.fluent-root') ?? document.body)}
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
