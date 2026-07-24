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
import { BlockAnchor, BlockGroup, NotebookEmbed, NotebookLink, type NotebookReferenceTarget } from '@notebook/sync-contract'
import { openReferencedTarget, resolveNotebookReference, subscribeToReferenceRuntime } from './referenceRuntime'
import { findReferencedFragment, referenceDynamicLabel } from './referenceContent'

export type AssetLoader = (assetId: string) => Promise<Blob | undefined>
const lowlight = createLowlight()
lowlight.register({ bash, css, java, javascript, json, kotlin, markdown: markdownLanguage, python, sql, swift, typescript, xml })
const SAFE_REFERENCE_URI = /^(?:(?:https?|mailto|tel|notebook-asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i

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
        let currentNode = node
        let visible = typeof IntersectionObserver === 'undefined'

        const render = () => {
          generation += 1
          const currentGeneration = generation
          if (objectUrl) URL.revokeObjectURL(objectUrl)
          objectUrl = undefined
          image.removeAttribute('src')
          image.alt = String(currentNode.attrs.alt ?? '')
          image.title = String(currentNode.attrs.title ?? '')
          if (!visible) {
            image.hidden = true
            placeholder.hidden = false
            placeholder.textContent = image.alt ? `${image.alt}（滚动到附近时载入）` : '图片将在滚动到附近时载入'
            return
          }
          const stableSource = typeof currentNode.attrs.src === 'string' ? currentNode.attrs.src : ''
          const assetId = String(currentNode.attrs.legacyAssetId ?? (stableSource.startsWith('notebook-asset:') ? stableSource.slice('notebook-asset:'.length) : ''))
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
        const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          visible = true
          observer?.disconnect()
          render()
        }, { rootMargin: '900px 0px' })
        if (observer) observer.observe(host)
        render()
        return {
          dom: host,
          update: (updated) => {
            if (updated.type !== node.type) return false
            currentNode = updated
            render()
            return true
          },
          destroy: () => { generation += 1; observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl) },
        }
      }
    },
  }).configure({ allowBase64: false, resize: { enabled: true } })
}

function targetFromAttributes(attributes: Record<string, unknown>): NotebookReferenceTarget {
  const pageId = String(attributes.pageId ?? '')
  if (attributes.targetKind === 'block') return { pageId, kind: 'block', targetId: String(attributes.targetId ?? '') }
  if (attributes.targetKind === 'group') return { pageId, kind: 'group', targetId: String(attributes.targetId ?? '') }
  return { pageId, kind: 'page' }
}

