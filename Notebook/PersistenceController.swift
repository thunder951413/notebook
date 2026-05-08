import Foundation
import SwiftData
import Combine
import CryptoKit

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
        BlockDocumentAssetEntity.self,
        BlockDocumentNoteVersionEntity.self,
        BlockDocumentNoteSyncStateEntity.self,
        BlockDocumentDeletedNoteTombstoneEntity.self
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
    var lastSavedContentHash: String = ""
    var hasConflict: Bool = false
    @Attribute(.externalStorage) var conflictRemoteSnapshotData: Data?

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
        lastSavedContentHash: String = ""
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

struct VersionedNoteAssetSnapshot: Codable {
    let reference: MigratedAssetReference
    let relativeFilePath: String
    let sidecarRelativePaths: [String]
}

struct VersionedNoteSnapshot: Codable {
    let metadata: DocumentMigrationPackage.NoteItem
    let document: MigratedDocument
    let assets: [VersionedNoteAssetSnapshot]
}

struct VersionedNoteHistoryEnvelope: Codable {
    let id: UUID
    let noteID: UUID
    let version: Int64
    let recordedAt: Date
    let updatedAt: Date
    let title: String
    let authorDeviceID: String
    let contentHash: String
    let snapshot: VersionedNoteSnapshot
}

struct VersionedNoteSyncStatePayload: Codable {
    let lastRecordedVersion: Int64
    let lastSyncedVersion: Int64
    let lastCommonVersion: Int64
    let lastRemoteVersion: Int64
    let lastSyncAt: Date?
    let lastRemoteDeviceID: String?
    let remoteFingerprint: String
    let pendingHistoryCount: Int
}

struct VersionedNoteSyncEnvelope: Codable {
    let noteID: UUID
    let deviceID: String
    let exportedAt: Date
    let currentVersion: Int64
    let currentSnapshot: VersionedNoteSnapshot
    let history: [VersionedNoteHistoryEnvelope]
    let syncState: VersionedNoteSyncStatePayload
}

struct NoteVersionComparison {
    let noteID: UUID
    let fromVersion: Int64
    let toVersion: Int64
    let titleChanged: Bool
    let metadataChanged: Bool
    let blockCountDelta: Int
    let assetCountDelta: Int
    let changedBlockIDs: [String]
    let addedAssetIDs: [String]
    let removedAssetIDs: [String]
}

struct NoteSyncMergeResult {
    let noteID: UUID
    let appliedRemoteSnapshot: Bool
    let detectedConflict: Bool
    let importedHistoryVersions: [Int64]
    let localVersion: Int64
    let remoteVersion: Int64
}

