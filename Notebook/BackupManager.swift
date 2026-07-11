//
//  BackupManager.swift
//  Notebook
//
//  自动备份管理器 - 防止数据丢失
//  功能：
//  1. 每次保存前自动创建备份
//  2. 保留最近 N 个备份版本
//  3. 支持从备份恢复
//  4. 崩溃后自动检测并提示恢复
//

import Foundation
import SwiftData
import AppKit

/// 备份项
struct BackupItem: Codable, Identifiable, Hashable {
    let id: UUID
    let noteID: UUID
    let timestamp: Date
    let title: String
    let rtfdData: Data
    let backupReason: String

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: BackupItem, rhs: BackupItem) -> Bool {
        lhs.id == rhs.id
    }
}

/// 自动备份管理器
@MainActor
final class BackupManager {
    static let shared = BackupManager()

    // 备份存储目录
    private var backupDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("Notebook/Backups", isDirectory: true)
    }

    // 每个笔记保留的最大备份数
    private let maxBackupsPerNote = 10

    // 崩溃检测标记
    private let crashMarkerKey = "notebook_crash_marker"
    private let lastSaveKey = "notebook_last_save"

    private init() {
        createBackupDirectory()
    }

    // MARK: - 公共 API

    /// 创建备份
    @discardableResult
    func createBackup(noteID: UUID, title: String, rtfdData: Data, reason: String) -> Bool {
        let backup = BackupItem(
            id: UUID(),
            noteID: noteID,
            timestamp: Date(),
            title: title,
            rtfdData: rtfdData,
            backupReason: reason
        )

        do {
            try saveBackup(backup)
            try cleanupOldBackups(for: noteID)
            DebugLog.storage("Backup created: \(backup.id) for note \(noteID)", level: .debug)
            return true
        } catch {
            DebugLog.storage("Failed to create backup: \(error)", level: .warn)
            return false
        }
    }

    /// 获取笔记的所有备份
    func getBackups(for noteID: UUID) -> [BackupItem] {
        do {
            let files = try listBackupFiles(for: noteID)
            return files.compactMap { try? loadBackup(from: $0) }
                .sorted { $0.timestamp > $1.timestamp }
        } catch {
            DebugLog.storage("Failed to list backups: \(error)", level: .warn)
            return []
        }
    }

    /// 从备份恢复
    func restoreBackup(_ backup: BackupItem, context: ModelContext) -> Bool {
        do {
            let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == backup.noteID }
            )

            let entities = try context.fetch(descriptor)

            if let entity = entities.first {
                if let currentData = currentBlockDocumentRTFDData(for: entity, context: context) {
                    createBackup(
                        noteID: backup.noteID,
                        title: entity.title,
                        rtfdData: currentData,
                        reason: "auto_before_restore"
                    )
                }

                entity.updatedAt = Date()
                guard let request = NoteSaveManager.shared.createRequest(
                    noteID: backup.noteID,
                    title: entity.title,
                    folderID: entity.folderID,
                    folder: entity.folderName,
                    reminderAt: entity.reminderAt,
                    recurrenceRule: entity.recurrenceRule,
                    content: try NSAttributedString(
                        data: backup.rtfdData,
                        options: [.documentType: NSAttributedString.DocumentType.rtfd],
                        documentAttributes: nil
                    ),
                    reason: "backup_restore"
                ) else {
                    return false
                }
                let result = NoteSaveManager.shared.saveImmediately(request: request)
                guard case .success = result else {
                    return false
                }

                DebugLog.storage("Restored backup: \(backup.id)", level: .debug)
                return true
            }
        } catch {
            DebugLog.storage("Failed to restore backup: \(error)", level: .warn)
        }
        return false
    }

    private func currentBlockDocumentRTFDData(for entity: BlockDocumentNoteEntity, context: ModelContext) -> Data? {
        let noteID = entity.id
        let blockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
            predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID }
        )
        let assetDescriptor = FetchDescriptor<BlockDocumentAssetEntity>(
            predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == noteID }
        )

        let blocks = ((try? context.fetch(blockDescriptor)) ?? []).sorted { $0.position < $1.position }
        let assets = ((try? context.fetch(assetDescriptor)) ?? []).map { ($0.assetID, $0) }
        let assetsByID = Dictionary(uniqueKeysWithValues: assets)

        let attachmentsRoot: URL? = {
            let storage = StorageLocationManager.shared
            guard let baseDirectory = storage.baseDirectoryURL else {
                return nil
            }
            return try? storage.withSecurityScopedAccess(baseDirectory) {
                try storage.attachmentsDirectoryURL()
            }
        }()

        let content = BlockDocumentAttributedStringBuilder(attachmentsRoot: attachmentsRoot)
            .build(blocks: blocks, assetsByID: assetsByID)
        guard content.length > 0 else {
            return nil
        }
        return try? content.data(
            from: NSRange(location: 0, length: content.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
        )
    }

    /// 标记保存开始（用于崩溃检测）
    func markSaveStart(noteID: UUID) {
        NotebookDefaults.shared.set(noteID.uuidString, forKey: crashMarkerKey)
        NotebookDefaults.shared.set(Date().timeIntervalSince1970, forKey: lastSaveKey)
    }

    /// 标记保存完成
    func markSaveComplete() {
        NotebookDefaults.shared.removeObject(forKey: crashMarkerKey)
        NotebookDefaults.shared.removeObject(forKey: lastSaveKey)
    }

    /// 检查是否有未完成的保存（崩溃检测）
    func checkForIncompleteSave() -> (noteID: UUID, timestamp: Date)? {
        guard let noteIDString = NotebookDefaults.shared.string(forKey: crashMarkerKey),
              let noteID = UUID(uuidString: noteIDString),
              let timestamp = NotebookDefaults.shared.object(forKey: lastSaveKey) as? TimeInterval else {
            return nil
        }

        return (noteID, Date(timeIntervalSince1970: timestamp))
    }

    /// 清理所有备份
    func clearAllBackups() {
        do {
            let files = try FileManager.default.contentsOfDirectory(at: backupDirectory, includingPropertiesForKeys: nil)
            for file in files {
                try? FileManager.default.removeItem(at: file)
            }
            DebugLog.storage("All backups cleared", level: .debug)
        } catch {
            DebugLog.storage("Failed to clear backups: \(error)", level: .warn)
        }
    }

    // MARK: - 私有方法

    private func createBackupDirectory() {
        do {
            try FileManager.default.createDirectory(at: backupDirectory, withIntermediateDirectories: true)
        } catch {
            DebugLog.storage("Failed to create backup directory: \(error)", level: .warn)
        }
    }

    private func backupFileURL(for backup: BackupItem) -> URL {
        return backupDirectory
            .appendingPathComponent("\(backup.noteID.uuidString)")
            .appendingPathComponent("\(backup.id.uuidString).backup")
    }

    private func saveBackup(_ backup: BackupItem) throws {
        let noteDirectory = backupDirectory.appendingPathComponent(backup.noteID.uuidString)
        try FileManager.default.createDirectory(at: noteDirectory, withIntermediateDirectories: true)

        let fileURL = backupFileURL(for: backup)
        let data = try JSONEncoder().encode(backup)
        try data.write(to: fileURL, options: .atomic)
    }

    private func loadBackup(from url: URL) throws -> BackupItem {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(BackupItem.self, from: data)
    }

    private func listBackupFiles(for noteID: UUID) throws -> [URL] {
        let noteDirectory = backupDirectory.appendingPathComponent(noteID.uuidString)
        guard FileManager.default.fileExists(atPath: noteDirectory.path) else {
            return []
        }

        return try FileManager.default.contentsOfDirectory(at: noteDirectory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "backup" }
    }

    private func cleanupOldBackups(for noteID: UUID) throws {
        let files = try listBackupFiles(for: noteID)

        guard files.count > maxBackupsPerNote else { return }

        // 按修改时间排序，删除最旧的
        let sortedFiles = try files.sorted {
            let attr1 = try FileManager.default.attributesOfItem(atPath: $0.path)
            let attr2 = try FileManager.default.attributesOfItem(atPath: $1.path)
            let date1 = attr1[.modificationDate] as? Date ?? Date.distantPast
            let date2 = attr2[.modificationDate] as? Date ?? Date.distantPast
            return date1 < date2
        }

        let filesToDelete = sortedFiles.prefix(files.count - maxBackupsPerNote)
        for file in filesToDelete {
            try? FileManager.default.removeItem(at: file)
        }
    }
}
