import Foundation
import SwiftUI
import Combine

/// 应用设置管理器（支持 iCloud 同步）
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private let defaults = UserDefaults.standard
    private var cancellables = Set<AnyCancellable>()
    
    /// 是否启用 iCloud 同步设置
    @Published var isiCloudSyncEnabled: Bool = false {
        didSet {
            defaults.set(isiCloudSyncEnabled, forKey: Keys.iCloudSyncEnabled)
            if isiCloudSyncEnabled {
                syncToiCloud()
            }
        }
    }

    private enum Keys {
        static let foldersExpanded = "sidebar_folders_expanded"
        static let tagsExpanded = "sidebar_tags_expanded"
        static let lastSelectedNoteID = "last_selected_note_id"
        static let lastSelectedFolder = "last_selected_folder"
        static let startupBehavior = "startup_behavior" // "restore", "none", "all_notes"
        static let accentColor = "accent_color" // 主题色
        static let appearanceMode = "appearance_mode"
        static let iCloudSyncEnabled = "icloud_sync_enabled"
        static let editorFontName = "editor_font_name" // 编辑器字体名称
        static let editorFontSize = "editor_font_size" // 编辑器字号
        static let tagsFilterMode = "tags_filter_mode" // 标签过滤模式: "current" 当前目录, "all" 所有标签
        static let editorFontColor = "editor_font_color" // 编辑器字体颜色
        static let isFileLoggingEnabled = "logger.file_logging_enabled"
        static let keepHistoricalLogFiles = "logger.keep_historical_files"
        static let githubRepositoryURL = "update.github_repository_url"
        static let recentNoteLoadLimit = "notes.recent_load_limit"
        static let recentSelectedNoteIDs = "notes.recent_selected_ids"
        static let aiKnowledgeBaseTopK = "ai.knowledge_base_top_k"
    }

    static let defaultRecentNoteLoadLimit = 5
    static let minRecentNoteLoadLimit = 1
    static let maxRecentNoteLoadLimit = 50

    static let defaultAIKnowledgeBaseTopK = 5
    static let minAIKnowledgeBaseTopK = 1
    static let maxAIKnowledgeBaseTopK = 20
    
    // iCloud 同步键（使用 NSUbiquitousKeyValueStore）
    private enum iCloudKeys {
        static let foldersExpanded = "icloud.sidebar_folders_expanded"
        static let tagsExpanded = "icloud.sidebar_tags_expanded"
        static let startupBehavior = "icloud.startup_behavior"
        static let accentColor = "icloud.accent_color"
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

    // MARK: - 最近笔记内容加载

    var recentNoteLoadLimit: Int {
        get {
            let storedValue = defaults.object(forKey: Keys.recentNoteLoadLimit) as? Int
            return Self.clampedRecentNoteLoadLimit(storedValue ?? Self.defaultRecentNoteLoadLimit)
        }
        set {
            defaults.set(Self.clampedRecentNoteLoadLimit(newValue), forKey: Keys.recentNoteLoadLimit)
        }
    }

    // MARK: - AI 全库问答 Top-K 数量

    var aiKnowledgeBaseTopK: Int {
        get {
            let storedValue = defaults.object(forKey: Keys.aiKnowledgeBaseTopK) as? Int
            return Self.clampedAIKnowledgeBaseTopK(storedValue ?? Self.defaultAIKnowledgeBaseTopK)
        }
        set {
            defaults.set(Self.clampedAIKnowledgeBaseTopK(newValue), forKey: Keys.aiKnowledgeBaseTopK)
        }
    }

    private static func clampedAIKnowledgeBaseTopK(_ value: Int) -> Int {
        min(max(value, minAIKnowledgeBaseTopK), maxAIKnowledgeBaseTopK)
    }

    var recentSelectedNoteIDs: [UUID] {
        get {
            defaults.stringArray(forKey: Keys.recentSelectedNoteIDs)?
                .compactMap(UUID.init(uuidString:)) ?? []
        }
        set {
            var seen = Set<UUID>()
            let uniqueIDs = newValue.filter { seen.insert($0).inserted }
            defaults.set(
                uniqueIDs
                    .prefix(Self.maxRecentNoteLoadLimit)
                    .map(\.uuidString),
                forKey: Keys.recentSelectedNoteIDs
            )
        }
    }

    func recordRecentlySelectedNote(_ id: UUID?) {
        guard let id else { return }
        var ids = recentSelectedNoteIDs.filter { $0 != id }
        ids.insert(id, at: 0)
        recentSelectedNoteIDs = ids
    }

    private static func clampedRecentNoteLoadLimit(_ value: Int) -> Int {
        min(max(value, minRecentNoteLoadLimit), maxRecentNoteLoadLimit)
    }

    // MARK: - 最后选中的文件夹

    var lastSelectedFolder: String? {
        get {
            return defaults.string(forKey: Keys.lastSelectedFolder)
        }
        set {
            if let folder = newValue {
                defaults.set(folder, forKey: Keys.lastSelectedFolder)
            } else {
                defaults.removeObject(forKey: Keys.lastSelectedFolder)
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

    // MARK: - 日志设置

    var isFileLoggingEnabled: Bool {
        get {
            defaults.bool(forKey: Keys.isFileLoggingEnabled)
        }
        set {
            defaults.set(newValue, forKey: Keys.isFileLoggingEnabled)
            Logger.shared.reloadPersistenceSettings()
        }
    }

    var keepHistoricalLogFiles: Bool {
        get {
            defaults.bool(forKey: Keys.keepHistoricalLogFiles)
        }
        set {
            defaults.set(newValue, forKey: Keys.keepHistoricalLogFiles)
            Logger.shared.reloadPersistenceSettings()
        }
    }

    var githubRepositoryURLString: String {
        get {
            let value = defaults.string(forKey: Keys.githubRepositoryURL)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return value?.isEmpty == false ? value! : "https://github.com/thunder951413/notebook"
        }
        set {
            defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.githubRepositoryURL)
        }
    }

    var githubRepositoryURL: URL? {
        let rawValue = githubRepositoryURLString
        if let url = URL(string: rawValue), url.scheme != nil {
            return url
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: "/").map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else {
            return nil
        }
        return URL(string: "https://github.com/\(parts[0])/\(parts[1].replacingOccurrences(of: ".git", with: ""))")
    }

    enum AppearanceMode: String, CaseIterable {
        case system
        case light
        case dark

        var displayName: String {
            switch self {
            case .system: return "自动"
            case .light: return "亮色"
            case .dark: return "暗色"
            }
        }

        var symbolName: String {
            switch self {
            case .system: return "circle.lefthalf.filled"
            case .light: return "sun.max"
            case .dark: return "moon"
            }
        }
    }

    var appearanceMode: AppearanceMode {
        get {
            guard let rawValue = defaults.string(forKey: Keys.appearanceMode),
                  let mode = AppearanceMode(rawValue: rawValue) else {
                return .system
            }
            return mode
        }
        set {
            defaults.set(newValue.rawValue, forKey: Keys.appearanceMode)
        }
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

    // MARK: - 编辑器字体设置

    /// 可用的字体列表
    static let availableFonts: [(name: String, displayName: String)] = [
        ("System", "系统默认"),
        ("PingFang SC", "苹方"),
        ("Heiti SC", "黑体"),
        ("Songti SC", "宋体"),
        ("Kaiti SC", "楷体"),
        ("Hiragino Sans GB", "冬青黑体"),
        ("Helvetica Neue", "Helvetica Neue"),
        ("Arial", "Arial"),
        ("Times New Roman", "Times New Roman"),
        ("Menlo", "Menlo"),
        ("Monaco", "Monaco"),
    ]

    /// 字号范围
    static let minFontSize: CGFloat = 10
    static let maxFontSize: CGFloat = 32
    static let defaultFontSize: CGFloat = 15

    /// 编辑器字体名称
    var editorFontName: String {
        get {
            return defaults.string(forKey: Keys.editorFontName) ?? "System"
        }
        set {
            defaults.set(newValue, forKey: Keys.editorFontName)
            // 发送通知让编辑器更新字体
            NotificationCenter.default.post(name: .editorFontDidChange, object: nil)
        }
    }

    /// 编辑器字号
    var editorFontSize: CGFloat {
        get {
            let size = defaults.double(forKey: Keys.editorFontSize)
            return size == 0 ? AppSettings.defaultFontSize : CGFloat(size)
        }
        set {
            let clampedSize = min(max(newValue, AppSettings.minFontSize), AppSettings.maxFontSize)
            defaults.set(Double(clampedSize), forKey: Keys.editorFontSize)
            // 发送通知让编辑器更新字体
            NotificationCenter.default.post(name: .editorFontDidChange, object: nil)
        }
    }

    /// 获取编辑器字体
    var editorFont: NSFont {
        let size = editorFontSize
        if editorFontName == "System" {
            return NSFont.systemFont(ofSize: size)
        }
        return NSFont(name: editorFontName, size: size) ?? NSFont.systemFont(ofSize: size)
    }

    // MARK: - 编辑器字体颜色

    /// 主题颜色（5行 x 10列）
    static let themeColors: [(color: Color, name: String)] = [
        // 第1行 - 浅色
        (Color.white, "白色"), (Color.black, "黑色"), (Color(red: 0.95, green: 0.95, blue: 0.95), "浅灰1"),
        (Color(red: 0.2, green: 0.4, blue: 0.6), "深蓝"), (Color(red: 0.4, green: 0.6, blue: 0.8), "中蓝"),
        (Color(red: 0.8, green: 0.3, blue: 0.3), "砖红"), (Color(red: 0.6, green: 0.8, blue: 0.4), "黄绿"),
        (Color(red: 0.6, green: 0.4, blue: 0.8), "紫罗兰"), (Color(red: 0.4, green: 0.8, blue: 0.9), "天蓝"),
        (Color(red: 1.0, green: 0.6, blue: 0.3), "浅橙"),
        // 第2行
        (Color(red: 0.95, green: 0.95, blue: 0.95), "浅灰2"), (Color(red: 0.5, green: 0.5, blue: 0.5), "中灰"),
        (Color(red: 0.85, green: 0.9, blue: 0.75), "淡绿"), (Color(red: 0.75, green: 0.85, blue: 0.95), "淡蓝"),
        (Color(red: 0.9, green: 0.95, blue: 1.0), "极淡蓝"), (Color(red: 1.0, green: 0.9, blue: 0.9), "淡红"),
        (Color(red: 0.95, green: 1.0, blue: 0.9), "淡黄绿"), (Color(red: 0.95, green: 0.9, blue: 0.95), "淡紫"),
        (Color(red: 0.9, green: 0.95, blue: 1.0), "冰蓝"), (Color(red: 1.0, green: 0.95, blue: 0.9), "奶油"),
        // 第3行
        (Color(red: 0.9, green: 0.9, blue: 0.9), "浅灰3"), (Color(red: 0.4, green: 0.4, blue: 0.4), "深灰"),
        (Color(red: 0.7, green: 0.75, blue: 0.6), "橄榄淡"), (Color(red: 0.6, green: 0.75, blue: 0.9), "天蓝淡"),
        (Color(red: 0.85, green: 0.75, blue: 0.75), "玫瑰淡"), (Color(red: 0.8, green: 0.9, blue: 0.7), "苹果淡"),
        (Color(red: 0.85, green: 0.8, blue: 0.9), "薰衣草"), (Color(red: 0.75, green: 0.9, blue: 0.95), "青蓝淡"),
        (Color(red: 1.0, green: 0.85, blue: 0.75), "桃色"),
        // 第4行
        (Color(red: 0.75, green: 0.75, blue: 0.75), "中灰2"), (Color(red: 0.3, green: 0.3, blue: 0.3), "炭灰"),
        (Color(red: 0.5, green: 0.55, blue: 0.35), "橄榄"), (Color(red: 0.4, green: 0.55, blue: 0.75), "钢蓝"),
        (Color(red: 0.75, green: 0.55, blue: 0.55), "玫瑰"), (Color(red: 0.7, green: 0.85, blue: 0.55), "草绿"),
        (Color(red: 0.75, green: 0.7, blue: 0.85), "淡紫罗兰"), (Color(red: 0.55, green: 0.8, blue: 0.9), "天青"),
        (Color(red: 0.95, green: 0.7, blue: 0.55), "蜜瓜"),
        // 第5行
        (Color(red: 0.6, green: 0.6, blue: 0.6), "深灰2"), (Color(red: 0.15, green: 0.15, blue: 0.15), "近黑"),
        (Color(red: 0.35, green: 0.4, blue: 0.2), "深橄榄"), (Color(red: 0.2, green: 0.35, blue: 0.55), "深海蓝"),
        (Color(red: 0.65, green: 0.35, blue: 0.35), "深砖红"), (Color(red: 0.5, green: 0.65, blue: 0.3), "深黄绿"),
        (Color(red: 0.55, green: 0.4, blue: 0.7), "深紫"), (Color(red: 0.3, green: 0.6, blue: 0.7), "深青"),
        (Color(red: 0.8, green: 0.5, blue: 0.25), "深橙"),
    ]

    /// 标准色
    static let standardColors: [Color] = [
        Color(red: 0.8, green: 0.0, blue: 0.0),    // 深红
        Color(red: 1.0, green: 0.0, blue: 0.0),    // 红
        Color(red: 1.0, green: 0.5, blue: 0.0),    // 橙
        Color(red: 1.0, green: 1.0, blue: 0.0),    // 黄
        Color(red: 0.5, green: 1.0, blue: 0.0),    // 黄绿
        Color(red: 0.0, green: 0.8, blue: 0.0),    // 绿
        Color(red: 0.0, green: 1.0, blue: 1.0),    // 青
        Color(red: 0.0, green: 0.5, blue: 1.0),    // 蓝
        Color(red: 0.0, green: 0.0, blue: 0.5),    // 深蓝
        Color(red: 0.5, green: 0.0, blue: 1.0),    // 紫
    ]

    /// 编辑器字体颜色（默认跟随系统 textColor）
    var editorFontColor: NSColor {
        get {
            guard let colorData = defaults.data(forKey: Keys.editorFontColor),
                  let color = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSColor.self, from: colorData) else {
                return NSColor.textColor // 默认跟随系统
            }
            return color
        }
        set {
            if let colorData = try? NSKeyedArchiver.archivedData(withRootObject: newValue, requiringSecureCoding: false) {
                defaults.set(colorData, forKey: Keys.editorFontColor)
            }
        }
    }

    // MARK: - 标签过滤模式

    enum TagsFilterMode: String, CaseIterable {
        case currentFolder = "current"  // 只显示当前目录下的标签
        case allTags = "all"            // 显示所有标签

        var displayName: String {
            switch self {
            case .currentFolder: return "当前目录"
            case .allTags: return "所有标签"
            }
        }
    }

    var tagsFilterMode: TagsFilterMode {
        get {
            guard let rawValue = defaults.string(forKey: Keys.tagsFilterMode),
                  let mode = TagsFilterMode(rawValue: rawValue) else {
                return .currentFolder  // 默认只显示当前目录的标签
            }
            return mode
        }
        set {
            defaults.set(newValue.rawValue, forKey: Keys.tagsFilterMode)
        }
    }

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

    private init() {
        // 加载 iCloud 同步设置
        isiCloudSyncEnabled = defaults.bool(forKey: Keys.iCloudSyncEnabled)
        
        // 监听 iCloud 配置变化
        setupiCloudObserver()
        
        // 如果启用了 iCloud 同步，尝试从 iCloud 恢复设置
        if isiCloudSyncEnabled {
            restoreFromiCloud()
        }
    }
    
    // MARK: - iCloud 同步
    
    private func setupiCloudObserver() {
        NotificationCenter.default.publisher(for: .iCloudConfigDidChange)
            .sink { [weak self] _ in
                self?.restoreFromiCloud()
            }
            .store(in: &cancellables)
    }
    
    /// 同步设置到 iCloud
    func syncToiCloud() {
        guard isiCloudSyncEnabled else { return }
        
        let keyValueStore = NSUbiquitousKeyValueStore.default
        
        keyValueStore.set(isFoldersExpanded, forKey: iCloudKeys.foldersExpanded)
        keyValueStore.set(isTagsExpanded, forKey: iCloudKeys.tagsExpanded)
        keyValueStore.set(startupBehavior.rawValue, forKey: iCloudKeys.startupBehavior)
        
        if let colorData = defaults.data(forKey: Keys.accentColor) {
            keyValueStore.set(colorData, forKey: iCloudKeys.accentColor)
        }
        
        keyValueStore.synchronize()
        DebugLog.app("Synced to iCloud", level: .debug)
    }
    
    /// 从 iCloud 恢复设置
    func restoreFromiCloud() {
        guard isiCloudSyncEnabled else { return }
        
        let keyValueStore = NSUbiquitousKeyValueStore.default
        keyValueStore.synchronize()
        
        // 恢复侧边栏状态
        if keyValueStore.object(forKey: iCloudKeys.foldersExpanded) != nil {
            isFoldersExpanded = keyValueStore.bool(forKey: iCloudKeys.foldersExpanded)
        }
        
        if keyValueStore.object(forKey: iCloudKeys.tagsExpanded) != nil {
            isTagsExpanded = keyValueStore.bool(forKey: iCloudKeys.tagsExpanded)
        }
        
        // 恢复启动行为
        if let behaviorRaw = keyValueStore.string(forKey: iCloudKeys.startupBehavior),
           let behavior = StartupBehavior(rawValue: behaviorRaw) {
            startupBehavior = behavior
        }
        
        // 恢复主题色
        if let colorData = keyValueStore.data(forKey: iCloudKeys.accentColor) {
            defaults.set(colorData, forKey: Keys.accentColor)
        }
        
        DebugLog.app("Restored from iCloud", level: .debug)
    }
    
    /// 清除 iCloud 设置
    func cleariCloudSettings() {
        let keyValueStore = NSUbiquitousKeyValueStore.default
        
        keyValueStore.removeObject(forKey: iCloudKeys.foldersExpanded)
        keyValueStore.removeObject(forKey: iCloudKeys.tagsExpanded)
        keyValueStore.removeObject(forKey: iCloudKeys.startupBehavior)
        keyValueStore.removeObject(forKey: iCloudKeys.accentColor)
        
        keyValueStore.synchronize()
        DebugLog.app("Cleared iCloud settings", level: .debug)
    }
}
