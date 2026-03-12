import Foundation
import SwiftData
import Combine
import AppKit

/// 备份位置类型
enum BackupLocation: String, Codable, CaseIterable {
    case local = "本地"
    case remote = "SSH服务器"
}

/// 自动备份管理器 - 每天首次启动时自动备份，支持本地和SSH同步
@MainActor
final class AutoBackupManager: ObservableObject {
    static let shared = AutoBackupManager()

    private let defaults = UserDefaults.standard
    private var cancellables = Set<AnyCancellable>()

    // MARK: - 设置键
    private enum Keys {
        static let lastBackupDate = "auto_backup_last_date"
        static let maxBackupCount = "auto_backup_max_count"
        static let isAutoBackupEnabled = "auto_backup_enabled"
        static let enableSSHBackup = "auto_backup_ssh_enabled"
    }

    // MARK: - 发布属性
    @Published var isAutoBackupEnabled: Bool {
        didSet {
            defaults.set(isAutoBackupEnabled, forKey: Keys.isAutoBackupEnabled)
        }
    }

    @Published var enableSSHBackup: Bool {
        didSet {
            defaults.set(enableSSHBackup, forKey: Keys.enableSSHBackup)
        }
    }

    @Published var maxBackupCount: Int {
        didSet {
            defaults.set(maxBackupCount, forKey: Keys.maxBackupCount)
        }
    }

    @Published private(set) var localBackupRecords: [BackupRecord] = []
    @Published private(set) var remoteBackupRecords: [BackupRecord] = []
    @Published private(set) var isBackingUp = false
    @Published private(set) var backupProgress: String = ""

    // MARK: - 备份记录结构
    struct BackupRecord: Identifiable, Codable, Comparable {
        let id: UUID
        let date: Date
        let fileName: String
        let fileSize: Int64
        let location: BackupLocation

        var formattedDate: String {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }

        var formattedSize: String {
            let formatter = ByteCountFormatter()
            formatter.countStyle = .file
            return formatter.string(fromByteCount: fileSize)
        }

        static func < (lhs: BackupRecord, rhs: BackupRecord) -> Bool {
            lhs.date > rhs.date // 最新的排在前面
        }
    }

    // MARK: - 所有备份记录（本地+远程合并）
    var allBackupRecords: [BackupRecord] {
        let all = localBackupRecords + remoteBackupRecords
        return all.sorted()
    }

    // MARK: - 初始化
    private init() {
        self.isAutoBackupEnabled = defaults.object(forKey: Keys.isAutoBackupEnabled) as? Bool ?? true
        self.enableSSHBackup = defaults.object(forKey: Keys.enableSSHBackup) as? Bool ?? false
        self.maxBackupCount = defaults.object(forKey: Keys.maxBackupCount) as? Int ?? 10
        loadBackupRecords()
    }

    // MARK: - 历史备份目录
    func historyDirectoryURL() throws -> URL {
        let baseURL = try StorageLocationManager.shared.notebookDataDirectoryURL()
        return baseURL.appendingPathComponent("history", isDirectory: true)
    }

    // MARK: - 检查是否需要备份
    func shouldPerformAutoBackup() -> Bool {
        guard isAutoBackupEnabled else { return false }

        let lastBackup = defaults.object(forKey: Keys.lastBackupDate) as? Date
        let calendar = Calendar.current

        if let lastDate = lastBackup {
            // 检查是否是同一天
            return !calendar.isDateInToday(lastDate)
        }

        // 从未备份过
        return true
    }

