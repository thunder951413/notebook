//
//  LocalSyncManager.swift
//  Notebook
//
//  本地同步管理器 - 作为 iCloud 的替代方案
//  将数据导出到本地目录，用户可手动同步
//

import Foundation
import SwiftUI
import Combine

@MainActor
final class LocalSyncManager: ObservableObject {
    static let shared = LocalSyncManager()
    
    @Published var syncStatus: SyncStatus = .idle
    @Published var lastSyncDate: Date?
    
    /// 同步目录（用户文档目录下的 NotebookSync 文件夹）
    var syncDirectory: URL {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return documents.appendingPathComponent("NotebookSync", isDirectory: true)
    }
    
    private init() {
        createSyncDirectoryIfNeeded()
    }
    
    private func createSyncDirectoryIfNeeded() {
        if !FileManager.default.fileExists(atPath: syncDirectory.path) {
            try? FileManager.default.createDirectory(at: syncDirectory, withIntermediateDirectories: true)
        }
    }
    
    /// 导出所有数据到本地
    func exportAllData(notes: [Note], folders: [Folder], tags: [Tag]) async throws {
        syncStatus = .syncing
        
        let exportData = ExportData(
            notes: notes.map { NoteExport(from: $0) },
            folders: folders,
            tags: tags,
            exportDate: Date(),
            version: "1.0"
        )
        
        let data = try JSONEncoder().encode(exportData)
        let fileURL = syncDirectory.appendingPathComponent("notebook_backup_\(Date().timeIntervalSince1970).json")
        try data.write(to: fileURL)
        
        lastSyncDate = Date()
        syncStatus = .completed
        
        print("[LocalSyncManager] Data exported to: \(fileURL.path)")
    }
    
    /// 从本地导入数据
    func importData(from fileURL: URL) async throws -> ExportData {
        syncStatus = .syncing
        
        let data = try Data(contentsOf: fileURL)
        let exportData = try JSONDecoder().decode(ExportData.self, from: data)
        
        syncStatus = .completed
        
        print("[LocalSyncManager] Data imported from: \(fileURL.path)")
        return exportData
    }
    
    /// 获取所有备份文件
    func listBackupFiles() -> [URL] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: syncDirectory, includingPropertiesForKeys: nil) else {
            return []
        }
        return files.filter { $0.pathExtension == "json" }
    }
}

// MARK: - 导出数据结构

struct ExportData: Codable {
    let notes: [NoteExport]
    let folders: [Folder]
    let tags: [Tag]
    let exportDate: Date
    let version: String
}

struct NoteExport: Codable {
    let id: UUID
    let title: String
    let content: String // 纯文本内容
    let createdAt: Date
    let updatedAt: Date
    let folder: String
    let reminderAt: Date?
    let recurrenceRule: String
    let version: Int64
    let tagIDs: [UUID]
    
    init(from note: Note) {
        self.id = note.id
        self.title = note.title
        self.content = note.content.string // 转换为纯文本
        self.createdAt = note.createdAt
        self.updatedAt = note.updatedAt
        self.folder = note.folder
        self.reminderAt = note.reminderAt
        self.recurrenceRule = note.recurrenceRule
        self.version = note.version
        self.tagIDs = note.tagIDs
    }
}
