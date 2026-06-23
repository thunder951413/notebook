import Foundation
import SwiftData

@MainActor
final class InMemoryDocumentMigrationImportHandler: DocumentMigrationImportHandler {
    private var manifest: DocumentMigrationPackage?
    private var notes: [ImportedDocumentNote] = []
    private(set) var library: ImportedDocumentLibrary?

    func prepareImport(manifest: DocumentMigrationPackage) throws {
        self.manifest = manifest
        notes = []
        library = nil
    }

    func importNote(_ note: LoadedDocumentMigrationNote) throws {
        notes.append(ImportedDocumentNote(note: note))
    }

    func finishImport(package: LoadedDocumentMigrationPackage) throws {
        let manifest = self.manifest ?? package.manifest
        library = ImportedDocumentLibrary(
            schemaVersion: manifest.schemaVersion,
            sourceExportedAt: manifest.exportedAt,
            importedAt: Date(),
            folders: manifest.folders.map(ImportedDocumentFolder.init),
            tags: manifest.tags.map(ImportedDocumentTag.init),
            notes: notes
        )
    }
}

enum DocumentMigrationPersistenceError: LocalizedError {
    case storageNotConfigured
    case importStateUnavailable

    var errorDescription: String? {
        switch self {
        case .storageNotConfigured:
            return "未配置数据存储目录"
        case .importStateUnavailable:
            return "迁移导入状态不可用"
        }
    }
}

@MainActor
final class SwiftDataDocumentMigrationImportHandler: DocumentMigrationImportHandler {
    private let modelContext: ModelContext
    private let fileManager = FileManager.default
    private let jsonEncoder = JSONEncoder()
    private var libraryEntity: BlockDocumentLibraryEntity?
    private var attachmentsRootDirectory: URL?

    init(modelContext: ModelContext) {
        self.modelContext = modelContext
    }

    convenience init(container: ModelContainer) {
        self.init(modelContext: ModelContext(container))
    }

    func prepareImport(manifest: DocumentMigrationPackage) throws {
        try deleteAll(BlockDocumentBlockEntity.self)
        try deleteAll(BlockDocumentAssetEntity.self)
        try deleteAll(BlockDocumentNoteEntity.self)
        try deleteAll(BlockDocumentTagEntity.self)
        try deleteAll(BlockDocumentFolderEntity.self)
        try deleteAll(BlockDocumentLibraryEntity.self)

        let attachmentsRoot = try persistentAttachmentsRootDirectory()
        let importedAssetsRoot = attachmentsRoot.appendingPathComponent("MigratedDocuments", isDirectory: true)
        if fileManager.fileExists(atPath: importedAssetsRoot.path) {
            try fileManager.removeItem(at: importedAssetsRoot)
        }
        try fileManager.createDirectory(at: importedAssetsRoot, withIntermediateDirectories: true)

        let libraryEntity = BlockDocumentLibraryEntity(
            schemaVersion: manifest.schemaVersion,
            sourceExportedAt: manifest.exportedAt,
            importedAt: Date(),
            noteCount: manifest.notes.count,
            folderCount: manifest.folders.count,
            tagCount: manifest.tags.count
        )
        modelContext.insert(libraryEntity)

        for folder in manifest.folders {
            modelContext.insert(
                BlockDocumentFolderEntity(
                    id: folder.id,
                    libraryID: libraryEntity.id,
                    name: folder.name,
                    sortOrder: folder.sortOrder,
                    isSystem: folder.isSystem,
                    createdAt: folder.createdAt
                )
            )
        }

        for tag in manifest.tags {
            modelContext.insert(
                BlockDocumentTagEntity(
                    id: tag.id,
                    libraryID: libraryEntity.id,
                    name: tag.name,
                    color: tag.color,
                    createdAt: tag.createdAt
                )
            )
        }

        try modelContext.save()
        self.libraryEntity = libraryEntity
        attachmentsRootDirectory = attachmentsRoot
    }

    func importNote(_ note: LoadedDocumentMigrationNote) throws {
        guard let libraryEntity else {
            throw DocumentMigrationPersistenceError.importStateUnavailable
        }

        let persistedAssets = try note.assets.map { try persistAsset($0, noteID: note.metadata.id) }

        let noteEntity = BlockDocumentNoteEntity(
            id: note.metadata.id,
            libraryID: libraryEntity.id,
            title: note.metadata.title,
            createdAt: note.metadata.createdAt,
            updatedAt: note.metadata.updatedAt,
            folderID: note.metadata.folderID,
            folderName: note.metadata.folderName,
            reminderAt: note.metadata.reminderAt,
            recurrenceRule: note.metadata.recurrenceRule,
            version: note.metadata.version,
            tagIDs: UUIDListCoding.encode(note.metadata.tagIDs),
            viewMode: note.metadata.viewMode,
            deletedAt: note.metadata.deletedAt,
            originalFolderID: note.metadata.originalFolderID,
            originalFolderName: note.metadata.originalFolderName,
            documentSchemaVersion: note.document.schemaVersion,
            documentSource: note.document.source,
            blockCount: note.document.blocks.count,
            assetCount: persistedAssets.count
        )
        modelContext.insert(noteEntity)

        for asset in persistedAssets {
            modelContext.insert(
                BlockDocumentAssetEntity(
                    noteID: note.metadata.id,
                    assetID: asset.reference.id,
                    kind: asset.reference.kind,
                    sourceKind: asset.reference.kind,
                    filename: asset.reference.filename,
                    mimeType: asset.reference.mimeType,
                    width: asset.reference.width,
                    height: asset.reference.height,
                    duration: asset.reference.duration,
                    createdAt: asset.reference.createdAt,
                    relativeFilePath: asset.relativeFilePath,
                    sidecarPathsPayload: try encodeJSON(asset.sidecarRelativePaths)
                )
            )
        }

        for (position, block) in note.document.blocks.enumerated() {
            modelContext.insert(
                BlockDocumentBlockEntity(
                    noteID: note.metadata.id,
                    position: position,
                    blockID: block.id,
                    kind: block.type,
                    sourceType: block.type,
                    textPayload: try encodeTextPayload(block.text ?? []),
                    level: block.level,
                    listStyle: block.listStyle,
                    order: block.order,
                    checked: block.checked,
                    indent: block.indent,
                    assetID: block.asset?.id,
                    tablePayload: try encodeTablePayload(block.table)
                )
            )
        }

        try modelContext.save()
    }

