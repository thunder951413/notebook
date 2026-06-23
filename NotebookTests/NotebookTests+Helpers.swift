import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


// MARK: - Shared test infrastructure

extension NotebookTests {
    @MainActor
    func makeInMemoryContainer() throws -> ModelContainer {
        let configuration = ModelConfiguration(schema: PersistenceController.appSchema, isStoredInMemoryOnly: true)
        return try ModelContainer(for: PersistenceController.appSchema, configurations: [configuration])
    }

    func encodeTextPayload(_ spans: [MigratedInlineText]?) throws -> Data? {
        guard let spans, !spans.isEmpty else { return nil }
        return try JSONEncoder().encode(
            spans.map {
                BlockDocumentTextSpanPayload(
                    text: $0.text,
                    bold: $0.bold,
                    italic: $0.italic,
                    underline: $0.underline,
                    strikethrough: $0.strikethrough,
                    textColor: $0.textColor,
                    backgroundColor: $0.backgroundColor,
                    link: $0.link,
                    fontFamily: $0.fontFamily,
                    fontSize: $0.fontSize,
                    kern: $0.kern,
                    baselineOffset: $0.baselineOffset,
                    paragraphStyle: $0.paragraphStyle.map {
                        BlockDocumentParagraphStylePayload(
                            alignment: $0.alignment,
                            lineSpacing: $0.lineSpacing,
                            paragraphSpacing: $0.paragraphSpacing,
                            paragraphSpacingBefore: $0.paragraphSpacingBefore,
                            firstLineHeadIndent: $0.firstLineHeadIndent,
                            headIndent: $0.headIndent,
                            tailIndent: $0.tailIndent
                        )
                    }
                )
            }
        )
    }

