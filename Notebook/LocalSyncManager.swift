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
import SwiftData
import CryptoKit

struct LocalNoteIndex: Codable {
    let generatedAt: Date
    let deviceID: String
    let entries: [LocalNoteIndexEntry]
}

struct LocalNoteIndexEntry: Codable {
    let noteID: UUID
    let version: Int64
    let contentHash: String
    let historyCount: Int
}

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
    private var notesDirectory: URL {
        syncDirectory.appendingPathComponent("notes", isDirectory: true)
    }
    
    private init() {
        createSyncDirectoryIfNeeded()
    }
    
    private func createSyncDirectoryIfNeeded() {
        if !FileManager.default.fileExists(atPath: syncDirectory.path) {
            try? FileManager.default.createDirectory(at: syncDirectory, withIntermediateDirectories: true)
        }
        if !FileManager.default.fileExists(atPath: notesDirectory.path) {
            try? FileManager.default.createDirectory(at: notesDirectory, withIntermediateDirectories: true)
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

    func syncAllNotesToLocal(context: ModelContext) async throws -> [UUID] {
        syncStatus = .syncing
        defer {
            if case .syncing = syncStatus {
                syncStatus = .completed
            }
        }
        createSyncDirectoryIfNeeded()

        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
            .sorted { $0.updatedAt > $1.updatedAt }
        var syncedNoteIDs: [UUID] = []
        var entries: [LocalNoteIndexEntry] = []

        for note in notes {
            let syncState = try fetchSyncState(noteID: note.id, context: context)
            let shouldSync =
                syncState == nil ||
                syncState!.lastSyncedVersion < note.version ||
                syncState!.pendingHistoryCount > 0
            if shouldSync {
                try syncNoteToLocal(noteID: note.id, context: context)
                syncedNoteIDs.append(note.id)
            }
            if let entry = try makeIndexEntry(noteID: note.id, context: context) {
                entries.append(entry)
            }
        }

        try writeIndex(entries: entries)
        lastSyncDate = Date()
        return syncedNoteIDs
    }

    func syncAllNotesFromLocal(context: ModelContext) async throws -> [NoteSyncMergeResult] {
        syncStatus = .syncing
        defer {
            if case .syncing = syncStatus {
                syncStatus = .completed
            }
        }
        createSyncDirectoryIfNeeded()

        let localIndex = try readIndex()
        let noteIDs: [UUID]
        if let localIndex {
            noteIDs = localIndex.entries
                .filter { entry in
                    guard let syncState = try? fetchSyncState(noteID: entry.noteID, context: context) else {
                        return true
                    }
                    if entry.version > syncState.lastRemoteVersion {
                        return true
                    }
                    return entry.contentHash != syncState.remoteFingerprint
                }
                .map(\.noteID)
                .sorted { $0.uuidString < $1.uuidString }
        } else {
            noteIDs = try listLocalNoteIDs()
        }

        var results: [NoteSyncMergeResult] = []
        for noteID in noteIDs {
            let result = try syncNoteFromLocal(noteID: noteID, context: context)
            results.append(result)
        }
        lastSyncDate = Date()
        return results
    }

    func syncBidirectional(context: ModelContext) async throws -> (pulled: Int, pushed: Int, conflicts: Int) {
        let pullResults = try await syncAllNotesFromLocal(context: context)
        let pushIDs = try await syncAllNotesToLocal(context: context)
        let conflicts = pullResults.filter(\.detectedConflict).count
        return (pullResults.count, pushIDs.count, conflicts)
    }

    private func syncNoteToLocal(noteID: UUID, context: ModelContext) throws {
        guard let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: noteID, context: context) else {
            return
        }
        let fileURL = notesDirectory.appendingPathComponent("\(noteID.uuidString).json")
        let tempURL = notesDirectory.appendingPathComponent("\(noteID.uuidString).json.tmp")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(envelope)
        try payload.write(to: tempURL, options: [.atomic])
        if FileManager.default.fileExists(atPath: fileURL.path) {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL)
        } else {
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        }
        try BlockDocumentNoteVersionStore.markSynced(
            noteID: noteID,
            syncedVersion: envelope.currentVersion,
            context: context
        )
    }

    private func syncNoteFromLocal(noteID: UUID, context: ModelContext) throws -> NoteSyncMergeResult {
        let fileURL = notesDirectory.appendingPathComponent("\(noteID.uuidString).json")
        let payload = try Data(contentsOf: fileURL)
        let envelope = try JSONDecoder().decode(VersionedNoteSyncEnvelope.self, from: payload)
        let result = try BlockDocumentNoteVersionStore.mergeRemoteEnvelope(envelope, context: context)
        if !result.detectedConflict {
            try BlockDocumentNoteVersionStore.markSynced(
                noteID: noteID,
                syncedVersion: min(result.localVersion, result.remoteVersion),
                context: context
            )
        }
        return result
    }

    private func makeIndexEntry(noteID: UUID, context: ModelContext) throws -> LocalNoteIndexEntry? {
        guard let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: noteID, context: context) else {
            return nil
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let snapshotData = try encoder.encode(envelope.currentSnapshot)
        return LocalNoteIndexEntry(
            noteID: noteID,
            version: envelope.currentVersion,
            contentHash: fingerprint(for: snapshotData),
            historyCount: envelope.history.count
        )
    }

    private func writeIndex(entries: [LocalNoteIndexEntry]) throws {
        let index = LocalNoteIndex(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: entries.sorted { $0.noteID.uuidString < $1.noteID.uuidString }
        )
        let fileURL = notesDirectory.appendingPathComponent("index.json")
        let tempURL = notesDirectory.appendingPathComponent("index.json.tmp")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(index)
        try payload.write(to: tempURL, options: [.atomic])
        if FileManager.default.fileExists(atPath: fileURL.path) {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL)
        } else {
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        }
    }

    private func readIndex() throws -> LocalNoteIndex? {
        let fileURL = notesDirectory.appendingPathComponent("index.json")
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }
        let data = try Data(contentsOf: fileURL)
        return try JSONDecoder().decode(LocalNoteIndex.self, from: data)
    }

    private func listLocalNoteIDs() throws -> [UUID] {
        let files = try FileManager.default.contentsOfDirectory(at: notesDirectory, includingPropertiesForKeys: nil)
        return files
            .compactMap { file in
                let filename = file.lastPathComponent
                guard filename.hasSuffix(".json"), filename != "index.json" else { return nil }
                return UUID(uuidString: String(filename.dropLast(5)))
            }
            .sorted { $0.uuidString < $1.uuidString }
    }

    private func fetchSyncState(noteID: UUID, context: ModelContext) throws -> BlockDocumentNoteSyncStateEntity? {
        let descriptor = FetchDescriptor<BlockDocumentNoteSyncStateEntity>(
            predicate: #Predicate<BlockDocumentNoteSyncStateEntity> { $0.noteID == noteID }
        )
        return try context.fetch(descriptor).first
    }

    private func fingerprint(for data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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