    // MARK: - 执行自动备份
    func performAutoBackup(context: ModelContext) async {
        guard shouldPerformAutoBackup() else { return }

        isBackingUp = true
        backupProgress = "正在备份..."
        defer {
            isBackingUp = false
            backupProgress = ""
        }

        do {
            // 确保历史目录存在
            let historyDir = try historyDirectoryURL()
            try FileManager.default.createDirectory(at: historyDir, withIntermediateDirectories: true)

            // 清理旧备份（如果超过限制）
            try await cleanupOldBackups()

            // 执行备份
            let backupURL = try await DataExportManager.shared.exportAllData(context: context)

            // 生成备份文件名
            let dateFormatter = DateFormatter()
            dateFormatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
            let fileName = "AutoBackup_\(dateFormatter.string(from: Date())).zip"
            let destinationURL = historyDir.appendingPathComponent(fileName)

            // 移动备份文件到历史目录
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.moveItem(at: backupURL, to: destinationURL)

            // 获取文件大小
            let attributes = try FileManager.default.attributesOfItem(atPath: destinationURL.path)
            let fileSize = attributes[.size] as? Int64 ?? 0

            // 更新本地记录
            let record = BackupRecord(
                id: UUID(),
                date: Date(),
                fileName: fileName,
                fileSize: fileSize,
                location: .local
            )
            localBackupRecords.append(record)
            localBackupRecords.sort()
            saveLocalBackupRecords()

            print("[AutoBackupManager] 本地备份完成: \(fileName)")

            // 如果启用了SSH备份，同步到远程
            if enableSSHBackup && SSHConfigManager.shared.isConfigured {
                backupProgress = "正在同步到SSH服务器..."
                do {
                    try await syncBackupToSSH(fileName: fileName, localURL: destinationURL)

                    // 添加远程记录
                    let remoteRecord = BackupRecord(
                        id: UUID(),
                        date: Date(),
                        fileName: fileName,
                        fileSize: fileSize,
                        location: .remote
                    )
                    remoteBackupRecords.append(remoteRecord)
                    remoteBackupRecords.sort()
                    saveRemoteBackupRecords()

                    print("[AutoBackupManager] SSH备份完成: \(fileName)")
                } catch {
                    print("[AutoBackupManager] SSH备份失败: \(error)")
                    // SSH失败不影响本地备份
                }
            }

            // 更新最后备份日期
            defaults.set(Date(), forKey: Keys.lastBackupDate)

            backupProgress = "备份完成"

        } catch {
            print("[AutoBackupManager] 自动备份失败: \(error)")
            backupProgress = "备份失败: \(error.localizedDescription)"
        }
    }

