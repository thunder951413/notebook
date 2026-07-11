import XCTest
@testable import Notebook

extension NotebookTests {
    func testAtomicFileCommitReplacesDestinationWithVerifiedCopy() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookAtomicTest_\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let source = directory.appendingPathComponent("source")
        let destination = directory.appendingPathComponent("destination")
        try Data("new".utf8).write(to: source)
        try Data("old".utf8).write(to: destination)

        try AtomicFileCommit.copyReplacingAtomically(from: source, to: destination)

        XCTAssertEqual(try Data(contentsOf: destination), Data("new".utf8))
        XCTAssertEqual(try AtomicFileCommit.sha256(of: destination), try AtomicFileCommit.sha256(of: source))
    }

    func testAtomicFileCommitPreservesDestinationWhenSourceIsMissing() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookAtomicFailureTest_\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let destination = directory.appendingPathComponent("destination")
        try Data("old".utf8).write(to: destination)

        XCTAssertThrowsError(
            try AtomicFileCommit.copyReplacingAtomically(
                from: directory.appendingPathComponent("missing"),
                to: destination
            )
        )
        XCTAssertEqual(try Data(contentsOf: destination), Data("old".utf8))
    }
}
