import Foundation
import SwiftData
import AppKit
import Compression

/// 数据导出管理器 - 打包配置和数据
@MainActor
final class DataExportManager {
    static let shared = DataExportManager()

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

    // MARK: - 导出配置

    /// 打包当前配置到 zip 文件
    func exportConfiguration() async throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let exportDir = uniqueTemporaryDirectoryURL(prefix: "NotebookConfig", in: tempDir)

        // 创建临时目录
        try FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)

        // 导出 UserDefaults 配置
        try exportUserDefaults(to: exportDir)

        // 导出快捷键配置
        try exportKeyboardShortcuts(to: exportDir)

        // 导出环形菜单配置
        try exportRadialMenuSettings(to: exportDir)

        // 导出应用设置
        try exportAppSettings(to: exportDir)

        // 导出 AI 配置
        try exportAIConfig(to: exportDir)

        // 创建 zip 文件
        let zipURL = uniqueExportArchiveURL(prefix: "NotebookConfig", in: tempDir)
        try createZip(from: exportDir, to: zipURL)

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
        try exportUserDefaults(to: configDir)
        try exportKeyboardShortcuts(to: configDir)
        try exportRadialMenuSettings(to: configDir)
        try exportAppSettings(to: configDir)

        // 导出 AI 配置
        try exportAIConfig(to: configDir)

        // 导出密码配置
        try exportPasswordConfig(to: configDir)

        // 导出加密文件夹配置
        try exportEncryptedFolders(to: configDir)

        // 导出加密相关数据
        try exportEncryptedData(to: configDir)

        // 导出所有笔记
        try await exportAllNotes(to: exportDir.appendingPathComponent("Notes"), context: context)

        // 导出附件
        try exportAttachments(to: exportDir.appendingPathComponent("Attachments"))

        // 创建 zip 文件
        let zipURL = uniqueExportArchiveURL(prefix: "NotebookData", in: tempDir)
        try createZip(from: exportDir, to: zipURL)

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
        try createZip(from: exportDir, to: zipURL)

        // 清理临时目录
        try? FileManager.default.removeItem(at: exportDir)

        return zipURL
    }

    func extractArchive(at zipURL: URL, to destinationURL: URL) throws {
        try unzipFile(at: zipURL, to: destinationURL)
    }

    func createArchiveForTesting(from directoryURL: URL, prefix: String = "NotebookTest") throws -> URL {
        let zipURL = uniqueExportArchiveURL(prefix: prefix, in: FileManager.default.temporaryDirectory)
        try createZip(from: directoryURL, to: zipURL)
        return zipURL
    }

    // MARK: - 私有方法

    private func exportUserDefaults(to directory: URL) throws {
        let defaults = UserDefaults.standard
        var config: [String: Any] = [:]

        // 收集所有相关的 UserDefaults 键
        let keys = [
            "keyboardShortcuts",
            "radialMenuEnabled",
            "radialMenuTrigger",
            "radialMenuRadius",
            "radialMenuItemSize",
            "radialMenuScale",
            "radialMenuItems",
            "sidebar_folders_expanded",
            "sidebar_tags_expanded",
            "last_selected_note_id",
            "last_selected_folder",
            "startup_behavior",
            "accent_color",
            "icloud_sync_enabled",
            "logger.file_logging_enabled",
            "logger.keep_historical_files",
            "update.github_repository_url"
        ]

        for key in keys {
            if let value = defaults.object(forKey: key) {
                config[key] = value
            }
        }

        let configURL = directory.appendingPathComponent("UserDefaults.plist")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: config, format: .xml, options: 0)
            .write(to: configURL)
    }

    private func exportKeyboardShortcuts(to directory: URL) throws {
        let shortcuts = KeyboardShortcutManager.shared.shortcuts

        // 转换为可编码的字典
        var shortcutsDict: [String: [String: Any]] = [:]
        for (action, shortcut) in shortcuts {
            shortcutsDict[action.rawValue] = [
                "key": shortcut.key.rawValue,
                "modifiers": shortcut.modifiers.rawValue
            ]
        }

        let shortcutsURL = directory.appendingPathComponent("KeyboardShortcuts.plist")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: shortcutsDict, format: .xml, options: 0)
            .write(to: shortcutsURL)
    }

    private func exportRadialMenuSettings(to directory: URL) throws {
        let settings = RadialMenuSettings.shared
        let config: [String: Any] = [
            "isEnabled": settings.isEnabled,
            "trigger": settings.trigger.rawValue,
            "menuRadius": settings.menuRadius,
            "itemSize": settings.itemSize,
            "menuScale": settings.menuScale
        ]

        let configURL = directory.appendingPathComponent("RadialMenuSettings.plist")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: config, format: .xml, options: 0)
            .write(to: configURL)
    }

    private func exportAppSettings(to directory: URL) throws {
        let settings = AppSettings.shared
        let config: [String: Any] = [
            "foldersExpanded": settings.isFoldersExpanded,
            "tagsExpanded": settings.isTagsExpanded,
            "startupBehavior": settings.startupBehavior.rawValue
        ]

        let configURL = directory.appendingPathComponent("AppSettings.plist")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: config, format: .xml, options: 0)
            .write(to: configURL)
    }

    private func exportAIConfig(to directory: URL) throws {
        let aiManager = AIConfigManager.shared

        // 导出 AI 服务配置
        let configsData = try JSONEncoder().encode(aiManager.configs)
        let configsURL = directory.appendingPathComponent("AIConfigs.json")
        try configsData.write(to: configsURL)

        // 导出选中的配置 ID
        var selectedConfig: [String: String] = [:]
        if let selectedConfigID = aiManager.selectedConfigID?.uuidString {
            selectedConfig["selectedConfigID"] = selectedConfigID
        }
        let selectedConfigURL = directory.appendingPathComponent("AISelectedConfig.plist")
        try PropertyListSerialization.data(fromPropertyList: selectedConfig, format: .xml, options: 0)
            .write(to: selectedConfigURL)

        print("[Export] 已导出 \(aiManager.configs.count) 个 AI 配置")
    }

    private func exportPasswordConfig(to directory: URL) throws {
        // 导出密码配置（哈希和盐值）
        if let passwordConfig = PasswordManager.shared.exportPasswordConfig() {
            let passwordURL = directory.appendingPathComponent("PasswordConfig.plist")
            try PropertyListSerialization.data(fromPropertyList: passwordConfig, format: .xml, options: 0)
                .write(to: passwordURL)
            print("[Export] 已导出密码配置")
        } else {
            print("[Export] 没有设置密码，跳过导出")
        }
    }

    private func exportEncryptedFolders(to directory: URL) throws {
        // 从 UserDefaults 导出加密文件夹列表
        let foldersKey = "encryptedFolders"
        let folderNamesKey = "encrypted_folder_names"
        
        var config: [String: Any] = [:]
        
        // 导出加密文件夹列表
        if let foldersData = UserDefaults.standard.data(forKey: foldersKey) {
            config["foldersData"] = foldersData.base64EncodedString()
        }
        
        // 导出文件夹名称映射
        if let folderNames = UserDefaults.standard.dictionary(forKey: folderNamesKey) {
            config["folderNames"] = folderNames
        }
        
        let configURL = directory.appendingPathComponent("EncryptedFolders.plist")
        try PropertyListSerialization.data(fromPropertyList: config, format: .xml, options: 0)
            .write(to: configURL)
        print("[Export] 已导出加密文件夹配置")
    }

    private func exportEncryptedData(to directory: URL) throws {
        // 导出加密相关数据（加密笔记ID列表和映射关系）
        let encryptedData = EncryptedFolderManager.shared.exportEncryptedData()
        
        let configURL = directory.appendingPathComponent("EncryptedData.plist")
        try PropertyListSerialization.data(fromPropertyList: encryptedData, format: .xml, options: 0)
            .write(to: configURL)
        print("[Export] 已导出加密数据")
    }

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
                    tagIDs: decodeUUIDList(note.tagIDs),
                    viewMode: note.viewMode,
                    deletedAt: note.deletedAt,
                    originalFolderID: note.originalFolderID,
                    originalFolderName: note.originalFolderName,
                    blockCount: document.blocks.count,
                    assetCount: migratedAssets.count,
                    documentPath: "Notes/\(note.id.uuidString)/document.json"
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
                    createdAt: $0.createdAt
                )
            },
            tags: tags.map {
                .init(
                    id: $0.id,
                    name: $0.name,
                    color: $0.color,
                    createdAt: $0.createdAt
                )
            }
        )

        try writeJSON(package, to: directory.appendingPathComponent("manifest.json"))
    }

    private func decodeUUIDList(_ raw: String) -> [UUID] {
        raw
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .compactMap(UUID.init(uuidString:))
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
            try? FileManager.default.copyItem(at: item, to: destination)
        }
    }

    private func createZip(from sourceURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default

        // 如果目标文件已存在，先删除
        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }

        // 使用原生 Swift 创建 ZIP 归档
        try createZipArchive(sourceDirectory: sourceURL, destinationURL: destinationURL)
    }

    /// 使用原生 Swift 创建 ZIP 归档
    private func createZipArchive(sourceDirectory: URL, destinationURL: URL) throws {
        print("[Export] 开始创建 ZIP 归档...")
        print("[Export] 源目录: \(sourceDirectory.path)")
        print("[Export] 目标文件: \(destinationURL.path)")

        // 递归收集所有文件
        var files: [(relativePath: String, fileURL: URL)] = []
        try collectFiles(in: sourceDirectory, relativePath: "", files: &files)
        print("[Export] 收集到 \(files.count) 个文件")

        // 创建 ZIP 数据
        var zipData = Data()
        var fileEntries: [(relativePath: String, fileData: Data, crc32: UInt32, localHeaderSize: Int)] = []

        // 写入本地文件头
        for (index, (relativePath, fileURL)) in files.enumerated() {
            print("[Export] 处理文件 \(index + 1)/\(files.count): \(relativePath)")

            do {
                let fileData = try Data(contentsOf: fileURL)
                let crc32 = calculateCRC32(fileData)
                let compressedData = compressData(fileData)

                // 本地文件头
                let localHeader = createLocalFileHeader(
                    fileName: relativePath,
                    compressedSize: compressedData.count,
                    uncompressedSize: fileData.count,
                    crc32: crc32
                )
                zipData.append(localHeader)
                zipData.append(compressedData)

                // 记录文件信息用于中央目录
                fileEntries.append((relativePath: relativePath, fileData: fileData, crc32: crc32, localHeaderSize: localHeader.count))
            } catch {
                print("[Export Error] 无法读取文件 \(relativePath): \(error)")
                throw error
            }
        }

        print("[Export] 写入中央目录...")

        // 写入中央目录
        var centralDirectory = Data()
        var centralDirectoryOffset = 0

        for entry in fileEntries {
            let compressedData = compressData(entry.fileData)

            let centralHeader = createCentralDirectoryHeader(
                fileName: entry.relativePath,
                compressedSize: compressedData.count,
                uncompressedSize: entry.fileData.count,
                crc32: entry.crc32,
                localHeaderOffset: centralDirectoryOffset
            )
            centralDirectory.append(centralHeader)
            centralDirectoryOffset += entry.localHeaderSize + compressedData.count
        }

        zipData.append(centralDirectory)

        // 写入结束记录
        let endRecord = createEndOfCentralDirectory(
            numEntries: files.count,
            centralDirectorySize: centralDirectory.count,
            centralDirectoryOffset: centralDirectoryOffset
        )
        zipData.append(endRecord)

        print("[Export] 写入 ZIP 文件，大小: \(zipData.count) bytes...")

        // 写入文件
        do {
            try zipData.write(to: destinationURL)
            print("[Export] ZIP 文件创建成功")
        } catch {
            print("[Export Error] 写入 ZIP 文件失败: \(error)")
            throw error
        }
    }

    /// 递归收集目录中的所有文件
    private func collectFiles(in directory: URL, relativePath: String, files: inout [(relativePath: String, fileURL: URL)]) throws {
        let fileManager = FileManager.default
        let contents = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)

        for item in contents {
            let itemName = item.lastPathComponent
            let itemRelativePath = relativePath.isEmpty ? itemName : "\(relativePath)/\(itemName)"

            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: item.path, isDirectory: &isDirectory) {
                if isDirectory.boolValue {
                    // 递归处理子目录
                    try collectFiles(in: item, relativePath: itemRelativePath, files: &files)
                } else {
                    // 添加文件
                    files.append((relativePath: itemRelativePath, fileURL: item))
                }
            }
        }
    }

    // MARK: - ZIP 格式辅助方法

    /// 计算 CRC32
    private func calculateCRC32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        let table = crc32Table

        for byte in data {
            let index = Int((crc ^ UInt32(byte)) & 0xFF)
            crc = (crc >> 8) ^ table[index]
        }

        return crc ^ 0xFFFFFFFF
    }

    /// CRC32 查找表
    private var crc32Table: [UInt32] = {
        var table = [UInt32](repeating: 0, count: 256)
        for i in 0..<256 {
            var crc = UInt32(i)
            for _ in 0..<8 {
                if crc & 1 == 1 {
                    crc = (crc >> 1) ^ 0xEDB88320
                } else {
                    crc >>= 1
                }
            }
            table[i] = crc
        }
        return table
    }()

    /// 压缩数据（使用存储模式，不压缩）
    private func compressData(_ data: Data) -> Data {
        // 使用存储模式（不压缩），简化实现
        return data
    }

    /// 创建本地文件头
    private func createLocalFileHeader(fileName: String, compressedSize: Int, uncompressedSize: Int, crc32: UInt32) -> Data {
        var header = Data()
        let fileNameData = fileName.data(using: .utf8)!

        // 本地文件头签名
        header.append(contentsOf: [0x50, 0x4B, 0x03, 0x04])
        // 版本（2.0）
        header.append(contentsOf: [0x14, 0x00])
        // 通用标志
        header.append(contentsOf: [0x00, 0x00])
        // 压缩方法（0 = 存储）
        header.append(contentsOf: [0x00, 0x00])
        // 修改时间/日期
        header.append(contentsOf: [0x00, 0x00, 0x00, 0x00])
        // CRC32
        header.append(contentsOf: withUnsafeBytes(of: crc32.littleEndian) { Array($0) })
        // 压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(compressedSize).littleEndian) { Array($0) })
        // 未压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(uncompressedSize).littleEndian) { Array($0) })
        // 文件名长度
        header.append(contentsOf: withUnsafeBytes(of: UInt16(fileNameData.count).littleEndian) { Array($0) })
        // 额外字段长度
        header.append(contentsOf: [0x00, 0x00])
        // 文件名
        header.append(fileNameData)

        return header
    }

    /// 创建中央目录头
    private func createCentralDirectoryHeader(fileName: String, compressedSize: Int, uncompressedSize: Int, crc32: UInt32, localHeaderOffset: Int) -> Data {
        var header = Data()
        let fileNameData = fileName.data(using: .utf8)!

        // 中央目录签名
        header.append(contentsOf: [0x50, 0x4B, 0x01, 0x02])
        // 创建者版本
        header.append(contentsOf: [0x14, 0x00])
        // 所需版本
        header.append(contentsOf: [0x14, 0x00])
        // 通用标志
        header.append(contentsOf: [0x00, 0x00])
        // 压缩方法
        header.append(contentsOf: [0x00, 0x00])
        // 修改时间/日期
        header.append(contentsOf: [0x00, 0x00, 0x00, 0x00])
        // CRC32
        header.append(contentsOf: withUnsafeBytes(of: crc32.littleEndian) { Array($0) })
        // 压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(compressedSize).littleEndian) { Array($0) })
        // 未压缩大小
        header.append(contentsOf: withUnsafeBytes(of: UInt32(uncompressedSize).littleEndian) { Array($0) })
        // 文件名长度
        header.append(contentsOf: withUnsafeBytes(of: UInt16(fileNameData.count).littleEndian) { Array($0) })
        // 额外字段长度
        header.append(contentsOf: [0x00, 0x00])
        // 注释长度
        header.append(contentsOf: [0x00, 0x00])
        // 磁盘号
        header.append(contentsOf: [0x00, 0x00])
        // 内部文件属性
        header.append(contentsOf: [0x00, 0x00])
        // 外部文件属性
        header.append(contentsOf: [0x00, 0x00, 0x00, 0x00])
        // 本地文件头偏移
        header.append(contentsOf: withUnsafeBytes(of: UInt32(localHeaderOffset).littleEndian) { Array($0) })
        // 文件名
        header.append(fileNameData)

        return header
    }

    /// 创建中央目录结束记录
    private func createEndOfCentralDirectory(numEntries: Int, centralDirectorySize: Int, centralDirectoryOffset: Int) -> Data {
        var record = Data()

        // 结束记录签名
        record.append(contentsOf: [0x50, 0x4B, 0x05, 0x06])
        // 磁盘号
        record.append(contentsOf: [0x00, 0x00])
        // 中央目录起始磁盘
        record.append(contentsOf: [0x00, 0x00])
        // 磁盘上的条目数
        record.append(contentsOf: withUnsafeBytes(of: UInt16(numEntries).littleEndian) { Array($0) })
        // 总条目数
        record.append(contentsOf: withUnsafeBytes(of: UInt16(numEntries).littleEndian) { Array($0) })
        // 中央目录大小
        record.append(contentsOf: withUnsafeBytes(of: UInt32(centralDirectorySize).littleEndian) { Array($0) })
        // 中央目录偏移
        record.append(contentsOf: withUnsafeBytes(of: UInt32(centralDirectoryOffset).littleEndian) { Array($0) })
        // 注释长度
        record.append(contentsOf: [0x00, 0x00])

        return record
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
        try unzipFile(at: zipURL, to: extractDir)

        try validateConfigurationImport(at: extractDir)

        // 导入配置
        try importUserDefaults(from: extractDir)
        try importKeyboardShortcuts(from: extractDir)
        try importRadialMenuSettings(from: extractDir)
        try importAppSettings(from: extractDir)
        try importAIConfig(from: extractDir)
    }

    /// 导入笔记
    func importNotes(from zipURL: URL, context: ModelContext) async throws {
        let importer = DocumentMigrationPackageImporter()
        let handler = SwiftDataDocumentMigrationImportHandler(modelContext: context)
        let package = try importer.importArchive(from: zipURL, using: handler)
        package.cleanup()
    }

    /// 导入所有数据
    func importAllData(from zipURL: URL, context: ModelContext) async throws {
        let tempDir = FileManager.default.temporaryDirectory
        let extractDir = uniqueTemporaryDirectoryURL(prefix: "ImportAll", in: tempDir)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: extractDir) }

        // 解压 ZIP
        try unzipFile(at: zipURL, to: extractDir)

        try preflightValidateAllDataImport(at: extractDir)

        let attachmentsDir = extractDir.appendingPathComponent("Attachments")
        let stagedAttachmentsDir = try stageAttachmentsImportIfNeeded(from: attachmentsDir)
        defer {
            if let stagedAttachmentsDir {
                try? FileManager.default.removeItem(at: stagedAttachmentsDir)
            }
        }

        // 先导入笔记和附件，确认核心数据可落盘，再覆盖配置
        let notesDir = extractDir.appendingPathComponent("Notes")
        if FileManager.default.fileExists(atPath: notesDir.path) {
            try await importAllNotes(from: notesDir, context: context)
        }

        if let stagedAttachmentsDir {
            try commitStagedAttachmentsImport(from: stagedAttachmentsDir)
        }

        // 导入配置
        let configDir = extractDir.appendingPathComponent("Config")
        if FileManager.default.fileExists(atPath: configDir.path) {
            try importUserDefaults(from: configDir)
            try importKeyboardShortcuts(from: configDir)
            try importRadialMenuSettings(from: configDir)
            try importAppSettings(from: configDir)
            try importAIConfig(from: configDir)
            try importPasswordConfig(from: configDir)
            try importEncryptedFolders(from: configDir)
            try importEncryptedData(from: configDir)
        }
    }

    // MARK: - 导入私有方法

    private func unzipFile(at zipURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: destinationURL, withIntermediateDirectories: true)

        // 读取 ZIP 文件数据
        let zipData = try Data(contentsOf: zipURL)

        // 解析并解压 ZIP 文件
        try extractZipData(zipData, to: destinationURL)
    }

    /// 解析并解压 ZIP 数据
    private func extractZipData(_ zipData: Data, to destinationURL: URL) throws {
        var offset = 0
        var fileEntries: [ZipEntry] = []

        // 首先扫描所有本地文件头
        while offset < zipData.count - 30 {
            // 检查本地文件头签名 (0x04034b50)
            guard zipData.count >= offset + 4 else { break }
            let signature = zipData.subdata(in: offset..<offset+4).withUnsafeBytes { $0.load(as: UInt32.self) }

            if signature == 0x04034b50 {
                // 解析本地文件头
                let entry = try parseLocalFileHeader(zipData, offset: offset)
                fileEntries.append(entry)
                offset = entry.nextOffset
            } else if signature == 0x02014b50 {
                // 中央目录开始，停止扫描
                break
            } else {
                offset += 1
            }
        }

        // 解压每个文件
        for entry in fileEntries {
            // 安全检查：防止路径遍历攻击
            let sanitizedName = sanitizeZipEntryName(entry.name)
            guard !sanitizedName.isEmpty else {
                print("[Import Warning] 跳过无效文件名: \(entry.name)")
                continue
            }

            let fileURL = destinationURL.appendingPathComponent(sanitizedName)

            // 确保文件在目标目录内
            let resolvedPath = fileURL.resolvingSymlinksInPath().path
            let resolvedDest = destinationURL.resolvingSymlinksInPath().path
            guard resolvedPath.hasPrefix(resolvedDest) else {
                print("[Import Warning] 检测到路径遍历攻击，跳过: \(entry.name)")
                continue
            }

            let fileDir = fileURL.deletingLastPathComponent()

            // 创建目录结构
            if !FileManager.default.fileExists(atPath: fileDir.path) {
                try FileManager.default.createDirectory(at: fileDir, withIntermediateDirectories: true)
            }

            // 解压数据
            let uncompressedData: Data
            if entry.compressionMethod == 0 {
                // 存储模式（未压缩）
                uncompressedData = entry.data
            } else if entry.compressionMethod == 8 {
                // DEFLATE 压缩 - 使用 zlib 解压
                uncompressedData = try decompressData(entry.data, uncompressedSize: entry.uncompressedSize)
            } else {
                throw NSError(domain: "DataExportManager", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported compression method: \(entry.compressionMethod)"])
            }

            // 写入文件
            try uncompressedData.write(to: fileURL)
        }

        print("[Import] 解压完成，共 \(fileEntries.count) 个文件")
    }

    /// ZIP 文件条目
    private struct ZipEntry {
        let name: String
        let data: Data
        let nextOffset: Int
        let compressedSize: Int
        let uncompressedSize: Int
        let compressionMethod: UInt16
    }

    /// 解析本地文件头
    private func parseLocalFileHeader(_ zipData: Data, offset: Int) throws -> ZipEntry {
        guard zipData.count >= offset + 30 else {
            throw NSError(domain: "DataExportManager", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid local file header"])
        }

        // 跳过签名 (4 bytes)
        var pos = offset + 4

        // 版本 (2 bytes) + 标志 (2 bytes) + 压缩方法 (2 bytes)
        let compressionMethod = zipData.subdata(in: pos+4..<pos+6).withUnsafeBytes { $0.load(as: UInt16.self) }
        pos += 6

        // 修改时间 (2 bytes) + 修改日期 (2 bytes)
        pos += 4

        // CRC32 (4 bytes)
        pos += 4

        // 压缩大小 (4 bytes)
        let compressedSize = Int(zipData.subdata(in: pos..<pos+4).withUnsafeBytes { $0.load(as: UInt32.self) })
        pos += 4

        // 未压缩大小 (4 bytes)
        let uncompressedSize = Int(zipData.subdata(in: pos..<pos+4).withUnsafeBytes { $0.load(as: UInt32.self) })
        pos += 4

        // 文件名长度 (2 bytes)
        let fileNameLength = Int(zipData.subdata(in: pos..<pos+2).withUnsafeBytes { $0.load(as: UInt16.self) })
        pos += 2

        // 额外字段长度 (2 bytes)
        let extraFieldLength = Int(zipData.subdata(in: pos..<pos+2).withUnsafeBytes { $0.load(as: UInt16.self) })
        pos += 2

        // 文件名
        guard zipData.count >= pos + fileNameLength else {
            throw NSError(domain: "DataExportManager", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid file name"])
        }
        let fileNameData = zipData.subdata(in: pos..<pos+fileNameLength)
        let fileName = String(data: fileNameData, encoding: .utf8) ?? "unknown"
        pos += fileNameLength

        // 跳过额外字段
        pos += extraFieldLength

        // 文件数据
        guard zipData.count >= pos + compressedSize else {
            throw NSError(domain: "DataExportManager", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid file data"])
        }
        let fileData = zipData.subdata(in: pos..<pos+compressedSize)
        pos += compressedSize

        return ZipEntry(name: fileName, data: fileData, nextOffset: pos, compressedSize: compressedSize, uncompressedSize: uncompressedSize, compressionMethod: compressionMethod)
    }

    /// 解压 DEFLATE 压缩的数据
    private func decompressData(_ data: Data, uncompressedSize: Int) throws -> Data {
        // 使用 Compression 框架解压
        guard !data.isEmpty else { return Data() }

        let bufferSize = max(uncompressedSize, 4096)
        let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { destinationBuffer.deallocate() }

        let result = data.withUnsafeBytes { sourcePtr in
            compression_decode_buffer(
                destinationBuffer,
                bufferSize,
                sourcePtr.bindMemory(to: UInt8.self).baseAddress!,
                data.count,
                nil,
                COMPRESSION_ZLIB
            )
        }

        guard result != 0 else {
            throw NSError(domain: "DataExportManager", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to decompress data"])
        }

        return Data(bytes: destinationBuffer, count: result)
    }

    /// 清理 ZIP 条目文件名，防止路径遍历攻击
    private func sanitizeZipEntryName(_ name: String) -> String {
        // 移除前导的 /
        var sanitized = name
        while sanitized.hasPrefix("/") {
            sanitized.removeFirst()
        }

        // 分割路径组件
        let components = sanitized.split(separator: "/").map(String.init)

        // 过滤掉 .. 和 . 以及空组件
        var validComponents: [String] = []
        for component in components {
            if component == ".." || component == "." || component.isEmpty {
                continue
            }
            // 检查非法字符
            if component.contains("..") || component.contains("//") {
                continue
            }
            validComponents.append(component)
        }

        return validComponents.joined(separator: "/")
    }

    private func importUserDefaults(from directory: URL) throws {
        let configURL = directory.appendingPathComponent("UserDefaults.plist")
        guard FileManager.default.fileExists(atPath: configURL.path) else { return }

        guard let config = try PropertyListSerialization.propertyList(from: Data(contentsOf: configURL), format: nil) as? [String: Any] else {
            return
        }

        let skippedKeys: Set<String> = ["storageDirectoryBookmark"]
        let defaults = UserDefaults.standard
        for (key, value) in config {
            if skippedKeys.contains(key) {
                continue
            }
            defaults.set(value, forKey: key)
        }
    }

    private func importKeyboardShortcuts(from directory: URL) throws {
        let shortcutsURL = directory.appendingPathComponent("KeyboardShortcuts.plist")
        guard FileManager.default.fileExists(atPath: shortcutsURL.path) else { return }

        guard let shortcutsDict = try PropertyListSerialization.propertyList(from: Data(contentsOf: shortcutsURL), format: nil) as? [String: [String: Any]] else {
            return
        }

        var shortcuts: [ShortcutAction: KeyboardShortcut] = [:]
        for (actionRaw, shortcutDict) in shortcutsDict {
            guard let action = ShortcutAction(rawValue: actionRaw),
                  let keyRaw = shortcutDict["key"] as? String,
                  let key = KeyEquivalent(rawValue: keyRaw),
                  let modifiersRaw = shortcutDict["modifiers"] as? Int else {
                continue
            }
            let modifiers = ModifierFlags(rawValue: modifiersRaw)
            shortcuts[action] = KeyboardShortcut(key: key, modifiers: modifiers)
        }

        KeyboardShortcutManager.shared.shortcuts = shortcuts
    }

    private func importRadialMenuSettings(from directory: URL) throws {
        guard let settings = try loadRadialMenuSettings(from: directory) else { return }

        let defaults = UserDefaults.standard
        if let isEnabled = settings["isEnabled"] as? Bool {
            defaults.set(isEnabled, forKey: "radialMenuEnabled")
        }
        if let trigger = settings["trigger"] as? String {
            defaults.set(trigger, forKey: "radialMenuTrigger")
        }
        if let menuRadius = settings["menuRadius"] as? CGFloat {
            defaults.set(menuRadius, forKey: "radialMenuRadius")
        }
        if let itemSize = settings["itemSize"] as? CGFloat {
            defaults.set(itemSize, forKey: "radialMenuItemSize")
        }
        if let menuScale = settings["menuScale"] as? CGFloat {
            defaults.set(menuScale, forKey: "radialMenuScale")
        }
        if let menuItems = settings["menuItems"] as? [[String: Any]] {
            if let itemsData = try? JSONSerialization.data(withJSONObject: menuItems) {
                defaults.set(itemsData, forKey: "radialMenuItems")
            }
        }
    }

    private func importAppSettings(from directory: URL) throws {
        let settingsURL = directory.appendingPathComponent("AppSettings.plist")
        guard FileManager.default.fileExists(atPath: settingsURL.path) else { return }

        guard let settings = try PropertyListSerialization.propertyList(from: Data(contentsOf: settingsURL), format: nil) as? [String: Any] else {
            return
        }

        let defaults = UserDefaults.standard
        for (key, value) in settings {
            defaults.set(value, forKey: key)
        }
    }

    private func importAIConfig(from directory: URL) throws {
        // 导入 AI 服务配置
        let configsURL = directory.appendingPathComponent("AIConfigs.json")
        if FileManager.default.fileExists(atPath: configsURL.path) {
            let configsData = try Data(contentsOf: configsURL)
            if let configs = try? JSONDecoder().decode([AIServiceConfig].self, from: configsData) {
                // 保存到 UserDefaults
                if let encoded = try? JSONEncoder().encode(configs) {
                    UserDefaults.standard.set(encoded, forKey: "ai.serviceConfigs")
                }
                print("[Import] 已导入 \(configs.count) 个 AI 配置")
            }
        }

        // 导入选中的配置 ID
        let selectedConfigURL = directory.appendingPathComponent("AISelectedConfig.plist")
        if FileManager.default.fileExists(atPath: selectedConfigURL.path) {
            guard let selectedConfig = try PropertyListSerialization.propertyList(from: Data(contentsOf: selectedConfigURL), format: nil) as? [String: Any] else {
                return
            }
            if let selectedID = selectedConfig["selectedConfigID"] as? String {
                UserDefaults.standard.set(selectedID, forKey: "ai.selectedConfigID")
            } else {
                UserDefaults.standard.removeObject(forKey: "ai.selectedConfigID")
            }
        }
    }

    private func importPasswordConfig(from directory: URL) throws {
        let passwordURL = directory.appendingPathComponent("PasswordConfig.plist")
        guard FileManager.default.fileExists(atPath: passwordURL.path) else {
            print("[Import] 未找到密码配置文件")
            return
        }

        guard let passwordConfig = try PropertyListSerialization.propertyList(from: Data(contentsOf: passwordURL), format: nil) as? [String: String] else {
            print("[Import] 密码配置格式错误")
            return
        }

        if PasswordManager.shared.importPasswordConfig(passwordConfig) {
            print("[Import] 已导入密码配置")
        } else {
            print("[Import Warning] 密码配置导入失败")
        }
    }

    private func importEncryptedFolders(from directory: URL) throws {
        let configURL = directory.appendingPathComponent("EncryptedFolders.plist")
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            print("[Import] 未找到加密文件夹配置")
            return
        }

        guard let config = try PropertyListSerialization.propertyList(from: Data(contentsOf: configURL), format: nil) as? [String: Any] else {
            print("[Import] 加密文件夹配置格式错误")
            return
        }

        // 导入加密文件夹列表
        if let foldersDataString = config["foldersData"] as? String,
           let foldersData = Data(base64Encoded: foldersDataString) {
            UserDefaults.standard.set(foldersData, forKey: "encryptedFolders")
        }

        // 导入文件夹名称映射
        if let folderNames = config["folderNames"] as? [String: String] {
            UserDefaults.standard.set(folderNames, forKey: "encrypted_folder_names")
        }

        print("[Import] 已导入加密文件夹配置")
    }

    private func importEncryptedData(from directory: URL) throws {
        let configURL = directory.appendingPathComponent("EncryptedData.plist")
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            print("[Import] 未找到加密数据配置")
            return
        }

        guard let encryptedData = try PropertyListSerialization.propertyList(from: Data(contentsOf: configURL), format: nil) as? [String: Any] else {
            print("[Import] 加密数据格式错误")
            return
        }

        EncryptedFolderManager.shared.importEncryptedData(encryptedData)
        print("[Import] 已导入加密数据")
    }

    private func importAllNotes(from directory: URL, context: ModelContext) async throws {
        let importer = DocumentMigrationPackageImporter()
        let handler = SwiftDataDocumentMigrationImportHandler(modelContext: context)
        let package = try importer.importDirectory(from: directory, using: handler)
        package.cleanup()
        print("[Import] 笔记导入完成，共 \(package.notes.count) 条")
    }

    private func preflightValidateAllDataImport(at directory: URL) throws {
        let configDir = directory.appendingPathComponent("Config")
        if FileManager.default.fileExists(atPath: configDir.path) {
            try validateConfigurationImport(at: configDir)
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

    private func validateConfigurationImport(at directory: URL) throws {
        let fileManager = FileManager.default

        let userDefaultsURL = directory.appendingPathComponent("UserDefaults.plist")
        if fileManager.fileExists(atPath: userDefaultsURL.path) {
            _ = try propertyListDictionary(at: userDefaultsURL, named: "UserDefaults.plist")
        }

        let shortcutsURL = directory.appendingPathComponent("KeyboardShortcuts.plist")
        if fileManager.fileExists(atPath: shortcutsURL.path) {
            guard (try PropertyListSerialization.propertyList(from: Data(contentsOf: shortcutsURL), format: nil) as? [String: [String: Any]]) != nil else {
                throw DataImportValidationError.invalidConfigurationFile(name: "KeyboardShortcuts.plist")
            }
        }

        if fileManager.fileExists(atPath: directory.appendingPathComponent("RadialMenuSettings.plist").path) ||
            fileManager.fileExists(atPath: directory.appendingPathComponent("RadialMenuSettings.json").path) {
            _ = try validatedRadialMenuSettings(from: directory)
        }

        let appSettingsURL = directory.appendingPathComponent("AppSettings.plist")
        if fileManager.fileExists(atPath: appSettingsURL.path) {
            _ = try propertyListDictionary(at: appSettingsURL, named: "AppSettings.plist")
        }

        let aiConfigsURL = directory.appendingPathComponent("AIConfigs.json")
        if fileManager.fileExists(atPath: aiConfigsURL.path) {
            _ = try JSONDecoder().decode([AIServiceConfig].self, from: Data(contentsOf: aiConfigsURL))
        }

        let selectedConfigURL = directory.appendingPathComponent("AISelectedConfig.plist")
        if fileManager.fileExists(atPath: selectedConfigURL.path) {
            guard (try PropertyListSerialization.propertyList(from: Data(contentsOf: selectedConfigURL), format: nil) as? [String: Any]) != nil else {
                throw DataImportValidationError.invalidConfigurationFile(name: "AISelectedConfig.plist")
            }
        }

        let passwordURL = directory.appendingPathComponent("PasswordConfig.plist")
        if fileManager.fileExists(atPath: passwordURL.path) {
            guard (try PropertyListSerialization.propertyList(from: Data(contentsOf: passwordURL), format: nil) as? [String: String]) != nil else {
                throw DataImportValidationError.invalidConfigurationFile(name: "PasswordConfig.plist")
            }
        }

        let encryptedFoldersURL = directory.appendingPathComponent("EncryptedFolders.plist")
        if fileManager.fileExists(atPath: encryptedFoldersURL.path) {
            _ = try propertyListDictionary(at: encryptedFoldersURL, named: "EncryptedFolders.plist")
        }

        let encryptedDataURL = directory.appendingPathComponent("EncryptedData.plist")
        if fileManager.fileExists(atPath: encryptedDataURL.path) {
            _ = try propertyListDictionary(at: encryptedDataURL, named: "EncryptedData.plist")
        }
    }

    private func propertyListDictionary(at url: URL, named fileName: String) throws -> [String: Any] {
        guard let dictionary = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any] else {
            throw DataImportValidationError.invalidConfigurationFile(name: fileName)
        }
        return dictionary
    }

    private func loadRadialMenuSettings(from directory: URL) throws -> [String: Any]? {
        let fileManager = FileManager.default
        let plistURL = directory.appendingPathComponent("RadialMenuSettings.plist")
        if fileManager.fileExists(atPath: plistURL.path) {
            return try propertyListDictionary(at: plistURL, named: "RadialMenuSettings.plist")
        }

        let jsonURL = directory.appendingPathComponent("RadialMenuSettings.json")
        if fileManager.fileExists(atPath: jsonURL.path) {
            let data = try Data(contentsOf: jsonURL)
            guard let settings = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw DataImportValidationError.invalidConfigurationFile(name: "RadialMenuSettings.json")
            }
            return settings
        }

        return nil
    }

    private func validatedRadialMenuSettings(from directory: URL) throws -> [String: Any] {
        guard let settings = try loadRadialMenuSettings(from: directory) else {
            throw DataImportValidationError.invalidConfigurationFile(name: "RadialMenuSettings")
        }
        return settings
    }

    private func stageAttachmentsImportIfNeeded(from directory: URL) throws -> URL? {
        guard FileManager.default.fileExists(atPath: directory.path) else { return nil }
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }

        let notebookDataDir = storage.appendingPathComponent("NotebookData", isDirectory: true)
        try FileManager.default.createDirectory(at: notebookDataDir, withIntermediateDirectories: true)

        let stagingDir = notebookDataDir.appendingPathComponent("AttachmentsImportStaging_\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stagingDir, withIntermediateDirectories: true)

        let contents = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        for item in contents {
            let destination = stagingDir.appendingPathComponent(item.lastPathComponent)
            try FileManager.default.copyItem(at: item, to: destination)
        }

        return stagingDir
    }

    private func commitStagedAttachmentsImport(from stagingDir: URL) throws {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }

        let fileManager = FileManager.default
        let notebookDataDir = storage.appendingPathComponent("NotebookData", isDirectory: true)
        try fileManager.createDirectory(at: notebookDataDir, withIntermediateDirectories: true)

        let liveDir = notebookDataDir.appendingPathComponent("Attachments", isDirectory: true)
        let backupDir = notebookDataDir.appendingPathComponent("AttachmentsBackup_\(UUID().uuidString)", isDirectory: true)
        let hadExistingLiveDir = fileManager.fileExists(atPath: liveDir.path)

        if hadExistingLiveDir {
            try fileManager.moveItem(at: liveDir, to: backupDir)
        }

        do {
            try fileManager.moveItem(at: stagingDir, to: liveDir)
            if hadExistingLiveDir, fileManager.fileExists(atPath: backupDir.path) {
                try fileManager.removeItem(at: backupDir)
            }
        } catch {
            if fileManager.fileExists(atPath: liveDir.path) {
                try? fileManager.removeItem(at: liveDir)
            }
            if hadExistingLiveDir, fileManager.fileExists(atPath: backupDir.path) {
                try? fileManager.moveItem(at: backupDir, to: liveDir)
            }
            throw error
        }

        let importedCount = try fileManager.contentsOfDirectory(at: liveDir, includingPropertiesForKeys: nil).count
        print("[Import] 已导入 \(importedCount) 个附件")
    }

    // MARK: - 重置功能

    /// 重置所有数据（删除所有笔记、文件夹、标签、附件和配置）
    func resetAllData(context: ModelContext) async throws {
        print("[Reset] 开始重置所有数据...")

        let allBlocks = try context.fetch(FetchDescriptor<BlockDocumentBlockEntity>())
        for block in allBlocks {
            context.delete(block)
        }
        print("[Reset] 已删除 \(allBlocks.count) 个块")

        let allAssets = try context.fetch(FetchDescriptor<BlockDocumentAssetEntity>())
        for asset in allAssets {
            context.delete(asset)
        }
        print("[Reset] 已删除 \(allAssets.count) 个资源")

        let allNotes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
        for note in allNotes {
            context.delete(note)
        }
        print("[Reset] 已删除 \(allNotes.count) 个笔记")

        let allFolders = try context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
        for folder in allFolders {
            context.delete(folder)
        }
        print("[Reset] 已删除 \(allFolders.count) 个文件夹")

        let allTags = try context.fetch(FetchDescriptor<BlockDocumentTagEntity>())
        for tag in allTags {
            context.delete(tag)
        }
        print("[Reset] 已删除 \(allTags.count) 个标签")

        let allLibraries = try context.fetch(FetchDescriptor<BlockDocumentLibraryEntity>())
        for library in allLibraries {
            context.delete(library)
        }
        print("[Reset] 已删除 \(allLibraries.count) 个文档库")

        try context.save()
        print("[Reset] 数据库已清空")

        // 5. 删除所有附件文件
        try deleteAllAttachments()

        // 6. 删除数据库文件
        try deleteDatabaseFiles()

        // 7. 重置所有 UserDefaults 设置
        resetAllSettings()

        // 8. 重置快捷键设置
        resetKeyboardShortcuts()

        // 9. 重置环形菜单设置
        resetRadialMenuSettings()

        print("[Reset] 重置完成")
    }

    /// 删除所有附件文件
    private func deleteAllAttachments() throws {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else { return }

        let attachmentsDir = storage.appendingPathComponent("NotebookData/Attachments")
        guard FileManager.default.fileExists(atPath: attachmentsDir.path) else { return }

        let contents = try FileManager.default.contentsOfDirectory(at: attachmentsDir, includingPropertiesForKeys: nil)
        for item in contents {
            try FileManager.default.removeItem(at: item)
        }

        print("[Reset] 已删除 \(contents.count) 个附件文件")
    }

    /// 删除数据库文件
    private func deleteDatabaseFiles() throws {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else { return }

        let databaseDir = storage.appendingPathComponent("NotebookData/Database")
        guard FileManager.default.fileExists(atPath: databaseDir.path) else { return }

        let contents = try FileManager.default.contentsOfDirectory(at: databaseDir, includingPropertiesForKeys: nil)
        for item in contents {
            try FileManager.default.removeItem(at: item)
        }

        print("[Reset] 已删除 \(contents.count) 个数据库文件")
    }

    /// 重置所有 UserDefaults 设置
    private func resetAllSettings() {
        let defaults = UserDefaults.standard

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

        // 清除存储位置设置
        defaults.removeObject(forKey: "storageLocationBookmark")

        print("[Reset] 已重置所有 UserDefaults 设置")
    }

    /// 重置快捷键设置
    private func resetKeyboardShortcuts() {
        KeyboardShortcutManager.shared.resetToDefaults()
        print("[Reset] 已重置快捷键设置")
    }

    /// 重置环形菜单设置
    private func resetRadialMenuSettings() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "radialMenuEnabled")
        defaults.removeObject(forKey: "radialMenuTrigger")
        defaults.removeObject(forKey: "radialMenuRadius")
        defaults.removeObject(forKey: "radialMenuItemSize")
        defaults.removeObject(forKey: "radialMenuScale")
        defaults.removeObject(forKey: "radialMenuItems")
        print("[Reset] 已重置环形菜单设置")
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

struct DocumentMigrationPackage: Codable {
    let schemaVersion: String
    let exportedAt: Date
    let notes: [NoteItem]
    let folders: [FolderItem]
    let tags: [TagItem]

    struct NoteItem: Codable {
        let id: UUID
        let title: String
        let createdAt: Date
        let updatedAt: Date
        let folderID: UUID?
        let folderName: String
        let reminderAt: Date?
        let recurrenceRule: String
        let version: Int64
        let tagIDs: [UUID]
        let viewMode: String
        let deletedAt: Date?
        let originalFolderID: UUID?
        let originalFolderName: String?
        let blockCount: Int
        let assetCount: Int
        let documentPath: String
    }

    struct FolderItem: Codable {
        let id: UUID
        let name: String
        let sortOrder: Int
        let isSystem: Bool
        let createdAt: Date?
    }

    struct TagItem: Codable {
        let id: UUID
        let name: String
        let color: String
        let createdAt: Date
    }
}

struct MigratedDocument: Codable {
    let schemaVersion: String
    let source: String
    let blocks: [MigratedDocumentBlock]
}

struct MigratedDocumentBlock: Codable {
    let id: String
    let type: String
    var text: [MigratedInlineText]?
    var level: Int?
    var listStyle: String?
    var order: Int?
    var checked: Bool?
    var indent: Int?
    var asset: MigratedAssetReference?
    var table: MigratedTable?
}

struct MigratedInlineText: Codable {
    let text: String
    let bold: Bool
    let italic: Bool
    let underline: Bool
    let strikethrough: Bool
    let textColor: String?
    let backgroundColor: String?
    let link: String?
    let fontFamily: String?
    let fontSize: Double?
    let kern: Double?
    let baselineOffset: Double?
    let paragraphStyle: MigratedParagraphStyle?
}

struct MigratedParagraphStyle: Codable, Equatable {
    let alignment: Int?
    let lineSpacing: Double?
    let paragraphSpacing: Double?
    let paragraphSpacingBefore: Double?
    let firstLineHeadIndent: Double?
    let headIndent: Double?
    let tailIndent: Double?
}

struct MigratedAssetReference: Codable {
    let id: String
    let kind: String
    let filename: String
    let mimeType: String
    let width: Double?
    let height: Double?
    let duration: Double?
    let createdAt: Date?
    let sidecarFiles: [String]
}

struct MigratedTable: Codable {
    let rows: [[String]]
    let columnWidths: [Double]
    let rowHeights: [Double]
}

struct LoadedDocumentMigrationPackage {
    let rootDirectory: URL
    let isTemporary: Bool
    let manifest: DocumentMigrationPackage
    let notes: [LoadedDocumentMigrationNote]

    func cleanup() {
        guard isTemporary else { return }
        try? FileManager.default.removeItem(at: rootDirectory)
    }
}

struct LoadedDocumentMigrationNote {
    let metadata: DocumentMigrationPackage.NoteItem
    let document: MigratedDocument
    let noteDirectory: URL
    let assets: [LoadedMigratedAsset]
}

struct LoadedMigratedAsset {
    let reference: MigratedAssetReference
    let fileURL: URL
    let sidecarFileURLs: [URL]
}

enum DocumentMigrationImportError: LocalizedError {
    case missingManifest
    case missingDocument(path: String)
    case missingAsset(path: String)
    case invalidAssetPath(path: String)

    var errorDescription: String? {
        switch self {
        case .missingManifest:
            return "迁移包缺少 manifest.json"
        case .missingDocument(let path):
            return "迁移包缺少文档文件: \(path)"
        case .missingAsset(let path):
            return "迁移包缺少资源文件: \(path)"
        case .invalidAssetPath(let path):
            return "迁移包资源路径无效: \(path)"
        }
    }
}

protocol DocumentMigrationImportHandler: AnyObject {
    func prepareImport(manifest: DocumentMigrationPackage) throws
    func importNote(_ note: LoadedDocumentMigrationNote) throws
    func finishImport(package: LoadedDocumentMigrationPackage) throws
}

@MainActor
final class DocumentMigrationPackageLoader {
    private let fileManager = FileManager.default

    func loadArchive(from zipURL: URL) throws -> LoadedDocumentMigrationPackage {
        let extractDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookDocumentMigrationImport_\(Date().timeIntervalSince1970)_\(UUID().uuidString)")
        try DataExportManager.shared.extractArchive(at: zipURL, to: extractDir)
        do {
            return try load(from: extractDir, isTemporary: true)
        } catch {
            try? fileManager.removeItem(at: extractDir)
            throw error
        }
    }

    func loadDirectory(from directoryURL: URL) throws -> LoadedDocumentMigrationPackage {
        try load(from: directoryURL, isTemporary: false)
    }

    private func load(from rootDirectory: URL, isTemporary: Bool) throws -> LoadedDocumentMigrationPackage {
        let manifestURL = rootDirectory.appendingPathComponent("manifest.json")
        guard fileManager.fileExists(atPath: manifestURL.path) else {
            throw DocumentMigrationImportError.missingManifest
        }

        let manifest: DocumentMigrationPackage = try readJSON(from: manifestURL)
        let notes = try manifest.notes.map { try loadNote($0, rootDirectory: rootDirectory) }

        return LoadedDocumentMigrationPackage(
            rootDirectory: rootDirectory,
            isTemporary: isTemporary,
            manifest: manifest,
            notes: notes
        )
    }

    private func loadNote(_ item: DocumentMigrationPackage.NoteItem, rootDirectory: URL) throws -> LoadedDocumentMigrationNote {
        let documentURL = rootDirectory.appendingPathComponent(item.documentPath)
        guard fileManager.fileExists(atPath: documentURL.path) else {
            throw DocumentMigrationImportError.missingDocument(path: item.documentPath)
        }

        let document: MigratedDocument = try readJSON(from: documentURL)
        let noteDirectory = documentURL.deletingLastPathComponent()
        let assets = try resolveAssets(for: document, noteDirectory: noteDirectory, rootDirectory: rootDirectory)

        return LoadedDocumentMigrationNote(
            metadata: item,
            document: document,
            noteDirectory: noteDirectory,
            assets: assets
        )
    }

    private func resolveAssets(for document: MigratedDocument, noteDirectory: URL, rootDirectory: URL) throws -> [LoadedMigratedAsset] {
        try document.blocks.compactMap { $0.asset }.map { reference in
            let fileURL = try resolvedAssetURL(
                for: reference.filename,
                noteDirectory: noteDirectory,
                rootDirectory: rootDirectory
            )
            guard fileManager.fileExists(atPath: fileURL.path) else {
                throw DocumentMigrationImportError.missingAsset(path: reference.filename)
            }

            let sidecarFileURLs = try reference.sidecarFiles.map { sidecarPath in
                let sidecarURL = try resolvedAssetURL(
                    for: sidecarPath,
                    noteDirectory: noteDirectory,
                    rootDirectory: rootDirectory
                )
                guard fileManager.fileExists(atPath: sidecarURL.path) else {
                    throw DocumentMigrationImportError.missingAsset(path: sidecarPath)
                }
                return sidecarURL
            }

            return LoadedMigratedAsset(
                reference: reference,
                fileURL: fileURL,
                sidecarFileURLs: sidecarFileURLs
            )
        }
    }

    private func resolvedAssetURL(for relativePath: String, noteDirectory: URL, rootDirectory: URL) throws -> URL {
        let noteScopedURL = try validatedURL(for: relativePath, baseDirectory: noteDirectory, rootDirectory: rootDirectory)
        if fileManager.fileExists(atPath: noteScopedURL.path) {
            return noteScopedURL
        }

        return try validatedURL(for: relativePath, baseDirectory: rootDirectory, rootDirectory: rootDirectory)
    }

    private func validatedURL(for relativePath: String, baseDirectory: URL, rootDirectory: URL) throws -> URL {
        let url = baseDirectory.appendingPathComponent(relativePath)
        let resolvedPath = url.standardizedFileURL.path
        let rootPath = rootDirectory.standardizedFileURL.path
        let rootPrefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard resolvedPath == rootPath || resolvedPath.hasPrefix(rootPrefix) else {
            throw DocumentMigrationImportError.invalidAssetPath(path: relativePath)
        }
        return url
    }

    private func readJSON<T: Decodable>(from url: URL) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(T.self, from: Data(contentsOf: url))
    }
}

