import Foundation
import SwiftUI
import AppKit
import Combine

/// 快捷键动作处理器
@MainActor
final class ShortcutActionHandler: ObservableObject {
    static let shared = ShortcutActionHandler()
    
    private var cancellables = Set<AnyCancellable>()
    private var eventMonitor: Any?
    
    // 发布者，用于通知视图执行动作
    let newNotePublisher = PassthroughSubject<Void, Never>()
    let saveNotePublisher = PassthroughSubject<Void, Never>()
    let deleteNotePublisher = PassthroughSubject<Void, Never>()
    let toggleBoldPublisher = PassthroughSubject<Void, Never>()
    let toggleItalicPublisher = PassthroughSubject<Void, Never>()
    let toggleUnderlinePublisher = PassthroughSubject<Void, Never>()
    let toggleStrikethroughPublisher = PassthroughSubject<Void, Never>()
    let clearFormattingPublisher = PassthroughSubject<Void, Never>()
    let toggleCheckboxPublisher = PassthroughSubject<Void, Never>()
    let increaseIndentPublisher = PassthroughSubject<Void, Never>()
    let decreaseIndentPublisher = PassthroughSubject<Void, Never>()
    let toggleBulletListPublisher = PassthroughSubject<Void, Never>()
    let toggleNumberedListPublisher = PassthroughSubject<Void, Never>()
    let toggleAIAssistantPublisher = PassthroughSubject<Void, Never>()
    let insertConversationPublisher = PassthroughSubject<Void, Never>()
    let toggleMarkdownPreviewPublisher = PassthroughSubject<Void, Never>()
    let toggleTableOfContentsPublisher = PassthroughSubject<Void, Never>()
    let focusSearchPublisher = PassthroughSubject<Void, Never>()
    let focusCurrentNoteSearchPublisher = PassthroughSubject<Void, Never>()
    let focusEditorPublisher = PassthroughSubject<Void, Never>()
    
    private init() {
        setupKeyboardMonitor()
    }
    
    /// 设置键盘监听
    private func setupKeyboardMonitor() {
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            
            // 检查是否匹配任何已配置的快捷键
            let shortcutManager = KeyboardShortcutManager.shared
            
            for (action, shortcut) in shortcutManager.shortcuts {
                if self.matchesShortcut(event, shortcut: shortcut) {
                    self.handleAction(action)
                    return nil // 消费掉事件
                }
            }
            
            return event
        }
    }
    
    /// 检查事件是否匹配快捷键
    private func matchesShortcut(_ event: NSEvent, shortcut: KeyboardShortcut) -> Bool {
        let modifierFlags = event.modifierFlags
        
        // 检查修饰键
        let hasCommand = modifierFlags.contains(.command)
        let hasOption = modifierFlags.contains(.option)
        let hasControl = modifierFlags.contains(.control)
        let hasShift = modifierFlags.contains(.shift)
        
        let shortcutModifiers = shortcut.modifiers
        let needsCommand = shortcutModifiers.contains(.command)
        let needsOption = shortcutModifiers.contains(.option)
        let needsControl = shortcutModifiers.contains(.control)
        let needsShift = shortcutModifiers.contains(.shift)
        
        guard hasCommand == needsCommand,
              hasOption == needsOption,
              hasControl == needsControl,
              hasShift == needsShift else {
            return false
        }
        
        // 检查按键
        return keyEquivalent(from: event) == shortcut.key
    }
    
    /// 从 NSEvent 获取 KeyEquivalent
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
    
    /// 处理快捷键动作
    private func handleAction(_ action: ShortcutAction) {
        switch action {
        case .newNote:
            newNotePublisher.send()
        case .saveNote:
            saveNotePublisher.send()
        case .deleteNote:
            deleteNotePublisher.send()
        case .toggleBold:
            toggleBoldPublisher.send()
        case .toggleItalic:
            toggleItalicPublisher.send()
        case .toggleUnderline:
            toggleUnderlinePublisher.send()
        case .toggleStrikethrough:
            toggleStrikethroughPublisher.send()
        case .clearFormatting:
            clearFormattingPublisher.send()
        case .toggleCheckbox:
            toggleCheckboxPublisher.send()
        case .increaseIndent:
            increaseIndentPublisher.send()
        case .decreaseIndent:
            decreaseIndentPublisher.send()
        case .toggleBulletList:
            toggleBulletListPublisher.send()
        case .toggleNumberedList:
            toggleNumberedListPublisher.send()
        case .toggleAIAssistant:
            toggleAIAssistantPublisher.send()
        case .insertConversation:
            insertConversationPublisher.send()
        case .toggleMarkdownPreview:
            toggleMarkdownPreviewPublisher.send()
        case .toggleTableOfContents:
            toggleTableOfContentsPublisher.send()
        case .focusSearch:
            focusSearchPublisher.send()
        case .focusCurrentNoteSearch:
            focusCurrentNoteSearchPublisher.send()
        case .focusEditor:
            focusEditorPublisher.send()
        }
    }
    
    deinit {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }
}
