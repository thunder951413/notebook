import Foundation
import SwiftUI
import AppKit
import Combine

/// 快捷键动作类型
enum ShortcutAction: String, CaseIterable, Identifiable {
    case newNote = "new_note"
    case saveNote = "save_note"
    case deleteNote = "delete_note"
    case toggleBold = "toggle_bold"
    case toggleItalic = "toggle_italic"
    case toggleUnderline = "toggle_underline"
    case toggleStrikethrough = "toggle_strikethrough"
    case toggleCheckbox = "toggle_checkbox"
    case increaseIndent = "increase_indent"
    case decreaseIndent = "decrease_indent"
    case toggleBulletList = "toggle_bullet_list"
    case toggleNumberedList = "toggle_numbered_list"
    case toggleAIAssistant = "toggle_ai_assistant"
    case insertConversation = "insert_conversation"
    case toggleMarkdownPreview = "toggle_markdown_preview"
    case toggleTableOfContents = "toggle_table_of_contents"
    case focusSearch = "focus_search"
    case focusEditor = "focus_editor"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .newNote: return l10n(L10nKeys.Shortcut.newNote)
        case .saveNote: return l10n(L10nKeys.Shortcut.saveNote)
        case .deleteNote: return l10n(L10nKeys.Shortcut.deleteNote)
        case .toggleBold: return l10n(L10nKeys.Shortcut.toggleBold)
        case .toggleItalic: return l10n(L10nKeys.Shortcut.toggleItalic)
        case .toggleUnderline: return l10n(L10nKeys.Shortcut.toggleUnderline)
        case .toggleStrikethrough: return l10n(L10nKeys.Shortcut.toggleStrikethrough)
        case .toggleCheckbox: return l10n(L10nKeys.Shortcut.toggleCheckbox)
        case .increaseIndent: return l10n(L10nKeys.Shortcut.increaseIndent)
        case .decreaseIndent: return l10n(L10nKeys.Shortcut.decreaseIndent)
        case .toggleBulletList: return l10n(L10nKeys.Shortcut.toggleBulletList)
        case .toggleNumberedList: return l10n(L10nKeys.Shortcut.toggleNumberedList)
        case .toggleAIAssistant: return l10n(L10nKeys.Shortcut.toggleAIAssistant)
        case .insertConversation: return l10n(L10nKeys.Shortcut.insertConversation)
        case .toggleMarkdownPreview: return l10n(L10nKeys.Shortcut.toggleMarkdownPreview)
        case .toggleTableOfContents: return l10n(L10nKeys.Shortcut.toggleTableOfContents)
        case .focusSearch: return l10n(L10nKeys.Shortcut.focusSearch)
        case .focusEditor: return l10n(L10nKeys.Shortcut.focusEditor)
        }
    }

    var icon: String {
        switch self {
        case .newNote: return "doc.badge.plus"
        case .saveNote: return "arrow.down.doc"
        case .deleteNote: return "trash"
        case .toggleBold: return "bold"
        case .toggleItalic: return "italic"
        case .toggleUnderline: return "underline"
        case .toggleStrikethrough: return "strikethrough"
        case .toggleCheckbox: return "checkmark.square"
        case .increaseIndent: return "increase.indent"
        case .decreaseIndent: return "decrease.indent"
        case .toggleBulletList: return "list.bullet"
        case .toggleNumberedList: return "list.number"
        case .toggleAIAssistant: return "brain"
        case .insertConversation: return "text.bubble"
        case .toggleMarkdownPreview: return "eye"
        case .toggleTableOfContents: return "list.bullet.rectangle"
        case .focusSearch: return "magnifyingglass"
        case .focusEditor: return "doc.text"
        }
    }

    var defaultShortcut: KeyboardShortcut? {
        switch self {
        case .newNote: return KeyboardShortcut(key: .n, modifiers: [.command])
        case .saveNote: return KeyboardShortcut(key: .s, modifiers: [.command])
        case .deleteNote: return KeyboardShortcut(key: .delete, modifiers: [.command])
        case .toggleBold: return KeyboardShortcut(key: .b, modifiers: [.command])
        case .toggleItalic: return KeyboardShortcut(key: .i, modifiers: [.command])
        case .toggleUnderline: return KeyboardShortcut(key: .u, modifiers: [.command])
        case .toggleStrikethrough: return nil
        case .toggleCheckbox: return nil
        case .increaseIndent: return KeyboardShortcut(key: .tab, modifiers: [])
        case .decreaseIndent: return KeyboardShortcut(key: .tab, modifiers: [.shift])
        case .toggleBulletList: return nil
        case .toggleNumberedList: return nil
        case .toggleAIAssistant: return KeyboardShortcut(key: .a, modifiers: [.command, .shift])
        case .insertConversation: return nil
        case .toggleMarkdownPreview: return KeyboardShortcut(key: .m, modifiers: [.command, .shift])
        case .toggleTableOfContents: return KeyboardShortcut(key: .t, modifiers: [.command, .shift])
        case .focusSearch: return KeyboardShortcut(key: .f, modifiers: [.command, .shift])
        case .focusEditor: return KeyboardShortcut(key: .e, modifiers: [.command, .shift])
        }
    }
}

