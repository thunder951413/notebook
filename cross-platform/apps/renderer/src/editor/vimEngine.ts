import { Selection, type Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

type ProseMirrorNode = EditorView['state']['doc']

// Normal-mode engine for the rich-text editor: counts, operators (d c y)
// composed with motions and text objects, an unnamed register, and put.
//
// The document is treated as a list of "lines": every non-code textblock is
// one line, and every `\n`-separated row of a code block is one line. Charwise
// motions work on those lines joined by "\n" (the "flat" string), linewise
// operations work on whole lines.

export interface VimState {
  count: string
  operator?: 'd' | 'c' | 'y'
  operatorCount: string
  prefix?: 'g' | 'i' | 'a'
}

export type VimOutcome = 'handled' | 'insert' | 'search' | 'undo' | 'redo'

export interface VimHost {
  moveVertical(view: EditorView, direction: -1 | 1): void
  openLine(view: EditorView, direction: 'above' | 'below'): void
}

interface Register { text: string; linewise: boolean }

interface Line {
  start: number
  end: number
  text: string
  blockFrom: number
  blockTo: number
  code: boolean
  /** Index of this line inside its block (always 0 for non-code blocks). */
  row: number
  /** Number of lines in its block. */
  rows: number
}

type Range = { kind: 'char'; from: number; to: number } | { kind: 'line'; from: number; to: number }
type Motion = { kind: 'char'; to: number; inclusive?: boolean } | { kind: 'line'; line: number }

const OBJECT_REPLACEMENT = '￼'
const MAX_COUNT = 9999
let register: Register | undefined

export function createVimState(): VimState {
  return { count: '', operatorCount: '' }
}

export function resetVimRegister() {
  register = undefined
}

export function readVimRegister() {
  return register
}

function resetState(state: VimState) {
  state.count = ''
  state.operatorCount = ''
  state.operator = undefined
  state.prefix = undefined
}

function buildLines(doc: ProseMirrorNode): Line[] {
  const lines: Line[] = []
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true
    const start = position + 1
    const blockFrom = position
    const blockTo = position + node.nodeSize
    const code = Boolean(node.type.spec.code)
    let text = node.textBetween(0, node.content.size, '', OBJECT_REPLACEMENT)
    if (!code) {
      if (text.length < node.content.size) text = text.padEnd(node.content.size, OBJECT_REPLACEMENT)
      lines.push({ start, end: start + node.content.size, text, blockFrom, blockTo, code, row: 0, rows: 1 })
      return false
    }
    const rows = text.split('\n')
    let offset = 0
    rows.forEach((row, index) => {
      lines.push({ start: start + offset, end: start + offset + row.length, text: row, blockFrom, blockTo, code, row: index, rows: rows.length })
      offset += row.length + 1
    })
    return false
  })
  return lines
}

interface Flat {
  lines: Line[]
  offsets: number[]
  text: string
}

function buildFlat(doc: ProseMirrorNode): Flat {
  const lines = buildLines(doc)
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.text.length + 1
  }
  return { lines, offsets, text: lines.map((line) => line.text).join('\n') }
}

function lineIndexAt(lines: Line[], position: number) {
  let found = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.start <= position) found = index
    else break
  }
  return found
}

function positionToFlat(flat: Flat, position: number) {
  const index = lineIndexAt(flat.lines, position)
  const line = flat.lines[index]
  if (!line) return 0
  return flat.offsets[index]! + Math.max(0, Math.min(line.text.length, position - line.start))
}

function flatToPosition(flat: Flat, offset: number) {
  let index = 0
  for (let candidate = 0; candidate < flat.lines.length; candidate += 1) {
    if (flat.offsets[candidate]! <= offset) index = candidate
    else break
  }
  const line = flat.lines[index]
  if (!line) return 0
  return line.start + Math.max(0, Math.min(line.text.length, offset - flat.offsets[index]!))
}

function charClass(character: string | undefined, big: boolean) {
  if (character === undefined || /\s/u.test(character)) return 0
  if (big) return 1
  return /[\p{L}\p{N}_]/u.test(character) ? 1 : 2
}

function nextWordStart(text: string, from: number, big: boolean) {
  const length = text.length
  if (from >= length) return length
  let index = from
  const startClass = charClass(text[index], big)
  if (startClass !== 0) while (index < length && charClass(text[index], big) === startClass) index += 1
  while (index < length && charClass(text[index], big) === 0) {
    if (index > from && text[index] === '\n' && text[index - 1] === '\n') break
    index += 1
  }
  return index
}

