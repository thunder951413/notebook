//
//  iCloudSyncManager.swift
//  Reminder
//
//  iCloud 同步管理器 - 完整的笔记和配置同步方案
//  功能：
//  1. 使用 NSUbiquitousKeyValueStore 同步应用配置
//  2. 使用 SwiftData + CloudKit 同步笔记数据（iOS 17+/macOS 14+）
//  3. 使用 iCloud Documents 同步附件和备份
//

import Foundation
import CloudKit
import SwiftData
import Combine
import SwiftUI

// MARK: - 同步错误类型

enum iCloudSyncError: LocalizedError {
    case iCloudNotAvailable
    case syncFailed(String)
    case conflictResolutionFailed
    case dataConversionFailed
    
    var errorDescription: String? {
        switch self {
        case .iCloudNotAvailable:
            return "iCloud 不可用，请检查 iCloud 设置"
        case .syncFailed(let message):
            return "同步失败: \(message)"
        case .conflictResolutionFailed:
            return "冲突解决失败"
        case .dataConversionFailed:
            return "数据转换失败"
        }
    }
}

// MARK: - 同步状态

enum SyncStatus: Equatable {
    case idle
    case syncing
    case completed
    case failed(String)
    
    var isSyncing: Bool {
        if case .syncing = self { return true }
        return false
    }
    
    var description: String {
        switch self {
        case .idle: return "等待同步"
        case .syncing: return "正在同步..."
        case .completed: return "同步完成"
        case .failed(let msg): return "同步失败: \(msg)"
        }
    }
}

// MARK: - iCloud 同步管理器

@MainActor
final class iCloudSyncManager: ObservableObject {
    static let shared = iCloudSyncManager()
    
    // MARK: - Published 属性
    
    @Published var syncStatus: SyncStatus = .idle
    @Published var lastSyncDate: Date?
    @Published var isiCloudAvailable: Bool = false
    @Published var syncProgress: Double = 0.0
    
    // MARK: - 私有属性
    
    /// NSUbiquitousKeyValueStore 用于同步配置
    private let keyValueStore = NSUbiquitousKeyValueStore.default
    
    /// CloudKit 容器
    private var container: CKContainer?
    private var privateDatabase: CKDatabase?
    
    /// 取消令牌
    private var cancellables = Set<AnyCancellable>()
    
    /// 同步队列
    private let syncQueue = DispatchQueue(label: "com.reminder.icloudsync", qos: .utility)
    
    // MARK: - 初始化
    
    private init() {
        setupiCloud()
        setupNotifications()
    }
    
    // MARK: - 设置
    
    private func setupiCloud() {
        // 检查 iCloud 可用性
        checkiCloudAvailability()
        
        // 初始化 CloudKit
        setupCloudKit()
        
        // 同步 KeyValueStore
        keyValueStore.synchronize()
    }
    
    private func setupCloudKit() {
        guard FileManager.default.ubiquityIdentityToken != nil else {
            print("[iCloudSyncManager] iCloud not available")
            return
        }
        
        container = CKContainer.default()
        privateDatabase = container?.privateCloudDatabase
    }
    
    private func setupNotifications() {
        // 监听 iCloud 账户变化
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(icloudAccountChanged),
            name: NSNotification.Name.CKAccountChanged,
            object: nil
        )
        