    func buildAttributedContent(from blocks: [MigratedDocumentBlock]) throws -> NSAttributedString {
        let noteID = UUID()
        let blockEntities = try blocks.enumerated().map { index, block in
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: index,
                blockID: block.id,
                kind: block.type,
                sourceType: block.type,
                textPayload: try encodeTextPayload(block.text),
                level: block.level,
                listStyle: block.listStyle,
                order: block.order,
                checked: block.checked,
                indent: block.indent,
                assetID: nil,
                tablePayload: nil
            )
        }
        return BlockDocumentAttributedStringBuilder(attachmentsRoot: nil)
            .build(blocks: blockEntities, assetsByID: [:])
    }

    func headingLevel(in content: NSAttributedString, at location: Int) -> Int? {
        let value = content.attribute(.notebookHeadingLevel, at: location, effectiveRange: nil)
        return (value as? NSNumber)?.intValue ?? (value as? Int)
    }

    func hasCheckboxAttachment(in content: NSAttributedString) -> Bool {
        var found = false
        content.enumerateAttribute(.attachment, in: NSRange(location: 0, length: content.length), options: []) { value, _, stop in
            if value is CheckboxTextAttachment {
                found = true
                stop.pointee = true
            }
        }
        return found
    }

    func sourceFileContents(relativePath: String) throws -> String {
        let rootURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: rootURL.appendingPathComponent(relativePath), encoding: .utf8)
    }

    @MainActor
    func refreshedAttachmentRenderData(
        in textView: RichTextView,
        appearance: NSAppearance,
        attachment: NSTextAttachment
    ) -> Data? {
        var renderedData: Data?
        appearance.performAsCurrentDrawingAppearance {
            RichTextEditor.refreshAppearanceSensitiveAttachments(in: textView)
            renderedData = attachment.image?.tiffRepresentation
        }
        return renderedData
    }

    @MainActor
    func makeHostedTableAttachmentView(
        tableData: TableData,
        onCellEdited: @escaping (Int, Int, String) -> Void = { _, _, _ in },
        onStructureChanged: @escaping () -> Void = {},
        contextMenuPresenter: ((NSMenu, NSEvent, NSView) -> Void)? = nil
    ) -> (NSWindow, TableAttachmentNSView) {
        let tableView = TableAttachmentNSView(frame: .zero)
        tableView.configure(tableData: tableData, onCellEdited: onCellEdited, onStructureChanged: onStructureChanged)
        tableView.contextMenuPresenter = contextMenuPresenter
        tableView.frame = NSRect(origin: .zero, size: tableView.intrinsicContentSize)

        let container = NSView(frame: tableView.frame)
        container.addSubview(tableView)

        let window = NSWindow(
            contentRect: tableView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        window.displayIfNeeded()

        return (window, tableView)
    }

    @MainActor
    func makeHostedRichTextView(content: NSAttributedString) -> (NSWindow, RichTextView) {
        let textView = RichTextView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainerInset = NSSize(width: 16, height: 16)
        textView.textContainer?.containerSize = NSSize(width: 768, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.textStorage?.setAttributedString(content)
        if let textContainer = textView.textContainer {
            textView.layoutManager?.ensureLayout(for: textContainer)
        }

        let window = NSWindow(
            contentRect: textView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = textView
        window.makeKeyAndOrderFront(nil)
        window.displayIfNeeded()
        textView.displayIfNeeded()

        return (window, textView)
    }

    @MainActor
    func sendLeftClick(to view: NSView, at point: NSPoint) {
        guard let window = view.window,
              let event = NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: view.convert(point, to: nil),
                modifierFlags: [],
                timestamp: 0,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 0,
                clickCount: 1,
                pressure: 1
              ) else {
            XCTFail("Unable to create click event")
            return
        }
        view.mouseDown(with: event)
    }

    @MainActor
    func sendLeftDoubleClick(to view: NSView, at point: NSPoint) {
        guard let window = view.window,
              let event = NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: view.convert(point, to: nil),
                modifierFlags: [],
                timestamp: 0,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 0,
                clickCount: 2,
                pressure: 1
              ) else {
            XCTFail("Unable to create double click event")
            return
        }
        view.mouseDown(with: event)
    }

    @MainActor
    func sendRightClick(to view: NSView, at point: NSPoint) {
        guard let window = view.window,
              let event = NSEvent.mouseEvent(
                with: .rightMouseDown,
                location: view.convert(point, to: nil),
                modifierFlags: [],
                timestamp: 0,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 0,
                clickCount: 1,
                pressure: 1
              ) else {
            XCTFail("Unable to create right click event")
            return
        }
        view.rightMouseDown(with: event)
    }

    @MainActor
    func performTableAction(_ selectorName: String, on tableView: TableAttachmentNSView) -> Bool {
        let selector = NSSelectorFromString(selectorName)
        guard tableView.responds(to: selector) else {
            XCTFail("Table view does not respond to \(selectorName)")
            return false
        }
        tableView.perform(selector, with: nil)
        return true
    }

    @MainActor
    func resizeToIntrinsicContentSize(_ view: NSView) {
        view.frame.size = view.intrinsicContentSize
        view.window?.contentView?.frame.size = view.frame.size
        view.window?.setContentSize(view.frame.size)
        view.displayIfNeeded()
    }

    @MainActor
    func sendKeyDown(to view: NSView, keyCode: UInt16, characters: String = "", modifiers: NSEvent.ModifierFlags = []) {
        guard let window = view.window,
              let event = NSEvent.keyEvent(
                with: .keyDown,
                location: .zero,
                modifierFlags: modifiers,
                timestamp: 0,
                windowNumber: window.windowNumber,
                context: nil,
                characters: characters,
                charactersIgnoringModifiers: characters,
                isARepeat: false,
                keyCode: keyCode
              ) else {
            XCTFail("Unable to create key event")
            return
        }
        view.keyDown(with: event)
    }

    @MainActor
    func sendEditingCommand(_ selector: Selector, in tableView: TableAttachmentNSView) -> Bool {
        guard let editor = tableView.subviews.compactMap({ $0 as? NSTextField }).first else {
            XCTFail("Expected active table editor")
            return false
        }
        return tableView.control(editor, textView: NSTextView(), doCommandBy: selector)
    }

    @MainActor
    func renderedViewData(_ view: NSView, appearance: NSAppearance) -> Data? {
        var renderedData: Data?
        let originalViewAppearance = view.appearance
        let originalWindowAppearance = view.window?.appearance
        view.appearance = appearance
        view.window?.appearance = appearance
        defer {
            view.appearance = originalViewAppearance
            view.window?.appearance = originalWindowAppearance
        }

        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        renderedData = bitmap.tiffRepresentation
        return renderedData
    }

    @MainActor
    func pointForAttachment(in textView: RichTextView, range: NSRange) -> NSPoint? {
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else {
            return nil
        }

        layoutManager.ensureLayout(for: textContainer)
        let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
        rect.origin.x += textView.textContainerInset.width
        rect.origin.y += textView.textContainerInset.height

        guard rect.width > 0, rect.height > 0 else { return nil }
        return NSPoint(x: rect.midX, y: rect.midY)
    }

    func pointForTableCell(row: Int, col: Int, tableData: TableData) -> NSPoint {
        let borderWidth: CGFloat = 1
        var y = borderWidth
        for index in 0..<row {
            y += tableData.rowHeights[index] + borderWidth
        }

        var x = borderWidth
        for index in 0..<col {
            x += tableData.columnWidths[index] + borderWidth
        }

        return NSPoint(
            x: x + tableData.columnWidths[col] / 2,
            y: y + tableData.rowHeights[row] / 2
        )
    }

    func resolvedRGBA(_ color: NSColor?, appearance: NSAppearance) -> [CGFloat]? {
        guard let color else { return nil }

        var components: [CGFloat]?
        appearance.performAsCurrentDrawingAppearance {
            guard let resolved = color.usingColorSpace(.deviceRGB) else { return }
            components = [resolved.redComponent, resolved.greenComponent, resolved.blueComponent, resolved.alphaComponent]
        }
        return components
    }

    @MainActor
    func resetSharedTestState() {
        StorageLocationManager.shared.setBaseDirectoryForTesting(nil)
        NoteSaveManager.shared.resetForTesting()
        BackupManager.shared.markSaveComplete()
    }

    @discardableResult
    func insertMinimalBlockLibrary(context: ModelContext, title: String) throws -> UUID {
        let libraryID = UUID()
        let noteID = UUID()
        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 1,
                folderCount: 0,
                tagCount: 0
            )
        )
        context.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: title,
                createdAt: Date(),
                updatedAt: Date(),
                folderID: nil,
                folderName: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 1,
                tagIDs: "",
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 0,
                assetCount: 0
            )
        )
        try context.save()
        return noteID
    }

    func makeLegacyCheckboxImage(size: CGFloat) throws -> NSImage {
        let data = try makeLegacyCheckboxPNGData(size: size)
        return try XCTUnwrap(NSImage(data: data))
    }

    func makeLegacyCheckboxPNGData(size: CGFloat) throws -> Data {
        try makePNGData(size: NSSize(width: size, height: size)) { context, rect in
            context.clear(rect)
            context.setStrokeColor(NSColor.tertiaryLabelColor.cgColor)
            context.setLineWidth(max(1, size / 16))
            context.strokeEllipse(in: rect.insetBy(dx: 1, dy: 1))
        }
    }

    func makeFilledPNGData(size: NSSize, color: NSColor) throws -> Data {
        try makePNGData(size: size) { context, rect in
            context.setFillColor(color.cgColor)
            context.fill(rect)
        }
    }

    func makePNGData(
        size: NSSize,
        drawing: (CGContext, CGRect) -> Void
    ) throws -> Data {
        let width = max(Int(size.width.rounded(.up)), 1)
        let height = max(Int(size.height.rounded(.up)), 1)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(
            CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        )
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        drawing(context, rect)
        let cgImage = try XCTUnwrap(context.makeImage())
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        return try XCTUnwrap(bitmap.representation(using: NSBitmapImageRep.FileType.png, properties: [:]))
    }

    func makeDeletedBlockNote(id: UUID, libraryID: UUID, title: String) -> BlockDocumentNoteEntity {
        BlockDocumentNoteEntity(
            id: id,
            libraryID: libraryID,
            title: title,
            createdAt: Date(),
            updatedAt: Date(),
            folderID: nil,
            folderName: "回收站",
            reminderAt: nil,
            recurrenceRule: "none",
            version: 1,
            tagIDs: "",
            viewMode: "text",
            deletedAt: Date(),
            originalFolderID: nil,
            originalFolderName: "未分类",
            documentSchemaVersion: "1.0",
            documentSource: "test",
            blockCount: 0,
            assetCount: 0
        )
    }

}
