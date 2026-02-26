import Foundation
import SwiftUI
import Combine

/// 支持的语言
enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case system = "system"
    case chinese = "zh"
    case english = "en"
    
    var id: String { rawValue }
    
    var displayName: String {
        switch self {
        case .system:
            return "跟随系统"
        case .chinese:
            return "简体中文"
        case .english:
            return "English"
        }
    }
    
    var localeIdentifier: String? {
        switch self {
        case .system:
            return nil
        case .chinese:
            return "zh-Hans"
        case .english:
            return "en"
        }
    }
}

/// 语言管理器
final class LanguageManager: ObservableObject {
    static let shared = LanguageManager()
    
    private let languageKey = "app_language"
    private var cancellables = Set<AnyCancellable>()
    
    @Published var currentLanguage: AppLanguage
    
    private init() {
        let savedValue = UserDefaults.standard.string(forKey: languageKey) ?? "system"
        self._currentLanguage = Published(wrappedValue: AppLanguage(rawValue: savedValue) ?? .system)
        
        // 监听语言变化
        $currentLanguage
            .dropFirst()
            .sink { [weak self] newLanguage in
                UserDefaults.standard.set(newLanguage.rawValue, forKey: self?.languageKey ?? "app_language")
                self?.applyLanguage()
            }
            .store(in: &cancellables)
    }
    
    /// 应用当前语言设置
    func applyLanguage() {
        guard let identifier = currentLanguage.localeIdentifier else {
            // 系统默认，重置为系统语言
            UserDefaults.standard.removeObject(forKey: "AppleLanguages")
            return
        }
        
        UserDefaults.standard.set([identifier], forKey: "AppleLanguages")
        UserDefaults.standard.synchronize()
    }
    
    /// 获取本地化字符串
    func localized(_ key: String) -> String {
        guard let identifier = currentLanguage.localeIdentifier else {
            // 使用系统默认
            return NSLocalizedString(key, comment: "")
        }
        
        guard let path = Bundle.main.path(forResource: identifier, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            return NSLocalizedString(key, comment: "")
        }
        
        return NSLocalizedString(key, tableName: nil, bundle: bundle, value: "", comment: "")
    }
}

/// 便捷访问方法 - 使用小写 l10n 避免与结构体重名
func l10n(_ key: String) -> String {
    LanguageManager.shared.localized(key)
}

/// 本地化字符串常量
struct L10nKeys {
    // MARK: - 通用
    static let appName = "Reminder"
    static let ok = "OK"
    static let cancel = "Cancel"
    static let save = "Save"
    static let delete = "Delete"
    static let edit = "Edit"
    static let done = "Done"
    static let close = "Close"
    
    // MARK: - 语言设置
    struct Language {
        static let title = "language.title"
        static let system = "language.system"
    }
    
    // MARK: - 笔记
    struct Note {
        static let newNote = "note.new"
        static let untitled = "note.untitled"
        static let searchPlaceholder = "note.search.placeholder"
        static let deleteConfirm = "note.delete.confirm"
    }
    
    // MARK: - 文件夹
    struct Folder {
        static let allNotes = "folder.all"
        static let uncategorized = "folder.uncategorized"
        static let newFolder = "folder.new"
    }
    
    // MARK: - 设置
    struct Settings {
        static let title = "settings.title"
        static let storageLocation = "settings.storage.location"
        static let storageCurrentPath = "settings.storage.current"
        static let storageNotConfigured = "settings.storage.notConfigured"
        static let storageChange = "settings.storage.change"
        static let storageSelect = "settings.storage.select"
        static let storageShowInFinder = "settings.storage.showInFinder"
    }

    // MARK: - 备份
    struct Backup {
        static let title = "backup.title"
        static let description = "backup.description"
        static let restore = "backup.restore"
        static let clear = "backup.clear"
    }
}
