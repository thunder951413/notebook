import XCTest
import SwiftData
import AppKit
@testable import Notebook

extension NotebookTests {
    func testTextNoteFileImporterLoadsMarkdownAndUsesFilenameAsTitle() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let fileURL = directory.appendingPathComponent("小说设定.md")
        let markdown = "# 世界观\n\n- 城市\n- 人物"
        try Data(markdown.utf8).write(to: fileURL)

        let imported = try TextNoteFileImporter.load(fileURL)
        XCTAssertEqual(imported.title, "小说设定")
        XCTAssertEqual(imported.content, markdown)
        XCTAssertEqual(imported.sourceURL, fileURL)
    }

    func testTextNoteFileImporterLoadsUTF16Text() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let fileURL = directory.appendingPathComponent("旧文本.txt")
        let text = "第一章\n这是 UTF-16 文本。"
        try XCTUnwrap(text.data(using: .utf16)).write(to: fileURL)

        XCTAssertEqual(try TextNoteFileImporter.load(fileURL).content, text)
    }

    func testTextNoteFileImporterRejectsUnsupportedExtension() throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("archive.pdf")
        XCTAssertThrowsError(try TextNoteFileImporter.load(fileURL)) { error in
            guard case TextNoteFileImportError.unsupportedType = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    @MainActor
    func testImportTextNotePersistsContentInSelectedFolder() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let folderID = UUID()
        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 0,
                folderCount: 1,
                tagCount: 0
            )
        )
        context.insert(
            BlockDocumentFolderEntity(
                id: folderID,
                libraryID: libraryID,
                name: "写作",
                sortOrder: 0,
                isSystem: false,
                createdAt: Date()
            )
        )
        try context.save()

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

        let store = NoteStore()
        store.setContext(context)
        let document = ImportedTextNoteFile(
            sourceURL: baseDirectory.appendingPathComponent("导入章节.md"),
            title: "导入章节",
            content: "# 第一章\n\n正文内容"
        )
        let target = TextNoteImportTarget(
            folderID: folderID,
            folderName: "写作",
            encryptedFolderID: nil,
            tagID: nil
        )

        let imported = try XCTUnwrap(store.importTextNote(document, target: target))
        XCTAssertEqual(imported.title, "导入章节")
        XCTAssertEqual(imported.folderID, folderID)
        XCTAssertEqual(imported.folder, "写作")
        XCTAssertEqual(imported.content.string, document.content)

        let importedID = imported.id
        let entity = try XCTUnwrap(
            context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == importedID }
                )
            ).first
        )
        XCTAssertGreaterThan(entity.version, 0)
        XCTAssertEqual(entity.blockCount, 3)
        XCTAssertEqual(
            store.ensureNoteContentLoaded(id: imported.id)?.content.string,
            document.content
        )
    }

    @MainActor
    func testAsyncLargeTextImportKeepsMainActorResponsiveAndPersistsEveryCharacter() async throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 0,
                folderCount: 0,
                tagCount: 0
            )
        )
        try context.save()

        let content = (0..<12_000)
            .map { "第\($0)行-" + String(repeating: "大文档安全导入", count: 6) }
            .joined(separator: "\r\n") + "\r\n尾部完整性标记"
        let expected = content.replacingOccurrences(of: "\r\n", with: "\n")
        let document = ImportedTextNoteFile(
            sourceURL: URL(fileURLWithPath: "/tmp/大文档.md"),
            title: "大文档",
            content: content
        )
        let target = TextNoteImportTarget(
            folderID: nil,
            folderName: "未分类",
            encryptedFolderID: nil,
            tagID: nil
        )
        let store = NoteStore()
        store.setContext(context)

        var mainActorProgressed = false
        Task { @MainActor in
            await Task.yield()
            mainActorProgressed = true
        }
        let importedResult = await store.importTextNoteAsync(document, target: target)
        let imported = try XCTUnwrap(importedResult)

        XCTAssertTrue(mainActorProgressed)
        XCTAssertEqual(imported.content.string, expected)
        XCTAssertTrue(imported.content.string.hasSuffix("尾部完整性标记"))
        let importedID = imported.id
        let entity = try XCTUnwrap(
            context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == importedID }
                )
            ).first
        )
        XCTAssertEqual(entity.blockCount, 47)
        XCTAssertEqual(try BlockDocumentNoteVersionStore.history(for: importedID, context: context).count, 1)

        let restartedStore = NoteStore()
        restartedStore.setContext(context)
        XCTAssertFalse(try XCTUnwrap(restartedStore.notes.first(where: { $0.id == importedID })).isContentLoaded)
        let reloadedResult = await restartedStore.ensureNoteContentLoadedAsync(id: importedID)
        XCTAssertEqual(try XCTUnwrap(reloadedResult).content.string, expected)
    }

    @MainActor
    func testCancelledAsyncTextImportRollsBackMetadataBlocksAndHistory() async throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 0,
                folderCount: 0,
                tagCount: 0
            )
        )
        try context.save()

        let document = ImportedTextNoteFile(
            sourceURL: URL(fileURLWithPath: "/tmp/取消导入.md"),
            title: "取消导入",
            content: (0..<20_000).map { "第\($0)行" }.joined(separator: "\n")
        )
        let target = TextNoteImportTarget(
            folderID: nil,
            folderName: "未分类",
            encryptedFolderID: nil,
            tagID: nil
        )
        let store = NoteStore()
        store.setContext(context)
        let task = Task {
            await store.importTextNoteAsync(document, target: target)
        }
        task.cancel()

        let cancelledResult = await task.value
        XCTAssertNil(cancelledResult)
        XCTAssertTrue(store.notes.isEmpty)
        XCTAssertEqual(try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>()).count, 0)
        XCTAssertEqual(try context.fetch(FetchDescriptor<BlockDocumentBlockEntity>()).count, 0)
        XCTAssertEqual(try context.fetch(FetchDescriptor<BlockDocumentNoteVersionEntity>()).count, 0)
        XCTAssertEqual(
            try XCTUnwrap(context.fetch(FetchDescriptor<BlockDocumentLibraryEntity>()).first).noteCount,
            0
        )
    }
}
