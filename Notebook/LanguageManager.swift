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
            return l10n(L10nKeys.Language.systemDefault)
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
        let savedValue = NotebookDefaults.shared.string(forKey: languageKey) ?? "system"
        self._currentLanguage = Published(wrappedValue: AppLanguage(rawValue: savedValue) ?? .system)

        // 监听语言变化
        $currentLanguage
            .dropFirst()
            .sink { [weak self] newLanguage in
                NotebookDefaults.shared.set(newLanguage.rawValue, forKey: self?.languageKey ?? "app_language")
                self?.applyLanguage()
            }
            .store(in: &cancellables)
    }

    /// 应用当前语言设置
    func applyLanguage() {
        guard let identifier = currentLanguage.localeIdentifier else {
            // 系统默认，重置为系统语言
            NotebookDefaults.shared.removeObject(forKey: "AppleLanguages")
            return
        }

        NotebookDefaults.shared.set([identifier], forKey: "AppleLanguages")
        NotebookDefaults.shared.synchronize()
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
    static let appName = "app.name"
    static let ok = "common.ok"
    static let cancel = "common.cancel"
    static let save = "common.save"
    static let delete = "common.delete"
    static let edit = "common.edit"
    static let done = "common.done"
    static let close = "common.close"
    static let create = "common.create"
    static let confirm = "common.confirm"
    static let noTitle = "common.noTitle"
    static let select = "common.select"
    static let search = "common.search"
    static let rename = "common.rename"
    static let add = "common.add"
    static let remove = "common.remove"
    static let clear = "common.clear"
    static let refresh = "common.refresh"
    static let notes = "common.notes"
    static let note = "common.note"

    // MARK: - 通用（嵌套结构体，用于兼容现有代码）
    struct common {
        static let ok = "common.ok"
        static let cancel = "common.cancel"
        static let save = "common.save"
        static let delete = "common.delete"
        static let edit = "common.edit"
        static let done = "common.done"
        static let close = "common.close"
        static let create = "common.create"
        static let confirm = "common.confirm"
        static let noTitle = "common.noTitle"
        static let select = "common.select"
        static let search = "common.search"
        static let rename = "common.rename"
        static let add = "common.add"
        static let remove = "common.remove"
        static let clear = "common.clear"
        static let refresh = "common.refresh"
        static let notes = "common.notes"
        static let note = "common.note"
    }

    // MARK: - 语言设置
    struct Language {
        static let title = "language.title"
        static let system = "language.system"
        static let systemDefault = "language.systemDefault"
        static let restartRequired = "language.restartRequired"
    }

    // MARK: - 笔记
    struct Note {
        static let new = "note.new"
        static let untitled = "note.untitled"
        static let searchPlaceholder = "note.search.placeholder"
        static let deleteConfirm = "note.delete.confirm"
        static let noSelection = "note.noSelection"
        static let title = "note.title"
        static let titlePlaceholder = "note.title.placeholder"
        static let reminder = "note.reminder"
        static let reminderTitle = "note.reminder.title"
        static let setReminder = "note.reminder.set"
        static let clearReminder = "note.reminder.clear"
        static let recurrence = "note.recurrence"
        static let noRecurrence = "note.recurrence.none"
        static let daily = "note.recurrence.daily"
        static let weekly = "note.recurrence.weekly"
        static let monthly = "note.recurrence.monthly"
    }

    struct Todo {
        static let title = "todo.title"
        static let today = "todo.today"
        static let important = "todo.important"
        static let untitled = "todo.untitled"
        static let titlePlaceholder = "todo.title.placeholder"
        static let steps = "todo.steps"
        static let newStep = "todo.step.new"
        static let notes = "todo.notes"
        static let dueDate = "todo.dueDate"
        static let due = "todo.due"
        static let reminder = "todo.reminder"
        static let reminderAt = "todo.reminderAt"
        static let recurrence = "todo.recurrence"
        static let list = "todo.list"
        static let noList = "todo.list.none"
        static let linkedNotes = "todo.linkedNotes"
        static let noLinkedNotes = "todo.linkedNotes.none"
        static let select = "todo.select"
        static let reminderTitle = "todo.reminder.title"
        static let deletedNote = "todo.linkedNote.deleted"
        static let listManagement = "todo.list.management"
        static let newList = "todo.list.new"
        static let newListTitle = "todo.list.new.title"
        static let listName = "todo.list.name"
        static let listNamePrompt = "todo.list.name.prompt"
        static let manageLists = "todo.list.manage"
    }

    // MARK: - 文件夹
    struct Folder {
        static let allNotes = "folder.all"
        static let uncategorized = "folder.uncategorized"
        static let new = "folder.new"
        static let title = "folder.title"
        static let management = "folder.management"
        static let namePlaceholder = "folder.name.placeholder"
        static let system = "folder.system"
        static let dragToSort = "folder.dragToSort"
    }

    // MARK: - 标签
    struct Tag {
        static let title = "tag.title"
        static let management = "tag.management"
        static let new = "tag.new"
        static let namePlaceholder = "tag.name.placeholder"
        static let selectColor = "tag.selectColor"
        static let added = "tag.added"
        static let addTag = "tag.add"
        static let noAvailable = "tag.noAvailable"
        static let rename = "tag.rename"
        static let changeColor = "tag.changeColor"
        static let dragToSort = "tag.dragToSort"
        static let noteCount = "tag.noteCount"
    }

    // MARK: - 设置
    struct Settings {
        static let title = "settings.title"
        static let windowTitle = "settings.windowTitle"
        static let storageLocation = "settings.storage.location"
        static let storageCurrentPath = "settings.storage.current"
        static let storageNotConfigured = "settings.storage.notConfigured"
        static let storageChange = "settings.storage.change"
        static let storageSelect = "settings.storage.select"
        static let storageShowInFinder = "settings.storage.showInFinder"
        static let startupBehavior = "settings.startup.behavior"
        static let startupTitle = "settings.startup.title"
        static let startupDescription = "settings.startup.description"
        static let themeColor = "settings.theme.color"
        static let themeDescription = "settings.theme.description"
        static let iCloudSync = "settings.icloud.sync"
        static let iCloudLastSync = "settings.icloud.lastSync"
        static let iCloudNotSynced = "settings.icloud.notSynced"
        static let iCloudUnavailable = "settings.icloud.unavailable"
        static let iCloudSyncNow = "settings.icloud.syncNow"
        static let restartAlertTitle = "settings.restartAlert.title"
        static let restartAlertMessage = "settings.restartAlert.message"
        static let clearBackupsConfirm = "settings.clearBackups.confirm"
        static let clearBackupsTitle = "settings.clearBackups.title"
        static let clearBackupsMessage = "settings.clearBackups.message"
    }

    // MARK: - 备份
    struct Backup {
        static let title = "backup.title"
        static let description = "backup.description"
        static let restore = "backup.restore"
        static let clear = "backup.clear"
        static let windowTitle = "backup.windowTitle"
        static let close = "backup.close"
        static let noBackups = "backup.noBackups"
        static let autoCreated = "backup.autoCreated"
        static let refresh = "backup.refresh"
        static let restoreSelected = "backup.restoreSelected"
        static let confirmRestore = "backup.confirmRestore"
        static let confirmRestoreMessage = "backup.confirmRestore.message"
        static let restoreSuccess = "backup.restoreSuccess"
        static let restoreSuccessMessage = "backup.restoreSuccess.message"
    }

    // MARK: - 编辑器
    struct Editor {
        static let bold = "editor.bold"
        static let italic = "editor.italic"
        static let underline = "editor.underline"
        static let strikethrough = "editor.strikethrough"
        static let heading = "editor.heading"
        static let heading1 = "editor.heading1"
        static let heading2 = "editor.heading2"
        static let heading3 = "editor.heading3"
        static let bulletList = "editor.bulletList"
        static let dashList = "editor.dashList"
        static let numberedList = "editor.numberedList"
        static let checkbox = "editor.checkbox"
        static let increaseIndent = "editor.increaseIndent"
        static let decreaseIndent = "editor.decreaseIndent"
        static let insertImage = "editor.insertImage"
        static let insertAudio = "editor.insertAudio"
        static let search = "editor.search"
        static let clearFormatting = "editor.clearFormatting"
    }

    // MARK: - 启动行为
    struct Startup {
        static let restoreLastNote = "startup.restoreLastNote"
        static let selectNone = "startup.selectNone"
        static let showAllNotes = "startup.showAllNotes"
    }

    // MARK: - 重启
    struct Restart {
        static let restartNow = "restart.restartNow"
        static let later = "restart.later"
    }

    // MARK: - Popover
    struct Popover {
        static let searchNotes = "popover.searchNotes"
        static let openMainWindow = "popover.openMainWindow"
        static let recentNotes = "popover.recentNotes"
        static let searchResults = "popover.searchResults"
        static let noResults = "popover.noResults"
        static let quit = "popover.quit"
    }

    // MARK: - 关于
    struct About {
        static let title = "about.title"
        static let appName = "about.appName"
        static let author = "about.author"
        static let email = "about.email"
        static let projectHelp = "about.projectHelp"
        static let viewOnGitHub = "about.viewOnGitHub"
    }

    // MARK: - Onboarding
    struct Onboarding {
        static let welcome = "onboarding.welcome"
        static let description = "onboarding.description"
        static let databasePath = "onboarding.databasePath"
        static let attachmentsPath = "onboarding.attachmentsPath"
        static let selectDirectory = "onboarding.selectDirectory"
        static let selecting = "onboarding.selecting"
        static let tip = "onboarding.tip"
    }

    // MARK: - 错误/提示
    struct Error {
        static let storageNotConfigured = "error.storage.notConfigured"
        static let userCancelled = "error.userCancelled"
    }
}
