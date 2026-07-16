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

    func testUUIDListCodingPreservesOrderAndDropsInvalidDuplicates() {
        let first = UUID()
        let second = UUID()
        let decoded = UUIDListCoding.decode(" \(first.uuidString),invalid,\(second.uuidString),\(first.uuidString) ")

        XCTAssertEqual(decoded, [first, second])
        XCTAssertEqual(UUIDListCoding.encode(decoded + [first]), "\(first.uuidString),\(second.uuidString)")
    }

    func testInitialNoteContentPolicyKeepsOnlyMostRecentExistingNote() {
        let missingID = UUID()
        let recentID = UUID()
        let olderID = UUID()

        let loadedIDs = NoteContentRetentionPolicy.initialContentIDs(
            existingNoteIDs: [recentID, olderID],
            recentSelectedNoteIDs: [missingID, recentID, olderID],
            lastSelectedNoteID: olderID,
            fallbackNoteID: nil
        )

        XCTAssertEqual(loadedIDs, [recentID])
        XCTAssertEqual(loadedIDs.count, NoteContentRetentionPolicy.maximumLoadedNoteCount)
    }

    func testInitialNoteContentPolicyUsesFallbackWhenHistoryIsUnavailable() {
        let fallbackID = UUID()

        let loadedIDs = NoteContentRetentionPolicy.initialContentIDs(
            existingNoteIDs: [fallbackID],
            recentSelectedNoteIDs: [UUID()],
            lastSelectedNoteID: UUID(),
            fallbackNoteID: fallbackID
        )

        XCTAssertEqual(loadedIDs, [fallbackID])
    }


}