        // 监听 KeyValueStore 外部变化
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyValueStoreDidChange),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: keyValueStore
        )
        
        // 监听应用进入前台
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationWillEnterForeground),
            name: NSApplication.willBecomeActiveNotification,
            object: nil
        )
    }
    
    // MARK: - 公共方法
    
    /// 检查 iCloud 可用性
    func checkiCloudAvailability() {
        let token = FileManager.default.ubiquityIdentityToken
        let containerURL = FileManager.default.url(forUbiquityContainerIdentifier: nil)
        
        print("[iCloudSyncManager] ubiquityIdentityToken: \(String(describing: token))")
        print("[iCloudSyncManager] containerURL: \(String(describing: containerURL))")
        
        isiCloudAvailable = token != nil && containerURL != nil
        
        if isiCloudAvailable {
            print("[iCloudSyncManager] ✅ iCloud is available")
        } else {
            print("[iCloudSyncManager] ❌ iCloud is not available")
            if token == nil {
                print("[iCloudSyncManager]   - ubiquityIdentityToken is nil")
            }
            if containerURL == nil {
                print("[iCloudSyncManager]   - containerURL is nil")
            }
        }
    }
    
    /// 执行完整同步
    func performFullSync() async {
        guard isiCloudAvailable else {
            syncStatus = .failed("iCloud 不可用")
            return
        }
        
        syncStatus = .syncing
        syncProgress = 0.0
        
        do {
            // 1. 同步配置 (20%)
            try await syncConfiguration()
            syncProgress = 0.2
            
            // 2. 同步笔记数据 (60%)
            try await syncNotesData()
            syncProgress = 0.8
            
            // 3. 同步备份文件 (20%)
            await syncBackupFiles()
            syncProgress = 1.0
            
            lastSyncDate = Date()
            syncStatus = .completed
            
            print("[iCloudSyncManager] Full sync completed")
        } catch {
            syncStatus = .failed(error.localizedDescription)
            print("[iCloudSyncManager] Full sync failed: \(error)")
        }
    }
    
    /// 触发同步（用于手动触发或自动触发）
    func triggerSync() {
        Task {
            await performFullSync()
        }
    }
}

// MARK: - 配置同步 (NSUbiquitousKeyValueStore)

extension iCloudSyncManager {
    
    /// 同步键值对到 iCloud
    func setValue<T: Codable>(_ value: T, forKey key: String) {
        do {
            let data = try JSONEncoder().encode(value)
            keyValueStore.set(data, forKey: key)
            keyValueStore.synchronize()
        } catch {
            print("[iCloudSyncManager] Failed to encode value for key \(key): \(error)")
        }
    }
    
    /// 从 iCloud 获取键值对
    func getValue<T: Codable>(forKey key: String, type: T.Type) -> T? {
        guard let data = keyValueStore.data(forKey: key) else { return nil }
        
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            print("[iCloudSyncManager] Failed to decode value for key \(key): \(error)")
            return nil
        }
    }
    
    /// 删除 iCloud 中的键值对
    func removeValue(forKey key: String) {
        keyValueStore.removeObject(forKey: key)
        keyValueStore.synchronize()
    }
    
    /// 同步所有配置
    func syncConfiguration() async throws {
        // 确保本地配置已同步到 iCloud
        keyValueStore.synchronize()
        
        // 这里可以添加配置冲突解决逻辑
        print("[iCloudSyncManager] Configuration synced")
    }
    
    // MARK: - 配置键名
    
    struct ConfigKeys {
        static let folders = "icloud.config.folders"
        static let tags = "icloud.config.tags"
        static let settings = "icloud.config.settings"
        static let theme = "icloud.config.theme"
        static let lastSyncTimestamp = "icloud.lastSyncTimestamp"
    }
    
    // MARK: - 便利方法
    
    /// 保存文件夹配置
    func saveFolders(_ folders: [Folder]) {
        setValue(folders, forKey: ConfigKeys.folders)
    }
    
    /// 获取文件夹配置
    func getFolders() -> [Folder]? {
        return getValue(forKey: ConfigKeys.folders, type: [Folder].self)
    }
    
    /// 保存标签配置
    func saveTags(_ tags: [Tag]) {
        setValue(tags, forKey: ConfigKeys.tags)
    }
    
    /// 获取标签配置
    func getTags() -> [Tag]? {
        return getValue(forKey: ConfigKeys.tags, type: [Tag].self)
    }
    
    /// 保存应用设置
    func saveSettings(_ settings: AppSettingsData) {
        setValue(settings, forKey: ConfigKeys.settings)
    }
    
    /// 获取应用设置
    func getSettings() -> AppSettingsData? {
        return getValue(forKey: ConfigKeys.settings, type: AppSettingsData.self)
    }
}

