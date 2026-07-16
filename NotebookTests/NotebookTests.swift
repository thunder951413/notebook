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

    func testSwiftUITooltipsAreDisabledOnMacOS27() {
        XCTAssertTrue(NotebookRuntimeCompatibility.allowsSwiftUITooltips(osMajorVersion: 26))
        XCTAssertFalse(NotebookRuntimeCompatibility.allowsSwiftUITooltips(osMajorVersion: 27))
        XCTAssertFalse(NotebookRuntimeCompatibility.allowsSwiftUITooltips(osMajorVersion: 28))
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

    func testReadingPositionConflictUsesTimestampThenDeviceID() {
        let noteID = UUID()
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let older = NoteReadingPosition(
            noteID: noteID,
            anchorUTF16Offset: 10,
            viewportOffsetFraction: 0,
            updatedAt: date.addingTimeInterval(-1),
            deviceID: "z-device"
        )
        let current = NoteReadingPosition(
            noteID: noteID,
            anchorUTF16Offset: 20,
            viewportOffsetFraction: 0.2,
            updatedAt: date,
            deviceID: "a-device"
        )
        let tieBreakerWinner = NoteReadingPosition(
            noteID: noteID,
            anchorUTF16Offset: 30,
            viewportOffsetFraction: -0.1,
            updatedAt: date,
            deviceID: "z-device"
        )

        XCTAssertFalse(NoteReadingPosition.wins(older, over: current))
        XCTAssertTrue(NoteReadingPosition.wins(tieBreakerWinner, over: current))
    }

    @MainActor
    func testReadingPositionPersistsAndRejectsStaleMerge() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let noteID = UUID()
        let newer = NoteReadingPosition(
            noteID: noteID,
            anchorUTF16Offset: 321,
            viewportOffsetFraction: 0.25,
            updatedAt: Date(),
            deviceID: "mac"
        )
        let stale = NoteReadingPosition(
            noteID: noteID,
            anchorUTF16Offset: 1,
            viewportOffsetFraction: 0,
            updatedAt: newer.updatedAt.addingTimeInterval(-10),
            deviceID: "android"
        )

        XCTAssertTrue(try NoteReadingPositionStore.merge(newer, context: context))
        try context.save()
        XCTAssertFalse(try NoteReadingPositionStore.merge(stale, context: context))
        XCTAssertEqual(try NoteReadingPositionStore.all(context: context), [newer])
    }


}
