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
}