function previousWordStart(text: string, from: number, big: boolean) {
  if (from <= 0) return 0
  let index = from - 1
  while (index > 0 && charClass(text[index], big) === 0) index -= 1
  const wordClass = charClass(text[index], big)
  while (index > 0 && charClass(text[index - 1], big) === wordClass) index -= 1
  return index
}

function wordEnd(text: string, from: number, big: boolean) {
  const length = text.length
  let index = from + 1
  while (index < length && charClass(text[index], big) === 0) index += 1
  if (index >= length) return Math.max(0, length - 1)
  const wordClass = charClass(text[index], big)
  while (index + 1 < length && charClass(text[index + 1], big) === wordClass) index += 1
  return index
}

function firstNonBlank(line: Line) {
  const offset = line.text.search(/\S/u)
  return offset < 0 ? line.text.length : offset
}

function wordObject(text: string, cursor: number, around: boolean): { from: number; to: number } | undefined {
  if (!text.length) return undefined
  const index = Math.min(cursor, text.length - 1)
  const wordClass = charClass(text[index], false)
  let from = index
  let to = index + 1
  while (from > 0 && charClass(text[from - 1], false) === wordClass) from -= 1
  while (to < text.length && charClass(text[to], false) === wordClass) to += 1
  if (!around) return { from, to }
  if (wordClass === 0) {
    const nextClass = charClass(text[to], false)
    if (to < text.length && nextClass !== 0) while (to < text.length && charClass(text[to], false) === nextClass) to += 1
  } else if (charClass(text[to], false) === 0 && to < text.length) {
    while (to < text.length && charClass(text[to], false) === 0) to += 1
  } else {
    while (from > 0 && charClass(text[from - 1], false) === 0) from -= 1
  }
  return { from, to }
}

const BRACKETS: Record<string, [string, string]> = {
  '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
  '[': ['[', ']'], ']': ['[', ']'],
  '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
  '<': ['<', '>'], '>': ['<', '>'],
}

function pairObject(text: string, cursor: number, key: string, around: boolean): { from: number; to: number } | undefined {
  if (key === '"' || key === "'" || key === '`') {
    // Quotes only pair up within the cursor's own line.
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1
    const nextBreak = text.indexOf('\n', cursor)
    const lineEnd = nextBreak < 0 ? text.length : nextBreak
    const quotes: number[] = []
    for (let index = lineStart; index < lineEnd; index += 1) if (text[index] === key) quotes.push(index)
    for (let index = 0; index + 1 < quotes.length; index += 2) {
      const open = quotes[index]!
      const close = quotes[index + 1]!
      if (cursor >= open && cursor <= close) return around ? { from: open, to: close + 1 } : { from: open + 1, to: close }
    }
    return undefined
  }
  const pair = BRACKETS[key]
  if (!pair) return undefined
  const [open, close] = pair
  let depth = 0
  let start = -1
  for (let index = Math.min(cursor, text.length - 1); index >= 0; index -= 1) {
    const character = text[index]
    if (character === close && index !== cursor) depth += 1
    else if (character === open) {
      if (depth === 0) { start = index; break }
      depth -= 1
    }
  }
  if (start < 0) return undefined
  depth = 0
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === open) depth += 1
    else if (text[index] === close) {
      if (depth === 0) return around ? { from: start, to: index + 1 } : { from: start + 1, to: index }
      depth -= 1
    }
  }
  return undefined
}

function finish(view: EditorView, transaction: Transaction, position: number, insert: boolean) {
  let target = Math.max(0, Math.min(transaction.doc.content.size, position))
  if (!insert) {
    const lines = buildLines(transaction.doc)
    const line = lines[lineIndexAt(lines, target)]
    if (line && target === line.end && line.end > line.start) target -= 1
  }
  transaction.setSelection(Selection.near(transaction.doc.resolve(target), 1)).scrollIntoView()
  view.dispatch(transaction)
}

function placeCursor(view: EditorView, position: number, insert = false) {
  finish(view, view.state.tr, position, insert)
}

function repeat(text: string, count: number) {
  return count <= 1 ? text : text.repeat(count)
}

function charwiseRange(flat: Flat, range: { from: number; to: number }) {
  return { from: flatToPosition(flat, range.from), to: flatToPosition(flat, range.to) }
}