@MainActor
final class DocumentMigrationPackageImporter {
    private let loader: DocumentMigrationPackageLoader

    init() {
        self.loader = DocumentMigrationPackageLoader()
    }

    init(loader: DocumentMigrationPackageLoader) {
        self.loader = loader
    }

    @discardableResult
    func importArchive(from zipURL: URL, using handler: DocumentMigrationImportHandler) throws -> LoadedDocumentMigrationPackage {
        let package = try loader.loadArchive(from: zipURL)
        do {
            try runImport(package, using: handler)
            return package
        } catch {
            package.cleanup()
            throw error
        }
    }

    @discardableResult
    func importDirectory(from directoryURL: URL, using handler: DocumentMigrationImportHandler) throws -> LoadedDocumentMigrationPackage {
        let package = try loader.loadDirectory(from: directoryURL)
        try runImport(package, using: handler)
        return package
    }

    private func runImport(_ package: LoadedDocumentMigrationPackage, using handler: DocumentMigrationImportHandler) throws {
        try handler.prepareImport(manifest: package.manifest)
        for note in package.notes {
            try handler.importNote(note)
        }
        try handler.finishImport(package: package)
    }
}

struct ImportedDocumentLibrary {
    let schemaVersion: String
    let sourceExportedAt: Date
    let importedAt: Date
    let folders: [ImportedDocumentFolder]
    let tags: [ImportedDocumentTag]
    let notes: [ImportedDocumentNote]
}

