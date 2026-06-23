import Foundation

struct DocumentMigrationPackage: Codable {
    let schemaVersion: String
    let exportedAt: Date
    let notes: [NoteItem]
    let folders: [FolderItem]
    let tags: [TagItem]

    struct NoteItem: Codable {
        let id: UUID
        let title: String
        let createdAt: Date
        let updatedAt: Date
        let folderID: UUID?
        let folderName: String
        let reminderAt: Date?
        let recurrenceRule: String
        let version: Int64
        let tagIDs: [UUID]
        let viewMode: String
        let deletedAt: Date?
        let originalFolderID: UUID?
        let originalFolderName: String?
        let blockCount: Int
        let assetCount: Int
        let documentPath: String
    }

    struct FolderItem: Codable {
        let id: UUID
        let name: String
        let sortOrder: Int
        let isSystem: Bool
        let createdAt: Date?
    }

    struct TagItem: Codable {
        let id: UUID
        let name: String
        let color: String
        let createdAt: Date
    }
}

struct MigratedDocument: Codable {
    let schemaVersion: String
    let source: String
    let blocks: [MigratedDocumentBlock]
}

struct MigratedDocumentBlock: Codable {
    let id: String
    let type: String
    var text: [MigratedInlineText]?
    var level: Int?
    var listStyle: String?
    var order: Int?
    var checked: Bool?
    var indent: Int?
    var asset: MigratedAssetReference?
    var table: MigratedTable?
}

struct MigratedInlineText: Codable {
    let text: String
    let bold: Bool
    let italic: Bool
    let underline: Bool
    let strikethrough: Bool
    let textColor: String?
    let backgroundColor: String?
    let link: String?
    let fontFamily: String?
    let fontSize: Double?
    let kern: Double?
    let baselineOffset: Double?
    let paragraphStyle: MigratedParagraphStyle?
}

struct MigratedParagraphStyle: Codable, Equatable {
    let alignment: Int?
    let lineSpacing: Double?
    let paragraphSpacing: Double?
    let paragraphSpacingBefore: Double?
    let firstLineHeadIndent: Double?
    let headIndent: Double?
    let tailIndent: Double?
}

struct MigratedAssetReference: Codable {
    let id: String
    let kind: String
    let filename: String
    let mimeType: String
    let width: Double?
    let height: Double?
    let duration: Double?
    let createdAt: Date?
    let sidecarFiles: [String]
}

struct MigratedTable: Codable {
    let rows: [[String]]
    let columnWidths: [Double]
    let rowHeights: [Double]
}

struct LoadedDocumentMigrationPackage {
    let rootDirectory: URL
    let isTemporary: Bool
    let manifest: DocumentMigrationPackage
    let notes: [LoadedDocumentMigrationNote]

    func cleanup() {
        guard isTemporary else { return }
        try? FileManager.default.removeItem(at: rootDirectory)
    }
}

struct LoadedDocumentMigrationNote {
    let metadata: DocumentMigrationPackage.NoteItem
    let document: MigratedDocument
    let noteDirectory: URL
    let assets: [LoadedMigratedAsset]
}

struct LoadedMigratedAsset {
    let reference: MigratedAssetReference
    let fileURL: URL
    let sidecarFileURLs: [URL]
}

enum DocumentMigrationImportError: LocalizedError {
    case missingManifest
    case missingDocument(path: String)
    case missingAsset(path: String)
    case invalidAssetPath(path: String)

    var errorDescription: String? {
        switch self {
        case .missingManifest:
            return "迁移包缺少 manifest.json"
        case .missingDocument(let path):
            return "迁移包缺少文档文件: \(path)"
        case .missingAsset(let path):
            return "迁移包缺少资源文件: \(path)"
        case .invalidAssetPath(let path):
            return "迁移包资源路径无效: \(path)"
        }
    }
}

