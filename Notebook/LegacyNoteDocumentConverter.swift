import Foundation
import AppKit

struct LegacyDocumentConversion {
    let document: MigratedDocument
    let assetCount: Int
}

struct LegacyNoteDocumentConverter {
    private let noteID: UUID
    private let noteDirectory: URL
    private let assetsDirectory: URL
    private let fileManager = FileManager.default
    private var blockIndex = 0
    private var assetIndex = 0

    init(noteID: UUID, noteDirectory: URL) throws {
        self.noteID = noteID
        self.noteDirectory = noteDirectory
        self.assetsDirectory = noteDirectory.appendingPathComponent("Assets", isDirectory: true)
        try fileManager.createDirectory(at: assetsDirectory, withIntermediateDirectories: true)
    }

    mutating func convert(content: NSAttributedString) throws -> LegacyDocumentConversion {
        let document = try buildDocument(from: content)
        return LegacyDocumentConversion(document: document, assetCount: assetIndex)
    }

    private mutating func buildDocument(from content: NSAttributedString) throws -> MigratedDocument {
        let nsString = content.string as NSString
        var blocks: [MigratedDocumentBlock] = []
        var location = 0

        while location < nsString.length {
            let paragraphRange = paragraphRangeForLegacyConversion(startingAt: location, in: content)
            blocks.append(contentsOf: try convertParagraph(content, range: paragraphRange))
            let nextLocation = NSMaxRange(paragraphRange)
            if nextLocation <= location {
                break
            }
            location = nextLocation
        }

        if nsString.length == 0 {
            blocks.append(MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: 0, asset: nil, table: nil))
        }

