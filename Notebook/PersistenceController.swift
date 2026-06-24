import Foundation
import SwiftData
import Combine

@MainActor
final class PersistenceController: ObservableObject {
    static let shared = PersistenceController()

    @Published private(set) var modelContainer: ModelContainer?
    /// 当前 store format 版本，与 `NotebookSchemaV4.versionIdentifier` 对齐。
    /// 每次引入 schema 变更时需同步 bump，并在 `NotebookSchemaMigrationPlan` 中追加 stage。
    static let currentStoreFormatVersion = 4

    static let appSchema = Schema([
        BlockDocumentLibraryEntity.self,
        BlockDocumentFolderEntity.self,
        BlockDocumentTagEntity.self,
        BlockDocumentNoteEntity.self,
        BlockDocumentBlockEntity.self,
        BlockDocumentAssetEntity.self,
        BlockDocumentNoteVersionEntity.self,
        BlockDocumentNoteSyncStateEntity.self,
        BlockDocumentDeletedNoteTombstoneEntity.self,
        BlockDocumentNoteTagEntity.self
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

        let container = try Self.makeModelContainer(storageLocationManager: location, migrationReason: "configureIfPossible")

        // 确保 security-scoped 权限在后续读写时可用
        // SwiftData 自己会访问 url，所以我们只确保 bookmark 是有效的。
        _ = base.startAccessingSecurityScopedResource()
        base.stopAccessingSecurityScopedResource()

        self.modelContainer = container
    }

    static func makeModelContainer(
        storageLocationManager location: StorageLocationManager,
        migrationReason: String
    ) throws -> ModelContainer {
        try location.ensureDirectoryStructureExists()

        let notebookDataDirectory = try location.notebookDataDirectoryURL()
        let databaseDirectory = try location.databaseDirectoryURL()
        let storeURL = databaseDirectory.appendingPathComponent("notebook.store")
        let schema = Self.appSchema

        try PersistenceMigrationSafety.prepareStoreForOpening(
            storeURL: storeURL,
            databaseDirectory: databaseDirectory,
            notebookDataDirectory: notebookDataDirectory,
            targetFormatVersion: currentStoreFormatVersion,
            reason: migrationReason
        )

        let config = ModelConfiguration(schema: schema, url: storeURL)
        // 显式传入 migrationPlan，让 SwiftData 按版本顺序执行 stage（V1→V2 等）。
        // 即便当前 stage 仅做日志记录，接线后未来 V3+ 的破坏性迁移可直接在此链路追加。
        let container = try ModelContainer(for: schema, configurations: [config])
        logIntegrityReport(for: container)

        try PersistenceMigrationSafety.markStoreOpened(
            notebookDataDirectory: notebookDataDirectory,
            targetFormatVersion: currentStoreFormatVersion
        )

        return container
    }

    private static func logIntegrityReport(for container: ModelContainer) {
        do {
            let report = try BlockDocumentIntegrityValidator.validate(context: ModelContext(container))
            if report.isClean {
                Logger.shared.log(.storage, .info, "数据完整性检查通过: notes=\(report.noteCount), blocks=\(report.blockCount), assets=\(report.assetCount)")
            } else {
                Logger.shared.log(.storage, .warn, "数据完整性检查发现 \(report.issueCount) 个问题")
                for issue in report.issues.prefix(20) {
                    Logger.shared.log(.storage, .warn, "\(issue.kind.rawValue): \(issue.message) owner=\(issue.ownerID) referenced=\(issue.referencedID)")
                }
            }
        } catch {
            Logger.shared.log(.storage, .error, "数据完整性检查失败: \(error.localizedDescription)")
        }
    }
}