function referenceExtensions(currentPageId?: string, loadAsset?: AssetLoader) {
  const link = NotebookLink.extend({
    addNodeView() {
      return ({ node }) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'notebook-link-node'
        button.contentEditable = 'false'
        let generation = 0
        let currentNode = node
        const render = async () => {
          const currentGeneration = ++generation
          const target = targetFromAttributes(currentNode.attrs)
          const alias = typeof currentNode.attrs.alias === 'string' ? currentNode.attrs.alias.trim() : ''
          button.textContent = alias || '正在读取引用…'
          const resolved = await resolveNotebookReference(target, target.kind !== 'page')
          if (generation !== currentGeneration) return
          const fragment = resolved.document && findReferencedFragment(resolved.document, target)
          const status = resolved.status === 'ready' && target.kind !== 'page' && resolved.document && !fragment ? 'missing' : resolved.status
          button.textContent = alias || (status === 'ready'
            ? referenceDynamicLabel(resolved.document, target, resolved.title)
            : resolved.title)
          button.dataset.status = status
          button.dataset.targetKind = target.kind
          button.title = resolved.status === 'ready' ? `打开“${resolved.title}”` : resolved.title
        }
        let unsubscribe = subscribeToReferenceRuntime(String(currentNode.attrs.pageId ?? ''), () => { void render() })
        button.addEventListener('click', () => openReferencedTarget(targetFromAttributes(currentNode.attrs)))
        void render()
        return {
          dom: button,
          update: (updated) => {
            if (updated.type.name !== 'notebookLink') return false
            const previousPageId = String(currentNode.attrs.pageId ?? '')
            currentNode = updated
            const nextPageId = String(currentNode.attrs.pageId ?? '')
            if (previousPageId !== nextPageId) {
              unsubscribe()
              unsubscribe = subscribeToReferenceRuntime(nextPageId, () => { void render() })
            }
            void render()
            return true
          },
          destroy: () => { generation += 1; unsubscribe() },
        }
      }
    },
  })

  const embed = NotebookEmbed.extend({
    addNodeView() {
      return ({ node }) => {
        const host = document.createElement('article')
        const header = document.createElement('button')
        const body = document.createElement('div')
        host.className = 'notebook-embed-node'
        host.contentEditable = 'false'
        header.type = 'button'
        header.className = 'notebook-embed-header'
        body.className = 'notebook-embed-body'
        host.append(header, body)
        let generation = 0
        let currentNode = node
        let visible = typeof IntersectionObserver === 'undefined'
        const objectUrls = new Set<string>()
        const clearObjectUrls = () => {
          for (const url of objectUrls) URL.revokeObjectURL(url)
          objectUrls.clear()
        }
        const render = async () => {
          const currentGeneration = ++generation
          clearObjectUrls()
          const target = targetFromAttributes(currentNode.attrs)
          body.replaceChildren()
          if (target.pageId === currentPageId) {
            host.dataset.status = 'cycle'
            header.textContent = '循环引用'
            body.textContent = '页面不能嵌入自身。'
            return
          }
          if (!visible) {
            host.dataset.status = 'deferred'
            header.textContent = typeof currentNode.attrs.alias === 'string' && currentNode.attrs.alias.trim() ? currentNode.attrs.alias : '嵌入内容'
            body.textContent = '滚动到附近时载入引用内容。'
            return
          }
          header.textContent = '正在读取嵌入内容…'
          const resolved = await resolveNotebookReference(target, true)
          if (generation !== currentGeneration) return
          host.dataset.status = resolved.status
          header.textContent = typeof currentNode.attrs.alias === 'string' && currentNode.attrs.alias.trim() ? currentNode.attrs.alias : resolved.title
          if (resolved.status !== 'ready') {
            body.textContent = resolved.status === 'locked' ? '解锁隐私笔记后才能查看引用内容。' : '目标可能已被删除，或尚未同步到本机。'
            return
          }
          const fragment = resolved.document && findReferencedFragment(resolved.document, target)
          if (!fragment) {
            host.dataset.status = 'missing'
            body.textContent = resolved.document ? '引用的段落或内容范围已不存在。' : '目标正文尚未载入。'
            return
          }
          body.innerHTML = DOMPurify.sanitize(documentToHtml(fragment), { ALLOWED_URI_REGEXP: SAFE_REFERENCE_URI })
          body.querySelectorAll<HTMLElement>('[data-notebook-embed]').forEach((element) => {
            element.replaceChildren(document.createTextNode('嵌套引用：打开原文查看'))
          })
          body.querySelectorAll<HTMLImageElement>('img[src^="notebook-asset:"]').forEach((image) => {
            const assetId = image.getAttribute('src')!.slice('notebook-asset:'.length)
            image.removeAttribute('src')
            image.alt = image.alt || '引用图片'
            if (!loadAsset) {
              image.replaceWith(document.createTextNode(image.alt ? `【图片：${image.alt}】` : '【图片附件】'))
              return
            }
            image.dataset.loading = 'true'
            void loadAsset(assetId).then((blob) => {
              if (generation !== currentGeneration || !image.isConnected) return
              if (!blob) {
                image.replaceWith(document.createTextNode(`【图片附件尚未下载：${image.alt}】`))
                return
              }
              const url = URL.createObjectURL(blob)
              objectUrls.add(url)
              image.src = url
              delete image.dataset.loading
            }).catch(() => {
              if (generation === currentGeneration && image.isConnected) image.replaceWith(document.createTextNode(`【图片载入失败：${image.alt}】`))
            })
          })
        }
        const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          visible = true
          observer?.disconnect()
          void render()
        }, { rootMargin: '900px 0px' })
        if (observer) observer.observe(host)
        let unsubscribe = subscribeToReferenceRuntime(String(currentNode.attrs.pageId ?? ''), () => { void render() })
        header.addEventListener('click', () => openReferencedTarget(targetFromAttributes(currentNode.attrs)))
        void render()
        return {
          dom: host,
          update: (updated) => {
            if (updated.type.name !== 'notebookEmbed') return false
            const previousPageId = String(currentNode.attrs.pageId ?? '')
            currentNode = updated
            const nextPageId = String(currentNode.attrs.pageId ?? '')
            if (previousPageId !== nextPageId) {
              unsubscribe()
              unsubscribe = subscribeToReferenceRuntime(nextPageId, () => { void render() })
            }
            void render()
            return true
          },
          destroy: () => { generation += 1; clearObjectUrls(); observer?.disconnect(); unsubscribe() },
        }
      }
    },
  })
  return [BlockGroup, embed, BlockAnchor, link]
}

export function createContentExtensions(collaborative = false, loadAsset?: AssetLoader, currentPageId?: string) {
  return [
    StarterKit.configure({ undoRedo: collaborative ? false : undefined, codeBlock: false }),
    // The stock triple-enter exit rule counts the newline used to create an
    // empty fenced block, so a user's first blank line can unexpectedly leave
    // the block. ArrowDown at the end still provides an explicit way out.
    CodeBlockLowlight.configure({ lowlight, exitOnTripleEnter: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    Mathematics.configure({ katexOptions: { throwOnError: false } }),
    notebookImage(loadAsset),
    ...referenceExtensions(currentPageId, loadAsset),
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

/**
 * Keep only the structure that the Markdown document model can represent.
 * This is shared by HTML import and clipboard paste so content copied from
 * Word, browsers, mail clients, etc. cannot bring its font/theme CSS into a
 * notebook page.
 */
export function sanitizeSupportedHtml(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'font', 'center'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['data-type', 'data-checked', 'data-asset-id', 'data-pm-slice'],
  })
  const supportedAttributes = new Set([
    'href',
    'title',
    'src',
    'alt',
    'start',
    'colspan',
    'rowspan',
    'type',
    'checked',
    'data-type',
    'data-checked',
    'data-asset-id',
    // ProseMirror adds this to its own clipboard HTML so partial lists,
    // tables and block selections can be pasted without changing structure.
    'data-pm-slice',
  ])
  const container = document.createElement('div')
  container.innerHTML = sanitized
  container.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (!supportedAttributes.has(attribute.name)) element.removeAttribute(attribute.name)
    }
  })
  return container.innerHTML
}

export function htmlToDocument(html: string) {
  const sanitized = sanitizeSupportedHtml(html)
  return generateJSON(sanitized, createContentExtensions()) as Record<string, unknown>
}
