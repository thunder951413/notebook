import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import type { JSONContent } from '@tiptap/core'

function extensions() {
  return [
    StarterKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit,
    Image.configure({ allowBase64: false }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
  ]
}

export function markdownToTiptap(markdown: string) {
  return new MarkdownManager({ extensions: extensions() }).parse(markdown) as Record<string, unknown>
}

export function tiptapToMarkdown(document: Record<string, unknown>) {
  return new MarkdownManager({ extensions: extensions() }).serialize(document as JSONContent)
}
