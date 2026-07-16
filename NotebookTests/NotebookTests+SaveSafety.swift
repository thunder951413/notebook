import XCTest
import SwiftData
import AppKit
@testable import Notebook

extension NotebookTests {
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
