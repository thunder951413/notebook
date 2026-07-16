import Foundation
import SwiftUI
import Dispatch

/// 配置同步管理器 - 处理应用设置的远程同步
class ConfigSyncManager {
    static let shared = ConfigSyncManager()

    private init() {}

    // MARK: - 配置同步数据结构

    /// 配置同步信封 - 包含所有可同步的配置
    struct ConfigSyncEnvelope: Codable {
        let exportedAt: Date
        let deviceID: String
        var version: String = "1.0"

        // 应用设置
        let appSettings: AppSettingsData?

        // AI配置
        let aiConfigs: [AIConfigData]?
        let selectedAIConfigID: String?

        // 环形菜单设置
        let radialMenuSettings: RadialMenuSettingsData?

        // 键盘快捷键
        let keyboardShortcuts: [String: KeyboardShortcutData]?

        // 通用元数据
        let noteCount: Int?
        let folderCount: Int?
        let tagCount: Int?
        let encryptedFolderCount: Int?
    }

    /// 应用设置数据（可同步部分）
    struct AppSettingsData: Codable {
        let isFoldersExpanded: Bool?
        let isTagsExpanded: Bool?
        let isTodoExpanded: Bool?
        let lastSelectedNoteID: String?
        let lastSelectedFolder: String?
        let startupBehavior: String?
        let accentColorData: Data? // NSColor编码后的Data
        let appearanceMode: String?
        let isiCloudSyncEnabled: Bool?
        let editorFontName: String?
        let editorFontSize: Double?
        let editorFontColorData: Data? // NSColor编码后的Data
        let tagsFilterMode: String?
    }

    /// AI配置数据
    struct AIConfigData: Codable {
        let id: String
        let serviceType: String
        let name: String
        let apiKey: String?
        let baseURL: String?
        let model: String?
        let temperature: Double?
        let maxTokens: Int?
        let systemPrompt: String?
        let createdAt: Date?
        let updatedAt: Date?
    }

    /// 环形菜单设置数据
    struct RadialMenuSettingsData: Codable {
        let enabled: Bool
        let trigger: String
        let radius: CGFloat
        let itemSize: CGFloat
        let scale: CGFloat
        let items: [RadialMenuItemData]?
    }

    struct RadialMenuItemData: Codable {
        let id: String
        let title: String
        let icon: String
        let shortcut: KeyboardShortcutData?
        let order: Int
    }

    /// 键盘快捷键数据
    struct KeyboardShortcutData: Codable {
        let key: String
        let modifiers: Int
    }

    // MARK: - 配置收集

    /// 收集当前设备的配置数据
    func collectLocalConfig() -> ConfigSyncEnvelope {
        let appSettings = collectAppSettings()
        let aiConfigs = collectAIConfigs()
        let selectedAIConfigID = collectSelectedAIConfigID()
        let radialMenuSettings = collectRadialMenuSettings()
        let keyboardShortcuts = collectKeyboardShortcuts()

        // 收集一些元数据
        let noteCount = collectNoteCount()
        let folderCount = collectFolderCount()
        let tagCount = collectTagCount()
        let encryptedFolderCount = collectEncryptedFolderCount()

        return ConfigSyncEnvelope(
            exportedAt: Date(),
            deviceID: getDeviceIdentifier(),
            appSettings: appSettings,
            aiConfigs: aiConfigs,
            selectedAIConfigID: selectedAIConfigID,
            radialMenuSettings: radialMenuSettings,
            keyboardShortcuts: keyboardShortcuts,
            noteCount: noteCount,
            folderCount: folderCount,
            tagCount: tagCount,
            encryptedFolderCount: encryptedFolderCount
        )
    }

    /// 收集应用设置
    private func collectAppSettings() -> AppSettingsData? {
        let settings = AppSettings.shared

        // 获取颜色数据
        let defaults = NotebookDefaults.shared
        let accentColorData = defaults.data(forKey: "accent_color")
        let editorFontColorData = defaults.data(forKey: "editor_font_color")

        return AppSettingsData(
            isFoldersExpanded: settings.isFoldersExpanded,
            isTagsExpanded: settings.isTagsExpanded,
            isTodoExpanded: settings.isTodoExpanded,
            lastSelectedNoteID: settings.lastSelectedNoteID?.uuidString,
            lastSelectedFolder: settings.lastSelectedFolder,
            startupBehavior: settings.startupBehavior.rawValue,
            accentColorData: accentColorData,
            appearanceMode: settings.appearanceMode.rawValue,
            isiCloudSyncEnabled: settings.isiCloudSyncEnabled,
            editorFontName: settings.editorFontName,
            editorFontSize: Double(settings.editorFontSize),
            editorFontColorData: editorFontColorData,
            tagsFilterMode: settings.tagsFilterMode.rawValue
        )
    }