    func finishImport(package: LoadedDocumentMigrationPackage) throws {
        guard let libraryEntity else {
            throw DocumentMigrationPersistenceError.importStateUnavailable
        }
        libraryEntity.noteCount = package.notes.count
        libraryEntity.folderCount = package.manifest.folders.count
        libraryEntity.tagCount = package.manifest.tags.count
        libraryEntity.importedAt = Date()
        try modelContext.save()
    }

    private func persistentAttachmentsRootDirectory() throws -> URL {
        let storage = StorageLocationManager.shared
        guard let base = storage.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }

        return try storage.withSecurityScopedAccess(base) {
            try storage.ensureDirectoryStructureExists()
            let attachmentsRoot = try storage.attachmentsDirectoryURL()
            try fileManager.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
            return attachmentsRoot
        }
    }

    private func persistAsset(_ asset: LoadedMigratedAsset, noteID: UUID) throws -> PersistedMigratedAsset {
        guard let attachmentsRootDirectory else {
            throw DocumentMigrationPersistenceError.importStateUnavailable
        }

        let baseRelativeDirectory = "MigratedDocuments/\(noteID.uuidString)/\(asset.reference.id)"
        let relativeFilePath = "\(baseRelativeDirectory)/\(asset.fileURL.lastPathComponent)"
        let destinationFileURL = attachmentsRootDirectory.appendingPathComponent(relativeFilePath)
        try copyItemReplacingIfNeeded(from: asset.fileURL, to: destinationFileURL)

        let sidecarRelativePaths = try asset.sidecarFileURLs.map { sidecarURL in
            let relativePath = "\(baseRelativeDirectory)/\(sidecarURL.lastPathComponent)"
            let destinationURL = attachmentsRootDirectory.appendingPathComponent(relativePath)
            try copyItemReplacingIfNeeded(from: sidecarURL, to: destinationURL)
            return relativePath
        }

        return PersistedMigratedAsset(
            reference: asset.reference,
            relativeFilePath: relativeFilePath,
            sidecarRelativePaths: sidecarRelativePaths
        )
    }

    private func copyItemReplacingIfNeeded(from sourceURL: URL, to destinationURL: URL) throws {
        let parentDirectory = destinationURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: parentDirectory, withIntermediateDirectories: true)
        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }
        try fileManager.copyItem(at: sourceURL, to: destinationURL)
    }

    private func encodeTextPayload(_ spans: [MigratedInlineText]) throws -> Data? {
        guard !spans.isEmpty else {
            return nil
        }

        let payload = spans.map {
            BlockDocumentTextSpanPayload(
                text: $0.text,
                bold: $0.bold,
                italic: $0.italic,
                underline: $0.underline,
                strikethrough: $0.strikethrough,
                textColor: $0.textColor,
                backgroundColor: $0.backgroundColor,
                link: $0.link,
                fontFamily: $0.fontFamily,
                fontSize: $0.fontSize,
                kern: $0.kern,
                baselineOffset: $0.baselineOffset,
                paragraphStyle: $0.paragraphStyle.map {
                    BlockDocumentParagraphStylePayload(
                        alignment: $0.alignment,
                        lineSpacing: $0.lineSpacing,
                        paragraphSpacing: $0.paragraphSpacing,
                        paragraphSpacingBefore: $0.paragraphSpacingBefore,
                        firstLineHeadIndent: $0.firstLineHeadIndent,
                        headIndent: $0.headIndent,
                        tailIndent: $0.tailIndent
                    )
                }
            )
        }
        return try encodeJSON(payload)
    }

    private func encodeTablePayload(_ table: MigratedTable?) throws -> Data? {
        guard let table else {
            return nil
        }

        return try encodeJSON(
            BlockDocumentTablePayload(
                rows: table.rows,
                columnWidths: table.columnWidths,
                rowHeights: table.rowHeights
            )
        )
    }

    private func encodeJSON<T: Encodable>(_ value: T) throws -> Data {
        try jsonEncoder.encode(value)
    }

    private func deleteAll<T: PersistentModel>(_ type: T.Type) throws {
        let models = try modelContext.fetch(FetchDescriptor<T>())
        for model in models {
            modelContext.delete(model)
        }
    }
}

private struct PersistedMigratedAsset {
    let reference: MigratedAssetReference
    let relativeFilePath: String
    let sidecarRelativePaths: [String]
}
