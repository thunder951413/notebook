import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {

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
}