        return MigratedDocument(schemaVersion: "1.0", source: "NotebookRTFD", blocks: blocks)
    }

    private func paragraphRangeForLegacyConversion(startingAt location: Int, in content: NSAttributedString) -> NSRange {
        let nsString = content.string as NSString
        let length = nsString.length
        guard location < length else {
            return NSRange(location: location, length: 0)
        }

        var range = nextParagraphRange(startingAt: location, in: nsString)
        while shouldMergeNextLegacyContinuation(for: range, in: content) {
            let nextLocation = NSMaxRange(range)
            guard nextLocation < length else { break }
            let nextRange = nextParagraphRange(startingAt: nextLocation, in: nsString)
            guard trimmedVisibleRange(nextRange, in: nsString).length > 0 else {
                break
            }
            range = NSRange(location: location, length: NSMaxRange(nextRange) - location)
        }

        return range
    }

    private func nextParagraphRange(startingAt location: Int, in nsString: NSString) -> NSRange {
        let length = nsString.length
        guard location < length else {
            return NSRange(location: location, length: 0)
        }

        var end = location
        while end < length {
            let scalar = nsString.character(at: end)
            if scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029 {
                end += 1
                if scalar == 13, end < length, nsString.character(at: end) == 10 {
                    end += 1
                }
                break
            }
            end += 1
        }

        return NSRange(location: location, length: end - location)
    }

    private func shouldMergeNextLegacyContinuation(for range: NSRange, in content: NSAttributedString) -> Bool {
        let nsString = content.string as NSString
        let current = trimmedVisibleRange(range, in: nsString)
        guard current.length > 0 else { return false }

        return isLegacyCheckboxContinuationMarker(current, in: content)
            || isLegacyListContinuationMarker(current, in: nsString)
    }

    private func isLegacyCheckboxContinuationMarker(_ range: NSRange, in content: NSAttributedString) -> Bool {
        let nsString = content.string as NSString
        var cursor = range.location
        let end = NSMaxRange(range)

        while cursor < end, isLegacyContinuationWhitespace(nsString.character(at: cursor)) {
            cursor += 1
        }

        guard cursor < end else { return false }
        guard let attachment = content.attribute(.attachment, at: cursor, effectiveRange: nil) as? NSTextAttachment else {
            return false
        }

        let isCheckboxAttachment =
            attachment is CheckboxTextAttachment
            || CheckboxTextAttachment.looksLikeCheckbox(attachment)
            || probableLegacyCheckboxAttachment(attachment)
        guard isCheckboxAttachment else { return false }

        cursor += 1
        while cursor < end {
            guard isLegacyContinuationWhitespace(nsString.character(at: cursor)) else {
                return false
            }
            cursor += 1
        }

        return true
    }

    private func isLegacyListContinuationMarker(_ range: NSRange, in nsString: NSString) -> Bool {
        var cursor = range.location
        let end = NSMaxRange(range)

        while cursor < end {
            let scalar = nsString.character(at: cursor)
            if scalar == 32 || scalar == 9 {
                cursor += 1
                continue
            }
            break
        }

        guard cursor < end else { return false }
        let marker = nsString.character(at: cursor)
        if marker == 0x2022 || marker == 45 {
            cursor += 1
            while cursor < end {
                let scalar = nsString.character(at: cursor)
                guard scalar == 32 || scalar == 9 else { return false }
                cursor += 1
            }
            return true
        }

        let digitStart = cursor
        while cursor < end {
            let scalar = nsString.character(at: cursor)
            guard CharacterSet.decimalDigits.contains(UnicodeScalar(scalar)!) else { break }
            cursor += 1
        }
        guard cursor > digitStart, cursor < end, nsString.character(at: cursor) == 46 else {
            return false
        }

        cursor += 1
        while cursor < end {
            let scalar = nsString.character(at: cursor)
            guard scalar == 32 || scalar == 9 else { return false }
            cursor += 1
        }
        return true
    }

    private func isLegacyContinuationWhitespace(_ scalar: unichar) -> Bool {
        scalar == 32 || scalar == 9 || scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029
    }

    private mutating func convertParagraph(_ content: NSAttributedString, range: NSRange) throws -> [MigratedDocumentBlock] {
        let visibleRange = trimmedVisibleRange(range, in: content.string as NSString)
        let attachmentItems = attachmentItems(in: visibleRange, content: content)

        if let leadingCheckbox = leadingCheckboxItem(in: attachmentItems, visibleRange: visibleRange, content: content) {
            return [buildTodoBlock(content, paragraphRange: visibleRange, checkbox: leadingCheckbox.item, indent: leadingCheckbox.indent)]
        }

        if attachmentItems.count == 1,
           visibleRange.length == attachmentItems[0].range.length,
           let attachmentBlock = try buildAttachmentBlock(from: attachmentItems[0], content: content) {
            return [attachmentBlock]
        }

        if attachmentItems.isEmpty {
            if let textBlock = buildTextBlock(content, range: visibleRange, prefersParagraphSemantics: true) {
                return [textBlock]
            }
            return [MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: 0, asset: nil, table: nil)]
        }

        var blocks: [MigratedDocumentBlock] = []
        var cursor = visibleRange.location
        var prefersParagraphSemantics = true

        for item in attachmentItems {
            if item.range.location > cursor {
                let textRange = NSRange(location: cursor, length: item.range.location - cursor)
                if let textBlock = buildTextBlock(content, range: textRange, prefersParagraphSemantics: prefersParagraphSemantics) {
                    blocks.append(textBlock)
                    prefersParagraphSemantics = false
                }
            }

            if let attachmentBlock = try buildAttachmentBlock(from: item, content: content) {
                blocks.append(attachmentBlock)
                prefersParagraphSemantics = false
            } else {
                prefersParagraphSemantics = false
            }

            cursor = NSMaxRange(item.range)
        }

        let paragraphEnd = NSMaxRange(visibleRange)
        if cursor < paragraphEnd {
            let textRange = NSRange(location: cursor, length: paragraphEnd - cursor)
            if let textBlock = buildTextBlock(content, range: textRange, prefersParagraphSemantics: prefersParagraphSemantics) {
                blocks.append(textBlock)
            }
        }

        if blocks.isEmpty {
            blocks.append(MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: 0, asset: nil, table: nil))
        }

        return blocks
    }

    private mutating func buildTodoBlock(_ content: NSAttributedString, paragraphRange: NSRange, checkbox: AttachmentItem, indent: Int) -> MigratedDocumentBlock {
        var start = checkboxTextStartLocation(for: checkbox, in: content)
        let end = NSMaxRange(paragraphRange)
        let nsString = content.string as NSString
        while start < end {
            let scalar = nsString.character(at: start)
            let hasAttachmentAttribute = content.attribute(.attachment, at: start, effectiveRange: nil) != nil
            if hasAttachmentAttribute || scalar == 32 || scalar == 9 || scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029 {
                start += 1
            } else {
                break
            }
        }

        let textRange = NSRange(location: start, length: max(0, end - start))
        return MigratedDocumentBlock(
            id: nextBlockID(),
            type: "todo_item",
            text: inlineText(in: textRange, content: content),
            level: nil,
            listStyle: nil,
            order: nil,
            checked: checkbox.checkboxState,
            indent: indent,
            asset: nil,
            table: nil
        )
    }

    private func checkboxTextStartLocation(for checkbox: AttachmentItem, in content: NSAttributedString) -> Int {
        let nsString = content.string as NSString
        let maxLength = nsString.length
        guard checkbox.range.location < maxLength else {
            return NSMaxRange(checkbox.range)
        }

        let rangeStart = max(0, checkbox.range.location)
        let rangeEnd = min(NSMaxRange(checkbox.range), maxLength)
        if rangeStart >= rangeEnd {
            return NSMaxRange(checkbox.range)
        }

        let objectReplacement: unichar = 0xFFFC
        for index in rangeStart..<rangeEnd where nsString.character(at: index) == objectReplacement {
            return min(index + 1, maxLength)
        }

        return min(NSMaxRange(checkbox.range), maxLength)
    }

    private mutating func buildTextBlock(_ content: NSAttributedString, range: NSRange, prefersParagraphSemantics: Bool) -> MigratedDocumentBlock? {
        let nsString = content.string as NSString
        let workingRange = prefersParagraphSemantics
            ? range
            : sanitizedInlineContinuationRange(range, in: nsString)
        guard workingRange.length > 0 else { return nil }

        let raw = nsString.substring(with: workingRange)
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: leadingIndentLevel(in: raw), asset: nil, table: nil)
        }

        var finalRange = workingRange
        var type = "paragraph"
        var level: Int?
        var listStyle: String?
        var order: Int?
        let indent = prefersParagraphSemantics ? leadingIndentLevel(in: raw) : 0

        if prefersParagraphSemantics, let listDescriptor = detectListDescriptor(in: raw, baseLocation: workingRange.location) {
            type = "list_item"
            listStyle = listDescriptor.style
            order = listDescriptor.order
            finalRange = sanitizedListContentRange(listDescriptor.contentRange, in: content.string as NSString)
        } else if prefersParagraphSemantics, let headingLevel = detectHeadingLevel(in: content, range: workingRange) {
            type = "heading"
            level = headingLevel
        }

        let spans = inlineText(in: finalRange, content: content)
        return MigratedDocumentBlock(
            id: nextBlockID(),
            type: type,
            text: spans,
            level: level,
            listStyle: listStyle,
            order: order,
            checked: nil,
            indent: indent,
            asset: nil,
            table: nil
        )
    }

    private func sanitizedInlineContinuationRange(_ range: NSRange, in nsString: NSString) -> NSRange {
        let maxLength = nsString.length
        var start = max(0, min(range.location, maxLength))
        let end = max(start, min(NSMaxRange(range), maxLength))

        while start < end {
            let scalar = nsString.character(at: start)
            if scalar == 0xFFFC ||
                scalar == 32 ||
                scalar == 9 ||
                scalar == 10 ||
                scalar == 13 ||
                scalar == 0x2028 ||
                scalar == 0x2029 {
                start += 1
                continue
            }
            break
        }

        return NSRange(location: start, length: max(0, end - start))
    }

    private mutating func buildAttachmentBlock(from item: AttachmentItem, content: NSAttributedString) throws -> MigratedDocumentBlock? {
        if item.isCheckbox {
            return nil
        }

        if let tableData = item.tableData {
            return MigratedDocumentBlock(
                id: nextBlockID(),
                type: "table",
                text: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: nil,
                asset: nil,
                table: MigratedTable(
                    rows: tableData.rows,
                    columnWidths: tableData.columnWidths.map { Double($0) },
                    rowHeights: tableData.rowHeights.map { Double($0) }
                )
            )
        }

        if let asset = try exportAsset(from: item, content: content) {
            return MigratedDocumentBlock(
                id: nextBlockID(),
                type: asset.kind,
                text: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: nil,
                asset: asset,
                table: nil
            )
        }

        return nil
    }

    private func sanitizedListContentRange(_ range: NSRange, in nsString: NSString) -> NSRange {
        let maxLength = nsString.length
        var start = max(0, min(range.location, maxLength))
        let end = max(start, min(NSMaxRange(range), maxLength))

        while start < end {
            let scalar = nsString.character(at: start)
            if scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029 {
                start += 1
                continue
            }
            break
        }

        return NSRange(location: start, length: max(0, end - start))
    }

    private mutating func exportAsset(from item: AttachmentItem, content: NSAttributedString) throws -> MigratedAssetReference? {
        if let attachment = item.attachment as? AttachmentTextAttachment {
            switch attachment.kind {
            case .image:
                return try exportImageAsset(
                    data: attachment.attachmentData(),
                    preferredFilename: attachment.attachmentFileURL.lastPathComponent,
                    width: resolvedWidth(for: item.attributes, attachment: attachment),
                    height: resolvedHeight(for: item.attributes, attachment: attachment)
                )
            case .audio:
                return try exportAudioAsset(
                    sourceURL: attachment.attachmentFileURL,
                    data: attachment.attachmentData(),
                    duration: nil,
                    createdAt: nil
                )
            }
        }

        if let audioAttachment = item.attachment as? AudioBlockAttachment {
            return try exportAudioAsset(
                sourceURL: audioAttachment.fileURL,
                data: audioAttachment.audioData(),
                duration: audioAttachment.duration,
                createdAt: audioAttachment.createDate
            )
        }

        if let payload = regularFilePayload(from: item.attachment.fileWrapper) {
            let data = payload.data
            let preferredFilename = payload.preferredFilename
            let mimeType = mimeType(forPathExtension: URL(fileURLWithPath: preferredFilename).pathExtension.lowercased())
            if mimeType.hasPrefix("image/") {
                return try exportImageAsset(
                    data: data,
                    preferredFilename: preferredFilename,
                    width: resolvedWidth(for: item.attributes, attachment: item.attachment),
                    height: resolvedHeight(for: item.attributes, attachment: item.attachment)
                )
            }
            if mimeType.hasPrefix("audio/") {
                return try exportAudioAsset(
                    sourceURL: URL(fileURLWithPath: preferredFilename),
                    data: data,
                    duration: nil,
                    createdAt: nil
                )
            }
        }

        if let image = item.attachment.image,
           let tiffData = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiffData),
           let pngData = bitmap.representation(using: .png, properties: [:]) {
            return try exportImageAsset(
                data: pngData,
                preferredFilename: "image.png",
                width: resolvedWidth(for: item.attributes, attachment: item.attachment),
                height: resolvedHeight(for: item.attributes, attachment: item.attachment)
            )
        }

        if let linkValue = item.attributes[.link] {
            let rawURL: String?
            if let url = linkValue as? URL {
                rawURL = url.absoluteString
            } else if let string = linkValue as? String {
                rawURL = string
            } else {
                rawURL = nil
            }

            if let rawURL, let fileURL = URL(string: rawURL) {
                let mimeType = mimeType(forPathExtension: fileURL.pathExtension.lowercased())
                if mimeType.hasPrefix("audio/") {
                    return try exportAudioAsset(
                        sourceURL: fileURL,
                        data: try? Data(contentsOf: fileURL),
                        duration: nil,
                        createdAt: nil
                    )
                }
            }
        }

        _ = content
        return nil
    }

    private mutating func exportImageAsset(data: Data?, preferredFilename: String, width: Double?, height: Double?) throws -> MigratedAssetReference? {
        guard let data else { return nil }
        let filename = uniqueAssetFilename(preferredFilename, fallbackExtension: "png")
        let outputURL = assetsDirectory.appendingPathComponent(filename)
        try data.write(to: outputURL, options: .atomic)
        return MigratedAssetReference(
            id: nextAssetID(),
            kind: "image",
            filename: "Assets/\(filename)",
            mimeType: mimeType(forPathExtension: outputURL.pathExtension.lowercased()),
            width: width,
            height: height,
            duration: nil,
            createdAt: nil,
            sidecarFiles: []
        )
    }

    private mutating func exportAudioAsset(sourceURL: URL, data: Data?, duration: TimeInterval?, createdAt: Date?) throws -> MigratedAssetReference? {
        guard let data else { return nil }
        let filename = uniqueAssetFilename(sourceURL.lastPathComponent, fallbackExtension: sourceURL.pathExtension.isEmpty ? "m4a" : sourceURL.pathExtension)
        let outputURL = assetsDirectory.appendingPathComponent(filename)
        try data.write(to: outputURL, options: .atomic)

        var sidecarFiles: [String] = []
        let manifestURL = sourceURL.deletingPathExtension().appendingPathExtension("tracks.json")
        if fileManager.fileExists(atPath: manifestURL.path),
           let manifestData = try? Data(contentsOf: manifestURL) {
            let manifestFilename = uniqueAssetFilename(manifestURL.lastPathComponent, fallbackExtension: manifestURL.pathExtension)
            let manifestOutputURL = assetsDirectory.appendingPathComponent(manifestFilename)
            try manifestData.write(to: manifestOutputURL, options: .atomic)
            sidecarFiles.append("Assets/\(manifestFilename)")
        }

        return MigratedAssetReference(
            id: nextAssetID(),
            kind: "audio",
            filename: "Assets/\(filename)",
            mimeType: mimeType(forPathExtension: outputURL.pathExtension.lowercased()),
            width: nil,
            height: nil,
            duration: duration,
            createdAt: createdAt,
            sidecarFiles: sidecarFiles
        )
    }

    private func inlineText(in range: NSRange, content: NSAttributedString) -> [MigratedInlineText] {
        guard range.length > 0 else { return [] }

        let nsString = content.string as NSString
        var spans: [MigratedInlineText] = []

        content.enumerateAttributes(in: range, options: []) { attributes, subrange, _ in
            let raw = nsString.substring(with: subrange)
                .replacingOccurrences(of: "\u{FFFC}", with: "")
                .replacingOccurrences(of: "\r", with: "")
                .replacingOccurrences(of: "\n", with: "")
                .replacingOccurrences(of: "\u{2028}", with: "")
                .replacingOccurrences(of: "\u{2029}", with: "")

            guard !raw.isEmpty else { return }

            let font = attributes[.font] as? NSFont
            let fontTraits = font.map { NSFontManager.shared.traits(of: $0) } ?? []
            let textColor = (attributes[.foregroundColor] as? NSColor).flatMap(colorHex)
            let backgroundColor = (attributes[.backgroundColor] as? NSColor).flatMap(colorHex)
            let underline = ((attributes[.underlineStyle] as? NSNumber)?.intValue ?? 0) != 0
            let strikethrough = ((attributes[.strikethroughStyle] as? NSNumber)?.intValue ?? 0) != 0
            let kern = (attributes[.kern] as? NSNumber)?.doubleValue
            let baselineOffset = (attributes[.baselineOffset] as? NSNumber)?.doubleValue
            let link: String?

            if let url = attributes[.link] as? URL {
                link = url.absoluteString
            } else if let string = attributes[.link] as? String {
                link = string
            } else {
                link = nil
            }

            let span = MigratedInlineText(
                text: raw,
                bold: fontTraits.contains(.boldFontMask),
                italic: fontTraits.contains(.italicFontMask),
                underline: underline,
                strikethrough: strikethrough,
                textColor: textColor,
                backgroundColor: backgroundColor,
                link: link,
                fontFamily: font?.familyName,
                fontSize: font.map { Double($0.pointSize) },
                kern: kern,
                baselineOffset: baselineOffset,
                paragraphStyle: paragraphStylePayload(from: attributes[.paragraphStyle] as? NSParagraphStyle)
            )

            if let last = spans.last,
               last.bold == span.bold,
               last.italic == span.italic,
               last.underline == span.underline,
               last.strikethrough == span.strikethrough,
               last.textColor == span.textColor,
               last.backgroundColor == span.backgroundColor,
               last.link == span.link,
               last.fontFamily == span.fontFamily,
               last.fontSize == span.fontSize,
               last.kern == span.kern,
               last.baselineOffset == span.baselineOffset,
               last.paragraphStyle == span.paragraphStyle {
                spans[spans.count - 1] = MigratedInlineText(
                    text: last.text + span.text,
                    bold: span.bold,
                    italic: span.italic,
                    underline: span.underline,
                    strikethrough: span.strikethrough,
                    textColor: span.textColor,
                    backgroundColor: span.backgroundColor,
                    link: span.link,
                    fontFamily: span.fontFamily,
                    fontSize: span.fontSize,
                    kern: span.kern,
                    baselineOffset: span.baselineOffset,
                    paragraphStyle: span.paragraphStyle
                )
            } else {
                spans.append(span)
            }
        }

        return spans
    }

    private func attachmentItems(in range: NSRange, content: NSAttributedString) -> [AttachmentItem] {
        guard range.length > 0 else { return [] }

        var items: [AttachmentItem] = []
        content.enumerateAttribute(.attachment, in: range, options: []) { value, subrange, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            let attributes = content.attributes(at: subrange.location, effectiveRange: nil)

            let tableData: TableData? = {
                if let tableAttachment = attachment as? TableTextAttachment {
                    return tableAttachment.tableData
                }
                if let raw = attributes[.notebookTableData] as? Data,
                   let decoded = try? JSONDecoder().decode(TableData.self, from: raw) {
                    return decoded
                }
                if TableTextAttachment.looksLikeTable(attachment) {
                    return TableTextAttachment.recover(from: attachment)?.tableData
                }
                return nil
            }()

            let checkboxState: Bool? = {
                if let checkbox = attachment as? CheckboxTextAttachment {
                    return checkbox.isChecked
                }
                if CheckboxTextAttachment.looksLikeCheckbox(attachment) {
                    return CheckboxTextAttachment.inferCheckedState(from: attachment)
                }
                if attachment is AttachmentTextAttachment {
                    return nil
                }
                if probableLegacyCheckboxAttachment(attachment) {
                    return CheckboxTextAttachment.inferCheckedState(from: attachment)
                }
                return nil
            }()

            items.append(
                AttachmentItem(
                    range: subrange,
                    attachment: attachment,
                    attributes: attributes,
                    checkboxState: checkboxState,
                    tableData: tableData
                )
            )
        }
        return items
    }

    private func leadingCheckboxItem(
        in items: [AttachmentItem],
        visibleRange: NSRange,
        content: NSAttributedString
    ) -> (item: AttachmentItem, indent: Int)? {
        guard let first = items.first, first.isCheckbox else { return nil }
        guard first.range.location >= visibleRange.location else { return nil }

        let prefixRange = NSRange(location: visibleRange.location, length: first.range.location - visibleRange.location)
        let prefix = (content.string as NSString).substring(with: prefixRange)
        guard prefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return (first, leadingIndentLevel(in: prefix))
    }

    private func detectHeadingLevel(in content: NSAttributedString, range: NSRange) -> Int? {
        guard range.length > 0 else { return nil }

        var explicitLevel: Int?
        content.enumerateAttribute(.notebookHeadingLevel, in: range, options: []) { value, _, stop in
            if let level = (value as? NSNumber)?.intValue ?? (value as? Int) {
                explicitLevel = max(1, min(level, 6))
                stop.pointee = true
            }
        }
        if let explicitLevel {
            return explicitLevel
        }

        var maxPointSize: CGFloat = 0
        var emphasized = false

        content.enumerateAttribute(.font, in: range, options: []) { value, _, _ in
            guard let font = value as? NSFont else { return }
            maxPointSize = max(maxPointSize, font.pointSize)
            let traits = NSFontManager.shared.traits(of: font)
            if traits.contains(.boldFontMask) || font.fontName.lowercased().contains("semibold") {
                emphasized = true
            }
        }

        if maxPointSize >= 21 {
            return 1
        }
        if maxPointSize >= 17 {
            return 2
        }
        if maxPointSize >= 15.5 && emphasized {
            return 3
        }
        return nil
    }

    private func paragraphStylePayload(from style: NSParagraphStyle?) -> MigratedParagraphStyle? {
        guard let style else { return nil }
        return MigratedParagraphStyle(
            alignment: style.alignment.rawValue,
            lineSpacing: style.lineSpacing == 0 ? nil : style.lineSpacing,
            paragraphSpacing: style.paragraphSpacing == 0 ? nil : style.paragraphSpacing,
            paragraphSpacingBefore: style.paragraphSpacingBefore == 0 ? nil : style.paragraphSpacingBefore,
            firstLineHeadIndent: style.firstLineHeadIndent == 0 ? nil : style.firstLineHeadIndent,
            headIndent: style.headIndent == 0 ? nil : style.headIndent,
            tailIndent: style.tailIndent == 0 ? nil : style.tailIndent
        )
    }

    private func detectListDescriptor(in raw: String, baseLocation: Int) -> ListDescriptor? {
        let nsRaw = raw as NSString
        let indentRange = nsRaw.range(of: #"^[ \t]*"#, options: .regularExpression)
        let indentLength = indentRange.length
        let tail = nsRaw.substring(from: indentLength)

        if tail.hasPrefix("• ") {
            return ListDescriptor(style: "bullet", order: nil, contentRange: NSRange(location: baseLocation + indentLength + 2, length: max(0, nsRaw.length - indentLength - 2)))
        }

        if tail.hasPrefix("- ") {
            return ListDescriptor(style: "dash", order: nil, contentRange: NSRange(location: baseLocation + indentLength + 2, length: max(0, nsRaw.length - indentLength - 2)))
        }

        let pattern = #"^(\d+)\.\s"#
        if let regex = try? NSRegularExpression(pattern: pattern),
           let match = regex.firstMatch(in: tail, options: [], range: NSRange(location: 0, length: (tail as NSString).length)) {
            let orderRange = match.range(at: 1)
            let order = Int((tail as NSString).substring(with: orderRange))
            return ListDescriptor(style: "ordered", order: order, contentRange: NSRange(location: baseLocation + indentLength + match.range.length, length: max(0, nsRaw.length - indentLength - match.range.length)))
        }

        return nil
    }

    private func trimmedVisibleRange(_ range: NSRange, in nsString: NSString) -> NSRange {
        var location = range.location
        var length = range.length

        while length > 0 {
            let tail = nsString.character(at: location + length - 1)
            if tail == 10 || tail == 13 || tail == 0x2028 || tail == 0x2029 {
                length -= 1
            } else {
                break
            }
        }

        while length > 0 {
            let head = nsString.character(at: location)
            if head == 10 || head == 13 || head == 0x2028 || head == 0x2029 {
                location += 1
                length -= 1
            } else {
                break
            }
        }

        return NSRange(location: location, length: max(0, length))
    }

    private func leadingIndentLevel(in raw: String) -> Int {
        var spaces = 0
        var tabs = 0

        for char in raw {
            if char == " " {
                spaces += 1
                continue
            }
            if char == "\t" {
                tabs += 1
                continue
            }
            break
        }

        return tabs + (spaces / 4)
    }

    private func resolvedWidth(for attributes: [NSAttributedString.Key: Any], attachment: NSTextAttachment) -> Double? {
        if let width = attributes[.notebookImageWidth] as? CGFloat, width > 1 {
            return Double(width)
        }
        if attachment.bounds.width > 1 {
            return Double(attachment.bounds.width)
        }
        return nil
    }

    private func resolvedHeight(for attributes: [NSAttributedString.Key: Any], attachment: NSTextAttachment) -> Double? {
        if let height = attributes[.notebookImageHeight] as? CGFloat, height > 1 {
            return Double(height)
        }
        if attachment.bounds.height > 1 {
            return Double(attachment.bounds.height)
        }
        return nil
    }

    private func probableLegacyCheckboxAttachment(_ attachment: NSTextAttachment) -> Bool {
        let resolvedSize: CGSize = {
            if attachment.bounds.width > 0, attachment.bounds.height > 0 {
                return attachment.bounds.size
            }
            if let image = attachment.image {
                return image.size
            }
            if let contents = attachment.contents, let image = NSImage(data: contents) {
                return image.size
            }
            if let payload = regularFilePayload(from: attachment.fileWrapper),
               let image = NSImage(data: payload.data) {
                return image.size
            }
            return .zero
        }()

        guard resolvedSize.width > 0, resolvedSize.height > 0 else {
            return false
        }

        let minEdge = min(resolvedSize.width, resolvedSize.height)
        let maxEdge = max(resolvedSize.width, resolvedSize.height)
        guard minEdge >= 10, maxEdge <= 36 else {
            return false
        }

        let ratio = maxEdge / minEdge
        return ratio <= 1.25
    }

    private func regularFilePayload(from fileWrapper: FileWrapper?) -> (data: Data, preferredFilename: String)? {
        guard let fileWrapper, fileWrapper.isRegularFile, let data = fileWrapper.regularFileContents else {
            return nil
        }
        let preferredFilename = fileWrapper.preferredFilename ?? fileWrapper.filename ?? "attachment"
        return (data, preferredFilename)
    }

    private func colorHex(_ color: NSColor) -> String? {
        guard let rgb = color.usingColorSpace(.sRGB) else { return nil }
        let red = Int(round(rgb.redComponent * 255))
        let green = Int(round(rgb.greenComponent * 255))
        let blue = Int(round(rgb.blueComponent * 255))
        let alpha = Int(round(rgb.alphaComponent * 255))
        return String(format: "#%02X%02X%02X%02X", red, green, blue, alpha)
    }

    private func mimeType(forPathExtension ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "webp": return "image/webp"
        case "m4a": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "aiff": return "audio/aiff"
        case "caf": return "audio/x-caf"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }

    private mutating func uniqueAssetFilename(_ preferredFilename: String, fallbackExtension: String) -> String {
        let sanitizedBase = sanitizeFilename(URL(fileURLWithPath: preferredFilename).deletingPathExtension().lastPathComponent)
        let fallbackBase = sanitizedBase.isEmpty ? "asset" : sanitizedBase
        let ext = URL(fileURLWithPath: preferredFilename).pathExtension.isEmpty ? fallbackExtension : URL(fileURLWithPath: preferredFilename).pathExtension
        let filename = "\(assetIndex + 1)-\(fallbackBase).\(ext)"
        return filename
    }

    private func sanitizeFilename(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let unicodeScalars = raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        return String(unicodeScalars).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private mutating func nextBlockID() -> String {
        blockIndex += 1
        return "block-\(blockIndex)"
    }

    private mutating func nextAssetID() -> String {
        assetIndex += 1
        return "asset-\(assetIndex)"
    }

    private struct AttachmentItem {
        let range: NSRange
        let attachment: NSTextAttachment
        let attributes: [NSAttributedString.Key: Any]
        let checkboxState: Bool?
        let tableData: TableData?

        var isCheckbox: Bool {
            checkboxState != nil
        }
    }

    private struct ListDescriptor {
        let style: String
        let order: Int?
        let contentRange: NSRange
    }
}
