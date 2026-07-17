import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {

    @MainActor
    func testMovingEncryptedNoteUpdatesPersistentFolderAndEncryptedMapping() throws {
        EncryptedFolderManager.shared.clearAllEncryptedData()
        NotebookDefaults.shared.removeObject(forKey: "encrypted_folders")
        defer {
            EncryptedFolderManager.shared.clearAllEncryptedData()
            NotebookDefaults.shared.removeObject(forKey: "encrypted_folders")
        }

        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let store = NoteStore()
        store.setContext(context)
        store.createEncryptedFolder(name: "来源")
        store.createEncryptedFolder(name: "目标")

        let sourceFolder = try XCTUnwrap(store.encryptedFolders.first(where: { $0.name == "来源" }))
        let targetFolder = try XCTUnwrap(store.encryptedFolders.first(where: { $0.name == "目标" }))
        let note = try XCTUnwrap(store.createEncryptedNote(in: sourceFolder.id))
        XCTAssertEqual(EncryptedFolderManager.shared.getEncryptedFolderID(for: note), sourceFolder.id)

        let movedNote = try XCTUnwrap(store.moveNoteToEncryptedFolder(id: note.id, to: targetFolder.id))
        XCTAssertEqual(movedNote.folderID, targetFolder.id)
        XCTAssertEqual(movedNote.folder, "🔒 目标")
        XCTAssertEqual(EncryptedFolderManager.shared.getEncryptedFolderID(for: movedNote), targetFolder.id)

        let noteID = note.id
        let persisted = try XCTUnwrap(
            try context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        XCTAssertEqual(persisted.folderID, targetFolder.id)
        XCTAssertEqual(persisted.folderName, "🔒 目标")
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
    func testMissingViewModeDefaultsToMarkdownAndSavedModeStillRestores() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "模式恢复")
        let idToMatch = noteID
        let entity = try XCTUnwrap(
            context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
                )
            ).first
        )
        entity.viewMode = ""
        try context.save()

        let store = NoteStore()
        store.setContext(context)
        XCTAssertEqual(
            try XCTUnwrap(store.notes.first(where: { $0.id == noteID })).viewMode,
            .preview
        )

        entity.viewMode = NoteViewMode.split.rawValue
        try context.save()
        store.fetchData()
        XCTAssertEqual(
            try XCTUnwrap(store.notes.first(where: { $0.id == noteID })).viewMode,
            .split
        )
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
}
