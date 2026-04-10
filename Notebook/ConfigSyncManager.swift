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
        let version: String = "1.0"

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
        let defaults = UserDefaults.standard
        let accentColorData = defaults.data(forKey: "accent_color")
        let editorFontColorData = defaults.data(forKey: "editor_font_color")

        return AppSettingsData(
            isFoldersExpanded: settings.isFoldersExpanded,
            isTagsExpanded: settings.isTagsExpanded,
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
        guard let configs = UserDefaults.standard.object(forKey: "ai.serviceConfigs") as? [[String: Any]] else {
            return nil
        }

        return configs.compactMap { dict in
            guard let id = dict["id"] as? String,
                  let serviceType = dict["serviceType"] as? String,
                  let name = dict["name"] as? String else {
                return nil
            }

            let apiKey = dict["apiKey"] as? String
            let baseURL = dict["baseURL"] as? String
            let model = dict["model"] as? String
            let temperature = dict["temperature"] as? Double
            let maxTokens = dict["maxTokens"] as? Int
            let systemPrompt = dict["systemPrompt"] as? String

            // 日期处理
            let createdAt = (dict["createdAt"] as? Date) ?? Date()
            let updatedAt = dict["updatedAt"] as? Date

            return AIConfigData(
                id: id,
                serviceType: serviceType,
                name: name,
                apiKey: apiKey,
                baseURL: baseURL,
                model: model,
                temperature: temperature,
                maxTokens: maxTokens,
                systemPrompt: systemPrompt,
                createdAt: createdAt,
                updatedAt: updatedAt
            )
        }
    }

    /// 收集选中的AI配置ID
    private func collectSelectedAIConfigID() -> String? {
        return UserDefaults.standard.string(forKey: "ai.selectedConfigID")
    }

    /// 收集环形菜单设置
    private func collectRadialMenuSettings() -> RadialMenuSettingsData? {
        let defaults = UserDefaults.standard

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
        guard let itemsArray = UserDefaults.standard.array(forKey: "radialMenuItems") as? [[String: Any]] else {
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
        guard let shortcutsDict = UserDefaults.standard.dictionary(forKey: "keyboardShortcuts") as? [String: [String: Any]] else {
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
        if let noteCount = UserDefaults.standard.object(forKey: "notebook_note_count") as? Int {
            return noteCount
        }
        return nil
    }

    /// 收集文件夹数量
    private func collectFolderCount() -> Int? {
        if let folderCount = UserDefaults.standard.object(forKey: "notebook_folder_count") as? Int {
            return folderCount
        }
        return nil
    }

    /// 收集标签数量
    private func collectTagCount() -> Int? {
        if let tagCount = UserDefaults.standard.object(forKey: "notebook_tag_count") as? Int {
            return tagCount
        }
        return nil
    }

    /// 收集加密文件夹数量
    private func collectEncryptedFolderCount() -> Int? {
        if let data = UserDefaults.standard.data(forKey: "encrypted_folders"),
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
        let defaults = UserDefaults.standard
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
        let defaults = UserDefaults.standard

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
        let defaults = UserDefaults.standard
        var appliedCount = 0

        // 获取现有配置
        var existingConfigs = defaults.array(forKey: "ai.serviceConfigs") as? [[String: Any]] ?? []

        for config in configs {
            // 检查是否已存在相同ID的配置
            if let existingIndex = existingConfigs.firstIndex(where: { ($0["id"] as? String) == config.id }) {
                // 根据策略决定是否更新
                switch mergeStrategy {
                case .preferLocal:
                    continue // 跳过，保留本地配置
                case .preferRemote, .preferNewer:
                    // 总是更新或比较时间戳
                    existingConfigs[existingIndex] = convertAIConfigToDict(config)
                    appliedCount += 1
                }
            } else {
                // 新增配置
                existingConfigs.append(convertAIConfigToDict(config))
                appliedCount += 1
            }
        }

        // 保存配置
        defaults.set(existingConfigs, forKey: "ai.serviceConfigs")

        // 更新选中的配置ID
        if let selectedConfigID = selectedConfigID,
           existingConfigs.contains(where: { ($0["id"] as? String) == selectedConfigID }) {
            defaults.set(selectedConfigID, forKey: "ai.selectedConfigID")
        }

        return appliedCount
    }

    /// 转换AI配置为字典
    private func convertAIConfigToDict(_ config: AIConfigData) -> [String: Any] {
        var dict: [String: Any] = [
            "id": config.id,
            "serviceType": config.serviceType,
            "name": config.name
        ]

        if let apiKey = config.apiKey { dict["apiKey"] = apiKey }
        if let baseURL = config.baseURL { dict["baseURL"] = baseURL }
        if let model = config.model { dict["model"] = model }
        if let temperature = config.temperature { dict["temperature"] = temperature }
        if let maxTokens = config.maxTokens { dict["maxTokens"] = maxTokens }
        if let systemPrompt = config.systemPrompt { dict["systemPrompt"] = systemPrompt }
        if let createdAt = config.createdAt { dict["createdAt"] = createdAt }
        if let updatedAt = config.updatedAt { dict["updatedAt"] = updatedAt }

        return dict
    }

    /// 应用环形菜单设置
    private func applyRadialMenuSettings(_ settings: RadialMenuSettingsData, envelopeExportedAt: Date, mergeStrategy: ConfigMergeStrategy) -> Bool {
        let defaults = UserDefaults.standard

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
        let defaults = UserDefaults.standard

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

        print("配置同步完成：已上传到 \(remoteTargetPath)")
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
                print("远程配置文件不存在：\(remotePath)")
                return ConfigSyncResult()
            }
            throw error
        }

        let payload = try Data(contentsOf: tempFileURL)
        let configEnvelope = try JSONDecoder().decode(ConfigSyncEnvelope.self, from: payload)
        let result = applyRemoteConfig(configEnvelope, mergeStrategy: mergeStrategy)

        print("配置同步完成：从 \(configEnvelope.deviceID) 同步了 \(result.totalApplied) 项配置")
        return result
    }

    // MARK: - SSH工具方法（从SSHSyncManager复制）

    private func findSshpassPath() throws -> String {
        // 复用SSHSyncManager中的逻辑
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/zsh")
        task.arguments = ["-c", "which sshpass 2>/dev/null || echo ''"]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        do {
            try task.run()
            task.waitUntilExit()

            if task.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty {
                    return path
                }
            }
        } catch {
            print("which sshpass 失败: \(error)")
        }

        // 回退到硬编码路径
        return "/usr/local/bin/sshpass"
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
        [
            "-p", config.password,
            "ssh"
        ] + commonSSHOptions(port: config.port) + [
            "\(config.username)@\(config.host)",
            command
        ]
    }

    private func scpUploadArguments(config: SSHConfig, localPath: String, remotePath: String) -> [String] {
        [
            "-p", config.password,
            "scp"
        ] + commonSCPOptions(port: config.port) + [
            localPath,
            "\(config.username)@\(config.host):\(remotePath)"
        ]
    }

    private func scpDownloadArguments(config: SSHConfig, remotePath: String, localPath: String) -> [String] {
        [
            "-p", config.password,
            "scp"
        ] + commonSCPOptions(port: config.port) + [
            "\(config.username)@\(config.host):\(remotePath)",
            localPath
        ]
    }

    private func commonSSHOptions(port: Int) -> [String] {
        [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=2",
            "-p", String(port)
        ]
    }

    private func commonSCPOptions(port: Int) -> [String] {
        [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=2",
            "-P", String(port)
        ]
    }

    private func executeProcess(
        executablePath: String,
        arguments: [String],
        password: String,
        timeout: TimeInterval = 45
    ) async throws -> ProcessExecutionResult {
        // 复制SSHSyncManager中的ProcessExecutionResult逻辑
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executablePath)
        task.arguments = arguments
        task.environment = env
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        task.standardOutput = outputPipe
        task.standardError = errorPipe

        let timeoutErrorMessage = sanitizeLog("SSH操作超时，请检查服务器连通性、端口配置或网络状态", password: password)

        return try await withCheckedThrowingContinuation { continuation in
            let lock = NSLock()
            var finished = false
            let finishedQueue = DispatchQueue(label: "com.notebook.configsync.finished")

            @Sendable func resume(_ result: Result<ProcessExecutionResult, Error>) {
                lock.lock()
                defer { lock.unlock() }

                var shouldResume = false
                finishedQueue.sync {
                    guard !finished else { return }
                    finished = true
                    shouldResume = true
                }

                guard shouldResume else { return }
                continuation.resume(with: result)
            }

            task.terminationHandler = { process in
                let output = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let error = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                resume(.success(ProcessExecutionResult(
                    terminationStatus: process.terminationStatus,
                    standardOutput: output,
                    standardError: error
                )))
            }

            do {
                try task.run()
            } catch {
                resume(.failure(error))
                return
            }

            Task.detached {
                let delay = UInt64(max(1, timeout) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: delay)
                guard task.isRunning else { return }
                task.terminate()
                resume(.failure(NSError(
                    domain: "ConfigSync",
                    code: -1001,
                    userInfo: [NSLocalizedDescriptionKey: timeoutErrorMessage]
                )))
            }
        }
    }

    private struct ProcessExecutionResult {
        let terminationStatus: Int32
        let standardOutput: String
        let standardError: String
    }

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