    /// 收集AI配置
    private func collectAIConfigs() -> [AIConfigData]? {
        let configs = AIConfigManager.shared.configs
        guard !configs.isEmpty else { return nil }
        return configs.map { config in
            return AIConfigData(
                id: config.id.uuidString,
                serviceType: "openai-compatible",
                name: config.name,
                // 凭据永不进入配置同步信封；每台设备从本机 Keychain 获取。
                apiKey: nil,
                baseURL: config.baseURL,
                model: config.model,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                systemPrompt: nil,
                createdAt: nil,
                updatedAt: nil
            )
        }
    }

    /// 收集选中的AI配置ID
    private func collectSelectedAIConfigID() -> String? {
        return NotebookDefaults.shared.string(forKey: "ai.selectedConfigID")
    }

    /// 收集环形菜单设置
    private func collectRadialMenuSettings() -> RadialMenuSettingsData? {
        let defaults = NotebookDefaults.shared

        guard defaults.object(forKey: "radialMenuEnabled") != nil else {
            return nil
        }

        let enabled = defaults.bool(forKey: "radialMenuEnabled")
        let trigger = defaults.string(forKey: "radialMenuTrigger") ?? "rightClick"
        let radius = CGFloat(defaults.double(forKey: "radialMenuRadius"))
        let itemSize = CGFloat(defaults.double(forKey: "radialMenuItemSize"))
        let scale = CGFloat(defaults.double(forKey: "radialMenuScale"))

        // 收集菜单项
        let itemsData = collectRadialMenuItems()

        return RadialMenuSettingsData(
            enabled: enabled,
            trigger: trigger,
            radius: radius > 0 ? radius : 120, // 默认值
            itemSize: itemSize > 0 ? itemSize : 44, // 默认值
            scale: scale > 0 ? scale : 1.0, // 默认值
            items: itemsData
        )
    }

    /// 收集环形菜单项
    private func collectRadialMenuItems() -> [RadialMenuItemData]? {
        guard let itemsArray = NotebookDefaults.shared.array(forKey: "radialMenuItems") as? [[String: Any]] else {
            return nil
        }

        return itemsArray.compactMap { itemDict in
            guard let id = itemDict["id"] as? String,
                  let title = itemDict["title"] as? String,
                  let icon = itemDict["icon"] as? String,
                  let order = itemDict["order"] as? Int else {
                return nil
            }

            // 解析快捷键（可选）
            var shortcutData: KeyboardShortcutData? = nil
            if let shortcutDict = itemDict["shortcut"] as? [String: Any],
               let key = shortcutDict["key"] as? String,
               let modifiers = shortcutDict["modifiers"] as? Int {
                shortcutData = KeyboardShortcutData(key: key, modifiers: modifiers)
            }

            return RadialMenuItemData(
                id: id,
                title: title,
                icon: icon,
                shortcut: shortcutData,
                order: order
            )
        }
    }

    /// 收集键盘快捷键
    private func collectKeyboardShortcuts() -> [String: KeyboardShortcutData]? {
        guard let shortcutsDict = NotebookDefaults.shared.dictionary(forKey: "keyboardShortcuts") as? [String: [String: Any]] else {
            return nil
        }

        var result: [String: KeyboardShortcutData] = [:]

        for (action, shortcutDict) in shortcutsDict {
            guard let key = shortcutDict["key"] as? String,
                  let modifiers = shortcutDict["modifiers"] as? Int else {
                continue
            }

            result[action] = KeyboardShortcutData(key: key, modifiers: modifiers)
        }

        return result.isEmpty ? nil : result
    }

    /// 收集笔记数量
    private func collectNoteCount() -> Int? {
        // 尝试从UserDefaults获取
        if let noteCount = NotebookDefaults.shared.object(forKey: "notebook_note_count") as? Int {
            return noteCount
        }
        return nil
    }