protocol DocumentMigrationImportHandler: AnyObject {
    func prepareImport(manifest: DocumentMigrationPackage) throws
    func importNote(_ note: LoadedDocumentMigrationNote) throws
    func finishImport(package: LoadedDocumentMigrationPackage) throws
}

@MainActor
final class DocumentMigrationPackageLoader {
    private let fileManager = FileManager.default

    func loadArchive(from zipURL: URL) throws -> LoadedDocumentMigrationPackage {
        let extractDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookDocumentMigrationImport_\(Date().timeIntervalSince1970)_\(UUID().uuidString)")
        try ArchiveUtility.unzipFile(at: zipURL, to: extractDir)
        do {
            return try load(from: extractDir, isTemporary: true)
        } catch {
            try? fileManager.removeItem(at: extractDir)
            throw error
        }
    }

    func loadDirectory(from directoryURL: URL) throws -> LoadedDocumentMigrationPackage {
        try load(from: directoryURL, isTemporary: false)
    }

    private func load(from rootDirectory: URL, isTemporary: Bool) throws -> LoadedDocumentMigrationPackage {
        let manifestURL = rootDirectory.appendingPathComponent("manifest.json")
        guard fileManager.fileExists(atPath: manifestURL.path) else {
            throw DocumentMigrationImportError.missingManifest
        }

        let manifest: DocumentMigrationPackage = try readJSON(from: manifestURL)
        let notes = try manifest.notes.map { try loadNote($0, rootDirectory: rootDirectory) }

        return LoadedDocumentMigrationPackage(
            rootDirectory: rootDirectory,
            isTemporary: isTemporary,
            manifest: manifest,
            notes: notes
        )
    }

    private func loadNote(_ item: DocumentMigrationPackage.NoteItem, rootDirectory: URL) throws -> LoadedDocumentMigrationNote {
        let documentURL = rootDirectory.appendingPathComponent(item.documentPath)
        guard fileManager.fileExists(atPath: documentURL.path) else {
            throw DocumentMigrationImportError.missingDocument(path: item.documentPath)
        }

        let document: MigratedDocument = try readJSON(from: documentURL)
        let noteDirectory = documentURL.deletingLastPathComponent()
        let assets = try resolveAssets(for: document, noteDirectory: noteDirectory, rootDirectory: rootDirectory)

        return LoadedDocumentMigrationNote(
            metadata: item,
            document: document,
            noteDirectory: noteDirectory,
            assets: assets
        )
    }

    private func resolveAssets(for document: MigratedDocument, noteDirectory: URL, rootDirectory: URL) throws -> [LoadedMigratedAsset] {
        try document.blocks.compactMap { $0.asset }.map { reference in
            let fileURL = try resolvedAssetURL(
                for: reference.filename,
                noteDirectory: noteDirectory,
                rootDirectory: rootDirectory
            )
            guard fileManager.fileExists(atPath: fileURL.path) else {
                throw DocumentMigrationImportError.missingAsset(path: reference.filename)
            }

            let sidecarFileURLs = try reference.sidecarFiles.map { sidecarPath in
                let sidecarURL = try resolvedAssetURL(
                    for: sidecarPath,
                    noteDirectory: noteDirectory,
                    rootDirectory: rootDirectory
                )
                guard fileManager.fileExists(atPath: sidecarURL.path) else {
                    throw DocumentMigrationImportError.missingAsset(path: sidecarPath)
                }
                return sidecarURL
            }

            return LoadedMigratedAsset(
                reference: reference,
                fileURL: fileURL,
                sidecarFileURLs: sidecarFileURLs
            )
        }
    }

    private func resolvedAssetURL(for relativePath: String, noteDirectory: URL, rootDirectory: URL) throws -> URL {
        let noteScopedURL = try validatedURL(for: relativePath, baseDirectory: noteDirectory, rootDirectory: rootDirectory)
        if fileManager.fileExists(atPath: noteScopedURL.path) {
            return noteScopedURL
        }

        return try validatedURL(for: relativePath, baseDirectory: rootDirectory, rootDirectory: rootDirectory)
    }

