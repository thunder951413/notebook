import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Asset } from '@notebook/domain'
import { useCollaborativeDocument } from '../collaboration/useCollaborativeDocument'
import { createContentExtensions, sanitizeSupportedHtml, type AssetLoader } from './extensions'
import { registerFlushHandler } from '../data/flushCoordinator'
import { createTrailingDebounce, type TrailingDebounce } from './saveScheduler'
import { INSERT_REFERENCE_EVENT, openReferencePicker, type InsertReferenceDetail } from './referenceCommands'
import { OUTLINE_JUMP_EVENT } from './OutlinePanel'
import { INSERT_ASSET_EVENT, insertAssetIntoEditor, type InsertAssetDetail } from '../assets/assetCommands'

export const initialContent = `
  <h1>Notebook Next 产品愿景</h1>
  <p class="lead">把笔记、任务、AI 与跨设备编辑放进同一个可靠的工作区。</p>
  <h2>我们想解决什么</h2>
  <p>新版本让每一篇页面都能自然记录、快速检索，并在不同设备之间保持一致。</p>
  <blockquote><p>像 OneNote 一样自然地记录，再让 AI 基于当前笔记和可追溯来源继续工作。</p></blockquote>
  <h2>首要原则</h2>
  <ul>
    <li><p><strong>离线优先：</strong>没有网络时仍可完整编辑，重新连接后自动合并。</p></li>
    <li><p><strong>数据可信：</strong>自动保存、版本历史、迁移快照和附件校验必须默认开启。</p></li>
    <li><p><strong>AI 可审计：</strong>回答标明引用来源，写回笔记前由用户确认。</p></li>
    <li><p><strong>开放格式：</strong>支持 Markdown、HTML、PDF 和版本化 JSON 导入导出。</p></li>
  </ul>
  <h2>下一步</h2>
  <p>继续完善跨平台数据层、编辑器、图片附件和可靠同步。</p>
`

export interface DocumentEditorProps {
  workspaceId: string
  pageId: string
  pageTitle: string
  content?: Record<string, unknown> | string
  onChange?: (json: Record<string, unknown>) => void | Promise<void>
  onDraft?: (json: Record<string, unknown>) => void | Promise<void>
  forceRestore?: boolean
  loadAsset?: AssetLoader
  saveAsset?: (pageId: string, file: File) => Promise<Asset>
  vimEnabled?: boolean
  onVimCommandModeChange?: (active: boolean) => void
  viewportPosition?: { scrollTop?: number; fraction: number }
  onViewportChange?: (position: { scrollTop: number; fraction: number }) => void
}

const statusLabels = { loading: '正在载入离线副本', offline: '离线可编辑', connecting: '正在连接协作', connected: '实时协作已连接', error: '协作服务不可用 · 已离线保存' }

// Crash drafts stay bounded behind a short trailing debounce; the durable save
// keeps its original 450ms idle cadence. Both flush immediately on quit.
const DRAFT_DEBOUNCE_MS = 250
const SAVE_DEBOUNCE_MS = 450

const vimBlockCursorPluginKey = new PluginKey<boolean>('vimBlockCursor')

