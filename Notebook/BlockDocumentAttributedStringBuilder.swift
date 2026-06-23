import SwiftUI
import SwiftData

/// 调试开关
let isCheckboxDebugEnabled = false

/// 字体缓存，减少每次 build 过程中对 NSFontManager.shared.convert 的频繁调用。
/// 使用 class 以便在 `BlockDocumentAttributedStringBuilder`（struct）中通过引用语义复用。
private final class FontCache {
    private var cache: [String: NSFont] = [:]

    private static func key(family: String?, size: CGFloat, bold: Bool, italic: Bool) -> String {
        "\(family ?? "system")_\(size)_\(bold)_\(italic)"
    }

    func resolvedFont(family: String?, size: CGFloat, bold: Bool, italic: Bool) -> NSFont {
        let k = Self.key(family: family, size: size, bold: bold, italic: italic)
        if let cached = cache[k] {
            return cached
        }
        let baseFont = family.flatMap { NSFont(name: $0, size: size) } ?? NSFont.systemFont(ofSize: size)

        var traits: NSFontTraitMask = []
        if bold { traits.insert(.boldFontMask) }
        if italic { traits.insert(.italicFontMask) }

        let font = traits.isEmpty ? baseFont : NSFontManager.shared.convert(baseFont, toHaveTrait: traits)
        cache[k] = font
        return font
    }
}

struct BlockDocumentAttributedStringBuilder {
    private let attachmentsRoot: URL?
    private let decoder = JSONDecoder()
    /// 单次 build 调用内的字体缓存，避免对每个 span 都走一遍 NSFontManager.shared.convert（线程锁）
    private let fontCache = FontCache()
    /// 跳过旧版复选框图片块的像素检测（已迁移过的笔记直接走元数据）。
    /// 通过初始化参数注入，由调用方根据 BlockDocumentNoteEntity.hasLegacyCheckboxMigrated 决定。
    private let skipLegacyCheckboxHeuristic: Bool

    init(attachmentsRoot: URL?, skipLegacyCheckboxHeuristic: Bool = false) {
        self.attachmentsRoot = attachmentsRoot
        self.skipLegacyCheckboxHeuristic = skipLegacyCheckboxHeuristic
    }

    func build(
        blocks: [BlockDocumentBlockEntity],
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        var index = 0
        var emittedBlockCount = 0

        while index < blocks.count {
            if emittedBlockCount > 0 {
                result.append(NSAttributedString(string: "\n"))
            }

            if !skipLegacyCheckboxHeuristic,
               let recoveredTodo = recoveredLegacyTodoBlock(
                at: index,
                blocks: blocks,
                assetsByID: assetsByID
            ) {
                result.append(recoveredTodo)
                index += 2
            } else {
                result.append(attributedBlock(for: blocks[index], assetsByID: assetsByID))
                index += 1
            }
            emittedBlockCount += 1
        }

        return result
    }

    private func attributedBlock(
        for block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        switch block.kind {
        case "heading":
            return headingBlock(for: block)
        case "list_item":
            return listItemBlock(for: block)
        case "todo_item":
            return todoItemBlock(for: block)
        case "image":
            return imageBlock(for: block, assetsByID: assetsByID)
        case "audio":
            return audioBlock(for: block, assetsByID: assetsByID)
        case "table":
            return tableBlock(for: block)
        default:
            let content = inlineAttributedText(from: block.textPayload)
            return content.length == 0 ? NSAttributedString(string: "") : content
        }
    }

