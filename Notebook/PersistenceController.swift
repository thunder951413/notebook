import Foundation
import SwiftData
import Combine

@MainActor
final class PersistenceController: ObservableObject {
    static let shared = PersistenceController()

    @Published private(set) var modelContainer: ModelContainer?

    static let appSchema = Schema([
        BlockDocumentLibraryEntity.self,
        BlockDocumentFolderEntity.self,
        BlockDocumentTagEntity.self,
        BlockDocumentNoteEntity.self,
        BlockDocumentBlockEntity.self,
        BlockDocumentAssetEntity.self
    ])

    private init() {}

    func configureIfPossible() throws {
        let location = StorageLocationManager.shared
        guard location.isConfigured else {
            modelContainer = nil
            return
        }

        try location.ensureDirectoryStructureExists()

        guard let base = location.baseDirectoryURL else { return }

        let storeURL = try location.databaseDirectoryURL().appendingPathComponent("notebook.store")

        let schema = Self.appSchema

        let config = ModelConfiguration(schema: schema, url: storeURL)
        let container = try ModelContainer(for: schema, configurations: [config])

        // 确保 security-scoped 权限在后续读写时可用
        // SwiftData 自己会访问 url，所以我们只确保 bookmark 是有效的。
        _ = base.startAccessingSecurityScopedResource()
        base.stopAccessingSecurityScopedResource()

        self.modelContainer = container
    }
}

struct BlockDocumentTextSpanPayload: Codable {
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
}

struct BlockDocumentTablePayload: Codable {
    let rows: [[String]]
    let columnWidths: [Double]
    let rowHeights: [Double]
}

@Model
final class BlockDocumentLibraryEntity {
    @Attribute(.unique) var id: UUID
    var schemaVersion: String
    var sourceExportedAt: Date
    var importedAt: Date
    var noteCount: Int
    var folderCount: Int
    var tagCount: Int

    init(
        id: UUID = UUID(),
        schemaVersion: String,
        sourceExportedAt: Date,
        importedAt: Date = Date(),
        noteCount: Int = 0,
        folderCount: Int = 0,
        tagCount: Int = 0
    ) {
        self.id = id
        self.schemaVersion = schemaVersion
        self.sourceExportedAt = sourceExportedAt
        self.importedAt = importedAt
        self.noteCount = noteCount
        self.folderCount = folderCount
        self.tagCount = tagCount
    }
}

@Model
final class BlockDocumentFolderEntity {
    @Attribute(.unique) var id: UUID
    var libraryID: UUID
    var name: String
    var sortOrder: Int
    var isSystem: Bool
    var createdAt: Date?

    init(
        id: UUID,
        libraryID: UUID,
        name: String,
        sortOrder: Int,
        isSystem: Bool,
        createdAt: Date?
    ) {
        self.id = id
        self.libraryID = libraryID
        self.name = name
        self.sortOrder = sortOrder
        self.isSystem = isSystem
        self.createdAt = createdAt
    }
}

@Model
final class BlockDocumentTagEntity {
    @Attribute(.unique) var id: UUID
    var libraryID: UUID
    var name: String
    var color: String
    var createdAt: Date

    init(
        id: UUID,
        libraryID: UUID,
        name: String,
        color: String,
        createdAt: Date
    ) {
        self.id = id
        self.libraryID = libraryID
        self.name = name
        self.color = color
        self.createdAt = createdAt
    }
}

@Model
final class BlockDocumentNoteEntity {
    @Attribute(.unique) var id: UUID
    var libraryID: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var folderID: UUID?
    var folderName: String
    var reminderAt: Date?
    var recurrenceRule: String
    var version: Int64
    var tagIDs: String
    var viewMode: String
    var deletedAt: Date?
    var originalFolderID: UUID?
    var originalFolderName: String?
    var documentSchemaVersion: String
    var documentSource: String
    var blockCount: Int
    var assetCount: Int

    init(
        id: UUID,
        libraryID: UUID,
        title: String,
        createdAt: Date,
        updatedAt: Date,
        folderID: UUID?,
        folderName: String,
        reminderAt: Date?,
        recurrenceRule: String,
        version: Int64,
        tagIDs: String,
        viewMode: String,
        deletedAt: Date?,
        originalFolderID: UUID?,
        originalFolderName: String?,
        documentSchemaVersion: String,
        documentSource: String,
        blockCount: Int,
        assetCount: Int
    ) {
        self.id = id
        self.libraryID = libraryID
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
        self.documentSchemaVersion = documentSchemaVersion
        self.documentSource = documentSource
        self.blockCount = blockCount
        self.assetCount = assetCount
    }
}

@Model
final class BlockDocumentBlockEntity {
    @Attribute(.unique) var internalID: UUID
    var noteID: UUID
    var position: Int
    var blockID: String
    var kind: String
    var sourceType: String
    var textPayload: Data?
    var level: Int?
    var listStyle: String?
    var order: Int?
    var checked: Bool?
    var indent: Int?
    var assetID: String?
    var tablePayload: Data?

    init(
        internalID: UUID = UUID(),
        noteID: UUID,
        position: Int,
        blockID: String,
        kind: String,
        sourceType: String,
        textPayload: Data?,
        level: Int?,
        listStyle: String?,
        order: Int?,
        checked: Bool?,
        indent: Int?,
        assetID: String?,
        tablePayload: Data?
    ) {
        self.internalID = internalID
        self.noteID = noteID
        self.position = position
        self.blockID = blockID
        self.kind = kind
        self.sourceType = sourceType
        self.textPayload = textPayload
        self.level = level
        self.listStyle = listStyle
        self.order = order
        self.checked = checked
        self.indent = indent
        self.assetID = assetID
        self.tablePayload = tablePayload
    }
}

@Model
final class BlockDocumentAssetEntity {
    @Attribute(.unique) var internalID: UUID
    var noteID: UUID
    var assetID: String
    var kind: String
    var sourceKind: String
    var filename: String
    var mimeType: String
    var width: Double?
    var height: Double?
    var duration: Double?
    var createdAt: Date?
    var relativeFilePath: String
    var sidecarPathsPayload: Data?

    init(
        internalID: UUID = UUID(),
        noteID: UUID,
        assetID: String,
        kind: String,
        sourceKind: String,
        filename: String,
        mimeType: String,
        width: Double?,
        height: Double?,
        duration: Double?,
        createdAt: Date?,
        relativeFilePath: String,
        sidecarPathsPayload: Data?
    ) {
        self.internalID = internalID
        self.noteID = noteID
        self.assetID = assetID
        self.kind = kind
        self.sourceKind = sourceKind
        self.filename = filename
        self.mimeType = mimeType
        self.width = width
        self.height = height
        self.duration = duration
        self.createdAt = createdAt
        self.relativeFilePath = relativeFilePath
        self.sidecarPathsPayload = sidecarPathsPayload
    }
}