function deleteLines(view: EditorView, lines: Line[], from: number, to: number, keepFirst: boolean) {
  const { state } = view
  const transaction = state.tr
  const everything = from === 0 && to === lines.length - 1 && !keepFirst
  if (everything) {
    const paragraph = state.schema.nodes.paragraph?.createAndFill()
    if (!paragraph) return
    transaction.replaceWith(0, state.doc.content.size, paragraph)
    finish(view, transaction, 1, false)
    return
  }
  // Walk bottom-up so earlier positions stay valid while we delete.
  const firstDeleted = keepFirst ? from + 1 : from
  const blocks = new Map<number, Line[]>()
  for (let index = firstDeleted; index <= to; index += 1) {
    const line = lines[index]!
    blocks.set(line.blockFrom, [...(blocks.get(line.blockFrom) ?? []), line])
  }
  const ordered = [...blocks.entries()].sort((a, b) => b[0] - a[0])
  for (const [, covered] of ordered) {
    const first = covered[0]!
    if (!first.code || covered.length === first.rows) {
      transaction.deleteRange(first.blockFrom, first.blockTo)
      continue
    }
    const last = covered[covered.length - 1]!
    const blockLines = lines.filter((line) => line.blockFrom === first.blockFrom)
    if (last.row === last.rows - 1) transaction.delete(first.start - 1, last.end)
    else transaction.delete(first.start, blockLines[last.row + 1]!.start)
  }
  if (keepFirst) {
    const line = lines[from]!
    if (line.end > line.start) transaction.delete(line.start, line.end)
    finish(view, transaction, line.start, true)
    return
  }
  finish(view, transaction, transaction.mapping.map(lines[from]!.blockFrom, -1), false)
}

function applyOperator(view: EditorView, flat: Flat, operator: 'd' | 'c' | 'y', range: Range) {
  if (range.kind === 'line') {
    const text = flat.lines.slice(range.from, range.to + 1).map((line) => line.text).join('\n')
    register = { text, linewise: true }
    if (operator === 'y') return 'handled' as const
    deleteLines(view, flat.lines, range.from, range.to, operator === 'c')
    return operator === 'c' ? 'insert' as const : 'handled' as const
  }
  const text = flat.text.slice(range.from, range.to)
  if (text) register = { text, linewise: false }
  const { from, to } = charwiseRange(flat, range)
  if (operator === 'y') {
    placeCursor(view, from)
    return 'handled' as const
  }
  if (to > from) {
    const transaction = view.state.tr.delete(from, to)
    finish(view, transaction, from, operator === 'c')
  } else if (operator === 'c') placeCursor(view, from, true)
  return operator === 'c' ? 'insert' as const : 'handled' as const
}

function motionFor(key: string, flat: Flat, cursor: number, lineIndex: number, count: number, hasCount: boolean, operator: VimState['operator']): Motion | undefined {
  const line = flat.lines[lineIndex]!
  const lineStart = flat.offsets[lineIndex]!
  const lineEnd = lineStart + line.text.length
  const text = flat.text
  switch (key) {
    case 'h': return { kind: 'char', to: Math.max(lineStart, cursor - count) }
    case 'l': case ' ': return { kind: 'char', to: Math.min(lineEnd, cursor + count) }
    case '0': return { kind: 'char', to: lineStart }
    case '^': return { kind: 'char', to: lineStart + firstNonBlank(line) }
    case '$': {
      const last = flat.lines[Math.min(flat.lines.length - 1, lineIndex + count - 1)]!
      const index = flat.lines.indexOf(last)
      return { kind: 'char', to: flat.offsets[index]! + last.text.length }
    }
    case 'w': case 'W': {
      const big = key === 'W'
      let target = cursor
      if (operator === 'c' && charClass(text[cursor], big) !== 0) {
        // `cw` behaves like `ce`: it stops at the end of the word instead of eating the gap.
        target = charClass(text[cursor + 1], big) === charClass(text[cursor], big) ? wordEnd(text, cursor, big) : cursor
        for (let step = 1; step < count; step += 1) target = wordEnd(text, target, big)
        return { kind: 'char', to: target, inclusive: true }
      }
      for (let step = 0; step < count; step += 1) target = nextWordStart(text, target, big)
      if (operator && count === 1 && text.slice(cursor, target).includes('\n')) target = lineEnd
      return { kind: 'char', to: target }
    }
    case 'b': case 'B': {
      let target = cursor
      for (let step = 0; step < count; step += 1) target = previousWordStart(text, target, key === 'B')
      return { kind: 'char', to: target }
    }
    case 'e': case 'E': {
      let target = cursor
      for (let step = 0; step < count; step += 1) target = wordEnd(text, target, key === 'E')
      return { kind: 'char', to: target, inclusive: true }
    }
    case 'j': return { kind: 'line', line: Math.min(flat.lines.length - 1, lineIndex + count) }
    case 'k': return { kind: 'line', line: Math.max(0, lineIndex - count) }
    case 'G': return { kind: 'line', line: hasCount ? Math.min(flat.lines.length - 1, count - 1) : flat.lines.length - 1 }
    default: return undefined
  }
}

