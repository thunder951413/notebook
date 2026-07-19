import XCTest
import CryptoKit
@testable import Notebook

extension NotebookTests {
    func testSharedSyncContractFixtureSetIsUnchanged() throws {
        let fixtureNames = [
            "library-envelope.json",
            "note-envelope.json",
            "note-index.json",
            "reading-positions.json"
        ]
        var combined = Data()
        for name in fixtureNames {
            combined.append(Data(name.utf8))
            combined.append(0)
            combined.append(try syncContractFixtureData(named: name))
        }
        let digest = SHA256.hash(data: combined).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, "51e9cb5da4e074b75de3b9a22db7a26730e38459022296b775f2d3aba5c94ddc")
    }

    func testSharedNoteEnvelopeDecodesAndRoundTripsSemantically() throws {
        let decoder = JSONDecoder()
        let envelope = try decoder.decode(
            VersionedNoteSyncEnvelope.self,
            from: syncContractFixtureData(named: "note-envelope.json")
        )

        XCTAssertEqual(envelope.noteID, envelope.currentSnapshot.metadata.id)
        XCTAssertEqual(envelope.currentVersion, envelope.currentSnapshot.metadata.version)
        XCTAssertEqual(envelope.currentSnapshot.metadata.blockCount, envelope.currentSnapshot.document.blocks.count)
        XCTAssertEqual(envelope.currentSnapshot.metadata.assetCount, envelope.currentSnapshot.assets.count)
        XCTAssertEqual(envelope.currentSnapshot.document.blocks.map(\.type), [
            "heading", "paragraph", "todo_item", "table", "attachment"
        ])
        XCTAssertEqual(envelope.currentSnapshot.assets.first?.reference.id, "asset-fixture-1")
        XCTAssertEqual(envelope.currentSnapshot.todoSteps?.first?.noteID, envelope.noteID)
        XCTAssertEqual(envelope.readingPosition?.noteID, envelope.noteID)

        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let roundTripped = try decoder.decode(
            VersionedNoteSyncEnvelope.self,
            from: encoder.encode(envelope)
        )
        XCTAssertEqual(roundTripped.noteID, envelope.noteID)
        XCTAssertEqual(roundTripped.currentVersion, envelope.currentVersion)
        XCTAssertEqual(
            try BlockDocumentNoteVersionStore.snapshotFingerprint(roundTripped.currentSnapshot),
            try BlockDocumentNoteVersionStore.snapshotFingerprint(envelope.currentSnapshot)
        )
    }

    func testSharedLibraryAndIndexFixturesPreserveDeletionAndEncryptionSemantics() throws {
        let decoder = JSONDecoder()
        let library = try decoder.decode(
            LibrarySyncEnvelope.self,
            from: syncContractFixtureData(named: "library-envelope.json")
        )
        let encrypted = try XCTUnwrap(library.encryptedData)
        let encryptedNoteID = try XCTUnwrap(encrypted.encryptedNoteIDs.first)
        XCTAssertEqual(
            encrypted.noteToFolderMapping[encryptedNoteID],
            encrypted.encryptedFolders.first?.id.uuidString.lowercased()
        )
        XCTAssertEqual(library.deletedFolders?.count, 1)
        XCTAssertEqual(library.deletedTags?.count, 1)

        let index = try decoder.decode(
            RemoteNoteIndex.self,
            from: syncContractFixtureData(named: "note-index.json")
        )
        XCTAssertEqual(index.entries.count, 1)
        XCTAssertEqual(index.deletedEntries.count, 1)
        XCTAssertTrue(Set(index.entries.map(\.noteID)).isDisjoint(with: Set(index.deletedEntries.map(\.noteID))))
        XCTAssertEqual(index.entries.first?.contentHash.count, 64)
    }

    func testSharedReadingPositionFixtureUsesISO8601AndUTF16Coordinates() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try decoder.decode(
            ReadingPositionSyncEnvelope.self,
            from: syncContractFixtureData(named: "reading-positions.json")
        )
        let position = try XCTUnwrap(envelope.positions.first)
        XCTAssertEqual(envelope.schemaVersion, NoteReadingPosition.schemaVersion)
        XCTAssertEqual(position.anchorUTF16Offset, 321)
        XCTAssertEqual(position.viewportOffsetFraction, 0.25, accuracy: 0.0001)
        XCTAssertTrue(NoteReadingPosition.wins(position, over: nil))
    }

    private func syncContractFixtureData(named name: String) throws -> Data {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try Data(contentsOf: repositoryRoot
            .appendingPathComponent("SyncContractFixtures", isDirectory: true)
            .appendingPathComponent(name))
    }
}