/// 键盘快捷键数据模型
struct KeyboardShortcut: Codable, Equatable {
    var key: KeyEquivalent
    var modifiers: ModifierFlags
    
    init(key: KeyEquivalent, modifiers: ModifierFlags) {
        self.key = key
        self.modifiers = modifiers
    }
    
    var displayString: String {
        var parts: [String] = []
        
        if modifiers.contains(.command) { parts.append("⌘") }
        if modifiers.contains(.option) { parts.append("⌥") }
        if modifiers.contains(.control) { parts.append("⌃") }
        if modifiers.contains(.shift) { parts.append("⇧") }
        
        parts.append(key.displayName)
        
        return parts.joined(separator: "")
    }
}

/// 按键等价物
enum KeyEquivalent: String, Codable, CaseIterable {
    case a = "a", b = "b", c = "c", d = "d", e = "e", f = "f", g = "g", h = "h"
    case i = "i", j = "j", k = "k", l = "l", m = "m", n = "n", o = "o", p = "p"
    case q = "q", r = "r", s = "s", t = "t", u = "u", v = "v", w = "w", x = "x"
    case y = "y", z = "z"
    case zero = "0", one = "1", two = "2", three = "3", four = "4"
    case five = "5", six = "6", seven = "7", eight = "8", nine = "9"
    case space = "space"
    case tab = "tab"
    case returnKey = "return"
    case escape = "escape"
    case delete = "delete"
    case up = "up", down = "down", left = "left", right = "right"
    case f1 = "f1", f2 = "f2", f3 = "f3", f4 = "f4", f5 = "f5"
    case f6 = "f6", f7 = "f7", f8 = "f8", f9 = "f9", f10 = "f10"
    case f11 = "f11", f12 = "f12"
    
    var displayName: String {
        switch self {
        case .space: return "Space"
        case .tab: return "Tab"
        case .returnKey: return "↵"
        case .escape: return "Esc"
        case .delete: return "⌫"
        case .up: return "↑"
        case .down: return "↓"
        case .left: return "←"
        case .right: return "→"
        default: return rawValue.uppercased()
        }
    }
}

/// 修饰键标志
struct ModifierFlags: OptionSet, Codable {
    let rawValue: Int
    
    static let command = ModifierFlags(rawValue: 1 << 0)
    static let option = ModifierFlags(rawValue: 1 << 1)
    static let control = ModifierFlags(rawValue: 1 << 2)
    static let shift = ModifierFlags(rawValue: 1 << 3)
    
    init(rawValue: Int) {
        self.rawValue = rawValue
    }
}

