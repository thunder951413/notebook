import Foundation
import SwiftData
import Combine

@MainActor
final class PersistenceController: ObservableObject {
    static let shared = PersistenceController()

    @Published private(set) var modelContainer: ModelContainer?

    private init() {}

    func configureIfPossible() throws {
        let location = StorageLocationManager.shared
        guard location.isConfigured else {
            modelContainer = nil
            return
        }

        try location.ensureDirectoryStructureExists()

        guard let base = location.baseDirectoryURL else { return }

        let storeURL = try location.databaseDirectoryURL().appendingPathComponent("reminder.store")

        let schema = Schema([
            NoteEntity.self,
            FolderEntity.self
        ])

        let config = ModelConfiguration(schema: schema, url: storeURL)
        let container = try ModelContainer(for: schema, configurations: [config])

        // 确保 security-scoped 权限在后续读写时可用
        // SwiftData 自己会访问 url，所以我们只确保 bookmark 是有效的。
        _ = base.startAccessingSecurityScopedResource()
        base.stopAccessingSecurityScopedResource()

        self.modelContainer = container
    }
}

@Model
final class FolderEntity {
    @Attribute(.unique) var id: UUID
    var name: String

    init(id: UUID = UUID(), name: String) {
        self.id = id
        self.name = name
    }
}

@Model
final class NoteEntity {
    @Attribute(.unique) var id: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var folderName: String

    /// RTFD 数据（可包含图片附件）。音频附件先用占位/引用，后续做自定义 attachment 序列化。
    var rtfdData: Data?
    var reminderAt: Date?
    var recurrenceRule: String? // "none", "daily", "weekly", "monthly"
    var version: Int64 = 0

    init(
        id: UUID = UUID(),
        title: String,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        folderName: String = "未分类",
        rtfdData: Data? = nil,
        reminderAt: Date? = nil,
        recurrenceRule: String? = "none",
        version: Int64 = 0
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.folderName = folderName
        self.rtfdData = rtfdData
        self.reminderAt = reminderAt
        self.recurrenceRule = recurrenceRule
        self.version = version
    }
}
