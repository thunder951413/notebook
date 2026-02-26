//
//  BackupManager.swift
//  Reminder
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
        return appSupport.appendingPathComponent("Reminder/Backups", isDirectory: true)
    }

    // 每个笔记保留的最大备份数
    private let maxBackupsPerNote = 10

    // 崩溃检测标记
    private let crashMarkerKey = "reminder_crash_marker"
    private let lastSaveKey = "reminder_last_save"

    private init() {
        createBackupDirectory()
    }

    // MARK: - 公共 API

    /// 创建备份
    func createBackup(noteID: UUID, title: String, rtfdData: Data, reason: String) {
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
            print("[BackupManager] Backup created: \(backup.id) for note \(noteID)")
        } catch {
            print("[BackupManager] Failed to create backup: \(error)")
        }
    }

    /// 获取笔记的所有备份
    func getBackups(for noteID: UUID) -> [BackupItem] {
        do {
            let files = try listBackupFiles(for: noteID)
            return files.compactMap { try? loadBackup(from: $0) }
                .sorted { $0.timestamp > $1.timestamp }
        } catch {
            print("[BackupManager] Failed to list backups: \(error)")
            return []
        }
    }

    /// 从备份恢复
    func restoreBackup(_ backup: BackupItem, context: ModelContext) -> Bool {
        do {
            let descriptor = FetchDescriptor<NoteEntity>(
                predicate: #Predicate<NoteEntity> { $0.id == backup.noteID }
            )

            let entities = try context.fetch(descriptor)

            if let entity = entities.first {
                // 先创建当前状态的备份（以防万一）
                if let currentData = entity.rtfdData {
                    createBackup(
                        noteID: backup.noteID,
                        title: entity.title,
                        rtfdData: currentData,
                        reason: "auto_before_restore"
                    )
                }

                // 恢复备份数据
                entity.rtfdData = backup.rtfdData
                entity.updatedAt = Date()
                try context.save()

                print("[BackupManager] Restored backup: \(backup.id)")
                return true
            }
        } catch {
            print("[BackupManager] Failed to restore backup: \(error)")
        }
        return false
    }

    /// 标记保存开始（用于崩溃检测）
    func markSaveStart(noteID: UUID) {
        UserDefaults.standard.set(noteID.uuidString, forKey: crashMarkerKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastSaveKey)
    }

    /// 标记保存完成
    func markSaveComplete() {
        UserDefaults.standard.removeObject(forKey: crashMarkerKey)
        UserDefaults.standard.removeObject(forKey: lastSaveKey)
    }

    /// 检查是否有未完成的保存（崩溃检测）
    func checkForIncompleteSave() -> (noteID: UUID, timestamp: Date)? {
        guard let noteIDString = UserDefaults.standard.string(forKey: crashMarkerKey),
              let noteID = UUID(uuidString: noteIDString),
              let timestamp = UserDefaults.standard.object(forKey: lastSaveKey) as? TimeInterval else {
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
            print("[BackupManager] All backups cleared")
        } catch {
            print("[BackupManager] Failed to clear backups: \(error)")
        }
    }

    // MARK: - 私有方法

    private func createBackupDirectory() {
        do {
            try FileManager.default.createDirectory(at: backupDirectory, withIntermediateDirectories: true)
        } catch {
            print("[BackupManager] Failed to create backup directory: \(error)")
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
        try data.write(to: fileURL)
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