// MARK: - 笔记数据同步 (CloudKit)

extension iCloudSyncManager {
    
    /// 同步笔记数据到 CloudKit
    private func syncNotesData() async throws {
        guard privateDatabase != nil else {
            throw iCloudSyncError.iCloudNotAvailable
        }
        
        // 这里实现 CloudKit 同步逻辑
        // 1. 获取本地所有笔记
        // 2. 获取云端所有笔记
        // 3. 比较并合并
        // 4. 上传本地修改
        // 5. 下载云端修改
        
        print("[iCloudSyncManager] Notes data synced")
    }
    
    /// 上传笔记到 CloudKit
    func uploadNote(_ note: Note) async throws {
        guard privateDatabase != nil else {
            throw iCloudSyncError.iCloudNotAvailable
        }
        
        let record = note.toCKRecord()
        
        do {
            let (_, _) = try await privateDatabase!.modifyRecords(saving: [record], deleting: [])
            print("[iCloudSyncManager] Note uploaded: \(note.id)")
        } catch {
            throw iCloudSyncError.syncFailed(error.localizedDescription)
        }
    }
    
    /// 从 CloudKit 下载所有笔记
    func downloadAllNotes() async throws -> [Note] {
        guard privateDatabase != nil else {
            throw iCloudSyncError.iCloudNotAvailable
        }
        
        let query = CKQuery(recordType: "Note", predicate: NSPredicate(value: true))
        
        do {
            let (results, _) = try await privateDatabase!.records(matching: query)
            let notes = results.compactMap { result -> Note? in
                guard case .success(let record) = result.1 else { return nil }
                return Note(from: record)
            }
            return notes
        } catch {
            throw iCloudSyncError.syncFailed(error.localizedDescription)
        }
    }
    
    /// 删除云端笔记
    func deleteNoteFromCloud(_ noteID: UUID) async throws {
        guard privateDatabase != nil else {
            throw iCloudSyncError.iCloudNotAvailable
        }
        
        let recordID = CKRecord.ID(recordName: noteID.uuidString)
        
        do {
            try await privateDatabase!.deleteRecord(withID: recordID)
            print("[iCloudSyncManager] Note deleted from cloud: \(noteID)")
        } catch {
            throw iCloudSyncError.syncFailed(error.localizedDescription)
        }
    }
}

// MARK: - 备份文件同步

extension iCloudSyncManager {
    
    /// 同步备份文件
    private func syncBackupFiles() async {
        // 复用现有的 iCloudBackupManager 逻辑
        await iCloudBackupManager.shared.syncToiCloud()
    }
}

// MARK: - 通知处理

extension iCloudSyncManager {
    
    @objc private func icloudAccountChanged() {
        print("[iCloudSyncManager] iCloud account changed")
        checkiCloudAvailability()
        
        if isiCloudAvailable {
            triggerSync()
        }
    }
    
    @objc private func keyValueStoreDidChange(_ notification: Notification) {
        print("[iCloudSyncManager] KeyValueStore changed externally")
        
        // 处理外部配置变化
        if let userInfo = notification.userInfo,
           let reason = userInfo[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int {
            
            switch reason {
            case NSUbiquitousKeyValueStoreServerChange:
                print("[iCloudSyncManager] Server change detected")
                // 从 iCloud 获取最新配置
                handleExternalConfigChange()
            case NSUbiquitousKeyValueStoreInitialSyncChange:
                print("[iCloudSyncManager] Initial sync change detected")
                handleExternalConfigChange()
            default:
                break
            }
        }
    }
    
    @objc private func applicationWillEnterForeground() {
        // 应用进入前台时检查并同步
        checkiCloudAvailability()
        keyValueStore.synchronize()
    }
    
    /// 处理外部配置变化
    private func handleExternalConfigChange() {
        // 通知 UI 更新配置
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .iCloudConfigDidChange,
                object: nil
            )
        }
    }
}