struct ImportedDocumentFolder {
    let id: UUID
    let name: String
    let sortOrder: Int
    let isSystem: Bool
    let createdAt: Date?

    init(
        id: UUID,
        name: String,
        sortOrder: Int,
        isSystem: Bool,
        createdAt: Date?
    ) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
        self.isSystem = isSystem
        self.createdAt = createdAt
    }

    init(item: DocumentMigrationPackage.FolderItem) {
        id = item.id
        name = item.name
        sortOrder = item.sortOrder
        isSystem = item.isSystem
        createdAt = item.createdAt
    }
}

struct ImportedDocumentTag {
    let id: UUID
    let name: String
    let color: String
    let createdAt: Date

    init(
        id: UUID,
        name: String,
        color: String,
        createdAt: Date
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.createdAt = createdAt
    }

    init(item: DocumentMigrationPackage.TagItem) {
        id = item.id
        name = item.name
        color = item.color
        createdAt = item.createdAt
    }
}

struct ImportedDocumentNote {
    let id: UUID
    let title: String
    let createdAt: Date
    let updatedAt: Date
    let folderID: UUID?
    let folderName: String
    let reminderAt: Date?
    let recurrenceRule: String
    let version: Int64
    let tagIDs: [UUID]
    let viewMode: String
    let deletedAt: Date?
    let originalFolderID: UUID?
    let originalFolderName: String?
    let document: ImportedDocument
    let assets: [ImportedDocumentAsset]