    private func headingBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        let content = NSMutableAttributedString(attributedString: inlineAttributedText(from: block.textPayload))
        let fontSize = headingFontSize(level: block.level ?? 1)
        let range = NSRange(location: 0, length: content.length)
        if range.length > 0 {
            content.enumerateAttributes(in: range) { attributes, subrange, _ in
                let font = resolvedFont(
                    family: fontFamily(from: attributes[.font]),
                    size: fontSize,
                    bold: true,
                    italic: isItalicFont(attributes[.font] as? NSFont)
                )
                content.addAttribute(.font, value: font, range: subrange)
            }
            content.addAttribute(.notebookHeadingLevel, value: block.level ?? 1, range: range)
        }
        return content
    }

    private func listItemBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        let result = NSMutableAttributedString(string: indentationPrefix(level: block.indent))
        result.append(NSAttributedString(string: listMarker(for: block)))
        result.append(sanitizedListInlineText(from: block.textPayload))
        return result
    }

    private func todoItemBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        let result = NSMutableAttributedString(string: indentationPrefix(level: block.indent))
        let attachment = CheckboxTextAttachment(checked: block.checked ?? false)
        result.append(NSAttributedString(attachment: attachment))
        result.append(NSAttributedString(string: " "))
        result.append(sanitizedTodoInlineText(from: block.textPayload))
        return result
    }

    private func recoveredLegacyTodoBlock(
        at index: Int,
        blocks: [BlockDocumentBlockEntity],
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString? {
        guard index + 1 < blocks.count else { return nil }
        let imageBlock = blocks[index]
        let textBlock = blocks[index + 1]
        guard imageBlock.kind == "image", textBlock.kind == "paragraph" else { return nil }
        guard isLikelyLegacyCheckboxImageBlock(imageBlock, assetsByID: assetsByID) else { return nil }

        let checked = recoveredLegacyCheckboxState(from: imageBlock, assetsByID: assetsByID) ?? false
        let result = NSMutableAttributedString(string: indentationPrefix(level: textBlock.indent))
        result.append(NSAttributedString(attachment: CheckboxTextAttachment(checked: checked)))
        result.append(NSAttributedString(string: " "))
        result.append(sanitizedTodoInlineText(from: textBlock.textPayload))
        return result
    }

    private func isLikelyLegacyCheckboxImageBlock(
        _ block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> Bool {
        guard let asset = block.assetID.flatMap({ assetsByID[$0] }) else { return false }
        guard asset.kind == "image" else { return false }
        let size = resolvedLegacyAssetImageSize(asset)
        guard size.width > 0, size.height > 0 else { return false }
        let width = size.width
        let height = size.height
        guard width >= 10, height >= 10, width <= 36, height <= 36 else { return false }

        let minEdge = min(width, height)
        let maxEdge = max(width, height)
        return minEdge > 0 && (maxEdge / minEdge) <= 1.25
    }

    private func recoveredLegacyCheckboxState(
        from block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> Bool? {
        guard
            let asset = block.assetID.flatMap({ assetsByID[$0] }),
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path),
            let image = NSImage(contentsOf: fileURL)
        else {
            return nil
        }

        let attachment = NSTextAttachment()
        attachment.image = image
        return CheckboxTextAttachment.inferCheckedState(from: attachment)
    }

    private func resolvedLegacyAssetImageSize(_ asset: BlockDocumentAssetEntity) -> CGSize {
        if let width = asset.width, let height = asset.height, width > 0, height > 0 {
            return CGSize(width: width, height: height)
        }
        guard
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path),
            let image = NSImage(contentsOf: fileURL)
        else {
            return .zero
        }
        return image.size
    }

    private func imageBlock(
        for block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        guard
            let asset = block.assetID.flatMap({ assetsByID[$0] }),
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path)
        else {
            return NSAttributedString(string: "[图片]")
        }

        let attachment = AttachmentTextAttachment(fileURL: fileURL, kind: .image)
        let width = CGFloat(asset.width ?? 0)
        let height = CGFloat(asset.height ?? 0)
        if width > 1, height > 1 {
            attachment.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        }

        let result = NSMutableAttributedString(attachment: attachment)
        let range = NSRange(location: 0, length: result.length)
        if width > 1, height > 1 {
            result.addAttribute(.notebookImageWidth, value: width, range: range)
            result.addAttribute(.notebookImageHeight, value: height, range: range)
            let link = "notebook-image://\(fileURL.absoluteString)#w=\(Int(width.rounded()))&h=\(Int(height.rounded()))"
            result.addAttribute(.link, value: link, range: range)
        }
        return result
    }

    private func audioBlock(
        for block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        guard
            let asset = block.assetID.flatMap({ assetsByID[$0] }),
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path)
        else {
            return NSAttributedString(string: "[音频]")
        }

        let attachment = AudioBlockAttachment(
            fileURL: fileURL,
            duration: asset.duration ?? 0,
            createDate: asset.createdAt ?? Date()
        )
        let result = NSMutableAttributedString(attachment: attachment)
        result.addAttribute(.link, value: fileURL, range: NSRange(location: 0, length: result.length))
        return result
    }

    private func tableBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        guard
            let payloadData = block.tablePayload,
            let payload = try? decoder.decode(BlockDocumentTablePayload.self, from: payloadData)
        else {
            return NSAttributedString(string: "[表格]")
        }

        let rowCount = max(1, payload.rows.count)
        let columnCount = max(1, payload.rows.first?.count ?? 1)
        var tableData = TableData(rows: rowCount, columns: columnCount)
        if !payload.rows.isEmpty {
            tableData.rows = payload.rows
        }
        if payload.columnWidths.count == columnCount {
            tableData.columnWidths = payload.columnWidths.map { CGFloat($0) }
        }
        if payload.rowHeights.count == rowCount {
            tableData.rowHeights = payload.rowHeights.map { CGFloat($0) }
        }

        let attachment = TableTextAttachment(rows: rowCount, columns: columnCount)
        attachment.tableData = tableData
        attachment.updateImage()
        let result = NSMutableAttributedString(attachment: attachment)
        if let encoded = try? JSONEncoder().encode(tableData) {
            result.addAttribute(.notebookTableData, value: encoded, range: NSRange(location: 0, length: result.length))
        }
        return result
    }

    private func inlineAttributedText(from payload: Data?) -> NSAttributedString {
        guard
            let payload,
            let spans = try? decoder.decode([BlockDocumentTextSpanPayload].self, from: payload)
        else {
            return NSAttributedString(string: "")
        }

        // 批量构造：一次性拼接所有文本并应用属性，避免对每个 span 创建独立 NSAttributedString 再 append
        let fullText = spans.map(\.text).joined()
        let result = NSMutableAttributedString(string: fullText)
        var cursor = 0
        for span in spans {
            let length = (span.text as NSString).length
            guard length > 0 else { continue }
            let range = NSRange(location: cursor, length: length)
            result.addAttributes(attributes(for: span), range: range)
            cursor += length
        }
        return result
    }

    private func sanitizedTodoInlineText(from payload: Data?) -> NSAttributedString {
        let text = NSMutableAttributedString(attributedString: inlineAttributedText(from: payload))
        guard text.length > 0 else { return text }

        while text.length > 0 {
            let char = (text.string as NSString).character(at: 0)
            if char == 32 || char == 9 || char == 10 || char == 13 || char == 0x2028 || char == 0x2029 {
                text.deleteCharacters(in: NSRange(location: 0, length: 1))
                continue
            }
            break
        }

        return text
    }

    private func sanitizedListInlineText(from payload: Data?) -> NSAttributedString {
        let text = NSMutableAttributedString(attributedString: inlineAttributedText(from: payload))
        guard text.length > 0 else { return text }

        while text.length > 0 {
            let char = (text.string as NSString).character(at: 0)
            if char == 10 || char == 13 || char == 0x2028 || char == 0x2029 {
                text.deleteCharacters(in: NSRange(location: 0, length: 1))
                continue
            }
            break
        }

        return text
    }

    private func attributes(for span: BlockDocumentTextSpanPayload) -> [NSAttributedString.Key: Any] {
        var attributes: [NSAttributedString.Key: Any] = [:]
        let fontSize = CGFloat(span.fontSize ?? 16)
        attributes[.font] = resolvedFont(
            family: span.fontFamily,
            size: fontSize,
            bold: span.bold,
            italic: span.italic
        )
        if span.underline {
            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        if span.strikethrough {
            attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        if let color = nsColor(from: span.textColor) {
            attributes[.foregroundColor] = color
        }
        if let color = nsColor(from: span.backgroundColor) {
            attributes[.backgroundColor] = color
        }
        if let link = span.link, !link.isEmpty {
            attributes[.link] = URL(string: link) ?? link
        }
        if let kern = span.kern {
            attributes[.kern] = kern
        }
        if let baselineOffset = span.baselineOffset {
            attributes[.baselineOffset] = baselineOffset
        }
        if let paragraphStyle = nsParagraphStyle(from: span.paragraphStyle) {
            attributes[.paragraphStyle] = paragraphStyle
        }
        return attributes
    }

    private func resolvedFont(
        family: String?,
        size: CGFloat,
        bold: Bool,
        italic: Bool
    ) -> NSFont {
        fontCache.resolvedFont(family: family, size: size, bold: bold, italic: italic)
    }

    private func fontFamily(from value: Any?) -> String? {
        (value as? NSFont)?.familyName
    }

    private func isItalicFont(_ font: NSFont?) -> Bool {
        guard let font else { return false }
        return NSFontManager.shared.traits(of: font).contains(.italicFontMask)
    }

    private func headingFontSize(level: Int) -> CGFloat {
        switch max(1, min(level, 6)) {
        case 1: return 22
        case 2: return 18
        case 3: return 16
        case 4: return 15
        case 5: return 14
        default: return 13
        }
    }

    private func nsParagraphStyle(from payload: BlockDocumentParagraphStylePayload?) -> NSParagraphStyle? {
        guard let payload else { return nil }
        let style = NSMutableParagraphStyle()
        if let alignment = payload.alignment,
           let textAlignment = NSTextAlignment(rawValue: alignment) {
            style.alignment = textAlignment
        }
        if let lineSpacing = payload.lineSpacing {
            style.lineSpacing = lineSpacing
        }
        if let paragraphSpacing = payload.paragraphSpacing {
            style.paragraphSpacing = paragraphSpacing
        }
        if let paragraphSpacingBefore = payload.paragraphSpacingBefore {
            style.paragraphSpacingBefore = paragraphSpacingBefore
        }
        if let firstLineHeadIndent = payload.firstLineHeadIndent {
            style.firstLineHeadIndent = firstLineHeadIndent
        }
        if let headIndent = payload.headIndent {
            style.headIndent = headIndent
        }
        if let tailIndent = payload.tailIndent {
            style.tailIndent = tailIndent
        }
        return style
    }

    private func indentationPrefix(level: Int?) -> String {
        String(repeating: "    ", count: max(0, level ?? 0))
    }

    private func listMarker(for block: BlockDocumentBlockEntity) -> String {
        switch block.listStyle {
        case "ordered":
            return "\(block.order ?? 1). "
        case "dash":
            return "- "
        default:
            return "• "
        }
    }

    private func assetFileURL(for asset: BlockDocumentAssetEntity) -> URL? {
        attachmentsRoot?.appendingPathComponent(asset.relativeFilePath)
    }

    private func nsColor(from hex: String?) -> NSColor? {
        guard let hex else { return nil }
        let raw = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard raw.count == 6 || raw.count == 8 else { return nil }

        var value: UInt64 = 0
        guard Scanner(string: raw).scanHexInt64(&value) else { return nil }

        if raw.count == 6 {
            return NSColor(
                red: CGFloat((value & 0xFF0000) >> 16) / 255,
                green: CGFloat((value & 0x00FF00) >> 8) / 255,
                blue: CGFloat(value & 0x0000FF) / 255,
                alpha: 1
            )
        }

        return NSColor(
            red: CGFloat((value & 0xFF000000) >> 24) / 255,
            green: CGFloat((value & 0x00FF0000) >> 16) / 255,
            blue: CGFloat((value & 0x0000FF00) >> 8) / 255,
            alpha: CGFloat(value & 0x000000FF) / 255
        )
    }
}