const VimBlockCursor = Extension.create({
  name: 'vimBlockCursor',
  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: vimBlockCursorPluginKey,
        state: {
          init: () => false,
          apply: (transaction, active) => {
            const next = transaction.getMeta(vimBlockCursorPluginKey)
            return typeof next === 'boolean' ? next : active
          },
        },
        props: {
          attributes(state) {
            return { class: vimBlockCursorPluginKey.getState(state) ? 'vim-block-cursor-mode' : '' }
          },
          decorations(state) {
            if (!vimBlockCursorPluginKey.getState(state) || !state.selection.empty || !(state.selection instanceof TextSelection)) return null
            const position = state.selection.from
            const resolved = state.doc.resolve(position)
            if (!resolved.parent.isTextblock) return null

            const blockEnd = resolved.end()
            if (position < blockEnd) {
              return DecorationSet.create(state.doc, [
                Decoration.inline(position, nextGraphemePosition(state, position, blockEnd), {
                  class: 'vim-block-cursor',
                }),
              ])
            }

            return null
          },
        },
        view(editorView) {
          const cursor = document.createElement('span')
          cursor.className = 'vim-block-cursor-overlay'
          cursor.setAttribute('aria-hidden', 'true')
          document.body.appendChild(cursor)
          let frame: number | undefined

          const render = () => {
            frame = undefined
            const { state } = editorView
            const selection = state.selection
            if (!vimBlockCursorPluginKey.getState(state) || !editorView.hasFocus() || !selection.empty || !(selection instanceof TextSelection)) {
              cursor.hidden = true
              return
            }
            const resolved = state.doc.resolve(selection.from)
            if (!resolved.parent.isTextblock || selection.from < resolved.end()) {
              cursor.hidden = true
              return
            }
            try {
              const editorStyle = getComputedStyle(editorView.dom)
              const fontSize = Number.parseFloat(editorStyle.fontSize) || 16
              let coordinates = editorView.coordsAtPos(selection.from, -1)
              let left = coordinates.left
              let top = coordinates.top
              let height = Math.max(16, coordinates.bottom - coordinates.top)

              const domAtCursor = editorView.domAtPos(selection.from, -1)
              const cursorElement = domAtCursor.node instanceof Element ? domAtCursor.node : domAtCursor.node.parentElement
              const codeBlock = cursorElement?.closest('pre')
              if (resolved.parent.type.name === 'codeBlock' && codeBlock instanceof HTMLElement) {
                const textBeforeCursor = resolved.parent.textBetween(0, resolved.parentOffset, '', '')
                const currentLine = textBeforeCursor.slice(textBeforeCursor.lastIndexOf('\n') + 1)
                if (!currentLine) {
                  const nodeStyle = getComputedStyle(codeBlock)
                  const bounds = codeBlock.getBoundingClientRect()
                  const lineHeight = Number.parseFloat(nodeStyle.lineHeight) || fontSize * 1.7
                  const lineIndex = textBeforeCursor.split('\n').length - 1
                  left = bounds.left + (Number.parseFloat(nodeStyle.paddingLeft) || 0)
                  top = bounds.top + (Number.parseFloat(nodeStyle.paddingTop) || 0) + lineIndex * lineHeight
                  height = lineHeight
                }
              }

              cursor.style.left = `${left}px`
              cursor.style.top = `${top}px`
              cursor.style.width = `${Math.max(8, fontSize * .62)}px`
              cursor.style.height = `${height}px`
              cursor.hidden = false
            } catch {
              cursor.hidden = true
            }
          }
          const schedule = () => {
            if (frame !== undefined) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(render)
          }

          document.addEventListener('scroll', schedule, true)
          window.addEventListener('resize', schedule)
          editorView.dom.addEventListener('focus', schedule)
          editorView.dom.addEventListener('blur', schedule)
          schedule()
          return {
            update: schedule,
            destroy: () => {
              if (frame !== undefined) cancelAnimationFrame(frame)
              document.removeEventListener('scroll', schedule, true)
              window.removeEventListener('resize', schedule)
              editorView.dom.removeEventListener('focus', schedule)
              editorView.dom.removeEventListener('blur', schedule)
              cursor.remove()
            },
          }
        },
      }),
    ]
  },
})

export function DocumentEditor({ workspaceId, pageId, pageTitle, content = initialContent, onChange, onDraft, forceRestore, loadAsset, saveAsset, vimEnabled = false, onVimCommandModeChange, viewportPosition, onViewportChange }: DocumentEditorProps) {
  const session = useCollaborativeDocument(workspaceId, pageId)
  if (!session || session.status === 'loading') return <div className="editor-loading">正在载入离线副本…</div>
  return <ReadyDocumentEditor session={session} pageId={pageId} pageTitle={pageTitle} content={content} onChange={onChange} onDraft={onDraft} forceRestore={forceRestore} loadAsset={loadAsset} saveAsset={saveAsset} vimEnabled={vimEnabled} onVimCommandModeChange={onVimCommandModeChange} viewportPosition={viewportPosition} onViewportChange={onViewportChange} />
}