    init(
        id: UUID,
        title: String,
        createdAt: Date,
        updatedAt: Date,
        folderID: UUID?,
        folderName: String,
        reminderAt: Date?,
        recurrenceRule: String,
        version: Int64,
        tagIDs: [UUID],
        viewMode: String,
        deletedAt: Date?,
        originalFolderID: UUID?,
        originalFolderName: String?,
        document: ImportedDocument,
        assets: [ImportedDocumentAsset]
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.folderID = folderID
        self.folderName = folderName
        self.reminderAt = reminderAt
        self.recurrenceRule = recurrenceRule
        self.version = version
        self.tagIDs = tagIDs
        self.viewMode = viewMode
        self.deletedAt = deletedAt
        self.originalFolderID = originalFolderID
        self.originalFolderName = originalFolderName
        self.document = document
        self.assets = assets
    }

    init(note: LoadedDocumentMigrationNote) {
        id = note.metadata.id
        title = note.metadata.title
        createdAt = note.metadata.createdAt
        updatedAt = note.metadata.updatedAt
        folderID = note.metadata.folderID
        folderName = note.metadata.folderName
        reminderAt = note.metadata.reminderAt
        recurrenceRule = note.metadata.recurrenceRule
        version = note.metadata.version
        tagIDs = note.metadata.tagIDs
        viewMode = note.metadata.viewMode
        deletedAt = note.metadata.deletedAt
        originalFolderID = note.metadata.originalFolderID
        originalFolderName = note.metadata.originalFolderName
        document = ImportedDocument(document: note.document)
        assets = note.assets.map(ImportedDocumentAsset.init)
    }
}

