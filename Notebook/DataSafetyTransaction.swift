import Foundation

/// 将附件目录切换封装为可回滚事务。备份只在数据库事务成功后删除；若应用在
/// 提交期间异常退出，`AttachmentsBackup_*` 仍可用于启动恢复或人工恢复。
final class AttachmentDirectoryTransaction {
    private let fileManager = FileManager.default
    private let stagedDirectory: URL
    private let liveDirectory: URL
    private let backupDirectory: URL
    private var hadLiveDirectory = false
    private var began = false

    init(stagedDirectory: URL, liveDirectory: URL, backupDirectory: URL) {
        self.stagedDirectory = stagedDirectory
        self.liveDirectory = liveDirectory
        self.backupDirectory = backupDirectory
    }

    func begin() throws {
        hadLiveDirectory = fileManager.fileExists(atPath: liveDirectory.path)
        if hadLiveDirectory {
            try fileManager.moveItem(at: liveDirectory, to: backupDirectory)
        }

        do {
            try fileManager.moveItem(at: stagedDirectory, to: liveDirectory)
            began = true
        } catch {
            if hadLiveDirectory, fileManager.fileExists(atPath: backupDirectory.path) {
                try? fileManager.moveItem(at: backupDirectory, to: liveDirectory)
            }
            throw error
        }
    }

    func rollback() {
        guard began else { return }
        if fileManager.fileExists(atPath: liveDirectory.path) {
            try? fileManager.removeItem(at: liveDirectory)
        }
        if hadLiveDirectory, fileManager.fileExists(atPath: backupDirectory.path) {
            try? fileManager.moveItem(at: backupDirectory, to: liveDirectory)
        }
        began = false
    }

    func finalize() {
        guard began else { return }
        if hadLiveDirectory, fileManager.fileExists(atPath: backupDirectory.path) {
            do {
                try fileManager.removeItem(at: backupDirectory)
            } catch {
                DebugLog.storage("附件事务已提交，但旧附件备份清理失败: \(error.localizedDescription)", level: .warn)
            }
        }
        began = false
    }
}