    private func validatedURL(for relativePath: String, baseDirectory: URL, rootDirectory: URL) throws -> URL {
        let url = baseDirectory.appendingPathComponent(relativePath)
        let resolvedPath = url.standardizedFileURL.path
        let rootPath = rootDirectory.standardizedFileURL.path
        let rootPrefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard resolvedPath == rootPath || resolvedPath.hasPrefix(rootPrefix) else {
            throw DocumentMigrationImportError.invalidAssetPath(path: relativePath)
        }
        return url
    }

    private func readJSON<T: Decodable>(from url: URL) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(T.self, from: Data(contentsOf: url))
    }
}

@MainActor
final class DocumentMigrationPackageImporter {
    private let loader: DocumentMigrationPackageLoader

    init() {
        self.loader = DocumentMigrationPackageLoader()
    }

    init(loader: DocumentMigrationPackageLoader) {
        self.loader = loader
    }

    @discardableResult
    func importArchive(from zipURL: URL, using handler: DocumentMigrationImportHandler) throws -> LoadedDocumentMigrationPackage {
        let package = try loader.loadArchive(from: zipURL)
        do {
            try runImport(package, using: handler)
            return package
        } catch {
            package.cleanup()
            throw error
        }
    }

    @discardableResult
    func importDirectory(from directoryURL: URL, using handler: DocumentMigrationImportHandler) throws -> LoadedDocumentMigrationPackage {
        let package = try loader.loadDirectory(from: directoryURL)
        try runImport(package, using: handler)
        return package
    }

    private func runImport(_ package: LoadedDocumentMigrationPackage, using handler: DocumentMigrationImportHandler) throws {
        try handler.prepareImport(manifest: package.manifest)
        for note in package.notes {
            try handler.importNote(note)
        }
        try handler.finishImport(package: package)
    }
}

struct ImportedDocumentLibrary {
    let schemaVersion: String
    let sourceExportedAt: Date
    let importedAt: Date
    let folders: [ImportedDocumentFolder]
    let tags: [ImportedDocumentTag]
    let notes: [ImportedDocumentNote]
}

struct ImportedDocumentFolder {
    let id: UUID
    let name: String
    let sortOrder: Int
    let isSystem: Bool
    let createdAt: Date?

    init(
        id: UUID,
        name: String,
        sortOrder: Int,
        isSystem: Bool,
        createdAt: Date?
    ) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
        self.isSystem = isSystem
        self.createdAt = createdAt
    }

    init(item: DocumentMigrationPackage.FolderItem) {
        id = item.id
        name = item.name
        sortOrder = item.sortOrder
        isSystem = item.isSystem
        createdAt = item.createdAt
    }
}

struct ImportedDocumentTag {
    let id: UUID
    let name: String
    let color: String
    let createdAt: Date

    init(
        id: UUID,
        name: String,
        color: String,
        createdAt: Date
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.createdAt = createdAt
    }

    init(item: DocumentMigrationPackage.TagItem) {
        id = item.id
        name = item.name
        color = item.color
        createdAt = item.createdAt
    }
}

struct ImportedDocumentNote {
    let id: UUID
    let title: String
    let createdAt: Date
    let updatedAt: Date
    let folderID: UUID?
    let folderName: String
    let reminderAt: Date?
    let recurrenceRule: String
    let version: Int64
    let tagIDs: [UUID]
    let viewMode: String
    let deletedAt: Date?
    let originalFolderID: UUID?
    let originalFolderName: String?
    let document: ImportedDocument
    let assets: [ImportedDocumentAsset]

