import Foundation
import SwiftData
import Combine

@MainActor
final class PersistenceController: ObservableObject {
    static let shared = PersistenceController()

    @Published private(set) var modelContainer: ModelContainer?
    /// 当前 store format 版本，与 `NotebookSchemaV7.versionIdentifier` 对齐。
    /// 每次引入 schema 变更时需同步 bump，并在 `NotebookSchemaMigrationPlan` 中追加 stage。
    static let currentStoreFormatVersion = 7

    static let appSchema = Schema([
        BlockDocumentLibraryEntity.self,
        BlockDocumentFolderEntity.self,
        BlockDocumentTagEntity.self,
        BlockDocumentReadingPositionEntity.self,
        BlockDocumentNoteEntity.self,
        BlockDocumentBlockEntity.self,
        BlockDocumentAssetEntity.self,
        BlockDocumentNoteVersionEntity.self,
        BlockDocumentNoteSyncStateEntity.self,
        BlockDocumentBackendSyncStateEntity.self,
        BlockDocumentDeletedNoteTombstoneEntity.self,
        BlockDocumentLibraryTombstoneEntity.self,
        BlockDocumentNoteTagEntity.self,
        TodoStepEntity.self
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
        // 当前 V1...V5 都只包含带默认值的新增字段/实体，交由 SwiftData 的自动
        // lightweight migration 处理。不要连接 NotebookSchemaMigrationPlan：其历史版本
        // 仍复用当前实体类型，不能代表真实的旧 schema；强行连接反而可能让既有 store
        // 无法匹配版本。任何未来破坏性迁移必须先引入独立的版本化实体定义和旧库夹具。
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
