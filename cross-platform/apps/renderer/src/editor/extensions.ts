import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Mathematics } from '@tiptap/extension-mathematics'
import Image from '@tiptap/extension-image'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdownLanguage from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import type { JSONContent } from '@tiptap/core'
import { generateHTML, generateJSON } from '@tiptap/html'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'

export type AssetLoader = (assetId: string) => Promise<Blob | undefined>
const lowlight = createLowlight()
lowlight.register({ bash, css, java, javascript, json, kotlin, markdown: markdownLanguage, python, sql, swift, typescript, xml })

function notebookImage(loadAsset?: AssetLoader) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        legacyAssetId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-asset-id'),
          renderHTML: (attributes) => attributes.legacyAssetId ? { 'data-asset-id': String(attributes.legacyAssetId) } : {},
        },
      }
    },
    addNodeView() {
      return ({ node }) => {
        const host = document.createElement('figure')
        const image = document.createElement('img')
        const placeholder = document.createElement('span')
        host.className = 'inline-image-node'
        host.contentEditable = 'false'
        image.draggable = false
        placeholder.className = 'inline-image-placeholder'
        placeholder.textContent = '图片正在载入…'
        host.append(image, placeholder)
        let objectUrl: string | undefined
        let generation = 0

        const render = (current: typeof node) => {
          generation += 1
          const currentGeneration = generation
          if (objectUrl) URL.revokeObjectURL(objectUrl)
          objectUrl = undefined
          image.removeAttribute('src')
          image.alt = String(current.attrs.alt ?? '')
          image.title = String(current.attrs.title ?? '')
          const stableSource = typeof current.attrs.src === 'string' ? current.attrs.src : ''
          const assetId = String(current.attrs.legacyAssetId ?? (stableSource.startsWith('notebook-asset:') ? stableSource.slice('notebook-asset:'.length) : ''))
          const setReady = (src: string) => {
            image.src = src
            image.hidden = false
            placeholder.hidden = true
          }
          if (assetId && loadAsset) {
            image.hidden = true
            placeholder.hidden = false
            placeholder.textContent = '图片正在载入…'
            void loadAsset(assetId).then((blob) => {
              if (currentGeneration !== generation) return
              if (!blob) { placeholder.textContent = image.alt || '图片附件尚未下载'; return }
              objectUrl = URL.createObjectURL(blob)
              setReady(objectUrl)
            }).catch(() => { if (currentGeneration === generation) placeholder.textContent = image.alt || '图片载入失败' })
          } else if (stableSource && !stableSource.startsWith('notebook-asset:')) {
            image.hidden = true
            placeholder.hidden = false
            placeholder.textContent = image.alt ? `${image.alt}（外部图片未自动加载）` : '外部图片未自动加载'
          }
          else {
            image.hidden = true
            placeholder.hidden = false
            placeholder.textContent = image.alt || '图片附件尚未下载'
          }
        }
        render(node)
        return {
          dom: host,
          update: (updated) => {
            if (updated.type !== node.type) return false
            render(updated)
            return true
          },
          destroy: () => { generation += 1; if (objectUrl) URL.revokeObjectURL(objectUrl) },
        }
      }
    },
  }).configure({ allowBase64: false, resize: { enabled: true } })
}

export function createContentExtensions(collaborative = false, loadAsset?: AssetLoader) {
  return [
    StarterKit.configure({ undoRedo: collaborative ? false : undefined, codeBlock: false }),
    CodeBlockLowlight.configure({ lowlight }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    Mathematics.configure({ katexOptions: { throwOnError: false } }),
    notebookImage(loadAsset),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
  ]
}

export function markdownToDocument(markdown: string) {
  return new MarkdownManager({ extensions: createContentExtensions() }).parse(markdown) as Record<string, unknown>
}

export function documentToMarkdown(document: Record<string, unknown>) {
  return new MarkdownManager({ extensions: createContentExtensions() }).serialize(document as JSONContent)
}

export function documentToHtml(document: Record<string, unknown>) {
  return generateHTML(document as JSONContent, createContentExtensions())
}

export function htmlToDocument(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style'],
  })
  return generateJSON(sanitized, createContentExtensions()) as Record<string, unknown>
}
