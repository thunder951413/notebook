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
}
