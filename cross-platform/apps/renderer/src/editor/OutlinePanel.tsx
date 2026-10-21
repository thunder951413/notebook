import { useEffect, useMemo, useRef, useState } from 'react'
import { isLargeDocument } from '../data/largeDocument'
import { useLargeDocumentIndex } from '../data/useLargeDocumentIndex'
import { activeHeadingOf, OUTLINE_ACTIVE_EVENT, OUTLINE_JUMP_EVENT, selectActiveHeading } from './outlineEvents'

type ContentNode = { type?: string; attrs?: Record<string, unknown>; text?: string; content?: ContentNode[] }

function nodeText(node: ContentNode): string {
  return node.text ?? (node.content ?? []).map(nodeText).join('')
}

function headings(document?: Record<string, unknown>) {
  const result: { level: number; title: string; index: number }[] = []
  const visit = (node: ContentNode) => {
    if (node.type === 'heading') {
      result.push({
        level: Math.max(1, Math.min(6, Number(node.attrs?.level ?? 1))),
        title: nodeText(node).trim() || '无标题',
        index: result.length,
      })
    }
    node.content?.forEach(visit)
  }
  if (document) visit(document as ContentNode)
  return result
}

function useActiveHeading(pageId: string) {
  const [active, setActive] = useState(() => activeHeadingOf(pageId))
  useEffect(() => {
    setActive(activeHeadingOf(pageId))
    const onActive = (event: Event) => {
      const detail = (event as CustomEvent<{ pageId: string; index: number }>).detail
      if (detail.pageId === pageId) setActive(detail.index)
    }
    window.addEventListener(OUTLINE_ACTIVE_EVENT, onActive)
    return () => window.removeEventListener(OUTLINE_ACTIVE_EVENT, onActive)
  }, [pageId])
  return active
}

export function OutlineSidebar({ pageId, document, onClose }: { pageId: string; document?: Record<string, unknown>; onClose?: () => void }) {
  const { index } = useLargeDocumentIndex(document)
  const items = useMemo(() => isLargeDocument(document) ? index?.headings ?? [] : headings(document), [document, index])
  const active = useActiveHeading(pageId)
  const current = useRef<HTMLButtonElement>(null)
  useEffect(() => { current.current?.scrollIntoView?.({ block: 'nearest' }) }, [active, items.length])

  return <section className="right-panel-content outline-sidebar" aria-label="页面大纲">
    <header><div><strong>页面大纲</strong><small>{items.length ? `${items.length} 个标题` : '正文中还没有标题'}</small></div>{onClose && <button aria-label="关闭大纲" onClick={onClose}>关闭</button>}</header>
    <div className="right-panel-scroll">
      {items.length === 0 && <p className="right-panel-empty">使用标题一、标题二或标题三后，会自动出现在这里。</p>}
      {items.map((item) => <button key={`${item.index}:${item.title}`} ref={item.index === active ? current : undefined} className={item.index === active ? 'current' : undefined} aria-current={item.index === active ? 'location' : undefined} style={{ paddingInlineStart: `${12 + (item.level - 1) * 14}px` }} onClick={() => {
        selectActiveHeading(pageId, item.index)
        window.dispatchEvent(new CustomEvent(OUTLINE_JUMP_EVENT, { detail: { index: item.index } }))
      }}><span>H{item.level}</span><strong>{item.title}</strong></button>)}
    </div>
  </section>
}
