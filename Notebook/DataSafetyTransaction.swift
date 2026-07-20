import Foundation
import CryptoKit
import Darwin

enum AtomicFileCommit {
    static func sha256(of url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func commit(stagedURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destinationURL.path) {
            _ = try fileManager.replaceItemAt(destinationURL, withItemAt: stagedURL)
        } else {
            try fileManager.moveItem(at: stagedURL, to: destinationURL)
        }
    }

    static func copyReplacingAtomically(from sourceURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let stagedURL = destinationURL.deletingLastPathComponent()
            .appendingPathComponent(".notebook-stage-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: stagedURL) }

        try fileManager.copyItem(at: sourceURL, to: stagedURL)
        guard try sha256(of: sourceURL) == sha256(of: stagedURL) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try commit(stagedURL: stagedURL, to: destinationURL)
    }

    /// Writes bytes to a sibling staging file, flushes them to stable storage,
    /// verifies the staged digest, atomically publishes the file, and finally
    /// flushes the containing directory. This is used for the editor draft
    /// journal because it is the only copy of keystrokes that have not reached
    /// SwiftData yet.
    static func writeDurably(_ data: Data, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        let directory = destinationURL.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: directory.path
        )

        let stagedURL = directory.appendingPathComponent(".notebook-stage-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: stagedURL) }

        guard fileManager.createFile(
            atPath: stagedURL.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else {
            throw CocoaError(.fileWriteUnknown)
        }

        let handle = try FileHandle(forWritingTo: stagedURL)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }

        let expected = SHA256.hash(data: data)
        let actual = SHA256.hash(data: try Data(contentsOf: stagedURL, options: .mappedIfSafe))
        guard expected.elementsEqual(actual) else {
            throw CocoaError(.fileWriteUnknown)
        }

        try commit(stagedURL: stagedURL, to: destinationURL)
        try fileManager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: destinationURL.path
        )

        let directoryDescriptor = open(directory.path, O_RDONLY)
        guard directoryDescriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { close(directoryDescriptor) }
        guard fsync(directoryDescriptor) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}

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
