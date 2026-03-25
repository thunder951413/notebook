import XCTest
import SwiftData
@testable import Notebook

final class NotebookTests: XCTestCase {
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
                        fontSize: nil
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
        let image = NSImage(size: NSSize(width: 1, height: 1))
        image.lockFocus()
        NSColor.systemBlue.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 1, height: 1)).fill()
        image.unlockFocus()
        let bitmapRepresentation = try XCTUnwrap(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        let imageData = try XCTUnwrap(bitmapRepresentation.representation(using: .png, properties: [:]))
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

    private func makeInMemoryContainer() throws -> ModelContainer {
        let configuration = ModelConfiguration(schema: PersistenceController.appSchema, isStoredInMemoryOnly: true)
        return try ModelContainer(for: PersistenceController.appSchema, configurations: [configuration])
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