    init(
        id: UUID,
        title: String,
        createdAt: Date,
        updatedAt: Date,
        folderID: UUID?,
        folderName: String,
        reminderAt: Date?,
        recurrenceRule: String,
        version: Int64,
        tagIDs: [UUID],
        viewMode: String,
        deletedAt: Date?,
        originalFolderID: UUID?,
        originalFolderName: String?,
        document: ImportedDocument,
        assets: [ImportedDocumentAsset]
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.folderID = folderID
        self.folderName = folderName
        self.reminderAt = reminderAt
        self.recurrenceRule = recurrenceRule
        self.version = version
        self.tagIDs = tagIDs
        self.viewMode = viewMode
        self.deletedAt = deletedAt
        self.originalFolderID = originalFolderID
        self.originalFolderName = originalFolderName
        self.document = document
        self.assets = assets
    }

    init(note: LoadedDocumentMigrationNote) {
        id = note.metadata.id
        title = note.metadata.title
        createdAt = note.metadata.createdAt
        updatedAt = note.metadata.updatedAt
        folderID = note.metadata.folderID
        folderName = note.metadata.folderName
        reminderAt = note.metadata.reminderAt
        recurrenceRule = note.metadata.recurrenceRule
        version = note.metadata.version
        tagIDs = note.metadata.tagIDs
        viewMode = note.metadata.viewMode
        deletedAt = note.metadata.deletedAt
        originalFolderID = note.metadata.originalFolderID
        originalFolderName = note.metadata.originalFolderName
        document = ImportedDocument(document: note.document)
        assets = note.assets.map(ImportedDocumentAsset.init)
    }
}

struct ImportedDocument {
    let schemaVersion: String
    let source: String
    let blocks: [ImportedDocumentBlock]

    init(
        schemaVersion: String,
        source: String,
        blocks: [ImportedDocumentBlock]
    ) {
        self.schemaVersion = schemaVersion
        self.source = source
        self.blocks = blocks
    }

    init(document: MigratedDocument) {
        schemaVersion = document.schemaVersion
        source = document.source
        blocks = document.blocks.map(ImportedDocumentBlock.init)
    }
}

enum ImportedDocumentBlockKind: String, Codable {
    case paragraph
    case heading
    case listItem = "list_item"
    case todoItem = "todo_item"
    case image
    case audio
    case table
    case unsupported
}

enum ImportedDocumentListStyle: String, Codable {
    case bullet
    case dash
    case ordered
    case unknown
}

struct ImportedDocumentBlock {
    let id: String
    let kind: ImportedDocumentBlockKind
    let text: [ImportedInlineText]
    let level: Int?
    let listStyle: ImportedDocumentListStyle?
    let order: Int?
    let checked: Bool?
    let indent: Int?
    let asset: ImportedDocumentAssetReference?
    let table: ImportedDocumentTable?
    let sourceType: String

    init(
        id: String,
        kind: ImportedDocumentBlockKind,
        text: [ImportedInlineText],
        level: Int?,
        listStyle: ImportedDocumentListStyle?,
        order: Int?,
        checked: Bool?,
        indent: Int?,
        asset: ImportedDocumentAssetReference?,
        table: ImportedDocumentTable?,
        sourceType: String
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.level = level
        self.listStyle = listStyle
        self.order = order
        self.checked = checked
        self.indent = indent
        self.asset = asset
        self.table = table
        self.sourceType = sourceType
    }

    init(block: MigratedDocumentBlock) {
        id = block.id
        kind = ImportedDocumentBlockKind(rawValue: block.type) ?? .unsupported
        text = (block.text ?? []).map(ImportedInlineText.init)
        level = block.level
        listStyle = block.listStyle.map { ImportedDocumentListStyle(rawValue: $0) ?? .unknown }
        order = block.order
        checked = block.checked
        indent = block.indent
        asset = block.asset.map(ImportedDocumentAssetReference.init)
        table = block.table.map(ImportedDocumentTable.init)
        sourceType = block.type
    }
}

