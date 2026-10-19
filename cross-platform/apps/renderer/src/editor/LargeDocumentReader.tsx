import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { markdownToEditorCache, normalizeReferenceTargetIds } from '@notebook/sync-contract'
import type { LargeDocument } from '../data/largeDocument'
import { chunkAtOffset, type ReadingChunk, type ReadingIndex } from '../data/largeDocumentIndex'
import { useLargeDocumentIndex } from '../data/useLargeDocumentIndex'
import { flushPendingEdits, registerFlushHandler } from '../data/flushCoordinator'
import { FIND_IN_DOCUMENT_EVENT, takePendingFind, type FindInDocumentDetail } from '../search/FullTextSearch'
import { showToast } from '../components/toast'
import { DocumentEditor, type DocumentEditorProps } from './DocumentEditor'
import { createContentExtensions, documentToMarkdown } from './extensions'
import { OUTLINE_JUMP_EVENT } from './outlineEvents'
import { highlightSearchTerms, SearchHighlight } from './searchHighlight'

type Props = Omit<DocumentEditorProps, 'content' | 'onChange' | 'onDraft'> & {
  content: LargeDocument
  onSaveSection: (source: string, start: number, end: number, replacement: string) => Promise<{ markdown: string; end: number }>
}
type Jump = { offset: number; heading?: number; term?: string; occurrence?: number; serial: number }
type EditSession = { source: string; start: number; end: number; title: string; initial: string; definitions: string; content?: Record<string, unknown>; lastSaved?: string }

export function LargeDocumentReader(props: Props) {
  const { index, error, document } = useLargeDocumentIndex(props.content)
  if (!index || !document) return <div className="document-loading" role="status">{error ?? '正在准备章节…'}</div>
  return <IndexedReader {...props} content={document as LargeDocument} index={index} />
}

