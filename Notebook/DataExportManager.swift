import Foundation
import SwiftData
import AppKit
import Compression

/// 数据导出管理器 - 打包配置和数据
@MainActor
final class DataExportManager {
    static let shared = DataExportManager()

    private var importFailureInjectorForTesting: (() throws -> Void)?
    private var resetFailureInjectorForTesting: (() throws -> Void)?

    enum BlockLibraryExportError: LocalizedError {
        case libraryUnavailable

        var errorDescription: String? {
            switch self {
            case .libraryUnavailable:
                return "当前没有可导出的块级文档库"
            }
        }
    }

    enum DataImportValidationError: LocalizedError {
        case invalidConfigurationFile(name: String)

        var errorDescription: String? {
            switch self {
            case .invalidConfigurationFile(let name):
                return "配置文件格式无效: \(name)"
            }
        }
    }

    private init() {}

    func setImportFailureInjectorForTesting(_ injector: (() throws -> Void)?) {
        importFailureInjectorForTesting = injector
    }

    func setResetFailureInjectorForTesting(_ injector: (() throws -> Void)?) {
        resetFailureInjectorForTesting = injector
    }

    // MARK: - 导出配置

    /// 打包当前配置到 zip 文件
    func exportConfiguration() async throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let exportDir = uniqueTemporaryDirectoryURL(prefix: "NotebookConfig", in: tempDir)