    /// 收集文件夹数量
    private func collectFolderCount() -> Int? {
        if let folderCount = NotebookDefaults.shared.object(forKey: "notebook_folder_count") as? Int {
            return folderCount
        }
        return nil
    }

    /// 收集标签数量
    private func collectTagCount() -> Int? {
        if let tagCount = NotebookDefaults.shared.object(forKey: "notebook_tag_count") as? Int {
            return tagCount
        }
        return nil
    }

    /// 收集加密文件夹数量
    private func collectEncryptedFolderCount() -> Int? {
        if let data = NotebookDefaults.shared.data(forKey: "encrypted_folders"),
           let folders = try? JSONDecoder().decode([EncryptedFolder].self, from: data) {
            return folders.count
        }
        return nil
    }

    /// 获取设备标识符
    private func getDeviceIdentifier() -> String {
        // 使用系统标识符，如果不可用则生成UUID
        if let serialNumber = getHardwareSerialNumber() {
            return serialNumber
        }

        // 使用UserDefaults存储的设备ID
        let defaults = NotebookDefaults.shared
        if let deviceID = defaults.string(forKey: "device_identifier") {
            return deviceID
        }

        // 生成新的设备ID
        let newDeviceID = UUID().uuidString
        defaults.set(newDeviceID, forKey: "device_identifier")
        return newDeviceID
    }

    /// 获取硬件序列号
    private func getHardwareSerialNumber() -> String? {
        let platformExpert = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        defer { IOObjectRelease(platformExpert) }

        guard platformExpert != 0 else { return nil }

        guard let serialNumber = IORegistryEntryCreateCFProperty(platformExpert, kIOPlatformSerialNumberKey as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String else {
            return nil
        }

        return serialNumber
    }

    // MARK: - 配置应用

    /// 应用远程配置到本地
    func applyRemoteConfig(_ envelope: ConfigSyncEnvelope, mergeStrategy: ConfigMergeStrategy = .preferNewer) -> ConfigSyncResult {
        var result = ConfigSyncResult()

        // 记录开始时间
        let startTime = Date()

        // 应用应用设置
        if let appSettings = envelope.appSettings {
            result.appliedAppSettings = applyAppSettings(appSettings, envelopeExportedAt: envelope.exportedAt, mergeStrategy: mergeStrategy)
        }

        // 应用AI配置
        if let aiConfigs = envelope.aiConfigs {
            result.appliedAIConfigs = applyAIConfigs(aiConfigs, envelope.selectedAIConfigID, mergeStrategy: mergeStrategy)
        }

        // 应用环形菜单设置
        if let radialMenuSettings = envelope.radialMenuSettings {
            result.appliedRadialMenuSettings = applyRadialMenuSettings(radialMenuSettings, envelopeExportedAt: envelope.exportedAt, mergeStrategy: mergeStrategy)
        }

        // 应用键盘快捷键
        if let keyboardShortcuts = envelope.keyboardShortcuts {
            result.appliedKeyboardShortcuts = applyKeyboardShortcuts(keyboardShortcuts, mergeStrategy: mergeStrategy)
        }

        // 记录统计信息
        result.deviceID = envelope.deviceID
        result.exportedAt = envelope.exportedAt
        result.duration = Date().timeIntervalSince(startTime)

        return result
    }

    /// 应用应用设置
    private func applyAppSettings(_ settings: AppSettingsData, envelopeExportedAt: Date, mergeStrategy: ConfigMergeStrategy) -> Bool {
        let appSettings = AppSettings.shared
        let defaults = NotebookDefaults.shared

        // 检查时间戳，如果本地设置更新，根据策略决定是否覆盖
        let lastModifiedKey = "app_settings_last_modified"
        if let lastModified = defaults.object(forKey: lastModifiedKey) as? Date {
            switch mergeStrategy {
            case .preferLocal:
                return false // 保留本地设置
            case .preferRemote:
                break // 总是应用远程设置
            case .preferNewer:
                // 比较时间戳
                if lastModified > envelopeExportedAt {
                    return false // 本地设置更新，不覆盖
                }
            }
        }

        // 应用设置
        if let isFoldersExpanded = settings.isFoldersExpanded {
            appSettings.isFoldersExpanded = isFoldersExpanded
        }

        if let isTagsExpanded = settings.isTagsExpanded {
            appSettings.isTagsExpanded = isTagsExpanded
        }

        if let isTodoExpanded = settings.isTodoExpanded {
            appSettings.isTodoExpanded = isTodoExpanded
        }

        if let lastSelectedNoteID = settings.lastSelectedNoteID {
            appSettings.lastSelectedNoteID = UUID(uuidString: lastSelectedNoteID)
        }

        if let lastSelectedFolder = settings.lastSelectedFolder {
            appSettings.lastSelectedFolder = lastSelectedFolder
        }

        if let startupBehavior = settings.startupBehavior,
           let behavior = AppSettings.StartupBehavior(rawValue: startupBehavior) {
            appSettings.startupBehavior = behavior
        }

        if let accentColorData = settings.accentColorData,
           let color = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSColor.self, from: accentColorData) {
            appSettings.accentColor = Color(color)
        }

        if let appearanceMode = settings.appearanceMode,
           let mode = AppSettings.AppearanceMode(rawValue: appearanceMode) {
            appSettings.appearanceMode = mode
        }

        if let isiCloudSyncEnabled = settings.isiCloudSyncEnabled {
            appSettings.isiCloudSyncEnabled = isiCloudSyncEnabled
        }

        if let editorFontName = settings.editorFontName {
            appSettings.editorFontName = editorFontName
        }

        if let editorFontSize = settings.editorFontSize {
            appSettings.editorFontSize = CGFloat(editorFontSize)
        }

        if let editorFontColorData = settings.editorFontColorData,
           let color = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSColor.self, from: editorFontColorData) {
            appSettings.editorFontColor = color
        }

