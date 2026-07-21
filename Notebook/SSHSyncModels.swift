import Foundation

struct RemoteNoteIndex: Codable {
    let generatedAt: Date
    let deviceID: String
    let entries: [RemoteNoteIndexEntry]
    let deletedEntries: [RemoteDeletedEntry]

    init(generatedAt: Date, deviceID: String, entries: [RemoteNoteIndexEntry], deletedEntries: [RemoteDeletedEntry] = []) {
        self.generatedAt = generatedAt
        self.deviceID = deviceID
        self.entries = entries
        self.deletedEntries = deletedEntries
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try container.decode(Date.self, forKey: .generatedAt)
        deviceID = try container.decode(String.self, forKey: .deviceID)
        entries = try container.decode([RemoteNoteIndexEntry].self, forKey: .entries)
        deletedEntries = try container.decodeIfPresent([RemoteDeletedEntry].self, forKey: .deletedEntries) ?? []
    }
}

/// A remote index is mutable shared state and older clients or interrupted
/// publications may leave duplicate rows behind.  Keep normalization explicit
/// instead of relying on `Dictionary(uniqueKeysWithValues:)`, which traps on
/// malformed remote input.
struct RemoteNoteIndexNormalization {
    let index: RemoteNoteIndex
    let duplicateEntryNoteIDs: Set<UUID>
    let duplicateDeletedNoteIDs: Set<UUID>
    let entryDeletionConflictNoteIDs: Set<UUID>

    var affectedNoteIDs: Set<UUID> {
        duplicateEntryNoteIDs
            .union(duplicateDeletedNoteIDs)
            .union(entryDeletionConflictNoteIDs)
    }

    var requiresRepair: Bool { !affectedNoteIDs.isEmpty }
}

extension RemoteNoteIndex {
    func normalizedForSafety() -> RemoteNoteIndexNormalization {
        var entriesByID: [UUID: RemoteNoteIndexEntry] = [:]
        var duplicateEntryNoteIDs = Set<UUID>()
        for entry in entries {
            if let existing = entriesByID[entry.noteID] {
                duplicateEntryNoteIDs.insert(entry.noteID)
                entriesByID[entry.noteID] = Self.preferred(existing, entry)
            } else {
                entriesByID[entry.noteID] = entry
            }
        }

        var deletedByID: [UUID: RemoteDeletedEntry] = [:]
        var duplicateDeletedNoteIDs = Set<UUID>()
        for deletion in deletedEntries {
            if let existing = deletedByID[deletion.noteID] {
                duplicateDeletedNoteIDs.insert(deletion.noteID)
                deletedByID[deletion.noteID] = Self.preferred(existing, deletion)
            } else {
                deletedByID[deletion.noteID] = deletion
            }
        }

        // A published tombstone always wins over an entry. This is the same
        // resurrection-prevention rule used by the normal publisher.
        let entryDeletionConflictNoteIDs = Set(entriesByID.keys).intersection(deletedByID.keys)
        for noteID in deletedByID.keys {
            entriesByID.removeValue(forKey: noteID)
        }

        return RemoteNoteIndexNormalization(
            index: RemoteNoteIndex(
                generatedAt: generatedAt,
                deviceID: deviceID,
                entries: entriesByID.values.sorted { $0.noteID.uuidString < $1.noteID.uuidString },
                deletedEntries: deletedByID.values.sorted { $0.noteID.uuidString < $1.noteID.uuidString }
            ),
            duplicateEntryNoteIDs: duplicateEntryNoteIDs,
            duplicateDeletedNoteIDs: duplicateDeletedNoteIDs,
            entryDeletionConflictNoteIDs: entryDeletionConflictNoteIDs
        )
    }

    private static func preferred(
        _ lhs: RemoteNoteIndexEntry,
        _ rhs: RemoteNoteIndexEntry
    ) -> RemoteNoteIndexEntry {
        if lhs.version != rhs.version {
            return lhs.version > rhs.version ? lhs : rhs
        }
        if lhs.historyCount != rhs.historyCount {
            return lhs.historyCount > rhs.historyCount ? lhs : rhs
        }
        // Stable tie-breaker makes every device repair the same malformed
        // index. The note payload remains authoritative during the pull.
        return lhs.contentHash >= rhs.contentHash ? lhs : rhs
    }

