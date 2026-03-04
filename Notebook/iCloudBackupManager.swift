//
//  iCloudBackupManager.swift
//  Notebook
//
//  iCloud 备份管理器 - 将备份同步到 iCloud
//  功能：
//  1. 将本地备份同步到 iCloud
//  2. 从 iCloud 恢复备份
//  3. 多设备同步支持
//

import Foundation
import CloudKit
import Combine
import SwiftUI

/// iCloud 备份管理器
@MainActor
final class iCloudBackupManager {
    static let shared = iCloudBackupManager()

    // iCloud 容器（延迟初始化，避免崩溃）
    private var container: CKContainer?
    private var privateDatabase: CKDatabase?

    // 本地备份目录
    private var localBackupDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("Notebook/Backups", isDirectory: true)
    }

    // iCloud 备份目录（在 iCloud Drive 中）
    private var iCloudBackupDirectory: URL? {
        guard let iCloudURL = FileManager.default.url(forUbiquityContainerIdentifier: nil) else {
            return nil
        }
        return iCloudURL.appendingPathComponent("Documents/NotebookBackups", isDirectory: true)
    }

    // 同步状态
    @Published var isSyncing = false
    @Published var lastSyncDate: Date?
    @Published var syncError: String?

    private init() {
        // 延迟初始化 CloudKit，避免配置错误时崩溃
        setupCloudKit()

        // 监听 iCloud 账户变化
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(icloudAccountChanged),
            name: NSNotification.Name.CKAccountChanged,
            object: nil
        )
    }

    /// 安全地初始化 CloudKit
    private func setupCloudKit() {
        // 检查是否有 iCloud 容器配置
        guard FileManager.default.ubiquityIdentityToken != nil else {
            print("[iCloudBackupManager] iCloud not available (no ubiquityIdentityToken)")
            self.container = nil
            self.privateDatabase = nil
            return
        }

        // 检查是否能获取 iCloud 容器 URL
        guard FileManager.default.url(forUbiquityContainerIdentifier: nil) != nil else {
            print("[iCloudBackupManager] iCloud not available (no container URL)")
            self.container = nil
            self.privateDatabase = nil
            return
        }

        // 尝试获取默认容器
        let ckContainer = CKContainer.default()
        self.container = ckContainer
        self.privateDatabase = ckContainer.privateCloudDatabase
        print("[iCloudBackupManager] CloudKit initialized successfully")
    }

    // MARK: - 公共 API

    /// 检查 iCloud 是否可用
    var isiCloudAvailable: Bool {
        return iCloudBackupDirectory != nil
    }

    /// 同步本地备份到 iCloud
    func syncToiCloud() async {
        guard isiCloudAvailable else {
            syncError = "iCloud 不可用"
            return
        }

        isSyncing = true
        defer { isSyncing = false }

        do {
            // 确保 iCloud 目录存在
            try createiCloudDirectoryIfNeeded()

            // 获取所有本地备份
            let localBackups = try listAllLocalBackups()

            for backupURL in localBackups {
                try await uploadBackupToiCloud(backupURL)
            }

            lastSyncDate = Date()
            syncError = nil
            print("[iCloudBackupManager] Sync to iCloud completed: \(localBackups.count) backups")
        } catch {
            syncError = error.localizedDescription
            print("[iCloudBackupManager] Sync to iCloud failed: \(error)")
        }
    }

    /// 从 iCloud 同步备份到本地
    func syncFromiCloud() async {
        guard isiCloudAvailable else {
            syncError = "iCloud 不可用"
            return
        }

        isSyncing = true
        defer { isSyncing = false }

        do {
            // 下载所有 iCloud 备份
            let iCloudBackups = try await downloadBackupsFromiCloud()

            for backup in iCloudBackups {
                try saveBackupToLocal(backup)
            }

            lastSyncDate = Date()
            syncError = nil
            print("[iCloudBackupManager] Sync from iCloud completed: \(iCloudBackups.count) backups")
        } catch {
            syncError = error.localizedDescription
            print("[iCloudBackupManager] Sync from iCloud failed: \(error)")
        }
    }

    /// 获取 iCloud 中的备份列表
    func listiCloudBackups() async -> [BackupItem] {
        guard isiCloudAvailable else { return [] }

        do {
            let backups = try await downloadBackupsFromiCloud()
            return backups.sorted { $0.timestamp > $1.timestamp }
        } catch {
            print("[iCloudBackupManager] Failed to list iCloud backups: \(error)")
            return []
        }
    }

    /// 删除 iCloud 中的备份
    func deleteiCloudBackup(_ backup: BackupItem) async {
        guard isiCloudAvailable else { return }

        do {
            let fileName = "\(backup.id.uuidString).backup"
            if let iCloudDir = iCloudBackupDirectory {
                let fileURL = iCloudDir.appendingPathComponent(fileName)
                try FileManager.default.removeItem(at: fileURL)
                print("[iCloudBackupManager] Deleted iCloud backup: \(backup.id)")
            }
        } catch {
            print("[iCloudBackupManager] Failed to delete iCloud backup: \(error)")
        }
    }

    // MARK: - 私有方法

    @objc private func icloudAccountChanged() {
        print("[iCloudBackupManager] iCloud account changed")
        Task {
            if isiCloudAvailable {
                await syncToiCloud()
            }
        }
    }

    private func createiCloudDirectoryIfNeeded() throws {
        guard let iCloudDir = iCloudBackupDirectory else { return }

        if !FileManager.default.fileExists(atPath: iCloudDir.path) {
            try FileManager.default.createDirectory(at: iCloudDir, withIntermediateDirectories: true)
        }
    }

    private func listAllLocalBackups() throws -> [URL] {
        guard FileManager.default.fileExists(atPath: localBackupDirectory.path) else {
            return []
        }

        var backupURLs: [URL] = []
        let noteDirectories = try FileManager.default.contentsOfDirectory(at: localBackupDirectory, includingPropertiesForKeys: nil)

        for noteDir in noteDirectories {
            let files = try FileManager.default.contentsOfDirectory(at: noteDir, includingPropertiesForKeys: nil)
            backupURLs.append(contentsOf: files.filter { $0.pathExtension == "backup" })
        }

        return backupURLs
    }

    private func uploadBackupToiCloud(_ backupURL: URL) async throws {
        guard let iCloudDir = iCloudBackupDirectory else { return }

        let fileName = backupURL.lastPathComponent
        let destinationURL = iCloudDir.appendingPathComponent(fileName)

        // 检查文件是否已存在且相同
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            let localAttributes = try FileManager.default.attributesOfItem(atPath: backupURL.path)
            let iCloudAttributes = try FileManager.default.attributesOfItem(atPath: destinationURL.path)

            let localSize = localAttributes[.size] as? Int64 ?? 0
            let iCloudSize = iCloudAttributes[.size] as? Int64 ?? 0

            if localSize == iCloudSize {
                // 文件相同，跳过
                return
            }
        }

        // 复制文件到 iCloud
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }
        try FileManager.default.copyItem(at: backupURL, to: destinationURL)

        print("[iCloudBackupManager] Uploaded backup: \(fileName)")
    }

    private func downloadBackupsFromiCloud() async throws -> [BackupItem] {
        guard let iCloudDir = iCloudBackupDirectory else { return [] }

        guard FileManager.default.fileExists(atPath: iCloudDir.path) else {
            return []
        }

        let files = try FileManager.default.contentsOfDirectory(at: iCloudDir, includingPropertiesForKeys: nil)
        let backupFiles = files.filter { $0.pathExtension == "backup" }

        var backups: [BackupItem] = []
        for fileURL in backupFiles {
            if let data = try? Data(contentsOf: fileURL),
               let backup = try? JSONDecoder().decode(BackupItem.self, from: data) {
                backups.append(backup)
            }
        }

        return backups
    }

    private func saveBackupToLocal(_ backup: BackupItem) throws {
        let noteDirectory = localBackupDirectory.appendingPathComponent(backup.noteID.uuidString)
        try FileManager.default.createDirectory(at: noteDirectory, withIntermediateDirectories: true)

        let fileURL = noteDirectory.appendingPathComponent("\(backup.id.uuidString).backup")
        let data = try JSONEncoder().encode(backup)
        try data.write(to: fileURL)
    }
}