struct ImportedInlineText {
    let text: String
    let bold: Bool
    let italic: Bool
    let underline: Bool
    let strikethrough: Bool
    let textColor: String?
    let backgroundColor: String?
    let link: String?
    let fontFamily: String?
    let fontSize: Double?
    let kern: Double?
    let baselineOffset: Double?
    let paragraphStyle: MigratedParagraphStyle?

    init(
        text: String,
        bold: Bool,
        italic: Bool,
        underline: Bool,
        strikethrough: Bool,
        textColor: String?,
        backgroundColor: String?,
        link: String?,
        fontFamily: String?,
        fontSize: Double?,
        kern: Double?,
        baselineOffset: Double?,
        paragraphStyle: MigratedParagraphStyle?
    ) {
        self.text = text
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.strikethrough = strikethrough
        self.textColor = textColor
        self.backgroundColor = backgroundColor
        self.link = link
        self.fontFamily = fontFamily
        self.fontSize = fontSize
        self.kern = kern
        self.baselineOffset = baselineOffset
        self.paragraphStyle = paragraphStyle
    }

    init(span: MigratedInlineText) {
        text = span.text
        bold = span.bold
        italic = span.italic
        underline = span.underline
        strikethrough = span.strikethrough
        textColor = span.textColor
        backgroundColor = span.backgroundColor
        link = span.link
        fontFamily = span.fontFamily
        fontSize = span.fontSize
        kern = span.kern
        baselineOffset = span.baselineOffset
        paragraphStyle = span.paragraphStyle
    }
}

enum ImportedDocumentAssetKind: String, Codable {
    case image
    case audio
    case unsupported
}

struct ImportedDocumentAssetReference {
    let id: String
    let kind: ImportedDocumentAssetKind
    let filename: String
    let mimeType: String
    let width: Double?
    let height: Double?
    let duration: Double?
    let createdAt: Date?
    let sidecarFiles: [String]
    let sourceKind: String

    init(
        id: String,
        kind: ImportedDocumentAssetKind,
        filename: String,
        mimeType: String,
        width: Double?,
        height: Double?,
        duration: Double?,
        createdAt: Date?,
        sidecarFiles: [String],
        sourceKind: String
    ) {
        self.id = id
        self.kind = kind
        self.filename = filename
        self.mimeType = mimeType
        self.width = width
        self.height = height
        self.duration = duration
        self.createdAt = createdAt
        self.sidecarFiles = sidecarFiles
        self.sourceKind = sourceKind
    }

    init(reference: MigratedAssetReference) {
        id = reference.id
        kind = ImportedDocumentAssetKind(rawValue: reference.kind) ?? .unsupported
        filename = reference.filename
        mimeType = reference.mimeType
        width = reference.width
        height = reference.height
        duration = reference.duration
        createdAt = reference.createdAt
        sidecarFiles = reference.sidecarFiles
        sourceKind = reference.kind
    }
}

struct ImportedDocumentAsset {
    let reference: ImportedDocumentAssetReference
    let sourceURL: URL
    let sidecarURLs: [URL]

    init(
        reference: ImportedDocumentAssetReference,
        sourceURL: URL,
        sidecarURLs: [URL]
    ) {
        self.reference = reference
        self.sourceURL = sourceURL
        self.sidecarURLs = sidecarURLs
    }

    init(asset: LoadedMigratedAsset) {
        reference = ImportedDocumentAssetReference(reference: asset.reference)
        sourceURL = asset.fileURL
        sidecarURLs = asset.sidecarFileURLs
    }
}

struct ImportedDocumentTable {
    let rows: [[String]]
    let columnWidths: [Double]
    let rowHeights: [Double]

    init(
        rows: [[String]],
        columnWidths: [Double],
        rowHeights: [Double]
    ) {
        self.rows = rows
        self.columnWidths = columnWidths
        self.rowHeights = rowHeights
    }

    init(table: MigratedTable) {
        rows = table.rows
        columnWidths = table.columnWidths
        rowHeights = table.rowHeights
    }
}
