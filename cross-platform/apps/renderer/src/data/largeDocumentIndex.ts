import { Lexer } from 'marked'

export interface ReadingChunk { start: number; end: number; chapter: number; height: number; literal?: boolean }
export interface ReadingChapter { start: number; end: number; title: string; definitions: string }
export interface ReadingHeading { start: number; level: number; title: string; index: number }
export interface ReadingIndex { chunks: ReadingChunk[]; chapters: ReadingChapter[]; headings: ReadingHeading[]; definitions: string }
const CHUNK_CHARACTERS = 6_000

/** Block lexing only, in a worker: no inline parsing, rich editor tree or DOM. */
export function indexLargeMarkdown(source: string): ReadingIndex {
  const normalized = source.replace(/\r\n?/g, '\n')
  const lexer = new Lexer({ gfm: true })
  const tokens = lexer.blockTokens(normalized)
  const result: ReadingIndex = { chunks: [], chapters: [], headings: [], definitions: '' }
  let offset = 0
  let chunkStart = 0
  let chapter = 0
  let math = false
  let group = 0
  result.chapters.push({ start: 0, end: source.length, title: '开篇', definitions: '' })
  const addChunk = (end: number, literal = false) => {
    if (end <= chunkStart) return
    const raw = source.slice(chunkStart, end)
    const paragraphs = raw.split(/\n\s*\n/).length
    result.chunks.push({ start: chunkStart, end, chapter, literal, height: Math.max(100, Math.ceil(raw.length / 48) * 26 + paragraphs * 9 + 42) })
    chunkStart = end
  }
  const flushChunk = (end: number) => {
    if (end - chunkStart <= CHUNK_CHARACTERS * 4) { addChunk(end); return }
    // Even an unclosed fence/group must never create an unbounded rich view.
    for (let part = chunkStart; end - part > CHUNK_CHARACTERS;) {
      let next = part + CHUNK_CHARACTERS
      if (/[\uD800-\uDBFF]/.test(source[next - 1]!)) next--
      addChunk(next, true)
      part = next
    }
    addChunk(end, true)
  }
  for (const token of tokens) {
    const start = offset
    // Marked normalizes CRLF. Map its offsets back to the exact source, so
    // opening and editing never normalize untouched line endings.
    for (let remaining = token.raw.length; remaining > 0 && offset < source.length; remaining--) {
      if (source[offset] === '\r' && source[offset + 1] === '\n') offset++
      offset++
    }
    if (token.type === 'heading' && !math && group === 0) {
      flushChunk(start)
      const title = token.text.replace(/!?\[([^\]]+)\]\([^)]*\)|[*_`]/g, '$1').trim() || '无标题'
      if (start === 0) result.chapters[0]!.title = title
      else {
        result.chapters[chapter]!.end = start
        chapter = result.chapters.length
        result.chapters.push({ start, end: source.length, title, definitions: '' })
      }
      result.headings.push({ start, title, level: token.depth, index: result.headings.length })
    }
    if (token.type === 'def') {
      result.definitions += token.raw + '\n'
      result.chapters[chapter]!.definitions += source.slice(start, offset) + '\n'
    }
    if (token.type !== 'code') {
      for (const line of token.raw.split('\n')) {
        if (line.trim() === '$$') math = !math
        if (/^\s*<!--\s*notebook:group\s+\S+:start\b/.test(line)) group++
        if (/^\s*<!--\s*notebook:group\s+\S+:end\b/.test(line)) group = Math.max(0, group - 1)
      }
    }
    if (!math && !group && offset - chunkStart >= CHUNK_CHARACTERS) {
      // An enormous indivisible code/list/table block must not defeat the
      // viewport bound. Display that block as literal source in small slices;
      // its original Markdown is still preserved and can be edited as text.
      flushChunk(offset)
    }
  }
  flushChunk(source.length)
  return result
}

export function chunkAtOffset(index: ReadingIndex, offset: number) {
  let low = 0
  let high = index.chunks.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (index.chunks[middle]!.end <= offset) low = middle + 1
    else high = middle
  }
  return low
}
