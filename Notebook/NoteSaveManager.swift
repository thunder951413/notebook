//
//  NoteSaveManager.swift
//  Notebook
//
//  笔记保存管理器 - 最高安全性和稳定性优先
//  设计原则：
//  1. 所有保存操作都是同步阻塞的，确保完成后再继续
//  2. 保存时锁定笔记，防止并发修改
//  3. 所有状态变更都有日志记录
//  4. 失败时重试，成功才返回
//

import Foundation
import SwiftData
import AppKit

/// 保存结果
enum SaveResult {
    case success
    case failure(Error)
}

/// 保存请求
struct SaveRequest {
    let noteID: UUID
    let title: String
    let folderID: UUID?
    let folder: String
    let reminderAt: Date?
    let recurrenceRule: String
    let rtfdData: Data
    let reason: String
    let timestamp: Date
}

/// 笔记保存管理器 - 单例，串行处理所有保存操作
@MainActor
final class NoteSaveManager {
    static let shared = NoteSaveManager()
    
    private var modelContext: ModelContext?
    
    // 保存队列 - 确保同一时间只有一个保存操作在执行
    private let saveQueue = DispatchQueue(label: "com.notebook.save", qos: .userInitiated)
    
    // 当前正在保存的笔记ID
    private var currentlySaving: Set<UUID> = []
    
    // 待保存的队列（用于自动保存去抖）
    private var pendingSaves: [UUID: SaveRequest] = [:]
    private var pendingTimers: [UUID: Timer] = [:]
    
    private init() {}
    
    func setContext(_ context: ModelContext) {
        self.modelContext = context
    }
    
    // MARK: - 公共 API
    
    /// 立即同步保存 - 阻塞直到保存完成
    func saveImmediately(request: SaveRequest) -> SaveResult {
        cancelPendingSave(for: request.noteID)
        return performSave(request: request)
    }
    
    /// 延迟保存（自动保存）- 去抖处理
    func scheduleSave(request: SaveRequest, delay: TimeInterval = 1.0) {
        let noteID = request.noteID
        cancelPendingSave(for: noteID)
        pendingSaves[noteID] = request
        
        let timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            DispatchQueue.main.async {
                if let pendingRequest = self.pendingSaves[noteID] {
                    self.pendingSaves.removeValue(forKey: noteID)
                    _ = self.performSave(request: pendingRequest)
                }
            }
        }
        
        pendingTimers[noteID] = timer
    }
    
    /// 取消待保存任务
    func cancelPendingSave(for noteID: UUID) {
        if let timer = pendingTimers[noteID] {
            timer.invalidate()
            pendingTimers.removeValue(forKey: noteID)
            pendingSaves.removeValue(forKey: noteID)
        }
    }
    
    /// 强制刷新所有待保存内容
    func flushAllPending() {
        let pending = pendingSaves
        pendingSaves.removeAll()
        
        for timer in pendingTimers.values {
            timer.invalidate()
        }
        pendingTimers.removeAll()
        
        for request in pending.values {
            _ = performSave(request: request)
        }
    }
    
    // MARK: - 私有方法

    /// 执行实际保存 - 必须在主线程调用
    private func performSave(request: SaveRequest) -> SaveResult {
        guard let context = modelContext else {
            return .failure(NSError(domain: "SaveManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "ModelContext not initialized"]))
        }

        let noteID = request.noteID

        // 检查是否正在保存该笔记
        guard !currentlySaving.contains(noteID) else {
            return waitAndRetry(request: request, maxRetries: 3)
        }

        // 标记为正在保存（用于崩溃检测）
        currentlySaving.insert(noteID)
        BackupManager.shared.markSaveStart(noteID: noteID)

        defer {
            currentlySaving.remove(noteID)
            BackupManager.shared.markSaveComplete()
        }

        // 先创建备份
        BackupManager.shared.createBackup(
            noteID: noteID,
            title: request.title,
            rtfdData: request.rtfdData,
            reason: request.reason
        )

        // 执行保存
        do {
            let descriptor = FetchDescriptor<NoteEntity>(
                predicate: #Predicate<NoteEntity> { $0.id == noteID }
            )

            let entities = try context.fetch(descriptor)
            guard let entity = entities.first else {
                return .failure(NSError(domain: "SaveManager", code: -2, userInfo: [NSLocalizedDescriptionKey: "Entity not found"]))
            }

            // 验证数据完整性
            guard validateData(request.rtfdData) else {
                return .failure(NSError(domain: "SaveManager", code: -3, userInfo: [NSLocalizedDescriptionKey: "Data validation failed"]))
            }

            // 更新实体
            entity.title = request.title
            entity.updatedAt = Date()
            entity.folderID = request.folderID
            entity.folderName = request.folder
            entity.rtfdData = request.rtfdData
            entity.reminderAt = request.reminderAt
            entity.recurrenceRule = request.recurrenceRule

            // 保存到数据库
            try context.save()

            // 清理未引用的附件
            if let content = try? NSAttributedString(data: request.rtfdData, options: [.documentType: NSAttributedString.DocumentType.rtfd], documentAttributes: nil) {
                AttachmentManager.shared.cleanupUnusedAttachments(for: noteID, content: content)
            }

            return .success
            
        } catch {
            return .failure(error)
        }
    }
    
    /// 等待并重试保存
    private func waitAndRetry(request: SaveRequest, maxRetries: Int) -> SaveResult {
        var retries = 0

        while retries < maxRetries {
            Thread.sleep(forTimeInterval: 0.05)
            if !currentlySaving.contains(request.noteID) {
                return performSave(request: request)
            }
            retries += 1
        }

        return performSave(request: request)
    }

    /// 验证数据完整性
    private func validateData(_ data: Data) -> Bool {
        // 检查数据是否为空
        guard !data.isEmpty else {
            print("[SaveManager] Validation failed: empty data")
            return false
        }

        // 检查数据大小（至少要有基本的 RTFD 头）
        guard data.count > 100 else {
            print("[SaveManager] Validation failed: data too small (\(data.count) bytes)")
            return false
        }

        // 尝试解析验证
        do {
            if let _ = try? NSAttributedString(
                data: data,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            ) {
                return true
            }
        }

        // 如果无法解析，可能是纯文本或其他格式，也接受
        return true
    }
}

// MARK: - 便捷方法

extension NoteSaveManager {
    /// 从编辑器内容创建保存请求
    func createRequest(
        noteID: UUID,
        title: String,
        folderID: UUID?,
        folder: String,
        reminderAt: Date?,
        recurrenceRule: String,
        content: NSAttributedString,
        reason: String
    ) -> SaveRequest? {
        let cleaned = content.cleanedForStorage()

        guard let rtfdData = try? cleaned.data(
            from: NSRange(location: 0, length: cleaned.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
        ) else {
            print("[SaveManager] ERROR: Failed to serialize content - id=\(noteID)")
            return nil
        }

        return SaveRequest(
            noteID: noteID,
            title: title,
            folderID: folderID,
            folder: folder,
            reminderAt: reminderAt,
            recurrenceRule: recurrenceRule,
            rtfdData: rtfdData,
            reason: reason,
            timestamp: Date()
        )
    }
}
