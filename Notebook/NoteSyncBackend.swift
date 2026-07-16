import Foundation
import SwiftData

/// 自动同步所需的最小后端接口。
/// UI/调度层只依赖此协议，避免直接绑定 SSH、全局配置和持久化单例。
@MainActor
protocol NoteSyncBackend: AnyObject {
    var isConfigured: Bool { get }
    var isPersistenceAvailable: Bool { get }

    func pushSavedNote(noteID: UUID) async throws
    func pullAllNotes() async throws
    func pushAllNotes() async throws
}

@MainActor
final class SSHNoteSyncBackend: NoteSyncBackend {
    static let shared = SSHNoteSyncBackend()

    private init() {}

    var isConfigured: Bool {
        SSHConfigManager.shared.isConfigured
    }

    var isPersistenceAvailable: Bool {
        PersistenceController.shared.modelContainer != nil
    }

    func pushSavedNote(noteID: UUID) async throws {
        let context = try mainContext()
        try await SSHSyncManager.shared.syncNoteToRemote(
            noteID: noteID,
            context: context,
            config: SSHConfigManager.shared.config
        )
    }

    func pullAllNotes() async throws {
        let context = try mainContext()
        _ = try await SSHSyncManager.shared.syncAllNotesFromRemote(
            context: context,
            config: SSHConfigManager.shared.config
        )
    }

    func pushAllNotes() async throws {
        let context = try mainContext()
        _ = try await SSHSyncManager.shared.syncAllNotesToRemote(
            context: context,
            config: SSHConfigManager.shared.config
        )
    }

    private func mainContext() throws -> ModelContext {
        guard let context = PersistenceController.shared.modelContainer?.mainContext else {
            throw NSError(
                domain: "AutoSync",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "数据容器未配置"]
            )
        }
        return context
    }
}