function textObject(key: string, around: boolean, flat: Flat, cursor: number, lineIndex: number): Range | undefined {
  if (key === 'p') return { kind: 'line', from: lineIndex, to: lineIndex }
  if (key === 'w' || key === 'W') {
    const line = flat.lines[lineIndex]!
    const base = flat.offsets[lineIndex]!
    const found = wordObject(line.text, cursor - base, around)
    return found ? { kind: 'char', from: base + found.from, to: base + found.to } : undefined
  }
  const found = pairObject(flat.text, cursor, key, around)
  return found ? { kind: 'char', ...found } : undefined
}

function put(view: EditorView, flat: Flat, lineIndex: number, cursor: number, before: boolean, count: number) {
  if (!register) return
  const line = flat.lines[lineIndex]!
  const { state } = view
  if (!register.linewise) {
    const text = repeat(line.code ? register.text : register.text.replaceAll('\n', ' '), count)
    const position = flatToPosition(flat, cursor)
    const insertAt = before || line.text.length === 0 ? position : Math.min(line.end, position + 1)
    const transaction = state.tr.insertText(text, insertAt)
    finish(view, transaction, insertAt + text.length - 1, false)
    return
  }
  const rows = register.text.split('\n')
  if (line.code) {
    const body = repeat(`${register.text}\n`, count).slice(0, -1)
    const transaction = before ? state.tr.insertText(`${body}\n`, line.start) : state.tr.insertText(`\n${body}`, line.end)
    finish(view, transaction, before ? line.start : line.end + 1, false)
    return
  }
  const paragraphType = state.schema.nodes.paragraph
  if (!paragraphType) return
  const $line = state.doc.resolve(line.start)
  const itemDepth = $line.depth - 1
  const item = itemDepth > 0 && $line.index(itemDepth) === 0 && ['listItem', 'taskItem'].includes($line.node(itemDepth).type.name) ? $line.node(itemDepth) : undefined
  const nodes: ReturnType<typeof paragraphType.create>[] = []
  for (let copy = 0; copy < count; copy += 1) {
    for (const row of rows) {
      const paragraph = paragraphType.create(null, row ? state.schema.text(row) : undefined)
      if (!item) nodes.push(paragraph)
      else nodes.push(item.type.create(item.type.name === 'taskItem' ? { ...item.attrs, checked: false } : item.attrs, paragraph))
    }
  }
  const insertAt = item
    ? (before ? $line.before(itemDepth) : $line.after(itemDepth))
    : (before ? line.blockFrom : line.blockTo)
  const transaction = state.tr.insert(insertAt, nodes)
  finish(view, transaction, insertAt + (item ? 2 : 1), false)
}

/**
 * Handle one normal-mode key. Returns what the host should do next; the host
 * must still `preventDefault` the keystroke (every normal-mode key is swallowed).
 */
