import SwiftUI

/// 快捷键设置视图
struct KeyboardShortcutSettingsView: View {
    @StateObject private var shortcutManager = KeyboardShortcutManager.shared
    @State private var editingAction: ShortcutAction?
    @State private var showConflictAlert = false
    @State private var conflictAction: ShortcutAction?
    @State private var tempShortcut: KeyboardShortcut?
    
    // 按类别分组的动作
    private let actionGroups: [(title: String, actions: [ShortcutAction])] = [
        ("文件操作", [.newNote, .saveNote, .deleteNote]),
        ("格式设置", [.toggleBold, .toggleItalic, .toggleUnderline, .toggleStrikethrough]),
        ("列表与缩进", [.toggleCheckbox, .increaseIndent, .decreaseIndent, .toggleBulletList, .toggleNumberedList]),
        ("AI 功能", [.toggleAIAssistant, .insertConversation]),
        ("视图与导航", [.toggleMarkdownPreview, .focusSearch, .focusEditor])
    ]
    
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // 标题和说明
                VStack(alignment: .leading, spacing: 8) {
                    Text(l10n(L10nKeys.Shortcut.title))
                        .font(.title2)
                        .bold()
                    
                    Text(l10n(L10nKeys.Shortcut.description))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                
                // 重置按钮
                Button(l10n(L10nKeys.Shortcut.resetDefaults)) {
                    shortcutManager.resetToDefaults()
                }
                .padding(.bottom, 8)
                
                // 快捷键列表
                ForEach(actionGroups, id: \.title) { group in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(group.title)
                            .font(.headline)
                            .foregroundColor(.secondary)
                        
                        VStack(spacing: 0) {
                            ForEach(group.actions) { action in
                                ShortcutRow(
                                    action: action,
                                    shortcut: shortcutManager.shortcut(for: action),
                                    isEditing: editingAction == action,
                                    onTap: { startEditing(action) },
                                    onClear: { shortcutManager.setShortcut(nil, for: action) }
                                )
                                
                                if action != group.actions.last {
                                    Divider()
                                        .padding(.leading, 16)
                                }
                            }
                        }
                        .background(Color(NSColor.controlBackgroundColor))
                        .cornerRadius(8)
                    }
                }
            }
            .padding(20)
        }
        .frame(minWidth: 500, minHeight: 400)
        .alert("快捷键冲突", isPresented: $showConflictAlert) {
            Button("替换", role: .destructive) {
                if let action = conflictAction, let shortcut = tempShortcut {
                    shortcutManager.setShortcut(nil, for: action)
                    shortcutManager.setShortcut(shortcut, for: editingAction!)
                }
                editingAction = nil
                tempShortcut = nil
            }
            Button("取消", role: .cancel) {
                editingAction = nil
                tempShortcut = nil
            }
        } message: {
            if let action = conflictAction {
                Text("该快捷键已被「\(action.displayName)」使用。是否替换？")
            }
        }
        .onAppear {
            setupKeyboardMonitor()
        }
        .onDisappear {
            removeKeyboardMonitor()
        }
    }
    
    private func startEditing(_ action: ShortcutAction) {
        editingAction = action
    }
    
    private func setupKeyboardMonitor() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard editingAction != nil else { return event }
            
            // 忽略单独的修饰键
            let modifierFlags = event.modifierFlags
            let hasModifier = modifierFlags.contains(.command) ||
                             modifierFlags.contains(.option) ||
                             modifierFlags.contains(.control) ||
                             modifierFlags.contains(.shift)
            
            // 获取按键
            guard let key = keyEquivalent(from: event) else { return event }
            
            // 构建修饰键
            var modifiers = ModifierFlags()
            if modifierFlags.contains(.command) { modifiers.insert(.command) }
            if modifierFlags.contains(.option) { modifiers.insert(.option) }
            if modifierFlags.contains(.control) { modifiers.insert(.control) }
            if modifierFlags.contains(.shift) { modifiers.insert(.shift) }
            
            // 如果没有修饰键且不是特殊键，忽略
            if !hasModifier && !isSpecialKey(key) {
                return event
            }
            
            let shortcut = KeyboardShortcut(key: key, modifiers: modifiers)
            
            // 检查冲突
            if let conflict = shortcutManager.shortcuts.first(where: { $0.value == shortcut && $0.key != editingAction })?.key {
                conflictAction = conflict
                tempShortcut = shortcut
                showConflictAlert = true
            } else {
                // 保存快捷键
                if let action = editingAction {
                    shortcutManager.setShortcut(shortcut, for: action)
                }
                editingAction = nil
            }
            
            return nil
        }
    }
    
    private func removeKeyboardMonitor() {
        // 监控器会在视图消失时自动清理
    }
    
    private func keyEquivalent(from event: NSEvent) -> KeyEquivalent? {
        let keyCode = event.keyCode
        
        // 功能键
        switch keyCode {
        case 53: return .escape
        case 36: return .returnKey
        case 48: return .tab
        case 51: return .delete
        case 49: return .space
        case 126: return .up
        case 125: return .down
        case 123: return .left
        case 124: return .right
        case 122: return .f1
        case 120: return .f2
        case 99: return .f3
        case 118: return .f4
        case 96: return .f5
        case 97: return .f6
        case 98: return .f7
        case 100: return .f8
        case 101: return .f9
        case 109: return .f10
        case 103: return .f11
        case 111: return .f12
        default: break
        }
        
        // 字母和数字键
        guard let chars = event.charactersIgnoringModifiers?.lowercased(),
              let char = chars.first else { return nil }
        
        switch char {
        case "a": return .a
        case "b": return .b
        case "c": return .c
        case "d": return .d
        case "e": return .e
        case "f": return .f
        case "g": return .g
        case "h": return .h
        case "i": return .i
        case "j": return .j
        case "k": return .k
        case "l": return .l
        case "m": return .m
        case "n": return .n
        case "o": return .o
        case "p": return .p
        case "q": return .q
        case "r": return .r
        case "s": return .s
        case "t": return .t
        case "u": return .u
        case "v": return .v
        case "w": return .w
        case "x": return .x
        case "y": return .y
        case "z": return .z
        case "0": return .zero
        case "1": return .one
        case "2": return .two
        case "3": return .three
        case "4": return .four
        case "5": return .five
        case "6": return .six
        case "7": return .seven
        case "8": return .eight
        case "9": return .nine
        default: return nil
        }
    }
    
    private func isSpecialKey(_ key: KeyEquivalent) -> Bool {
        switch key {
        case .escape, .returnKey, .tab, .delete, .up, .down, .left, .right:
            return true
        default:
            return false
        }
    }
}

/// 单个快捷键行
struct ShortcutRow: View {
    let action: ShortcutAction
    let shortcut: KeyboardShortcut?
    let isEditing: Bool
    let onTap: () -> Void
    let onClear: () -> Void
    
    var body: some View {
        HStack {
            Text(action.displayName)
                .frame(maxWidth: .infinity, alignment: .leading)
            
            Spacer()
            
            if isEditing {
                Text("按下快捷键...")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.accentColor)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.1))
                    .cornerRadius(4)
            } else if let shortcut = shortcut {
                HStack(spacing: 8) {
                    Text(shortcut.displayString)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(NSColor.secondarySystemFill))
                        .cornerRadius(4)
                    
                    Button(action: onClear) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Text("未设置")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(isEditing ? Color.accentColor.opacity(0.05) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture {
            onTap()
        }
    }
}
