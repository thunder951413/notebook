import Foundation

struct PersistenceMigrationBackupManifest: Codable {
    let id: UUID
    let createdAt: Date
    let reason: String
    let sourceDatabaseDirectory: String
    let sourceStoreFilename: String
    let sourceFormatVersion: Int?
    let targetFormatVersion: Int
}

enum PersistenceMigrationSafetyError: LocalizedError {
    case missingBackupDatabase(URL)
    case refusingToOverwriteLiveDatabase(URL)

    var errorDescription: String? {
        switch self {
        case .missingBackupDatabase(let url):
            return "迁移备份中缺少数据库目录: \(url.path)"
        case .refusingToOverwriteLiveDatabase(let url):
            return "实时数据库目录仍存在，拒绝覆盖: \(url.path)"
        }
    }
}

enum PersistenceMigrationSafety {
    static let stateFilename = "migration-state.json"
    static let backupsDirectoryName = "MigrationBackups"
    static let databaseSnapshotDirectoryName = "Database"

    struct State: Codable {
        var storeFormatVersion: Int
        var updatedAt: Date
        var lastBackupID: UUID?
    }

    static func prepareStoreForOpening(
        storeURL: URL,
        databaseDirectory: URL,
        notebookDataDirectory: URL,
        targetFormatVersion: Int,
        reason: String
    ) throws {
        guard storeFilesExist(for: storeURL) else {
            return
        }

        let state = loadState(from: stateURL(in: notebookDataDirectory))
        guard state?.storeFormatVersion != targetFormatVersion else {
            return
        }

        let backupURL = try createDatabaseBackup(
            storeURL: storeURL,
            databaseDirectory: databaseDirectory,
            notebookDataDirectory: notebookDataDirectory,
            sourceFormatVersion: state?.storeFormatVersion,
            targetFormatVersion: targetFormatVersion,
            reason: reason
        )
        Logger.shared.log(.storage, .info, "已创建迁移前数据库备份: \(backupURL.path)")
    }

    static func markStoreOpened(
        notebookDataDirectory: URL,
        targetFormatVersion: Int,
        lastBackupID: UUID? = nil
    ) throws {
        let state = State(
            storeFormatVersion: targetFormatVersion,
            updatedAt: Date(),
            lastBackupID: lastBackupID
        )
        let stateURL = stateURL(in: notebookDataDirectory)
        let data = try JSONEncoder().encode(state)
        try data.write(to: stateURL, options: .atomic)
    }

    static func latestBackup(in notebookDataDirectory: URL) throws -> URL? {
        let backupsRoot = backupsDirectory(in: notebookDataDirectory)
        guard FileManager.default.fileExists(atPath: backupsRoot.path) else {
            return nil
        }

        return try FileManager.default
            .contentsOfDirectory(at: backupsRoot, includingPropertiesForKeys: [.creationDateKey], options: [.skipsHiddenFiles])
            .filter { $0.hasDirectoryPath }
            .sorted { lhs, rhs in
                creationDate(for: lhs) > creationDate(for: rhs)
            }
            .first
    }

    static func restoreBackup(_ backupURL: URL, to databaseDirectory: URL) throws {
        let sourceDatabase = backupURL.appendingPathComponent(databaseSnapshotDirectoryName, isDirectory: true)
        guard FileManager.default.fileExists(atPath: sourceDatabase.path) else {
            throw PersistenceMigrationSafetyError.missingBackupDatabase(sourceDatabase)
        }
        guard !FileManager.default.fileExists(atPath: databaseDirectory.path) else {
            throw PersistenceMigrationSafetyError.refusingToOverwriteLiveDatabase(databaseDirectory)
        }

        try FileManager.default.copyItem(at: sourceDatabase, to: databaseDirectory)
    }

    private static func createDatabaseBackup(
        storeURL: URL,
        databaseDirectory: URL,
        notebookDataDirectory: URL,
        sourceFormatVersion: Int?,
        targetFormatVersion: Int,
        reason: String
    ) throws -> URL {
        let id = UUID()
        let timestamp = ISO8601DateFormatter.filenameSafeString(from: Date())
        let backupURL = backupsDirectory(in: notebookDataDirectory)
            .appendingPathComponent("\(timestamp)_\(id.uuidString)", isDirectory: true)
        let snapshotURL = backupURL.appendingPathComponent(databaseSnapshotDirectoryName, isDirectory: true)

        try FileManager.default.createDirectory(at: backupURL, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: databaseDirectory, to: snapshotURL)

        let manifest = PersistenceMigrationBackupManifest(
            id: id,
            createdAt: Date(),
            reason: reason,
            sourceDatabaseDirectory: databaseDirectory.path,
            sourceStoreFilename: storeURL.lastPathComponent,
            sourceFormatVersion: sourceFormatVersion,
            targetFormatVersion: targetFormatVersion
        )
        let manifestData = try JSONEncoder().encode(manifest)
        try manifestData.write(to: backupURL.appendingPathComponent("manifest.json"), options: .atomic)

        return backupURL
    }

    private static func storeFilesExist(for storeURL: URL) -> Bool {
        let candidates = [
            storeURL,
            URL(fileURLWithPath: storeURL.path + "-shm"),
            URL(fileURLWithPath: storeURL.path + "-wal")
        ]
        return candidates.contains { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func stateURL(in notebookDataDirectory: URL) -> URL {
        notebookDataDirectory.appendingPathComponent(stateFilename)
    }

    private static func backupsDirectory(in notebookDataDirectory: URL) -> URL {
        notebookDataDirectory.appendingPathComponent(backupsDirectoryName, isDirectory: true)
    }

    private static func loadState(from url: URL) -> State? {
        guard let data = try? Data(contentsOf: url) else {
            return nil
        }
        return try? JSONDecoder().decode(State.self, from: data)
    }

    private static func creationDate(for url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
    }
}

private extension ISO8601DateFormatter {
    static let filenameSafeFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func filenameSafeString(from date: Date) -> String {
        filenameSafeFormatter.string(from: date)
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: "/", with: "-")
    }
}
