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


}
