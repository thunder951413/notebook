import {
  CodeBlockLanguageSelector,
  InlineFormatToolbar,
  LinkTools,
  Muya,
  ParagraphFrontButton,
  ParagraphFrontMenu,
  ParagraphQuickInsertMenu,
  TableChessboard,
  TableColumnToolbar,
  TableDragBar,
  TableRowColumMenu,
  zhCN,
} from '@muyajs/core'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { search, searchKeymap } from '@codemirror/search'
import './style.css'

const root = document.querySelector('#editor-root')
const LARGE_DOCUMENT_THRESHOLD = 250_000
let mode = 'wysiwyg'
let markdownText = ''
let muya = null
let sourceView = null
let suppressChange = false
let changeTimer = null
let positionTimer = null

Muya.use(InlineFormatToolbar)
Muya.use(CodeBlockLanguageSelector)
Muya.use(LinkTools, {
  jumpClick: (linkInfo) => {
    const href = linkInfo?.href
    if (/^https?:\/\//i.test(href || '')) post('openLink', href)
  },
})
Muya.use(ParagraphFrontButton)
Muya.use(ParagraphFrontMenu)
Muya.use(ParagraphQuickInsertMenu)
Muya.use(TableChessboard)
Muya.use(TableColumnToolbar)
Muya.use(TableDragBar)
Muya.use(TableRowColumMenu)

function post(name, value) {
  const handler = window.webkit?.messageHandlers?.[name]
  if (handler) handler.postMessage(value)
}

function currentMarkdown() {
  if (mode === 'source' && sourceView) return sourceView.state.doc.toString()
  if (mode === 'wysiwyg' && muya) return muya.getMarkdown()
  return markdownText
}

function reportChange() {
  if (suppressChange) return
  if (currentMarkdown().length < LARGE_DOCUMENT_THRESHOLD) {
    reportChangeNow()
    return
  }
  clearTimeout(changeTimer)
  const delay = currentMarkdown().length >= LARGE_DOCUMENT_THRESHOLD ? 320 : 120
  changeTimer = setTimeout(() => {
    markdownText = currentMarkdown()
    post('editorChange', markdownText)
  }, delay)
}

function reportChangeNow() {
  if (suppressChange) return
  clearTimeout(changeTimer)
  markdownText = currentMarkdown()
  post('editorChange', markdownText)
}

function reportPosition() {
  clearTimeout(positionTimer)
  positionTimer = setTimeout(() => {
    const scrolling = mode === 'source' ? sourceView?.scrollDOM : root
    const max = Math.max((scrolling?.scrollHeight || 0) - (scrolling?.clientHeight || 0), 0)
    const fraction = max > 0 ? Math.min(1, Math.max(0, (scrolling?.scrollTop || 0) / max)) : 0
    let anchor = 0
    if (mode === 'source' && sourceView) anchor = sourceView.state.selection.main.head
    post('editorPosition', { anchor, fraction, mode })
  }, 350)
}

function destroyEditor() {
  clearTimeout(changeTimer)
  if (muya) {
    muya.destroy()
    muya = null
  }
  if (sourceView) {
    sourceView.destroy()
    sourceView = null
  }
  root.replaceChildren()
}

function createMuya() {
  const container = document.createElement('div')
  container.className = 'muya-host'
  root.append(container)
  muya = new Muya(container, {
    markdown: markdownText,
    frontMatter: true,
    footnote: true,
    math: true,
    codeBlockLineNumbers: true,
    autoPairBracket: true,
    autoPairMarkdownSyntax: true,
    autoPairQuote: true,
    spellcheckEnabled: false,
    fontSize: 17,
    lineHeight: 1.65,
  })
  muya.locale(zhCN)
  muya.init()
  muya.on('json-change', reportChange)
  muya.on('blur', reportChangeNow)
  root.addEventListener('scroll', reportPosition, { passive: true })
}

function createSourceEditor() {
  sourceView = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: markdownText,
      extensions: [
        lineNumbers(),
        history(),
        search(),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            if (!suppressChange) {
              const patches = []
              update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                patches.push({ from: fromA, to: toA, text: inserted.toString() })
              })
              post('editorPatch', patches)
            }
            reportChange()
          }
          if (update.selectionSet || update.viewportChanged) reportPosition()
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          '.cm-content': { maxWidth: '920px', margin: '0 auto', padding: '24px 34px 45vh' },
        }),
      ],
    }),
  })
}

function setMode(nextMode, preserveFocus = false) {
  const normalized = nextMode === 'source' ? 'source' : 'wysiwyg'
  if (normalized === mode && (muya || sourceView)) return
  markdownText = currentMarkdown()
  destroyEditor()
  mode = normalized
  if (mode === 'source') createSourceEditor()
  else createMuya()
  document.body.dataset.mode = mode
  if (preserveFocus) focusEditor()
  post('editorMode', mode)
}

function setContent(value, requestedMode, position) {
  suppressChange = true
  markdownText = typeof value === 'string' ? value : ''
  const safeMode = requestedMode || (markdownText.length >= LARGE_DOCUMENT_THRESHOLD ? 'source' : 'wysiwyg')
  destroyEditor()
  mode = safeMode === 'source' ? 'source' : 'wysiwyg'
  if (mode === 'source') createSourceEditor()
  else createMuya()
  document.body.dataset.mode = mode
  requestAnimationFrame(() => {
    restorePosition(position)
    suppressChange = false
    post('editorMode', mode)
  })
}

function restorePosition(position) {
  if (!position) return
  const fraction = Math.min(1, Math.max(0, Number(position.fraction) || 0))
  if (mode === 'source' && sourceView) {
    const anchor = Math.min(sourceView.state.doc.length, Math.max(0, Number(position.anchor) || 0))
    sourceView.dispatch({ selection: { anchor }, scrollIntoView: true })
    requestAnimationFrame(() => {
      const max = Math.max(sourceView.scrollDOM.scrollHeight - sourceView.scrollDOM.clientHeight, 0)
      if (max > 0 && anchor === 0) sourceView.scrollDOM.scrollTop = fraction * max
    })
  } else {
    requestAnimationFrame(() => {
      const max = Math.max(root.scrollHeight - root.clientHeight, 0)
      root.scrollTop = fraction * max
    })
  }
}

function focusEditor() {
  if (sourceView) sourceView.focus()
  else root.querySelector('[contenteditable="true"]')?.focus()
}

window.notebookEditor = {
  setContent,
  setMode,
  getContent: currentMarkdown,
  capturePosition: reportPosition,
  focus: focusEditor,
}

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    post('editorSave', currentMarkdown())
  }
})
window.addEventListener('blur', reportChangeNow, true)

post('editorReady', true)
