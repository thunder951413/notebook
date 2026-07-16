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