struct ImportedDocument {
    let schemaVersion: String
    let source: String
    let blocks: [ImportedDocumentBlock]

    init(
        schemaVersion: String,
        source: String,
        blocks: [ImportedDocumentBlock]
    ) {
        self.schemaVersion = schemaVersion
        self.source = source
        self.blocks = blocks
    }

    init(document: MigratedDocument) {
        schemaVersion = document.schemaVersion
        source = document.source
        blocks = document.blocks.map(ImportedDocumentBlock.init)
    }
}

enum ImportedDocumentBlockKind: String, Codable {
    case paragraph
    case heading
    case listItem = "list_item"
    case todoItem = "todo_item"
    case image
    case audio
    case table
    case unsupported
}

enum ImportedDocumentListStyle: String, Codable {
    case bullet
    case dash
    case ordered
    case unknown
}

struct ImportedDocumentBlock {
    let id: String
    let kind: ImportedDocumentBlockKind
    let text: [ImportedInlineText]
    let level: Int?
    let listStyle: ImportedDocumentListStyle?
    let order: Int?
    let checked: Bool?
    let indent: Int?
    let asset: ImportedDocumentAssetReference?
    let table: ImportedDocumentTable?
    let sourceType: String

    init(
        id: String,
        kind: ImportedDocumentBlockKind,
        text: [ImportedInlineText],
        level: Int?,
        listStyle: ImportedDocumentListStyle?,
        order: Int?,
        checked: Bool?,
        indent: Int?,
        asset: ImportedDocumentAssetReference?,
        table: ImportedDocumentTable?,
        sourceType: String
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.level = level
        self.listStyle = listStyle
        self.order = order
        self.checked = checked
        self.indent = indent
        self.asset = asset
        self.table = table
        self.sourceType = sourceType
    }

    init(block: MigratedDocumentBlock) {
        id = block.id
        kind = ImportedDocumentBlockKind(rawValue: block.type) ?? .unsupported
        text = (block.text ?? []).map(ImportedInlineText.init)
        level = block.level
        listStyle = block.listStyle.map { ImportedDocumentListStyle(rawValue: $0) ?? .unknown }
        order = block.order
        checked = block.checked
        indent = block.indent
        asset = block.asset.map(ImportedDocumentAssetReference.init)
        table = block.table.map(ImportedDocumentTable.init)
        sourceType = block.type
    }
}

struct ImportedInlineText {
    let text: String
    let bold: Bool
    let italic: Bool
    let underline: Bool
    let strikethrough: Bool
    let textColor: String?
    let backgroundColor: String?
    let link: String?
    let fontFamily: String?
    let fontSize: Double?
    let kern: Double?
    let baselineOffset: Double?
    let paragraphStyle: MigratedParagraphStyle?

    init(
        text: String,
        bold: Bool,
        italic: Bool,
        underline: Bool,
        strikethrough: Bool,
        textColor: String?,
        backgroundColor: String?,
        link: String?,
        fontFamily: String?,
        fontSize: Double?,
        kern: Double?,
        baselineOffset: Double?,
        paragraphStyle: MigratedParagraphStyle?
    ) {
        self.text = text
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.strikethrough = strikethrough
        self.textColor = textColor
        self.backgroundColor = backgroundColor
        self.link = link
        self.fontFamily = fontFamily
        self.fontSize = fontSize
        self.kern = kern
        self.baselineOffset = baselineOffset
        self.paragraphStyle = paragraphStyle
    }

    init(span: MigratedInlineText) {
        text = span.text
        bold = span.bold
        italic = span.italic
        underline = span.underline
        strikethrough = span.strikethrough
        textColor = span.textColor
        backgroundColor = span.backgroundColor
        link = span.link
        fontFamily = span.fontFamily
        fontSize = span.fontSize
        kern = span.kern
        baselineOffset = span.baselineOffset
        paragraphStyle = span.paragraphStyle
    }
}

enum ImportedDocumentAssetKind: String, Codable {
    case image
    case audio
    case unsupported
}

struct ImportedDocumentAssetReference {
    let id: String
    let kind: ImportedDocumentAssetKind
    let filename: String
    let mimeType: String
    let width: Double?
    let height: Double?
    let duration: Double?
    let createdAt: Date?
    let sidecarFiles: [String]
    let sourceKind: String

    init(
        id: String,
        kind: ImportedDocumentAssetKind,
        filename: String,
        mimeType: String,
        width: Double?,
        height: Double?,
        duration: Double?,
        createdAt: Date?,
        sidecarFiles: [String],
        sourceKind: String
    ) {
        self.id = id
        self.kind = kind
        self.filename = filename
        self.mimeType = mimeType
        self.width = width
        self.height = height
        self.duration = duration
        self.createdAt = createdAt
        self.sidecarFiles = sidecarFiles
        self.sourceKind = sourceKind
    }

    init(reference: MigratedAssetReference) {
        id = reference.id
        kind = ImportedDocumentAssetKind(rawValue: reference.kind) ?? .unsupported
        filename = reference.filename
        mimeType = reference.mimeType
        width = reference.width
        height = reference.height
        duration = reference.duration
        createdAt = reference.createdAt
        sidecarFiles = reference.sidecarFiles
        sourceKind = reference.kind
    }
}

struct ImportedDocumentAsset {
    let reference: ImportedDocumentAssetReference
    let sourceURL: URL
    let sidecarURLs: [URL]

    init(
        reference: ImportedDocumentAssetReference,
        sourceURL: URL,
        sidecarURLs: [URL]
    ) {
        self.reference = reference
        self.sourceURL = sourceURL
        self.sidecarURLs = sidecarURLs
    }

    init(asset: LoadedMigratedAsset) {
        reference = ImportedDocumentAssetReference(reference: asset.reference)
        sourceURL = asset.fileURL
        sidecarURLs = asset.sidecarFileURLs
    }
}

struct ImportedDocumentTable {
    let rows: [[String]]
    let columnWidths: [Double]
    let rowHeights: [Double]

    init(
        rows: [[String]],
        columnWidths: [Double],
        rowHeights: [Double]
    ) {
        self.rows = rows
        self.columnWidths = columnWidths
        self.rowHeights = rowHeights
    }

    init(table: MigratedTable) {
        rows = table.rows
        columnWidths = table.columnWidths
        rowHeights = table.rowHeights
    }
}

@MainActor
final class InMemoryDocumentMigrationImportHandler: DocumentMigrationImportHandler {
    private var manifest: DocumentMigrationPackage?
    private var notes: [ImportedDocumentNote] = []
    private(set) var library: ImportedDocumentLibrary?

    func prepareImport(manifest: DocumentMigrationPackage) throws {
        self.manifest = manifest
        notes = []
        library = nil
    }

    func importNote(_ note: LoadedDocumentMigrationNote) throws {
        notes.append(ImportedDocumentNote(note: note))
    }

    func finishImport(package: LoadedDocumentMigrationPackage) throws {
        let manifest = self.manifest ?? package.manifest
        library = ImportedDocumentLibrary(
            schemaVersion: manifest.schemaVersion,
            sourceExportedAt: manifest.exportedAt,
            importedAt: Date(),
            folders: manifest.folders.map(ImportedDocumentFolder.init),
            tags: manifest.tags.map(ImportedDocumentTag.init),
            notes: notes
        )
    }
}

enum DocumentMigrationPersistenceError: LocalizedError {
    case storageNotConfigured
    case importStateUnavailable

    var errorDescription: String? {
        switch self {
        case .storageNotConfigured:
            return "未配置数据存储目录"
        case .importStateUnavailable:
            return "迁移导入状态不可用"
        }
    }
}

@MainActor
final class SwiftDataDocumentMigrationImportHandler: DocumentMigrationImportHandler {
    private let modelContext: ModelContext
    private let fileManager = FileManager.default
    private let jsonEncoder = JSONEncoder()
    private var libraryEntity: BlockDocumentLibraryEntity?
    private var attachmentsRootDirectory: URL?

