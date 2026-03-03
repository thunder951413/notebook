import SwiftUI
import Combine

/// 环形菜单覆盖层 - 检测鼠标中键并显示菜单
struct RadialMenuOverlayView: View {
    @StateObject private var manager = RadialMenuManager.shared
    @StateObject private var settings = RadialMenuSettings.shared
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // 透明层用于捕获鼠标事件
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { } // 阻止事件穿透
                
                // 环形菜单
                if manager.isShowing {
                    RadialMenuContent()
                        .transition(.scale.combined(with: .opacity))
                }
            }
        }
        .ignoresSafeArea()
    }
}

/// 环形菜单内容
struct RadialMenuContent: View {
    @StateObject private var manager = RadialMenuManager.shared
    @StateObject private var settings = RadialMenuSettings.shared
    @State private var hoveredItem: RadialMenuItem?
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        GeometryReader { geometry in
            let center = manager.menuLocation
            
            ZStack {
                // 背景遮罩
                Color.black.opacity(0.1)
                    .ignoresSafeArea()
                    .onTapGesture {
                        manager.hide()
                    }
                
                // 中心圆
                Circle()
                    .fill(themeManager.accentColor.opacity(0.2))
                    .frame(width: 40, height: 40)
                    .position(center)
                
                // 连接线
                Canvas { context, size in
                    for item in settings.menuItems {
                        guard let position = RadialMenuPosition(rawValue: item.position) else { continue }
                        
                        let itemPoint = position.point(in: settings.menuRadius, center: center)
                        
                        var path = Path()
                        path.move(to: center)
                        path.addLine(to: itemPoint)
                        
                        context.stroke(
                            path,
                            with: .color(themeManager.accentColor.opacity(0.3)),
                            lineWidth: 1
                        )
                    }
                }
                .allowsHitTesting(false)
                
                // 菜单项
                ForEach(settings.menuItems) { item in
                    if let position = RadialMenuPosition(rawValue: item.position) {
                        let point = position.point(in: settings.menuRadius, center: center)
                        let isHovered = hoveredItem?.id == item.id
                        
                        RadialMenuButton(
                            item: item,
                            isHovered: isHovered,
                            size: settings.itemSize
                        )
                        .position(point)
                        .onHover { hovering in
                            withAnimation(.easeInOut(duration: 0.15)) {
                                hoveredItem = hovering ? item : nil
                            }
                        }
                        .onTapGesture {
                            executeAction(item.action)
                        }
                    }
                }
            }
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
        
        manager.hide()
    }
}

/// 环形菜单按钮
struct RadialMenuButton: View {
    let item: RadialMenuItem
    let isHovered: Bool
    let size: CGFloat
    
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        ZStack {
            // 背景圆形
            Circle()
                .fill(isHovered ? themeManager.accentColor : Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.2), radius: isHovered ? 6 : 3, x: 0, y: 2)
            
            // 图标
            Image(systemName: item.action.icon)
                .font(.system(size: size * 0.4, weight: .medium))
                .foregroundStyle(isHovered ? .white : .primary)
        }
        .frame(width: size, height: size)
        .scaleEffect(isHovered ? 1.15 : 1.0)
        .animation(.easeInOut(duration: 0.15), value: isHovered)
        .help(item.action.displayName)
    }
}