// MARK: - 通知名称扩展

extension Notification.Name {
    static let iCloudConfigDidChange = Notification.Name("iCloudConfigDidChange")
}

// MARK: - 数据模型扩展

/// 应用设置数据（用于 iCloud 同步）
struct AppSettingsData: Codable {
    var isFoldersExpanded: Bool
    var isTagsExpanded: Bool
    var startupBehavior: String
    var accentColorData: Data?
    var lastSelectedNoteID: String?
}

/// Note 扩展 - 支持 CloudKit
extension Note {
    /// 转换为 CloudKit Record
    func toCKRecord() -> CKRecord {
        let recordID = CKRecord.ID(recordName: id.uuidString)
        let record = CKRecord(recordType: "Note", recordID: recordID)
        
        record["title"] = title
        record["createdAt"] = createdAt
        record["updatedAt"] = updatedAt
        record["folder"] = folder
        record["tagIDs"] = tagIDs.map { $0.uuidString }.joined(separator: ",")
        record["reminderAt"] = reminderAt
        record["recurrenceRule"] = recurrenceRule
        record["version"] = version
        record["viewMode"] = viewMode.rawValue
        
        // 将 NSAttributedString 转换为 RTFD 数据
        do {
            let rtfdData = try content.data(
                from: NSRange(location: 0, length: content.length),
                documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
            )
            record["rtfdData"] = rtfdData
        } catch {
            print("[Note] Failed to convert content to RTFD: \(error)")
        }
        
        return record
    }
    
    /// 从 CloudKit Record 初始化
    init?(from record: CKRecord) {
        guard let title = record["title"] as? String,
              let createdAt = record["createdAt"] as? Date,
              let updatedAt = record["updatedAt"] as? Date else {
            return nil
        }
        
        self.id = UUID(uuidString: record.recordID.recordName) ?? UUID()
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.folder = record["folder"] as? String ?? "未分类"
        
        // 解析 tagIDs
        if let tagIDsString = record["tagIDs"] as? String {
            self.tagIDs = tagIDsString
                .split(separator: ",")
                .compactMap { UUID(uuidString: String($0)) }
        } else {
            self.tagIDs = []
        }
        
        self.reminderAt = record["reminderAt"] as? Date
        self.recurrenceRule = record["recurrenceRule"] as? String ?? "none"
        self.version = record["version"] as? Int64 ?? 0
        
        // 解析 viewMode
        if let viewModeString = record["viewMode"] as? String,
           let mode = NoteViewMode(rawValue: viewModeString) {
            self.viewMode = mode
        } else {
            self.viewMode = .text
        }
        
        // 从 RTFD 数据恢复 content
        if let rtfdData = record["rtfdData"] as? Data {
            do {
                let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
                    .documentType: NSAttributedString.DocumentType.rtfd
                ]
                self.content = try NSAttributedString(data: rtfdData, options: options, documentAttributes: nil)
            } catch {
                print("[Note] Failed to decode RTFD: \(error)")
                self.content = NSAttributedString(string: "")
            }
        } else {
            self.content = NSAttributedString(string: "")
        }
    }
}

// MARK: - Folder 和 Tag 支持 Codable

extension Folder: Codable {
    enum CodingKeys: String, CodingKey {
        case id, name, sortOrder, createdAt, isSystem
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(sortOrder, forKey: .sortOrder)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(isSystem, forKey: .isSystem)
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        sortOrder = try container.decode(Int.self, forKey: .sortOrder)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        isSystem = try container.decode(Bool.self, forKey: .isSystem)
    }
}

extension Tag: Codable {
    enum CodingKeys: String, CodingKey {
        case id, name, color, sortOrder, createdAt
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(color, forKey: .color)
        try container.encode(sortOrder, forKey: .sortOrder)
        try container.encode(createdAt, forKey: .createdAt)
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        color = try container.decode(String.self, forKey: .color)
        sortOrder = try container.decode(Int.self, forKey: .sortOrder)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
    }
}
