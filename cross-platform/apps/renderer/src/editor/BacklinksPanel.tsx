import { useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import { Document20Regular } from '@fluentui/react-icons'
import type { PageLink } from '@notebook/domain'
import type { PageSummary } from '../model'

export function BacklinksSidebar({
  pageId,
  pages,
  load,
  loadMentions,
  openPage,
  refreshKey = 0,
}: {
  pageId: string
  pages: PageSummary[]
  load: (pageId: string) => Promise<PageLink[]>
  loadMentions: (pageId: string, signal?: AbortSignal) => Promise<{ pageId: string; excerpt: string }[]>
  openPage: (pageId: string) => void
  refreshKey?: number
}) {
  const [links, setLinks] = useState<PageLink[]>([])
  const [mentions, setMentions] = useState<{ pageId: string; excerpt: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [mentionsLoading, setMentionsLoading] = useState(false)
  const [mentionsLoaded, setMentionsLoaded] = useState(false)
  const mentionsRequest = useRef<AbortController | undefined>(undefined)
  const refreshGeneration = useRef(0)

  const refresh = async () => {
    const generation = ++refreshGeneration.current
    setLoading(true)
    try {
      const nextLinks = await load(pageId)
      if (refreshGeneration.current === generation) setLinks(nextLinks)
    } finally {
      if (refreshGeneration.current === generation) setLoading(false)
    }
  }

  const scanMentions = async () => {
    mentionsRequest.current?.abort()
    const controller = new AbortController()
    mentionsRequest.current = controller
    setMentionsLoading(true)
    try {
      const nextMentions = await loadMentions(pageId, controller.signal)
      if (!controller.signal.aborted) {
        setMentions(nextMentions.filter((mention) => !links.some((link) => link.sourcePageId === mention.pageId)))
        setMentionsLoaded(true)
      }
    } finally {
      if (!controller.signal.aborted) setMentionsLoading(false)
    }
  }

  useEffect(() => {
    mentionsRequest.current?.abort()
    setLinks([])
    setMentions([])
    setMentionsLoaded(false)
    setMentionsLoading(false)
    void refresh()
    return () => {
      refreshGeneration.current += 1
      mentionsRequest.current?.abort()
    }
  }, [pageId, refreshKey])

  return <section className="right-panel-content backlinks-sidebar" aria-label="引用当前页面的笔记">
    <header><div><strong>引用</strong><small>链接或提到当前页面的笔记</small></div><Button size="small" appearance="subtle" onClick={() => void refresh()}>刷新</Button></header>
    <div className="right-panel-scroll">
      {loading && <p className="right-panel-empty">正在读取引用…</p>}
      {!loading && links.length === 0 && !mentionsLoaded && <p className="right-panel-empty">还没有其他页面链接到这里。</p>}
      {!loading && links.length > 0 && <h4>已链接</h4>}
      {!loading && links.map((link) => {
        const page = pages.find((candidate) => candidate.id === link.sourcePageId)
        if (!page) return null
        return <button key={link.id} onClick={() => openPage(page.id)}><Document20Regular /><span><strong>{page.title}</strong><small>{link.kind === 'embed' ? '嵌入了当前内容' : '链接到当前页面'}{link.excerpt ? ` · ${link.excerpt.replace(':', ' ')}` : ''}</small></span></button>
      })}
      {!loading && !mentionsLoaded && <div className="backlinks-scan-action"><Button size="small" appearance="subtle" disabled={mentionsLoading} onClick={() => void scanMentions()}>{mentionsLoading ? '正在分批查找…' : '查找未链接提及'}</Button><small>仅在需要时扫描正文，避免大型笔记库阻塞界面。</small></div>}
      {!loading && mentionsLoaded && mentions.length === 0 && <p className="right-panel-empty">没有发现未链接的标题提及。</p>}
      {!loading && mentionsLoaded && mentions.length > 0 && <h4>未链接提及</h4>}
      {!loading && mentionsLoaded && mentions.map((mention) => {
        const page = pages.find((candidate) => candidate.id === mention.pageId)
        if (!page) return null
        return <button key={mention.pageId} onClick={() => openPage(page.id)}><Document20Regular /><span><strong>{page.title}</strong><small>{mention.excerpt}</small></span></button>
      })}
    </div>
  </section>
}
