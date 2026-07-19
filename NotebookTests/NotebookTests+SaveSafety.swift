import XCTest
import SwiftData
import AppKit
@testable import Notebook

extension NotebookTests {
    @MainActor
    func testFirstSaveAfterPersistedEmptyPlaceholderCreatesVerifiedBackupAndSucceeds() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "首次保存")
        let note = try XCTUnwrap(context.fetch(
            FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
            )
        ).first)
        note.blockCount = 1
        let placeholder = BlockDocumentBlockEntity(
            noteID: noteID,
            position: 0,
            blockID: "empty-placeholder",
            kind: "paragraph",
            sourceType: "paragraph",
            textPayload: nil,
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: nil,
            assetID: nil,
            tablePayload: nil
        )
        placeholder.note = note
        context.insert(placeholder)
        try context.save()

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookFirstSave-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        StorageLocationManager.shared.setBaseDirectoryForTesting(baseDirectory)
        let backupDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Notebook/Backups/\(noteID.uuidString)", isDirectory: true)
        defer {
            StorageLocationManager.shared.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
            try? FileManager.default.removeItem(at: backupDirectory)
        }
        try StorageLocationManager.shared.ensureDirectoryStructureExists()
        NoteSaveManager.shared.setContext(context)

        let request = try XCTUnwrap(NoteSaveManager.shared.createRequest(
            noteID: noteID,
            title: note.title,
            folderID: nil,
            folder: note.folderName,
            reminderAt: nil,
            recurrenceRule: "none",
            content: NSAttributedString(string: "第一段可靠正文"),
            reason: "explicit"
        ))
        guard case .success = NoteSaveManager.shared.saveImmediately(request: request) else {
            return XCTFail("首次正文保存不应被空占位块的备份校验拦截")
        }

        let backup = try XCTUnwrap(BackupManager.shared.getBackups(for: noteID).first)
        let backedUpContent = try NSAttributedString(
            data: backup.rtfdData,
            options: [.documentType: NSAttributedString.DocumentType.rtfd],
            documentAttributes: nil
        )
        XCTAssertEqual(backedUpContent.string, "")

        let restored = NoteStore()
        restored.setContext(context)
        XCTAssertEqual(restored.ensureNoteContentLoaded(id: noteID)?.content.string, "第一段可靠正文")
    }

    @MainActor
    func testAutomaticEmptySnapshotCannotOverwritePersistedContent() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "重要笔记")
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

        let original = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "重要笔记",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: NSAttributedString(string: "绝不能丢失的正文"),
                reason: "testSeed"
            )
        )
        guard case .success = NoteSaveManager.shared.saveImmediately(request: original) else {
            return XCTFail("Failed to seed persisted content")
        }

        let entityBefore = try XCTUnwrap(
            context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        let versionBefore = entityBefore.version
        let backupCountBefore = BackupManager.shared.getBackups(for: noteID).count
        let emptyRequest = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "重要笔记",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: NSAttributedString(string: ""),
                reason: "appBlur"
            )
        )

        switch NoteSaveManager.shared.saveImmediately(request: emptyRequest) {
        case .success:
            XCTFail("Automatic empty snapshot must be rejected")
        case .failure(let error):
            guard case SaveSafetyError.destructiveEmptySnapshotBlocked = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }

        let entityAfter = try XCTUnwrap(
            context.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        XCTAssertEqual(entityAfter.version, versionBefore)
        XCTAssertEqual(BackupManager.shared.getBackups(for: noteID).count, backupCountBefore)
        let restored = NoteStore()
        restored.setContext(context)
        XCTAssertEqual(restored.ensureNoteContentLoaded(id: noteID)?.content.string, "绝不能丢失的正文")
    }

    @MainActor
    func testExplicitSaveCanIntentionallyClearPersistedContent() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "允许清空")
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

        let original = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "允许清空",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: NSAttributedString(string: "准备主动清空"),
                reason: "testSeed"
            )
        )
        guard case .success = NoteSaveManager.shared.saveImmediately(request: original) else {
            return XCTFail("Failed to seed persisted content")
        }

        let emptyRequest = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "允许清空",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: NSAttributedString(string: ""),
                reason: "commandSave",
                allowsDestructiveEmptySave: true
            )
        )
        guard case .success = NoteSaveManager.shared.saveImmediately(request: emptyRequest) else {
            return XCTFail("Explicit save should be allowed to clear content")
        }

        let restored = NoteStore()
        restored.setContext(context)
        XCTAssertEqual(restored.ensureNoteContentLoaded(id: noteID)?.content.length, 0)
    }
}