    private static func preferred(
        _ lhs: RemoteDeletedEntry,
        _ rhs: RemoteDeletedEntry
    ) -> RemoteDeletedEntry {
        if lhs.deletedAt != rhs.deletedAt {
            return lhs.deletedAt > rhs.deletedAt ? lhs : rhs
        }
        return lhs.deletedByDeviceID >= rhs.deletedByDeviceID ? lhs : rhs
    }
}

struct RemoteNoteIndexEntry: Codable {
    let noteID: UUID
    let version: Int64
    let contentHash: String
    let historyCount: Int
}

struct RemoteDeletedEntry: Codable {
    let noteID: UUID
    let deletedAt: Date
    let deletedByDeviceID: String
}

struct AssetsManifest: Codable {
    let generatedAt: Date
    let deviceID: String
    let entries: [AssetsManifestEntry]
}

struct AssetsManifestEntry: Codable {
    let relativePath: String
    let contentHash: String
    let size: Int
}

struct LibrarySyncEnvelope: Codable {
    let exportedAt: Date
    let deviceID: String
    let folders: [FolderSyncEntry]
    let tags: [TagSyncEntry]
    let encryptedData: EncryptedFolderSyncData?
    let deletedFolders: [LibraryDeletedEntry]?
    let deletedTags: [LibraryDeletedEntry]?
}

struct LibraryDeletedEntry: Codable {
    let id: UUID
    let deletedAt: Date
    let deletedByDeviceID: String
}

struct FolderSyncEntry: Codable {
    let id: UUID
    let name: String
    let sortOrder: Int
    let isSystem: Bool
    let createdAt: Date?
    let folderType: String?
    let updatedAt: Date?
}

struct TagSyncEntry: Codable {
    let id: UUID
    let name: String
    let color: String
    let createdAt: Date
    let updatedAt: Date?
}

struct EncryptedFolderSyncData: Codable {
    let encryptedFolders: [EncryptedFolder]
    let encryptedNoteIDs: [String]
    let noteToFolderMapping: [String: String]
}

struct SSHSyncProgress {
    let phase: SyncPhase
    let current: Int
    let total: Int
    let message: String

    var fraction: Double {
        guard total > 0 else { return 0 }
        return Double(current) / Double(total)
    }
}

typealias SSHSyncProgressHandler = @Sendable (SSHSyncProgress) async -> Void

enum SyncPhase: String {
    case pushLibrary = "推送文件夹/标签"
    case pushNotes = "推送笔记"
    case pushAssets = "推送附件"
    case pushConfig = "推送配置"
    case pullLibrary = "拉取文件夹/标签"
    case pullNotes = "拉取笔记"
    case pullAssets = "拉取附件"
    case pullConfig = "拉取配置"
    case checkMissingAssets = "检查缺失附件"
}

/// SSH 同步管理器内部的可变同步状态，由 actor 串行化访问。
actor SSHSyncState {
    private(set) var activeControlMasterPaths: Set<String> = []
    private(set) var activeSyncOperationName: String?

    func isSyncOperationRunning() -> Bool { activeSyncOperationName != nil }

    func beginSyncOperation(named operationName: String) -> String? {
        if let activeSyncOperationName { return activeSyncOperationName }
        activeSyncOperationName = operationName
        return nil
    }

    func endSyncOperation() { activeSyncOperationName = nil }
    func containsControlMasterPath(_ path: String) -> Bool { activeControlMasterPaths.contains(path) }
    func insertControlMasterPath(_ path: String) { activeControlMasterPaths.insert(path) }

    func removeControlMasterPath(_ path: String) -> Bool {
        guard activeControlMasterPaths.contains(path) else { return false }
        activeControlMasterPaths.remove(path)
        return true
    }

    func snapshotControlMasterPaths() -> [String] { Array(activeControlMasterPaths) }
}
