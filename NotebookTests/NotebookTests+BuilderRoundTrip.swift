import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {

    @MainActor
    func testTodoRoundTripPreservesIndentationAndCheckboxSemantics() throws {
        let block = MigratedDocumentBlock(
            id: "todo-1",
            type: "todo_item",
            text: [
                MigratedInlineText(
                    text: "处理格式",
                    bold: false,
                    italic: false,
                    underline: false,
                    strikethrough: false,
                    textColor: nil,
                    backgroundColor: nil,
                    link: nil,
                    fontFamily: nil,
                    fontSize: nil,
                    kern: nil,
                    baselineOffset: nil,
                    paragraphStyle: nil
                )
            ],
            level: nil,
            listStyle: nil,
            order: nil,
            checked: true,
            indent: 1,
            asset: nil,
            table: nil
        )

        let restored = try buildAttributedContent(from: [block])
        XCTAssertTrue(restored.string.hasPrefix("    "))
        XCTAssertEqual(restored.string.replacingOccurrences(of: "\u{FFFC}", with: "").trimmingCharacters(in: .whitespacesAndNewlines), "处理格式")
        XCTAssertTrue(hasCheckboxAttachment(in: restored))
    }

    @MainActor
    func testTodoBuilderSanitizesLeadingWhitespaceAndNewlinesFromPayload() throws {
        let block = MigratedDocumentBlock(
            id: "todo-legacy-leading-break",
            type: "todo_item",
            text: [
                MigratedInlineText(
                    text: "\n\t  修复历史数据",
                    bold: false,
                    italic: false,
                    underline: false,
                    strikethrough: false,
                    textColor: nil,
                    backgroundColor: nil,
                    link: nil,
                    fontFamily: nil,
                    fontSize: nil,
                    kern: nil,
                    baselineOffset: nil,
                    paragraphStyle: nil
                )
            ],
            level: nil,
            listStyle: nil,
            order: nil,
            checked: false,
            indent: 0,
            asset: nil,
            table: nil
        )

        let restored = try buildAttributedContent(from: [block])
        XCTAssertTrue(restored.string.contains("\u{FFFC} 修复历史数据"), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("\u{FFFC} \n"), "restored=\(restored.string)")
    }

    @MainActor
    func testLegacyConverterTodoSkipsCorruptedAttachmentRangeAndLeadingLineBreak() throws {
        let content = NSMutableAttributedString()
        let checkbox = CheckboxTextAttachment(checked: true)
        content.append(NSAttributedString(attachment: checkbox))
        content.append(NSAttributedString(string: " \n历史待办"))
        content.addAttribute(.attachment, value: checkbox, range: NSRange(location: 0, length: 3))

        let workingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workingDirectory) }

        var converter = try LegacyNoteDocumentConverter(noteID: UUID(), noteDirectory: workingDirectory)
        let conversion = try converter.convert(content: content)
        let first = try XCTUnwrap(conversion.document.blocks.first)
        XCTAssertEqual(first.type, "todo_item")
        XCTAssertEqual(first.checked, true)
        XCTAssertEqual(first.text?.map(\.text).joined(), "历史待办")
    }

    @MainActor
    func testLegacyConverterTreatsRecoveredSmallSquareAttachmentAsTodo() throws {
        let image = try makeLegacyCheckboxImage(size: 24)

        let genericAttachment = NSTextAttachment()
        genericAttachment.image = image
        genericAttachment.bounds = NSRect(x: 0, y: 0, width: 24, height: 24)

        let content = NSMutableAttributedString(attachment: genericAttachment)
        content.append(NSAttributedString(string: " 修复后不应换行"))

        let workingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workingDirectory) }

        var converter = try LegacyNoteDocumentConverter(noteID: UUID(), noteDirectory: workingDirectory)
        let conversion = try converter.convert(content: content)
        XCTAssertEqual(conversion.document.blocks.count, 1)
        let first = try XCTUnwrap(conversion.document.blocks.first)
        XCTAssertEqual(first.type, "todo_item")
        XCTAssertEqual(first.text?.map(\.text).joined(), "修复后不应换行")
    }

    @MainActor
    func testLegacyConverterSkipsDirectoryFileWrapperAttachmentWithoutCrashing() throws {
        let htmlData = Data("<table><tr><td>网页表格</td></tr></table>".utf8)
        let htmlWrapper = FileWrapper(regularFileWithContents: htmlData)
        htmlWrapper.preferredFilename = "index.html"
        let archiveWrapper = FileWrapper(directoryWithFileWrappers: ["index.html": htmlWrapper])
        archiveWrapper.preferredFilename = "table.rtfd"

        let attachment = NSTextAttachment(fileWrapper: archiveWrapper)
        let content = NSMutableAttributedString(attachment: attachment)
        content.append(NSAttributedString(string: " 表格后的文本"))

        let workingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workingDirectory) }

        var converter = try LegacyNoteDocumentConverter(noteID: UUID(), noteDirectory: workingDirectory)
        let conversion = try converter.convert(content: content)

        XCTAssertFalse(conversion.document.blocks.isEmpty)
        XCTAssertEqual(conversion.document.blocks.last?.text?.map(\.text).joined(), "表格后的文本")
    }

    @MainActor
    func testBuilderRecoversLegacyCheckboxImageBlockFollowedByParagraph() throws {
        let noteID = UUID()
        let tempRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let assetDirectory = tempRoot.appendingPathComponent("legacy", isDirectory: true)
        try FileManager.default.createDirectory(at: assetDirectory, withIntermediateDirectories: true)
        let assetFile = assetDirectory.appendingPathComponent("checkbox.png")

        let pngData = try makeLegacyCheckboxPNGData(size: 24)
        try pngData.write(to: assetFile)

        let imageBlock = BlockDocumentBlockEntity(
            noteID: noteID,
            position: 0,
            blockID: "block-image",
            kind: "image",
            sourceType: "image",
            textPayload: nil,
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: nil,
            assetID: "asset-1",
            tablePayload: nil
        )
        let paragraphBlock = BlockDocumentBlockEntity(
            noteID: noteID,
            position: 1,
            blockID: "block-paragraph",
            kind: "paragraph",
            sourceType: "paragraph",
            textPayload: try encodeTextPayload([
                MigratedInlineText(
                    text: "重启后同一行展示",
                    bold: false,
                    italic: false,
                    underline: false,
                    strikethrough: false,
                    textColor: nil,
                    backgroundColor: nil,
                    link: nil,
                    fontFamily: nil,
                    fontSize: nil,
                    kern: nil,
                    baselineOffset: nil,
                    paragraphStyle: nil
                )
            ]),
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: 0,
            assetID: nil,
            tablePayload: nil
        )
        let asset = BlockDocumentAssetEntity(
            noteID: noteID,
            assetID: "asset-1",
            kind: "image",
            sourceKind: "image",
            filename: "checkbox.png",
            mimeType: "image/png",
            width: 24,
            height: 24,
            duration: nil,
            createdAt: nil,
            relativeFilePath: "legacy/checkbox.png",
            sidecarPathsPayload: nil
        )

        let restored = BlockDocumentAttributedStringBuilder(attachmentsRoot: tempRoot).build(
            blocks: [imageBlock, paragraphBlock],
            assetsByID: ["asset-1": asset]
        )

        XCTAssertTrue(hasCheckboxAttachment(in: restored), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("\u{FFFC}\n"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("\u{FFFC} 重启后同一行展示"), "restored=\(restored.string)")
    }

    @MainActor
    func testNoteStoreFetchDataRecoversLegacyCheckboxImageParagraphAfterRestart() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let noteID = UUID()

        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }
        try storage.ensureDirectoryStructureExists()

        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let legacyDir = attachmentsRoot.appendingPathComponent("legacy", isDirectory: true)
        try FileManager.default.createDirectory(at: legacyDir, withIntermediateDirectories: true)
        let imageFile = legacyDir.appendingPathComponent("legacy-checkbox.png")

        let pngData = try makeLegacyCheckboxPNGData(size: 24)
        try pngData.write(to: imageFile)

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
                title: "重启恢复测试",
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
                documentSource: "legacy",
                blockCount: 2,
                assetCount: 1
            )
        )
        context.insert(
            BlockDocumentAssetEntity(
                noteID: noteID,
                assetID: "asset-legacy-checkbox",
                kind: "image",
                sourceKind: "image",
                filename: "legacy-checkbox.png",
                mimeType: "image/png",
                width: nil,
                height: nil,
                duration: nil,
                createdAt: nil,
                relativeFilePath: "legacy/legacy-checkbox.png",
                sidecarPathsPayload: nil
            )
        )
        context.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 0,
                blockID: "block-legacy-image",
                kind: "image",
                sourceType: "image",
                textPayload: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: 0,
                assetID: "asset-legacy-checkbox",
                tablePayload: nil
            )
        )
        context.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 1,
                blockID: "block-legacy-paragraph",
                kind: "paragraph",
                sourceType: "paragraph",
                textPayload: try encodeTextPayload([
                    MigratedInlineText(
                        text: "退出重进后仍应同一行",
                        bold: false,
                        italic: false,
                        underline: false,
                        strikethrough: false,
                        textColor: nil,
                        backgroundColor: nil,
                        link: nil,
                        fontFamily: nil,
                        fontSize: nil,
                        kern: nil,
                        baselineOffset: nil,
                        paragraphStyle: nil
                    )
                ]),
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: 0,
                assetID: nil,
                tablePayload: nil
            )
        )
        try context.save()

        let store = NoteStore()
        store.setContext(context)

        XCTAssertFalse(try XCTUnwrap(store.activeNotes.first(where: { $0.id == noteID })).isContentLoaded)
        let note = try XCTUnwrap(store.ensureNoteContentLoaded(id: noteID))
        XCTAssertTrue(hasCheckboxAttachment(in: note.content), "content=\(note.content.string)")
        XCTAssertFalse(note.content.string.contains("\u{FFFC}\n"), "content=\(note.content.string)")
        XCTAssertTrue(note.content.string.contains("\u{FFFC} 退出重进后仍应同一行"), "content=\(note.content.string)")
    }

    @MainActor
    func testSaveThenFetchRoundTripKeepsRecoveredLegacyCheckboxTextOnSameLine() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let noteID = UUID()
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }
        try storage.ensureDirectoryStructureExists()

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
                title: "保存后重启测试",
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

        NoteSaveManager.shared.setContext(context)

        let legacyImage = try makeLegacyCheckboxImage(size: 24)

        let attachment = NSTextAttachment()
        attachment.image = legacyImage
        attachment.bounds = NSRect(x: 0, y: 0, width: 24, height: 24)

        let content = NSMutableAttributedString(attachment: attachment)
        content.append(NSAttributedString(string: " 重启后不下沉"))

        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "保存后重启测试",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: content,
                reason: "unit_test_round_trip"
            )
        )
        let result = NoteSaveManager.shared.saveImmediately(request: request)
        if case .failure(let error) = result {
            XCTFail("save failed: \(error.localizedDescription)")
        }

        let persistedBlocks = try context.fetch(
            FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID }
            )
        ).sorted { $0.position < $1.position }
        XCTAssertEqual(persistedBlocks.count, 1)
        XCTAssertEqual(persistedBlocks.first?.kind, "todo_item")

        let restartedStore = NoteStore()
        restartedStore.setContext(context)

        XCTAssertFalse(try XCTUnwrap(restartedStore.activeNotes.first(where: { $0.id == noteID })).isContentLoaded)
        let restored = try XCTUnwrap(restartedStore.ensureNoteContentLoaded(id: noteID)?.content)
        XCTAssertTrue(hasCheckboxAttachment(in: restored), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("\u{FFFC}\n"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("\u{FFFC} 重启后不下沉"), "restored=\(restored.string)")
    }

    @MainActor
    func testSaveThenFetchRoundTripPreservesBulletDashAndOrderedListsOnSameLine() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let noteID = UUID()
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }
        try storage.ensureDirectoryStructureExists()

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
                title: "列表重启测试",
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

        NoteSaveManager.shared.setContext(context)

        let rawContent = NSMutableAttributedString(
            string: "• \u{2028}项目符号项\n- \u{2029}短划线项\n7. \u{2028}编号项"
        )
        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "列表重启测试",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: rawContent,
                reason: "unit_test_list_round_trip"
            )
        )
        let result = NoteSaveManager.shared.saveImmediately(request: request)
        if case .failure(let error) = result {
            XCTFail("save failed: \(error.localizedDescription)")
        }

        let persistedBlocks = try context.fetch(
            FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID }
            )
        ).sorted { $0.position < $1.position }
        XCTAssertEqual(persistedBlocks.map(\.kind), ["list_item", "list_item", "list_item"])
        XCTAssertEqual(persistedBlocks.map(\.listStyle), ["bullet", "dash", "ordered"])
        XCTAssertEqual(persistedBlocks[2].order, 7)

        let restartedStore = NoteStore()
        restartedStore.setContext(context)
        XCTAssertFalse(try XCTUnwrap(restartedStore.activeNotes.first(where: { $0.id == noteID })).isContentLoaded)
        let restored = try XCTUnwrap(restartedStore.ensureNoteContentLoaded(id: noteID)?.content)
        XCTAssertFalse(restored.string.contains("• \n"), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("- \n"), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("7. \n"), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("\u{2028}"), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("\u{2029}"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("• 项目符号项"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("- 短划线项"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("7. 编号项"), "restored=\(restored.string)")
    }

    @MainActor
    func testFetchDataSanitizesLeadingLineBreaksForStoredListItems() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
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
                title: "列表脏数据恢复",
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
                documentSource: "legacy",
                blockCount: 3,
                assetCount: 0
            )
        )
        context.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 0,
                blockID: "legacy-list-bullet",
                kind: "list_item",
                sourceType: "list_item",
                textPayload: try encodeTextPayload([
                    MigratedInlineText(
                        text: "\n项目符号恢复",
                        bold: false,
                        italic: false,
                        underline: false,
                        strikethrough: false,
                        textColor: nil,
                        backgroundColor: nil,
                        link: nil,
                        fontFamily: nil,
                        fontSize: nil,
                        kern: nil,
                        baselineOffset: nil,
                        paragraphStyle: nil
                    )
                ]),
                level: nil,
                listStyle: "bullet",
                order: nil,
                checked: nil,
                indent: 0,
                assetID: nil,
                tablePayload: nil
            )
        )
        context.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 1,
                blockID: "legacy-list-dash",
                kind: "list_item",
                sourceType: "list_item",
                textPayload: try encodeTextPayload([
                    MigratedInlineText(
                        text: "\r\n短划线恢复",
                        bold: false,
                        italic: false,
                        underline: false,
                        strikethrough: false,
                        textColor: nil,
                        backgroundColor: nil,
                        link: nil,
                        fontFamily: nil,
                        fontSize: nil,
                        kern: nil,
                        baselineOffset: nil,
                        paragraphStyle: nil
                    )
                ]),
                level: nil,
                listStyle: "dash",
                order: nil,
                checked: nil,
                indent: 0,
                assetID: nil,
                tablePayload: nil
            )
        )
        context.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 2,
                blockID: "legacy-list-ordered",
                kind: "list_item",
                sourceType: "list_item",
                textPayload: try encodeTextPayload([
                    MigratedInlineText(
                        text: "\u{2029}编号恢复",
                        bold: false,
                        italic: false,
                        underline: false,
                        strikethrough: false,
                        textColor: nil,
                        backgroundColor: nil,
                        link: nil,
                        fontFamily: nil,
                        fontSize: nil,
                        kern: nil,
                        baselineOffset: nil,
                        paragraphStyle: nil
                    )
                ]),
                level: nil,
                listStyle: "ordered",
                order: 5,
                checked: nil,
                indent: 0,
                assetID: nil,
                tablePayload: nil
            )
        )
        try context.save()

        let store = NoteStore()
        store.setContext(context)
        XCTAssertFalse(try XCTUnwrap(store.activeNotes.first(where: { $0.id == noteID })).isContentLoaded)
        let restored = try XCTUnwrap(store.ensureNoteContentLoaded(id: noteID)?.content)
        XCTAssertFalse(restored.string.contains("• \n"), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("- \n"), "restored=\(restored.string)")
        XCTAssertFalse(restored.string.contains("5. \n"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("• 项目符号恢复"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("- 短划线恢复"), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("5. 编号恢复"), "restored=\(restored.string)")
    }

    @MainActor
    func testAdvancedTextAttributesRoundTripPreservesKernBaselineAndParagraphStyle() throws {
        let span = MigratedInlineText(
            text: "高级格式",
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            textColor: nil,
            backgroundColor: nil,
            link: nil,
            fontFamily: nil,
            fontSize: 16,
            kern: 1.5,
            baselineOffset: 2.0,
            paragraphStyle: MigratedParagraphStyle(
                alignment: NSTextAlignment.center.rawValue,
                lineSpacing: 6,
                paragraphSpacing: 10,
                paragraphSpacingBefore: nil,
                firstLineHeadIndent: nil,
                headIndent: nil,
                tailIndent: nil
            )
        )

        let payload = try XCTUnwrap(encodeTextPayload([span]))
        let decoded = try JSONDecoder().decode([BlockDocumentTextSpanPayload].self, from: payload)
        let firstPayload = try XCTUnwrap(decoded.first)
        XCTAssertEqual(try XCTUnwrap(firstPayload.kern), 1.5, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(firstPayload.baselineOffset), 2.0, accuracy: 0.001)
        XCTAssertEqual(firstPayload.paragraphStyle?.alignment, NSTextAlignment.center.rawValue)
        XCTAssertEqual(try XCTUnwrap(firstPayload.paragraphStyle?.lineSpacing), 6, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(firstPayload.paragraphStyle?.paragraphSpacing), 10, accuracy: 0.001)

        let block = MigratedDocumentBlock(
            id: "paragraph-1",
            type: "paragraph",
            text: [span],
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: nil,
            asset: nil,
            table: nil
        )
        let restored = try buildAttributedContent(from: [block])
        XCTAssertEqual(
            try XCTUnwrap((restored.attribute(.kern, at: 0, effectiveRange: nil) as? NSNumber)?.doubleValue),
            1.5,
            accuracy: 0.001
        )
        XCTAssertEqual(
            try XCTUnwrap((restored.attribute(.baselineOffset, at: 0, effectiveRange: nil) as? NSNumber)?.doubleValue),
            2.0,
            accuracy: 0.001
        )
        let restoredStyle = try XCTUnwrap(restored.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(restoredStyle.alignment, .center)
        XCTAssertEqual(restoredStyle.lineSpacing, 6, accuracy: 0.001)
        XCTAssertEqual(restoredStyle.paragraphSpacing, 10, accuracy: 0.001)
    }

    @MainActor
    func testCreateRequestRelocatesCrossNoteImageAttachmentToCurrentNoteFolder() throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()

        let sourceNoteID = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
        let targetNoteID = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let sourceFolder = attachmentsRoot.appendingPathComponent(sourceNoteID.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: sourceFolder, withIntermediateDirectories: true)

        let sourceImageURL = sourceFolder.appendingPathComponent("shared.png")
        let imageData = try makeFilledPNGData(size: NSSize(width: 1, height: 1), color: .systemBlue)
        try imageData.write(to: sourceImageURL)

        let attachment = AttachmentTextAttachment(
            fileURL: sourceImageURL,
            kind: .image,
            embeddedFileData: imageData,
            attachmentFilename: "shared.png"
        )
        attachment.bounds = NSRect(x: 0, y: 0, width: 120, height: 80)

        let content = NSMutableAttributedString(attachment: attachment)
        let range = NSRange(location: 0, length: content.length)
        content.addAttribute(.notebookImageWidth, value: CGFloat(120), range: range)
        content.addAttribute(.notebookImageHeight, value: CGFloat(80), range: range)
        content.addAttribute(.link, value: "notebook-image://\(sourceImageURL.absoluteString)#w=120&h=80", range: range)

        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: targetNoteID,
                title: "跨笔记图片",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: content,
                reason: "test"
            )
        )

        let decoded = try XCTUnwrap(
            try NSAttributedString(
                data: request.rtfdData,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            )
        )

        let decodedLinkValue = try XCTUnwrap(decoded.attribute(.link, at: 0, effectiveRange: nil))
        let decodedLink: String
        if let linkString = decodedLinkValue as? String {
            decodedLink = linkString
        } else if let linkURL = decodedLinkValue as? URL {
            decodedLink = linkURL.absoluteString
        } else {
            XCTFail("Unexpected image link type: \(type(of: decodedLinkValue))")
            return
        }

        XCTAssertTrue(decodedLink.contains(targetNoteID.uuidString), "decoded image link: \(decodedLink)")
        XCTAssertFalse(decodedLink.contains(sourceNoteID.uuidString), "decoded image link: \(decodedLink)")

        let targetFolder = attachmentsRoot.appendingPathComponent(targetNoteID.uuidString, isDirectory: true)
        let targetFiles = try FileManager.default.contentsOfDirectory(at: targetFolder, includingPropertiesForKeys: nil)
        XCTAssertEqual(targetFiles.count, 1, "target image files: \(targetFiles.map { $0.lastPathComponent })")
        XCTAssertEqual(targetFiles.first?.pathExtension, "png", "target image files: \(targetFiles.map { $0.lastPathComponent })")
    }

    @MainActor
    func testCreateRequestRelocatesCrossNoteAudioAttachmentAndManifest() throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()

        let sourceNoteID = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        let targetNoteID = UUID(uuidString: "44444444-4444-4444-4444-444444444444")!
        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let sourceFolder = attachmentsRoot.appendingPathComponent(sourceNoteID.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: sourceFolder, withIntermediateDirectories: true)

        let sourceAudioURL = sourceFolder.appendingPathComponent("voice.m4a")
        let sourceManifestURL = sourceFolder.appendingPathComponent("voice.tracks.json")
        try Data([0x10, 0x20, 0x30]).write(to: sourceAudioURL)
        try Data("{\"channels\":2}".utf8).write(to: sourceManifestURL)

        let attachment = AudioBlockAttachment(
            fileURL: sourceAudioURL,
            duration: 6,
            createDate: Date(),
            embeddedAudioData: Data([0x10, 0x20, 0x30]),
            attachmentFilename: "voice.m4a",
            embeddedManifestData: Data("{\"channels\":2}".utf8)
        )

        let content = NSMutableAttributedString(attachment: attachment)
        content.addAttribute(.link, value: sourceAudioURL, range: NSRange(location: 0, length: content.length))

        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: targetNoteID,
                title: "跨笔记音频",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: content,
                reason: "test"
            )
        )

        let decoded = try XCTUnwrap(
            try NSAttributedString(
                data: request.rtfdData,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            )
        )

        let decodedLinkValue = try XCTUnwrap(decoded.attribute(.link, at: 0, effectiveRange: nil))
        let decodedLinkURL: URL
        if let linkURL = decodedLinkValue as? URL {
            decodedLinkURL = linkURL
        } else if let linkString = decodedLinkValue as? String, let linkURL = URL(string: linkString) {
            decodedLinkURL = linkURL
        } else {
            XCTFail("Unexpected audio link type: \(type(of: decodedLinkValue))")
            return
        }

        XCTAssertTrue(decodedLinkURL.path.contains(targetNoteID.uuidString), "decoded audio link: \(decodedLinkURL)")
        XCTAssertFalse(decodedLinkURL.path.contains(sourceNoteID.uuidString), "decoded audio link: \(decodedLinkURL)")

        let targetFolder = attachmentsRoot.appendingPathComponent(targetNoteID.uuidString, isDirectory: true)
        let targetFiles = try FileManager.default.contentsOfDirectory(at: targetFolder, includingPropertiesForKeys: nil)
        XCTAssertEqual(targetFiles.count, 2, "target audio files: \(targetFiles.map { $0.lastPathComponent })")
        XCTAssertTrue(targetFiles.contains(where: { $0.pathExtension == "m4a" }), "target audio files: \(targetFiles.map { $0.lastPathComponent })")
        XCTAssertTrue(targetFiles.contains(where: { $0.lastPathComponent.hasSuffix(".tracks.json") }), "target audio files: \(targetFiles.map { $0.lastPathComponent })")

        let targetAudioURL = try XCTUnwrap(targetFiles.first(where: { $0.pathExtension == "m4a" }))
        let targetManifestURL = targetAudioURL.deletingPathExtension().appendingPathExtension("tracks.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetManifestURL.path))
    }


    func testBuilderRecoversLegacyCheckboxImageBlockWhenAssetSizeMissing() throws {
        let noteID = UUID()
        let tempRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let assetDirectory = tempRoot.appendingPathComponent("legacy", isDirectory: true)
        try FileManager.default.createDirectory(at: assetDirectory, withIntermediateDirectories: true)
        let assetFile = assetDirectory.appendingPathComponent("checkbox-missing-size.png")

        let pngData = try makeLegacyCheckboxPNGData(size: 22)
        try pngData.write(to: assetFile)

        let imageBlock = BlockDocumentBlockEntity(
            noteID: noteID,
            position: 0,
            blockID: "block-image-missing-size",
            kind: "image",
            sourceType: "image",
            textPayload: nil,
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: nil,
            assetID: "asset-missing-size",
            tablePayload: nil
        )
        let paragraphBlock = BlockDocumentBlockEntity(
            noteID: noteID,
            position: 1,
            blockID: "block-paragraph-missing-size",
            kind: "paragraph",
            sourceType: "paragraph",
            textPayload: try encodeTextPayload([
                MigratedInlineText(
                    text: "缺失尺寸也要恢复",
                    bold: false,
                    italic: false,
                    underline: false,
                    strikethrough: false,
                    textColor: nil,
                    backgroundColor: nil,
                    link: nil,
                    fontFamily: nil,
                    fontSize: nil,
                    kern: nil,
                    baselineOffset: nil,
                    paragraphStyle: nil
                )
            ]),
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: 0,
            assetID: nil,
            tablePayload: nil
        )
        let asset = BlockDocumentAssetEntity(
            noteID: noteID,
            assetID: "asset-missing-size",
            kind: "image",
            sourceKind: "image",
            filename: "checkbox-missing-size.png",
            mimeType: "image/png",
            width: nil,
            height: nil,
            duration: nil,
            createdAt: nil,
            relativeFilePath: "legacy/checkbox-missing-size.png",
            sidecarPathsPayload: nil
        )

        let restored = BlockDocumentAttributedStringBuilder(attachmentsRoot: tempRoot).build(
            blocks: [imageBlock, paragraphBlock],
            assetsByID: ["asset-missing-size": asset]
        )

        XCTAssertTrue(hasCheckboxAttachment(in: restored), "restored=\(restored.string)")
        XCTAssertTrue(restored.string.contains("\u{FFFC} 缺失尺寸也要恢复"), "restored=\(restored.string)")
    }

    func testHeadingRoundTripPreservesExplicitHeadingLevelAndSize() throws {
        let block = MigratedDocumentBlock(
            id: "heading-1",
            type: "heading",
            text: [
                MigratedInlineText(
                    text: "一级标题",
                    bold: false,
                    italic: false,
                    underline: false,
                    strikethrough: false,
                    textColor: nil,
                    backgroundColor: nil,
                    link: nil,
                    fontFamily: nil,
                    fontSize: nil,
                    kern: nil,
                    baselineOffset: nil,
                    paragraphStyle: nil
                )
            ],
            level: 1,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: nil,
            asset: nil,
            table: nil
        )

        let restored = try buildAttributedContent(from: [block])
        let restoredLevel = headingLevel(in: restored, at: 0)
        let restoredFont = try XCTUnwrap(restored.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        XCTAssertEqual(restored.string, "一级标题")
        XCTAssertEqual(restoredLevel, 1)
        XCTAssertEqual(restoredFont.pointSize, 22, accuracy: 0.01)
    }
}
