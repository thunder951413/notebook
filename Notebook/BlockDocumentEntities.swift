import Foundation
import SwiftData

struct BlockDocumentParagraphStylePayload: Codable, Equatable {
    let alignment: Int?
    let lineSpacing: Double?
    let paragraphSpacing: Double?
    let paragraphSpacingBefore: Double?
    let firstLineHeadIndent: Double?
    let headIndent: Double?
    let tailIndent: Double?
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
    let kern: Double?
    let baselineOffset: Double?
    let paragraphStyle: BlockDocumentParagraphStylePayload?
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
    var updatedAt: Date = Date()
    var folderType: String = FolderType.noteFolder.rawValue

    init(
        id: UUID,
        libraryID: UUID,
        name: String,
        sortOrder: Int,
        isSystem: Bool,
        createdAt: Date?,
        folderType: String = FolderType.noteFolder.rawValue,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.libraryID = libraryID
        self.name = name
        self.sortOrder = sortOrder
        self.isSystem = isSystem
        self.createdAt = createdAt
        self.folderType = folderType
        self.updatedAt = updatedAt ?? createdAt ?? Date()
    }
}

@Model
final class BlockDocumentTagEntity {
    @Attribute(.unique) var id: UUID
    var libraryID: UUID
    var name: String
    var color: String
    var createdAt: Date
    var updatedAt: Date = Date()

    init(
        id: UUID,
        libraryID: UUID,
        name: String,
        color: String,
        createdAt: Date,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.libraryID = libraryID
        self.name = name
        self.color = color
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }
}

@Model
final class BlockDocumentNoteEntity {
    @Attribute(.unique) var id: UUID = UUID()
    var libraryID: UUID = UUID()
    var title: String = ""
    var createdAt: Date = Date()
    var updatedAt: Date = Date()
    var folderID: UUID?
    var folderName: String = ""
    var reminderAt: Date?
    var recurrenceRule: String = ""
    var version: Int64 = 0
    var tagIDs: String = ""
    var viewMode: String = "text"
    var deletedAt: Date?
    var originalFolderID: UUID?
    var originalFolderName: String?
    var documentSchemaVersion: String = ""
    var documentSource: String = ""
    var blockCount: Int = 0
    var assetCount: Int = 0
    /// 持久化预览文本（写入时一次性计算，列表加载时直接读取，避免给每条笔记做 blocks fetch）
    var previewText: String = ""
    /// 标记该笔记的旧版复选框图片块是否已迁移为 todo_item 类型。
    /// 一旦为 true，后续加载时不再执行像素检测启发式。
    var hasLegacyCheckboxMigrated: Bool = false
    var lastSavedContentHash: String = ""
    var hasConflict: Bool = false
    @Attribute(.externalStorage) var conflictRemoteSnapshotData: Data?
    var conflictBackendID: String = ""
    var itemType: String = "note"
    var todoDueAt: Date?
    var todoCompletedAt: Date?
    var todoIsImportant: Bool = false
    var todoOrder: Int = 0
    var linkedNoteIDs: String = ""

    // MARK: — Relationships（与 UUID 字段并存）
    // 设计说明：保留 noteID: UUID 字段以维持现有基于 predicate 的查询兼容性
    // （SwiftData @Relationship 在 #Predicate 里语法不同，且 macOS 14 早期有 bug）。
    // 此处的 @Relationship 仅承担"删除时自动级联"职责，写入路径仍用 noteID 显式赋值，
    // 实现渐进式过渡：cascade 删除立即可用，predicate 查询零改动。
    @Relationship(deleteRule: .cascade, inverse: \BlockDocumentBlockEntity.note)
    var blocks: [BlockDocumentBlockEntity] = []

    @Relationship(deleteRule: .cascade, inverse: \BlockDocumentAssetEntity.note)
    var assets: [BlockDocumentAssetEntity] = []

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
        assetCount: Int,
        lastSavedContentHash: String = "",
        itemType: String = "note",
        todoDueAt: Date? = nil,
        todoCompletedAt: Date? = nil,
        todoIsImportant: Bool = false,
        todoOrder: Int = 0,
        linkedNoteIDs: String = ""
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
        self.lastSavedContentHash = lastSavedContentHash
        self.itemType = itemType
        self.todoDueAt = todoDueAt
        self.todoCompletedAt = todoCompletedAt
        self.todoIsImportant = todoIsImportant
        self.todoOrder = todoOrder
        self.linkedNoteIDs = linkedNoteIDs
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
    /// 反向关系：指向所属笔记。由 SwiftData 自动维护，删除笔记时级联删除本 block。
    /// noteID 字段仍保留用于 predicate 查询；两者由写入路径同步赋值。
    var note: BlockDocumentNoteEntity?

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
    /// 反向关系：指向所属笔记。由 SwiftData 自动维护，删除笔记时级联删除本 asset。
    /// noteID 字段仍保留用于 predicate 查询；两者由写入路径同步赋值。
    var note: BlockDocumentNoteEntity?

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

@Model
final class BlockDocumentNoteVersionEntity {
    @Attribute(.unique) var id: UUID
    var noteID: UUID
    var version: Int64
    var recordedAt: Date
    var updatedAt: Date
    var title: String
    var authorDeviceID: String
    var contentHash: String
    var snapshotData: Data

