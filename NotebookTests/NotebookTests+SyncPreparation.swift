import XCTest
@testable import Notebook

extension NotebookTests {
    @MainActor
    func testSyncPreparationCapturesCurrentEditorBeforeContinuing() throws {
        var editorSaveCount = 0
        NoteSaveManager.shared.registerEditorSaveHandler {
            editorSaveCount += 1
            return true
        }

        try NoteSaveManager.shared.prepareForSync()

        XCTAssertEqual(editorSaveCount, 1)
    }

    @MainActor
    func testSyncPreparationStopsWhenCurrentEditorCannotBeSaved() {
        NoteSaveManager.shared.registerEditorSaveHandler { false }

        XCTAssertThrowsError(try NoteSaveManager.shared.prepareForSync()) { error in
            guard case SyncPreparationError.editorSaveFailed = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    @MainActor
    func testOldEditorCannotUnregisterNewEditorSaveHandler() throws {
        let oldID = NoteSaveManager.shared.registerEditorSaveHandler { false }
        var newEditorSaved = false
        _ = NoteSaveManager.shared.registerEditorSaveHandler {
            newEditorSaved = true
            return true
        }

        NoteSaveManager.shared.unregisterEditorSaveHandler(id: oldID)
        try NoteSaveManager.shared.prepareForSync()

        XCTAssertTrue(newEditorSaved)
    }

    @MainActor
    func testSyncPreparationStopsWhenPendingSaveCannotBeWritten() {
        let request = SaveRequest(
            noteID: UUID(),
            title: "Unsaved",
            folderID: nil,
            folder: "",
            reminderAt: nil,
            recurrenceRule: "none",
            rtfdData: Data([0x00]),
            decodedContent: NSAttributedString(string: "Unsaved content"),
            allowsDestructiveEmptySave: false,
            reason: "test",
            timestamp: Date()
        )
        NoteSaveManager.shared.scheduleSave(request: request, delay: 60)

        XCTAssertThrowsError(try NoteSaveManager.shared.prepareForSync()) { error in
            guard case SyncPreparationError.pendingSaveFailed = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    @MainActor
    func testSyncSessionSavesEditsMadeWhileRemoteOperationRuns() async throws {
        var revision = "before"
        var saveCount = 0
        NoteSaveManager.shared.registerEditorSaveHandler(revisionProvider: { revision }) {
            saveCount += 1
            return true
        }

        try await SyncSessionCoordinator.shared.withSession(named: "test") {
            revision = "after"
        }

        XCTAssertEqual(saveCount, 2)
    }

    @MainActor
    func testCancelledSyncSessionStillSavesEditsMadeWhileRemoteOperationRuns() async throws {
        var revision = "before"
        var saveCount = 0
        NoteSaveManager.shared.registerEditorSaveHandler(revisionProvider: { revision }) {
            saveCount += 1
            return true
        }

        let syncTask = Task { @MainActor in
            try await SyncSessionCoordinator.shared.withSession(named: "cancel-test") {
                revision = "during-sync"
                try await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
        while revision != "during-sync" { await Task.yield() }
        syncTask.cancel()

        do {
            _ = try await syncTask.value
            XCTFail("取消后的同步不应成功")
        } catch is CancellationError {
            XCTAssertEqual(saveCount, 2)
        }
    }

    @MainActor
    func testSyncSessionRejectsOverlappingBackendOperation() async throws {
        NoteSaveManager.shared.registerEditorSaveHandler { true }

        try await SyncSessionCoordinator.shared.withSession(named: "outer") {
            do {
                try await SyncSessionCoordinator.shared.withSession(named: "inner") {}
                XCTFail("Expected overlapping sync to be rejected")
            } catch let error as SyncSessionError {
                guard case .alreadyRunning("outer") = error else {
                    return XCTFail("Unexpected error: \(error)")
                }
            }
        }
    }

    @MainActor
    func testSavedNoteIsNotQueuedWhenRemoteIsNotConfigured() async {
        let backend = TestNoteSyncBackend(isConfigured: false)
        let coordinator = AutoSyncCoordinator(backend: backend)

        coordinator.noteDidSave(noteID: UUID(), reason: "testSave")
        await coordinator.waitForSavedNotePushesForTesting()

        XCTAssertTrue(backend.pushedNoteIDs.isEmpty)
        XCTAssertEqual(coordinator.pendingSavedNotePushCountForTesting, 0)
    }

    @MainActor
    func testSavedChangedNoteIsPushedToConfiguredRemote() async {
        let backend = TestNoteSyncBackend()
        let coordinator = AutoSyncCoordinator(backend: backend)
        let firstNoteID = UUID()
        let secondNoteID = UUID()

        coordinator.noteDidSave(noteID: firstNoteID, reason: "autoSave")
        coordinator.noteDidSave(noteID: secondNoteID, reason: "manualSave")
        await coordinator.waitForSavedNotePushesForTesting()

        XCTAssertEqual(Set(backend.pushedNoteIDs), Set([firstNoteID, secondNoteID]))
        XCTAssertEqual(backend.pushedNoteIDs.count, 2)
        XCTAssertEqual(coordinator.pendingSavedNotePushCountForTesting, 0)
    }

    @MainActor
    func testAutomaticFullSyncUsesInjectedBackend() async {
        let backend = TestNoteSyncBackend()
        let coordinator = AutoSyncCoordinator(backend: backend)

        await coordinator.runAutomaticPullForTesting()
        XCTAssertEqual(backend.pullAllCallCount, 1)
        XCTAssertEqual(backend.pushAllCallCount, 0)

        coordinator.libraryDidChange(reason: "test")
        await coordinator.runAutomaticPushForTesting()
        XCTAssertEqual(backend.pullAllCallCount, 2, "全量推送前应先合并远程变更")
        XCTAssertEqual(backend.pushAllCallCount, 1)
    }

    func testNotificationCancellationInvalidatesInFlightSchedule() {
        var tracker = NotificationScheduleRevisionTracker()
        let itemID = UUID()
        let schedulingRevision = tracker.begin(for: itemID)

        tracker.invalidate(for: itemID)

        XCTAssertFalse(tracker.isCurrent(schedulingRevision, for: itemID))
    }

    func testNewNotificationScheduleSupersedesOlderSchedule() {
        var tracker = NotificationScheduleRevisionTracker()
        let itemID = UUID()
        let oldRevision = tracker.begin(for: itemID)
        let newRevision = tracker.begin(for: itemID)

        XCTAssertFalse(tracker.isCurrent(oldRevision, for: itemID))
        XCTAssertTrue(tracker.isCurrent(newRevision, for: itemID))
    }
}

@MainActor
private final class TestNoteSyncBackend: NoteSyncBackend {
    let isConfigured: Bool
    let isPersistenceAvailable: Bool
    private(set) var pushedNoteIDs: [UUID] = []
    private(set) var pullAllCallCount = 0
    private(set) var pushAllCallCount = 0

    init(isConfigured: Bool = true, isPersistenceAvailable: Bool = true) {
        self.isConfigured = isConfigured
        self.isPersistenceAvailable = isPersistenceAvailable
    }

    func pushSavedNote(noteID: UUID) async throws {
        pushedNoteIDs.append(noteID)
    }

    func pullAllNotes() async throws {
        pullAllCallCount += 1
    }

    func pushAllNotes() async throws {
        pushAllCallCount += 1
    }
}