function ReadyDocumentEditor({ session, pageId, pageTitle, content, onChange, onDraft, forceRestore, loadAsset, saveAsset, vimEnabled = false, onVimCommandModeChange, viewportPosition, onViewportChange }: Pick<DocumentEditorProps, 'pageId' | 'pageTitle' | 'content' | 'onChange' | 'onDraft' | 'forceRestore' | 'loadAsset' | 'saveAsset' | 'vimEnabled' | 'onVimCommandModeChange' | 'viewportPosition' | 'onViewportChange'> & { session: NonNullable<ReturnType<typeof useCollaborativeDocument>> }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const restoreTimers = useRef<number[]>([])
  const restoredViewportPage = useRef<string | undefined>(undefined)
  const restoringViewport = useRef(false)
  const userMovedViewport = useRef(false)
  const viewportInteractionVersion = useRef(0)
  const latestJson = useRef<Record<string, unknown> | undefined>(undefined)
  // Signature of the JSON last known to be accepted by storage (or delivered
  // from it). Compared lazily so typing never serializes the whole document.
  const lastCommittedSignature = useRef<string | undefined>(undefined)
  const lastAppliedContent = useRef(content)
  const onChangeRef = useRef(onChange)
  const onDraftRef = useRef(onDraft)
  const onViewportChangeRef = useRef(onViewportChange)
  const onVimCommandModeChangeRef = useRef(onVimCommandModeChange)
  const vimEnabledRef = useRef(vimEnabled)
  const vimModeRef = useRef<'normal' | 'insert'>('insert')
  const pendingVimKey = useRef<string | undefined>(undefined)
  const suppressedVimTransitionText = useRef<string | undefined>(undefined)
  const draftScheduler = useRef<TrailingDebounce | undefined>(undefined)
  const commitScheduler = useRef<TrailingDebounce | undefined>(undefined)
  const [vimMode, setVimMode] = useState<'normal' | 'insert'>('insert')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [slashMenu, setSlashMenu] = useState<{ left: number; top: number }>()
  const [largeDocument, setLargeDocument] = useState(false)
  onChangeRef.current = onChange
  onDraftRef.current = onDraft
  onViewportChangeRef.current = onViewportChange
  onVimCommandModeChangeRef.current = onVimCommandModeChange
  vimEnabledRef.current = vimEnabled
  const commitNow = async () => {
    commitScheduler.current?.cancel()
    draftScheduler.current?.cancel()
    const json = latestJson.current
    if (!json) return
    const signature = JSON.stringify(json)
    await onChangeRef.current?.(json)
    lastCommittedSignature.current = signature
  }
  if (!draftScheduler.current) {
    draftScheduler.current = createTrailingDebounce(DRAFT_DEBOUNCE_MS, () => {
      const json = latestJson.current
      if (json) void Promise.resolve(onDraftRef.current?.(json)).catch(() => undefined)
    })
  }
  if (!commitScheduler.current) {
    commitScheduler.current = createTrailingDebounce(SAVE_DEBOUNCE_MS, () => { void commitNow().catch(() => undefined) })
  }
  const changeVimMode = (mode: 'normal' | 'insert') => {
    vimModeRef.current = mode
    pendingVimKey.current = undefined
    setVimMode(mode)
    onVimCommandModeChangeRef.current?.(vimEnabledRef.current && mode === 'normal')
  }
  const enterVimInsertMode = (trigger: string) => {
    const expectedText = trigger.toLocaleLowerCase()
    suppressedVimTransitionText.current = expectedText
    window.setTimeout(() => {
      if (suppressedVimTransitionText.current === expectedText) suppressedVimTransitionText.current = undefined
    }, 500)
    changeVimMode('insert')
  }
  const collaborative = Boolean(session.provider)
  const editor = useEditor({
    extensions: [
      ...createContentExtensions(collaborative, loadAsset, pageId),
      VimBlockCursor,
      Placeholder.configure({ placeholder: '开始记录，或输入 / 插入内容…' }),
      ...(collaborative ? [Collaboration.configure({ document: session.document })] : []),
      ...(session.provider ? [CollaborationCaret.configure({
        provider: session.provider,
        user: { name: '本机用户', color: '#7c3aed' },
      })] : []),
    ],
    content: collaborative ? undefined : content,
    onCreate: ({ editor: currentEditor }) => {
      // Hydration is not a user edit. Emitting an update here would mark every
      // opened page as pending and could make an old local copy beat a newer
      // Android/SSH revision during the next merge.
      if (collaborative && (forceRestore || session.document.getXmlFragment('default').length === 0) && content) currentEditor.commands.setContent(content, { emitUpdate: false })
      setLargeDocument(isLargeEditorDocument(currentEditor))
    },
    onUpdate: ({ editor: currentEditor }) => {
      setLargeDocument((current) => {
        const next = isLargeEditorDocument(currentEditor)
        return current === next ? current : next
      })
      // Typing stays O(1) per transaction here: no full-document serialization
      // until the draft/save debounces actually fire.
      latestJson.current = currentEditor.getJSON()
      draftScheduler.current?.call()
      commitScheduler.current?.call()
    },
    editorProps: {
      attributes: {
        class: 'document-editor-content',
        'aria-label': '页面正文',
      },
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          const input = event as InputEvent
          if (input.inputType === 'insertText' && input.data === ' ' && convertMarkdownCodeFence(_view, _view.state.selection.from)) {
            event.preventDefault()
            return true
          }
          if (input.inputType !== 'insertText' || !input.data || suppressedVimTransitionText.current !== input.data.toLocaleLowerCase()) return false
          event.preventDefault()
          suppressedVimTransitionText.current = undefined
          return true
        },
        keyup: (_view, event) => {
          const key = event.key.toLocaleLowerCase()
          if (suppressedVimTransitionText.current !== key) return false
          window.setTimeout(() => {
            if (suppressedVimTransitionText.current === key) suppressedVimTransitionText.current = undefined
          }, 30)
          return false
        },
      },
      transformPastedHTML: sanitizeSupportedHtml,
      handlePaste: (view, event) => {
        const images = imageFilesFromTransfer(event.clipboardData)
        if (images.length && saveAsset) {
          event.preventDefault()
          const position = view.state.selection.from
          void saveImageFilesAtPosition(view, images, pageId, saveAsset, position)
          return true
        }
        const readNativeImage = window.notebookDesktop?.clipboard?.readImage
        if (!readNativeImage || !saveAsset) return false
        const position = view.state.selection.from
        void readNativeImage().then((value) => {
          if (!value) return
          const bytes = Uint8Array.from(atob(value.dataBase64), (character) => character.charCodeAt(0))
          return saveImageFilesAtPosition(view, [new File([bytes], value.name, { type: value.mimeType })], pageId, saveAsset, position)
        })
        return false
      },
      handleDrop: (view, event) => {
        const images = imageFilesFromTransfer(event.dataTransfer)
        if (!images.length || !saveAsset) return false
        event.preventDefault()
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
        void saveImageFilesAtPosition(view, images, pageId, saveAsset, position)
        return true
      },
      handleTextInput: (view, from, _to, text) => {
        if (suppressedVimTransitionText.current === text.toLocaleLowerCase()) {
          suppressedVimTransitionText.current = undefined
          return true
        }
        if (text === ' ' && convertMarkdownCodeFence(view, from)) return true
        if (text === '/' && view.state.selection.$from.parent.isTextblock && view.state.selection.$from.parent.textContent === '') {
          queueMicrotask(() => {
            try {
              const coordinates = view.coordsAtPos(view.state.selection.from)
              setSlashMenu({ left: Math.min(coordinates.left, window.innerWidth - 260), top: Math.min(coordinates.bottom + 6, window.innerHeight - 330) })
            } catch {
              setSlashMenu({ left: 24, top: 140 })
            }
          })
        } else if (text !== '/') {
          setSlashMenu(undefined)
        }
        if (text !== '[' || from < 1 || view.state.doc.textBetween(from - 1, from, '') !== '[') return false
        view.dispatch(view.state.tr.delete(from - 1, from))
        openReferencePicker()
        return true
      },
      handleKeyDown: (view, event) => {
        if (!vimEnabledRef.current || event.metaKey || event.altKey) return false
        if (vimModeRef.current === 'insert' && suppressedVimTransitionText.current) {
          if (suppressedVimTransitionText.current === event.key.toLocaleLowerCase()) {
            event.preventDefault()
            suppressedVimTransitionText.current = undefined
            return true
          }
          suppressedVimTransitionText.current = undefined
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setSlashMenu(undefined)
          setSearchOpen(false)
          changeVimMode('normal')
          return true
        }
        if (vimModeRef.current === 'insert') {
          if (event.key === 'Enter' && view.state.selection.$from.parent.type.name === 'codeBlock') {
            event.preventDefault()
            const { from, to } = view.state.selection
            view.dispatch(view.state.tr.insertText('\n', from, to).scrollIntoView())
            return true
          }
          return false
        }
        if (event.ctrlKey && (event.key.toLocaleLowerCase() === 'p' || event.key.toLocaleLowerCase() === 'n')) {
          event.preventDefault()
          moveVertical(view, event.key.toLocaleLowerCase() === 'p' ? -1 : 1)
          return true
        }
        if (event.ctrlKey) return false
        if (event.key === 'i' || event.key === 'I') {
          event.preventDefault()
          if (event.key === 'I') moveToTextblockEdge(view, 'start')
          enterVimInsertMode(event.key)
          return true
        }
        if (event.key === 'a' || event.key === 'A') {
          event.preventDefault()
          if (event.key === 'A') moveToTextblockEdge(view, 'end')
          else moveAfterCursor(view)
          enterVimInsertMode(event.key)
          return true
        }
        if (event.key === 'o' || event.key === 'O') {
          event.preventDefault()
          if (event.repeat) return true
          insertOpenLine(view, event.key === 'O' ? 'above' : 'below')
          enterVimInsertMode(event.key)
          return true
        }
        if (event.key === 's' || event.key === 'S') {
          event.preventDefault()
          if (event.key === 'S') clearCurrentTextblock(view)
          else deleteCharacter(view)
          enterVimInsertMode(event.key)
          return true
        }
        if (event.key === '/') {
          event.preventDefault()
          setSearchQuery('')
          setSearchOpen(true)
          return true
        }
        if (event.key === 'g') {
          event.preventDefault()
          if (pendingVimKey.current === 'g') {
            pendingVimKey.current = undefined
            moveSelection(view, Selection.atStart(view.state.doc))
          } else {
            pendingVimKey.current = 'g'
          }
          return true
        }
        if (event.key === 'd') {
          event.preventDefault()
          if (pendingVimKey.current === 'd') {
            pendingVimKey.current = undefined
            deleteCurrentBlock(view)
          } else {
            pendingVimKey.current = 'd'
          }
          return true
        }
        if (pendingVimKey.current === 'd' && event.key === 'w') {
          event.preventDefault()
          pendingVimKey.current = undefined
          deleteWord(view)
          return true
        }
        pendingVimKey.current = undefined
        if (event.key === 'G') {
          event.preventDefault()
          moveSelection(view, Selection.atEnd(view.state.doc))
          return true
        }
        if (event.key === '0' || event.key === '$') {
          event.preventDefault()
          moveToTextblockEdge(view, event.key === '0' ? 'start' : 'end')
          return true
        }
        if (event.key === 'h' || event.key === 'l') {
          event.preventDefault()
          moveHorizontal(view, event.key === 'h' ? -1 : 1)
          return true
        }
        if (event.key === 'j' || event.key === 'k') {
          event.preventDefault()
          moveVertical(view, event.key === 'k' ? -1 : 1)
          return true
        }
        if (event.key === 'x') {
          event.preventDefault()
          deleteCharacter(view)
          return true
        }
        if (event.key === 'u') {
          event.preventDefault()
          queueMicrotask(() => editor?.commands.undo?.())
          return true
        }
        event.preventDefault()
        return true
      },
    },
  }, [session.document, session.provider, loadAsset, pageId, saveAsset])

  useEffect(() => {
    if (!editor || !content) return
    if (lastAppliedContent.current === content) return
    const contentSignature = JSON.stringify(content)
    if (lastCommittedSignature.current === contentSignature) {
      // Our own committed save round-tripped through storage; nothing to apply.
      // Uncommitted typing after that commit is intentionally preserved.
      lastAppliedContent.current = content
      return
    }

    // The content prop only changes after storage has accepted a local save or
    // after sync/revision restore has replaced the stored document. Local saves
    // already match the editor, so a difference here is an external replacement
    // that also needs to refresh the persistent Yjs document.
    const body = bodyRef.current
    const previousScrollTop = body?.scrollTop
    const previousSelection = editor.state.selection
    const interactionVersion = viewportInteractionVersion.current
    draftScheduler.current?.cancel()
    commitScheduler.current?.cancel()
    editor.commands.setContent(content, { emitUpdate: false })
    const maximumPosition = editor.state.doc.content.size
    try {
      const anchor = Math.min(previousSelection.anchor, maximumPosition)
      const head = Math.min(previousSelection.head, maximumPosition)
      editor.view.dispatch(editor.state.tr
        .setSelection(TextSelection.between(editor.state.doc.resolve(anchor), editor.state.doc.resolve(head)))
        .setMeta('addToHistory', false))
    } catch {
      // A structural replacement can invalidate the old selection. In that
      // case ProseMirror's safe default is preferable to aborting the refresh.
    }
    if (body && previousScrollTop !== undefined) {
      body.scrollTop = Math.min(previousScrollTop, Math.max(0, body.scrollHeight - body.clientHeight))
      window.requestAnimationFrame(() => {
        if (viewportInteractionVersion.current !== interactionVersion) return
        body.scrollTop = Math.min(previousScrollTop, Math.max(0, body.scrollHeight - body.clientHeight))
      })
    }
    latestJson.current = editor.getJSON()
    lastCommittedSignature.current = contentSignature
    lastAppliedContent.current = content
    setLargeDocument(isLargeEditorDocument(editor))
  }, [content, editor])

  useEffect(() => {
    restoreTimers.current.forEach(window.clearTimeout)
    restoreTimers.current = []
    const body = bodyRef.current
    if (!editor || !body || !viewportPosition) return
    // A user who already moved the viewport before the stored position arrived
    // does not want to be interrupted. Mark the page as restored only when the
    // restore actually starts, so a late-arriving position may still retry.
    if (userMovedViewport.current) return
    if (restoredViewportPage.current === pageId) return
    restoredViewportPage.current = pageId
    let cancelled = false
    restoringViewport.current = true
    const apply = () => {
      if (cancelled || userMovedViewport.current) return
      const maximum = Math.max(0, body.scrollHeight - body.clientHeight)
      const target = viewportPosition.scrollTop === undefined
        ? viewportPosition.fraction * maximum
        : Math.min(viewportPosition.scrollTop, maximum)
      body.scrollTop = Math.max(0, target)
    }
    const frame = window.requestAnimationFrame(() => window.requestAnimationFrame(apply))
    for (const delay of [90, 260, 700]) {
      restoreTimers.current.push(window.setTimeout(() => {
        apply()
        if (delay === 700) {
          restoringViewport.current = false
          // Never report the un-restored position after the user has taken
          // over: the caller would persist scrollTop 0 over the saved one.
          if (cancelled || userMovedViewport.current) return
          const maximum = Math.max(1, body.scrollHeight - body.clientHeight)
          onViewportChangeRef.current?.({ scrollTop: body.scrollTop, fraction: body.scrollTop / maximum })
        }
      }, delay))
    }
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      restoreTimers.current.forEach(window.clearTimeout)
      restoreTimers.current = []
      restoringViewport.current = false
    }
  }, [editor, pageId, viewportPosition])

  useEffect(() => () => {
    // Final save on unmount (page switch), but only when the editor holds
    // content storage has not already accepted — no redundant pending marks.
    draftScheduler.current?.cancel()
    commitScheduler.current?.cancel()
    void commitNow().catch(() => undefined)
  }, [])

  useEffect(() => registerFlushHandler(() => commitNow()), [])

  useEffect(() => {
    if (!editor) return
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<InsertReferenceDetail>).detail
      const attrs = {
        pageId: detail.target.pageId,
        targetKind: detail.target.kind,
        targetId: detail.target.kind === 'page' ? null : detail.target.targetId,
        alias: detail.alias ?? null,
      }
      editor.chain().focus().insertContent({ type: detail.embed ? 'notebookEmbed' : 'notebookLink', attrs }).run()
    }
    window.addEventListener(INSERT_REFERENCE_EVENT, insert)
    return () => window.removeEventListener(INSERT_REFERENCE_EVENT, insert)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<InsertAssetDetail>).detail
      if (!detail || detail.pageId !== pageId) return
      const href = `notebook-asset:${detail.asset.id}`
      let chain = editor.chain().focus()
      if (typeof detail.position === 'number') {
        chain = chain.setTextSelection(Math.min(detail.position, editor.state.doc.content.size))
      }
      if (detail.asset.kind === 'image') {
        chain.insertContent({
          type: 'image',
          attrs: {
            src: href,
            legacyAssetId: detail.asset.id,
            alt: detail.asset.filename,
            title: detail.asset.filename,
          },
        }).run()
        return
      }
      chain.insertContent({
        type: 'text',
        text: detail.asset.filename,
        marks: [{ type: 'link', attrs: { href } }],
      }).run()
    }
    window.addEventListener(INSERT_ASSET_EVENT, insert)
    return () => window.removeEventListener(INSERT_ASSET_EVENT, insert)
  }, [editor, pageId])

  useEffect(() => {
    if (!editor) return
    const jump = (event: Event) => {
      const index = Number((event as CustomEvent<{ index: number }>).detail?.index)
      let current = 0
      let position: number | undefined
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'heading') return
        if (current === index) position = pos + 1
        current += 1
      })
      if (position !== undefined) editor.chain().focus().setTextSelection(position).scrollIntoView().run()
    }
    window.addEventListener(OUTLINE_JUMP_EVENT, jump)
    return () => window.removeEventListener(OUTLINE_JUMP_EVENT, jump)
  }, [editor])

  const firstNode = editor?.state.doc.firstChild
  const duplicateTitle = firstNode?.type.name === 'heading' && firstNode.attrs.level === 1 && firstNode.textContent.trim() === pageTitle.trim()

  useEffect(() => {
    changeVimMode(vimEnabled ? 'normal' : 'insert')
    setSearchOpen(false)
    return () => onVimCommandModeChangeRef.current?.(false)
  }, [vimEnabled])

  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(vimBlockCursorPluginKey, vimEnabled && vimMode === 'normal'))
  }, [editor, vimEnabled, vimMode])

  const findNext = () => {
    if (!editor || !searchQuery.trim()) return
    const query = searchQuery.toLocaleLowerCase()
    const from = editor.state.selection.to
    const matches: Array<{ from: number; to: number }> = []
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return
      const text = node.text.toLocaleLowerCase()
      let index = text.indexOf(query)
      while (index >= 0) {
        matches.push({ from: pos + index, to: pos + index + query.length })
        index = text.indexOf(query, index + Math.max(1, query.length))
      }
    })
    const match = matches.find((item) => item.from >= from) ?? matches[0]
    if (!match) return
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView())
    editor.commands.focus()
    changeVimMode('normal')
  }

  const runSlashCommand = (command: 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'task' | 'quote' | 'code' | 'link') => {
    if (!editor) return
    const from = Math.max(0, editor.state.selection.from - 1)
    editor.chain().focus().deleteRange({ from, to: editor.state.selection.from }).run()
    if (command === 'paragraph') editor.chain().focus().setParagraph().run()
    if (command === 'h1' || command === 'h2' || command === 'h3') editor.chain().focus().toggleHeading({ level: Number(command.slice(1)) as 1 | 2 | 3 }).run()
    if (command === 'bullet') editor.chain().focus().toggleBulletList().run()
    if (command === 'task') editor.chain().focus().toggleTaskList().run()
    if (command === 'quote') editor.chain().focus().toggleBlockquote().run()
    if (command === 'code') editor.chain().focus().toggleCodeBlock().run()
    if (command === 'link') openReferencePicker()
    setSlashMenu(undefined)
  }

  return <div className={`document-editor ${duplicateTitle ? 'duplicate-title' : ''} ${largeDocument ? 'large-document' : ''}`}>
    {(session.status === 'connecting' || session.status === 'error') && <span className={`collaboration-status ${session.status}`}>{statusLabels[session.status]}</span>}
    {largeDocument && <span className="large-document-status">大型笔记 · 已按视口分段渲染</span>}
    <div
      ref={bodyRef}
      className="document-editor-body"
      onWheel={() => { viewportInteractionVersion.current += 1; userMovedViewport.current = true; restoringViewport.current = false }}
      onPointerDown={() => { viewportInteractionVersion.current += 1; userMovedViewport.current = true; restoringViewport.current = false }}
      onKeyDownCapture={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          viewportInteractionVersion.current += 1
          userMovedViewport.current = true
          restoringViewport.current = false
        }
      }}
      onScroll={(event) => {
        if (restoringViewport.current) return
        const body = event.currentTarget
        onViewportChangeRef.current?.({
          scrollTop: body.scrollTop,
          fraction: body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight),
        })
      }}
    ><EditorContent editor={editor} /></div>
    {slashMenu && <div className="slash-command-menu" role="menu" style={slashMenu}>
      <strong>插入内容</strong>
      {([
        ['paragraph', '正文', '普通 Markdown 段落'],
        ['h1', '标题一', '# 一级标题'],
        ['h2', '标题二', '## 二级标题'],
        ['h3', '标题三', '### 三级标题'],
        ['bullet', '项目列表', '- 列表'],
        ['task', '待办列表', '- [ ] 待办'],
        ['quote', '引用', '> 引用内容'],
        ['code', '代码块', '``` 代码'],
        ['link', '双链或嵌入', '链接页面、段落或连续内容'],
      ] as const).map(([id, title, hint]) => <button type="button" role="menuitem" key={id} onMouseDown={(event) => { event.preventDefault(); runSlashCommand(id) }}><span>{title}</span><small>{hint}</small></button>)}
    </div>}
    {vimEnabled && searchOpen && <form className="vim-search" role="search" onSubmit={(event) => { event.preventDefault(); findNext() }}>
      <span>/</span><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); editor?.commands.focus() } }} aria-label="Vim 搜索" />
      <button type="submit">查找下一个</button>
    </form>}
  </div>
}

