import Foundation

enum SyncSessionError: LocalizedError {
    case alreadyRunning(String)

    var errorDescription: String? {
        switch self {
        case .alreadyRunning(let name):
            return "已有同步任务正在执行：\(name)"
        }
    }
}

@MainActor
final class SyncSessionCoordinator {
    static let shared = SyncSessionCoordinator()

    private struct ActiveSession {
        let id: UUID
        let name: String
    }

    private var activeSession: ActiveSession?

    private init() {}

    func resetForTesting() {
        activeSession = nil
    }

    func withSession<T>(
        named name: String,
        operation: () async throws -> T
    ) async throws -> T {
        guard activeSession == nil else {
            throw SyncSessionError.alreadyRunning(activeSession!.name)
        }

        let session = ActiveSession(id: UUID(), name: name)
        activeSession = session
        let checkpoint: EditorSyncCheckpoint
        do {
            checkpoint = try NoteSaveManager.shared.prepareForSync()
        } catch {
            activeSession = nil
            throw error
        }

        do {
            let result = try await operation()
            try NoteSaveManager.shared.finishSync(checkpoint: checkpoint)
            if activeSession?.id == session.id { activeSession = nil }
            return result
        } catch {
            // 即使远端操作失败，也要保存网络等待期间产生的新输入。
            do {
                try NoteSaveManager.shared.finishSync(checkpoint: checkpoint)
            } catch {
                Logger.shared.log(.save, .error, "同步失败后的编辑器保存也失败：\(error.localizedDescription)")
            }
            if activeSession?.id == session.id { activeSession = nil }
            throw error
        }
    }
}
