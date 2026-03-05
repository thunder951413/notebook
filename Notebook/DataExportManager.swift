import Foundation
import SwiftData
import AppKit
import Compression

/// 数据导出管理器 - 打包配置和数据
@MainActor
final class DataExportManager {
    static let shared = DataExportManager()

    private init() {}

    // MARK: - 导出配置

    /// 打包当前配置到 zip 文件
    func exportConfiguration() async throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let exportDir = tempDir.appendingPathComponent("NotebookConfig_\(Date().timeIntervalSince1970)")

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
        let zipURL = tempDir.appendingPathComponent("NotebookConfig_\(formattedDate()).zip")
        try createZip(from: exportDir, to: zipURL)

        // 清理临时目录
        try? FileManager.default.removeItem(at: exportDir)

        return zipURL
    }

    // MARK: - 导出所有数据

    /// 打包所有笔记和附件到 zip 文件
    func exportAllData(context: ModelContext) async throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let exportDir = tempDir.appendingPathComponent("NotebookData_\(Date().timeIntervalSince1970)")

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

        // 导出所有笔记
        try await exportAllNotes(to: exportDir.appendingPathComponent("Notes"), context: context)

        // 导出文件夹
        try await exportFolders(to: exportDir.appendingPathComponent("Folders"), context: context)

        // 导出标签
        try await exportTags(to: exportDir.appendingPathComponent("Tags"), context: context)

        // 导出附件
        try exportAttachments(to: exportDir.appendingPathComponent("Attachments"))

        // 导出数据库文件
        try exportDatabaseFiles(to: exportDir.appendingPathComponent("Database"))

        // 创建 zip 文件
        let zipURL = tempDir.appendingPathComponent("NotebookData_\(formattedDate()).zip")
        try createZip(from: exportDir, to: zipURL)

        // 清理临时目录
        try? FileManager.default.removeItem(at: exportDir)

        return zipURL
    }

    // MARK: - 导出所有笔记（仅笔记）

    /// 仅导出所有笔记（不包含配置和附件）
    func exportAllNotesOnly(context: ModelContext) async throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let exportDir = tempDir.appendingPathComponent("NotebookNotes_\(Date().timeIntervalSince1970)")

        // 创建临时目录
        try FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)

        // 导出所有笔记
        try await exportAllNotes(to: exportDir, context: context)

        // 创建 zip 文件
        let zipURL = tempDir.appendingPathComponent("NotebookNotes_\(formattedDate()).zip")
        try createZip(from: exportDir, to: zipURL)

        // 清理临时目录
        try? FileManager.default.removeItem(at: exportDir)

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
            "storageDirectoryBookmark"
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
        let selectedConfig: [String: String?] = [
            "selectedConfigID": aiManager.selectedConfigID?.uuidString
        ]
        let selectedConfigURL = directory.appendingPathComponent("AISelectedConfig.plist")
        try PropertyListSerialization.data(fromPropertyList: selectedConfig, format: .xml, options: 0)
            .write(to: selectedConfigURL)

        print("[Export] 已导出 \(aiManager.configs.count) 个 AI 配置")
    }

    private func exportAllNotes(to directory: URL, context: ModelContext) async throws {
        let descriptor = FetchDescriptor<NoteEntity>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)])
        let notes = try context.fetch(descriptor)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // 创建元数据文件
        var metadata: [[String: Any]] = []

        for note in notes {
            let noteDir = directory.appendingPathComponent(note.id.uuidString)
            try FileManager.default.createDirectory(at: noteDir, withIntermediateDirectories: true)

            // 保存笔记内容 (RTFD 数据)
            if let rtfdData = note.rtfdData {
                let contentURL = noteDir.appendingPathComponent("content.rtfd")
                // 直接保存原始数据
                do {
                    try rtfdData.write(to: contentURL)
                    print("[Export] 已保存笔记内容: \(contentURL.path)")
                } catch {
                    print("[Export Warning] 无法保存 RTFD 数据: \(error)")
                }
            }

            // 保存元数据（确保没有 nil 值）
            var noteMeta: [String: Any] = [
                "id": note.id.uuidString,
                "title": note.title,
                "folderName": note.folderName,
                "tagIDs": note.tagIDs ?? "",
                "createdAt": note.createdAt.timeIntervalSince1970,
                "updatedAt": note.updatedAt.timeIntervalSince1970,
                "viewMode": note.viewMode ?? "text",
                "recurrenceRule": note.recurrenceRule ?? "none",
                "version": note.version
            ]
            // 可选字段只在有值时添加
            if let reminderAt = note.reminderAt {
                noteMeta["reminderAt"] = reminderAt.timeIntervalSince1970
            }
            // 导出 folderID（优先使用ID关联）
            if let folderID = note.folderID {
                noteMeta["folderID"] = folderID.uuidString
            }
            metadata.append(noteMeta)
        }

        // 保存元数据 plist
        let metadataURL = directory.appendingPathComponent("metadata.plist")
        try PropertyListSerialization.data(fromPropertyList: metadata, format: .xml, options: 0)
            .write(to: metadataURL)
    }

    private func exportFolders(to directory: URL, context: ModelContext) async throws {
        let descriptor = FetchDescriptor<FolderEntity>()
        let folders = try context.fetch(descriptor)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        var metadata: [[String: Any]] = []

        for folder in folders {
            var folderMeta: [String: Any] = [
                "id": folder.id.uuidString,
                "name": folder.name,
                "sortOrder": folder.sortOrder ?? 0,
                "isSystem": folder.isSystem ?? false
            ]
            // 可选字段只在有值时添加
            if let createdAt = folder.createdAt {
                folderMeta["createdAt"] = createdAt.timeIntervalSince1970
            }
            metadata.append(folderMeta)
        }

        let metadataURL = directory.appendingPathComponent("folders.plist")
        try PropertyListSerialization.data(fromPropertyList: metadata, format: .xml, options: 0)
            .write(to: metadataURL)

        print("[Export] 已导出 \(folders.count) 个文件夹")
    }

    private func exportTags(to directory: URL, context: ModelContext) async throws {
        let descriptor = FetchDescriptor<TagEntity>()
        let tags = try context.fetch(descriptor)

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        var metadata: [[String: Any]] = []

        for tag in tags {
            let tagMeta: [String: Any] = [
                "id": tag.id.uuidString,
                "name": tag.name,
                "color": tag.color,
                "createdAt": tag.createdAt.timeIntervalSince1970
            ]
            metadata.append(tagMeta)
        }

        let metadataURL = directory.appendingPathComponent("tags.plist")
        try PropertyListSerialization.data(fromPropertyList: metadata, format: .xml, options: 0)
            .write(to: metadataURL)

        print("[Export] 已导出 \(tags.count) 个标签")
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

    private func exportDatabaseFiles(to directory: URL) throws {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else { return }

        let databaseDir = storage.appendingPathComponent("NotebookData/Database")

        guard FileManager.default.fileExists(atPath: databaseDir.path) else { return }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // 复制数据库文件
        let contents = try FileManager.default.contentsOfDirectory(at: databaseDir, includingPropertiesForKeys: nil)
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

    // MARK: - 导入功能

    /// 导入配置
    func importConfiguration(from zipURL: URL) async throws {
        let tempDir = FileManager.default.temporaryDirectory
        let extractDir = tempDir.appendingPathComponent("ImportConfig_\(Date().timeIntervalSince1970)")

        // 解压 ZIP
        try unzipFile(at: zipURL, to: extractDir)

        // 导入配置
        try importUserDefaults(from: extractDir)
        try importKeyboardShortcuts(from: extractDir)
        try importRadialMenuSettings(from: extractDir)
        try importAppSettings(from: extractDir)
        try importAIConfig(from: extractDir)

        // 清理
        try? FileManager.default.removeItem(at: extractDir)
    }

    /// 导入笔记
    func importNotes(from zipURL: URL, context: ModelContext) async throws {
        let tempDir = FileManager.default.temporaryDirectory
        let extractDir = tempDir.appendingPathComponent("ImportNotes_\(Date().timeIntervalSince1970)")

        // 解压 ZIP
        try unzipFile(at: zipURL, to: extractDir)

        // 导入笔记
        try await importAllNotes(from: extractDir, context: context)

        // 清理
        try? FileManager.default.removeItem(at: extractDir)
    }

    /// 导入所有数据
    func importAllData(from zipURL: URL, context: ModelContext) async throws {
        let tempDir = FileManager.default.temporaryDirectory
        let extractDir = tempDir.appendingPathComponent("ImportAll_\(Date().timeIntervalSince1970)")

        // 解压 ZIP
        try unzipFile(at: zipURL, to: extractDir)

        // 导入配置
        let configDir = extractDir.appendingPathComponent("Config")
        if FileManager.default.fileExists(atPath: configDir.path) {
            try importUserDefaults(from: configDir)
            try importKeyboardShortcuts(from: configDir)
            try importRadialMenuSettings(from: configDir)
            try importAppSettings(from: configDir)
            try importAIConfig(from: configDir)
        }

        // 导入笔记
        let notesDir = extractDir.appendingPathComponent("Notes")
        if FileManager.default.fileExists(atPath: notesDir.path) {
            try await importAllNotes(from: notesDir, context: context)
        }

        // 导入文件夹
        let foldersDir = extractDir.appendingPathComponent("Folders")
        if FileManager.default.fileExists(atPath: foldersDir.path) {
            try await importFolders(from: foldersDir, context: context)
        }

        // 导入标签
        let tagsDir = extractDir.appendingPathComponent("Tags")
        if FileManager.default.fileExists(atPath: tagsDir.path) {
            try await importTags(from: tagsDir, context: context)
        }

        // 导入附件
        let attachmentsDir = extractDir.appendingPathComponent("Attachments")
        if FileManager.default.fileExists(atPath: attachmentsDir.path) {
            try importAttachments(from: attachmentsDir)
        }

        // 清理
        try? FileManager.default.removeItem(at: extractDir)
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

        let defaults = UserDefaults.standard
        for (key, value) in config {
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
        let settingsURL = directory.appendingPathComponent("RadialMenuSettings.json")
        guard FileManager.default.fileExists(atPath: settingsURL.path) else { return }

        let data = try Data(contentsOf: settingsURL)
        guard let settings = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

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
            guard let selectedConfig = try PropertyListSerialization.propertyList(from: Data(contentsOf: selectedConfigURL), format: nil) as? [String: String?] else {
                return
            }
            if let selectedID = selectedConfig["selectedConfigID"] {
                UserDefaults.standard.set(selectedID, forKey: "ai.selectedConfigID")
            }
        }
    }

    private func importAllNotes(from directory: URL, context: ModelContext) async throws {
        let metadataURL = directory.appendingPathComponent("metadata.plist")
        guard FileManager.default.fileExists(atPath: metadataURL.path) else {
            print("[Import] 未找到元数据文件")
            return
        }

        guard let metadata = try PropertyListSerialization.propertyList(from: Data(contentsOf: metadataURL), format: nil) as? [[String: Any]] else {
            print("[Import] 元数据格式错误")
            return
        }

        print("[Import] 开始导入 \(metadata.count) 个笔记")

        for (index, noteMeta) in metadata.enumerated() {
            guard let idString = noteMeta["id"] as? String,
                  let id = UUID(uuidString: idString) else {
                print("[Import Warning] 跳过无效笔记 ID")
                continue
            }

            // 检查笔记是否已存在
            let descriptor = FetchDescriptor<NoteEntity>(predicate: #Predicate { $0.id == id })
            let existingNotes = try? context.fetch(descriptor)

            // 解析 folderID（优先使用ID关联）
            var folderID: UUID?
            if let folderIDString = noteMeta["folderID"] as? String {
                folderID = UUID(uuidString: folderIDString)
            }
            let folderName = noteMeta["folderName"] as? String ?? "未分类"

            let note: NoteEntity
            if let existing = existingNotes?.first {
                // 更新现有笔记
                note = existing
                print("[Import] 更新现有笔记: \(id)")
            } else {
                // 创建新笔记
                note = NoteEntity(
                    id: id,
                    title: noteMeta["title"] as? String ?? "",
                    createdAt: Date(timeIntervalSince1970: noteMeta["createdAt"] as? TimeInterval ?? 0),
                    updatedAt: Date(timeIntervalSince1970: noteMeta["updatedAt"] as? TimeInterval ?? 0),
                    folderID: folderID,
                    folderName: folderName
                )
                context.insert(note)
                print("[Import] 创建新笔记: \(id)")
            }

            // 更新笔记属性
            note.title = noteMeta["title"] as? String ?? ""
            note.folderID = folderID
            note.folderName = folderName
            note.tagIDs = noteMeta["tagIDs"] as? String
            note.viewMode = noteMeta["viewMode"] as? String
            note.recurrenceRule = noteMeta["recurrenceRule"] as? String
            note.version = Int64(noteMeta["version"] as? Int ?? 1)

            if let reminderInterval = noteMeta["reminderAt"] as? TimeInterval {
                note.reminderAt = Date(timeIntervalSince1970: reminderInterval)
            }

            // 导入笔记内容
            let noteDir = directory.appendingPathComponent(id.uuidString)
            let contentURL = noteDir.appendingPathComponent("content.rtfd")
            if FileManager.default.fileExists(atPath: contentURL.path) {
                do {
                    note.rtfdData = try Data(contentsOf: contentURL)
                    print("[Import] 已导入笔记内容: \(id)")
                } catch {
                    print("[Import Warning] 无法读取笔记内容: \(id), error: \(error)")
                }
            }

            if index % 10 == 0 {
                print("[Import] 进度: \(index + 1)/\(metadata.count)")
            }
        }

        // 保存更改
        try context.save()
        print("[Import] 笔记导入完成")
    }

    private func importAttachments(from directory: URL) throws {
        guard let storage = StorageLocationManager.shared.baseDirectoryURL else { return }

        let attachmentsDir = storage.appendingPathComponent("NotebookData/Attachments")
        try FileManager.default.createDirectory(at: attachmentsDir, withIntermediateDirectories: true)

        let contents = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        for item in contents {
            let destination = attachmentsDir.appendingPathComponent(item.lastPathComponent)
            if FileManager.default.fileExists(atPath: destination.path) {
                try? FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.copyItem(at: item, to: destination)
        }

        print("[Import] 已导入 \(contents.count) 个附件")
    }

    private func importFolders(from directory: URL, context: ModelContext) async throws {
        let metadataURL = directory.appendingPathComponent("folders.plist")
        guard FileManager.default.fileExists(atPath: metadataURL.path) else {
            print("[Import] 未找到文件夹元数据文件")
            return
        }

        guard let metadata = try PropertyListSerialization.propertyList(from: Data(contentsOf: metadataURL), format: nil) as? [[String: Any]] else {
            print("[Import] 文件夹元数据格式错误")
            return
        }

        print("[Import] 开始导入 \(metadata.count) 个文件夹")

        for folderMeta in metadata {
            guard let idString = folderMeta["id"] as? String,
                  let id = UUID(uuidString: idString) else {
                print("[Import Warning] 跳过无效文件夹 ID")
                continue
            }

            // 检查文件夹是否已存在
            let descriptor = FetchDescriptor<FolderEntity>(predicate: #Predicate { $0.id == id })
            let existingFolders = try? context.fetch(descriptor)

            let folder: FolderEntity
            if let existing = existingFolders?.first {
                // 更新现有文件夹
                folder = existing
                print("[Import] 更新现有文件夹: \(id)")
            } else {
                // 创建新文件夹
                folder = FolderEntity(
                    id: id,
                    name: folderMeta["name"] as? String ?? "",
                    sortOrder: folderMeta["sortOrder"] as? Int ?? 0
                )
                context.insert(folder)
                print("[Import] 创建新文件夹: \(id)")
            }

            // 更新文件夹属性
            folder.name = folderMeta["name"] as? String ?? ""
            folder.sortOrder = folderMeta["sortOrder"] as? Int ?? 0
            folder.isSystem = folderMeta["isSystem"] as? Bool ?? false
            if let createdAt = folderMeta["createdAt"] as? TimeInterval {
                folder.createdAt = Date(timeIntervalSince1970: createdAt)
            }
        }

        try context.save()
        print("[Import] 文件夹导入完成")
    }

    private func importTags(from directory: URL, context: ModelContext) async throws {
        let metadataURL = directory.appendingPathComponent("tags.plist")
        guard FileManager.default.fileExists(atPath: metadataURL.path) else {
            print("[Import] 未找到标签元数据文件")
            return
        }

        guard let metadata = try PropertyListSerialization.propertyList(from: Data(contentsOf: metadataURL), format: nil) as? [[String: Any]] else {
            print("[Import] 标签元数据格式错误")
            return
        }

        print("[Import] 开始导入 \(metadata.count) 个标签")

        for tagMeta in metadata {
            guard let idString = tagMeta["id"] as? String,
                  let id = UUID(uuidString: idString) else {
                print("[Import Warning] 跳过无效标签 ID")
                continue
            }

            // 检查标签是否已存在
            let descriptor = FetchDescriptor<TagEntity>(predicate: #Predicate { $0.id == id })
            let existingTags = try? context.fetch(descriptor)

            let tag: TagEntity
            if let existing = existingTags?.first {
                // 更新现有标签
                tag = existing
                print("[Import] 更新现有标签: \(id)")
            } else {
                // 创建新标签
                tag = TagEntity(
                    id: id,
                    name: tagMeta["name"] as? String ?? "",
                    color: tagMeta["color"] as? String ?? "blue"
                )
                tag.createdAt = Date(timeIntervalSince1970: tagMeta["createdAt"] as? TimeInterval ?? 0)
                context.insert(tag)
                print("[Import] 创建新标签: \(id)")
            }

            // 更新标签属性
            tag.name = tagMeta["name"] as? String ?? ""
            tag.color = tagMeta["color"] as? String ?? "blue"
        }

        try context.save()
        print("[Import] 标签导入完成")
    }

    // MARK: - 重置功能

    /// 重置所有数据（删除所有笔记、文件夹、标签、附件和配置）
    func resetAllData(context: ModelContext) async throws {
        print("[Reset] 开始重置所有数据...")

        // 1. 删除所有笔记
        let notesDescriptor = FetchDescriptor<NoteEntity>()
        let allNotes = try context.fetch(notesDescriptor)
        for note in allNotes {
            context.delete(note)
        }
        print("[Reset] 已删除 \(allNotes.count) 个笔记")

        // 2. 删除所有文件夹（包括系统文件夹）
        let foldersDescriptor = FetchDescriptor<FolderEntity>()
        let allFolders = try context.fetch(foldersDescriptor)
        for folder in allFolders {
            context.delete(folder)
        }
        print("[Reset] 已删除 \(allFolders.count) 个文件夹")

        // 3. 删除所有标签
        let tagsDescriptor = FetchDescriptor<TagEntity>()
        let allTags = try context.fetch(tagsDescriptor)
        for tag in allTags {
            context.delete(tag)
        }
        print("[Reset] 已删除 \(allTags.count) 个标签")

        // 4. 保存数据库更改
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
}