function isLargeEditorDocument(editor: Editor) {
  return editor.state.doc.childCount > 120 || editor.state.doc.content.size > 250_000
}

function nextGraphemePosition(state: EditorState, position: number, blockEnd: number) {
  const remaining = state.doc.textBetween(position, Math.min(blockEnd, position + 32), '', '')
  if (!remaining) return Math.min(blockEnd, position + 1)
  if (typeof Intl.Segmenter === 'function') {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(remaining)[Symbol.iterator]().next().value
    return Math.min(blockEnd, position + Math.max(1, first?.segment.length ?? 1))
  }
  return Math.min(blockEnd, position + Math.max(1, Array.from(remaining)[0]?.length ?? 1))
}

type ProseMirrorView = Editor['view']

function imageFilesFromTransfer(transfer: DataTransfer | null) {
  if (!transfer) return []
  const images = [...transfer.files].filter((file) => file.type.startsWith('image/'))
  for (const item of transfer.items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file && !images.includes(file)) images.push(file)
  }
  return images
}

async function saveImageFilesAtPosition(
  view: ProseMirrorView,
  files: File[],
  pageId: string,
  saveAsset: NonNullable<DocumentEditorProps['saveAsset']>,
  initialPosition: number,
) {
  let position = initialPosition
  for (const source of files) {
    const extension = source.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const file = source.name ? source : new File([source], `粘贴图片-${new Date().toISOString().replaceAll(':', '-')}.${extension}`, { type: source.type })
    const asset = await saveAsset(pageId, file)
    insertAssetIntoEditor(pageId, asset, position)
    position = Math.min(view.state.selection.from, view.state.doc.content.size)
  }
  view.focus()
}

