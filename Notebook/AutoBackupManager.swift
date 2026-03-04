import Foundation
import SwiftData
import Combine
import AppKit

/// 自动备份管理器 - 每天首次启动时自动备份
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
    }
    
    // MARK: - 发布属性
    @Published var isAutoBackupEnabled: Bool {
        didSet {
            defaults.set(isAutoBackupEnabled, forKey: Keys.isAutoBackupEnabled)
        }
    }
    
    @Published var maxBackupCount: Int {
        didSet {
            defaults.set(maxBackupCount, forKey: Keys.maxBackupCount)
        }
    }
    
    @Published private(set) var backupRecords: [BackupRecord] = []
    @Published private(set) var isBackingUp = false
    
    // MARK: - 备份记录结构
    struct BackupRecord: Identifiable, Codable, Comparable {
        let id: UUID
        let date: Date
        let fileName: String
        let fileSize: Int64
        
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
    
    // MARK: - 初始化
    private init() {
        self.isAutoBackupEnabled = defaults.object(forKey: Keys.isAutoBackupEnabled) as? Bool ?? true
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
        defer { isBackingUp = false }
        
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
            
            // 更新记录
            let record = BackupRecord(
                id: UUID(),
                date: Date(),
                fileName: fileName,
                fileSize: fileSize
            )
            backupRecords.append(record)
            backupRecords.sort()
            saveBackupRecords()
            
            // 更新最后备份日期
            defaults.set(Date(), forKey: Keys.lastBackupDate)
            
            print("[AutoBackupManager] Auto backup completed: \(fileName)")
            
        } catch {
            print("[AutoBackupManager] Auto backup failed: \(error)")
        }
    }
    
    // MARK: - 清理旧备份
    private func cleanupOldBackups() async throws {
        let historyDir = try historyDirectoryURL()
        
        // 重新加载备份记录（以防文件被手动删除）
        loadBackupRecordsFromDisk()
        
        // 如果超过限制，删除最旧的备份
        while backupRecords.count >= maxBackupCount {
            let oldestRecord = backupRecords.removeLast()
            let fileURL = historyDir.appendingPathComponent(oldestRecord.fileName)
            
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
                print("[AutoBackupManager] Removed old backup: \(oldestRecord.fileName)")
            }
        }
        
        saveBackupRecords()
    }
    
    // MARK: - 手动删除备份
    func deleteBackup(record: BackupRecord) throws {
        let historyDir = try historyDirectoryURL()
        let fileURL = historyDir.appendingPathComponent(record.fileName)
        
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try FileManager.default.removeItem(at: fileURL)
        }
        
        backupRecords.removeAll { $0.id == record.id }
        saveBackupRecords()
    }
    
    // MARK: - 恢复备份
    func restoreBackup(record: BackupRecord) async throws -> URL {
        let historyDir = try historyDirectoryURL()
        let fileURL = historyDir.appendingPathComponent(record.fileName)
        
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw NSError(domain: "AutoBackupManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "备份文件不存在"])
        }
        
        return fileURL
    }
    
    // MARK: - 打开备份所在文件夹
    func revealBackupInFinder(record: BackupRecord) throws {
        let historyDir = try historyDirectoryURL()
        let fileURL = historyDir.appendingPathComponent(record.fileName)
        
        if FileManager.default.fileExists(atPath: fileURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([fileURL])
        }
    }
    
    // MARK: - 持久化备份记录
    private func saveBackupRecords() {
        if let encoded = try? JSONEncoder().encode(backupRecords) {
            defaults.set(encoded, forKey: "auto_backup_records")
        }
    }
    
    private func loadBackupRecords() {
        loadBackupRecordsFromDisk()
    }
    
    private func loadBackupRecordsFromDisk() {
        guard let data = defaults.data(forKey: "auto_backup_records"),
              let records = try? JSONDecoder().decode([BackupRecord].self, from: data) else {
            // 尝试从磁盘扫描备份文件
            scanBackupFilesFromDisk()
            return
        }
        backupRecords = records.sorted()
    }
    
    private func scanBackupFilesFromDisk() {
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
                    fileSize: fileSize
                )
                records.append(record)
            }
            
            backupRecords = records.sorted()
            saveBackupRecords()
            
        } catch {
            print("[AutoBackupManager] Failed to scan backup files: \(error)")
            backupRecords = []
        }
    }
    
    // MARK: - 刷新备份记录
    func refreshBackupRecords() {
        scanBackupFilesFromDisk()
    }
}