function IndexedReader({ content, index, onSaveSection, ...props }: Props & { index: ReadingIndex }) {
  const scroller = useRef<HTMLDivElement>(null)
  const shells = useRef(new Map<number, HTMLDivElement>())
  const heights = useRef(new Map<number, number>())
  const [visible, setVisible] = useState(() => new Set([0]))
  const [jump, setJump] = useState<Jump>()
  const [query, setQuery] = useState('')
  const [searchMessage, setSearchMessage] = useState('')
  const searchOffset = useRef(-1)
  const input = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<EditSession>()
  const [saveStatus, setSaveStatus] = useState('修改会自动保存')
  const [saveError, setSaveError] = useState('')
  const saveTail = useRef<Promise<void>>(Promise.resolve())
  const saveSectionRef = useRef(onSaveSection)
  saveSectionRef.current = onSaveSection
  const restored = useRef(false)
  const userMoved = useRef(false)
  const positionCallback = useRef(props.onViewportChange)
  positionCallback.current = props.onViewportChange
  const activeJump = jump ? chunkAtOffset(index, jump.offset) : -1
  const body = content.markdown

  const goTo = useCallback((target: Omit<Jump, 'serial'>) => {
    if (editing) { showToast('请先保存并返回阅读，再跳转到其他位置'); return }
    userMoved.current = true
    const chunk = chunkAtOffset(index, target.offset)
    setVisible((previous) => new Set([...previous, chunk]))
    setJump({ ...target, serial: performance.now() })
    shells.current.get(chunk)?.scrollIntoView({ block: 'start' })
  }, [index, editing])

  useEffect(() => {
    const root = scroller.current
    if (!root || editing || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      setVisible((previous) => {
        const next = new Set(previous)
        for (const entry of entries) {
          const item = Number((entry.target as HTMLElement).dataset.chunk)
          if (entry.isIntersecting) next.add(item)
          else next.delete(item)
        }
        return next
      })
    }, { root, rootMargin: '1000px 0px' })
    for (const shell of shells.current.values()) observer.observe(shell)
    return () => observer.disconnect()
  }, [index, editing])

  useLayoutEffect(() => {
    const root = scroller.current
    if (!root || editing || restored.current || userMoved.current || !props.viewportPosition) return
    restored.current = true
    // Fractions survive a change from the old full editor to estimated block
    // heights; pixel offsets do not. Measurements refine the nearby blocks.
    root.scrollTop = props.viewportPosition.fraction * Math.max(0, root.scrollHeight - root.clientHeight)
  }, [index, props.viewportPosition, editing])

  useEffect(() => {
    const onOutline = (event: Event) => {
      const heading = index.headings[(event as CustomEvent<{ index: number }>).detail?.index]
      if (heading) goTo({ offset: heading.start, heading: heading.index })
    }
    const reveal = (detail: FindInDocumentDetail | undefined) => {
      if (!detail || detail.pageId !== props.pageId) return
      const text = body.toLocaleLowerCase()
      const found = detail.terms.map((term) => ({ term, offset: text.indexOf(term.toLocaleLowerCase()) })).find((hit) => hit.offset >= 0)
      if (found) { setQuery(found.term); searchOffset.current = found.offset; goTo({ ...found, occurrence: 0 }) }
    }
    const onFind = () => reveal(takePendingFind(props.pageId))
    window.addEventListener(OUTLINE_JUMP_EVENT, onOutline)
    window.addEventListener(FIND_IN_DOCUMENT_EVENT, onFind)
    reveal(takePendingFind(props.pageId))
    return () => {
      window.removeEventListener(OUTLINE_JUMP_EVENT, onOutline)
      window.removeEventListener(FIND_IN_DOCUMENT_EVENT, onFind)
    }
  }, [body, goTo, index, props.pageId])

  useEffect(() => {
    const handleFind = (event: KeyboardEvent) => {
      if (!editing && (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); input.current?.focus(); input.current?.select()
      }
    }
    window.addEventListener('keydown', handleFind)
    return () => window.removeEventListener('keydown', handleFind)
  }, [editing])

  const find = (backward = false) => {
    const term = query.trim()
    if (!term) return
    const lower = body.toLocaleLowerCase()
    const word = term.toLocaleLowerCase()
    let offset = backward ? lower.lastIndexOf(word, searchOffset.current - 1) : lower.indexOf(word, searchOffset.current + 1)
    if (offset < 0) offset = backward ? lower.lastIndexOf(word) : lower.indexOf(word)
    if (offset < 0) { setSearchMessage('全文中没有找到'); return }
    setSearchMessage('已定位，可继续查找')
    searchOffset.current = offset
    const chunk = index.chunks[chunkAtOffset(index, offset)]!
    const occurrence = lower.slice(chunk.start, offset).split(word).length - 1
    goTo({ offset, term, occurrence })
  }

  const openChapter = (chapterIndex: number) => {
    const chapter = index.chapters[chapterIndex]!
    const initial = body.slice(chapter.start, chapter.end)
    setSaveError(''); setSaveStatus('修改会自动保存')
    setEditing({ source: body, start: chapter.start, end: chapter.end, title: chapter.title, initial, definitions: chapter.definitions,
      content: initial.length <= 80_000 ? markdownToEditorCache(initial + '\n\n' + index.definitions, content.assets) : undefined })
  }

  const saveChapter = (replacement: string) => {
    const session = editing
    if (!session) return Promise.resolve()
    const operation = saveTail.current.catch(() => undefined).then(async () => {
      if (replacement === session.lastSaved) return
      setSaveStatus('正在保存…')
      try {
        const result = await saveSectionRef.current(session.source, session.start, session.end, replacement)
        session.source = result.markdown
        session.end = result.end
        session.lastSaved = replacement
        setSaveStatus('已自动保存'); setSaveError('')
      } catch (error) {
        const message = error instanceof Error ? error.message : '保存失败，请重试'
        setSaveError(message); setSaveStatus('尚未保存')
        showToast(message, { kind: 'error', durationMs: 8_000 })
        throw error
      }
    })
    saveTail.current = operation
    return operation
  }

  const returnToReading = async () => {
    try {
      await flushPendingEdits()
      await saveTail.current
      setEditing(undefined)
    } catch { /* The editor and recovery version remain available. */ }
  }

  return <div className="large-note-reader document-editor" data-reading-chunks={index.chunks.length}>
    {editing ? <>
      <div className="large-note-toolbar"><strong>编辑本章 · {editing.title}</strong><span role="status">{saveStatus}</span><button onClick={() => { void returnToReading() }}>保存并返回阅读</button></div>
      {saveError && <div className="large-note-save-error" role="alert">{saveError}{saveError.includes('版本历史') && <button onClick={() => setEditing(undefined)}>保留恢复版本，返回阅读</button>}</div>}
      {editing.content ? <DocumentEditor {...props} content={editing.content} viewportPosition={undefined} onViewportChange={undefined}
        onChange={(json) => saveChapter(documentToMarkdown(normalizeReferenceTargetIds(json)) + (editing.definitions ? '\n\n' + editing.definitions : ''))} />
        : <SourceChapterEditor source={editing.initial} onSave={saveChapter} />}
    </> : <div className="large-note-toolbar">
      <span>阅读模式 · 按需加载</span>
      <form role="search" onSubmit={(event) => { event.preventDefault(); find() }}>
        <input ref={input} aria-label="在本篇中查找" placeholder="查找全文" value={query} onChange={(event) => { setQuery(event.target.value); searchOffset.current = -1; setSearchMessage('') }} />
        <button type="button" onClick={() => find(true)}>上一处</button><button type="submit">下一处</button>
        <span role="status">{searchMessage}</span>
      </form>
    </div>}
    <div className="large-note-scroll" ref={scroller} style={editing ? { display: 'none' } : undefined}
      onWheel={() => { userMoved.current = true }} onPointerDown={() => { userMoved.current = true }}
      onScroll={(event) => {
        if (editing) return
        const root = event.currentTarget
        positionCallback.current?.({ scrollTop: root.scrollTop, fraction: root.scrollTop / Math.max(1, root.scrollHeight - root.clientHeight) })
      }}>
      {index.chunks.map((chunk, number) => <div key={number} data-chunk={number} className="large-note-chunk"
        ref={(element) => { if (element) shells.current.set(number, element); else shells.current.delete(number) }}
        style={{ minHeight: heights.current.get(number) ?? chunk.height }}>
        {!editing && (visible.has(number) || activeJump === number) && <ReadChunk
          source={body.slice(chunk.start, chunk.end)} chunk={chunk} index={index} document={content} pageId={props.pageId} loadAsset={props.loadAsset}
          jump={activeJump === number ? jump : undefined} onJumpDone={() => setJump(undefined)}
          onHeight={(height) => {
            const root = scroller.current
            const previousHeight = heights.current.get(number) ?? chunk.height
            const atEnd = root && root.scrollHeight - Math.max(0, height - previousHeight) - root.scrollTop - root.clientHeight < 4
            heights.current.set(number, height)
            const shell = shells.current.get(number)
            if (shell) shell.style.minHeight = `${height}px`
            if (root && atEnd) root.scrollTop = root.scrollHeight
          }}
          onEdit={() => openChapter(chunk.chapter)} />}
      </div>)}
    </div>
  </div>
}