    init(modelContext: ModelContext) {
        self.modelContext = modelContext
    }

    convenience init(container: ModelContainer) {
        self.init(modelContext: ModelContext(container))
    }

    func prepareImport(manifest: DocumentMigrationPackage) throws {
        try deleteAll(BlockDocumentBlockEntity.self)
        try deleteAll(BlockDocumentAssetEntity.self)
        try deleteAll(BlockDocumentNoteEntity.self)
        try deleteAll(BlockDocumentTagEntity.self)
        try deleteAll(BlockDocumentFolderEntity.self)
        try deleteAll(BlockDocumentLibraryEntity.self)

        let attachmentsRoot = try persistentAttachmentsRootDirectory()
        let importedAssetsRoot = attachmentsRoot.appendingPathComponent("MigratedDocuments", isDirectory: true)
        if fileManager.fileExists(atPath: importedAssetsRoot.path) {
            try fileManager.removeItem(at: importedAssetsRoot)
        }
        try fileManager.createDirectory(at: importedAssetsRoot, withIntermediateDirectories: true)

        let libraryEntity = BlockDocumentLibraryEntity(
            schemaVersion: manifest.schemaVersion,
            sourceExportedAt: manifest.exportedAt,
            importedAt: Date(),
            noteCount: manifest.notes.count,
            folderCount: manifest.folders.count,
            tagCount: manifest.tags.count
        )
        modelContext.insert(libraryEntity)

        for folder in manifest.folders {
            modelContext.insert(
                BlockDocumentFolderEntity(
                    id: folder.id,
                    libraryID: libraryEntity.id,
                    name: folder.name,
                    sortOrder: folder.sortOrder,
                    isSystem: folder.isSystem,
                    createdAt: folder.createdAt
                )
            )
        }

        for tag in manifest.tags {
            modelContext.insert(
                BlockDocumentTagEntity(
                    id: tag.id,
                    libraryID: libraryEntity.id,
                    name: tag.name,
                    color: tag.color,
                    createdAt: tag.createdAt
                )
            )
        }

        try modelContext.save()
        self.libraryEntity = libraryEntity
        attachmentsRootDirectory = attachmentsRoot
    }

    func importNote(_ note: LoadedDocumentMigrationNote) throws {
        guard let libraryEntity else {
            throw DocumentMigrationPersistenceError.importStateUnavailable
        }

        let persistedAssets = try note.assets.map { try persistAsset($0, noteID: note.metadata.id) }

        let noteEntity = BlockDocumentNoteEntity(
            id: note.metadata.id,
            libraryID: libraryEntity.id,
            title: note.metadata.title,
            createdAt: note.metadata.createdAt,
            updatedAt: note.metadata.updatedAt,
            folderID: note.metadata.folderID,
            folderName: note.metadata.folderName,
            reminderAt: note.metadata.reminderAt,
            recurrenceRule: note.metadata.recurrenceRule,
            version: note.metadata.version,
            tagIDs: encodeUUIDList(note.metadata.tagIDs),
            viewMode: note.metadata.viewMode,
            deletedAt: note.metadata.deletedAt,
            originalFolderID: note.metadata.originalFolderID,
            originalFolderName: note.metadata.originalFolderName,
            documentSchemaVersion: note.document.schemaVersion,
            documentSource: note.document.source,
            blockCount: note.document.blocks.count,
            assetCount: persistedAssets.count
        )
        modelContext.insert(noteEntity)

        for asset in persistedAssets {
            modelContext.insert(
                BlockDocumentAssetEntity(
                    noteID: note.metadata.id,
                    assetID: asset.reference.id,
                    kind: asset.reference.kind,
                    sourceKind: asset.reference.kind,
                    filename: asset.reference.filename,
                    mimeType: asset.reference.mimeType,
                    width: asset.reference.width,
                    height: asset.reference.height,
                    duration: asset.reference.duration,
                    createdAt: asset.reference.createdAt,
                    relativeFilePath: asset.relativeFilePath,
                    sidecarPathsPayload: try encodeJSON(asset.sidecarRelativePaths)
                )
            )
        }

        for (position, block) in note.document.blocks.enumerated() {
            modelContext.insert(
                BlockDocumentBlockEntity(
                    noteID: note.metadata.id,
                    position: position,
                    blockID: block.id,
                    kind: block.type,
                    sourceType: block.type,
                    textPayload: try encodeTextPayload(block.text ?? []),
                    level: block.level,
                    listStyle: block.listStyle,
                    order: block.order,
                    checked: block.checked,
                    indent: block.indent,
                    assetID: block.asset?.id,
                    tablePayload: try encodeTablePayload(block.table)
                )
            )
        }

        try modelContext.save()
    }

    func finishImport(package: LoadedDocumentMigrationPackage) throws {
        guard let libraryEntity else {
            throw DocumentMigrationPersistenceError.importStateUnavailable
        }
        libraryEntity.noteCount = package.notes.count
        libraryEntity.folderCount = package.manifest.folders.count
        libraryEntity.tagCount = package.manifest.tags.count
        libraryEntity.importedAt = Date()
        try modelContext.save()
    }

    private func persistentAttachmentsRootDirectory() throws -> URL {
        let storage = StorageLocationManager.shared
        guard let base = storage.baseDirectoryURL else {
            throw DocumentMigrationPersistenceError.storageNotConfigured
        }

        return try storage.withSecurityScopedAccess(base) {
            try storage.ensureDirectoryStructureExists()
            let attachmentsRoot = try storage.attachmentsDirectoryURL()
            try fileManager.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
            return attachmentsRoot
        }
    }

    private func persistAsset(_ asset: LoadedMigratedAsset, noteID: UUID) throws -> PersistedMigratedAsset {
        guard let attachmentsRootDirectory else {
            throw DocumentMigrationPersistenceError.importStateUnavailable
        }

        let baseRelativeDirectory = "MigratedDocuments/\(noteID.uuidString)/\(asset.reference.id)"
        let relativeFilePath = "\(baseRelativeDirectory)/\(asset.fileURL.lastPathComponent)"
        let destinationFileURL = attachmentsRootDirectory.appendingPathComponent(relativeFilePath)
        try copyItemReplacingIfNeeded(from: asset.fileURL, to: destinationFileURL)

        let sidecarRelativePaths = try asset.sidecarFileURLs.map { sidecarURL in
            let relativePath = "\(baseRelativeDirectory)/\(sidecarURL.lastPathComponent)"
            let destinationURL = attachmentsRootDirectory.appendingPathComponent(relativePath)
            try copyItemReplacingIfNeeded(from: sidecarURL, to: destinationURL)
            return relativePath
        }

        return PersistedMigratedAsset(
            reference: asset.reference,
            relativeFilePath: relativeFilePath,
            sidecarRelativePaths: sidecarRelativePaths
        )
    }

