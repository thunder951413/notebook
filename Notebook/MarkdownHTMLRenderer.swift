import SwiftUI
import AppKit

struct MarkdownHTMLRenderer {
    let markdown: String
    let attributedContent: NSAttributedString?
    let colorScheme: ColorScheme
    let noteID: UUID
    let renderAttributedContent: Bool
    var readerFontSize: CGFloat = 17
    var readerLineHeight: CGFloat = 1.6
    var readerMaxWidth: CGFloat = 820

    /// 使用 NSRegularExpression 进行替换，支持 anchorsMatchLines 选项
    private func replaceWithRegex(_ string: String, pattern: String, replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
            return string
        }
        let range = NSRange(string.startIndex..., in: string)
        return regex.stringByReplacingMatches(in: string, options: [], range: range, withTemplate: replacement)
    }

    func generateHTML() -> String {
        let textColor = colorScheme == .dark ? "#FFFFFF" : "#000000"
        let linkColor = colorScheme == .dark ? "#4A9EFF" : "#0066CC"

        let markdownSource: String
        var attachmentBlocks: [(placeholder: String, html: String)] = []
        var inlineHTMLBlocks: [(placeholder: String, html: String)] = []
        if renderAttributedContent,
           let attributedContent,
           shouldRenderFromAttributedContent(attributedContent) {
            let conversion = attributedToMarkdownWithAttachments(attributedContent)
            markdownSource = conversion.markdown
            attachmentBlocks = conversion.blocks
            inlineHTMLBlocks = conversion.inlineBlocks
        } else {
            markdownSource = markdown
        }

        // 提取目录项用于生成锚点
        let tocItems = extractTableOfContents(from: markdownSource)
        var anchorIndex = 0

        // 先处理代码块（在转义之前），避免代码块内的内容被转义
        var html = markdownSource

        // 第一步：提取并保护代码块（包括 Mermaid）
        var codeBlocks: [(placeholder: String, language: String, content: String, isMermaid: Bool)] = []
        var codeBlockIndex = 0

        // 匹配所有代码块
        let codePattern = #"```([^\n]*)\n([\s\S]*?)```"#
        if let codeRegex = try? NSRegularExpression(pattern: codePattern, options: []) {
            let matches = codeRegex.matches(in: html, options: [], range: NSRange(html.startIndex..., in: html))

            // 从后往前处理，避免位置变化
            for match in matches.reversed() {
                guard let fullRange = Range(match.range, in: html),
                      let langRange = Range(match.range(at: 1), in: html),
                      let codeRange = Range(match.range(at: 2), in: html) else { continue }

                let lang = String(html[langRange]).trimmingCharacters(in: .whitespaces)
                let code = String(html[codeRange])
                let isMermaid = lang == "mermaid"

                // 使用不会被 HTML 转义影响的占位符格式
                let placeholder = "CODEBLOCK_\(codeBlockIndex)_END"
                codeBlocks.append((placeholder: placeholder, language: lang, content: code, isMermaid: isMermaid))
                codeBlockIndex += 1

                html.replaceSubrange(fullRange, with: placeholder)
            }
        }

        // 第二步：提取并保护行内代码，避免后续 HTML 转义破坏标签或执行用户内容
        var inlineCodeBlocks: [(placeholder: String, content: String)] = []
        var inlineCodeIndex = 0
        let inlineCodePattern = #"`([^`]+)`"#
        if let inlineCodeRegex = try? NSRegularExpression(pattern: inlineCodePattern, options: []) {
            let matches = inlineCodeRegex.matches(in: html, options: [], range: NSRange(html.startIndex..., in: html))
            for match in matches.reversed() {
                guard let fullRange = Range(match.range, in: html),
                      let codeRange = Range(match.range(at: 1), in: html) else { continue }
                let placeholder = "INLINECODE_\(inlineCodeIndex)_END"
                inlineCodeBlocks.append((placeholder: placeholder, content: String(html[codeRange])))
                inlineCodeIndex += 1
                html.replaceSubrange(fullRange, with: placeholder)
            }
        }

        // 第三步：转义 HTML 特殊字符
        html = htmlTextEscaped(html)

        // 表格处理
        html = processTables(html)

        // 标题 - 使用 NSRegularExpression 处理 anchorsMatchLines，并添加锚点
        html = replaceHeadingsWithAnchors(html, tocItems: tocItems, anchorIndex: &anchorIndex)

        // 粗体和斜体
        html = html.replacingOccurrences(of: #"\*\*\*(.+?)\*\*\*"#, with: "<strong><em>$1</em></strong>", options: .regularExpression)
        html = html.replacingOccurrences(of: #"\*\*(.+?)\*\*"#, with: "<strong>$1</strong>", options: .regularExpression)
        html = html.replacingOccurrences(of: #"\*(.+?)\*"#, with: "<em>$1</em>", options: .regularExpression)

        html = processMarkdownLinks(html, linkColor: linkColor)

        // 自动链接（纯 URL）
        html = processAutoLinks(html, linkColor: linkColor)

        // 换行
        html = html.replacingOccurrences(of: "\n", with: "<br>")

        // 第四步：恢复代码块
        for (placeholder, language, content, isMermaid) in codeBlocks {
            let replacement: String
            if isMermaid {
                replacement = "<div class=\"mermaid\">\(htmlTextEscaped(content))</div>"
            } else {
                let languageClass = sanitizedCodeLanguageClass(from: language)
                replacement = "<pre><code\(languageClass)>\(htmlTextEscaped(content))</code></pre>"
            }
            html = html.replacingOccurrences(of: placeholder, with: replacement)
        }

        for (placeholder, content) in inlineCodeBlocks {
            html = html.replacingOccurrences(of: placeholder, with: "<code>\(htmlTextEscaped(content))</code>")
        }

        // 第五步：恢复附件 HTML 块（避免被转义和自动换行污染）
        for block in attachmentBlocks {
            html = html.replacingOccurrences(of: block.placeholder, with: block.html)
        }

        for block in inlineHTMLBlocks {
            html = html.replacingOccurrences(of: block.placeholder, with: block.html)
        }

        html = wrapLazyLayoutBlocks(html)

        let scriptNonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let mermaidScripts: String
        if markdownSource.contains("```mermaid") {
            mermaidScripts = """
            <script nonce="\(scriptNonce)" src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
            <script nonce="\(scriptNonce)">
                mermaid.initialize({
                    startOnLoad: true,
                    theme: '\(colorScheme == .dark ? "dark" : "default")',
                    securityLevel: 'strict'
                });
            </script>
            """
        } else {
            mermaidScripts = ""
        }

        return """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: file: blob:; media-src data: file: blob:; style-src 'unsafe-inline'; script-src 'nonce-\(scriptNonce)' https://cdn.jsdelivr.net; connect-src 'none'">
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: \(readerFontSize)px;
                    line-height: \(readerLineHeight);
                    color: \(textColor);
                    margin: 0;
                    padding: 0 20px 36px;
                    overflow-wrap: anywhere;
                }
                .notebook-reader {
                    width: 100%;
                    max-width: \(readerMaxWidth)px;
                    margin: 0 auto;
                }
                .notebook-block {
                    content-visibility: auto;
                    contain-intrinsic-block-size: auto 72px;
                    overflow-wrap: anywhere;
                }
                .notebook-block + .notebook-block {
                    margin-top: 0.8em;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                    margin: 8px 0;
                }
                th, td {
                    border: 1px solid \(colorScheme == .dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)");
                    padding: 6px 8px;
                    text-align: left;
                }
                th {
                    background-color: \(colorScheme == .dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)");
                    font-weight: 600;
                }
                code {
                    background-color: \(colorScheme == .dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.08)");
                    padding: 2px 4px;
                    border-radius: 3px;
                    font-family: "SF Mono", Monaco, monospace;
                    font-size: 0.86em;
                }
                pre {
                    background-color: \(colorScheme == .dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)");
                    padding: 8px;
                    border-radius: 6px;
                    overflow-x: auto;
                    margin: 8px 0;
                }
                pre code {
                    background: none;
                    padding: 0;
                }
                h1, h2, h3, h4, h5, h6 {
                    margin: 12px 0 8px 0;
                    scroll-margin-top: 20px;
                    line-height: 1.25;
                }
                h1 { font-size: 1.7em; }
                h2 { font-size: 1.45em; }
                h3 { font-size: 1.25em; }
                h4 { font-size: 1.12em; }
                h5, h6 { font-size: 1em; }
                a {
                    color: \(linkColor);
                    text-decoration: none;
                }
                a:hover {
                    text-decoration: underline;
                }
                .mermaid {
                    background-color: \(colorScheme == .dark ? "#1e1e1e" : "#f5f5f5");
                    padding: 16px;
                    border-radius: 8px;
                    margin: 8px 0;
                }
                .note-image {
                    border-radius: 8px;
                    display: block;
                    margin: 8px 0;
                    object-fit: contain;
                }
                .note-image-auto {
                    max-width: 100%;
                    height: auto;
                }
                audio {
                    width: min(420px, 100%);
                    margin-top: 8px;
                }
                .audio-caption {
                    color: \(colorScheme == .dark ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.6)");
                    font-size: 0.8em;
                    margin: 4px 0 8px 0;
                }
            </style>
            \(mermaidScripts)
        </head>
        <body>
            <main class="notebook-reader">\(html)</main>
        </body>
        </html>
        """
    }

    /// Double Markdown line breaks are semantic paragraph boundaries after protected code and
    /// attachment placeholders have been restored. Wrapping those regions lets WebKit skip layout
    /// and painting for offscreen blocks while intrinsic sizes keep the scrollbar stable.
    private func wrapLazyLayoutBlocks(_ html: String) -> String {
        guard !html.isEmpty else { return "" }
        let boundaryPattern = #"(?:<br>\s*){2,}"#
        guard let regex = try? NSRegularExpression(pattern: boundaryPattern) else {
            return "<section class=\"notebook-block\">\(html)</section>"
        }
        let range = NSRange(html.startIndex..., in: html)
        let separated = regex.stringByReplacingMatches(
            in: html,
            range: range,
            withTemplate: "</section><section class=\"notebook-block\">"
        )
        return "<section class=\"notebook-block\">\(separated)</section>"
    }

    private func shouldRenderFromAttributedContent(_ attributed: NSAttributedString) -> Bool {
        guard attributed.length > 0 else { return false }

        let fullRange = NSRange(location: 0, length: attributed.length)
        var shouldUseAttributedPipeline = false

        attributed.enumerateAttributes(in: fullRange, options: []) { attrs, _, stop in
            if attrs[.attachment] != nil ||
                attrs[.notebookHeadingLevel] != nil ||
                attrs[.notebookExplicitBold] != nil ||
                attrs[.notebookExplicitItalic] != nil ||
                attrs[.notebookExplicitFontFamily] != nil ||
                attrs[.notebookExplicitFontSize] != nil ||
                attrs[.notebookExplicitForegroundColor] != nil {
                shouldUseAttributedPipeline = true
                stop.pointee = true
                return
            }

            if attrs[.link] != nil {
                shouldUseAttributedPipeline = true
                stop.pointee = true
                return
            }

            if previewForegroundColorHex(for: attrs) != nil ||
                attrs[.backgroundColor] != nil ||
                attrs[.kern] != nil ||
                attrs[.baselineOffset] != nil ||
                ((attrs[.underlineStyle] as? NSNumber)?.intValue ?? 0) != 0 ||
                ((attrs[.strikethroughStyle] as? NSNumber)?.intValue ?? 0) != 0 {
                shouldUseAttributedPipeline = true
                stop.pointee = true
                return
            }
        }

        return shouldUseAttributedPipeline
    }

    private func hasPreviewableInlineStyle(_ attributes: [NSAttributedString.Key: Any]) -> Bool {
        let editorFont = AppSettings.shared.editorFont
        if let color = previewForegroundColorHex(for: attributes), !color.isEmpty {
            return true
        }

        guard let font = attributes[.font] as? NSFont else {
            return false
        }

        let traits = NSFontManager.shared.traits(of: font)
        if traits.contains(.boldFontMask) || traits.contains(.italicFontMask) {
            return true
        }
        if abs(font.pointSize - editorFont.pointSize) > 0.5 {
            return true
        }
        if let fontFamily = font.familyName,
           fontFamily != editorFont.familyName {
            return true
        }

        return false
    }

    private func attributedToMarkdownWithAttachments(_ attributed: NSAttributedString) -> (
        markdown: String,
        blocks: [(placeholder: String, html: String)],
        inlineBlocks: [(placeholder: String, html: String)]
    ) {
        let nsText = attributed.string as NSString
        var output = ""
        var blocks: [(placeholder: String, html: String)] = []
        var inlineBlocks: [(placeholder: String, html: String)] = []
        var blockIndex = 0
        var inlineIndex = 0
        let fullRange = NSRange(location: 0, length: attributed.length)

        func appendBlock(_ html: String) {
            let placeholder = "ATTACHMENT_BLOCK_\(blockIndex)_END"
            blockIndex += 1
            blocks.append((placeholder: placeholder, html: html))
            output += "\n\(placeholder)\n"
        }

        func appendInlineHTML(_ html: String) {
            let placeholder = "INLINE_HTML_\(inlineIndex)_END"
            inlineIndex += 1
            inlineBlocks.append((placeholder: placeholder, html: html))
            output += placeholder
        }

        attributed.enumerateAttributes(in: fullRange, options: []) { attrs, range, _ in
            if let attachment = attrs[.attachment] {
                if let textAttachment = attachment as? AttachmentTextAttachment {
                    switch textAttachment.kind {
                    case .image:
                        if let imageData = textAttachment.attachmentData() {
                            let mimeType = mimeTypeForPath(path: textAttachment.attachmentFileURL.path)
                            let base64 = imageData.base64EncodedString()

                            let storedWidth = (attrs[.notebookImageWidth] as? CGFloat) ?? 0
                            let storedHeight = (attrs[.notebookImageHeight] as? CGFloat) ?? 0

                            let linkedSize: (CGFloat, CGFloat)? = {
                                let raw: String
                                if let s = attrs[.link] as? String {
                                    raw = s
                                } else if let u = attrs[.link] as? URL {
                                    raw = u.absoluteString
                                } else {
                                    return nil
                                }
                                guard raw.hasPrefix("notebook-image://") else { return nil }
                                let parts = raw.split(separator: "#", maxSplits: 1).map(String.init)
                                guard parts.count == 2 else { return nil }
                                var w: CGFloat = 0
                                var h: CGFloat = 0
                                for item in parts[1].split(separator: "&") {
                                    let kv = item.split(separator: "=", maxSplits: 1).map(String.init)
                                    guard kv.count == 2 else { continue }
                                    if kv[0] == "w" { w = CGFloat(Double(kv[1]) ?? 0) }
                                    if kv[0] == "h" { h = CGFloat(Double(kv[1]) ?? 0) }
                                }
                                return (w > 1 && h > 1) ? (w, h) : nil
                            }()

                            let resolvedW = textAttachment.bounds.width > 1 ? textAttachment.bounds.width : (storedWidth > 1 ? storedWidth : (linkedSize?.0 ?? 0))
                            let resolvedH = textAttachment.bounds.height > 1 ? textAttachment.bounds.height : (storedHeight > 1 ? storedHeight : (linkedSize?.1 ?? 0))
                            let width = Int(resolvedW.rounded())
                            let height = Int(resolvedH.rounded())
                            DebugLog.editor("note=\(noteID) AttachmentTextAttachment bounds=\(textAttachment.bounds.size) stored=\(storedWidth)x\(storedHeight) linked=\(linkedSize?.0 ?? 0)x\(linkedSize?.1 ?? 0) resolved=\(width)x\(height)", level: .debug)
                            if width > 1 && height > 1 {
                                appendBlock("<img src=\"data:\(mimeType);base64,\(base64)\" alt=\"image\" class=\"note-image\" style=\"width:\(width)px !important;height:\(height)px !important;max-width:none !important;\" />")
                            } else {
                                appendBlock("<img src=\"data:\(mimeType);base64,\(base64)\" alt=\"image\" class=\"note-image note-image-auto\" />")
                            }
                        } else {
                            DebugLog.editor("Failed to read image attachment data (all sources empty)", level: .warn)
                        }
                    case .audio:
                        if let data = textAttachment.attachmentData() {
                            let mimeType = mimeTypeForPath(path: textAttachment.attachmentFileURL.path)
                            let base64 = data.base64EncodedString()
                            let filename = textAttachment.attachmentFilename
                            appendBlock("<audio controls preload=\"metadata\" src=\"data:\(mimeType);base64,\(base64)\"></audio><div class=\"audio-caption\">\(filename)</div>")
                        } else {
                            DebugLog.editor("Failed to read audio attachment data (all sources empty)", level: .warn)
                        }
                    }
                    return
                }

                if let audioAttachment = attachment as? AudioBlockAttachment {
                    if let data = audioAttachment.audioData() {
                        let mimeType = mimeTypeForPath(path: audioAttachment.attachmentFilename)
                        let base64 = data.base64EncodedString()
                        let duration = Int(audioAttachment.duration.rounded())
                        let filename = htmlTextEscaped(audioAttachment.attachmentFilename)
                        appendBlock("<audio controls preload=\"metadata\" src=\"data:\(mimeType);base64,\(base64)\"></audio><div class=\"audio-caption\">\(filename) · \(max(1, duration))秒</div>")
                    } else {
                        DebugLog.editor("Failed to read audio attachment (all sources empty)", level: .warn)
                    }
                    return
                }

                if let nsAttachment = attachment as? NSTextAttachment {
                    if let image = nsAttachment.image,
                       let tiffData = image.tiffRepresentation,
                       let bitmap = NSBitmapImageRep(data: tiffData),
                       let pngData = bitmap.representation(using: .png, properties: [:]) {
                        let base64 = pngData.base64EncodedString()

                        let storedWidth = (attrs[.notebookImageWidth] as? CGFloat) ?? 0
                        let storedHeight = (attrs[.notebookImageHeight] as? CGFloat) ?? 0
                        let linkedSize: (CGFloat, CGFloat)? = {
                            let raw: String
                            if let s = attrs[.link] as? String {
                                raw = s
                            } else if let u = attrs[.link] as? URL {
                                raw = u.absoluteString
                            } else {
                                return nil
                            }
                            guard raw.hasPrefix("notebook-image://") else { return nil }
                            let parts = raw.split(separator: "#", maxSplits: 1).map(String.init)
                            guard parts.count == 2 else { return nil }
                            var w: CGFloat = 0
                            var h: CGFloat = 0
                            for item in parts[1].split(separator: "&") {
                                let kv = item.split(separator: "=", maxSplits: 1).map(String.init)
                                guard kv.count == 2 else { continue }
                                if kv[0] == "w" { w = CGFloat(Double(kv[1]) ?? 0) }
                                if kv[0] == "h" { h = CGFloat(Double(kv[1]) ?? 0) }
                            }
                            return (w > 1 && h > 1) ? (w, h) : nil
                        }()
                        let resolvedW = storedWidth > 1 ? storedWidth : (linkedSize?.0 ?? nsAttachment.bounds.width)
                        let resolvedH = storedHeight > 1 ? storedHeight : (linkedSize?.1 ?? nsAttachment.bounds.height)
                        let width = Int(resolvedW.rounded())
                        let height = Int(resolvedH.rounded())
                        DebugLog.editor("note=\(noteID) NSTextAttachment(image) bounds=\(nsAttachment.bounds.size) stored=\(storedWidth)x\(storedHeight) linked=\(linkedSize?.0 ?? 0)x\(linkedSize?.1 ?? 0) resolved=\(width)x\(height)", level: .debug)
                        if width > 1 && height > 1 {
                            appendBlock("<img src=\"data:image/png;base64,\(base64)\" alt=\"image\" class=\"note-image\" style=\"width:\(width)px !important;height:\(height)px !important;max-width:none !important;\" />")
                        } else {
                            appendBlock("<img src=\"data:image/png;base64,\(base64)\" alt=\"image\" class=\"note-image note-image-auto\" />")
                        }
                        return
                    }

                    if let fileWrapper = nsAttachment.fileWrapper,
                       let data = fileWrapper.regularFileContents,
                       let filename = fileWrapper.preferredFilename {
                        let mimeType = mimeTypeForPath(path: filename)
                        if mimeType.hasPrefix("image/") {
                            let base64 = data.base64EncodedString()
                            let storedWidth = (attrs[.notebookImageWidth] as? CGFloat) ?? 0
                            let storedHeight = (attrs[.notebookImageHeight] as? CGFloat) ?? 0
                            let linkedSize: (CGFloat, CGFloat)? = {
                                let raw: String
                                if let s = attrs[.link] as? String {
                                    raw = s
                                } else if let u = attrs[.link] as? URL {
                                    raw = u.absoluteString
                                } else {
                                    return nil
                                }
                                guard raw.hasPrefix("notebook-image://") else { return nil }
                                let parts = raw.split(separator: "#", maxSplits: 1).map(String.init)
                                guard parts.count == 2 else { return nil }
                                var w: CGFloat = 0
                                var h: CGFloat = 0
                                for item in parts[1].split(separator: "&") {
                                    let kv = item.split(separator: "=", maxSplits: 1).map(String.init)
                                    guard kv.count == 2 else { continue }
                                    if kv[0] == "w" { w = CGFloat(Double(kv[1]) ?? 0) }
                                    if kv[0] == "h" { h = CGFloat(Double(kv[1]) ?? 0) }
                                }
                                return (w > 1 && h > 1) ? (w, h) : nil
                            }()
                            let resolvedW = storedWidth > 1 ? storedWidth : (linkedSize?.0 ?? nsAttachment.bounds.width)
                            let resolvedH = storedHeight > 1 ? storedHeight : (linkedSize?.1 ?? nsAttachment.bounds.height)
                            let width = Int(resolvedW.rounded())
                            let height = Int(resolvedH.rounded())
                            DebugLog.editor("note=\(noteID) NSTextAttachment(fileWrapper) bounds=\(nsAttachment.bounds.size) stored=\(storedWidth)x\(storedHeight) linked=\(linkedSize?.0 ?? 0)x\(linkedSize?.1 ?? 0) resolved=\(width)x\(height)", level: .debug)
                            if width > 1 && height > 1 {
                                appendBlock("<img src=\"data:\(mimeType);base64,\(base64)\" alt=\"image\" class=\"note-image\" style=\"width:\(width)px !important;height:\(height)px !important;max-width:none !important;\" />")
                            } else {
                                appendBlock("<img src=\"data:\(mimeType);base64,\(base64)\" alt=\"image\" class=\"note-image note-image-auto\" />")
                            }
                            return
                        }

                        if mimeType.hasPrefix("audio/") {
                            let src = "data:\(mimeType);base64,\(data.base64EncodedString())"
                            let safeFilename = htmlTextEscaped(filename)
                            appendBlock("<audio controls preload=\"metadata\" src=\"\(src)\"></audio><div class=\"audio-caption\">\(safeFilename)</div>")
                            return
                        }
                    }

                    if let linkValue = attrs[.link] {
                        let url: URL?
                        if let u = linkValue as? URL {
                            url = u
                        } else if let s = linkValue as? String {
                            url = URL(string: s)
                        } else {
                            url = nil
                        }

                        if let url {
                            let mimeType = mimeTypeForPath(path: url.path)
                            if mimeType.hasPrefix("audio/") {
                                do {
                                    let data = try Data(contentsOf: url)
                                    let base64 = data.base64EncodedString()
                                    let safeFilename = htmlTextEscaped(url.lastPathComponent)
                                    appendBlock("<audio controls preload=\"metadata\" src=\"data:\(mimeType);base64,\(base64)\"></audio><div class=\"audio-caption\">\(safeFilename)</div>")
                                } catch {
                                    DebugLog.editor("Failed to read linked audio: \(error)", level: .warn)
                                }
                                return
                            }
                        }
                    }
                }

                output += "\n"
                return
            }

            let chunk = nsText.substring(with: range)
            if let inlineHTML = previewInlineHTML(for: chunk, attributes: attrs) {
                appendInlineHTML(inlineHTML)
            } else {
                output += chunk
            }
        }

        return (output, blocks, inlineBlocks)
    }

    private func previewInlineHTML(for text: String, attributes: [NSAttributedString.Key: Any]) -> String? {
        guard !text.isEmpty else { return nil }

        let linkURL: String? = {
            if let url = attributes[.link] as? URL {
                return url.absoluteString
            }
            if let raw = attributes[.link] as? String,
               raw.hasPrefix("http://") || raw.hasPrefix("https://") || raw.hasPrefix("mailto:") {
                return raw
            }
            return nil
        }()

        let style = previewInlineStyle(for: attributes)
        if style.isEmpty && linkURL == nil {
            return nil
        }

        let escapedText = htmlTextEscaped(text)
        if let linkURL {
            let safeURL = htmlAttributeEscaped(linkURL)
            let styleAttribute = style.isEmpty ? "" : " style=\"\(style)\""
            return "<a href=\"\(safeURL)\"\(styleAttribute)>\(escapedText)</a>"
        }

        return "<span style=\"\(style)\">\(escapedText)</span>"
    }

    private func previewInlineStyle(for attributes: [NSAttributedString.Key: Any]) -> String {
        var styles: [String] = []
        let font = attributes[.font] as? NSFont
        let editorFont = AppSettings.shared.editorFont
        let textDecorations = previewTextDecorations(for: attributes)

        let traits = font.map { NSFontManager.shared.traits(of: $0) } ?? []

        if attributes[.notebookExplicitBold] != nil || traits.contains(.boldFontMask) {
            styles.append("font-weight: 600")
        }
        if attributes[.notebookExplicitItalic] != nil || traits.contains(.italicFontMask) {
            styles.append("font-style: italic")
        }
        if !textDecorations.isEmpty {
            styles.append("text-decoration: \(textDecorations.joined(separator: " "))")
        }
        if let color = previewForegroundColorHex(for: attributes) {
            styles.append("color: \(color)")
        }
        if let color = (attributes[.backgroundColor] as? NSColor).flatMap(previewColorHex) {
            styles.append("background-color: \(color)")
        }
        if let font,
           attributes[.notebookExplicitFontSize] != nil ||
            attributes[.notebookHeadingLevel] != nil ||
            abs(font.pointSize - editorFont.pointSize) > 0.5 {
            styles.append("font-size: \(Int(font.pointSize.rounded()))px")
            styles.append("line-height: 1.45")
        }
        if let fontFamily = font?.familyName,
           (attributes[.notebookExplicitFontFamily] != nil || fontFamily != editorFont.familyName) &&
            fontFamily != editorFont.familyName {
            styles.append("font-family: '\(htmlAttributeEscaped(fontFamily))'")
        }
        if let kern = (attributes[.kern] as? NSNumber)?.doubleValue,
           abs(kern) > 0.001 {
            styles.append("letter-spacing: \(kern)px")
        }
        if let baselineOffset = (attributes[.baselineOffset] as? NSNumber)?.doubleValue,
           abs(baselineOffset) > 0.001 {
            styles.append("position: relative")
            styles.append("top: \(-baselineOffset)px")
        }

        if !styles.isEmpty {
            styles.insert("white-space: pre-wrap", at: 0)
        }

        return styles.joined(separator: "; ")
    }

    private func previewTextDecorations(for attributes: [NSAttributedString.Key: Any]) -> [String] {
        var decorations: [String] = []
        if ((attributes[.underlineStyle] as? NSNumber)?.intValue ?? 0) != 0 {
            decorations.append("underline")
        }
        if ((attributes[.strikethroughStyle] as? NSNumber)?.intValue ?? 0) != 0 {
            decorations.append("line-through")
        }
        return decorations
    }

    /// 处理 Mermaid 代码块
    private func processMermaidBlocks(_ html: String) -> String {
        let pattern = #"```mermaid\n([\s\S]*?)```"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return html
        }

        let range = NSRange(html.startIndex..., in: html)
        return regex.stringByReplacingMatches(
            in: html,
            options: [],
            range: range,
            withTemplate: "<div class=\"mermaid\">$1</div>"
        )
    }

    /// 处理普通代码块（排除 Mermaid）
    private func processCodeBlocks(_ html: String) -> String {
        // 匹配 ``` 开头的代码块，但排除已经处理的 mermaid div
        let pattern = #"```([^\n]*)\n([\s\S]*?)```"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return html
        }

        let matches = regex.matches(in: html, options: [], range: NSRange(html.startIndex..., in: html))

        var result = html
        // 从后往前替换，避免位置变化
        for match in matches.reversed() {
            guard let fullRange = Range(match.range, in: result),
                  let langRange = Range(match.range(at: 1), in: result),
                  let codeRange = Range(match.range(at: 2), in: result) else { continue }

            let lang = String(result[langRange])
            let code = String(result[codeRange])

            // 跳过 mermaid（已经处理过了）
            if lang.trimmingCharacters(in: .whitespaces) == "mermaid" {
                continue
            }

            let replacement = "<pre><code>\(code)</code></pre>"
            result.replaceSubrange(fullRange, with: replacement)
        }

        return result
    }

    /// 处理自动链接（纯 URL）
    private func processAutoLinks(_ html: String, linkColor: String) -> String {
        let pattern = #"(?<![\"\'>])(https?://[^\s\<\>\"\']+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return html
        }

        var result = html
        let matches = regex.matches(in: html, options: [], range: NSRange(html.startIndex..., in: html))
        for match in matches.reversed() {
            guard let fullRange = Range(match.range(at: 1), in: result) else { continue }
            let rawURL = String(result[fullRange])
            let escapedText = htmlTextEscaped(rawURL)
            let replacement: String
            if let safeHref = safeExternalHref(rawURL) {
                replacement = "<a href=\"\(safeHref)\" target=\"_blank\" style=\"color: \(linkColor); text-decoration: none;\">\(escapedText)</a>"
            } else {
                replacement = escapedText
            }
            result.replaceSubrange(fullRange, with: replacement)
        }
        return result
    }

    private func processMarkdownLinks(_ html: String, linkColor: String) -> String {
        let pattern = #"\[([^\]]+)\]\s*\(([^\)]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else {
            return html
        }

        var result = html
        let matches = regex.matches(in: html, options: [], range: NSRange(html.startIndex..., in: html))
        for match in matches.reversed() {
            guard let fullRange = Range(match.range, in: result),
                  let textRange = Range(match.range(at: 1), in: result),
                  let urlRange = Range(match.range(at: 2), in: result) else { continue }

            let text = String(result[textRange])
            let url = String(result[urlRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            let escapedText = htmlTextEscaped(text)
            let replacement: String
            if let safeHref = safeExternalHref(url) {
                replacement = "<a href=\"\(safeHref)\" target=\"_blank\" style=\"color: \(linkColor); text-decoration: none;\">\(escapedText)</a>"
            } else {
                replacement = escapedText
            }
            result.replaceSubrange(fullRange, with: replacement)
        }
        return result
    }

    private func safeExternalHref(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed),
              let url = URL(string: encoded),
              let scheme = url.scheme?.lowercased() else {
            return nil
        }
        let allowedSchemes: Set<String> = ["http", "https", "mailto"]
        guard allowedSchemes.contains(scheme) else { return nil }
        return htmlAttributeEscaped(trimmed)
    }

    private func htmlTextEscaped(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private func htmlAttributeEscaped(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }


    private func sanitizedCodeLanguageClass(from rawLanguage: String) -> String {
        let language = rawLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !language.isEmpty else { return "" }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-")
        guard language.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return "" }
        return " class=\"language-\(htmlAttributeEscaped(language))\""
    }

    private func previewForegroundColorHex(for attributes: [NSAttributedString.Key: Any]) -> String? {
        guard let color = attributes[.foregroundColor] as? NSColor else { return nil }
        if RichTextEditor.isLegacyDefaultTextColor(color, for: colorScheme) {
            return nil
        }
        if color.isEqual(to: NSColor.textColor) {
            return nil
        }
        return previewColorHex(color)
    }

    private func previewColorHex(_ color: NSColor) -> String? {
        guard let rgbColor = color.usingColorSpace(.sRGB) else { return nil }
        let red = Int(round(rgbColor.redComponent * 255))
        let green = Int(round(rgbColor.greenComponent * 255))
        let blue = Int(round(rgbColor.blueComponent * 255))
        let alpha = rgbColor.alphaComponent
        if abs(alpha - 1) < 0.001 {
            return String(format: "#%02X%02X%02X", red, green, blue)
        }
        let alphaInt = Int(round(alpha * 255))
        return String(format: "#%02X%02X%02X%02X", red, green, blue, alphaInt)
    }

    private func replaceHeadingsWithAnchors(_ html: String, tocItems: [TableOfContentsItem], anchorIndex: inout Int) -> String {
        let headingPattern = #"^(#{1,6})\s+(.+)$"#
        guard let regex = try? NSRegularExpression(pattern: headingPattern, options: [.anchorsMatchLines]) else {
            return html
        }

        let lines = html.components(separatedBy: .newlines)
        var modifiedLines: [String] = []

        for line in lines {
            let range = NSRange(line.startIndex..., in: line)
            if let match = regex.firstMatch(in: line, options: [], range: range),
               anchorIndex < tocItems.count {
                let levelRange = match.range(at: 1)
                let titleRange = match.range(at: 2)

                if let levelSwiftRange = Range(levelRange, in: line),
                   let titleSwiftRange = Range(titleRange, in: line) {
                    let level = line[levelSwiftRange].count
                    let title = String(line[titleSwiftRange])
                    let anchor = htmlAttributeEscaped(tocItems[anchorIndex].anchor)
                    anchorIndex += 1

                    let headingTag = "h\(level)"
                    modifiedLines.append("<\(headingTag) id=\"\(anchor)\">\(title)</\(headingTag)>")
                    continue
                }
            }
            modifiedLines.append(line)
        }

        return modifiedLines.joined(separator: "\n")
    }
    
    private func processTables(_ html: String) -> String {
        var result = html
        let tablePattern = #"(\|[^\n]+\|\n\|[-:\| ]+\|\n(?:\|[^\n]+\|\n?)+)"#
        
        if let regex = try? NSRegularExpression(pattern: tablePattern, options: []) {
            let matches = regex.matches(in: html, options: [], range: NSRange(html.startIndex..., in: html))
            
            for match in matches.reversed() {
                guard let range = Range(match.range, in: html) else { continue }
                let tableText = String(html[range])
                let tableHTML = convertTableToHTML(tableText)
                result.replaceSubrange(range, with: tableHTML)
            }
        }
        
        return result
    }
    
    private func mimeTypeForPath(path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg":
            return "image/jpeg"
        case "png":
            return "image/png"
        case "gif":
            return "image/gif"
        case "webp":
            return "image/webp"
        case "heic":
            return "image/heic"
        case "m4a":
            return "audio/mp4"
        case "mp3":
            return "audio/mpeg"
        case "wav":
            return "audio/wav"
        case "aiff":
            return "audio/aiff"
        case "caf":
            return "audio/x-caf"
        default:
            return "application/octet-stream"
        }
    }

    private func convertTableToHTML(_ tableText: String) -> String {
        let lines = tableText.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n")
        guard lines.count >= 2 else { return tableText }
        
        var html = "<table>"
        
        let headerLine = String(lines[0])
        let headers = headerLine.split(separator: "|").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        html += "<thead><tr>"
        for header in headers {
            html += "<th>\(htmlTextEscaped(header))</th>"
        }
        html += "</tr></thead>"
        
        html += "<tbody>"
        for i in 2..<lines.count {
            let line = String(lines[i])
            let cells = line.split(separator: "|").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            html += "<tr>"
            for cell in cells {
                html += "<td>\(htmlTextEscaped(cell))</td>"
            }
            html += "</tr>"
        }
        html += "</tbody></table>"
        
        return html
    }
}
