import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook

extension NotebookTests {
    @MainActor
    func testAsyncLongDocumentLoadMatchesSynchronousContent() async throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "长文档")
        let payload = try JSONEncoder().encode([
            BlockDocumentTextSpanPayload(
                text: "一段正文",
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
        ])
        let blockCount = 2_000
        for position in 0..<blockCount {
            context.insert(
                BlockDocumentBlockEntity(
                    noteID: noteID,
                    position: position,
                    blockID: "block-\(position)",
                    kind: "paragraph",
                    sourceType: "paragraph",
                    textPayload: payload,
                    level: nil,
                    listStyle: nil,
                    order: nil,
                    checked: nil,
                    indent: nil,
                    assetID: nil,
                    tablePayload: nil
                )
            )
        }
        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        let noteEntity = try XCTUnwrap(context.fetch(noteDescriptor).first)
        noteEntity.blockCount = blockCount
        try context.save()

        let store = NoteStore()
        store.setContext(context)
        let metadataOnlyNote = try XCTUnwrap(store.notes.first(where: { $0.id == noteID }))
        XCTAssertFalse(metadataOnlyNote.isContentLoaded)
        XCTAssertTrue(metadataOnlyNote.content.string.isEmpty)

        let asyncLoaded = await store.ensureNoteContentLoadedAsync(id: noteID, rememberSelection: true)
        let loaded = try XCTUnwrap(asyncLoaded)
        XCTAssertTrue(loaded.isContentLoaded)
        XCTAssertEqual(loaded.content.string.components(separatedBy: "\n").count, blockCount)
        XCTAssertTrue(loaded.content.string.hasPrefix("一段正文\n一段正文"))
        XCTAssertTrue(loaded.content.string.hasSuffix("一段正文"))
        XCTAssertFalse(store.loadingNoteIDs.contains(noteID))
        XCTAssertNil(store.noteContentLoadErrors[noteID])
    }

    @MainActor
    func testCancelledLongDocumentLoadDoesNotPublishPartialContent() async throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "可取消长文档")
        let payload = try JSONEncoder().encode([
            BlockDocumentTextSpanPayload(
                text: String(repeating: "内容", count: 40),
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
        ])
        for position in 0..<3_000 {
            context.insert(
                BlockDocumentBlockEntity(
                    noteID: noteID,
                    position: position,
                    blockID: "cancel-\(position)",
                    kind: "paragraph",
                    sourceType: "paragraph",
                    textPayload: payload,
                    level: nil,
                    listStyle: nil,
                    order: nil,
                    checked: nil,
                    indent: nil,
                    assetID: nil,
                    tablePayload: nil
                )
            )
        }
        try context.save()

        let store = NoteStore()
        store.setContext(context)
        let task = Task {
            await store.ensureNoteContentLoadedAsync(id: noteID)
        }
        task.cancel()
        let cancelledResult = await task.value
        XCTAssertNil(cancelledResult)

        let note = try XCTUnwrap(store.notes.first(where: { $0.id == noteID }))
        XCTAssertFalse(note.isContentLoaded)
        XCTAssertTrue(note.content.string.isEmpty)
        XCTAssertFalse(store.loadingNoteIDs.contains(noteID))
    }

    @MainActor
    func testMetadataRefreshRetainsLoadedContentUntilDatabaseVersionChanges() async throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "刷新保护")
        let payload = try JSONEncoder().encode([
            BlockDocumentTextSpanPayload(
                text: "不能被前台刷新清空",
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
        ])
        context.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 0,
                blockID: "refresh-0",
                kind: "paragraph",
                sourceType: "paragraph",
                textPayload: payload,
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
        _ = await store.ensureNoteContentLoadedAsync(id: noteID)
        XCTAssertEqual(try XCTUnwrap(store.notes.first(where: { $0.id == noteID })).content.string, "不能被前台刷新清空")

        store.fetchData()
        let retained = try XCTUnwrap(store.notes.first(where: { $0.id == noteID }))
        XCTAssertTrue(retained.isContentLoaded)
        XCTAssertEqual(retained.content.string, "不能被前台刷新清空")

        let entity = try XCTUnwrap(
            context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        entity.version += 1
        try context.save()
        store.fetchData()
        let invalidated = try XCTUnwrap(store.notes.first(where: { $0.id == noteID }))
        XCTAssertFalse(invalidated.isContentLoaded)
        XCTAssertTrue(invalidated.content.string.isEmpty)
    }

    @MainActor
    func testLongDocumentLayoutUsesNonContiguousViewportLayout() {
        let textView = RichTextView()
        RichTextEditor.configureViewportLayout(
            in: textView,
            contentLength: RichTextEditor.longDocumentCharacterThreshold
        )

        XCTAssertEqual(textView.layoutManager?.allowsNonContiguousLayout, true)
        XCTAssertEqual(textView.isAutomaticLinkDetectionEnabled, false)
    }

    @MainActor
    func testLongDocumentTypingDefersFullBindingCopyButSwitchCanFlushIt() {
        let noteID = UUID()
        let controller = RichTextController()
        var boundContent = NSAttributedString(string: "旧内容")
        let coordinator = RichTextEditor.Coordinator(
            attributedText: Binding(
                get: { boundContent },
                set: { boundContent = $0 }
            ),
            controller: controller
        )
        let textView = RichTextView()
        controller.bind(textView: textView, noteID: noteID)
        textView.textStorage?.setAttributedString(
            NSAttributedString(
                string: String(
                    repeating: "长文档输入内容",
                    count: RichTextEditor.longDocumentCharacterThreshold / 7 + 1
                )
            )
        )

        coordinator.textDidChange(
            Notification(name: NSText.didChangeNotification, object: textView)
        )
        XCTAssertEqual(boundContent.string, "旧内容")
        XCTAssertTrue(controller.requiresCommittedSnapshotOnSwitch)

        coordinator.flushDeferredBindingUpdate()
        XCTAssertEqual(boundContent.string, textView.string)
        XCTAssertFalse(controller.requiresCommittedSnapshotOnSwitch)
    }

    @MainActor
    func testLargeTextEditSaveAndAsyncReloadPreservesEveryCharacter() async throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "保存回归长文档")
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        StorageLocationManager.shared.setBaseDirectoryForTesting(baseDirectory)
        defer {
            StorageLocationManager.shared.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }
        try StorageLocationManager.shared.ensureDirectoryStructureExists()
        NoteSaveManager.shared.setContext(context)

        let original = (0..<12_000)
            .map { "第\($0)行-" + String(repeating: "长篇正文", count: 10) }
            .joined(separator: "\n")
        let edited = original + "\n尾部安全标记-必须完整保留"
        let store = NoteStore()
        store.setContext(context)
        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "保存回归长文档",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: NSAttributedString(string: edited),
                reason: "longDocumentRegression"
            )
        )
        guard case .success = NoteSaveManager.shared.saveImmediately(request: request) else {
            return XCTFail("Long document save failed")
        }
        let savedEntity = try XCTUnwrap(
            context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        XCTAssertLessThanOrEqual(savedEntity.blockCount, 50)
        store.markNoteContentUpdated(id: noteID, content: NSAttributedString(string: edited))

        let restartedStore = NoteStore()
        restartedStore.setContext(context)
        XCTAssertFalse(try XCTUnwrap(restartedStore.notes.first(where: { $0.id == noteID })).isContentLoaded)
        let reloaded = await restartedStore.ensureNoteContentLoadedAsync(id: noteID)

        XCTAssertEqual(try XCTUnwrap(reloaded).content.string, edited)
        XCTAssertTrue(try XCTUnwrap(reloaded).content.string.hasSuffix("尾部安全标记-必须完整保留"))
    }

    @MainActor
    func testLongDocumentCompactionPreservesHeadingBoundaryAndFormatting() async throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "混合语义长文档")
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        StorageLocationManager.shared.setBaseDirectoryForTesting(baseDirectory)
        defer {
            StorageLocationManager.shared.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }
        try StorageLocationManager.shared.ensureDirectoryStructureExists()
        NoteSaveManager.shared.setContext(context)

        let before = (0..<300).map { "前段\($0)" }.joined(separator: "\n")
        let heading = "关键标题"
        let after = (0..<300).map { "后段\($0)" }.joined(separator: "\n")
        let plain = before + "\n" + heading + "\n" + after
        let content = NSMutableAttributedString(string: plain)
        let headingRange = (plain as NSString).range(of: heading)
        content.addAttribute(.notebookHeadingLevel, value: 2, range: headingRange)
        content.addAttribute(.font, value: NSFont.boldSystemFont(ofSize: 22), range: headingRange)

        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "混合语义长文档",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: content,
                reason: "longDocumentSemanticRegression"
            )
        )
        guard case .success = NoteSaveManager.shared.saveImmediately(request: request) else {
            return XCTFail("Long semantic document save failed")
        }

        let blockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
            predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID },
            sortBy: [SortDescriptor(\.position)]
        )
        let blocks = try context.fetch(blockDescriptor)
        XCTAssertLessThanOrEqual(blocks.count, 5)
        XCTAssertEqual(blocks.filter { $0.kind == "heading" }.count, 1)

        let restartedStore = NoteStore()
        restartedStore.setContext(context)
        let reloadedResult = await restartedStore.ensureNoteContentLoadedAsync(id: noteID)
        let reloaded = try XCTUnwrap(reloadedResult)
        XCTAssertEqual(reloaded.content.string, plain)
        XCTAssertEqual(headingLevel(in: reloaded.content, at: headingRange.location), 2)
    }
}
