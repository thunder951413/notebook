import SwiftUI
import Combine

/// 环形菜单管理器 - 处理显示/隐藏和事件
final class RadialMenuManager: ObservableObject {
    static let shared = RadialMenuManager()
    
    @Published var isShowing = false
    @Published var menuLocation: CGPoint = .zero
    
    private var cancellables = Set<AnyCancellable>()
    
    private init() {
        // 监听菜单选择事件
        NotificationCenter.default.publisher(for: .radialMenuItemSelected)
            .sink { [weak self] notification in
                if let action = notification.object as? ShortcutAction {
                    self?.executeAction(action)
                }
            }
            .store(in: &cancellables)
    }
    
    func show(at location: CGPoint) {
        guard RadialMenuSettings.shared.isEnabled else { return }
        menuLocation = location
        isShowing = true
    }
    
    func hide() {
        isShowing = false
    }
    
    func toggle(at location: CGPoint) {
        if isShowing {
            hide()
        } else {
            show(at: location)
        }
    }
    
    private func executeAction(_ action: ShortcutAction) {
        // 发送对应的快捷键事件
        switch action {
        case .newNote:
            ShortcutActionHandler.shared.newNotePublisher.send()
        case .saveNote:
            ShortcutActionHandler.shared.saveNotePublisher.send()
        case .deleteNote:
            ShortcutActionHandler.shared.deleteNotePublisher.send()
        case .toggleBold:
            ShortcutActionHandler.shared.toggleBoldPublisher.send()
        case .toggleItalic:
            ShortcutActionHandler.shared.toggleItalicPublisher.send()
        case .toggleUnderline:
            ShortcutActionHandler.shared.toggleUnderlinePublisher.send()
        case .toggleStrikethrough:
            ShortcutActionHandler.shared.toggleStrikethroughPublisher.send()
        case .toggleCheckbox:
            ShortcutActionHandler.shared.toggleCheckboxPublisher.send()
        case .increaseIndent:
            ShortcutActionHandler.shared.increaseIndentPublisher.send()
        case .decreaseIndent:
            ShortcutActionHandler.shared.decreaseIndentPublisher.send()
        case .toggleBulletList:
            ShortcutActionHandler.shared.toggleBulletListPublisher.send()
        case .toggleNumberedList:
            ShortcutActionHandler.shared.toggleNumberedListPublisher.send()
        case .toggleAIAssistant:
            ShortcutActionHandler.shared.toggleAIAssistantPublisher.send()
        case .insertConversation:
            ShortcutActionHandler.shared.insertConversationPublisher.send()
        case .toggleMarkdownPreview:
            ShortcutActionHandler.shared.toggleMarkdownPreviewPublisher.send()
        case .toggleTableOfContents:
            ShortcutActionHandler.shared.toggleTableOfContentsPublisher.send()
        case .focusSearch:
            ShortcutActionHandler.shared.focusSearchPublisher.send()
        case .focusEditor:
            ShortcutActionHandler.shared.focusEditorPublisher.send()
        }
        
        hide()
    }
}

extension Notification.Name {
    static let radialMenuItemSelected = Notification.Name("radialMenuItemSelected")
}
