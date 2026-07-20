import XCTest
import CryptoKit
@testable import Notebook

extension NotebookTests {
    @MainActor
    func testEditorDraftJournalEncryptsAndRoundTripsContent() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookDraftJournal_\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(data: Data(repeating: 0x42, count: 32))
        let journal = EditorDraftJournal(
            directoryURL: directory,
            isEnabled: true,
            keyProvider: { key }
        )
        let noteID = UUID()
        let content = NSAttributedString(string: "绝不能以明文出现在草稿文件里")
        let request = try makeDraftRequest(noteID: noteID, content: content, baseVersion: 7)

        try journal.persist(request)

        let fileURL = directory.appendingPathComponent("\(noteID.uuidString).draft")
        let encryptedBytes = try Data(contentsOf: fileURL)
        XCTAssertNil(String(data: encryptedBytes, encoding: .utf8)?.range(of: "绝不能以明文"))
        let filePermissions = try XCTUnwrap(
            FileManager.default.attributesOfItem(atPath: fileURL.path)[.posixPermissions] as? NSNumber
        ).intValue & 0o777
        let directoryPermissions = try XCTUnwrap(
            FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber
        ).intValue & 0o777
        XCTAssertEqual(filePermissions, 0o600)
        XCTAssertEqual(directoryPermissions, 0o700)
        let loaded = journal.loadAll()
        XCTAssertTrue(loaded.unreadableFiles.isEmpty)
        XCTAssertEqual(loaded.records.count, 1)
        XCTAssertEqual(loaded.records.first?.baseVersion, 7)
        let restored = try XCTUnwrap(loaded.records.first).makeSaveRequest()
        XCTAssertEqual(restored.decodedContent.string, content.string)
    }

    @MainActor
    func testEditorDraftJournalPreservesFileWhenKeyDoesNotMatch() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookDraftWrongKey_\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let noteID = UUID()
        let writer = EditorDraftJournal(
            directoryURL: directory,
            isEnabled: true,
            keyProvider: { SymmetricKey(data: Data(repeating: 0x11, count: 32)) }
        )
        try writer.persist(try makeDraftRequest(
            noteID: noteID,
            content: NSAttributedString(string: "keep me"),
            baseVersion: 1
        ))

        let reader = EditorDraftJournal(
            directoryURL: directory,
            isEnabled: true,
            keyProvider: { SymmetricKey(data: Data(repeating: 0x22, count: 32)) }
        )
        let loaded = reader.loadAll()

        XCTAssertTrue(loaded.records.isEmpty)
        XCTAssertEqual(loaded.unreadableFiles, ["\(noteID.uuidString).draft"])
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("\(noteID.uuidString).draft").path
        ))
    }

    @MainActor
    func testEditorDraftJournalRemovesOnlyAfterExplicitCommit() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookDraftRemoval_\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let noteID = UUID()
        let journal = EditorDraftJournal(
            directoryURL: directory,
            isEnabled: true,
            keyProvider: { SymmetricKey(data: Data(repeating: 0x33, count: 32)) }
        )
        try journal.persist(try makeDraftRequest(
            noteID: noteID,
            content: NSAttributedString(string: "pending"),
            baseVersion: 3
        ))
        XCTAssertEqual(journal.loadAll().records.count, 1)

        journal.remove(noteID: noteID)

        XCTAssertTrue(journal.loadAll().records.isEmpty)
    }

    private func makeDraftRequest(
        noteID: UUID,
        content: NSAttributedString,
        baseVersion: Int64
    ) throws -> SaveRequest {
        let data = try content.data(
            from: NSRange(location: 0, length: content.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
        )
        return SaveRequest(
            noteID: noteID,
            title: "Draft",
            folderID: nil,
            folder: "未分类",
            reminderAt: nil,
            recurrenceRule: "none",
            rtfdData: data,
            decodedContent: content,
            allowsDestructiveEmptySave: false,
            reason: "unitTest",
            timestamp: Date(),
            baseVersion: baseVersion
        )
    }
}
