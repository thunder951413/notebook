import Foundation
import SwiftUI

enum ConfigurationTransferHelper {
    static func exportUserDefaults(to directory: URL) throws {
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

    static func exportKeyboardShortcuts(to directory: URL) throws {
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

    static func exportRadialMenuSettings(to directory: URL) throws {
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

    static func exportAppSettings(to directory: URL) throws {
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

    static func exportAIConfig(to directory: URL) throws {
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

        DebugLog.storage("已导出 \(aiManager.configs.count) 个 AI 配置", level: .debug)
    }

    static func exportPasswordConfig(to directory: URL) throws {
        // 导出密码配置（哈希和盐值）
        if let passwordConfig = PasswordManager.shared.exportPasswordConfig() {
            let passwordURL = directory.appendingPathComponent("PasswordConfig.plist")
            try PropertyListSerialization.data(fromPropertyList: passwordConfig, format: .xml, options: 0)
                .write(to: passwordURL)
            DebugLog.storage("已导出密码配置", level: .debug)
        } else {
            DebugLog.storage("没有设置密码，跳过导出", level: .debug)
        }
    }

    static func exportEncryptedFolders(to directory: URL) throws {
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
        DebugLog.storage("已导出加密文件夹配置", level: .debug)
    }

    static func exportEncryptedData(to directory: URL) throws {
        // 导出加密相关数据（加密笔记ID列表和映射关系）
        let encryptedData = EncryptedFolderManager.shared.exportEncryptedData()
        
        let configURL = directory.appendingPathComponent("EncryptedData.plist")
        try PropertyListSerialization.data(fromPropertyList: encryptedData, format: .xml, options: 0)
            .write(to: configURL)
        DebugLog.storage("已导出加密数据", level: .debug)
    }


    static func importUserDefaults(from directory: URL) throws {
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

    static func importKeyboardShortcuts(from directory: URL) throws {
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

    static func importRadialMenuSettings(from directory: URL) throws {
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

    static func importAppSettings(from directory: URL) throws {
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

    static func importAIConfig(from directory: URL) throws {
        // 导入 AI 服务配置
        let configsURL = directory.appendingPathComponent("AIConfigs.json")
        if FileManager.default.fileExists(atPath: configsURL.path) {
            let configsData = try Data(contentsOf: configsURL)
            if let configs = try? JSONDecoder().decode([AIServiceConfig].self, from: configsData) {
                // 保存到 UserDefaults
                if let encoded = try? JSONEncoder().encode(configs) {
                    UserDefaults.standard.set(encoded, forKey: "ai.serviceConfigs")
                }
                DebugLog.storage("已导入 \(configs.count) 个 AI 配置", level: .debug)
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

    static func importPasswordConfig(from directory: URL) throws {
        let passwordURL = directory.appendingPathComponent("PasswordConfig.plist")
        guard FileManager.default.fileExists(atPath: passwordURL.path) else {
            DebugLog.storage("未找到密码配置文件", level: .debug)
            return
        }

        guard let passwordConfig = try PropertyListSerialization.propertyList(from: Data(contentsOf: passwordURL), format: nil) as? [String: String] else {
            DebugLog.storage("密码配置格式错误", level: .warn)
            return
        }

        if PasswordManager.shared.importPasswordConfig(passwordConfig) {
            DebugLog.storage("已导入密码配置", level: .debug)
        } else {
            DebugLog.storage("密码配置导入失败", level: .warn)
        }
    }

    static func importEncryptedFolders(from directory: URL) throws {
        let configURL = directory.appendingPathComponent("EncryptedFolders.plist")
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            DebugLog.storage("未找到加密文件夹配置", level: .debug)
            return
        }

        guard let config = try PropertyListSerialization.propertyList(from: Data(contentsOf: configURL), format: nil) as? [String: Any] else {
            DebugLog.storage("加密文件夹配置格式错误", level: .warn)
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

        DebugLog.storage("已导入加密文件夹配置", level: .debug)
    }

    static func importEncryptedData(from directory: URL) throws {
        let configURL = directory.appendingPathComponent("EncryptedData.plist")
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            DebugLog.storage("未找到加密数据配置", level: .debug)
            return
        }

        guard let encryptedData = try PropertyListSerialization.propertyList(from: Data(contentsOf: configURL), format: nil) as? [String: Any] else {
            DebugLog.storage("加密数据格式错误", level: .warn)
            return
        }

        EncryptedFolderManager.shared.importEncryptedData(encryptedData)
        DebugLog.storage("已导入加密数据", level: .debug)
    }


    static func validateConfigurationImport(at directory: URL) throws {
        let fileManager = FileManager.default

        let userDefaultsURL = directory.appendingPathComponent("UserDefaults.plist")
        if fileManager.fileExists(atPath: userDefaultsURL.path) {
            _ = try propertyListDictionary(at: userDefaultsURL, named: "UserDefaults.plist")
        }

        let shortcutsURL = directory.appendingPathComponent("KeyboardShortcuts.plist")
        if fileManager.fileExists(atPath: shortcutsURL.path) {
            guard (try PropertyListSerialization.propertyList(from: Data(contentsOf: shortcutsURL), format: nil) as? [String: [String: Any]]) != nil else {
                throw DataExportManager.DataImportValidationError.invalidConfigurationFile(name: "KeyboardShortcuts.plist")
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
                throw DataExportManager.DataImportValidationError.invalidConfigurationFile(name: "AISelectedConfig.plist")
            }
        }

        let passwordURL = directory.appendingPathComponent("PasswordConfig.plist")
        if fileManager.fileExists(atPath: passwordURL.path) {
            guard (try PropertyListSerialization.propertyList(from: Data(contentsOf: passwordURL), format: nil) as? [String: String]) != nil else {
                throw DataExportManager.DataImportValidationError.invalidConfigurationFile(name: "PasswordConfig.plist")
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

    static func propertyListDictionary(at url: URL, named fileName: String) throws -> [String: Any] {
        guard let dictionary = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any] else {
            throw DataExportManager.DataImportValidationError.invalidConfigurationFile(name: fileName)
        }
        return dictionary
    }

    static func loadRadialMenuSettings(from directory: URL) throws -> [String: Any]? {
        let fileManager = FileManager.default
        let plistURL = directory.appendingPathComponent("RadialMenuSettings.plist")
        if fileManager.fileExists(atPath: plistURL.path) {
            return try propertyListDictionary(at: plistURL, named: "RadialMenuSettings.plist")
        }

        let jsonURL = directory.appendingPathComponent("RadialMenuSettings.json")
        if fileManager.fileExists(atPath: jsonURL.path) {
            let data = try Data(contentsOf: jsonURL)
            guard let settings = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw DataExportManager.DataImportValidationError.invalidConfigurationFile(name: "RadialMenuSettings.json")
            }
            return settings
        }

        return nil
    }

    static func validatedRadialMenuSettings(from directory: URL) throws -> [String: Any] {
        guard let settings = try loadRadialMenuSettings(from: directory) else {
            throw DataExportManager.DataImportValidationError.invalidConfigurationFile(name: "RadialMenuSettings")
        }
        return settings
    }

}