    // MARK: - 同步备份到SSH
    private func syncBackupToSSH(fileName: String, localURL: URL) async throws {
        let config = SSHConfigManager.shared.config

        // 确保远程备份目录存在
        let remoteBackupPath = "\(config.repositoryPath)/backups"
        try await ensureRemoteDirectory(path: remoteBackupPath, config: config)

        // 上传备份文件
        let sshpassPath = try findSshpassPath()

        let scpTask = Process()
        scpTask.executableURL = URL(fileURLWithPath: sshpassPath)
        scpTask.arguments = [
            "-p", config.password,
            "scp",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-P", String(config.port),
            localURL.path,
            "\(config.username)@\(config.host):\(remoteBackupPath)/\(fileName)"
        ]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        scpTask.environment = env

        let pipe = Pipe()
        scpTask.standardOutput = pipe
        scpTask.standardError = pipe

        try scpTask.run()
        scpTask.waitUntilExit()

        if scpTask.terminationStatus != 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let errorMsg = String(data: data, encoding: .utf8) ?? "上传失败"
            throw NSError(domain: "SSHSync", code: Int(scpTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMsg])
        }
    }

    // MARK: - 确保远程目录存在
    private func ensureRemoteDirectory(path: String, config: SSHConfig) async throws {
        let sshpassPath = try findSshpassPath()

        let task = Process()
        task.executableURL = URL(fileURLWithPath: sshpassPath)
        task.arguments = [
            "-p", config.password,
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-p", String(config.port),
            "\(config.username)@\(config.host)",
            "mkdir -p '\(path)'"
        ]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        try task.run()
        task.waitUntilExit()
    }

    // MARK: - 查找 sshpass
    private func findSshpassPath() throws -> String {
        let possiblePaths = [
            "/usr/local/bin/sshpass",
            "/opt/homebrew/bin/sshpass",
            "/usr/bin/sshpass"
        ]

        for path in possiblePaths {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }

        throw NSError(domain: "SSHSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "未找到 sshpass"])
    }

    // MARK: - 清理旧备份
    private func cleanupOldBackups() async throws {
        // 重新加载备份记录
        loadBackupRecordsFromDisk()

        // 清理本地旧备份
        let historyDir = try historyDirectoryURL()
        while localBackupRecords.count >= maxBackupCount {
            let oldestRecord = localBackupRecords.removeLast()
            let fileURL = historyDir.appendingPathComponent(oldestRecord.fileName)

            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
                print("[AutoBackupManager] 删除本地旧备份: \(oldestRecord.fileName)")
            }
        }
        saveLocalBackupRecords()

        // 如果启用了SSH，清理远程旧备份
        if enableSSHBackup && SSHConfigManager.shared.isConfigured {
            try await cleanupRemoteOldBackups()
        }
    }

    // MARK: - 清理远程旧备份
    private func cleanupRemoteOldBackups() async throws {
        guard remoteBackupRecords.count >= maxBackupCount else { return }

        let config = SSHConfigManager.shared.config
        let sshpassPath = try findSshpassPath()
        let remoteBackupPath = "\(config.repositoryPath)/backups"

        while remoteBackupRecords.count >= maxBackupCount {
            let oldestRecord = remoteBackupRecords.removeLast()

            let task = Process()
            task.executableURL = URL(fileURLWithPath: sshpassPath)
            task.arguments = [
                "-p", config.password,
                "ssh",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "PreferredAuthentications=keyboard-interactive,password",
                "-o", "PubkeyAuthentication=no",
                "-p", String(config.port),
                "\(config.username)@\(config.host)",
                "rm -f '\(remoteBackupPath)/\(oldestRecord.fileName)'"
            ]

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            task.environment = env

            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = pipe

            try? task.run()
            task.waitUntilExit()

            print("[AutoBackupManager] 删除远程旧备份: \(oldestRecord.fileName)")
        }
        saveRemoteBackupRecords()
    }

    // MARK: - 手动删除备份
    func deleteBackup(record: BackupRecord) async throws {
        switch record.location {
        case .local:
            let historyDir = try historyDirectoryURL()
            let fileURL = historyDir.appendingPathComponent(record.fileName)

            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }

            localBackupRecords.removeAll { $0.id == record.id }
            saveLocalBackupRecords()

        case .remote:
            guard SSHConfigManager.shared.isConfigured else {
                throw NSError(domain: "AutoBackupManager", code: 2, userInfo: [NSLocalizedDescriptionKey: "SSH未配置"])
            }

            let config = SSHConfigManager.shared.config
            let sshpassPath = try findSshpassPath()
            let remoteBackupPath = "\(config.repositoryPath)/backups"

            let task = Process()
            task.executableURL = URL(fileURLWithPath: sshpassPath)
            task.arguments = [
                "-p", config.password,
                "ssh",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "PreferredAuthentications=keyboard-interactive,password",
                "-o", "PubkeyAuthentication=no",
                "-p", String(config.port),
                "\(config.username)@\(config.host)",
                "rm -f '\(remoteBackupPath)/\(record.fileName)'"
            ]

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            task.environment = env

            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = pipe

            try task.run()
            task.waitUntilExit()

            if task.terminationStatus != 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let errorMsg = String(data: data, encoding: .utf8) ?? "删除失败"
                throw NSError(domain: "SSHSync", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMsg])
            }

            remoteBackupRecords.removeAll { $0.id == record.id }
            saveRemoteBackupRecords()
        }
    }

    // MARK: - 恢复备份
    func restoreBackup(record: BackupRecord) async throws -> URL {
        switch record.location {
        case .local:
            let historyDir = try historyDirectoryURL()
            let fileURL = historyDir.appendingPathComponent(record.fileName)

            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                throw NSError(domain: "AutoBackupManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "备份文件不存在"])
            }

            return fileURL

        case .remote:
            guard SSHConfigManager.shared.isConfigured else {
                throw NSError(domain: "AutoBackupManager", code: 2, userInfo: [NSLocalizedDescriptionKey: "SSH未配置"])
            }

            let config = SSHConfigManager.shared.config
            let sshpassPath = try findSshpassPath()
            let remoteBackupPath = "\(config.repositoryPath)/backups"

            let tempDir = FileManager.default.temporaryDirectory
            let localURL = tempDir.appendingPathComponent(record.fileName)

            // 下载文件
            let scpTask = Process()
            scpTask.executableURL = URL(fileURLWithPath: sshpassPath)
            scpTask.arguments = [
                "-p", config.password,
                "scp",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "PreferredAuthentications=keyboard-interactive,password",
                "-o", "PubkeyAuthentication=no",
                "-P", String(config.port),
                "\(config.username)@\(config.host):\(remoteBackupPath)/\(record.fileName)",
                localURL.path
            ]

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            scpTask.environment = env

            let pipe = Pipe()
            scpTask.standardOutput = pipe
            scpTask.standardError = pipe

            try scpTask.run()
            scpTask.waitUntilExit()

            if scpTask.terminationStatus != 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let errorMsg = String(data: data, encoding: .utf8) ?? "下载失败"
                throw NSError(domain: "SSHSync", code: Int(scpTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMsg])
            }

            return localURL
        }
    }

    // MARK: - 刷新远程备份列表
    func refreshRemoteBackupList() async throws {
        guard SSHConfigManager.shared.isConfigured else { return }

        let config = SSHConfigManager.shared.config
        let sshpassPath = try findSshpassPath()
        let remoteBackupPath = "\(config.repositoryPath)/backups"

        // 获取远程文件列表
        let task = Process()
        task.executableURL = URL(fileURLWithPath: sshpassPath)
        task.arguments = [
            "-p", config.password,
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-p", String(config.port),
            "\(config.username)@\(config.host)",
            "ls -la '\(remoteBackupPath)/' 2>/dev/null | grep '\\.zip$' || echo ''"
        ]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        try task.run()
        task.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""

        var records: [BackupRecord] = []

        // 解析 ls 输出
        let lines = output.components(separatedBy: .newlines)
        for line in lines {
            let components = line.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
            if components.count >= 9, components.last?.hasSuffix(".zip") == true {
                let fileName = components.last!

                // 解析日期和时间
                let dateComponents = Array(components[5..<8])
                let dateString = dateComponents.joined(separator: " ")

                let formatter = DateFormatter()
                formatter.dateFormat = "MMM d HH:mm" // 或者 "MMM d yyyy" 取决于 ls 输出
                let date = formatter.date(from: dateString) ?? Date()

                // 获取文件大小
                let sizeString = components[4]
                let fileSize = Int64(sizeString) ?? 0

                let record = BackupRecord(
                    id: UUID(),
                    date: date,
                    fileName: fileName,
                    fileSize: fileSize,
                    location: .remote
                )
                records.append(record)
            }
        }

        remoteBackupRecords = records.sorted()
        saveRemoteBackupRecords()
    }

    // MARK: - 打开备份所在文件夹
    func revealBackupInFinder(record: BackupRecord) throws {
        guard record.location == .local else { return }

        let historyDir = try historyDirectoryURL()
        let fileURL = historyDir.appendingPathComponent(record.fileName)

        if FileManager.default.fileExists(atPath: fileURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([fileURL])
        }
    }

    // MARK: - 持久化备份记录
    private func saveLocalBackupRecords() {
        if let encoded = try? JSONEncoder().encode(localBackupRecords) {
            defaults.set(encoded, forKey: "auto_backup_records_local")
        }
    }

    private func saveRemoteBackupRecords() {
        if let encoded = try? JSONEncoder().encode(remoteBackupRecords) {
            defaults.set(encoded, forKey: "auto_backup_records_remote")
        }
    }

    private func loadBackupRecords() {
        loadBackupRecordsFromDisk()
    }

    private func loadBackupRecordsFromDisk() {
        // 加载本地记录
        if let data = defaults.data(forKey: "auto_backup_records_local"),
           let records = try? JSONDecoder().decode([BackupRecord].self, from: data) {
            localBackupRecords = records.sorted()
        } else {
            scanLocalBackupFilesFromDisk()
        }

        // 加载远程记录
        if let data = defaults.data(forKey: "auto_backup_records_remote"),
           let records = try? JSONDecoder().decode([BackupRecord].self, from: data) {
            remoteBackupRecords = records.sorted()
        }
    }

    private func scanLocalBackupFilesFromDisk() {
        do {
            let historyDir = try historyDirectoryURL()
            let contents = try FileManager.default.contentsOfDirectory(at: historyDir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey])

            var records: [BackupRecord] = []

            for url in contents where url.pathExtension == "zip" {
                let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                let modificationDate = attributes[.modificationDate] as? Date ?? Date()
                let fileSize = attributes[.size] as? Int64 ?? 0

                let record = BackupRecord(
                    id: UUID(),
                    date: modificationDate,
                    fileName: url.lastPathComponent,
                    fileSize: fileSize,
                    location: .local
                )
                records.append(record)
            }

            localBackupRecords = records.sorted()
            saveLocalBackupRecords()

        } catch {
            print("[AutoBackupManager] 扫描本地备份文件失败: \(error)")
            localBackupRecords = []
        }
    }

    // MARK: - 刷新备份记录
    func refreshBackupRecords() {
        scanLocalBackupFilesFromDisk()
        // 远程记录在需要时单独刷新
    }

    // MARK: - 双向同步功能

    /// 同步所有本地备份到 SSH（上传缺失的文件）
    func syncAllLocalToRemote(progressHandler: ((String) -> Void)? = nil) async throws -> (uploaded: Int, skipped: Int) {
        guard SSHConfigManager.shared.isConfigured else {
            throw NSError(domain: "AutoBackupManager", code: 3, userInfo: [NSLocalizedDescriptionKey: "SSH未配置"])
        }

        progressHandler?("正在获取远程备份列表...")

        // 先刷新远程列表
        try await refreshRemoteBackupList()

        let config = SSHConfigManager.shared.config
        let sshpassPath = try findSshpassPath()
        let remoteBackupPath = "\(config.repositoryPath)/backups"

        // 确保远程目录存在
        try await ensureRemoteDirectory(path: remoteBackupPath, config: config)

        var uploadedCount = 0
        var skippedCount = 0

        let historyDir = try historyDirectoryURL()

        for localRecord in localBackupRecords {
            // 检查远程是否已存在
            let existsOnRemote = remoteBackupRecords.contains { $0.fileName == localRecord.fileName }

            if existsOnRemote {
                skippedCount += 1
                progressHandler?("跳过已存在的文件: \(localRecord.fileName)")
                continue
            }

            let localURL = historyDir.appendingPathComponent(localRecord.fileName)

            guard FileManager.default.fileExists(atPath: localURL.path) else {
                skippedCount += 1
                continue
            }

            progressHandler?("正在上传: \(localRecord.fileName)")

            // 上传文件
            let scpTask = Process()
            scpTask.executableURL = URL(fileURLWithPath: sshpassPath)
            scpTask.arguments = [
                "-p", config.password,
                "scp",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "PreferredAuthentications=keyboard-interactive,password",
                "-o", "PubkeyAuthentication=no",
                "-P", String(config.port),
                localURL.path,
                "\(config.username)@\(config.host):\(remoteBackupPath)/\(localRecord.fileName)"
            ]

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            scpTask.environment = env

            let pipe = Pipe()
            scpTask.standardOutput = pipe
            scpTask.standardError = pipe

            try scpTask.run()
            scpTask.waitUntilExit()

            if scpTask.terminationStatus == 0 {
                uploadedCount += 1

                // 添加到远程记录
                let remoteRecord = BackupRecord(
                    id: UUID(),
                    date: localRecord.date,
                    fileName: localRecord.fileName,
                    fileSize: localRecord.fileSize,
                    location: .remote
                )
                remoteBackupRecords.append(remoteRecord)
            } else {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let errorMsg = String(data: data, encoding: .utf8) ?? "上传失败"
                print("[AutoBackupManager] 上传失败 \(localRecord.fileName): \(errorMsg)")
            }
        }

        remoteBackupRecords.sort()
        saveRemoteBackupRecords()

        progressHandler?("同步完成: 上传 \(uploadedCount) 个, 跳过 \(skippedCount) 个")

        return (uploaded: uploadedCount, skipped: skippedCount)
    }

    /// 同步所有 SSH 备份到本地（下载缺失的文件）
    func syncAllRemoteToLocal(progressHandler: ((String) -> Void)? = nil) async throws -> (downloaded: Int, skipped: Int) {
        guard SSHConfigManager.shared.isConfigured else {
            throw NSError(domain: "AutoBackupManager", code: 3, userInfo: [NSLocalizedDescriptionKey: "SSH未配置"])
        }

        progressHandler?("正在获取远程备份列表...")

        // 先刷新远程列表
        try await refreshRemoteBackupList()

        let config = SSHConfigManager.shared.config
        let sshpassPath = try findSshpassPath()
        let remoteBackupPath = "\(config.repositoryPath)/backups"

        var downloadedCount = 0
        var skippedCount = 0

        let historyDir = try historyDirectoryURL()

        for remoteRecord in remoteBackupRecords {
            // 检查本地是否已存在
            let existsLocally = localBackupRecords.contains { $0.fileName == remoteRecord.fileName }

            if existsLocally {
                skippedCount += 1
                progressHandler?("跳过已存在的文件: \(remoteRecord.fileName)")
                continue
            }

            let localURL = historyDir.appendingPathComponent(remoteRecord.fileName)

            progressHandler?("正在下载: \(remoteRecord.fileName)")

            // 下载文件
            let scpTask = Process()
            scpTask.executableURL = URL(fileURLWithPath: sshpassPath)
            scpTask.arguments = [
                "-p", config.password,
                "scp",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "PreferredAuthentications=keyboard-interactive,password",
                "-o", "PubkeyAuthentication=no",
                "-P", String(config.port),
                "\(config.username)@\(config.host):\(remoteBackupPath)/\(remoteRecord.fileName)",
                localURL.path
            ]

            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            scpTask.environment = env

            let pipe = Pipe()
            scpTask.standardOutput = pipe
            scpTask.standardError = pipe

            try scpTask.run()
            scpTask.waitUntilExit()

            if scpTask.terminationStatus == 0 {
                downloadedCount += 1

                // 获取文件大小
                let attributes = try? FileManager.default.attributesOfItem(atPath: localURL.path)
                let fileSize = attributes?[.size] as? Int64 ?? remoteRecord.fileSize

                // 添加到本地记录
                let localRecord = BackupRecord(
                    id: UUID(),
                    date: remoteRecord.date,
                    fileName: remoteRecord.fileName,
                    fileSize: fileSize,
                    location: .local
                )
                localBackupRecords.append(localRecord)
            } else {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let errorMsg = String(data: data, encoding: .utf8) ?? "下载失败"
                print("[AutoBackupManager] 下载失败 \(remoteRecord.fileName): \(errorMsg)")
            }
        }

        localBackupRecords.sort()
        saveLocalBackupRecords()

        progressHandler?("同步完成: 下载 \(downloadedCount) 个, 跳过 \(skippedCount) 个")

        return (downloaded: downloadedCount, skipped: skippedCount)
    }
}