        // 创建临时目录
        try FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)

        // 导出 UserDefaults 配置
        try ConfigurationTransferHelper.exportUserDefaults(to: exportDir)

        // 导出快捷键配置
        try ConfigurationTransferHelper.exportKeyboardShortcuts(to: exportDir)

        // 导出环形菜单配置
        try ConfigurationTransferHelper.exportRadialMenuSettings(to: exportDir)

        // 导出应用设置
        try ConfigurationTransferHelper.exportAppSettings(to: exportDir)

        // 导出 AI 配置
        try ConfigurationTransferHelper.exportAIConfig(to: exportDir)

        // 创建 zip 文件
        let zipURL = uniqueExportArchiveURL(prefix: "NotebookConfig", in: tempDir)
        try ArchiveUtility.createZip(from: exportDir, to: zipURL)

        // 清理临时目录
        try? FileManager.default.removeItem(at: exportDir)

        return zipURL
    }

    // MARK: - 导出所有数据

    /// 打包所有笔记和附件到 zip 文件
    func exportAllData(context: ModelContext) async throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let exportDir = uniqueTemporaryDirectoryURL(prefix: "NotebookData", in: tempDir)

        // 创建临时目录
        try FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)

        // 导出配置
        let configDir = exportDir.appendingPathComponent("Config")
        try ConfigurationTransferHelper.exportUserDefaults(to: configDir)
        try ConfigurationTransferHelper.exportKeyboardShortcuts(to: configDir)
        try ConfigurationTransferHelper.exportRadialMenuSettings(to: configDir)
        try ConfigurationTransferHelper.exportAppSettings(to: configDir)

        // 导出 AI 配置
        try ConfigurationTransferHelper.exportAIConfig(to: configDir)

        // 密码验证记录属于设备凭据，禁止随数据包导出。旧包仍保持兼容导入。

        // 导出锁定文件夹配置（仅应用内访问控制元数据，不代表磁盘加密）
        try ConfigurationTransferHelper.exportEncryptedFolders(to: configDir)

        // 导出加密相关数据
        try ConfigurationTransferHelper.exportEncryptedData(to: configDir)

        // 导出所有笔记
        try await exportAllNotes(to: exportDir.appendingPathComponent("Notes"), context: context)

        // 导出附件
        try exportAttachments(to: exportDir.appendingPathComponent("Attachments"))

        // 创建 zip 文件
        let zipURL = uniqueExportArchiveURL(prefix: "NotebookData", in: tempDir)
        try ArchiveUtility.createZip(from: exportDir, to: zipURL)

        // 清理临时目录
        try? FileManager.default.removeItem(at: exportDir)

        return zipURL
    }

    // MARK: - 导出所有笔记（仅笔记）

    /// 仅导出所有笔记（不包含配置和附件）
    func exportAllNotesOnly(context: ModelContext) async throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let exportDir = uniqueTemporaryDirectoryURL(prefix: "NotebookNotes", in: tempDir)

        // 创建临时目录
        try FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)

        // 导出所有笔记
        try await exportAllNotes(to: exportDir, context: context)

        // 创建 zip 文件
        let zipURL = uniqueExportArchiveURL(prefix: "NotebookNotes", in: tempDir)
        try ArchiveUtility.createZip(from: exportDir, to: zipURL)

        // 清理临时目录
        try? FileManager.default.removeItem(at: exportDir)

        return zipURL
    }

    func extractArchive(at zipURL: URL, to destinationURL: URL) throws {
        try ArchiveUtility.unzipFile(at: zipURL, to: destinationURL)
    }

    func createArchiveForTesting(from directoryURL: URL, prefix: String = "NotebookTest") throws -> URL {
        let zipURL = uniqueExportArchiveURL(prefix: prefix, in: FileManager.default.temporaryDirectory)
        try ArchiveUtility.createZip(from: directoryURL, to: zipURL)
        return zipURL
    }

    // MARK: - 私有方法

    private func exportAllNotes(to directory: URL, context: ModelContext) async throws {
        try await exportDocumentMigrationData(to: directory, context: context)
    }

    private func exportDocumentMigrationData(to directory: URL, context: ModelContext) async throws {
        let library = try latestBlockLibrary(in: context)
        let folders = try context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
            .filter { $0.libraryID == library.id }
            .sorted { $0.sortOrder < $1.sortOrder }
        let tags = try context.fetch(FetchDescriptor<BlockDocumentTagEntity>())
            .filter { $0.libraryID == library.id }
            .sorted { $0.createdAt < $1.createdAt }
        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]))
            .filter { $0.libraryID == library.id }
        let todoSteps = try context.fetch(FetchDescriptor<TodoStepEntity>())
            .filter { $0.libraryID == library.id }
            .sorted { lhs, rhs in
                if lhs.noteID != rhs.noteID {
                    return lhs.noteID.uuidString < rhs.noteID.uuidString
                }
                return lhs.order < rhs.order
            }
        let blocks = try context.fetch(FetchDescriptor<BlockDocumentBlockEntity>())
        let assets = try context.fetch(FetchDescriptor<BlockDocumentAssetEntity>())
        let attachmentsRoot = try persistentAttachmentsRootDirectory()
        let blocksByNoteID = Dictionary(grouping: blocks, by: \.noteID)
        let assetsByNoteID = Dictionary(grouping: assets, by: \.noteID)

        let notesDirectory = directory.appendingPathComponent("Notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notesDirectory, withIntermediateDirectories: true)

        var exportedNotes: [DocumentMigrationPackage.NoteItem] = []

        for note in notes {
            let noteDirectory = notesDirectory.appendingPathComponent(note.id.uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: noteDirectory, withIntermediateDirectories: true)
            let noteAssets = assetsByNoteID[note.id] ?? []
            let migratedAssets = try exportPersistedAssets(noteAssets, attachmentsRoot: attachmentsRoot, noteDirectory: noteDirectory)
            let assetByID = Dictionary(uniqueKeysWithValues: migratedAssets.map { ($0.id, $0) })
            let document = try buildMigratedDocument(
                from: (blocksByNoteID[note.id] ?? []).sorted { $0.position < $1.position },
                assetsByID: assetByID
            )
            try writeJSON(document, to: noteDirectory.appendingPathComponent("document.json"))

            exportedNotes.append(
                .init(
                    id: note.id,
                    title: note.title,
                    createdAt: note.createdAt,
                    updatedAt: note.updatedAt,
                    folderID: note.folderID,
                    folderName: note.folderName,
                    reminderAt: note.reminderAt,
                    recurrenceRule: note.recurrenceRule,
                    version: note.version,
                    tagIDs: UUIDListCoding.decode(note.tagIDs),
                    viewMode: note.viewMode,
                    deletedAt: note.deletedAt,
                    originalFolderID: note.originalFolderID,
                    originalFolderName: note.originalFolderName,
                    blockCount: document.blocks.count,
                    assetCount: migratedAssets.count,
                    documentPath: "Notes/\(note.id.uuidString)/document.json",
                    itemType: note.itemType,
                    todoDueAt: note.todoDueAt,
                    todoCompletedAt: note.todoCompletedAt,
                    todoIsImportant: note.todoIsImportant,
                    todoOrder: note.todoOrder,
                    linkedNoteIDs: UUIDListCoding.decode(note.linkedNoteIDs)
                )
            )
        }

        let package = DocumentMigrationPackage(
            schemaVersion: library.schemaVersion,
            exportedAt: library.sourceExportedAt,
            notes: exportedNotes,
            folders: folders.map {
                .init(
                    id: $0.id,
                    name: $0.name,
                    sortOrder: $0.sortOrder,
                    isSystem: $0.isSystem,
                    createdAt: $0.createdAt,
                    folderType: $0.folderType
                )
            },
            tags: tags.map {
                .init(
                    id: $0.id,
                    name: $0.name,
                    color: $0.color,
                    createdAt: $0.createdAt
                )
            },
            todoSteps: todoSteps.map {
                .init(
                    id: $0.id,
                    noteID: $0.noteID,
                    text: $0.text,
                    checked: $0.checked,
                    order: $0.order,
                    createdAt: $0.createdAt
                )
            }
        )

        try writeJSON(package, to: directory.appendingPathComponent("manifest.json"))
    }

    private func latestBlockLibrary(in context: ModelContext) throws -> BlockDocumentLibraryEntity {
        let libraries = try context.fetch(FetchDescriptor<BlockDocumentLibraryEntity>())
        guard let library = libraries.max(by: { $0.importedAt < $1.importedAt }) else {
            throw BlockLibraryExportError.libraryUnavailable
        }
        return library
    }

    private func buildMigratedDocument(
        from blocks: [BlockDocumentBlockEntity],
        assetsByID: [String: MigratedAssetReference]
    ) throws -> MigratedDocument {
        MigratedDocument(
            schemaVersion: "1.0",
            source: "NotebookBlockDocument",
            blocks: try blocks.map { block in
                MigratedDocumentBlock(
                    id: block.blockID,
                    type: block.sourceType,
                    text: try decodeTextPayload(block.textPayload),
                    level: block.level,
                    listStyle: block.listStyle,
                    order: block.order,
                    checked: block.checked,
                    indent: block.indent,
                    asset: block.assetID.flatMap { assetsByID[$0] },
                    table: try decodeTablePayload(block.tablePayload)
                )
            }
        )
    }

    private func exportPersistedAssets(
        _ assets: [BlockDocumentAssetEntity],
        attachmentsRoot: URL,
        noteDirectory: URL
    ) throws -> [MigratedAssetReference] {
        let assetsDirectory = noteDirectory.appendingPathComponent("Assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assetsDirectory, withIntermediateDirectories: true)

        return try assets.map { asset in
            let exportedFilename = exportedAssetFilename(for: asset.assetID, originalFilename: asset.filename)
            let sourceFileURL = attachmentsRoot.appendingPathComponent(asset.relativeFilePath)
            let destinationFileURL = assetsDirectory.appendingPathComponent(exportedFilename)
            try copyItemReplacingIfNeeded(from: sourceFileURL, to: destinationFileURL)

            let sidecarRelativePaths = try decodeStringListPayload(asset.sidecarPathsPayload)
            let exportedSidecars = try sidecarRelativePaths.map { relativePath -> String in
                let sidecarSourceURL = attachmentsRoot.appendingPathComponent(relativePath)
                let sidecarFilename = exportedAssetFilename(for: asset.assetID, originalFilename: sidecarSourceURL.lastPathComponent)
                let sidecarDestinationURL = assetsDirectory.appendingPathComponent(sidecarFilename)
                try copyItemReplacingIfNeeded(from: sidecarSourceURL, to: sidecarDestinationURL)
                return "Assets/\(sidecarFilename)"
            }

            return MigratedAssetReference(
                id: asset.assetID,
                kind: asset.sourceKind,
                filename: "Assets/\(exportedFilename)",
                mimeType: asset.mimeType,
                width: asset.width,
                height: asset.height,
                duration: asset.duration,
                createdAt: asset.createdAt,
                sidecarFiles: exportedSidecars
            )
        }
    }

    private func exportedAssetFilename(for assetID: String, originalFilename: String) -> String {
        let safeFilename = originalFilename.isEmpty ? assetID : originalFilename
        return "\(assetID)_\(safeFilename)"
    }

    private func decodeTextPayload(_ payload: Data?) throws -> [MigratedInlineText]? {
        guard let payload else {
            return nil
        }

        let spans = try JSONDecoder().decode([BlockDocumentTextSpanPayload].self, from: payload)
        return spans.map {
            MigratedInlineText(
                text: $0.text,
                bold: $0.bold,
                italic: $0.italic,
                underline: $0.underline,
                strikethrough: $0.strikethrough,
                textColor: $0.textColor,
                backgroundColor: $0.backgroundColor,
                link: $0.link,
                fontFamily: $0.fontFamily,
                fontSize: $0.fontSize,
                kern: $0.kern,
                baselineOffset: $0.baselineOffset,
                paragraphStyle: $0.paragraphStyle.map {
                    MigratedParagraphStyle(
                        alignment: $0.alignment,
                        lineSpacing: $0.lineSpacing,
                        paragraphSpacing: $0.paragraphSpacing,
                        paragraphSpacingBefore: $0.paragraphSpacingBefore,
                        firstLineHeadIndent: $0.firstLineHeadIndent,
                        headIndent: $0.headIndent,
                        tailIndent: $0.tailIndent
                    )
                }
            )
        }
    }

    private func decodeTablePayload(_ payload: Data?) throws -> MigratedTable? {
        guard let payload else {
            return nil
        }

        let table = try JSONDecoder().decode(BlockDocumentTablePayload.self, from: payload)
        return MigratedTable(
            rows: table.rows,
            columnWidths: table.columnWidths,
            rowHeights: table.rowHeights
        )
    }

    private func decodeStringListPayload(_ payload: Data?) throws -> [String] {
        guard let payload else {
            return []
        }
        return try JSONDecoder().decode([String].self, from: payload)
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(value).write(to: url)
    }

    private func exportAttachments(to directory: URL) throws {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else { return }

        let attachmentsDir = storage.appendingPathComponent("NotebookData/Attachments")

        guard FileManager.default.fileExists(atPath: attachmentsDir.path) else { return }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // 复制附件目录
        let contents = try FileManager.default.contentsOfDirectory(at: attachmentsDir, includingPropertiesForKeys: nil)
        for item in contents {
            let destination = directory.appendingPathComponent(item.lastPathComponent)
            try FileManager.default.copyItem(at: item, to: destination)
        }
    }

    private func formattedDate() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        return formatter.string(from: Date())
    }

    private func uniqueTemporaryDirectoryURL(prefix: String, in directory: URL) -> URL {
        directory.appendingPathComponent("\(prefix)_\(UUID().uuidString)", isDirectory: true)
    }

    private func uniqueExportArchiveURL(prefix: String, in directory: URL) -> URL {
        directory.appendingPathComponent("\(prefix)_\(formattedDate())_\(UUID().uuidString).zip")
    }

    // MARK: - 导入功能

    /// 导入配置
    func importConfiguration(from zipURL: URL) async throws {
        let tempDir = FileManager.default.temporaryDirectory
        let extractDir = uniqueTemporaryDirectoryURL(prefix: "ImportConfig", in: tempDir)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: extractDir) }

        // 解压 ZIP
        try ArchiveUtility.unzipFile(at: zipURL, to: extractDir)

        try ConfigurationTransferHelper.validateConfigurationImport(at: extractDir)

        // 导入配置
        try ConfigurationTransferHelper.importUserDefaults(from: extractDir)
        try ConfigurationTransferHelper.importKeyboardShortcuts(from: extractDir)
        try ConfigurationTransferHelper.importRadialMenuSettings(from: extractDir)
        try ConfigurationTransferHelper.importAppSettings(from: extractDir)
        try ConfigurationTransferHelper.importAIConfig(from: extractDir)
    }

    /// 导入笔记
    func importNotes(from zipURL: URL, context: ModelContext) async throws {
        if let safetyBackupURL = try await createSafetyBackup(context: context, directoryName: "BeforeNotesImport") {
            DebugLog.storage("笔记导入前安全备份已创建: \(safetyBackupURL.path)", level: .info)
        }

        guard let storage = StorageLocationManager.shared.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }
        let currentAttachments = storage.appendingPathComponent("NotebookData/Attachments", isDirectory: true)
        let stagedAttachments = try stageAttachmentsImport(from: currentAttachments)
        defer { try? FileManager.default.removeItem(at: stagedAttachments) }

        let previousAutosaveEnabled = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = previousAutosaveEnabled }

        var attachmentsTransaction: AttachmentDirectoryTransaction?
        do {
            let importer = DocumentMigrationPackageImporter()
            let handler = SwiftDataDocumentMigrationImportHandler(
                modelContext: context,
                savesIncrementally: false,
                attachmentsRootOverride: stagedAttachments
            )
            let package = try importer.importArchive(from: zipURL, using: handler)
            package.cleanup()

            let transaction = try beginAttachmentsTransaction(stagedDirectory: stagedAttachments)
            attachmentsTransaction = transaction
            try importFailureInjectorForTesting?()
            try context.save()
            transaction.finalize()
            attachmentsTransaction = nil
        } catch {
            context.rollback()
            attachmentsTransaction?.rollback()
            throw error
        }
    }

    /// 导入所有数据
    func importAllData(from zipURL: URL, context: ModelContext) async throws {
        let tempDir = FileManager.default.temporaryDirectory
        let extractDir = uniqueTemporaryDirectoryURL(prefix: "ImportAll", in: tempDir)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: extractDir) }

        // 解压 ZIP
        try ArchiveUtility.unzipFile(at: zipURL, to: extractDir)

        try preflightValidateAllDataImport(at: extractDir)

        // 在任何破坏性变更前生成持久化安全备份。即使进程在附件/数据库提交之间
        // 意外退出，用户也始终有一份可独立导入的完整恢复包。
        if let safetyBackupURL = try await createSafetyBackup(context: context, directoryName: "BeforeImport") {
            DebugLog.storage("导入前安全备份已创建: \(safetyBackupURL.path)", level: .info)
        }

        // 配置不是 SwiftData 事务的一部分，因此先保存当前配置；核心提交失败时恢复。
        let configurationRollbackArchive = try await exportConfiguration()
        defer { try? FileManager.default.removeItem(at: configurationRollbackArchive) }

        let attachmentsDir = extractDir.appendingPathComponent("Attachments")
        let stagedAttachmentsDir = try stageAttachmentsImport(from: attachmentsDir)
        defer {
            try? FileManager.default.removeItem(at: stagedAttachmentsDir)
        }

        let previousAutosaveEnabled = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = previousAutosaveEnabled }

        var attachmentsTransaction: AttachmentDirectoryTransaction?
        do {
            // 所有 SwiftData 删除和插入都留在同一个未保存事务中。附件也只写入暂存目录。
            let notesDir = extractDir.appendingPathComponent("Notes")
            if FileManager.default.fileExists(atPath: notesDir.path) {
                let importer = DocumentMigrationPackageImporter()
                let handler = SwiftDataDocumentMigrationImportHandler(
                    modelContext: context,
                    savesIncrementally: false,
                    attachmentsRootOverride: stagedAttachmentsDir
                )
                let package = try importer.importDirectory(from: notesDir, using: handler)
                package.cleanup()
            }

            let configDir = extractDir.appendingPathComponent("Config")
            if FileManager.default.fileExists(atPath: configDir.path) {
                try ConfigurationTransferHelper.importUserDefaults(from: configDir)
                try ConfigurationTransferHelper.importKeyboardShortcuts(from: configDir)
                try ConfigurationTransferHelper.importRadialMenuSettings(from: configDir)
                try ConfigurationTransferHelper.importAppSettings(from: configDir)
                try ConfigurationTransferHelper.importAIConfig(from: configDir)
                // 设备访问密码不随数据包迁移，避免旧备份覆盖当前 Keychain 并锁定用户。
                try ConfigurationTransferHelper.importEncryptedFolders(from: configDir)
                try ConfigurationTransferHelper.importEncryptedData(from: configDir)
            }

            let transaction = try beginAttachmentsTransaction(stagedDirectory: stagedAttachmentsDir)
            attachmentsTransaction = transaction
            try importFailureInjectorForTesting?()
            try context.save()
            transaction.finalize()
            attachmentsTransaction = nil
        } catch {
            context.rollback()
            attachmentsTransaction?.rollback()
            // 尽最大努力恢复非数据库配置；恢复失败会记录，但绝不掩盖原始导入错误。
            do {
                try await importConfiguration(from: configurationRollbackArchive)
            } catch {
                DebugLog.storage("导入失败后恢复配置失败: \(error.localizedDescription)", level: .error)
            }
            throw error
        }
    }

    // MARK: - 导入私有方法

    private func importAllNotes(from directory: URL, context: ModelContext) async throws {
        let importer = DocumentMigrationPackageImporter()
        let handler = SwiftDataDocumentMigrationImportHandler(modelContext: context)
        let package = try importer.importDirectory(from: directory, using: handler)
        package.cleanup()
        DebugLog.storage("笔记导入完成，共 \(package.notes.count) 条", level: .debug)
    }

    private func preflightValidateAllDataImport(at directory: URL) throws {
        let configDir = directory.appendingPathComponent("Config")
        if FileManager.default.fileExists(atPath: configDir.path) {
            try ConfigurationTransferHelper.validateConfigurationImport(at: configDir)
        }

        let notesDir = directory.appendingPathComponent("Notes")
        if FileManager.default.fileExists(atPath: notesDir.path) {
            let importer = DocumentMigrationPackageImporter()
            let handler = InMemoryDocumentMigrationImportHandler()
            let package = try importer.importDirectory(from: notesDir, using: handler)
            package.cleanup()
        }

        let attachmentsDir = directory.appendingPathComponent("Attachments")
        if FileManager.default.fileExists(atPath: attachmentsDir.path) {
            _ = try FileManager.default.contentsOfDirectory(at: attachmentsDir, includingPropertiesForKeys: nil)
        }
    }

    private func stageAttachmentsImport(from directory: URL) throws -> URL {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }

        let notebookDataDir = storage.appendingPathComponent("NotebookData", isDirectory: true)
        try FileManager.default.createDirectory(at: notebookDataDir, withIntermediateDirectories: true)

        let stagingDir = notebookDataDir.appendingPathComponent("AttachmentsImportStaging_\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stagingDir, withIntermediateDirectories: true)

        if FileManager.default.fileExists(atPath: directory.path) {
            let contents = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            for item in contents {
                let destination = stagingDir.appendingPathComponent(item.lastPathComponent)
                try FileManager.default.copyItem(at: item, to: destination)
            }
        }

        return stagingDir
    }

    private func beginAttachmentsTransaction(stagedDirectory: URL) throws -> AttachmentDirectoryTransaction {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }
        let notebookDataDir = storage.appendingPathComponent("NotebookData", isDirectory: true)
        let liveDir = notebookDataDir.appendingPathComponent("Attachments", isDirectory: true)
        let backupDir = notebookDataDir.appendingPathComponent("AttachmentsBackup_\(UUID().uuidString)", isDirectory: true)
        let transaction = AttachmentDirectoryTransaction(
            stagedDirectory: stagedDirectory,
            liveDirectory: liveDir,
            backupDirectory: backupDir
        )
        try transaction.begin()
        return transaction
    }

    private func createSafetyBackup(context: ModelContext, directoryName: String) async throws -> URL? {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }
        guard try !context.fetch(FetchDescriptor<BlockDocumentLibraryEntity>()).isEmpty else {
            return nil
        }
        let temporaryArchive = try await exportAllData(context: context)
        defer { try? FileManager.default.removeItem(at: temporaryArchive) }

        let backupDirectory = storage
            .appendingPathComponent("NotebookData", isDirectory: true)
            .appendingPathComponent("Backups", isDirectory: true)
            .appendingPathComponent(directoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: backupDirectory, withIntermediateDirectories: true)
        let destination = backupDirectory.appendingPathComponent(
            "Notebook_\(directoryName)_\(formattedDate())_\(UUID().uuidString).zip"
        )
        try FileManager.default.copyItem(at: temporaryArchive, to: destination)
        return destination
    }

    // MARK: - 重置功能

    /// 重置所有数据（删除所有笔记、文件夹、标签、附件和配置）
    func resetAllData(context: ModelContext) async throws {
        DebugLog.storage("开始重置所有数据...", level: .debug)
        if let safetyBackupURL = try await createSafetyBackup(context: context, directoryName: "BeforeReset") {
            DebugLog.storage("重置前安全备份已创建: \(safetyBackupURL.path)", level: .info)
        }

        guard let storage = StorageLocationManager.shared.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }
        let notebookDataDirectory = storage.appendingPathComponent("NotebookData", isDirectory: true)
        let emptyAttachmentsDirectory = notebookDataDirectory
            .appendingPathComponent("AttachmentsResetStaging_\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: emptyAttachmentsDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: emptyAttachmentsDirectory) }

        let previousAutosaveEnabled = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = previousAutosaveEnabled }

        var attachmentsTransaction: AttachmentDirectoryTransaction?
        do {
            try deleteAllEntities(context: context)
            let transaction = try beginAttachmentsTransaction(stagedDirectory: emptyAttachmentsDirectory)
            attachmentsTransaction = transaction
            try resetFailureInjectorForTesting?()
            try context.save()
            transaction.finalize()
            attachmentsTransaction = nil

            // 数据提交成功后才清理非关键配置。存储位置和安全备份始终保留。
            resetAllSettings()
            resetKeyboardShortcuts()
            resetRadialMenuSettings()
            DebugLog.storage("重置完成", level: .debug)
        } catch {
            context.rollback()
            attachmentsTransaction?.rollback()
            throw error
        }
    }

    private func deleteAllEntities(context: ModelContext) throws {
        try deleteAll(BlockDocumentBlockEntity.self, context: context)
        try deleteAll(BlockDocumentAssetEntity.self, context: context)
        try deleteAll(TodoStepEntity.self, context: context)
        try deleteAll(BlockDocumentNoteTagEntity.self, context: context)
        try deleteAll(BlockDocumentNoteVersionEntity.self, context: context)
        try deleteAll(BlockDocumentNoteSyncStateEntity.self, context: context)
        try deleteAll(BlockDocumentDeletedNoteTombstoneEntity.self, context: context)
        try deleteAll(BlockDocumentNoteEntity.self, context: context)
        try deleteAll(BlockDocumentTagEntity.self, context: context)
        try deleteAll(BlockDocumentFolderEntity.self, context: context)
        try deleteAll(BlockDocumentLibraryEntity.self, context: context)
    }

    private func deleteAll<T: PersistentModel>(_ type: T.Type, context: ModelContext) throws {
        for model in try context.fetch(FetchDescriptor<T>()) {
            context.delete(model)
        }
    }

    /// 重置所有 UserDefaults 设置
    private func resetAllSettings() {
        let defaults = NotebookDefaults.shared

        // 清除最近选择的文件夹和笔记
        defaults.removeObject(forKey: "lastSelectedFolder")
        defaults.removeObject(forKey: "lastSelectedNote")

        // 清除搜索历史
        defaults.removeObject(forKey: "searchHistory")

        // 清除应用设置
        defaults.removeObject(forKey: "foldersExpanded")
        defaults.removeObject(forKey: "tagsExpanded")
        defaults.removeObject(forKey: "startupBehavior")
        defaults.removeObject(forKey: "accentColor")
        defaults.removeObject(forKey: "logger.file_logging_enabled")
        defaults.removeObject(forKey: "logger.keep_historical_files")
        defaults.removeObject(forKey: "update.github_repository_url")
        _ = GitHubTokenManager.shared.deleteToken()

        // 保留 storageDirectoryBookmark：安全备份仍位于该资料库中，重启后必须可访问。

        DebugLog.storage("已重置所有 UserDefaults 设置", level: .debug)
    }

    /// 重置快捷键设置
    private func resetKeyboardShortcuts() {
        KeyboardShortcutManager.shared.resetToDefaults()
        DebugLog.storage("已重置快捷键设置", level: .debug)
    }

    /// 重置环形菜单设置
    private func resetRadialMenuSettings() {
        let defaults = NotebookDefaults.shared
        defaults.removeObject(forKey: "radialMenuEnabled")
        defaults.removeObject(forKey: "radialMenuTrigger")
        defaults.removeObject(forKey: "radialMenuRadius")
        defaults.removeObject(forKey: "radialMenuItemSize")
        defaults.removeObject(forKey: "radialMenuScale")
        defaults.removeObject(forKey: "radialMenuItems")
        DebugLog.storage("已重置环形菜单设置", level: .debug)
    }

    private func persistentAttachmentsRootDirectory() throws -> URL {
        let storage = StorageLocationManager.shared
        guard let base = storage.baseDirectoryURL else {
            throw NSError(
                domain: "DataExportManager",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "未配置数据存储目录"]
            )
        }

        return try storage.withSecurityScopedAccess(base) {
            try storage.ensureDirectoryStructureExists()
            let attachmentsRoot = try storage.attachmentsDirectoryURL()
            try FileManager.default.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
            return attachmentsRoot
        }
    }

    private func copyItemReplacingIfNeeded(from sourceURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        let destinationDirectory = destinationURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)

        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }
        try fileManager.copyItem(at: sourceURL, to: destinationURL)
    }
}
