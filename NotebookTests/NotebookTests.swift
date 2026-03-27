import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook

final class NotebookTests: XCTestCase {
    private static let sharedStateLock = DispatchSemaphore(value: 1)

    @MainActor
    override func setUpWithError() throws {
        try super.setUpWithError()
        Self.sharedStateLock.wait()
        resetSharedTestState()
    }

    @MainActor
    override func tearDownWithError() throws {
        resetSharedTestState()
        Self.sharedStateLock.signal()
        try super.tearDownWithError()
    }

    func testAppModuleLoads() {
        XCTAssertTrue(true)
    }

    @MainActor
    func testBlockDocumentNoteMovesToRecycleBinAndRestores() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let folderID = UUID()
        let noteID = UUID()

        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 1,
                folderCount: 1,
                tagCount: 0
            )
        )
        context.insert(
            BlockDocumentFolderEntity(
                id: folderID,
                libraryID: libraryID,
                name: "工作",
                sortOrder: 0,
                isSystem: false,
                createdAt: Date()
            )
        )
        context.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "块级笔记",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: folderID,
                folderName: "工作",
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

        let store = NoteStore()
        store.setContext(context)

        XCTAssertTrue(store.isUsingBlockDocumentLibrary)
        XCTAssertEqual(store.activeNotes.count, 1)

        store.deleteNote(id: noteID)

        let noteAfterDelete = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        XCTAssertNotNil(noteAfterDelete.deletedAt)
        XCTAssertEqual(noteAfterDelete.originalFolderID, folderID)
        XCTAssertEqual(noteAfterDelete.originalFolderName, "工作")
        XCTAssertEqual(store.recycledNotes.map(\.id), [noteID])

        store.restoreNote(id: noteID)

        let noteAfterRestore = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        XCTAssertNil(noteAfterRestore.deletedAt)
        XCTAssertEqual(noteAfterRestore.folderID, folderID)
        XCTAssertEqual(noteAfterRestore.folderName, "工作")
        XCTAssertTrue(store.recycledNotes.isEmpty)
        XCTAssertEqual(store.activeNotes.map(\.id), [noteID])
    }

    @MainActor
    func testBlockDocumentPermanentDeleteRemovesEntities() throws {
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
                title: "待删除",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: nil,
                folderName: "未分类",
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
                blockCount: 1,
                assetCount: 1
            )
        )
        context.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 0,
                blockID: "block-1",
                kind: "paragraph",
                sourceType: "paragraph",
                textPayload: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: nil,
                assetID: "asset-1",
                tablePayload: nil
            )
        )
        context.insert(
            BlockDocumentAssetEntity(
                noteID: noteID,
                assetID: "asset-1",
                kind: "image",
                sourceKind: "image",
                filename: "image.png",
                mimeType: "image/png",
                width: 100,
                height: 100,
                duration: nil,
                createdAt: Date(),
                relativeFilePath: "BlockDocuments/\(noteID.uuidString)/asset-1/image.png",
                sidecarPathsPayload: nil
            )
        )
        try context.save()

        let store = NoteStore()
        store.setContext(context)
        store.deleteNotePermanently(id: noteID)

        let remainingNotes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
        let remainingBlocks = try context.fetch(FetchDescriptor<BlockDocumentBlockEntity>())
        let remainingAssets = try context.fetch(FetchDescriptor<BlockDocumentAssetEntity>())
        let library = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentLibraryEntity>(
                    predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
                )
            ).first
        )

        XCTAssertTrue(remainingNotes.isEmpty)
        XCTAssertTrue(remainingBlocks.isEmpty)
        XCTAssertTrue(remainingAssets.isEmpty)
        XCTAssertEqual(library.noteCount, 0)
        XCTAssertFalse(store.notes.contains(where: { $0.id == noteID }))
    }

    @MainActor
    func testExportedMigrationPackageImportsIntoFreshBlockLibrary() async throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()

        let sourceContainer = try makeInMemoryContainer()
        let sourceContext = sourceContainer.mainContext
        let libraryID = UUID()
        let folderID = UUID()
        let tagID = UUID()
        let noteID = UUID()

        sourceContext.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(timeIntervalSince1970: 50),
                importedAt: Date(timeIntervalSince1970: 60),
                noteCount: 1,
                folderCount: 1,
                tagCount: 1
            )
        )
        sourceContext.insert(
            BlockDocumentFolderEntity(
                id: folderID,
                libraryID: libraryID,
                name: "工作",
                sortOrder: 1,
                isSystem: false,
                createdAt: Date(timeIntervalSince1970: 70)
            )
        )
        sourceContext.insert(
            BlockDocumentTagEntity(
                id: tagID,
                libraryID: libraryID,
                name: "重要",
                color: "red",
                createdAt: Date(timeIntervalSince1970: 80)
            )
        )
        sourceContext.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "迁移包导入测试",
                createdAt: Date(timeIntervalSince1970: 100),
                updatedAt: Date(timeIntervalSince1970: 200),
                folderID: folderID,
                folderName: "工作",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 3,
                tagIDs: tagID.uuidString,
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 1,
                assetCount: 0
            )
        )
        sourceContext.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 0,
                blockID: "block-1",
                kind: "paragraph",
                sourceType: "paragraph",
                textPayload: try JSONEncoder().encode([
                    BlockDocumentTextSpanPayload(
                        text: "块级内容",
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
        try sourceContext.save()

        let exportURL = try await DataExportManager.shared.exportAllNotesOnly(context: sourceContext)
        defer { try? FileManager.default.removeItem(at: exportURL) }

        let destinationContainer = try makeInMemoryContainer()
        let destinationContext = destinationContainer.mainContext
        let oldLibraryID = UUID()
        let oldNoteID = UUID()
        destinationContext.insert(
            BlockDocumentLibraryEntity(
                id: oldLibraryID,
                schemaVersion: "0.9",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 1,
                folderCount: 0,
                tagCount: 0
            )
        )
        destinationContext.insert(
            BlockDocumentNoteEntity(
                id: oldNoteID,
                libraryID: oldLibraryID,
                title: "旧库内容",
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
                documentSource: "old",
                blockCount: 0,
                assetCount: 0
            )
        )
        try destinationContext.save()

        try await DataExportManager.shared.importNotes(from: exportURL, context: destinationContext)

        let importedLibrary = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentLibraryEntity>()).first)
        let importedFolder = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentFolderEntity>()).first)
        let importedTag = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentTagEntity>()).first)
        let importedNote = try XCTUnwrap(
            try destinationContext.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        let importedBlocks = try destinationContext.fetch(
            FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID }
            )
        )

        XCTAssertEqual(try destinationContext.fetch(FetchDescriptor<BlockDocumentLibraryEntity>()).count, 1)
        XCTAssertEqual(try destinationContext.fetch(FetchDescriptor<BlockDocumentNoteEntity>()).count, 1)
        XCTAssertEqual(importedLibrary.noteCount, 1)
        XCTAssertEqual(importedLibrary.folderCount, 1)
        XCTAssertEqual(importedLibrary.tagCount, 1)
        XCTAssertEqual(importedFolder.id, folderID)
        XCTAssertEqual(importedTag.id, tagID)
        XCTAssertEqual(importedNote.title, "迁移包导入测试")
        XCTAssertEqual(importedNote.folderID, folderID)
        XCTAssertEqual(importedNote.folderName, "工作")
        XCTAssertEqual(importedNote.version, 3)
        XCTAssertEqual(importedNote.tagIDs, tagID.uuidString)
        XCTAssertEqual(importedBlocks.count, 1)

        let store = NoteStore()
        store.setContext(destinationContext)

        XCTAssertTrue(store.isUsingBlockDocumentLibrary)
        XCTAssertEqual(store.activeNotes.map(\.id), [noteID])
    }

    @MainActor
    func testExportedMigrationPackageRestoresPersistedImageAssets() async throws {
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
        let sourceContainer = try makeInMemoryContainer()
        let sourceContext = sourceContainer.mainContext
        let libraryID = UUID()
        let noteID = UUID()
        let assetID = "asset-image-1"
        let relativeFilePath = "BlockDocuments/\(noteID.uuidString)/\(assetID)/Attachment.png"

        sourceContext.insert(
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
        sourceContext.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "带图片迁移包",
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
                blockCount: 1,
                assetCount: 1
            )
        )
        sourceContext.insert(
            BlockDocumentAssetEntity(
                noteID: noteID,
                assetID: assetID,
                kind: "image",
                sourceKind: "image",
                filename: "Attachment.png",
                mimeType: "image/png",
                width: 64,
                height: 64,
                duration: nil,
                createdAt: Date(),
                relativeFilePath: relativeFilePath,
                sidecarPathsPayload: nil
            )
        )
        sourceContext.insert(
            BlockDocumentBlockEntity(
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
                indent: 0,
                assetID: assetID,
                tablePayload: nil
            )
        )

        let sourceFileURL = attachmentsRoot.appendingPathComponent(relativeFilePath)
        try FileManager.default.createDirectory(at: sourceFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("image-data".utf8).write(to: sourceFileURL, options: .atomic)
        try sourceContext.save()

        let exportURL = try await DataExportManager.shared.exportAllNotesOnly(context: sourceContext)
        defer { try? FileManager.default.removeItem(at: exportURL) }

        let destinationContainer = try makeInMemoryContainer()
        let destinationContext = destinationContainer.mainContext
        try await DataExportManager.shared.importNotes(from: exportURL, context: destinationContext)

        let importedAsset = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentAssetEntity>()).first)
        let importedBlock = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentBlockEntity>()).first)
        let persistedAssetURL = attachmentsRoot.appendingPathComponent(importedAsset.relativeFilePath)

        XCTAssertEqual(importedAsset.kind, "image")
        XCTAssertEqual(importedAsset.assetID, assetID)
        XCTAssertEqual(importedBlock.assetID, assetID)
        XCTAssertTrue(importedAsset.filename.hasPrefix("Assets/"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: persistedAssetURL.path), persistedAssetURL.path)
        XCTAssertEqual(try Data(contentsOf: persistedAssetURL), Data("image-data".utf8))
    }

    @MainActor
    func testCreateLocalBackupWritesArchiveToHistoryDirectory() async throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()

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
                title: "备份前笔记",
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

        let backupManager = AutoBackupManager.shared
        let record = try await backupManager.createLocalBackup(context: context, fileNamePrefix: "TestMigrationBackup")

        let historyDirectory = try backupManager.historyDirectoryURL()
        let backupURL = historyDirectory.appendingPathComponent(record.fileName)

        XCTAssertTrue(FileManager.default.fileExists(atPath: backupURL.path))
        XCTAssertTrue(record.fileName.hasPrefix("TestMigrationBackup_"))
        XCTAssertTrue(backupManager.localBackupRecords.contains(where: { $0.fileName == record.fileName }))

        try await backupManager.deleteBackup(record: record)
    }

    @MainActor
    func testBlockDocumentRestoreFallsBackToUncategorizedWhenFolderMissing() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let missingFolderID = UUID()
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
                title: "待恢复",
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
                originalFolderID: missingFolderID,
                originalFolderName: "已删除文件夹",
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 0,
                assetCount: 0
            )
        )
        try context.save()

        let store = NoteStore()
        store.setContext(context)
        store.restoreNote(id: noteID)

        let restoredNote = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )

        XCTAssertNil(restoredNote.deletedAt)
        XCTAssertNil(restoredNote.folderID)
        XCTAssertEqual(restoredNote.folderName, "未分类")
        XCTAssertNil(restoredNote.originalFolderID)
        XCTAssertNil(restoredNote.originalFolderName)
        XCTAssertEqual(store.activeNotes.map(\.id), [noteID])
        XCTAssertTrue(store.recycledNotes.isEmpty)
    }

    @MainActor
    func testBlockDocumentBatchRestoreMovesMultipleNotesOutOfRecycleBin() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let firstNoteID = UUID()
        let secondNoteID = UUID()

        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 2,
                folderCount: 0,
                tagCount: 0
            )
        )
        context.insert(makeDeletedBlockNote(id: firstNoteID, libraryID: libraryID, title: "待恢复-1"))
        context.insert(makeDeletedBlockNote(id: secondNoteID, libraryID: libraryID, title: "待恢复-2"))
        try context.save()

        let store = NoteStore()
        store.setContext(context)

        let restoredCount = store.restoreNotes(ids: [firstNoteID, secondNoteID, firstNoteID])
        let restoredNotes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())

        XCTAssertEqual(restoredCount, 2)
        XCTAssertTrue(restoredNotes.allSatisfy { $0.deletedAt == nil })
        XCTAssertEqual(Set(store.activeNotes.map(\.id)), [firstNoteID, secondNoteID])
        XCTAssertTrue(store.recycledNotes.isEmpty)
    }

    @MainActor
    func testBlockDocumentBatchPermanentDeleteRemovesMultipleNotes() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let firstNoteID = UUID()
        let secondNoteID = UUID()

        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 2,
                folderCount: 0,
                tagCount: 0
            )
        )
        context.insert(makeDeletedBlockNote(id: firstNoteID, libraryID: libraryID, title: "待删-1"))
        context.insert(makeDeletedBlockNote(id: secondNoteID, libraryID: libraryID, title: "待删-2"))
        try context.save()

        let store = NoteStore()
        store.setContext(context)

        let deletedCount = store.deleteNotesPermanently(ids: [firstNoteID, secondNoteID, secondNoteID])
        let remainingNotes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
        let library = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentLibraryEntity>(
                    predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
                )
            ).first
        )

        XCTAssertEqual(deletedCount, 2)
        XCTAssertTrue(remainingNotes.isEmpty)
        XCTAssertEqual(library.noteCount, 0)
        XCTAssertTrue(store.notes.isEmpty)
    }

    @MainActor
    func testBlockDocumentAddNoteCreatesNewEntityAndUpdatesSelectionSource() throws {
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
                name: "工作",
                sortOrder: 0,
                isSystem: false,
                createdAt: Date()
            )
        )
        try context.save()

        let store = NoteStore()
        store.setContext(context)

        let note = try XCTUnwrap(store.addNote(title: "新建笔记", folderID: folderID, folderName: "工作"))
        let noteID = note.id
        let persistedNote = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        let library = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentLibraryEntity>(
                    predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
                )
            ).first
        )

        XCTAssertEqual(persistedNote.title, "新建笔记")
        XCTAssertEqual(persistedNote.folderID, folderID)
        XCTAssertEqual(persistedNote.folderName, "工作")
        XCTAssertEqual(persistedNote.viewMode, "text")
        XCTAssertNil(persistedNote.deletedAt)
        XCTAssertEqual(library.noteCount, 1)
        XCTAssertTrue(store.activeNotes.contains(where: { $0.id == noteID }))
    }

    @MainActor
    func testBlockDocumentFolderManagementUpdatesEntitiesAndAssociatedNotes() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let folderID = UUID()
        let noteID = UUID()

        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 1,
                folderCount: 1,
                tagCount: 0
            )
        )
        context.insert(
            BlockDocumentFolderEntity(
                id: folderID,
                libraryID: libraryID,
                name: "工作",
                sortOrder: 0,
                isSystem: false,
                createdAt: Date()
            )
        )
        context.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "文件夹测试",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: folderID,
                folderName: "工作",
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

        let store = NoteStore()
        store.setContext(context)

        store.updateFolder(id: folderID, name: "项目")

        let renamedFolder = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentFolderEntity>(
                    predicate: #Predicate<BlockDocumentFolderEntity> { $0.id == folderID }
                )
            ).first
        )
        let renamedNote = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )

        XCTAssertEqual(renamedFolder.name, "项目")
        XCTAssertEqual(renamedNote.folderName, "项目")

        store.deleteFolder(id: folderID)

        let remainingFolders = try context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
        let uncategorizedNote = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        let library = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentLibraryEntity>(
                    predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
                )
            ).first
        )

        XCTAssertTrue(remainingFolders.isEmpty)
        XCTAssertNil(uncategorizedNote.folderID)
        XCTAssertEqual(uncategorizedNote.folderName, "未分类")
        XCTAssertEqual(library.folderCount, 0)
    }

    @MainActor
    func testBlockDocumentTagManagementUpdatesTagsAndRemovesTagFromNotes() throws {
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
                title: "标签测试",
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

        let store = NoteStore()
        store.setContext(context)

        store.addTag(name: "重要", color: "red")

        let createdTag = try XCTUnwrap(try context.fetch(FetchDescriptor<BlockDocumentTagEntity>()).first)
        let libraryAfterAdd = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentLibraryEntity>(
                    predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
                )
            ).first
        )

        XCTAssertEqual(createdTag.name, "重要")
        XCTAssertEqual(createdTag.color, "red")
        XCTAssertEqual(libraryAfterAdd.tagCount, 1)

        store.updateTag(id: createdTag.id, name: "待办", color: "blue")
        store.addTagToNote(tagID: createdTag.id, noteID: noteID)
        store.deleteTag(id: createdTag.id)

        let remainingTags = try context.fetch(FetchDescriptor<BlockDocumentTagEntity>())
        let updatedNote = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        let libraryAfterDelete = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentLibraryEntity>(
                    predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
                )
            ).first
        )

        XCTAssertTrue(remainingTags.isEmpty)
        XCTAssertEqual(updatedNote.tagIDs, "")
        XCTAssertEqual(libraryAfterDelete.tagCount, 0)
    }

    @MainActor
    func testStaleRelativePathsIncludesAssetsAndSidecars() throws {
        let sidecarPaths = ["BlockDocuments/note/audio/tracks.json", "BlockDocuments/note/audio/waveform.json"]
        let asset = BlockDocumentAssetEntity(
            noteID: UUID(),
            assetID: "asset-audio",
            kind: "audio",
            sourceKind: "audio",
            filename: "recording.m4a",
            mimeType: "audio/mp4",
            width: nil,
            height: nil,
            duration: 1.5,
            createdAt: Date(),
            relativeFilePath: "BlockDocuments/note/audio/recording.m4a",
            sidecarPathsPayload: try JSONEncoder().encode(sidecarPaths)
        )

        let paths = NoteSaveManager.shared.staleRelativePaths(
            previousAssets: [asset]
        )

        XCTAssertEqual(
            Set(paths),
            Set([
                "BlockDocuments/note/audio/recording.m4a",
                "BlockDocuments/note/audio/tracks.json",
                "BlockDocuments/note/audio/waveform.json"
            ])
        )
    }

    @MainActor
    func testCleanupBlockArtifactFilesRemovesOnlyStaleFilesAndEmptyDirectories() throws {
        let fileManager = FileManager.default
        let noteID = UUID()
        let attachmentsRoot = fileManager.temporaryDirectory
            .appendingPathComponent("NotebookTests_Attachments_\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
        defer {
            try? fileManager.removeItem(at: attachmentsRoot)
        }

        let staleLegacyPath = "BlockDocuments/\(noteID.uuidString)/LegacyContent/content.rtfd"
        let staleAssetPath = "BlockDocuments/\(noteID.uuidString)/old-asset/recording.m4a"
        let staleSidecarPath = "BlockDocuments/\(noteID.uuidString)/old-asset/recording.tracks.json"
        let preservedAssetPath = "BlockDocuments/\(noteID.uuidString)/current-asset/image.png"

        for relativePath in [staleLegacyPath, staleAssetPath, staleSidecarPath, preservedAssetPath] {
            let fileURL = attachmentsRoot.appendingPathComponent(relativePath)
            try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("payload".utf8).write(to: fileURL)
        }

        NoteSaveManager.shared.cleanupBlockArtifactFiles(
            relativePaths: [staleLegacyPath, staleAssetPath, staleSidecarPath, preservedAssetPath],
            preservedRelativePaths: [preservedAssetPath],
            attachmentsRoot: attachmentsRoot,
            noteID: noteID
        )

        XCTAssertFalse(fileManager.fileExists(atPath: attachmentsRoot.appendingPathComponent(staleLegacyPath).path))
        XCTAssertFalse(fileManager.fileExists(atPath: attachmentsRoot.appendingPathComponent(staleAssetPath).path))
        XCTAssertFalse(fileManager.fileExists(atPath: attachmentsRoot.appendingPathComponent(staleSidecarPath).path))
        XCTAssertTrue(fileManager.fileExists(atPath: attachmentsRoot.appendingPathComponent(preservedAssetPath).path))
        XCTAssertFalse(
            fileManager.fileExists(
                atPath: attachmentsRoot
                    .appendingPathComponent("BlockDocuments/\(noteID.uuidString)/old-asset", isDirectory: true)
                    .path
            )
        )
    }

    func testRecycleBinSelectionCoordinatorKeepsRemainingSelectionWhenPossible() {
        let firstID = UUID()
        let secondID = UUID()
        let thirdID = UUID()

        let result = RecycleBinSelectionCoordinator.selectionAfterRemoving(
            [firstID],
            from: [firstID, secondID],
            availableIDs: [firstID, secondID, thirdID]
        )

        XCTAssertEqual(result, [secondID])
    }

    func testRecycleBinSelectionCoordinatorFallsBackToFirstRemainingItem() {
        let firstID = UUID()
        let secondID = UUID()

        let result = RecycleBinSelectionCoordinator.selectionAfterRemoving(
            [firstID],
            from: [firstID],
            availableIDs: [firstID, secondID]
        )

        XCTAssertEqual(result, [secondID])
    }

    func testRecycleBinSelectionCoordinatorReturnsEmptyWhenNoItemsRemain() {
        let firstID = UUID()

        let result = RecycleBinSelectionCoordinator.selectionAfterRemoving(
            [firstID],
            from: [firstID],
            availableIDs: [firstID]
        )

        XCTAssertTrue(result.isEmpty)
    }

    func testVisibleNoteSelectionCoordinatorKeepsCurrentSelectionWhenStillVisible() {
        let firstID = UUID()
        let secondID = UUID()

        let result = VisibleNoteSelectionCoordinator.selectionForVisibleNotes(
            currentSelection: secondID,
            availableIDs: [firstID, secondID]
        )

        XCTAssertEqual(result, secondID)
    }

    func testVisibleNoteSelectionCoordinatorFallsBackToFirstVisibleNote() {
        let firstID = UUID()
        let secondID = UUID()

        let result = VisibleNoteSelectionCoordinator.selectionForVisibleNotes(
            currentSelection: UUID(),
            availableIDs: [firstID, secondID]
        )

        XCTAssertEqual(result, firstID)
    }

    func testVisibleNoteSelectionCoordinatorReturnsNilWhenNoVisibleNotesRemain() {
        let result = VisibleNoteSelectionCoordinator.selectionForVisibleNotes(
            currentSelection: UUID(),
            availableIDs: []
        )

        XCTAssertNil(result)
    }

    func testAttachmentTargetNoteResolverPrefersBoundNoteWhenEditorIsActive() {
        let boundNoteID = UUID()
        let currentNoteID = UUID()

        let result = AttachmentTargetNoteResolver.resolve(
            boundNoteID: boundNoteID,
            currentNoteID: currentNoteID,
            hasActiveTextView: true
        )

        XCTAssertEqual(result, boundNoteID)
    }

    func testAttachmentTargetNoteResolverFallsBackToCurrentSelectionWhenEditorNotReady() {
        let currentNoteID = UUID()

        let result = AttachmentTargetNoteResolver.resolve(
            boundNoteID: nil,
            currentNoteID: currentNoteID,
            hasActiveTextView: false
        )

        XCTAssertEqual(result, currentNoteID)
    }

    func testMarkdownPreviewNavigationStateRestoresRelativeProgressAfterReload() {
        var state = MarkdownPreviewNavigationState()
        state.captureRelativeProgress(offset: 120, contentHeight: 520, viewportHeight: 220)

        let command = state.consumePostLoadCommand()

        guard case .relativeProgress(let progress)? = command else {
            return XCTFail("Expected relative progress command")
        }
        XCTAssertEqual(progress, 0.4, accuracy: 0.0001)
        XCTAssertNil(state.consumePostLoadCommand())
    }

    func testMarkdownPreviewNavigationStatePrefersAnchorOverRelativeProgress() {
        var state = MarkdownPreviewNavigationState()
        state.captureRelativeProgress(offset: 120, contentHeight: 520, viewportHeight: 220)
        state.queueAnchor("heading-2")

        let firstCommand = state.consumePostLoadCommand()
        let secondCommand = state.consumePostLoadCommand()

        XCTAssertEqual(firstCommand, .anchor("heading-2"))
        XCTAssertEqual(secondCommand, .relativeProgress(0.4))
    }

    func testAttachmentTextAttachmentKeepsOriginalFilename() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let sourceURL = tempDirectory.appendingPathComponent("sample-audio.mp3")
        let sourceData = Data([0x00, 0x11, 0x22, 0x33])
        try sourceData.write(to: sourceURL)

        let attachment = AttachmentTextAttachment(fileURL: sourceURL, kind: .audio)

        XCTAssertEqual(attachment.attachmentFilename, "sample-audio.mp3")
    }

    func testAttachmentTextAttachmentUsesEmbeddedDataWhenFileIsUnavailable() throws {
        let missingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let sourceURL = missingDirectory.appendingPathComponent("persisted-image.png")
        let sourceData = Data([0x89, 0x50, 0x4E, 0x47])
        let attachment = AttachmentTextAttachment(
            fileURL: sourceURL,
            kind: .image,
            embeddedFileData: sourceData,
            attachmentFilename: "persisted-image.png"
        )

        XCTAssertEqual(attachment.attachmentFilename, "persisted-image.png")
        XCTAssertEqual(attachment.kind, .image)
        XCTAssertEqual(attachment.attachmentData(), sourceData)
    }

    func testAudioBlockAttachmentKeepsOriginalFilenameAndManifest() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let audioURL = tempDirectory.appendingPathComponent("meeting.mp3")
        let manifestURL = tempDirectory.appendingPathComponent("meeting.tracks.json")
        try Data([0x01, 0x02, 0x03]).write(to: audioURL)
        try Data("{\"tracks\":2}".utf8).write(to: manifestURL)

        let attachment = AudioBlockAttachment(fileURL: audioURL, duration: 12, createDate: Date())

        XCTAssertEqual(attachment.attachmentFilename, "meeting.mp3")
        XCTAssertEqual(attachment.manifestFilename, "meeting.tracks.json")
        XCTAssertEqual(attachment.audioData(), Data([0x01, 0x02, 0x03]))
        XCTAssertEqual(attachment.manifestData(), Data("{\"tracks\":2}".utf8))
    }

    func testAudioBlockAttachmentUsesEmbeddedDataWhenFileIsUnavailable() {
        let missingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let audioURL = missingDirectory.appendingPathComponent("copied.m4a")
        let audioData = Data([0x10, 0x20, 0x30])
        let manifestData = Data("{\"dual\":true}".utf8)

        let attachment = AudioBlockAttachment(
            fileURL: audioURL,
            duration: 8,
            createDate: Date(),
            embeddedAudioData: audioData,
            attachmentFilename: "copied.m4a",
            embeddedManifestData: manifestData
        )

        XCTAssertEqual(attachment.attachmentFilename, "copied.m4a")
        XCTAssertEqual(attachment.manifestFilename, "copied.tracks.json")
        XCTAssertEqual(attachment.audioData(), audioData)
        XCTAssertEqual(attachment.manifestData(), manifestData)
    }

    @MainActor
    func testNormalizedContentForSavingReusesManagedBlockAttachmentFile() throws {
        let noteID = UUID()
        let assetID = UUID().uuidString
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            StorageLocationManager.shared.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        try storage.ensureDirectoryStructureExists()

        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let managedImageURL = attachmentsRoot
            .appendingPathComponent("BlockDocuments/\(noteID.uuidString)/\(assetID)", isDirectory: true)
            .appendingPathComponent("Attachment.png")
        try FileManager.default.createDirectory(at: managedImageURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: managedImageURL)

        let attachment = AttachmentTextAttachment(fileURL: managedImageURL, kind: .image)
        let content = NSAttributedString(attachment: attachment)

        let normalized = AttachmentManager.shared.normalizedContentForSaving(content, noteID: noteID)
        let normalizedAttachment = try XCTUnwrap(normalized.attribute(.attachment, at: 0, effectiveRange: nil) as? AttachmentTextAttachment)

        XCTAssertEqual(normalizedAttachment.attachmentFileURL.standardizedFileURL, managedImageURL.standardizedFileURL)
        XCTAssertEqual(normalizedAttachment.attachmentFilename, managedImageURL.lastPathComponent)

        let legacyNoteFolder = attachmentsRoot.appendingPathComponent(noteID.uuidString, isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyNoteFolder.path))
    }

    func testRichTextEditorNormalizesLegacyDefaultColorsToAdaptiveTextColor() {
        let darkNormalized = RichTextEditor.normalizedDefaultForegroundColor(.black, for: .dark)
        let lightNormalized = RichTextEditor.normalizedDefaultForegroundColor(.white, for: .light)
        let customColor = NSColor.systemRed

        XCTAssertTrue(try XCTUnwrap(darkNormalized).isEqual(to: NSColor.textColor))
        XCTAssertTrue(try XCTUnwrap(lightNormalized).isEqual(to: NSColor.textColor))
        XCTAssertNil(RichTextEditor.normalizedDefaultForegroundColor(customColor, for: .dark))
        XCTAssertTrue(RichTextEditor.isLegacyDefaultTextColor(.black, for: .dark))
        XCTAssertFalse(RichTextEditor.isLegacyDefaultTextColor(customColor, for: .dark))
    }

    func testAttachmentAppearanceUsesSemanticSystemColors() {
        XCTAssertTrue(AttachmentAppearance.primaryTextColor.isEqual(to: NSColor.textColor))
        XCTAssertTrue(AttachmentAppearance.secondaryTextColor.isEqual(to: NSColor.secondaryLabelColor))
        XCTAssertTrue(AttachmentAppearance.backgroundColor.isEqual(to: NSColor.textBackgroundColor))
        XCTAssertTrue(AttachmentAppearance.secondaryBackgroundColor.isEqual(to: NSColor.controlBackgroundColor))
        XCTAssertTrue(AttachmentAppearance.borderColor.isEqual(to: NSColor.separatorColor))
        XCTAssertTrue(AttachmentAppearance.uncheckedStrokeColor.isEqual(to: NSColor.tertiaryLabelColor))
    }

    @MainActor
    func testRefreshAppearanceSensitiveAttachmentsRebuildsAttachmentImages() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let audioURL = tempDirectory.appendingPathComponent("theme-check.m4a")
        try Data([0x01, 0x02, 0x03]).write(to: audioURL)

        let audioAttachment = AudioBlockAttachment(fileURL: audioURL, duration: 5, createDate: Date())
        let tableAttachment = TableTextAttachment(rows: 2, columns: 2)
        let checkboxAttachment = CheckboxTextAttachment(checked: false)

        audioAttachment.image = nil
        tableAttachment.image = nil
        checkboxAttachment.image = nil

        let content = NSMutableAttributedString()
        content.append(NSAttributedString(attachment: audioAttachment))
        content.append(NSAttributedString(string: "\n"))
        content.append(NSAttributedString(attachment: tableAttachment))
        content.append(NSAttributedString(string: "\n"))
        content.append(NSAttributedString(attachment: checkboxAttachment))

        let textView = RichTextView(frame: .zero)
        textView.textStorage?.setAttributedString(content)

        RichTextEditor.refreshAppearanceSensitiveAttachments(in: textView)

        XCTAssertNotNil(audioAttachment.image)
        XCTAssertNotNil(tableAttachment.image)
        XCTAssertNotNil(checkboxAttachment.image)
    }

    @MainActor
    func testRefreshAppearanceSensitiveAttachmentsRerendersAttachmentBackgroundsForThemeChanges() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let audioURL = tempDirectory.appendingPathComponent("appearance-shift.m4a")
        try Data([0xAA, 0xBB, 0xCC]).write(to: audioURL)

        let audioAttachment = AudioBlockAttachment(fileURL: audioURL, duration: 7, createDate: Date())
        let tableAttachment = TableTextAttachment(rows: 2, columns: 2)
        tableAttachment.tableData.updateCell(row: 0, column: 0, value: "Theme")
        tableAttachment.updateImage()

        let content = NSMutableAttributedString()
        content.append(NSAttributedString(attachment: audioAttachment))
        content.append(NSAttributedString(string: "\n"))
        content.append(NSAttributedString(attachment: tableAttachment))

        let textView = RichTextView(frame: .zero)
        textView.textStorage?.setAttributedString(content)

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let darkAppearance = try XCTUnwrap(NSAppearance(named: .darkAqua))

        let lightAudioData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: lightAppearance, attachment: audioAttachment))
        let darkAudioData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: darkAppearance, attachment: audioAttachment))
        let lightTableData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: lightAppearance, attachment: tableAttachment))
        let darkTableData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: darkAppearance, attachment: tableAttachment))

        XCTAssertNotEqual(lightAudioData, darkAudioData)
        XCTAssertNotEqual(lightTableData, darkTableData)
    }

    @MainActor
    func testSerializedAttachmentsRecoverPresentationAfterRTFDRoundTrip() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)

        let storageManager = StorageLocationManager.shared
        storageManager.setBaseDirectoryForTesting(tempDirectory)
        defer {
            storageManager.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: tempDirectory)
        }

        try storageManager.ensureDirectoryStructureExists()

        let noteID = UUID()
        let audioURL = tempDirectory.appendingPathComponent("roundtrip-audio.m4a")
        let manifestURL = tempDirectory.appendingPathComponent("roundtrip-audio.tracks.json")
        try Data([0x11, 0x22, 0x33]).write(to: audioURL)
        try Data("{\"tracks\":2}".utf8).write(to: manifestURL)

        let audioAttachment = AudioBlockAttachment(fileURL: audioURL, duration: 11, createDate: Date())
        let tableAttachment = TableTextAttachment(rows: 2, columns: 2)
        tableAttachment.tableData.updateCell(row: 0, column: 0, value: "A1")
        tableAttachment.updateImage()
        let content = NSMutableAttributedString()
        let audioRange = NSRange(location: content.length, length: 1)
        content.append(NSAttributedString(attachment: audioAttachment))
        content.addAttribute(.link, value: audioURL, range: audioRange)
        content.append(NSAttributedString(string: "\n"))
        let tableRange = NSRange(location: content.length, length: 1)
        content.append(NSAttributedString(attachment: tableAttachment))
        let tableData = try JSONEncoder().encode(tableAttachment.tableData)
        content.addAttribute(.notebookTableData, value: tableData, range: tableRange)

        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "序列化附件",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: content,
                reason: "test"
            )
        )
        let decoded = try XCTUnwrap(
            NSAttributedString(
                data: request.rtfdData,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            )
        )

        let textView = RichTextView(frame: .zero)
        textView.textStorage?.setAttributedString(decoded)
        textView.normalizeAttachmentsAfterLoad()
        RichTextEditor.refreshAppearanceSensitiveAttachments(in: textView)

        var foundLinkedAttachment = false
        var foundTable = false

        let textStorage = try XCTUnwrap(textView.textStorage)
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length), options: []) { value, range, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            let hasLink = textStorage.attribute(.link, at: range.location, effectiveRange: nil) != nil

            if let audio = attachment as? AudioBlockAttachment {
                foundLinkedAttachment = true
                XCTAssertNotNil(audio.image)
                XCTAssertTrue(hasLink)
                return
            }

            if let audio = attachment as? AttachmentTextAttachment, audio.kind == .audio {
                foundLinkedAttachment = true
                XCTAssertNotNil(audio.image)
                XCTAssertTrue(hasLink)
                return
            }

            if !(attachment is TableTextAttachment), hasLink {
                foundLinkedAttachment = true
                XCTAssertNotNil(attachment.image)
                return
            }

            if let table = attachment as? TableTextAttachment {
                foundTable = true
                XCTAssertNotNil(table.image)
                XCTAssertEqual(table.tableData.rows.first?.first, "A1")
            }
        }

        XCTAssertTrue(foundLinkedAttachment)
        XCTAssertTrue(foundTable)
    }

    @MainActor
    func testRichTextViewActiveTableEditorRelayoutsAfterDeletingColumn() throws {
        let attachment = TableTextAttachment(rows: 2, columns: 3)
        attachment.tableData.updateCell(row: 0, column: 2, value: "C1")
        attachment.updateImage()

        let content = NSMutableAttributedString()
        let tableRange = NSRange(location: content.length, length: 1)
        content.append(NSAttributedString(attachment: attachment))

        let (window, textView) = makeHostedRichTextView(content: content)
        defer { window.orderOut(nil) }

        let clickPoint = try XCTUnwrap(pointForAttachment(in: textView, range: tableRange))
        sendLeftClick(to: textView, at: clickPoint)

        let editor = try XCTUnwrap(textView.subviews.compactMap { $0 as? TableInlineEditorView }.first)
        let originalWidth = editor.frame.width

        sendLeftClick(to: editor, at: pointForTableCell(row: 0, col: 2, tableData: attachment.tableData))
        XCTAssertNotNil(editor.perform(NSSelectorFromString("deleteCurrentColumn:"), with: nil))

        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        textView.layoutSubtreeIfNeeded()
        textView.displayIfNeeded()

        let activeEditors = textView.subviews.compactMap { $0 as? TableInlineEditorView }
        let updatedEditor = try XCTUnwrap(activeEditors.first)
        let expectedWidth = attachment.tableData.columnWidths.reduce(0, +) + CGFloat(attachment.tableData.columnCount + 1) * 0.5
        let expectedHeight = attachment.tableData.rowHeights.reduce(0, +) + CGFloat(attachment.tableData.rowCount + 1) * 0.5

        XCTAssertEqual(activeEditors.count, 1)
        XCTAssertEqual(attachment.tableData.columnCount, 2)
        XCTAssertLessThan(updatedEditor.frame.width, originalWidth)
        XCTAssertEqual(updatedEditor.frame.width, expectedWidth, accuracy: 0.5)
        XCTAssertEqual(updatedEditor.frame.height, expectedHeight, accuracy: 0.5)
    }

    @MainActor
    func testTableAttachmentSelectionRenderingRespondsToSelectionAndAppearance() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "Selected")
        tableData.updateCell(row: 0, column: 1, value: "Other")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let darkAppearance = try XCTUnwrap(NSAppearance(named: .darkAqua))

        let unselectedLight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: NSPoint(x: 24, y: 16))
        let selectedLight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        let selectedDark = try XCTUnwrap(renderedViewData(tableView, appearance: darkAppearance))

        XCTAssertNotEqual(unselectedLight, selectedLight)
        XCTAssertNotEqual(selectedLight, selectedDark)
    }

    @MainActor
    func testTableAttachmentEditingFieldUsesAdaptiveSystemBackground() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "Edit me")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        sendLeftDoubleClick(to: tableView, at: NSPoint(x: 24, y: 16))

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let darkAppearance = try XCTUnwrap(NSAppearance(named: .darkAqua))
        let lightBackground = try XCTUnwrap(resolvedRGBA(editor.backgroundColor, appearance: lightAppearance))
        let darkBackground = try XCTUnwrap(resolvedRGBA(editor.backgroundColor, appearance: darkAppearance))

        XCTAssertNotEqual(lightBackground, darkBackground)
    }

    @MainActor
    func testTableAttachmentTabNavigationMatchesMouseSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 0, value: "A2")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        let initialSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        sendKeyDown(to: tableView, keyCode: 48, characters: "\t")
        let tabToNext = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertNotEqual(initialSelection, tabToNext)
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        let clickedNext = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(tabToNext, clickedNext)

        sendKeyDown(to: tableView, keyCode: 48, characters: "\t")
        let tabToNextRow = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 0, tableData: tableData))
        let clickedNextRow = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(tabToNextRow, clickedNextRow)

        sendKeyDown(to: tableView, keyCode: 48, characters: "\t", modifiers: .shift)
        let shiftTabBack = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        let clickedShiftTabBack = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(shiftTabBack, clickedShiftTabBack)
    }

    @MainActor
    func testTableAttachmentArrowNavigationWrapsAcrossEdges() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 0, value: "A2")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))

        sendKeyDown(to: tableView, keyCode: 123)
        let wrappedLeft = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        let clickedWrappedLeft = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(wrappedLeft, clickedWrappedLeft)

        sendKeyDown(to: tableView, keyCode: 126)
        let wrappedUp = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 1, tableData: tableData))
        let clickedWrappedUp = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(wrappedUp, clickedWrappedUp)

        sendKeyDown(to: tableView, keyCode: 124)
        let wrappedRight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 0, tableData: tableData))
        let clickedWrappedRight = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(wrappedRight, clickedWrappedRight)
    }

    @MainActor
    func testTableAttachmentReturnKeyBeginsEditingSelectedCell() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        XCTAssertEqual(editor.stringValue, "A1")
    }

    @MainActor
    func testTableAttachmentEscapeCancelsEditingWithoutCommit() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Changed"

        sendKeyDown(to: tableView, keyCode: 53)

        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertTrue(editedValues.isEmpty)
    }

    @MainActor
    func testTableAttachmentEditingMoveDownCommitsAndSelectsNextRow() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Down"

        XCTAssertTrue(sendEditingCommand(#selector(NSResponder.moveDown(_:)), in: tableView))
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 1)
        XCTAssertEqual(editedValues.first?.2, "Edited Down")
        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 1, tableData: tableData))
        let clickedTarget = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(movedSelection, clickedTarget)
    }

    @MainActor
    func testTableAttachmentEditingMoveUpCommitsAndWrapsSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 1, value: "B1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 1, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 36, characters: "\r")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Up"

        XCTAssertTrue(sendEditingCommand(#selector(NSResponder.moveUp(_:)), in: tableView))
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 1)
        XCTAssertEqual(editedValues.first?.2, "Edited Up")
        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        sendLeftClick(to: tableView, at: pointForTableCell(row: 1, col: 1, tableData: tableData))
        let clickedTarget = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))
        XCTAssertEqual(movedSelection, clickedTarget)
    }

    @MainActor
    func testTableAttachmentPrintableKeyStartsEditingWithTypedCharacter() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        let (window, tableView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { window.orderOut(nil) }

        sendLeftClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        sendKeyDown(to: tableView, keyCode: 7, characters: "x")

        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        XCTAssertEqual(editor.stringValue, "x")
    }

    @MainActor
    func testTableAttachmentClickingOtherCellCommitsEditingAndMovesSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let sourcePoint = pointForTableCell(row: 0, col: 0, tableData: tableData)
        let targetPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)

        sendLeftDoubleClick(to: tableView, at: sourcePoint)
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Click"

        sendLeftClick(to: tableView, at: targetPoint)

        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 0)
        XCTAssertEqual(editedValues.first?.2, "Edited Click")

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: targetPoint)
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(movedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentClickingBlankAreaKeepsCurrentEditingSession() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        var editedValues: [(Int, Int, String)] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            }
        )
        defer { window.orderOut(nil) }

        let sourcePoint = pointForTableCell(row: 0, col: 0, tableData: tableData)
        let blankPoint = NSPoint(x: tableView.bounds.maxX + 20, y: tableView.bounds.maxY + 20)

        sendLeftDoubleClick(to: tableView, at: sourcePoint)
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Still Editing"

        sendLeftClick(to: tableView, at: blankPoint)

        let remainingEditor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        XCTAssertEqual(remainingEditor.stringValue, "Still Editing")
        XCTAssertTrue(editedValues.isEmpty)
    }

    @MainActor
    func testTableAttachmentRightClickOtherCellCommitsEditingAndUpdatesSelection() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var editedValues: [(Int, Int, String)] = []
        var presentedMenuTitles: [String] = []
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            },
            contextMenuPresenter: { menu, _, _ in
                presentedMenuTitles = menu.items.map(\.title)
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let sourcePoint = pointForTableCell(row: 0, col: 0, tableData: tableData)
        let targetPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)

        sendLeftDoubleClick(to: tableView, at: sourcePoint)
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Edited Right Click"

        sendRightClick(to: tableView, at: targetPoint)

        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 0)
        XCTAssertEqual(editedValues.first?.2, "Edited Right Click")
        XCTAssertEqual(presentedMenuTitles, ["行操作", "列操作"])

        let movedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: tableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: targetPoint)
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(movedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentInsertRowAbovePreservesOriginalSelectionAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 1, column: 1, value: "B2")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let targetPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)
        sendLeftClick(to: tableView, at: targetPoint)
        XCTAssertTrue(performTableAction("insertRowAbove:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.addRow(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 2, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentStructureActionCommitsActiveEditingBeforeMutatingTable() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 0, value: "A1")

        var editedValues: [(Int, Int, String)] = []
        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onCellEdited: { row, col, value in
                editedValues.append((row, col, value))
            },
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        sendLeftDoubleClick(to: tableView, at: pointForTableCell(row: 0, col: 0, tableData: tableData))
        let editor = try XCTUnwrap(tableView.subviews.compactMap { $0 as? NSTextField }.first)
        editor.stringValue = "Committed Before Insert"

        XCTAssertTrue(performTableAction("insertColumnLeft:", on: tableView))
        XCTAssertTrue(tableView.subviews.compactMap { $0 as? NSTextField }.isEmpty)
        XCTAssertEqual(structureChangeCount, 1)
        XCTAssertEqual(editedValues.count, 1)
        XCTAssertEqual(editedValues.first?.0, 0)
        XCTAssertEqual(editedValues.first?.1, 0)
        XCTAssertEqual(editedValues.first?.2, "Committed Before Insert")
        XCTAssertEqual(tableView.intrinsicContentSize.width, 304)
    }

    @MainActor
    func testTableAttachmentDeleteRowSelectsNearestRemainingRowAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 3, columns: 2)
        tableData.updateCell(row: 2, column: 1, value: "C2")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let deletedRowPoint = pointForTableCell(row: 1, col: 1, tableData: tableData)

        sendLeftClick(to: tableView, at: deletedRowPoint)
        XCTAssertTrue(performTableAction("deleteRow:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.removeRow(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 1, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentDeleteColumnSelectsNearestRemainingColumnAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 3)
        tableData.updateCell(row: 1, column: 2, value: "B3")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let deletedColumnPoint = pointForTableCell(row: 1, col: 2, tableData: tableData)

        sendLeftClick(to: tableView, at: deletedColumnPoint)
        XCTAssertTrue(performTableAction("deleteColumn:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.removeColumn(at: 2)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 1, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentInsertRowBelowKeepsCurrentSelectionAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 0, column: 1, value: "A2")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let targetPoint = pointForTableCell(row: 0, col: 1, tableData: tableData)

        sendLeftClick(to: tableView, at: targetPoint)
        XCTAssertTrue(performTableAction("insertRowBelow:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.addRow(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 0, col: 1, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentInsertColumnRightKeepsCurrentSelectionAndNotifiesStructureChange() throws {
        var tableData = TableData(rows: 2, columns: 2)
        tableData.updateCell(row: 1, column: 0, value: "B1")

        var structureChangeCount = 0
        let (window, tableView) = makeHostedTableAttachmentView(
            tableData: tableData,
            onStructureChanged: {
                structureChangeCount += 1
            }
        )
        defer { window.orderOut(nil) }

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let targetPoint = pointForTableCell(row: 1, col: 0, tableData: tableData)

        sendLeftClick(to: tableView, at: targetPoint)
        XCTAssertTrue(performTableAction("insertColumnRight:", on: tableView))
        resizeToIntrinsicContentSize(tableView)
        XCTAssertEqual(structureChangeCount, 1)

        var expectedTableData = tableData
        expectedTableData.addColumn(at: 1)
        let updatedSelection = try XCTUnwrap(renderedViewData(tableView, appearance: lightAppearance))

        let (referenceWindow, referenceView) = makeHostedTableAttachmentView(tableData: expectedTableData)
        defer { referenceWindow.orderOut(nil) }
        sendLeftClick(to: referenceView, at: pointForTableCell(row: 1, col: 0, tableData: expectedTableData))
        let expectedSelection = try XCTUnwrap(renderedViewData(referenceView, appearance: lightAppearance))

        XCTAssertEqual(updatedSelection, expectedSelection)
    }

    @MainActor
    func testTableAttachmentDeletingLastRemainingStructureDoesNothing() throws {
        let singleRowTableData = TableData(rows: 1, columns: 2)
        var rowStructureChangeCount = 0
        let (rowWindow, rowTableView) = makeHostedTableAttachmentView(
            tableData: singleRowTableData,
            onStructureChanged: {
                rowStructureChangeCount += 1
            }
        )
        defer { rowWindow.orderOut(nil) }

        let rowAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        sendLeftClick(to: rowTableView, at: pointForTableCell(row: 0, col: 1, tableData: singleRowTableData))
        XCTAssertTrue(performTableAction("deleteRow:", on: rowTableView))
        let afterRowDeletion = try XCTUnwrap(renderedViewData(rowTableView, appearance: rowAppearance))

        let (rowReferenceWindow, rowReferenceView) = makeHostedTableAttachmentView(tableData: singleRowTableData)
        defer { rowReferenceWindow.orderOut(nil) }
        sendLeftClick(to: rowReferenceView, at: pointForTableCell(row: 0, col: 1, tableData: singleRowTableData))
        let expectedRowSelection = try XCTUnwrap(renderedViewData(rowReferenceView, appearance: rowAppearance))

        XCTAssertEqual(afterRowDeletion, expectedRowSelection)
        XCTAssertEqual(rowStructureChangeCount, 0)

        let singleColumnTableData = TableData(rows: 2, columns: 1)
        var columnStructureChangeCount = 0
        let (columnWindow, columnTableView) = makeHostedTableAttachmentView(
            tableData: singleColumnTableData,
            onStructureChanged: {
                columnStructureChangeCount += 1
            }
        )
        defer { columnWindow.orderOut(nil) }

        sendLeftClick(to: columnTableView, at: pointForTableCell(row: 1, col: 0, tableData: singleColumnTableData))
        XCTAssertTrue(performTableAction("deleteColumn:", on: columnTableView))
        let afterColumnDeletion = try XCTUnwrap(renderedViewData(columnTableView, appearance: rowAppearance))

        let (columnReferenceWindow, columnReferenceView) = makeHostedTableAttachmentView(tableData: singleColumnTableData)
        defer { columnReferenceWindow.orderOut(nil) }
        sendLeftClick(to: columnReferenceView, at: pointForTableCell(row: 1, col: 0, tableData: singleColumnTableData))
        let expectedColumnSelection = try XCTUnwrap(renderedViewData(columnReferenceView, appearance: rowAppearance))

        XCTAssertEqual(afterColumnDeletion, expectedColumnSelection)
        XCTAssertEqual(columnStructureChangeCount, 0)
    }

    func testAttachmentThemeRenderingFilesUseSharedAppearanceTokens() throws {
        let expectedSnippets: [String: [String]] = [
            "Notebook/AudioBlockAttachment.swift": [
                "AttachmentAppearance.primaryTextColor",
                "AttachmentAppearance.secondaryTextColor",
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.secondaryBackgroundColor"
            ],
            "Notebook/TableTextAttachment.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableAttachmentView.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.selectionColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableInlineEditorView.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.selectionColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableAttachmentCell.swift": [
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/TableEditorView.swift": [
                "AttachmentAppearance.secondaryBackgroundColor",
                "AttachmentAppearance.backgroundColor",
                "AttachmentAppearance.borderColor",
                "AttachmentAppearance.primaryTextColor"
            ],
            "Notebook/CheckboxTextAttachment.swift": [
                "AttachmentAppearance.uncheckedStrokeColor"
            ]
        ]
        let forbiddenPatterns = [
            #"isDark\s*\?\s*\.white\s*:\s*\.black"#,
            #"isDarkMode\s*\?\s*\.white\s*:\s*\.black"#,
            #"isDark\s*\?\s*NSColor\.white\s*:\s*NSColor\.black"#,
            #"isDarkMode\s*\?\s*NSColor\.white\s*:\s*NSColor\.black"#
        ]

        for (relativePath, snippets) in expectedSnippets {
            let source = try sourceFileContents(relativePath: relativePath)

            for snippet in snippets {
                XCTAssertTrue(source.contains(snippet), "\(relativePath) should contain \(snippet)")
            }

            for pattern in forbiddenPatterns {
                XCTAssertNil(
                    source.range(of: pattern, options: .regularExpression),
                    "\(relativePath) should not reintroduce hardcoded black/white theme branching"
                )
            }
        }
    }

    func testMarkdownPreviewRendersInlineRichTextStyles() {
        let content = NSMutableAttributedString(string: "预览样式")
        let fullRange = NSRange(location: 0, length: content.length)
        content.addAttributes([
            .font: NSFont.systemFont(ofSize: 18, weight: .semibold),
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .foregroundColor: NSColor(calibratedRed: 1, green: 0, blue: 0, alpha: 1),
            .link: URL(string: "https://example.com")!
        ], range: fullRange)

        let html = MarkdownWebView(
            markdown: "",
            attributedContent: content,
            colorScheme: ColorScheme.light,
            height: .constant(0),
            noteID: UUID()
        ).generateHTML(from: "", attributed: content, colorScheme: ColorScheme.light)

        XCTAssertTrue(html.contains("href=\"https://example.com\""))
        XCTAssertTrue(html.contains("font-weight"))
        XCTAssertTrue(html.contains("text-decoration"))
        XCTAssertTrue(html.contains("color:"))
        XCTAssertTrue(html.contains("预览样式"))
    }

    func testMarkdownPreviewUsesThemeTextColorForLegacyDefaultBlackInDarkMode() {
        let content = NSMutableAttributedString(string: "深色预览")
        content.addAttribute(.foregroundColor, value: NSColor.black, range: NSRange(location: 0, length: content.length))

        let html = MarkdownWebView(
            markdown: "",
            attributedContent: content,
            colorScheme: .dark,
            height: .constant(0),
            noteID: UUID()
        ).generateHTML(from: "", attributed: content, colorScheme: .dark)

        XCTAssertFalse(html.contains("color: #000000"))
        XCTAssertTrue(html.contains("color: #FFFFFF"))
    }

    @MainActor
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

        let note = try XCTUnwrap(store.activeNotes.first(where: { $0.id == noteID }))
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

        let restored = try XCTUnwrap(restartedStore.activeNotes.first(where: { $0.id == noteID })?.content)
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
        let restored = try XCTUnwrap(restartedStore.activeNotes.first(where: { $0.id == noteID })?.content)
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
        let restored = try XCTUnwrap(store.activeNotes.first(where: { $0.id == noteID })?.content)
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

    @MainActor
    private func makeInMemoryContainer() throws -> ModelContainer {
        let configuration = ModelConfiguration(schema: PersistenceController.appSchema, isStoredInMemoryOnly: true)
        return try ModelContainer(for: PersistenceController.appSchema, configurations: [configuration])
    }

    private func encodeTextPayload(_ spans: [MigratedInlineText]?) throws -> Data? {
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

    private func buildAttributedContent(from blocks: [MigratedDocumentBlock]) throws -> NSAttributedString {
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

    private func headingLevel(in content: NSAttributedString, at location: Int) -> Int? {
        let value = content.attribute(.notebookHeadingLevel, at: location, effectiveRange: nil)
        return (value as? NSNumber)?.intValue ?? (value as? Int)
    }

    private func hasCheckboxAttachment(in content: NSAttributedString) -> Bool {
        var found = false
        content.enumerateAttribute(.attachment, in: NSRange(location: 0, length: content.length), options: []) { value, _, stop in
            if value is CheckboxTextAttachment {
                found = true
                stop.pointee = true
            }
        }
        return found
    }

    private func sourceFileContents(relativePath: String) throws -> String {
        let rootURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: rootURL.appendingPathComponent(relativePath), encoding: .utf8)
    }

    @MainActor
    private func refreshedAttachmentRenderData(
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
    private func makeHostedTableAttachmentView(
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
    private func makeHostedRichTextView(content: NSAttributedString) -> (NSWindow, RichTextView) {
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
    private func sendLeftClick(to view: NSView, at point: NSPoint) {
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
    private func sendLeftDoubleClick(to view: NSView, at point: NSPoint) {
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
    private func sendRightClick(to view: NSView, at point: NSPoint) {
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
    private func performTableAction(_ selectorName: String, on tableView: TableAttachmentNSView) -> Bool {
        let selector = NSSelectorFromString(selectorName)
        guard tableView.responds(to: selector) else {
            XCTFail("Table view does not respond to \(selectorName)")
            return false
        }
        tableView.perform(selector, with: nil)
        return true
    }

    @MainActor
    private func resizeToIntrinsicContentSize(_ view: NSView) {
        view.frame.size = view.intrinsicContentSize
        view.window?.contentView?.frame.size = view.frame.size
        view.window?.setContentSize(view.frame.size)
        view.displayIfNeeded()
    }

    @MainActor
    private func sendKeyDown(to view: NSView, keyCode: UInt16, characters: String = "", modifiers: NSEvent.ModifierFlags = []) {
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
    private func sendEditingCommand(_ selector: Selector, in tableView: TableAttachmentNSView) -> Bool {
        guard let editor = tableView.subviews.compactMap({ $0 as? NSTextField }).first else {
            XCTFail("Expected active table editor")
            return false
        }
        return tableView.control(editor, textView: NSTextView(), doCommandBy: selector)
    }

    @MainActor
    private func renderedViewData(_ view: NSView, appearance: NSAppearance) -> Data? {
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
    private func pointForAttachment(in textView: RichTextView, range: NSRange) -> NSPoint? {
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

    private func pointForTableCell(row: Int, col: Int, tableData: TableData) -> NSPoint {
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

    private func resolvedRGBA(_ color: NSColor?, appearance: NSAppearance) -> [CGFloat]? {
        guard let color else { return nil }

        var components: [CGFloat]?
        appearance.performAsCurrentDrawingAppearance {
            guard let resolved = color.usingColorSpace(.deviceRGB) else { return }
            components = [resolved.redComponent, resolved.greenComponent, resolved.blueComponent, resolved.alphaComponent]
        }
        return components
    }

    @MainActor
    private func resetSharedTestState() {
        StorageLocationManager.shared.setBaseDirectoryForTesting(nil)
        NoteSaveManager.shared.resetForTesting()
        BackupManager.shared.markSaveComplete()
    }

    private func makeLegacyCheckboxImage(size: CGFloat) throws -> NSImage {
        let data = try makeLegacyCheckboxPNGData(size: size)
        return try XCTUnwrap(NSImage(data: data))
    }

    private func makeLegacyCheckboxPNGData(size: CGFloat) throws -> Data {
        try makePNGData(size: NSSize(width: size, height: size)) { context, rect in
            context.clear(rect)
            context.setStrokeColor(NSColor.tertiaryLabelColor.cgColor)
            context.setLineWidth(max(1, size / 16))
            context.strokeEllipse(in: rect.insetBy(dx: 1, dy: 1))
        }
    }

    private func makeFilledPNGData(size: NSSize, color: NSColor) throws -> Data {
        try makePNGData(size: size) { context, rect in
            context.setFillColor(color.cgColor)
            context.fill(rect)
        }
    }

    private func makePNGData(
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

    private func makeDeletedBlockNote(id: UUID, libraryID: UUID, title: String) -> BlockDocumentNoteEntity {
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