function convertMarkdownCodeFence(view: ProseMirrorView, cursorPosition: number) {
  const { state } = view
  const { selection } = state
  const { $from } = selection
  if (!selection.empty || cursorPosition !== selection.from || $from.parent.type.name !== 'paragraph') return false
  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '', '')
  const match = /^```([a-z]+)?$/i.exec(textBeforeCursor)
  const codeBlock = state.schema.nodes.codeBlock
  if (!match || !codeBlock) return false

  const blockStart = $from.before()
  const blockEnd = $from.after()
  const contentStart = $from.start()
  const transaction = state.tr
    .setBlockType(blockStart, blockEnd, codeBlock, { language: match[1] || null })
    .delete(contentStart, $from.pos)
  transaction.setSelection(TextSelection.create(transaction.doc, contentStart)).scrollIntoView()
  view.dispatch(transaction)
  return true
}

function moveSelection(view: ProseMirrorView, selection: Selection) {
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
}

function moveHorizontal(view: ProseMirrorView, direction: -1 | 1) {
  const position = Math.max(0, Math.min(view.state.doc.content.size, view.state.selection.head + direction))
  moveSelection(view, Selection.near(view.state.doc.resolve(position), direction))
}

function moveVertical(view: ProseMirrorView, direction: -1 | 1) {
  try {
    const coordinates = view.coordsAtPos(view.state.selection.head)
    const target = view.posAtCoords({ left: coordinates.left, top: direction < 0 ? coordinates.top - 20 : coordinates.bottom + 20 })
    if (target) moveSelection(view, Selection.near(view.state.doc.resolve(target.pos), direction))
  } catch {
    const fallback = Selection.findFrom(view.state.selection.$head, direction, true)
    if (fallback) moveSelection(view, fallback)
  }
}

function moveToTextblockEdge(view: ProseMirrorView, edge: 'start' | 'end') {
  const { $head } = view.state.selection
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    if (!$head.node(depth).isTextblock) continue
    moveSelection(view, TextSelection.create(view.state.doc, edge === 'start' ? $head.start(depth) : $head.end(depth)))
    return
  }
}

function currentTextblockRange(state: EditorState) {
  const { $head } = state.selection
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    if ($head.node(depth).isTextblock) {
      return {
        depth,
        from: $head.before(depth),
        to: $head.after(depth),
        textStart: $head.start(depth),
        textEnd: $head.end(depth),
      }
    }
  }
  return undefined
}

function moveAfterCursor(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (!range) return
  const position = Math.min(range.textEnd, view.state.selection.head + 1)
  moveSelection(view, TextSelection.create(view.state.doc, position))
}

function insertOpenLine(view: ProseMirrorView, direction: 'above' | 'below') {
  const { state } = view
  const { $head } = state.selection

  if ($head.parent.type.name === 'codeBlock') {
    const text = $head.parent.textContent
    const offset = $head.parentOffset
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
    const nextBreak = text.indexOf('\n', offset)
    const lineEnd = nextBreak < 0 ? text.length : nextBreak
    const insertAt = $head.start() + (direction === 'above' ? lineStart : lineEnd)
    const transaction = state.tr.insertText('\n', insertAt)
    transaction.setSelection(TextSelection.create(transaction.doc, insertAt + (direction === 'above' ? 0 : 1))).scrollIntoView()
    view.dispatch(transaction)
    return
  }

  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const node = $head.node(depth)
    if (node.type.name !== 'listItem' && node.type.name !== 'taskItem') continue
    const paragraph = state.schema.nodes.paragraph?.createAndFill()
    if (!paragraph) return
    const attrs = node.type.name === 'taskItem' ? { ...node.attrs, checked: false } : node.attrs
    const item = node.type.create(attrs, paragraph)
    const position = direction === 'above' ? $head.before(depth) : $head.after(depth)
    const transaction = state.tr.insert(position, item)
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 2))).scrollIntoView()
    view.dispatch(transaction)
    return
  }

  const range = currentTextblockRange(state)
  const paragraph = state.schema.nodes.paragraph?.createAndFill()
  if (!range || !paragraph) return
  const position = direction === 'above' ? range.from : range.to
  const parent = $head.node(range.depth - 1)
  const index = $head.index(range.depth - 1) + (direction === 'below' ? 1 : 0)
  if (!parent.canReplaceWith(index, index, paragraph.type)) return
  const transaction = state.tr.insert(position, paragraph)
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 1))).scrollIntoView()
  view.dispatch(transaction)
}

function clearCurrentTextblock(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (!range || range.textStart === range.textEnd) return
  const transaction = view.state.tr.delete(range.textStart, range.textEnd)
  transaction.setSelection(TextSelection.create(transaction.doc, range.textStart)).scrollIntoView()
  view.dispatch(transaction)
}

function deleteCurrentBlock(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (range) view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView())
}

function deleteWord(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (!range) return
  const from = view.state.selection.head
  const remaining = view.state.doc.textBetween(from, range.textEnd, '', '')
  const length = remaining.match(/^\s+|^[^\s]+\s*/u)?.[0].length ?? 0
  if (length) view.dispatch(view.state.tr.delete(from, Math.min(range.textEnd, from + length)).scrollIntoView())
}

function deleteCharacter(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (!range) return
  const from = view.state.selection.head
  if (from < range.textEnd) view.dispatch(view.state.tr.delete(from, from + 1).scrollIntoView())
}
