//
//  SwiftDataCloudKitSync.swift
//  Notebook
//
//  SwiftData + CloudKit 自动同步方案
//  适用于 iOS 17+ / macOS 14+
//

import Foundation
import SwiftData
import CloudKit
import Combine

// MARK: - CloudKit 同步管理器 (SwiftData 版本)

@MainActor
final class SwiftDataCloudKitManager: ObservableObject {
    static let shared = SwiftDataCloudKitManager()
    
    @Published var syncStatus: SyncStatus = .idle
    @Published var isCloudKitEnabled: Bool = false
    
    private var cancellables = Set<AnyCancellable>()
    
    private init() {
        checkCloudKitStatus()
    }
    
    /// 检查 CloudKit 状态
    func checkCloudKitStatus() {
        CKContainer.default().accountStatus { [weak self] status, error in
            DispatchQueue.main.async {
                switch status {
                case .available:
                    self?.isCloudKitEnabled = true
                    print("[SwiftDataCloudKitManager] CloudKit is available")
                case .noAccount:
                    self?.isCloudKitEnabled = false
                    print("[SwiftDataCloudKitManager] No iCloud account")
                case .restricted:
                    self?.isCloudKitEnabled = false
                    print("[SwiftDataCloudKitManager] CloudKit is restricted")
                case .couldNotDetermine:
                    self?.isCloudKitEnabled = false
                    print("[SwiftDataCloudKitManager] CloudKit status could not be determined")
                case .temporarilyUnavailable:
                    self?.isCloudKitEnabled = false
                    print("[SwiftDataCloudKitManager] CloudKit is temporarily unavailable")
                @unknown default:
                    self?.isCloudKitEnabled = false
                }
            }
        }
    }
}

// MARK: - ModelContainer 配置扩展

extension PersistenceController {
    
    /// 创建支持 CloudKit 的 ModelConfiguration
    /// 使用 SwiftData 原生的 CloudKit 同步功能
    /// 返回配置，由调用者创建 ModelContainer
    func createCloudKitConfiguration() throws -> ModelConfiguration? {
        let location = StorageLocationManager.shared
        guard location.isConfigured else {
            return nil
        }
        
        try location.ensureDirectoryStructureExists()
        
        guard let base = location.baseDirectoryURL else { return nil }
        
        let storeURL = try location.databaseDirectoryURL().appendingPathComponent("notebook.store")
        
        // 配置 CloudKit 同步
        // 注意：需要在 Capabilities 中启用 CloudKit，并在 CloudKit Dashboard 中创建 Record Types
        let config = ModelConfiguration(
            schema: Schema([NoteEntity.self, FolderEntity.self, TagEntity.self]),
            url: storeURL,
            cloudKitDatabase: .automatic
        )
        
        _ = base.startAccessingSecurityScopedResource()
        base.stopAccessingSecurityScopedResource()
        
        print("[PersistenceController] SwiftData + CloudKit configuration created")
        return config
    }
}

// MARK: - CloudKit Record Types 定义

/// 用于 CloudKit Dashboard 的 Record Type 定义
/// 需要在 CloudKit Dashboard 中手动创建这些 Record Types

/*
 
 Record Type: Note
 - title: String
 - content: String
 - createdAt: Date
 - updatedAt: Date
 - folderName: String
 - tagIDs: String (逗号分隔)
 - reminderAt: Date?
 - recurrenceRule: String?
 - version: Int64
 - rtfdData: Bytes?
 
 Record Type: Folder
 - id: String (UUID)
 - name: String
 - sortOrder: Int64
 - createdAt: Date
 - isSystem: Int64 (0 or 1)
 
 Record Type: Tag
 - id: String (UUID)
 - name: String
 - color: String
 - sortOrder: Int64
 - createdAt: Date
 
 */

// MARK: - CloudKit 操作帮助类

@MainActor
final class CloudKitHelper {
    static let shared = CloudKitHelper()
    
    private let container = CKContainer.default()
    private var privateDatabase: CKDatabase {
        return container.privateCloudDatabase
    }
    
    private init() {}
    
    // MARK: - 笔记操作
    
    /// 保存笔记到 CloudKit
    func saveNote(_ note: NoteEntity) async throws {
        let record = note.toCKRecord()
        let (_, _) = try await privateDatabase.modifyRecords(saving: [record], deleting: [])
    }
    
    /// 从 CloudKit 获取所有笔记
    func fetchAllNotes() async throws -> [CKRecord] {
        let query = CKQuery(recordType: "Note", predicate: NSPredicate(value: true))
        query.sortDescriptors = [NSSortDescriptor(key: "updatedAt", ascending: false)]
        
        let (results, _) = try await privateDatabase.records(matching: query)
        return results.compactMap { result in
            guard case .success(let record) = result.1 else { return nil }
            return record
        }
    }
    
    /// 删除 CloudKit 中的笔记
    func deleteNote(id: UUID) async throws {
        let recordID = CKRecord.ID(recordName: id.uuidString)
        try await privateDatabase.deleteRecord(withID: recordID)
    }
    
    // MARK: - 文件夹操作
    
    /// 保存文件夹到 CloudKit
    func saveFolder(_ folder: FolderEntity) async throws {
        let record = folder.toCKRecord()
        let (_, _) = try await privateDatabase.modifyRecords(saving: [record], deleting: [])
    }
    
    /// 从 CloudKit 获取所有文件夹
    func fetchAllFolders() async throws -> [CKRecord] {
        let query = CKQuery(recordType: "Folder", predicate: NSPredicate(value: true))
        query.sortDescriptors = [NSSortDescriptor(key: "sortOrder", ascending: true)]
        
        let (results, _) = try await privateDatabase.records(matching: query)
        return results.compactMap { result in
            guard case .success(let record) = result.1 else { return nil }
            return record
        }
    }
    