/// 快捷键设置管理器
@MainActor
final class KeyboardShortcutManager: ObservableObject {
    static let shared = KeyboardShortcutManager()
    
    @Published var shortcuts: [ShortcutAction: KeyboardShortcut] = [:]
    
    private let defaultsKey = "keyboard_shortcuts"
    
    private init() {
        loadShortcuts()
    }
    
    /// 加载保存的快捷键
    private func loadShortcuts() {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let saved = try? JSONDecoder().decode([String: KeyboardShortcut].self, from: data) else {
            // 使用默认快捷键
            shortcuts = Dictionary(uniqueKeysWithValues: ShortcutAction.allCases.compactMap { action in
                guard let shortcut = action.defaultShortcut else { return nil }
                return (action, shortcut)
            })
            return
        }
        
        shortcuts = Dictionary(uniqueKeysWithValues: saved.compactMap { key, value in
            guard let action = ShortcutAction(rawValue: key) else { return nil }
            return (action, value)
        })
    }
    
    /// 保存快捷键
    private func saveShortcuts() {
        let data = Dictionary(uniqueKeysWithValues: shortcuts.map { ($0.key.rawValue, $0.value) })
        if let encoded = try? JSONEncoder().encode(data) {
            UserDefaults.standard.set(encoded, forKey: defaultsKey)
        }
    }
    
    /// 设置快捷键
    func setShortcut(_ shortcut: KeyboardShortcut?, for action: ShortcutAction) {
        if let shortcut = shortcut {
            shortcuts[action] = shortcut
        } else {
            shortcuts.removeValue(forKey: action)
        }
        saveShortcuts()
    }
    
    /// 重置为默认快捷键
    func resetToDefaults() {
        shortcuts = Dictionary(uniqueKeysWithValues: ShortcutAction.allCases.compactMap { action in
            guard let shortcut = action.defaultShortcut else { return nil }
            return (action, shortcut)
        })
        saveShortcuts()
    }
    
    /// 获取快捷键
    func shortcut(for action: ShortcutAction) -> KeyboardShortcut? {
        return shortcuts[action]
    }
    
    /// 检查快捷键是否已被使用
    func isShortcutUsed(_ shortcut: KeyboardShortcut, excluding action: ShortcutAction? = nil) -> Bool {
        for (existingAction, existingShortcut) in shortcuts {
            if existingAction != action && existingShortcut == shortcut {
                return true
            }
        }
        return false
    }
}

// MARK: - 本地化键值
extension L10nKeys {
    enum Shortcut {
        static let newNote = "shortcut_new_note"
        static let saveNote = "shortcut_save_note"
        static let deleteNote = "shortcut_delete_note"
        static let toggleBold = "shortcut_toggle_bold"
        static let toggleItalic = "shortcut_toggle_italic"
        static let toggleUnderline = "shortcut_toggle_underline"
        static let toggleStrikethrough = "shortcut_toggle_strikethrough"
        static let toggleCheckbox = "shortcut_toggle_checkbox"
        static let increaseIndent = "shortcut_increase_indent"
        static let decreaseIndent = "shortcut_decrease_indent"
        static let toggleBulletList = "shortcut_toggle_bullet_list"
        static let toggleNumberedList = "shortcut_toggle_numbered_list"
        static let toggleAIAssistant = "shortcut_toggle_ai_assistant"
        static let insertConversation = "shortcut_insert_conversation"
        static let toggleMarkdownPreview = "shortcut_toggle_markdown_preview"
        static let toggleTableOfContents = "shortcut_toggle_table_of_contents"
        static let focusSearch = "shortcut_focus_search"
        static let focusEditor = "shortcut_focus_editor"
        
        static let title = "shortcut_settings_title"
        static let description = "shortcut_settings_description"
        static let resetDefaults = "shortcut_reset_defaults"
        static let pressShortcut = "shortcut_press_shortcut"
        static let conflictWarning = "shortcut_conflict_warning"
    }
}
