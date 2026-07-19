import XCTest
import SwiftData
import AppKit
@testable import Notebook

extension NotebookTests {
    func testSyncBarrierNeverTreatsMetadataPlaceholderAsContent() {
        let staleBoundID = UUID()
        let selectedID = UUID()

        XCTAssertEqual(
            EditorSaveBarrierPolicy.plan(
                boundNoteID: staleBoundID,
                hasLiveEditor: false,
                selectedNoteID: selectedID,
                selectedContentIsLoaded: false,
                selectedHasUnsavedChanges: true
            ),
            .noContentSaveRequired
        )
        XCTAssertEqual(
            EditorSaveBarrierPolicy.plan(
                boundNoteID: staleBoundID,
                hasLiveEditor: false,
                selectedNoteID: selectedID,
                selectedContentIsLoaded: true,
                selectedHasUnsavedChanges: true
            ),
            .loadedPreview(noteID: selectedID)
        )
        XCTAssertEqual(
            EditorSaveBarrierPolicy.plan(
                boundNoteID: staleBoundID,
                hasLiveEditor: true,
                selectedNoteID: selectedID,
                selectedContentIsLoaded: false,
                selectedHasUnsavedChanges: true
            ),
            .liveEditor(noteID: staleBoundID)
        )
    }

    @MainActor
    func testDestructiveExplicitSaveBacksUpPersistedContentAndPinsRecoveryVersion() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "恢复锚点")
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookPersistedBackup-\(UUID().uuidString)", isDirectory: true)
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

        let originalText = String(repeating: "安全正文段落。", count: 100)
        let original = try XCTUnwrap(NoteSaveManager.shared.createRequest(
            noteID: noteID,
            title: "恢复锚点",
            folderID: nil,
            folder: "未分类",
            reminderAt: nil,
            recurrenceRule: "none",
            content: NSAttributedString(string: originalText),
            reason: "testSeed"
        ))
        guard case .success = NoteSaveManager.shared.saveImmediately(request: original) else {
            return XCTFail("Failed to seed persisted content")
        }

        let empty = try XCTUnwrap(NoteSaveManager.shared.createRequest(
            noteID: noteID,
            title: "恢复锚点",
            folderID: nil,
            folder: "未分类",
            reminderAt: nil,
            recurrenceRule: "none",
            content: NSAttributedString(string: ""),
            reason: "commandSave",
            allowsDestructiveEmptySave: true
        ))
        guard case .success = NoteSaveManager.shared.saveImmediately(request: empty) else {
            return XCTFail("Explicit empty save should succeed")
        }

        let persistedBackup = try XCTUnwrap(BackupManager.shared.getBackups(for: noteID).first)
        XCTAssertEqual(persistedBackup.backupReason, "before_commandSave")
        let backedUpContent = try NSAttributedString(
            data: persistedBackup.rtfdData,
            options: [.documentType: NSAttributedString.DocumentType.rtfd],
            documentAttributes: nil
        )
        XCTAssertEqual(backedUpContent.string, originalText)

        try BlockDocumentNoteVersionStore.pruneHistory(
            noteID: noteID,
            context: context,
            maxCount: 1,
            maxAgeDays: 0
        )
        let retained = try BlockDocumentNoteVersionStore.history(for: noteID, context: context)
        XCTAssertEqual(retained.count, 2)
        let snapshots = try retained.map {
            try XCTUnwrap(BlockDocumentNoteVersionStore.snapshot(noteID: noteID, version: $0.version, context: context))
        }
        XCTAssertTrue(BlockDocumentNoteVersionStore.isCatastrophicContentReduction(from: snapshots[0], to: snapshots[1]))
    }

    @MainActor
    func testCatastrophicRemoteReductionRequiresConflictInsteadOfFastForward() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = try insertMinimalBlockLibrary(context: context, title: "远程缩减保护")
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookRemoteReduction-\(UUID().uuidString)", isDirectory: true)
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

        let seed = try XCTUnwrap(NoteSaveManager.shared.createRequest(
            noteID: noteID,
            title: "远程缩减保护",
            folderID: nil,
            folder: "未分类",
            reminderAt: nil,
            recurrenceRule: "none",
            content: NSAttributedString(string: String(repeating: "完整正文。", count: 100)),
            reason: "testSeed"
        ))
        guard case .success = NoteSaveManager.shared.saveImmediately(request: seed) else {
            return XCTFail("Failed to seed content")
        }

        let backendID = "test-catastrophic-reduction"
        let localEnvelope = try XCTUnwrap(BlockDocumentNoteVersionStore.exportEnvelope(
            noteID: noteID,
            context: context,
            backendID: backendID
        ))
        try BlockDocumentNoteVersionStore.markSynced(
            noteID: noteID,
            syncedVersion: localEnvelope.currentVersion,
            context: context,
            backendID: backendID
        )

        let localMetadata = localEnvelope.currentSnapshot.metadata
        let remoteMetadata = DocumentMigrationPackage.NoteItem(
            id: localMetadata.id,
            title: localMetadata.title,
            createdAt: localMetadata.createdAt,
            updatedAt: Date(),
            folderID: localMetadata.folderID,
            folderName: localMetadata.folderName,
            reminderAt: localMetadata.reminderAt,
            recurrenceRule: localMetadata.recurrenceRule,
            version: localEnvelope.currentVersion + 1,
            tagIDs: localMetadata.tagIDs,
            viewMode: "preview",
            deletedAt: localMetadata.deletedAt,
            originalFolderID: localMetadata.originalFolderID,
            originalFolderName: localMetadata.originalFolderName,
            blockCount: 1,
            assetCount: 0,
            documentPath: localMetadata.documentPath,
            itemType: localMetadata.itemType,
            todoDueAt: localMetadata.todoDueAt,
            todoCompletedAt: localMetadata.todoCompletedAt,
            todoIsImportant: localMetadata.todoIsImportant,
            todoOrder: localMetadata.todoOrder,
            linkedNoteIDs: localMetadata.linkedNoteIDs
        )
        let emptyBlock = MigratedDocumentBlock(
            id: UUID().uuidString,
            type: "paragraph",
            text: [],
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: nil,
            asset: nil,
            table: nil
        )
        let remoteSnapshot = VersionedNoteSnapshot(
            metadata: remoteMetadata,
            document: MigratedDocument(
                schemaVersion: localEnvelope.currentSnapshot.document.schemaVersion,
                source: localEnvelope.currentSnapshot.document.source,
                blocks: [emptyBlock]
            ),
            assets: [],
            todoSteps: localEnvelope.currentSnapshot.todoSteps
        )
        let remoteEnvelope = VersionedNoteSyncEnvelope(
            noteID: noteID,
            deviceID: "different-device",
            exportedAt: Date(),
            currentVersion: remoteMetadata.version,
            currentSnapshot: remoteSnapshot,
            history: localEnvelope.history,
            syncState: localEnvelope.syncState,
            readingPosition: nil
        )

        let result = try BlockDocumentNoteVersionStore.mergeRemoteEnvelope(
            remoteEnvelope,
            context: context,
            backendID: backendID
        )
        XCTAssertTrue(result.detectedConflict)
        XCTAssertFalse(result.appliedRemoteSnapshot)

        let note = try XCTUnwrap(context.fetch(
            FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.id == noteID })
        ).first)
        XCTAssertTrue(note.hasConflict)
        XCTAssertGreaterThan(note.blockCount, 0)
        XCTAssertEqual(note.version, localEnvelope.currentVersion)
    }
}