enum BlockDocumentNoteVersionStore {
    private static let deviceIdentityKey = "BlockDocumentNoteVersionStore.deviceID"
    private static let jsonEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return encoder
    }()
    private static let jsonDecoder = JSONDecoder()

    static func currentDeviceID(defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: deviceIdentityKey), !existing.isEmpty {
            return existing
        }

        let generated = UUID().uuidString
        defaults.set(generated, forKey: deviceIdentityKey)
        return generated
    }

    @discardableResult
    static func ensureHistoryRecorded(noteID: UUID, context: ModelContext) throws -> BlockDocumentNoteVersionEntity? {
        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        guard let note = try context.fetch(noteDescriptor).first else {
            return nil
        }

        let blocks = try context.fetch(
            FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID },
                sortBy: [SortDescriptor(\.position)]
            )
        )
        let assets = try context.fetch(
            FetchDescriptor<BlockDocumentAssetEntity>(
                predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == noteID }
            )
        )
        return try recordVersionIfNeeded(note: note, blocks: blocks, assets: assets, context: context)
    }

    @discardableResult
    static func recordVersionIfNeeded(
        note: BlockDocumentNoteEntity,
        blocks: [BlockDocumentBlockEntity],
        assets: [BlockDocumentAssetEntity],
        context: ModelContext,
        authorDeviceID: String? = nil
    ) throws -> BlockDocumentNoteVersionEntity? {
        let noteID = note.id
        let noteVersion = note.version
        let versionDescriptor = FetchDescriptor<BlockDocumentNoteVersionEntity>(
            predicate: #Predicate<BlockDocumentNoteVersionEntity> {
                $0.noteID == noteID && $0.version == noteVersion
            }
        )
        if let existing = try context.fetch(versionDescriptor).first {
            let syncState = try ensureSyncState(noteID: note.id, context: context)
            syncState.lastRecordedVersion = max(syncState.lastRecordedVersion, existing.version)
            syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
            return existing
        }

        let snapshot = try makeSnapshot(note: note, blocks: blocks, assets: assets)
        let contentHash = try snapshotFingerprint(snapshot)
        let snapshotData = try jsonEncoder.encode(snapshot)
        let entry = BlockDocumentNoteVersionEntity(
            noteID: note.id,
            version: note.version,
            recordedAt: note.updatedAt,
            updatedAt: note.updatedAt,
            title: note.title,
            authorDeviceID: authorDeviceID ?? currentDeviceID(),
            contentHash: contentHash,
            snapshotData: snapshotData
        )
        context.insert(entry)

        let syncState = try ensureSyncState(noteID: note.id, context: context)
        syncState.lastRecordedVersion = max(syncState.lastRecordedVersion, note.version)
        syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
        return entry
    }

    static func history(for noteID: UUID, context: ModelContext) throws -> [BlockDocumentNoteVersionEntity] {
        try context.fetch(
            FetchDescriptor<BlockDocumentNoteVersionEntity>(
                predicate: #Predicate<BlockDocumentNoteVersionEntity> { $0.noteID == noteID },
                sortBy: [SortDescriptor(\.version)]
            )
        )
    }

    static func snapshot(noteID: UUID, version: Int64, context: ModelContext) throws -> VersionedNoteSnapshot? {
        let versionDescriptor = FetchDescriptor<BlockDocumentNoteVersionEntity>(
            predicate: #Predicate<BlockDocumentNoteVersionEntity> {
                $0.noteID == noteID && $0.version == version
            }
        )
        guard let entry = try context.fetch(versionDescriptor).first else {
            return nil
        }
        return try jsonDecoder.decode(VersionedNoteSnapshot.self, from: entry.snapshotData)
    }

    static func compare(
        noteID: UUID,
        from fromVersion: Int64,
        to toVersion: Int64,
        context: ModelContext
    ) throws -> NoteVersionComparison? {
        guard let left = try snapshot(noteID: noteID, version: fromVersion, context: context),
              let right = try snapshot(noteID: noteID, version: toVersion, context: context) else {
            return nil
        }

        let leftBlockSignatures = Dictionary(uniqueKeysWithValues: left.document.blocks.map { ($0.id, blockSignature($0)) })
        let rightBlockSignatures = Dictionary(uniqueKeysWithValues: right.document.blocks.map { ($0.id, blockSignature($0)) })
        let sharedBlockIDs = Set(leftBlockSignatures.keys).intersection(rightBlockSignatures.keys)
        let changedBlockIDs = sharedBlockIDs
            .filter { leftBlockSignatures[$0] != rightBlockSignatures[$0] }
            .sorted()

        let leftAssetIDs = Set(left.assets.map(\.reference.id))
        let rightAssetIDs = Set(right.assets.map(\.reference.id))
        let addedAssetIDs = rightAssetIDs.subtracting(leftAssetIDs).sorted()
        let removedAssetIDs = leftAssetIDs.subtracting(rightAssetIDs).sorted()

        let metadataChanged =
            left.metadata.folderID != right.metadata.folderID ||
            left.metadata.folderName != right.metadata.folderName ||
            left.metadata.reminderAt != right.metadata.reminderAt ||
            left.metadata.recurrenceRule != right.metadata.recurrenceRule ||
            left.metadata.tagIDs != right.metadata.tagIDs ||
            left.metadata.viewMode != right.metadata.viewMode ||
            left.metadata.deletedAt != right.metadata.deletedAt ||
            left.metadata.originalFolderID != right.metadata.originalFolderID ||
            left.metadata.originalFolderName != right.metadata.originalFolderName

        return NoteVersionComparison(
            noteID: noteID,
            fromVersion: fromVersion,
            toVersion: toVersion,
            titleChanged: left.metadata.title != right.metadata.title,
            metadataChanged: metadataChanged,
            blockCountDelta: right.document.blocks.count - left.document.blocks.count,
            assetCountDelta: right.assets.count - left.assets.count,
            changedBlockIDs: changedBlockIDs,
            addedAssetIDs: addedAssetIDs,
            removedAssetIDs: removedAssetIDs
        )
    }

    @discardableResult
    static func restore(noteID: UUID, toVersion version: Int64, context: ModelContext) throws -> Int64 {
        guard let targetSnapshot = try snapshot(noteID: noteID, version: version, context: context) else {
            throw NSError(domain: "NoteVersionStore", code: 404, userInfo: [NSLocalizedDescriptionKey: "找不到目标版本"])
        }

        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        guard let note = try context.fetch(noteDescriptor).first else {
            throw NSError(domain: "NoteVersionStore", code: 404, userInfo: [NSLocalizedDescriptionKey: "找不到目标笔记"])
        }

        try apply(snapshot: targetSnapshot, to: note, context: context, restoredAt: Date())
        try context.save()
        _ = try ensureHistoryRecorded(noteID: noteID, context: context)
        try context.save()
        return note.version
    }

    static func exportEnvelope(noteID: UUID, context: ModelContext) throws -> VersionedNoteSyncEnvelope? {
        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        guard let note = try context.fetch(noteDescriptor).first else {
            return nil
        }

        let blocks = try context.fetch(
            FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID },
                sortBy: [SortDescriptor(\.position)]
            )
        )
        let assets = try context.fetch(
            FetchDescriptor<BlockDocumentAssetEntity>(
                predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == noteID }
            )
        )
        let currentSnapshot = try makeSnapshot(note: note, blocks: blocks, assets: assets)
        let historyEntries = try history(for: noteID, context: context)
        let historyPayload = try historyEntries.map {
            VersionedNoteHistoryEnvelope(
                id: $0.id,
                noteID: $0.noteID,
                version: $0.version,
                recordedAt: $0.recordedAt,
                updatedAt: $0.updatedAt,
                title: $0.title,
                authorDeviceID: $0.authorDeviceID,
                contentHash: $0.contentHash,
                snapshot: try jsonDecoder.decode(VersionedNoteSnapshot.self, from: $0.snapshotData)
            )
        }
        let syncState = try ensureSyncState(noteID: noteID, context: context)
        return VersionedNoteSyncEnvelope(
            noteID: noteID,
            deviceID: currentDeviceID(),
            exportedAt: Date(),
            currentVersion: note.version,
            currentSnapshot: currentSnapshot,
            history: historyPayload,
            syncState: VersionedNoteSyncStatePayload(
                lastRecordedVersion: syncState.lastRecordedVersion,
                lastSyncedVersion: syncState.lastSyncedVersion,
                lastCommonVersion: syncState.lastCommonVersion,
                lastRemoteVersion: syncState.lastRemoteVersion,
                lastSyncAt: syncState.lastSyncAt,
                lastRemoteDeviceID: syncState.lastRemoteDeviceID,
                remoteFingerprint: syncState.remoteFingerprint,
                pendingHistoryCount: syncState.pendingHistoryCount
            )
        )
    }

    static func mergeRemoteEnvelope(_ envelope: VersionedNoteSyncEnvelope, context: ModelContext) throws -> NoteSyncMergeResult {
        let importedVersions = try importHistory(from: envelope, context: context)
        let syncState = try ensureSyncState(noteID: envelope.noteID, context: context)
        syncState.lastRemoteVersion = envelope.currentVersion
        syncState.lastRemoteDeviceID = envelope.deviceID

        // 用内容指纹而非版本号做冲突检测，避免跨设备版本号不可比的问题
        let incomingFingerprint = try snapshotFingerprint(envelope.currentSnapshot)

        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == envelope.noteID }
        )
        let localNote = try context.fetch(noteDescriptor).first

        if let localNote {
            // localHasChanges: 自上次同步后本地是否有未推送的修改
            let localHasChanges = localNote.version > syncState.lastSyncedVersion
            // remoteHasChanged: 远程内容相比上次同步时是否有变化（首次同步时 fingerprint 为空视为有变化）
            let remoteHasChanged = syncState.remoteFingerprint.isEmpty || incomingFingerprint != syncState.remoteFingerprint
            // sameDeviceEcho: 远程数据来自本机推送，不是真正的冲突
            let sameDeviceEcho = envelope.deviceID == currentDeviceID()

            if localHasChanges && remoteHasChanged && !sameDeviceEcho {
                // 真正的冲突：本地有未推送修改 + 远程有来自其他设备的变化
                // 不再创建副本，而是在笔记上标记冲突状态并保存远程快照
                // 用户稍后可通过 diff 视图手动解决冲突
                Logger.shared.log(.app, .warn, """
                    [SyncConflict] detected noteID=\(envelope.noteID) \
                    localVersion=\(localNote.version) remoteVersion=\(envelope.currentVersion) \
                    deviceID=\(envelope.deviceID)
                    """)

                // 保存远程快照数据供 diff 使用
                localNote.hasConflict = true
                localNote.conflictRemoteSnapshotData = try? jsonEncoder.encode(envelope.currentSnapshot)

                // 不应用远程版本，保留本地内容
                syncState.lastRemoteVersion = envelope.currentVersion
                syncState.lastRemoteDeviceID = envelope.deviceID
                // 更新 remoteFingerprint：避免下次拉取重复触发冲突
                syncState.remoteFingerprint = incomingFingerprint
                syncState.lastSyncAt = Date()

                try context.save()
                return NoteSyncMergeResult(
                    noteID: envelope.noteID,
                    appliedRemoteSnapshot: false,
                    detectedConflict: true,
                    importedHistoryVersions: importedVersions,
                    localVersion: localNote.version,
                    remoteVersion: envelope.currentVersion
                )
            } else if sameDeviceEcho {
                // 同设备回声：远程数据就是本机推送的，只需同步状态，不应用快照也不标记冲突
                // 同时清除可能存在的假冲突标记
                if localNote.hasConflict {
                    localNote.hasConflict = false
                    localNote.conflictRemoteSnapshotData = nil
                }
                syncState.lastSyncedVersion = max(syncState.lastSyncedVersion, envelope.currentVersion)
                syncState.lastCommonVersion = max(syncState.lastCommonVersion, envelope.currentVersion)
                syncState.lastRecordedVersion = max(syncState.lastRecordedVersion, localNote.version)
                syncState.remoteFingerprint = incomingFingerprint
                syncState.lastSyncAt = Date()
                syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
                try context.save()
                return NoteSyncMergeResult(
                    noteID: envelope.noteID,
                    appliedRemoteSnapshot: false,
                    detectedConflict: false,
                    importedHistoryVersions: importedVersions,
                    localVersion: localNote.version,
                    remoteVersion: envelope.currentVersion
                )
            } else if remoteHasChanged {
                // 远程有变化但本地无未推送修改 → 快进应用远程版本
                try apply(snapshot: envelope.currentSnapshot, to: localNote, context: context, restoredAt: envelope.currentSnapshot.metadata.updatedAt)
                syncState.lastCommonVersion = envelope.currentVersion
                // apply 会递增 localNote.version，lastSyncedVersion 必须推进到 localNote.version
                // 否则 localNote.version > lastSyncedVersion 永远为 true，导致 localHasChanges 误判
                syncState.lastSyncedVersion = max(syncState.lastSyncedVersion, localNote.version)
                syncState.lastRecordedVersion = max(syncState.lastRecordedVersion, localNote.version)
                syncState.remoteFingerprint = incomingFingerprint
                syncState.lastSyncAt = Date()
                syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
                try context.save()
                return NoteSyncMergeResult(
                    noteID: envelope.noteID,
                    appliedRemoteSnapshot: true,
                    detectedConflict: false,
                    importedHistoryVersions: importedVersions,
                    localVersion: localNote.version,
                    remoteVersion: envelope.currentVersion
                )
            } else {
                // 远程无实质变化，保留本地内容
                syncState.lastCommonVersion = max(syncState.lastCommonVersion, min(localNote.version, envelope.currentVersion))
                syncState.lastSyncAt = Date()
                syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
                try context.save()
                return NoteSyncMergeResult(
                    noteID: envelope.noteID,
                    appliedRemoteSnapshot: false,
                    detectedConflict: false,
                    importedHistoryVersions: importedVersions,
                    localVersion: localNote.version,
                    remoteVersion: envelope.currentVersion
                )
            }
        }

        let library = try ensureLibrary(context: context)
        let note = BlockDocumentNoteEntity(
            id: envelope.noteID,
            libraryID: library.id,
            title: envelope.currentSnapshot.metadata.title,
            createdAt: envelope.currentSnapshot.metadata.createdAt,
            updatedAt: envelope.currentSnapshot.metadata.updatedAt,
            folderID: envelope.currentSnapshot.metadata.folderID,
            folderName: envelope.currentSnapshot.metadata.folderName,
            reminderAt: envelope.currentSnapshot.metadata.reminderAt,
            recurrenceRule: envelope.currentSnapshot.metadata.recurrenceRule,
            version: envelope.currentSnapshot.metadata.version,
            tagIDs: encodeUUIDList(envelope.currentSnapshot.metadata.tagIDs),
            viewMode: envelope.currentSnapshot.metadata.viewMode,
            deletedAt: envelope.currentSnapshot.metadata.deletedAt,
            originalFolderID: envelope.currentSnapshot.metadata.originalFolderID,
            originalFolderName: envelope.currentSnapshot.metadata.originalFolderName,
            documentSchemaVersion: envelope.currentSnapshot.document.schemaVersion,
            documentSource: envelope.currentSnapshot.document.source,
            blockCount: envelope.currentSnapshot.document.blocks.count,
            assetCount: envelope.currentSnapshot.assets.count
        )
        context.insert(note)
        library.noteCount += 1
        try apply(snapshot: envelope.currentSnapshot, to: note, context: context, restoredAt: envelope.currentSnapshot.metadata.updatedAt, replaceExistingArtifacts: false)
        syncState.lastCommonVersion = envelope.currentVersion
        syncState.lastSyncedVersion = max(syncState.lastSyncedVersion, note.version)
        syncState.lastRecordedVersion = max(syncState.lastRecordedVersion, note.version)
        syncState.remoteFingerprint = incomingFingerprint
        syncState.lastSyncAt = Date()
        syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
        try context.save()

        return NoteSyncMergeResult(
            noteID: envelope.noteID,
            appliedRemoteSnapshot: true,
            detectedConflict: false,
            importedHistoryVersions: importedVersions,
            localVersion: note.version,
            remoteVersion: envelope.currentVersion
        )
    }

    static func markSynced(noteID: UUID, syncedVersion: Int64, context: ModelContext) throws {
        let syncState = try ensureSyncState(noteID: noteID, context: context)
        syncState.lastSyncedVersion = max(syncState.lastSyncedVersion, syncedVersion)
        syncState.lastCommonVersion = max(syncState.lastCommonVersion, syncedVersion)
        syncState.lastSyncAt = Date()
        syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
        try context.save()
    }

    static func markSynced(envelope: VersionedNoteSyncEnvelope, context: ModelContext) throws {
        let syncState = try ensureSyncState(noteID: envelope.noteID, context: context)
        syncState.lastSyncedVersion = max(syncState.lastSyncedVersion, envelope.currentVersion)
        syncState.lastCommonVersion = max(syncState.lastCommonVersion, envelope.currentVersion)
        syncState.lastRemoteVersion = max(syncState.lastRemoteVersion, envelope.currentVersion)
        syncState.lastRemoteDeviceID = envelope.deviceID
        syncState.remoteFingerprint = try snapshotFingerprint(envelope.currentSnapshot)
        syncState.lastSyncAt = Date()
        syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
        try context.save()
    }

    // MARK: - 冲突解决

    /// 获取笔记的远程冲突快照（用于 diff 展示）
    static func conflictRemoteSnapshot(for noteID: UUID, context: ModelContext) throws -> VersionedNoteSnapshot? {
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        guard let note = try context.fetch(descriptor).first,
              let data = note.conflictRemoteSnapshotData else { return nil }
        return try? jsonDecoder.decode(VersionedNoteSnapshot.self, from: data)
    }

    /// 解决冲突：保留本地版本
    static func resolveConflictKeepLocal(noteID: UUID, context: ModelContext) throws {
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        guard let note = try context.fetch(descriptor).first else { return }

        note.hasConflict = false
        note.conflictRemoteSnapshotData = nil

        let syncState = try ensureSyncState(noteID: noteID, context: context)
        // 不覆盖 remoteFingerprint：冲突检测时已正确设置为 incomingFingerprint
        // 重新从快照计算可能因 JSON round-trip 产生不同指纹，导致下次拉取重复触发冲突
        // 不推进 lastSyncedVersion：保留本地版本需要下次推送覆盖远程
        syncState.lastSyncAt = Date()
        syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
        try context.save()
    }

    /// 解决冲突：采用远程版本
    static func resolveConflictKeepRemote(noteID: UUID, context: ModelContext) throws {
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        guard let note = try context.fetch(descriptor).first,
              let data = note.conflictRemoteSnapshotData,
              let snapshot = try? jsonDecoder.decode(VersionedNoteSnapshot.self, from: data) else { return }

        try apply(snapshot: snapshot, to: note, context: context, restoredAt: snapshot.metadata.updatedAt)
        note.hasConflict = false
        note.conflictRemoteSnapshotData = nil

        let syncState = try ensureSyncState(noteID: noteID, context: context)
        syncState.lastSyncedVersion = max(syncState.lastSyncedVersion, note.version)
        syncState.lastRemoteVersion = max(syncState.lastRemoteVersion, note.version)
        // 不覆盖 remoteFingerprint：冲突检测时已正确设置为 incomingFingerprint
        // 重新从快照计算可能因 JSON round-trip 产生不同指纹
        syncState.lastSyncAt = Date()
        syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
        try context.save()
    }

    /// 裁剪历史版本：保留最近 maxCount 个且不超过 maxAge 天的版本
    static func pruneHistory(
        noteID: UUID,
        context: ModelContext,
        maxCount: Int = 50,
        maxAgeDays: Int = 30
    ) throws {
        let allVersions = try history(for: noteID, context: context)
        guard allVersions.count > maxCount else { return }

        let cutoffDate = Date().addingTimeInterval(-Double(maxAgeDays) * 86400)
        // 按版本号升序排列，最旧的在前面
        let sorted = allVersions.sorted { $0.version < $1.version }
        // 保留最新的 maxCount 个
        let keepFromIndex = sorted.count - maxCount
        let toDelete = sorted.prefix(keepFromIndex).filter { entry in
            // 不删除 30 天内的版本
            entry.recordedAt < cutoffDate
        }

        for entry in toDelete {
            context.delete(entry)
        }
        if !toDelete.isEmpty {
            try context.save()
            Logger.shared.log(.app, .debug, "[PruneHistory] noteID=\(noteID.uuidString.prefix(8)) deleted=\(toDelete.count) remaining=\(sorted.count - toDelete.count)")
        }
    }

    static func deleteHistory(noteID: UUID, context: ModelContext) throws {
        for entry in try history(for: noteID, context: context) {
            context.delete(entry)
        }

        let syncStateDescriptor = FetchDescriptor<BlockDocumentNoteSyncStateEntity>(
            predicate: #Predicate<BlockDocumentNoteSyncStateEntity> { $0.noteID == noteID }
        )
        if let syncState = try context.fetch(syncStateDescriptor).first {
            context.delete(syncState)
        }
    }

    static func recordDeletedTombstone(noteID: UUID, deletedAt: Date = Date(), context: ModelContext) throws {
        let descriptor = FetchDescriptor<BlockDocumentDeletedNoteTombstoneEntity>(
            predicate: #Predicate<BlockDocumentDeletedNoteTombstoneEntity> { $0.noteID == noteID }
        )
        if let existing = try context.fetch(descriptor).first {
            existing.deletedAt = max(existing.deletedAt, deletedAt)
            existing.deletedByDeviceID = currentDeviceID()
            return
        }

        context.insert(
            BlockDocumentDeletedNoteTombstoneEntity(
                noteID: noteID,
                deletedAt: deletedAt,
                deletedByDeviceID: currentDeviceID()
            )
        )
    }

    static func deletedTombstones(context: ModelContext) throws -> [BlockDocumentDeletedNoteTombstoneEntity] {
        try context.fetch(FetchDescriptor<BlockDocumentDeletedNoteTombstoneEntity>())
    }

    static func cleanupDeletedTombstones(noteIDs: Set<UUID>, context: ModelContext) throws {
        guard !noteIDs.isEmpty else { return }
        for noteID in noteIDs {
            let descriptor = FetchDescriptor<BlockDocumentDeletedNoteTombstoneEntity>(
                predicate: #Predicate<BlockDocumentDeletedNoteTombstoneEntity> { $0.noteID == noteID }
            )
            if let tombstone = try context.fetch(descriptor).first {
                context.delete(tombstone)
            }
        }
    }

    private static func importHistory(from envelope: VersionedNoteSyncEnvelope, context: ModelContext) throws -> [Int64] {
        let noteID = envelope.noteID
        var importedVersions: [Int64] = []

        for historyEntry in envelope.history {
            let versionDescriptor = FetchDescriptor<BlockDocumentNoteVersionEntity>(
                predicate: #Predicate<BlockDocumentNoteVersionEntity> {
                    $0.noteID == noteID && $0.version == historyEntry.version
                }
            )
            if try context.fetch(versionDescriptor).first != nil {
                continue
            }

            let snapshotData = try jsonEncoder.encode(historyEntry.snapshot)
            context.insert(
                BlockDocumentNoteVersionEntity(
                    id: historyEntry.id,
                    noteID: historyEntry.noteID,
                    version: historyEntry.version,
                    recordedAt: historyEntry.recordedAt,
                    updatedAt: historyEntry.updatedAt,
                    title: historyEntry.title,
                    authorDeviceID: historyEntry.authorDeviceID,
                    contentHash: historyEntry.contentHash,
                    snapshotData: snapshotData
                )
            )
            importedVersions.append(historyEntry.version)
        }

        let syncState = try ensureSyncState(noteID: noteID, context: context)
        if let maxHistoryVersion = (envelope.history.map(\.version).max()) {
            syncState.lastRecordedVersion = max(syncState.lastRecordedVersion, maxHistoryVersion)
        }
        syncState.pendingHistoryCount = max(0, Int(syncState.lastRecordedVersion - syncState.lastSyncedVersion))
        return importedVersions.sorted()
    }

    private static func ensureLibrary(context: ModelContext) throws -> BlockDocumentLibraryEntity {
        if let existing = try context.fetch(
            FetchDescriptor<BlockDocumentLibraryEntity>(sortBy: [SortDescriptor(\.importedAt, order: .reverse)])
        ).first {
            return existing
        }

        let library = BlockDocumentLibraryEntity(schemaVersion: "1.0", sourceExportedAt: Date())
        context.insert(library)
        return library
    }

    private static func ensureSyncState(noteID: UUID, context: ModelContext) throws -> BlockDocumentNoteSyncStateEntity {
        let syncStateDescriptor = FetchDescriptor<BlockDocumentNoteSyncStateEntity>(
            predicate: #Predicate<BlockDocumentNoteSyncStateEntity> { $0.noteID == noteID }
        )
        if let existing = try context.fetch(syncStateDescriptor).first {
            return existing
        }

        let syncState = BlockDocumentNoteSyncStateEntity(noteID: noteID)
        context.insert(syncState)
        return syncState
    }

    private static func apply(
        snapshot: VersionedNoteSnapshot,
        to note: BlockDocumentNoteEntity,
        context: ModelContext,
        restoredAt: Date,
        replaceExistingArtifacts: Bool = true
    ) throws {
        let noteID = note.id
        if replaceExistingArtifacts {
            for block in try context.fetch(
                FetchDescriptor<BlockDocumentBlockEntity>(
                    predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID }
                )
            ) {
                context.delete(block)
            }
            for asset in try context.fetch(
                FetchDescriptor<BlockDocumentAssetEntity>(
                    predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == noteID }
                )
            ) {
                context.delete(asset)
            }
        }

        note.title = snapshot.metadata.title
        note.createdAt = snapshot.metadata.createdAt
        note.updatedAt = restoredAt
        note.folderID = snapshot.metadata.folderID
        note.folderName = snapshot.metadata.folderName
        note.reminderAt = snapshot.metadata.reminderAt
        note.recurrenceRule = snapshot.metadata.recurrenceRule
        note.version = max(note.version + 1, snapshot.metadata.version + (replaceExistingArtifacts ? 1 : 0))
        note.tagIDs = encodeUUIDList(snapshot.metadata.tagIDs)
        note.viewMode = snapshot.metadata.viewMode
        note.deletedAt = snapshot.metadata.deletedAt
        note.originalFolderID = snapshot.metadata.originalFolderID
        note.originalFolderName = snapshot.metadata.originalFolderName
        note.documentSchemaVersion = snapshot.document.schemaVersion
        note.documentSource = snapshot.document.source
        note.blockCount = snapshot.document.blocks.count
        note.assetCount = snapshot.assets.count

        for asset in snapshot.assets {
            context.insert(
                BlockDocumentAssetEntity(
                    noteID: note.id,
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
                    sidecarPathsPayload: try jsonEncoder.encode(asset.sidecarRelativePaths)
                )
            )
        }

        for (position, block) in snapshot.document.blocks.enumerated() {
            context.insert(
                BlockDocumentBlockEntity(
                    noteID: note.id,
                    position: position,
                    blockID: block.id,
                    kind: block.type,
                    sourceType: block.type,
                    textPayload: try block.text.map { try jsonEncoder.encode($0.map(mapTextPayload)) },
                    level: block.level,
                    listStyle: block.listStyle,
                    order: block.order,
                    checked: block.checked,
                    indent: block.indent,
                    assetID: block.asset?.id,
                    tablePayload: try block.table.map { try jsonEncoder.encode(BlockDocumentTablePayload(rows: $0.rows, columnWidths: $0.columnWidths, rowHeights: $0.rowHeights)) }
                )
            )
        }
        // 清空脏检查哈希：应用远程/冲突快照后，下次本地保存将重新计算并纠正
        note.lastSavedContentHash = ""
    }

    private static func makeSnapshot(
        note: BlockDocumentNoteEntity,
        blocks: [BlockDocumentBlockEntity],
        assets: [BlockDocumentAssetEntity]
    ) throws -> VersionedNoteSnapshot {
        let assetSnapshots = try assets.map(makeAssetSnapshot).sorted { $0.reference.id < $1.reference.id }
        let assetByID = Dictionary(uniqueKeysWithValues: assetSnapshots.map { ($0.reference.id, $0.reference) })
        let documentBlocks = try blocks.map { try makeDocumentBlock(from: $0, assetByID: assetByID) }
        return VersionedNoteSnapshot(
            metadata: DocumentMigrationPackage.NoteItem(
                id: note.id,
                title: note.title,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
                folderID: note.folderID,
                folderName: note.folderName,
                reminderAt: note.reminderAt,
                recurrenceRule: note.recurrenceRule,
                version: note.version,
                tagIDs: decodeUUIDList(note.tagIDs),
                viewMode: note.viewMode,
                deletedAt: note.deletedAt,
                originalFolderID: note.originalFolderID,
                originalFolderName: note.originalFolderName,
                blockCount: blocks.count,
                assetCount: assets.count,
                documentPath: "Notes/\(note.id.uuidString)/document.json"
            ),
            document: MigratedDocument(
                schemaVersion: note.documentSchemaVersion,
                source: note.documentSource,
                blocks: documentBlocks
            ),
            assets: assetSnapshots
        )
    }

    private static func makeAssetSnapshot(from asset: BlockDocumentAssetEntity) throws -> VersionedNoteAssetSnapshot {
        let sidecarPaths = try decodeStringArray(asset.sidecarPathsPayload)
        return VersionedNoteAssetSnapshot(
            reference: MigratedAssetReference(
                id: asset.assetID,
                kind: asset.kind,
                filename: asset.filename,
                mimeType: asset.mimeType,
                width: asset.width,
                height: asset.height,
                duration: asset.duration,
                createdAt: asset.createdAt,
                sidecarFiles: sidecarPaths
            ),
            relativeFilePath: asset.relativeFilePath,
            sidecarRelativePaths: sidecarPaths
        )
    }

    private static func makeDocumentBlock(
        from block: BlockDocumentBlockEntity,
        assetByID: [String: MigratedAssetReference]
    ) throws -> MigratedDocumentBlock {
        MigratedDocumentBlock(
            id: block.blockID,
            type: block.kind,
            text: try decodeTextPayload(block.textPayload),
            level: block.level,
            listStyle: block.listStyle,
            order: block.order,
            checked: block.checked,
            indent: block.indent,
            asset: block.assetID.flatMap { assetByID[$0] },
            table: try decodeTablePayload(block.tablePayload)
        )
    }

    private static func decodeTextPayload(_ data: Data?) throws -> [MigratedInlineText]? {
        guard let data else {
            return nil
        }
        return try jsonDecoder.decode([BlockDocumentTextSpanPayload].self, from: data).map {
            MigratedInlineText(
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
                    MigratedParagraphStyle(
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
    }

    private static func decodeTablePayload(_ data: Data?) throws -> MigratedTable? {
        guard let data else {
            return nil
        }
        let table = try jsonDecoder.decode(BlockDocumentTablePayload.self, from: data)
        return MigratedTable(rows: table.rows, columnWidths: table.columnWidths, rowHeights: table.rowHeights)
    }

    private static func decodeStringArray(_ data: Data?) throws -> [String] {
        guard let data else {
            return []
        }
        return try jsonDecoder.decode([String].self, from: data)
    }

    private static func mapTextPayload(_ inline: MigratedInlineText) -> BlockDocumentTextSpanPayload {
        BlockDocumentTextSpanPayload(
            text: inline.text,
            bold: inline.bold,
            italic: inline.italic,
            underline: inline.underline,
            strikethrough: inline.strikethrough,
            textColor: inline.textColor,
            backgroundColor: inline.backgroundColor,
            link: inline.link,
            fontFamily: inline.fontFamily,
            fontSize: inline.fontSize,
            kern: inline.kern,
            baselineOffset: inline.baselineOffset,
            paragraphStyle: inline.paragraphStyle.map {
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

    private static func decodeUUIDList(_ rawValue: String) -> [UUID] {
        rawValue
            .split(separator: ",")
            .compactMap { UUID(uuidString: String($0)) }
    }

    private static func encodeUUIDList(_ values: [UUID]) -> String {
        values.map(\.uuidString).joined(separator: ",")
    }

    private static func blockSignature(_ block: MigratedDocumentBlock) -> String {
        let text = (block.text ?? []).map(\.text).joined(separator: "\u{241E}")
        let table = block.table.map { "\($0.rows)\($0.columnWidths)\($0.rowHeights)" } ?? ""
        let asset = block.asset?.id ?? ""
        return [
            block.id,
            block.type,
            text,
            block.listStyle ?? "",
            String(block.level ?? -1),
            String(block.order ?? -1),
            String(block.checked ?? false),
            String(block.indent ?? -1),
            asset,
            table
        ].joined(separator: "\u{241F}")
    }

    static func fingerprint(for data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// 用统一的 jsonEncoder 编码快照并计算指纹，确保所有模块的指纹计算方式一致
    static func snapshotFingerprint(_ snapshot: VersionedNoteSnapshot) throws -> String {
        fingerprint(for: try jsonEncoder.encode(snapshot))
    }
}