function ReadChunk({ source, chunk, index, document, pageId, loadAsset, jump, onJumpDone, onHeight, onEdit }: {
  source: string; chunk: ReadingChunk; index: ReadingIndex; document: LargeDocument; pageId: string; loadAsset: DocumentEditorProps['loadAsset'];
  jump?: Jump; onJumpDone: () => void; onHeight: (height: number) => void; onEdit: () => void;
}) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onHeight, onJumpDone })
  callbacks.current = { onHeight, onJumpDone }
  const parsed = useMemo(() => chunk.literal
    ? { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: source }] }] }
    : markdownToEditorCache(source + '\n\n' + index.definitions, document.assets), [source, index.definitions, document.assets, chunk.literal])
  const editor = useEditor({ editable: false, extensions: [...createContentExtensions(false, loadAsset, pageId), SearchHighlight], content: parsed,
    editorProps: { attributes: { class: 'document-editor-content', 'aria-label': '阅读正文' } } }, [parsed, loadAsset, pageId])
  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const measure = () => { const height = element.getBoundingClientRect().height; if (height > 0) callbacks.current.onHeight(height) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [editor])
  useEffect(() => {
    if (!editor || !jump) return
    if (jump.term) {
      const transaction = highlightSearchTerms(editor.state, [jump.term])
      if (transaction) editor.view.dispatch(transaction)
    }
    const frame = requestAnimationFrame(() => {
      const localHeading = index.headings.filter((heading) => heading.start >= chunk.start && heading.start < chunk.end).findIndex((heading) => heading.index === jump.heading)
      const target = jump.term ? host.current?.querySelectorAll('.search-hit-highlight')[jump.occurrence ?? 0]
        : localHeading >= 0 ? host.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[localHeading] : host.current
      target?.scrollIntoView({ block: 'center' })
      callbacks.current.onJumpDone()
    })
    return () => cancelAnimationFrame(frame)
  }, [editor, jump, index, chunk])
  return <div ref={host} className="large-note-loaded">
    <div className="large-note-chapter-action"><span>{index.chapters[chunk.chapter]?.title}</span><button onClick={onEdit}>编辑本章</button></div>
    <EditorContent editor={editor} />
  </div>
}

function SourceChapterEditor({ source, onSave }: { source: string; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(source)
  const latest = useRef(source)
  const saved = useRef(source)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const commit = useCallback(async () => {
    const value = latest.current
    if (value === saved.current) return
    await saveRef.current(value)
    saved.current = value
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => { void commit().catch(() => undefined) }, 450)
    return () => clearTimeout(timer)
  }, [text, commit])
  useEffect(() => registerFlushHandler(commit), [commit])
  useEffect(() => () => { void commit().catch(() => undefined) }, [commit])
  return <div className="large-note-source-editor"><p>本章内容较长，使用 Markdown 文本编辑，保存后恢复阅读排版。</p>
    <textarea aria-label="本章 Markdown 正文" value={text} onChange={(event) => { latest.current = event.target.value; setText(event.target.value) }} /></div>
}
