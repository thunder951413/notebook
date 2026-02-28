import Foundation
import SwiftUI

/// 应用设置管理器
final class AppSettings {
    static let shared = AppSettings()

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let foldersExpanded = "sidebar_folders_expanded"
        static let tagsExpanded = "sidebar_tags_expanded"
        static let lastSelectedNoteID = "last_selected_note_id"
        static let startupBehavior = "startup_behavior" // "restore", "none", "all_notes"
        static let accentColor = "accent_color" // 主题色
    }

    // MARK: - 侧边栏折叠状态

    var isFoldersExpanded: Bool {
        get { defaults.object(forKey: Keys.foldersExpanded) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Keys.foldersExpanded) }
    }

    var isTagsExpanded: Bool {
        get { defaults.object(forKey: Keys.tagsExpanded) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Keys.tagsExpanded) }
    }

    // MARK: - 最后选中的笔记

    var lastSelectedNoteID: UUID? {
        get {
            guard let uuidString = defaults.string(forKey: Keys.lastSelectedNoteID) else { return nil }
            return UUID(uuidString: uuidString)
        }
        set {
            if let id = newValue {
                defaults.set(id.uuidString, forKey: Keys.lastSelectedNoteID)
            } else {
                defaults.removeObject(forKey: Keys.lastSelectedNoteID)
            }
        }
    }

    // MARK: - 启动行为

    enum StartupBehavior: String, CaseIterable {
        case restoreLastNote = "restore"
        case selectNone = "none"
        case showAllNotes = "all_notes"

        var displayName: String {
            switch self {
            case .restoreLastNote: return l10n(L10nKeys.Startup.restoreLastNote)
            case .selectNone: return l10n(L10nKeys.Startup.selectNone)
            case .showAllNotes: return l10n(L10nKeys.Startup.showAllNotes)
            }
        }
    }

    var startupBehavior: StartupBehavior {
        get {
            guard let rawValue = defaults.string(forKey: Keys.startupBehavior),
                  let behavior = StartupBehavior(rawValue: rawValue) else {
                return .restoreLastNote
            }
            return behavior
        }
        set { defaults.set(newValue.rawValue, forKey: Keys.startupBehavior) }
    }

    // MARK: - 主题色

    /// 预设的主题色
    static let presetColors: [Color] = [
        Color(red: 0.0, green: 0.48, blue: 1.0),    // 蓝色 (默认)
        Color(red: 0.0, green: 0.78, blue: 0.33),   // 绿色
        Color(red: 1.0, green: 0.23, blue: 0.19),   // 红色
        Color(red: 1.0, green: 0.58, blue: 0.0),    // 橙色
        Color(red: 0.95, green: 0.76, blue: 0.0),   // 黄色
        Color(red: 0.75, green: 0.33, blue: 0.95),  // 紫色
        Color(red: 1.0, green: 0.18, blue: 0.33),   // 粉色
        Color(red: 0.0, green: 0.73, blue: 0.83),   // 青色
        Color(red: 0.4, green: 0.4, blue: 0.4),     // 灰色
    ]

    var accentColor: Color {
        get {
            guard let colorData = defaults.data(forKey: Keys.accentColor),
                  let color = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSColor.self, from: colorData) else {
                return AppSettings.presetColors[0] // 默认蓝色
            }
            return Color(color)
        }
        set {
            let nsColor = NSColor(newValue)
            if let colorData = try? NSKeyedArchiver.archivedData(withRootObject: nsColor, requiringSecureCoding: false) {
                defaults.set(colorData, forKey: Keys.accentColor)
            }
        }
    }

    private init() {}
}