    init(
        id: UUID = UUID(),
        noteID: UUID,
        version: Int64,
        recordedAt: Date,
        updatedAt: Date,
        title: String,
        authorDeviceID: String,
        contentHash: String,
        snapshotData: Data
    ) {
        self.id = id
        self.noteID = noteID
        self.version = version
        self.recordedAt = recordedAt
        self.updatedAt = updatedAt
        self.title = title
        self.authorDeviceID = authorDeviceID
        self.contentHash = contentHash
        self.snapshotData = snapshotData
    }
}

@Model
final class BlockDocumentNoteSyncStateEntity {
    @Attribute(.unique) var noteID: UUID
    var lastRecordedVersion: Int64
    var lastSyncedVersion: Int64
    var lastCommonVersion: Int64
    var lastRemoteVersion: Int64
    var lastSyncAt: Date?
    var lastRemoteDeviceID: String?
    var remoteFingerprint: String
    var pendingHistoryCount: Int

    init(
        noteID: UUID,
        lastRecordedVersion: Int64 = 0,
        lastSyncedVersion: Int64 = 0,
        lastCommonVersion: Int64 = 0,
        lastRemoteVersion: Int64 = 0,
        lastSyncAt: Date? = nil,
        lastRemoteDeviceID: String? = nil,
        remoteFingerprint: String = "",
        pendingHistoryCount: Int = 0
    ) {
        self.noteID = noteID
        self.lastRecordedVersion = lastRecordedVersion
        self.lastSyncedVersion = lastSyncedVersion
        self.lastCommonVersion = lastCommonVersion
        self.lastRemoteVersion = lastRemoteVersion
        self.lastSyncAt = lastSyncAt
        self.lastRemoteDeviceID = lastRemoteDeviceID
        self.remoteFingerprint = remoteFingerprint
        self.pendingHistoryCount = pendingHistoryCount
    }
}

/// V6：每个同步后端维护独立游标，避免 SSH/iCloud/本地目录互相误判为已同步。
@Model
final class BlockDocumentBackendSyncStateEntity {
    @Attribute(.unique) var backendNoteKey: String
    var noteID: UUID
    var backendID: String
    var lastRecordedVersion: Int64
    var lastSyncedVersion: Int64
    var lastCommonVersion: Int64
    var lastRemoteVersion: Int64
    var lastSyncAt: Date?
    var lastRemoteDeviceID: String?
    var remoteFingerprint: String
    var pendingHistoryCount: Int

    init(
        noteID: UUID,
        backendID: String,
        lastRecordedVersion: Int64 = 0,
        lastSyncedVersion: Int64 = 0,
        lastCommonVersion: Int64 = 0,
        lastRemoteVersion: Int64 = 0,
        lastSyncAt: Date? = nil,
        lastRemoteDeviceID: String? = nil,
        remoteFingerprint: String = "",
        pendingHistoryCount: Int = 0
    ) {
        self.backendNoteKey = "\(backendID)|\(noteID.uuidString)"
        self.noteID = noteID
        self.backendID = backendID
        self.lastRecordedVersion = lastRecordedVersion
        self.lastSyncedVersion = lastSyncedVersion
        self.lastCommonVersion = lastCommonVersion
        self.lastRemoteVersion = lastRemoteVersion
        self.lastSyncAt = lastSyncAt
        self.lastRemoteDeviceID = lastRemoteDeviceID
        self.remoteFingerprint = remoteFingerprint
        self.pendingHistoryCount = pendingHistoryCount
    }
}

@Model
final class BlockDocumentDeletedNoteTombstoneEntity {
    @Attribute(.unique) var noteID: UUID
    var deletedAt: Date
    var deletedByDeviceID: String
    var createdAt: Date

    init(
        noteID: UUID,
        deletedAt: Date,
        deletedByDeviceID: String,
        createdAt: Date = Date()
    ) {
        self.noteID = noteID
        self.deletedAt = deletedAt
        self.deletedByDeviceID = deletedByDeviceID
        self.createdAt = createdAt
    }
}

@Model
final class BlockDocumentLibraryTombstoneEntity {
    @Attribute(.unique) var tombstoneKey: String
    var itemID: UUID
    var itemKind: String
    var deletedAt: Date
    var deletedByDeviceID: String

    init(itemID: UUID, itemKind: String, deletedAt: Date = Date(), deletedByDeviceID: String) {
        self.tombstoneKey = "\(itemKind)|\(itemID.uuidString)"
        self.itemID = itemID
        self.itemKind = itemKind
        self.deletedAt = deletedAt
        self.deletedByDeviceID = deletedByDeviceID
    }
}

/// 笔记-标签关联表（V4 引入）。
///
/// 设计目标：为"按标签筛选笔记"提供 SQLite 索引查询，避免扫描全表 + 字符串 LIKE。
/// 与 `BlockDocumentNoteEntity.tagIDs: String` 并存：
/// - `tagIDs` 字符串仍是权威序列化格式（同步/导出/历史快照依赖它）
/// - 本表是派生查找索引，由 `addTagToNote` / `removeTagFromNote` / 保存路径同步维护
/// - 一次性迁移在 V3→V4 stage 中执行
@Model
final class BlockDocumentNoteTagEntity {
    @Attribute(.unique) var id: UUID
    var noteID: UUID
    var tagID: UUID
    var libraryID: UUID
    var sortOrder: Int

    init(
        id: UUID = UUID(),
        noteID: UUID,
        tagID: UUID,
        libraryID: UUID,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.noteID = noteID
        self.tagID = tagID
        self.libraryID = libraryID
        self.sortOrder = sortOrder
    }
}

@Model
final class TodoStepEntity {
    @Attribute(.unique) var id: UUID
    var noteID: UUID
    var libraryID: UUID
    var text: String
    var checked: Bool
    var order: Int
    var createdAt: Date

    init(
        id: UUID = UUID(),
        noteID: UUID,
        libraryID: UUID,
        text: String,
        checked: Bool = false,
        order: Int = 0,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.noteID = noteID
        self.libraryID = libraryID
        self.text = text
        self.checked = checked
        self.order = order
        self.createdAt = createdAt
    }
}