    // MARK: - 标签操作
    
    /// 保存标签到 CloudKit
    func saveTag(_ tag: TagEntity) async throws {
        let record = tag.toCKRecord()
        let (_, _) = try await privateDatabase.modifyRecords(saving: [record], deleting: [])
    }
    
    /// 从 CloudKit 获取所有标签
    func fetchAllTags() async throws -> [CKRecord] {
        let query = CKQuery(recordType: "Tag", predicate: NSPredicate(value: true))
        query.sortDescriptors = [NSSortDescriptor(key: "sortOrder", ascending: true)]
        
        let (results, _) = try await privateDatabase.records(matching: query)
        return results.compactMap { result in
            guard case .success(let record) = result.1 else { return nil }
            return record
        }
    }
    
    // MARK: - 订阅
    
    /// 创建数据库变更订阅
    func createDatabaseSubscription() async throws {
        let subscription = CKDatabaseSubscription(subscriptionID: "database-changes")
        
        let notificationInfo = CKSubscription.NotificationInfo()
        notificationInfo.shouldSendContentAvailable = true
        subscription.notificationInfo = notificationInfo
        
        do {
            let (_, _) = try await privateDatabase.modifySubscriptions(saving: [subscription], deleting: [])
            print("[CloudKitHelper] Database subscription created")
        } catch {
            print("[CloudKitHelper] Failed to create subscription: \(error)")
        }
    }
}

// MARK: - ModelEntity CloudKit 转换扩展

extension NoteEntity {
    /// 转换为 CloudKit Record
    func toCKRecord() -> CKRecord {
        let recordID = CKRecord.ID(recordName: id.uuidString)
        let record = CKRecord(recordType: "Note", recordID: recordID)
        
        record["title"] = title
        record["createdAt"] = createdAt
        record["updatedAt"] = updatedAt
        record["folderName"] = folderName
        record["folderID"] = folderID?.uuidString
        record["tagIDs"] = tagIDs
        record["reminderAt"] = reminderAt
        record["recurrenceRule"] = recurrenceRule
        record["version"] = version
        
        if let rtfdData = rtfdData {
            record["rtfdData"] = rtfdData
        }
        
        return record
    }
    
    /// 从 CloudKit Record 更新
    func update(from record: CKRecord) {
        title = record["title"] as? String ?? title
        createdAt = record["createdAt"] as? Date ?? createdAt
        updatedAt = record["updatedAt"] as? Date ?? updatedAt
        folderName = record["folderName"] as? String ?? folderName
        if let folderIDString = record["folderID"] as? String {
            folderID = UUID(uuidString: folderIDString)
        }
        tagIDs = record["tagIDs"] as? String
        reminderAt = record["reminderAt"] as? Date
        recurrenceRule = record["recurrenceRule"] as? String
        version = record["version"] as? Int64 ?? version
        rtfdData = record["rtfdData"] as? Data
    }
}

extension FolderEntity {
    /// 转换为 CloudKit Record
    func toCKRecord() -> CKRecord {
        let recordID = CKRecord.ID(recordName: id.uuidString)
        let record = CKRecord(recordType: "Folder", recordID: recordID)
        
        record["id"] = id.uuidString
        record["name"] = name
        record["sortOrder"] = sortOrder ?? 0
        record["createdAt"] = createdAt ?? Date()
        record["isSystem"] = (isSystem ?? false) ? 1 : 0
        
        return record
    }
    
    /// 从 CloudKit Record 更新
    func update(from record: CKRecord) {
        name = record["name"] as? String ?? name
        sortOrder = record["sortOrder"] as? Int
        createdAt = record["createdAt"] as? Date
        isSystem = (record["isSystem"] as? Int64 ?? 0) == 1
    }
}

extension TagEntity {
    /// 转换为 CloudKit Record
    func toCKRecord() -> CKRecord {
        let recordID = CKRecord.ID(recordName: id.uuidString)
        let record = CKRecord(recordType: "Tag", recordID: recordID)
        
        record["id"] = id.uuidString
        record["name"] = name
        record["color"] = color
        record["sortOrder"] = sortOrder
        record["createdAt"] = createdAt
        
        return record
    }
    
    /// 从 CloudKit Record 更新
    func update(from record: CKRecord) {
        name = record["name"] as? String ?? name
        color = record["color"] as? String ?? color
        sortOrder = record["sortOrder"] as? Int ?? sortOrder
        createdAt = record["createdAt"] as? Date ?? createdAt
    }
}

// MARK: - 同步冲突解决策略

enum ConflictResolutionStrategy {
    case serverWins    // 服务器版本优先
    case clientWins    // 本地版本优先
    case newerWins     // 较新版本优先
    case merge         // 尝试合并
}

@MainActor
final class ConflictResolver {
    static let shared = ConflictResolver()
    
    var strategy: ConflictResolutionStrategy = .newerWins
    
    private init() {}
    
    /// 解决笔记冲突
    func resolveNoteConflict(local: NoteEntity, server: CKRecord) -> NoteEntity {
        switch strategy {
        case .serverWins:
            local.update(from: server)
            return local
            
        case .clientWins:
            // 保持本地版本，稍后会上传到服务器
            return local
            
        case .newerWins:
            let serverDate = server["updatedAt"] as? Date ?? Date.distantPast
            if serverDate > local.updatedAt {
                local.update(from: server)
            }
            return local
            
        case .merge:
            // 简单的合并策略：保留较新的标题和内容
            let serverDate = server["updatedAt"] as? Date ?? Date.distantPast
            if serverDate > local.updatedAt {
                local.update(from: server)
            }
            return local
        }
    }
}
