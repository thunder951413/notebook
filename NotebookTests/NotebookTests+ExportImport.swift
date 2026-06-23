import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {

    @MainActor
    func testExportedMigrationPackageRestoresPersistedImageAssets() async throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()

        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let sourceContainer = try makeInMemoryContainer()
        let sourceContext = sourceContainer.mainContext
        let libraryID = UUID()
        let noteID = UUID()
        let assetID = "asset-image-1"
        let relativeFilePath = "BlockDocuments/\(noteID.uuidString)/\(assetID)/Attachment.png"

        sourceContext.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 1,
                folderCount: 0,
                tagCount: 0
            )
        )
        sourceContext.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "带图片迁移包",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: nil,
                folderName: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 1,
                tagIDs: "",
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 1,
                assetCount: 1
            )
        )
        sourceContext.insert(
            BlockDocumentAssetEntity(
                noteID: noteID,
                assetID: assetID,
                kind: "image",
                sourceKind: "image",
                filename: "Attachment.png",
                mimeType: "image/png",
                width: 64,
                height: 64,
                duration: nil,
                createdAt: Date(),
                relativeFilePath: relativeFilePath,
                sidecarPathsPayload: nil
            )
        )
        sourceContext.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 0,
                blockID: "block-image",
                kind: "image",
                sourceType: "image",
                textPayload: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: 0,
                assetID: assetID,
                tablePayload: nil
            )
        )

        let sourceFileURL = attachmentsRoot.appendingPathComponent(relativeFilePath)
        try FileManager.default.createDirectory(at: sourceFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("image-data".utf8).write(to: sourceFileURL, options: .atomic)
        try sourceContext.save()

        let exportURL = try await DataExportManager.shared.exportAllNotesOnly(context: sourceContext)
        defer { try? FileManager.default.removeItem(at: exportURL) }

        let destinationContainer = try makeInMemoryContainer()
        let destinationContext = destinationContainer.mainContext
        try await DataExportManager.shared.importNotes(from: exportURL, context: destinationContext)

        let importedAsset = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentAssetEntity>()).first)
        let importedBlock = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentBlockEntity>()).first)
        let persistedAssetURL = attachmentsRoot.appendingPathComponent(importedAsset.relativeFilePath)

        XCTAssertEqual(importedAsset.kind, "image")
        XCTAssertEqual(importedAsset.assetID, assetID)
        XCTAssertEqual(importedBlock.assetID, assetID)
        XCTAssertTrue(importedAsset.filename.hasPrefix("Assets/"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: persistedAssetURL.path), persistedAssetURL.path)
        XCTAssertEqual(try Data(contentsOf: persistedAssetURL), Data("image-data".utf8))
    }

    @MainActor
    func testImportConfigurationUsesPlistRadialSettingsAndSkipsStorageBookmark() async throws {
        let defaults = UserDefaults.standard
        let keysToClear = [
            "radialMenuEnabled",
            "radialMenuTrigger",
            "radialMenuRadius",
            "radialMenuItemSize",
            "radialMenuScale",
            "startup_behavior",
            "storageDirectoryBookmark"
        ]
        defer {
            for key in keysToClear {
                defaults.removeObject(forKey: key)
            }
        }

        let rootDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: rootDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: rootDir) }

        let userDefaultsPayload: [String: Any] = [
            "startup_behavior": "all_notes",
            "storageDirectoryBookmark": Data("legacy-bookmark".utf8)
        ]
        try PropertyListSerialization.data(fromPropertyList: userDefaultsPayload, format: .xml, options: 0)
            .write(to: rootDir.appendingPathComponent("UserDefaults.plist"))

        let radialMenuPayload: [String: Any] = [
            "isEnabled": true,
            "trigger": "right_click",
            "menuRadius": 160.0,
            "itemSize": 52.0,
            "menuScale": 1.2
        ]
        try PropertyListSerialization.data(fromPropertyList: radialMenuPayload, format: .xml, options: 0)
            .write(to: rootDir.appendingPathComponent("RadialMenuSettings.plist"))

        let zipURL = try DataExportManager.shared.createArchiveForTesting(from: rootDir, prefix: "ConfigImportTest")
        defer { try? FileManager.default.removeItem(at: zipURL) }

        try await DataExportManager.shared.importConfiguration(from: zipURL)

        XCTAssertEqual(defaults.string(forKey: "startup_behavior"), "all_notes")
        XCTAssertTrue(defaults.bool(forKey: "radialMenuEnabled"))
        XCTAssertEqual(defaults.string(forKey: "radialMenuTrigger"), "right_click")
        XCTAssertEqual(defaults.double(forKey: "radialMenuRadius"), 160.0, accuracy: 0.001)
        XCTAssertEqual(defaults.double(forKey: "radialMenuItemSize"), 52.0, accuracy: 0.001)
        XCTAssertEqual(defaults.double(forKey: "radialMenuScale"), 1.2, accuracy: 0.001)
        XCTAssertNil(defaults.object(forKey: "storageDirectoryBookmark"))
    }

    @MainActor
    func testImportAllDataPreflightFailureKeepsExistingLibraryUntouched() async throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()

        let sourceContainer = try makeInMemoryContainer()
        let sourceContext = sourceContainer.mainContext
        try insertMinimalBlockLibrary(context: sourceContext, title: "待导入数据")

        let notesArchiveURL = try await DataExportManager.shared.exportAllNotesOnly(context: sourceContext)
        defer { try? FileManager.default.removeItem(at: notesArchiveURL) }

        let destinationContainer = try makeInMemoryContainer()
        let destinationContext = destinationContainer.mainContext
        let existingNoteID = try insertMinimalBlockLibrary(context: destinationContext, title: "现有数据")

        let importRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let notesDir = importRoot.appendingPathComponent("Notes", isDirectory: true)
        let configDir = importRoot.appendingPathComponent("Config", isDirectory: true)
        try FileManager.default.createDirectory(at: notesDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: importRoot) }

        try DataExportManager.shared.extractArchive(at: notesArchiveURL, to: notesDir)
        try Data("not-a-valid-plist".utf8).write(to: configDir.appendingPathComponent("RadialMenuSettings.plist"))

        let importArchiveURL = try DataExportManager.shared.createArchiveForTesting(from: importRoot, prefix: "InvalidAllDataImport")
        defer { try? FileManager.default.removeItem(at: importArchiveURL) }

        do {
            try await DataExportManager.shared.importAllData(from: importArchiveURL, context: destinationContext)
            XCTFail("Expected invalid configuration preflight to throw")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }

        let notes = try destinationContext.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes.first?.id, existingNoteID)
        XCTAssertEqual(notes.first?.title, "现有数据")
    }

    @MainActor


    func testExportAllDataOmitsStorageBookmarkAndDatabaseDirectory() async throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            UserDefaults.standard.removeObject(forKey: "storageDirectoryBookmark")
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()
        UserDefaults.standard.set(Data("bookmark".utf8), forKey: "storageDirectoryBookmark")

        let container = try makeInMemoryContainer()
        let context = container.mainContext
        try insertMinimalBlockLibrary(context: context, title: "导出检查")

        let exportURL = try await DataExportManager.shared.exportAllData(context: context)
        defer { try? FileManager.default.removeItem(at: exportURL) }

        let extractDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: extractDir) }

        try DataExportManager.shared.extractArchive(at: exportURL, to: extractDir)

        let userDefaultsURL = extractDir.appendingPathComponent("Config/UserDefaults.plist")
        let exportedDefaults = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: Data(contentsOf: userDefaultsURL), format: nil) as? [String: Any]
        )

        XCTAssertNil(exportedDefaults["storageDirectoryBookmark"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: extractDir.appendingPathComponent("Database").path))
    }

    func testExportedMigrationPackageImportsIntoFreshBlockLibrary() async throws {
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        defer {
            storage.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        try storage.ensureDirectoryStructureExists()

        let sourceContainer = try makeInMemoryContainer()
        let sourceContext = sourceContainer.mainContext
        let libraryID = UUID()
        let folderID = UUID()
        let tagID = UUID()
        let noteID = UUID()

        sourceContext.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(timeIntervalSince1970: 50),
                importedAt: Date(timeIntervalSince1970: 60),
                noteCount: 1,
                folderCount: 1,
                tagCount: 1
            )
        )
        sourceContext.insert(
            BlockDocumentFolderEntity(
                id: folderID,
                libraryID: libraryID,
                name: "工作",
                sortOrder: 1,
                isSystem: false,
                createdAt: Date(timeIntervalSince1970: 70)
            )
        )
        sourceContext.insert(
            BlockDocumentTagEntity(
                id: tagID,
                libraryID: libraryID,
                name: "重要",
                color: "red",
                createdAt: Date(timeIntervalSince1970: 80)
            )
        )
        sourceContext.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "迁移包导入测试",
                createdAt: Date(timeIntervalSince1970: 100),
                updatedAt: Date(timeIntervalSince1970: 200),
                folderID: folderID,
                folderName: "工作",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 3,
                tagIDs: tagID.uuidString,
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 1,
                assetCount: 0
            )
        )
        sourceContext.insert(
            BlockDocumentBlockEntity(
                noteID: noteID,
                position: 0,
                blockID: "block-1",
                kind: "paragraph",
                sourceType: "paragraph",
                textPayload: try JSONEncoder().encode([
                    BlockDocumentTextSpanPayload(
                        text: "块级内容",
                        bold: false,
                        italic: false,
                        underline: false,
                        strikethrough: false,
                        textColor: nil,
                        backgroundColor: nil,
                        link: nil,
                        fontFamily: nil,
                        fontSize: nil,
                        kern: nil,
                        baselineOffset: nil,
                        paragraphStyle: nil
                    )
                ]),
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: 0,
                assetID: nil,
                tablePayload: nil
            )
        )
        try sourceContext.save()

        let exportURL = try await DataExportManager.shared.exportAllNotesOnly(context: sourceContext)
        defer { try? FileManager.default.removeItem(at: exportURL) }

        let destinationContainer = try makeInMemoryContainer()
        let destinationContext = destinationContainer.mainContext
        let oldLibraryID = UUID()
        let oldNoteID = UUID()
        destinationContext.insert(
            BlockDocumentLibraryEntity(
                id: oldLibraryID,
                schemaVersion: "0.9",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 1,
                folderCount: 0,
                tagCount: 0
            )
        )
        destinationContext.insert(
            BlockDocumentNoteEntity(
                id: oldNoteID,
                libraryID: oldLibraryID,
                title: "旧库内容",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: nil,
                folderName: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 1,
                tagIDs: "",
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "old",
                blockCount: 0,
                assetCount: 0
            )
        )
        try destinationContext.save()

        try await DataExportManager.shared.importNotes(from: exportURL, context: destinationContext)

        let importedLibrary = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentLibraryEntity>()).first)
        let importedFolder = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentFolderEntity>()).first)
        let importedTag = try XCTUnwrap(try destinationContext.fetch(FetchDescriptor<BlockDocumentTagEntity>()).first)
        let importedNote = try XCTUnwrap(
            try destinationContext.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
                )
            ).first
        )
        let importedBlocks = try destinationContext.fetch(
            FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID }
            )
        )

        XCTAssertEqual(try destinationContext.fetch(FetchDescriptor<BlockDocumentLibraryEntity>()).count, 1)
        XCTAssertEqual(try destinationContext.fetch(FetchDescriptor<BlockDocumentNoteEntity>()).count, 1)
        XCTAssertEqual(importedLibrary.noteCount, 1)
        XCTAssertEqual(importedLibrary.folderCount, 1)
        XCTAssertEqual(importedLibrary.tagCount, 1)
        XCTAssertEqual(importedFolder.id, folderID)
        XCTAssertEqual(importedTag.id, tagID)
        XCTAssertEqual(importedNote.title, "迁移包导入测试")
        XCTAssertEqual(importedNote.folderID, folderID)
        XCTAssertEqual(importedNote.folderName, "工作")
        XCTAssertEqual(importedNote.version, 3)
        XCTAssertEqual(importedNote.tagIDs, tagID.uuidString)
        XCTAssertEqual(importedBlocks.count, 1)

        let store = NoteStore()
        store.setContext(destinationContext)

        XCTAssertTrue(store.isUsingBlockDocumentLibrary)
        XCTAssertEqual(store.activeNotes.map(\.id), [noteID])
    }
}
