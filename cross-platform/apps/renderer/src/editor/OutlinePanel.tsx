import { useMemo } from 'react'

export const OUTLINE_JUMP_EVENT = 'notebook:outline-jump'

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

export function OutlineSidebar({ document }: { document?: Record<string, unknown> }) {
  const items = useMemo(() => headings(document), [document])

  return <section className="right-panel-content outline-sidebar" aria-label="页面大纲">
    <header><div><strong>页面大纲</strong><small>{items.length ? `${items.length} 个标题` : '正文中还没有标题'}</small></div></header>
    <div className="right-panel-scroll">
      {items.length === 0 && <p className="right-panel-empty">使用标题一、标题二或标题三后，会自动出现在这里。</p>}
      {items.map((item) => <button key={`${item.index}:${item.title}`} style={{ paddingInlineStart: `${12 + (item.level - 1) * 14}px` }} onClick={() => {
        window.dispatchEvent(new CustomEvent(OUTLINE_JUMP_EVENT, { detail: { index: item.index } }))
      }}><span>H{item.level}</span><strong>{item.title}</strong></button>)}
    </div>
  </section>
}