export function runVimKey(view: EditorView, state: VimState, key: string, host: VimHost): VimOutcome {
  const flat = buildFlat(view.state.doc)
  if (!flat.lines.length) { resetState(state); return 'handled' }
  const cursor = positionToFlat(flat, view.state.selection.head)
  const lineIndex = lineIndexAt(flat.lines, view.state.selection.head)
  const line = flat.lines[lineIndex]!

  const pendingOperator = state.operator
  const hasCount = state.count !== '' || state.operatorCount !== ''
  const count = Math.min(MAX_COUNT, (state.count ? Number(state.count) : 1) * (state.operatorCount ? Number(state.operatorCount) : 1))

  // Text object after `i` / `a` (only meaningful with an operator pending).
  if (state.prefix === 'i' || state.prefix === 'a') {
    const around = state.prefix === 'a'
    const operator = state.operator
    resetState(state)
    if (!operator) return 'handled'
    const range = textObject(key, around, flat, cursor, lineIndex)
    if (!range) return 'handled'
    return applyOperator(view, flat, operator, range)
  }

  if (state.prefix === 'g') {
    const operator = state.operator
    resetState(state)
    if (key !== 'g') return 'handled'
    const target = hasCount ? Math.min(flat.lines.length - 1, count - 1) : 0
    if (operator) return applyOperator(view, flat, operator, { kind: 'line', from: Math.min(lineIndex, target), to: Math.max(lineIndex, target) })
    placeCursor(view, flat.lines[target]!.start)
    return 'handled'
  }

  if (/^[1-9]$/.test(key) || (key === '0' && (pendingOperator ? state.operatorCount : state.count) !== '')) {
    if (pendingOperator) state.operatorCount = `${state.operatorCount}${key}`.slice(0, 4)
    else state.count = `${state.count}${key}`.slice(0, 4)
    return 'handled'
  }

  if (key === 'd' || key === 'c' || key === 'y') {
    if (!pendingOperator) {
      state.operator = key
      return 'handled'
    }
    resetState(state)
    if (pendingOperator !== key) return 'handled'
    // dd / cc / yy: `count` lines starting at the cursor's line.
    return applyOperator(view, flat, key, { kind: 'line', from: lineIndex, to: Math.min(flat.lines.length - 1, lineIndex + count - 1) })
  }

  if (pendingOperator && (key === 'i' || key === 'a')) {
    state.prefix = key
    return 'handled'
  }
  if (key === 'g') {
    state.prefix = 'g'
    return 'handled'
  }

  const operator = pendingOperator
  resetState(state)

  const motion = motionFor(key, flat, cursor, lineIndex, count, hasCount, operator)
  if (motion) {
    if (operator) {
      if (motion.kind === 'line') return applyOperator(view, flat, operator, { kind: 'line', from: Math.min(lineIndex, motion.line), to: Math.max(lineIndex, motion.line) })
      const upper = Math.max(cursor, motion.to) + (motion.inclusive && motion.to >= cursor ? 1 : 0)
      return applyOperator(view, flat, operator, { kind: 'char', from: Math.min(cursor, motion.to), to: Math.min(flat.text.length, upper) })
    }
    if (motion.kind === 'char') {
      placeCursor(view, flatToPosition(flat, motion.to))
    } else if (key === 'G') {
      placeCursor(view, flat.lines[motion.line]!.start)
    } else {
      for (let step = 0; step < count; step += 1) host.moveVertical(view, key === 'k' ? -1 : 1)
    }
    return 'handled'
  }
  if (operator) return 'handled'

  switch (key) {
    case 'i': placeCursor(view, view.state.selection.head, true); return 'insert'
    case 'I': placeCursor(view, line.start, true); return 'insert'
    case 'a': placeCursor(view, Math.min(line.end, view.state.selection.head + (line.end > line.start ? 1 : 0)), true); return 'insert'
    case 'A': placeCursor(view, line.end, true); return 'insert'
    case 'o': case 'O': host.openLine(view, key === 'O' ? 'above' : 'below'); return 'insert'
    case 's': return applyOperator(view, flat, 'c', { kind: 'char', from: cursor, to: Math.min(flat.offsets[lineIndex]! + line.text.length, cursor + count) })
    case 'S': return applyOperator(view, flat, 'c', { kind: 'line', from: lineIndex, to: Math.min(flat.lines.length - 1, lineIndex + count - 1) })
    case 'x': return applyOperator(view, flat, 'd', { kind: 'char', from: cursor, to: Math.min(flat.offsets[lineIndex]! + line.text.length, cursor + count) })
    case 'X': return applyOperator(view, flat, 'd', { kind: 'char', from: Math.max(flat.offsets[lineIndex]!, cursor - count), to: cursor })
    case 'D': case 'C': {
      const last = Math.min(flat.lines.length - 1, lineIndex + count - 1)
      return applyOperator(view, flat, key === 'D' ? 'd' : 'c', { kind: 'char', from: cursor, to: flat.offsets[last]! + flat.lines[last]!.text.length })
    }
    case 'Y': return applyOperator(view, flat, 'y', { kind: 'line', from: lineIndex, to: Math.min(flat.lines.length - 1, lineIndex + count - 1) })
    case 'p': case 'P': put(view, flat, lineIndex, cursor, key === 'P', count); return 'handled'
    case 'u': return 'undo'
    case '/': return 'search'
    default: return 'handled'
  }
}

export function isVimRedo(event: { ctrlKey: boolean; key: string }) {
  return event.ctrlKey && event.key.toLocaleLowerCase() === 'r'
}