        if let tagsFilterMode = settings.tagsFilterMode,
           let mode = AppSettings.TagsFilterMode(rawValue: tagsFilterMode) {
            appSettings.tagsFilterMode = mode
        }

        // 更新时间戳
        defaults.set(Date(), forKey: lastModifiedKey)

        return true
    }

    /// 应用AI配置
    private func applyAIConfigs(_ configs: [AIConfigData], _ selectedConfigID: String?, mergeStrategy: ConfigMergeStrategy) -> Int {
        let manager = AIConfigManager.shared
        var appliedCount = 0
        var mergedByID = Dictionary(uniqueKeysWithValues: manager.configs.map { ($0.id, $0) })

        for config in configs {
            guard let id = UUID(uuidString: config.id),
                  let baseURL = config.baseURL,
                  let model = config.model else { continue }
            if mergedByID[id] != nil {
                if case .preferLocal = mergeStrategy { continue }
            }

            // API Key 保留本机 Keychain 中同 ID 的值，不接受远程凭据。
            let localKey = AIConfigKeychainStore.load(configID: id) ?? ""
            mergedByID[id] = AIServiceConfig(
                id: id,
                name: config.name,
                baseURL: baseURL,
                apiKey: localKey,
                model: model,
                temperature: config.temperature ?? 0.7,
                maxTokens: config.maxTokens ?? 2_000
            )
            appliedCount += 1
        }

        manager.importConfigs(Array(mergedByID.values).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending })
        if let selectedConfigID,
           let selectedID = UUID(uuidString: selectedConfigID),
           mergedByID[selectedID] != nil {
            manager.selectConfig(id: selectedID)
        }

        return appliedCount
    }

    /// 应用环形菜单设置
    private func applyRadialMenuSettings(_ settings: RadialMenuSettingsData, envelopeExportedAt: Date, mergeStrategy: ConfigMergeStrategy) -> Bool {
        let defaults = NotebookDefaults.shared

        // 检查时间戳
        let lastModifiedKey = "radial_menu_last_modified"
        if let lastModified = defaults.object(forKey: lastModifiedKey) as? Date {
            switch mergeStrategy {
            case .preferLocal:
                return false
            case .preferRemote:
                break
            case .preferNewer:
                if lastModified > envelopeExportedAt {
                    return false
                }
            }
        }

        // 应用基本设置
        defaults.set(settings.enabled, forKey: "radialMenuEnabled")
        defaults.set(settings.trigger, forKey: "radialMenuTrigger")
        defaults.set(Double(settings.radius), forKey: "radialMenuRadius")
        defaults.set(Double(settings.itemSize), forKey: "radialMenuItemSize")
        defaults.set(Double(settings.scale), forKey: "radialMenuScale")

        // 应用菜单项
        if let items = settings.items {
            let itemsArray = items.map { item in
                var itemDict: [String: Any] = [
                    "id": item.id,
                    "title": item.title,
                    "icon": item.icon,
                    "order": item.order
                ]

                if let shortcut = item.shortcut {
                    itemDict["shortcut"] = [
                        "key": shortcut.key,
                        "modifiers": shortcut.modifiers
                    ]
                }

                return itemDict
            }
            defaults.set(itemsArray, forKey: "radialMenuItems")
        }

        // 更新时间戳
        defaults.set(Date(), forKey: lastModifiedKey)

        return true
    }

    /// 应用键盘快捷键
    private func applyKeyboardShortcuts(_ shortcuts: [String: KeyboardShortcutData], mergeStrategy: ConfigMergeStrategy) -> Int {
        let defaults = NotebookDefaults.shared

        // 获取现有快捷键
        var existingShortcuts = defaults.dictionary(forKey: "keyboardShortcuts") as? [String: [String: Any]] ?? [:]
        var appliedCount = 0

        for (action, shortcut) in shortcuts {
            // 检查是否已存在该操作的快捷键
            if existingShortcuts[action] != nil {
                switch mergeStrategy {
                case .preferLocal:
                    continue // 跳过，保留本地快捷键
                case .preferRemote, .preferNewer:
                    // 更新快捷键
                    existingShortcuts[action] = [
                        "key": shortcut.key,
                        "modifiers": shortcut.modifiers
                    ]
                    appliedCount += 1
                }
            } else {
                // 新增快捷键
                existingShortcuts[action] = [
                    "key": shortcut.key,
                    "modifiers": shortcut.modifiers
                ]
                appliedCount += 1
            }
        }

        // 保存快捷键
        defaults.set(existingShortcuts, forKey: "keyboardShortcuts")

        return appliedCount
    }

    // MARK: - SSH同步集成

    /// 同步配置到远程服务器
    func syncConfigToRemote(config: SSHConfig) async throws {
        let sshpassPath = try findSshpassPath()

        // 收集本地配置
        let configEnvelope = collectLocalConfig()

        // 序列化配置
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(configEnvelope)

        // 写入临时文件
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("config_sync_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        // 确保远程目录存在
        try await ensureRemoteDirectory(config: config)

        // 上传配置
        let remoteTempPath = "\(config.repositoryPath)/config.json.tmp"
        let remoteTargetPath = "\(config.repositoryPath)/config.json"

        try await runSCPUpload(
            sshpassPath: sshpassPath,
            config: config,
            localPath: tempFileURL.path,
            remotePath: remoteTempPath
        )

        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv '\(escapeSingleQuoted(remoteTempPath))' '\(escapeSingleQuoted(remoteTargetPath))'"
        )

        DebugLog.storage("配置同步完成：已上传到 \(remoteTargetPath)", level: .debug)
    }

    /// 从远程服务器同步配置
    func syncConfigFromRemote(config: SSHConfig, mergeStrategy: ConfigMergeStrategy = .preferNewer) async throws -> ConfigSyncResult {
        let sshpassPath = try findSshpassPath()

        let remotePath = "\(config.repositoryPath)/config.json"
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("config_sync_pull_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        do {
            try await runSCPDownload(
                sshpassPath: sshpassPath,
                config: config,
                remotePath: remotePath,
                localPath: tempFileURL.path
            )
        } catch {
            if isRemoteConfigFileMissing(error) {
                DebugLog.storage("远程配置文件不存在：\(remotePath)", level: .debug)
                return ConfigSyncResult()
            }
            throw error
        }

        let payload = try Data(contentsOf: tempFileURL)
        let configEnvelope = try JSONDecoder().decode(ConfigSyncEnvelope.self, from: payload)
        let result = applyRemoteConfig(configEnvelope, mergeStrategy: mergeStrategy)

        DebugLog.storage("配置同步完成：从 \(configEnvelope.deviceID) 同步了 \(result.totalApplied) 项配置", level: .debug)
        return result
    }

    // MARK: - SSH 工具方法

    private func findSshpassPath() throws -> String {
        guard let path = SSHProcessTransport.findSSHpassPath() else {
            throw NSError(
                domain: "ConfigSync",
                code: -1000,
                userInfo: [NSLocalizedDescriptionKey: "未找到 sshpass，请先安装后再同步配置"]
            )
        }
        return path
    }

    private func ensureRemoteDirectory(config: SSHConfig) async throws {
        let sshpassPath = try findSshpassPath()
        let quotedRemotePath = config.repositoryPath
            .replacingOccurrences(of: "'", with: "'\"'\"'")
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p '\(quotedRemotePath)'"
        )
    }

    private func runSSHCommand(sshpassPath: String, config: SSHConfig, command: String) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: sshArguments(config: config, command: command),
            password: config.password
        )
        if result.terminationStatus != 0 {
            let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "ConfigSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: sanitizeLog(message.isEmpty ? "执行远程命令失败" : message, password: config.password)]
            )
        }
    }

    private func runSCPUpload(sshpassPath: String, config: SSHConfig, localPath: String, remotePath: String) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: scpUploadArguments(config: config, localPath: localPath, remotePath: remotePath),
            password: config.password,
            timeout: 120
        )
        if result.terminationStatus != 0 {
            let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "ConfigSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: sanitizeLog(message.isEmpty ? "上传失败" : message, password: config.password)]
            )
        }
    }

    private func runSCPDownload(sshpassPath: String, config: SSHConfig, remotePath: String, localPath: String) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: scpDownloadArguments(config: config, remotePath: remotePath, localPath: localPath),
            password: config.password,
            timeout: 120
        )
        if result.terminationStatus != 0 {
            let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "ConfigSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: sanitizeLog(message.isEmpty ? "下载失败" : message, password: config.password)]
            )
        }
    }

    private func sshArguments(config: SSHConfig, command: String) -> [String] {
        SSHProcessTransport.sshArguments(config: config, command: command)
    }

    private func scpUploadArguments(config: SSHConfig, localPath: String, remotePath: String) -> [String] {
        SSHProcessTransport.scpUploadArguments(config: config, localPath: localPath, remotePath: remotePath)
    }

    private func scpDownloadArguments(config: SSHConfig, remotePath: String, localPath: String) -> [String] {
        SSHProcessTransport.scpDownloadArguments(config: config, remotePath: remotePath, localPath: localPath)
    }

    private func executeProcess(
        executablePath: String,
        arguments: [String],
        password: String,
        timeout: TimeInterval = 45
    ) async throws -> ProcessExecutionResult {
        let timeoutErrorMessage = sanitizeLog("SSH操作超时，请检查服务器连通性、端口配置或网络状态", password: password)
        return try await CancellableProcessRunner.run(
            executablePath: executablePath,
            arguments: arguments,
            environment: SSHProcessTransport.environment(password: password),
            timeout: timeout,
            timeoutError: NSError(
                domain: "ConfigSync",
                code: -1001,
                userInfo: [NSLocalizedDescriptionKey: timeoutErrorMessage]
            )
        )
    }

    private typealias ProcessExecutionResult = ProcessExecutionOutput

    private func escapeSingleQuoted(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "'\"'\"'")
    }

    private func sanitizeLog(_ text: String, password: String) -> String {
        guard !password.isEmpty else { return text }
        return text.replacingOccurrences(of: password, with: "******")
    }

    private func isRemoteConfigFileMissing(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        if message.contains("no such file") { return true }
        if message.contains("not found") { return true }
        if message.contains("没有那个文件或目录") { return true }
        if message.contains("找不到") { return true }
        if message.contains("cannot stat") { return true }
        return false
    }
}

// MARK: - 辅助类型

/// 配置合并策略
enum ConfigMergeStrategy {
    case preferLocal      // 优先保留本地配置
    case preferRemote     // 优先应用远程配置
    case preferNewer      // 优先应用更新的配置（基于时间戳）
}

/// 配置同步结果
struct ConfigSyncResult {
    var appliedAppSettings: Bool = false
    var appliedAIConfigs: Int = 0
    var appliedRadialMenuSettings: Bool = false
    var appliedKeyboardShortcuts: Int = 0

    var deviceID: String?
    var exportedAt: Date?
    var duration: TimeInterval = 0

    var totalApplied: Int {
        (appliedAppSettings ? 1 : 0) +
        appliedAIConfigs +
        (appliedRadialMenuSettings ? 1 : 0) +
        appliedKeyboardShortcuts
    }
}
