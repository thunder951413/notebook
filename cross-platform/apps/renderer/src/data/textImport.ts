/**
 * Turning loose Markdown, plain-text and HTML files into notes.
 *
 * Pure helpers (no storage access) so the rules are shared by every import
 * entry point and easy to test.
 */

export const TEXT_IMPORT_PATTERN = /\.(md|markdown|txt|text|html?)$/i
export const TEXT_IMPORT_ACCEPT = '.md,.markdown,.txt,.text,.html,.htm'
/** Larger files are almost certainly not notes (logs, dumps). */
export const TEXT_IMPORT_MAX_BYTES = 5 * 1024 * 1024

export type TextImportKind = 'markdown' | 'text' | 'html'

export interface TextImportSkip {
  name: string
  reason: string
}

export function textImportKind(name: string): TextImportKind | undefined {
  const match = TEXT_IMPORT_PATTERN.exec(name)
  if (!match) return undefined
  const extension = match[1]!.toLowerCase()
  if (extension === 'txt' || extension === 'text') return 'text'
  if (extension.startsWith('htm')) return 'html'
  return 'markdown'
}

/**
 * UTF-8 first (with or without BOM, also UTF-16 with BOM); files written by
 * older Chinese Windows tools are often GB18030/GBK, which is the fallback.
 */
export function decodeImportedText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2))
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(data)
    } catch {
      return new TextDecoder('utf-8').decode(data)
    }
  }
}

/** The file name without folders or the extension; never empty. */
export function importedTitle(name: string, source: string, kind: TextImportKind): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const fromName = base.replace(TEXT_IMPORT_PATTERN, '').trim()
  if (fromName && !/^(untitled|新建文本文档|未命名)/i.test(fromName)) return fromName
  if (kind === 'html') {
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(source)?.[1]?.trim()
    if (title) return title
  }
  const firstLine = source.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean)
  return (firstLine ?? fromName).slice(0, 80) || '导入的笔记'
}

/**
 * Plain text keeps its line breaks and is never interpreted as Markdown:
 * characters with Markdown meaning at the start of a line are escaped, and
 * single newlines become hard breaks.
 */
export function plainTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph
      .split('\n')
      .map((line) => line
        .replace(/[\\`*_[\]<>]/g, (character) => `\\${character}`)
        .replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, '$1\\$2$3'))
      .join('  \n'))
    .join('\n\n')
    .trim()
}

/** Removes a leading "# Title" when it only repeats the note title. */
export function stripRepeatedTitle(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*#*\s*(\n|$)/.exec(markdown)
  if (match && match[1]!.trim() === title.trim()) return markdown.slice(match[0].length).replace(/^\n+/, '')
  return markdown
}

export function importSummary(imported: number, skipped: TextImportSkip[]): string {
  if (!skipped.length) return `已导入 ${imported} 篇笔记`
  const reasons = skipped.slice(0, 3).map((item) => `${item.name}（${item.reason}）`).join('、')
  return `已导入 ${imported} 篇笔记，跳过 ${skipped.length} 个文件：${reasons}${skipped.length > 3 ? ' 等' : ''}`
}
