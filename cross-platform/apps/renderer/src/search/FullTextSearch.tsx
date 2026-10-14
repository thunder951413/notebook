import { useEffect, useRef, useState } from 'react'
import { Search20Regular } from '@fluentui/react-icons'
import type { SearchHit } from '@notebook/storage-renderer'
import { highlightText } from '../shell/NoteList'

export const OPEN_FULL_TEXT_SEARCH_EVENT = 'notebook:open-full-text-search'
export const FIND_IN_DOCUMENT_EVENT = 'notebook:find-in-document'

export interface FindInDocumentDetail {
  pageId: string
  terms: string[]
}

/** Opens the full-text search panel, optionally with a query (⌘⇧F). */
export function openFullTextSearch(query = '') {
  window.dispatchEvent(new CustomEvent(OPEN_FULL_TEXT_SEARCH_EVENT, { detail: query }))
}

let pendingFind: FindInDocumentDetail | undefined

/**
 * Asks the editor of `pageId` to highlight the hit and reveal the first one.
 * The request waits for that editor if it is not open yet.
 */
export function findInDocument(detail: FindInDocumentDetail) {
  pendingFind = detail
  window.dispatchEvent(new CustomEvent<FindInDocumentDetail>(FIND_IN_DOCUMENT_EVENT, { detail }))
}

export function takePendingFind(pageId: string) {
  if (pendingFind?.pageId !== pageId) return undefined
  const detail = pendingFind
  pendingFind = undefined
  return detail
}

/**
 * Searches titles and bodies of every note (renderer inverted index with
 * Chinese word segmentation and bigrams) and shows highlighted excerpts.
 */
export function FullTextSearch({ initialQuery = '', search, notebookName, onOpen, onClose }: {
  initialQuery?: string
  search: (query: string) => Promise<SearchHit[]>
  notebookName: (sectionId: string) => string
  onOpen: (hit: SearchHit) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setHits([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      void search(text).then((results) => {
        if (cancelled) return
        setHits(results)
        setActive(0)
      }).catch(() => { if (!cancelled) setHits([]) }).finally(() => { if (!cancelled) setSearching(false) })
    }, 140)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query, search])

  const choose = (hit: SearchHit | undefined) => { if (hit) onOpen(hit) }

  return <div className="command-palette-backdrop full-text-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="command-palette full-text-search" role="dialog" aria-modal="true" aria-label="全文搜索">
      <div className="command-palette-search">
        <Search20Regular />
        <input
          ref={inputRef}
          className="full-text-search-input"
          value={query}
          spellCheck={false}
          placeholder="搜索全部笔记的标题和正文"
          aria-label="全文搜索"
          aria-controls="full-text-search-results"
          aria-activedescendant={hits[active] ? `full-text-hit-${hits[active]!.page.id}` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose() }
            else if (event.key === 'ArrowDown' && hits.length) { event.preventDefault(); setActive((value) => (value + 1) % hits.length) }
            else if (event.key === 'ArrowUp' && hits.length) { event.preventDefault(); setActive((value) => (value - 1 + hits.length) % hits.length) }
            else if (event.key === 'Enter') { event.preventDefault(); choose(hits[active]) }
          }}
        />
        <kbd>⌘⇧F</kbd>
      </div>
      <div id="full-text-search-results" className="full-text-search-results" role="listbox" aria-label="搜索结果">
        {!query.trim() && <p className="full-text-search-empty">输入关键词，同时搜索标题和正文。多个词用空格分开，"引号" 内为完整短语。</p>}
        {query.trim() && !searching && !hits.length && <p className="full-text-search-empty">没有找到包含“{query.trim()}”的笔记。</p>}
        {hits.map((hit, index) => <button
          type="button"
          role="option"
          id={`full-text-hit-${hit.page.id}`}
          key={hit.page.id}
          aria-selected={index === active}
          className={index === active ? 'selected' : undefined}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(hit)}
        >
          <span className="full-text-hit-title">{highlightText(hit.page.title || '无标题', hit.terms)}</span>
          <span className="full-text-hit-snippet">{highlightText(hit.snippet, hit.terms)}</span>
          <small>{[notebookName(hit.page.sectionId ?? ''), hit.page.kind === 'task' ? '待办' : ''].filter(Boolean).join(' · ')}</small>
        </button>)}
      </div>
      <footer className="full-text-search-footer">{searching ? '正在搜索…' : hits.length ? `${hits.length} 篇笔记 · ↑↓ 选择 · 回车打开` : ' '}</footer>
    </section>
  </div>
}