    private func copyItemReplacingIfNeeded(from sourceURL: URL, to destinationURL: URL) throws {
        let parentDirectory = destinationURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: parentDirectory, withIntermediateDirectories: true)
        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }
        try fileManager.copyItem(at: sourceURL, to: destinationURL)
    }

    private func encodeUUIDList(_ uuids: [UUID]) -> String {
        uuids.map(\.uuidString).joined(separator: ",")
    }

    private func encodeTextPayload(_ spans: [MigratedInlineText]) throws -> Data? {
        guard !spans.isEmpty else {
            return nil
        }

        let payload = spans.map {
            BlockDocumentTextSpanPayload(
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
                    BlockDocumentParagraphStylePayload(
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
        return try encodeJSON(payload)
    }

    private func encodeTablePayload(_ table: MigratedTable?) throws -> Data? {
        guard let table else {
            return nil
        }

        return try encodeJSON(
            BlockDocumentTablePayload(
                rows: table.rows,
                columnWidths: table.columnWidths,
                rowHeights: table.rowHeights
            )
        )
    }

    private func encodeJSON<T: Encodable>(_ value: T) throws -> Data {
        try jsonEncoder.encode(value)
    }

    private func deleteAll<T: PersistentModel>(_ type: T.Type) throws {
        let models = try modelContext.fetch(FetchDescriptor<T>())
        for model in models {
            modelContext.delete(model)
        }
    }
}

private struct PersistedMigratedAsset {
    let reference: MigratedAssetReference
    let relativeFilePath: String
    let sidecarRelativePaths: [String]
}

struct LegacyDocumentConversion {
    let document: MigratedDocument
    let assetCount: Int
}

struct LegacyNoteDocumentConverter {
    private let noteID: UUID
    private let noteDirectory: URL
    private let assetsDirectory: URL
    private let fileManager = FileManager.default
    private var blockIndex = 0
    private var assetIndex = 0

    init(noteID: UUID, noteDirectory: URL) throws {
        self.noteID = noteID
        self.noteDirectory = noteDirectory
        self.assetsDirectory = noteDirectory.appendingPathComponent("Assets", isDirectory: true)
        try fileManager.createDirectory(at: assetsDirectory, withIntermediateDirectories: true)
    }

    mutating func convert(content: NSAttributedString) throws -> LegacyDocumentConversion {
        let document = try buildDocument(from: content)
        return LegacyDocumentConversion(document: document, assetCount: assetIndex)
    }

    private mutating func buildDocument(from content: NSAttributedString) throws -> MigratedDocument {
        let nsString = content.string as NSString
        var blocks: [MigratedDocumentBlock] = []
        var location = 0

        while location < nsString.length {
            let paragraphRange = paragraphRangeForLegacyConversion(startingAt: location, in: content)
            blocks.append(contentsOf: try convertParagraph(content, range: paragraphRange))
            let nextLocation = NSMaxRange(paragraphRange)
            if nextLocation <= location {
                break
            }
            location = nextLocation
        }

        if nsString.length == 0 {
            blocks.append(MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: 0, asset: nil, table: nil))
        }

        return MigratedDocument(schemaVersion: "1.0", source: "NotebookRTFD", blocks: blocks)
    }

    private func paragraphRangeForLegacyConversion(startingAt location: Int, in content: NSAttributedString) -> NSRange {
        let nsString = content.string as NSString
        let length = nsString.length
        guard location < length else {
            return NSRange(location: location, length: 0)
        }

        var range = nextParagraphRange(startingAt: location, in: nsString)
        while shouldMergeNextLegacyContinuation(for: range, in: content) {
            let nextLocation = NSMaxRange(range)
            guard nextLocation < length else { break }
            let nextRange = nextParagraphRange(startingAt: nextLocation, in: nsString)
            guard trimmedVisibleRange(nextRange, in: nsString).length > 0 else {
                break
            }
            range = NSRange(location: location, length: NSMaxRange(nextRange) - location)
        }

        return range
    }

    private func nextParagraphRange(startingAt location: Int, in nsString: NSString) -> NSRange {
        let length = nsString.length
        guard location < length else {
            return NSRange(location: location, length: 0)
        }

        var end = location
        while end < length {
            let scalar = nsString.character(at: end)
            if scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029 {
                end += 1
                if scalar == 13, end < length, nsString.character(at: end) == 10 {
                    end += 1
                }
                break
            }
            end += 1
        }

        return NSRange(location: location, length: end - location)
    }

    private func shouldMergeNextLegacyContinuation(for range: NSRange, in content: NSAttributedString) -> Bool {
        let nsString = content.string as NSString
        let current = trimmedVisibleRange(range, in: nsString)
        guard current.length > 0 else { return false }

        return isLegacyCheckboxContinuationMarker(current, in: content)
            || isLegacyListContinuationMarker(current, in: nsString)
    }

    private func isLegacyCheckboxContinuationMarker(_ range: NSRange, in content: NSAttributedString) -> Bool {
        let nsString = content.string as NSString
        var cursor = range.location
        let end = NSMaxRange(range)

        while cursor < end, isLegacyContinuationWhitespace(nsString.character(at: cursor)) {
            cursor += 1
        }

        guard cursor < end else { return false }
        guard let attachment = content.attribute(.attachment, at: cursor, effectiveRange: nil) as? NSTextAttachment else {
            return false
        }

        let isCheckboxAttachment =
            attachment is CheckboxTextAttachment
            || CheckboxTextAttachment.looksLikeCheckbox(attachment)
            || probableLegacyCheckboxAttachment(attachment)
        guard isCheckboxAttachment else { return false }

        cursor += 1
        while cursor < end {
            guard isLegacyContinuationWhitespace(nsString.character(at: cursor)) else {
                return false
            }
            cursor += 1
        }

        return true
    }

    private func isLegacyListContinuationMarker(_ range: NSRange, in nsString: NSString) -> Bool {
        var cursor = range.location
        let end = NSMaxRange(range)

        while cursor < end {
            let scalar = nsString.character(at: cursor)
            if scalar == 32 || scalar == 9 {
                cursor += 1
                continue
            }
            break
        }

        guard cursor < end else { return false }
        let marker = nsString.character(at: cursor)
        if marker == 0x2022 || marker == 45 {
            cursor += 1
            while cursor < end {
                let scalar = nsString.character(at: cursor)
                guard scalar == 32 || scalar == 9 else { return false }
                cursor += 1
            }
            return true
        }

        let digitStart = cursor
        while cursor < end {
            let scalar = nsString.character(at: cursor)
            guard CharacterSet.decimalDigits.contains(UnicodeScalar(scalar)!) else { break }
            cursor += 1
        }
        guard cursor > digitStart, cursor < end, nsString.character(at: cursor) == 46 else {
            return false
        }

        cursor += 1
        while cursor < end {
            let scalar = nsString.character(at: cursor)
            guard scalar == 32 || scalar == 9 else { return false }
            cursor += 1
        }
        return true
    }

    private func isLegacyContinuationWhitespace(_ scalar: unichar) -> Bool {
        scalar == 32 || scalar == 9 || scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029
    }

    private mutating func convertParagraph(_ content: NSAttributedString, range: NSRange) throws -> [MigratedDocumentBlock] {
        let visibleRange = trimmedVisibleRange(range, in: content.string as NSString)
        let attachmentItems = attachmentItems(in: visibleRange, content: content)

        if let leadingCheckbox = leadingCheckboxItem(in: attachmentItems, visibleRange: visibleRange, content: content) {
            return [buildTodoBlock(content, paragraphRange: visibleRange, checkbox: leadingCheckbox.item, indent: leadingCheckbox.indent)]
        }

        if attachmentItems.count == 1,
           visibleRange.length == attachmentItems[0].range.length,
           let attachmentBlock = try buildAttachmentBlock(from: attachmentItems[0], content: content) {
            return [attachmentBlock]
        }

        if attachmentItems.isEmpty {
            if let textBlock = buildTextBlock(content, range: visibleRange, prefersParagraphSemantics: true) {
                return [textBlock]
            }
            return [MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: 0, asset: nil, table: nil)]
        }

        var blocks: [MigratedDocumentBlock] = []
        var cursor = visibleRange.location
        var prefersParagraphSemantics = true

        for item in attachmentItems {
            if item.range.location > cursor {
                let textRange = NSRange(location: cursor, length: item.range.location - cursor)
                if let textBlock = buildTextBlock(content, range: textRange, prefersParagraphSemantics: prefersParagraphSemantics) {
                    blocks.append(textBlock)
                    prefersParagraphSemantics = false
                }
            }

            if let attachmentBlock = try buildAttachmentBlock(from: item, content: content) {
                blocks.append(attachmentBlock)
                prefersParagraphSemantics = false
            }

            cursor = NSMaxRange(item.range)
        }

        let paragraphEnd = NSMaxRange(visibleRange)
        if cursor < paragraphEnd {
            let textRange = NSRange(location: cursor, length: paragraphEnd - cursor)
            if let textBlock = buildTextBlock(content, range: textRange, prefersParagraphSemantics: prefersParagraphSemantics) {
                blocks.append(textBlock)
            }
        }

        if blocks.isEmpty {
            blocks.append(MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: 0, asset: nil, table: nil))
        }

        return blocks
    }

    private mutating func buildTodoBlock(_ content: NSAttributedString, paragraphRange: NSRange, checkbox: AttachmentItem, indent: Int) -> MigratedDocumentBlock {
        var start = checkboxTextStartLocation(for: checkbox, in: content)
        let end = NSMaxRange(paragraphRange)
        let nsString = content.string as NSString
        while start < end {
            let scalar = nsString.character(at: start)
            let hasAttachmentAttribute = content.attribute(.attachment, at: start, effectiveRange: nil) != nil
            if hasAttachmentAttribute || scalar == 32 || scalar == 9 || scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029 {
                start += 1
            } else {
                break
            }
        }

        let textRange = NSRange(location: start, length: max(0, end - start))
        return MigratedDocumentBlock(
            id: nextBlockID(),
            type: "todo_item",
            text: inlineText(in: textRange, content: content),
            level: nil,
            listStyle: nil,
            order: nil,
            checked: checkbox.checkboxState,
            indent: indent,
            asset: nil,
            table: nil
        )
    }

    private func checkboxTextStartLocation(for checkbox: AttachmentItem, in content: NSAttributedString) -> Int {
        let nsString = content.string as NSString
        let maxLength = nsString.length
        guard checkbox.range.location < maxLength else {
            return NSMaxRange(checkbox.range)
        }

        let rangeStart = max(0, checkbox.range.location)
        let rangeEnd = min(NSMaxRange(checkbox.range), maxLength)
        if rangeStart >= rangeEnd {
            return NSMaxRange(checkbox.range)
        }

        let objectReplacement: unichar = 0xFFFC
        for index in rangeStart..<rangeEnd where nsString.character(at: index) == objectReplacement {
            return min(index + 1, maxLength)
        }

        return min(NSMaxRange(checkbox.range), maxLength)
    }

    private mutating func buildTextBlock(_ content: NSAttributedString, range: NSRange, prefersParagraphSemantics: Bool) -> MigratedDocumentBlock? {
        guard range.length > 0 else { return nil }
        let nsString = content.string as NSString
        let raw = nsString.substring(with: range)
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return MigratedDocumentBlock(id: nextBlockID(), type: "paragraph", text: [], level: nil, listStyle: nil, order: nil, checked: nil, indent: leadingIndentLevel(in: raw), asset: nil, table: nil)
        }

        var finalRange = range
        var type = "paragraph"
        var level: Int?
        var listStyle: String?
        var order: Int?
        let indent = leadingIndentLevel(in: raw)

        if prefersParagraphSemantics, let listDescriptor = detectListDescriptor(in: raw, baseLocation: range.location) {
            type = "list_item"
            listStyle = listDescriptor.style
            order = listDescriptor.order
            finalRange = sanitizedListContentRange(listDescriptor.contentRange, in: content.string as NSString)
        } else if prefersParagraphSemantics, let headingLevel = detectHeadingLevel(in: content, range: range) {
            type = "heading"
            level = headingLevel
        }

        let spans = inlineText(in: finalRange, content: content)
        return MigratedDocumentBlock(
            id: nextBlockID(),
            type: type,
            text: spans,
            level: level,
            listStyle: listStyle,
            order: order,
            checked: nil,
            indent: indent,
            asset: nil,
            table: nil
        )
    }

    private mutating func buildAttachmentBlock(from item: AttachmentItem, content: NSAttributedString) throws -> MigratedDocumentBlock? {
        if item.isCheckbox {
            return nil
        }

        if let tableData = item.tableData {
            return MigratedDocumentBlock(
                id: nextBlockID(),
                type: "table",
                text: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: nil,
                asset: nil,
                table: MigratedTable(
                    rows: tableData.rows,
                    columnWidths: tableData.columnWidths.map { Double($0) },
                    rowHeights: tableData.rowHeights.map { Double($0) }
                )
            )
        }

        if let asset = try exportAsset(from: item, content: content) {
            return MigratedDocumentBlock(
                id: nextBlockID(),
                type: asset.kind,
                text: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: nil,
                asset: asset,
                table: nil
            )
        }

        return nil
    }

    private func sanitizedListContentRange(_ range: NSRange, in nsString: NSString) -> NSRange {
        let maxLength = nsString.length
        var start = max(0, min(range.location, maxLength))
        let end = max(start, min(NSMaxRange(range), maxLength))

        while start < end {
            let scalar = nsString.character(at: start)
            if scalar == 10 || scalar == 13 || scalar == 0x2028 || scalar == 0x2029 {
                start += 1
                continue
            }
            break
        }

        return NSRange(location: start, length: max(0, end - start))
    }

    private mutating func exportAsset(from item: AttachmentItem, content: NSAttributedString) throws -> MigratedAssetReference? {
        if let attachment = item.attachment as? AttachmentTextAttachment {
            switch attachment.kind {
            case .image:
                return try exportImageAsset(
                    data: attachment.attachmentData(),
                    preferredFilename: attachment.attachmentFileURL.lastPathComponent,
                    width: resolvedWidth(for: item.attributes, attachment: attachment),
                    height: resolvedHeight(for: item.attributes, attachment: attachment)
                )
            case .audio:
                return try exportAudioAsset(
                    sourceURL: attachment.attachmentFileURL,
                    data: attachment.attachmentData(),
                    duration: nil,
                    createdAt: nil
                )
            }
        }

        if let audioAttachment = item.attachment as? AudioBlockAttachment {
            return try exportAudioAsset(
                sourceURL: audioAttachment.fileURL,
                data: audioAttachment.audioData(),
                duration: audioAttachment.duration,
                createdAt: audioAttachment.createDate
            )
        }

        if let payload = regularFilePayload(from: item.attachment.fileWrapper) {
            let data = payload.data
            let preferredFilename = payload.preferredFilename
            let mimeType = mimeType(forPathExtension: URL(fileURLWithPath: preferredFilename).pathExtension.lowercased())
            if mimeType.hasPrefix("image/") {
                return try exportImageAsset(
                    data: data,
                    preferredFilename: preferredFilename,
                    width: resolvedWidth(for: item.attributes, attachment: item.attachment),
                    height: resolvedHeight(for: item.attributes, attachment: item.attachment)
                )
            }
            if mimeType.hasPrefix("audio/") {
                return try exportAudioAsset(
                    sourceURL: URL(fileURLWithPath: preferredFilename),
                    data: data,
                    duration: nil,
                    createdAt: nil
                )
            }
        }

        if let image = item.attachment.image,
           let tiffData = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiffData),
           let pngData = bitmap.representation(using: .png, properties: [:]) {
            return try exportImageAsset(
                data: pngData,
                preferredFilename: "image.png",
                width: resolvedWidth(for: item.attributes, attachment: item.attachment),
                height: resolvedHeight(for: item.attributes, attachment: item.attachment)
            )
        }

        if let linkValue = item.attributes[.link] {
            let rawURL: String?
            if let url = linkValue as? URL {
                rawURL = url.absoluteString
            } else if let string = linkValue as? String {
                rawURL = string
            } else {
                rawURL = nil
            }

            if let rawURL, let fileURL = URL(string: rawURL) {
                let mimeType = mimeType(forPathExtension: fileURL.pathExtension.lowercased())
                if mimeType.hasPrefix("audio/") {
                    return try exportAudioAsset(
                        sourceURL: fileURL,
                        data: try? Data(contentsOf: fileURL),
                        duration: nil,
                        createdAt: nil
                    )
                }
            }
        }

        _ = content
        return nil
    }

    private mutating func exportImageAsset(data: Data?, preferredFilename: String, width: Double?, height: Double?) throws -> MigratedAssetReference? {
        guard let data else { return nil }
        let filename = uniqueAssetFilename(preferredFilename, fallbackExtension: "png")
        let outputURL = assetsDirectory.appendingPathComponent(filename)
        try data.write(to: outputURL, options: .atomic)
        return MigratedAssetReference(
            id: nextAssetID(),
            kind: "image",
            filename: "Assets/\(filename)",
            mimeType: mimeType(forPathExtension: outputURL.pathExtension.lowercased()),
            width: width,
            height: height,
            duration: nil,
            createdAt: nil,
            sidecarFiles: []
        )
    }

    private mutating func exportAudioAsset(sourceURL: URL, data: Data?, duration: TimeInterval?, createdAt: Date?) throws -> MigratedAssetReference? {
        guard let data else { return nil }
        let filename = uniqueAssetFilename(sourceURL.lastPathComponent, fallbackExtension: sourceURL.pathExtension.isEmpty ? "m4a" : sourceURL.pathExtension)
        let outputURL = assetsDirectory.appendingPathComponent(filename)
        try data.write(to: outputURL, options: .atomic)

        var sidecarFiles: [String] = []
        let manifestURL = sourceURL.deletingPathExtension().appendingPathExtension("tracks.json")
        if fileManager.fileExists(atPath: manifestURL.path),
           let manifestData = try? Data(contentsOf: manifestURL) {
            let manifestFilename = uniqueAssetFilename(manifestURL.lastPathComponent, fallbackExtension: manifestURL.pathExtension)
            let manifestOutputURL = assetsDirectory.appendingPathComponent(manifestFilename)
            try manifestData.write(to: manifestOutputURL, options: .atomic)
            sidecarFiles.append("Assets/\(manifestFilename)")
        }

        return MigratedAssetReference(
            id: nextAssetID(),
            kind: "audio",
            filename: "Assets/\(filename)",
            mimeType: mimeType(forPathExtension: outputURL.pathExtension.lowercased()),
            width: nil,
            height: nil,
            duration: duration,
            createdAt: createdAt,
            sidecarFiles: sidecarFiles
        )
    }

    private func inlineText(in range: NSRange, content: NSAttributedString) -> [MigratedInlineText] {
        guard range.length > 0 else { return [] }

        let nsString = content.string as NSString
        var spans: [MigratedInlineText] = []

        content.enumerateAttributes(in: range, options: []) { attributes, subrange, _ in
            let raw = nsString.substring(with: subrange)
                .replacingOccurrences(of: "\u{FFFC}", with: "")
                .replacingOccurrences(of: "\r", with: "")
                .replacingOccurrences(of: "\n", with: "")
                .replacingOccurrences(of: "\u{2028}", with: "")
                .replacingOccurrences(of: "\u{2029}", with: "")

            guard !raw.isEmpty else { return }

            let font = attributes[.font] as? NSFont
            let fontTraits = font.map { NSFontManager.shared.traits(of: $0) } ?? []
            let textColor = (attributes[.foregroundColor] as? NSColor).flatMap(colorHex)
            let backgroundColor = (attributes[.backgroundColor] as? NSColor).flatMap(colorHex)
            let underline = ((attributes[.underlineStyle] as? NSNumber)?.intValue ?? 0) != 0
            let strikethrough = ((attributes[.strikethroughStyle] as? NSNumber)?.intValue ?? 0) != 0
            let kern = (attributes[.kern] as? NSNumber)?.doubleValue
            let baselineOffset = (attributes[.baselineOffset] as? NSNumber)?.doubleValue
            let link: String?

            if let url = attributes[.link] as? URL {
                link = url.absoluteString
            } else if let string = attributes[.link] as? String {
                link = string
            } else {
                link = nil
            }

            let span = MigratedInlineText(
                text: raw,
                bold: fontTraits.contains(.boldFontMask),
                italic: fontTraits.contains(.italicFontMask),
                underline: underline,
                strikethrough: strikethrough,
                textColor: textColor,
                backgroundColor: backgroundColor,
                link: link,
                fontFamily: font?.familyName,
                fontSize: font.map { Double($0.pointSize) },
                kern: kern,
                baselineOffset: baselineOffset,
                paragraphStyle: paragraphStylePayload(from: attributes[.paragraphStyle] as? NSParagraphStyle)
            )

            if let last = spans.last,
               last.bold == span.bold,
               last.italic == span.italic,
               last.underline == span.underline,
               last.strikethrough == span.strikethrough,
               last.textColor == span.textColor,
               last.backgroundColor == span.backgroundColor,
               last.link == span.link,
               last.fontFamily == span.fontFamily,
               last.fontSize == span.fontSize,
               last.kern == span.kern,
               last.baselineOffset == span.baselineOffset,
               last.paragraphStyle == span.paragraphStyle {
                spans[spans.count - 1] = MigratedInlineText(
                    text: last.text + span.text,
                    bold: span.bold,
                    italic: span.italic,
                    underline: span.underline,
                    strikethrough: span.strikethrough,
                    textColor: span.textColor,
                    backgroundColor: span.backgroundColor,
                    link: span.link,
                    fontFamily: span.fontFamily,
                    fontSize: span.fontSize,
                    kern: span.kern,
                    baselineOffset: span.baselineOffset,
                    paragraphStyle: span.paragraphStyle
                )
            } else {
                spans.append(span)
            }
        }

        return spans
    }

    private func attachmentItems(in range: NSRange, content: NSAttributedString) -> [AttachmentItem] {
        guard range.length > 0 else { return [] }

        var items: [AttachmentItem] = []
        content.enumerateAttribute(.attachment, in: range, options: []) { value, subrange, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            let attributes = content.attributes(at: subrange.location, effectiveRange: nil)

            let tableData: TableData? = {
                if let tableAttachment = attachment as? TableTextAttachment {
                    return tableAttachment.tableData
                }
                if let raw = attributes[.notebookTableData] as? Data,
                   let decoded = try? JSONDecoder().decode(TableData.self, from: raw) {
                    return decoded
                }
                if TableTextAttachment.looksLikeTable(attachment) {
                    return TableTextAttachment.recover(from: attachment)?.tableData
                }
                return nil
            }()

            let checkboxState: Bool? = {
                if let checkbox = attachment as? CheckboxTextAttachment {
                    return checkbox.isChecked
                }
                if CheckboxTextAttachment.looksLikeCheckbox(attachment) {
                    return CheckboxTextAttachment.inferCheckedState(from: attachment)
                }
                if attachment is AttachmentTextAttachment {
                    return nil
                }
                if probableLegacyCheckboxAttachment(attachment) {
                    return CheckboxTextAttachment.inferCheckedState(from: attachment)
                }
                return nil
            }()

            items.append(
                AttachmentItem(
                    range: subrange,
                    attachment: attachment,
                    attributes: attributes,
                    checkboxState: checkboxState,
                    tableData: tableData
                )
            )
        }
        return items
    }

    private func leadingCheckboxItem(
        in items: [AttachmentItem],
        visibleRange: NSRange,
        content: NSAttributedString
    ) -> (item: AttachmentItem, indent: Int)? {
        guard let first = items.first, first.isCheckbox else { return nil }
        guard first.range.location >= visibleRange.location else { return nil }

        let prefixRange = NSRange(location: visibleRange.location, length: first.range.location - visibleRange.location)
        let prefix = (content.string as NSString).substring(with: prefixRange)
        guard prefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return (first, leadingIndentLevel(in: prefix))
    }

    private func detectHeadingLevel(in content: NSAttributedString, range: NSRange) -> Int? {
        guard range.length > 0 else { return nil }

        var explicitLevel: Int?
        content.enumerateAttribute(.notebookHeadingLevel, in: range, options: []) { value, _, stop in
            if let level = (value as? NSNumber)?.intValue ?? (value as? Int) {
                explicitLevel = max(1, min(level, 6))
                stop.pointee = true
            }
        }
        if let explicitLevel {
            return explicitLevel
        }

        var maxPointSize: CGFloat = 0
        var emphasized = false

        content.enumerateAttribute(.font, in: range, options: []) { value, _, _ in
            guard let font = value as? NSFont else { return }
            maxPointSize = max(maxPointSize, font.pointSize)
            let traits = NSFontManager.shared.traits(of: font)
            if traits.contains(.boldFontMask) || font.fontName.lowercased().contains("semibold") {
                emphasized = true
            }
        }

        if maxPointSize >= 21 {
            return 1
        }
        if maxPointSize >= 17 {
            return 2
        }
        if maxPointSize >= 15.5 && emphasized {
            return 3
        }
        return nil
    }

    private func paragraphStylePayload(from style: NSParagraphStyle?) -> MigratedParagraphStyle? {
        guard let style else { return nil }
        return MigratedParagraphStyle(
            alignment: style.alignment.rawValue,
            lineSpacing: style.lineSpacing == 0 ? nil : style.lineSpacing,
            paragraphSpacing: style.paragraphSpacing == 0 ? nil : style.paragraphSpacing,
            paragraphSpacingBefore: style.paragraphSpacingBefore == 0 ? nil : style.paragraphSpacingBefore,
            firstLineHeadIndent: style.firstLineHeadIndent == 0 ? nil : style.firstLineHeadIndent,
            headIndent: style.headIndent == 0 ? nil : style.headIndent,
            tailIndent: style.tailIndent == 0 ? nil : style.tailIndent
        )
    }

    private func detectListDescriptor(in raw: String, baseLocation: Int) -> ListDescriptor? {
        let nsRaw = raw as NSString
        let indentRange = nsRaw.range(of: #"^[ \t]*"#, options: .regularExpression)
        let indentLength = indentRange.length
        let tail = nsRaw.substring(from: indentLength)

        if tail.hasPrefix("• ") {
            return ListDescriptor(style: "bullet", order: nil, contentRange: NSRange(location: baseLocation + indentLength + 2, length: max(0, nsRaw.length - indentLength - 2)))
        }

        if tail.hasPrefix("- ") {
            return ListDescriptor(style: "dash", order: nil, contentRange: NSRange(location: baseLocation + indentLength + 2, length: max(0, nsRaw.length - indentLength - 2)))
        }

        let pattern = #"^(\d+)\.\s"#
        if let regex = try? NSRegularExpression(pattern: pattern),
           let match = regex.firstMatch(in: tail, options: [], range: NSRange(location: 0, length: (tail as NSString).length)) {
            let orderRange = match.range(at: 1)
            let order = Int((tail as NSString).substring(with: orderRange))
            return ListDescriptor(style: "ordered", order: order, contentRange: NSRange(location: baseLocation + indentLength + match.range.length, length: max(0, nsRaw.length - indentLength - match.range.length)))
        }

        return nil
    }

    private func trimmedVisibleRange(_ range: NSRange, in nsString: NSString) -> NSRange {
        var location = range.location
        var length = range.length

        while length > 0 {
            let tail = nsString.character(at: location + length - 1)
            if tail == 10 || tail == 13 || tail == 0x2028 || tail == 0x2029 {
                length -= 1
            } else {
                break
            }
        }

        while length > 0 {
            let head = nsString.character(at: location)
            if head == 10 || head == 13 || head == 0x2028 || head == 0x2029 {
                location += 1
                length -= 1
            } else {
                break
            }
        }

        return NSRange(location: location, length: max(0, length))
    }

    private func leadingIndentLevel(in raw: String) -> Int {
        var spaces = 0
        var tabs = 0

        for char in raw {
            if char == " " {
                spaces += 1
                continue
            }
            if char == "\t" {
                tabs += 1
                continue
            }
            break
        }

        return tabs + (spaces / 4)
    }

    private func resolvedWidth(for attributes: [NSAttributedString.Key: Any], attachment: NSTextAttachment) -> Double? {
        if let width = attributes[.notebookImageWidth] as? CGFloat, width > 1 {
            return Double(width)
        }
        if attachment.bounds.width > 1 {
            return Double(attachment.bounds.width)
        }
        return nil
    }

    private func resolvedHeight(for attributes: [NSAttributedString.Key: Any], attachment: NSTextAttachment) -> Double? {
        if let height = attributes[.notebookImageHeight] as? CGFloat, height > 1 {
            return Double(height)
        }
        if attachment.bounds.height > 1 {
            return Double(attachment.bounds.height)
        }
        return nil
    }

    private func probableLegacyCheckboxAttachment(_ attachment: NSTextAttachment) -> Bool {
        let resolvedSize: CGSize = {
            if attachment.bounds.width > 0, attachment.bounds.height > 0 {
                return attachment.bounds.size
            }
            if let image = attachment.image {
                return image.size
            }
            if let contents = attachment.contents, let image = NSImage(data: contents) {
                return image.size
            }
            if let payload = regularFilePayload(from: attachment.fileWrapper),
               let image = NSImage(data: payload.data) {
                return image.size
            }
            return .zero
        }()

        guard resolvedSize.width > 0, resolvedSize.height > 0 else {
            return false
        }

        let minEdge = min(resolvedSize.width, resolvedSize.height)
        let maxEdge = max(resolvedSize.width, resolvedSize.height)
        guard minEdge >= 10, maxEdge <= 36 else {
            return false
        }

        let ratio = maxEdge / minEdge
        return ratio <= 1.25
    }

    private func regularFilePayload(from fileWrapper: FileWrapper?) -> (data: Data, preferredFilename: String)? {
        guard let fileWrapper, fileWrapper.isRegularFile, let data = fileWrapper.regularFileContents else {
            return nil
        }
        let preferredFilename = fileWrapper.preferredFilename ?? fileWrapper.filename ?? "attachment"
        return (data, preferredFilename)
    }

    private func colorHex(_ color: NSColor) -> String? {
        guard let rgb = color.usingColorSpace(.sRGB) else { return nil }
        let red = Int(round(rgb.redComponent * 255))
        let green = Int(round(rgb.greenComponent * 255))
        let blue = Int(round(rgb.blueComponent * 255))
        let alpha = Int(round(rgb.alphaComponent * 255))
        return String(format: "#%02X%02X%02X%02X", red, green, blue, alpha)
    }

    private func mimeType(forPathExtension ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "webp": return "image/webp"
        case "m4a": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "aiff": return "audio/aiff"
        case "caf": return "audio/x-caf"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }

    private mutating func uniqueAssetFilename(_ preferredFilename: String, fallbackExtension: String) -> String {
        let sanitizedBase = sanitizeFilename(URL(fileURLWithPath: preferredFilename).deletingPathExtension().lastPathComponent)
        let fallbackBase = sanitizedBase.isEmpty ? "asset" : sanitizedBase
        let ext = URL(fileURLWithPath: preferredFilename).pathExtension.isEmpty ? fallbackExtension : URL(fileURLWithPath: preferredFilename).pathExtension
        let filename = "\(assetIndex + 1)-\(fallbackBase).\(ext)"
        return filename
    }

    private func sanitizeFilename(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let unicodeScalars = raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        return String(unicodeScalars).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private mutating func nextBlockID() -> String {
        blockIndex += 1
        return "block-\(blockIndex)"
    }

    private mutating func nextAssetID() -> String {
        assetIndex += 1
        return "asset-\(assetIndex)"
    }

    private struct AttachmentItem {
        let range: NSRange
        let attachment: NSTextAttachment
        let attributes: [NSAttributedString.Key: Any]
        let checkboxState: Bool?
        let tableData: TableData?

        var isCheckbox: Bool {
            checkboxState != nil
        }
    }

    private struct ListDescriptor {
        let style: String
        let order: Int?
        let contentRange: NSRange
    }
}
