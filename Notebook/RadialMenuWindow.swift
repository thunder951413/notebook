import SwiftUI
import AppKit
import Combine

/// 环形菜单窗口控制器
final class RadialMenuWindowController: NSObject {
    static let shared = RadialMenuWindowController()
    
    private var window: NSWindow?
    private var eventMonitor: Any?
    
    private override init() {
        super.init()
    }
    
    func show(at screenLocation: CGPoint) {
        hide()
        
        guard RadialMenuSettings.shared.isEnabled else { return }
        
        let scale = RadialMenuSettings.shared.menuScale
        let windowSize: CGFloat = 360 * scale
        
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: windowSize, height: windowSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.level = .popUpMenu
        window.ignoresMouseEvents = false
        
        let windowX = screenLocation.x - windowSize / 2
        let windowY = screenLocation.y - windowSize / 2
        window.setFrameOrigin(NSPoint(x: windowX, y: windowY))
        
        let contentView = RadialMenuWindowContent(onDismiss: { [weak self] in
            self?.hide()
        }, onSelect: { action in
            self.executeAction(action)
            self.hide()
        })
        
        window.contentView = NSHostingView(rootView: contentView)
        
        // 注意：不要监控鼠标按下事件，否则会拦截按钮点击
        // 使用背景点击来关闭菜单
        
        self.window = window
        window.makeKeyAndOrderFront(nil)
        
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                self?.hide()
                return nil
            }
            return event
        }
    }
    
    func hide() {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
        }
        
        window?.orderOut(nil)
        window = nil
    }
    
    private func executeAction(_ action: ShortcutAction) {
        // 延迟一帧发送事件，确保主窗口已经重新成为 key window
        DispatchQueue.main.async {
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
            case .clearFormatting:
                ShortcutActionHandler.shared.clearFormattingPublisher.send()
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
            case .focusCurrentNoteSearch:
                ShortcutActionHandler.shared.focusCurrentNoteSearchPublisher.send()
            case .focusEditor:
                ShortcutActionHandler.shared.focusEditorPublisher.send()
            }
        }
    }
}

/// 环形菜单窗口内容
struct RadialMenuWindowContent: View {
    let onDismiss: () -> Void
    let onSelect: (ShortcutAction) -> Void
    
    @StateObject private var settings = RadialMenuSettings.shared
    @State private var hoveredPosition: Int? = nil
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        GeometryReader { geometry in
            let scale = settings.menuScale
            let size = min(geometry.size.width, geometry.size.height)
            let center = CGPoint(x: geometry.size.width / 2, y: geometry.size.height / 2)
            let outerRadius: CGFloat = size / 2 - 8
            let innerRadius: CGFloat = 55 * scale
            
            ZStack {
                // 背景圆（可点击关闭）
                Circle()
                    .fill(Color(NSColor.controlBackgroundColor))
                    .frame(width: outerRadius * 2, height: outerRadius * 2)
                    .position(center)
                    .shadow(color: .black.opacity(0.2), radius: 15 * scale, x: 0, y: 8 * scale)
                    .onTapGesture {
                        // 只有点击背景圆但不在按钮上时才关闭
                        DebugLog.app("Background tapped, closing menu", level: .debug)
                        onDismiss()
                    }
                
                // 8个扇形区域
                ForEach(0..<8) { index in
                    let startAngle = Double(index) * 45.0 - 22.5
                    let endAngle = startAngle + 45.0
                    let isHovered = hoveredPosition == index
                    
                    // 找到这个位置的功能
                    let action = settings.menuItems.first { $0.position == index }?.action
                    
                    SectorView(
                        center: center,
                        innerRadius: innerRadius,
                        outerRadius: outerRadius,
                        startAngle: startAngle,
                        endAngle: endAngle,
                        action: action,
                        isHovered: isHovered,
                        scale: scale,
                        onSelect: {
                            if let action = action {
                                onSelect(action)
                            }
                        }
                    )
                }
                
                // 中心圆
                Circle()
                    .fill(Color(NSColor.controlBackgroundColor))
                    .frame(width: innerRadius * 2 - 4, height: innerRadius * 2 - 4)
                    .position(center)
                    .shadow(color: .black.opacity(0.15), radius: 6 * scale, x: 0, y: 3 * scale)
                
                // 中心内容
                CenterContent(
                    hoveredAction: hoveredPosition.flatMap { pos in
                        settings.menuItems.first { $0.position == pos }?.action
                    },
                    scale: scale
                )
                .position(center)
            }
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let location):
                    updateHover(at: location, center: center, innerRadius: innerRadius, outerRadius: outerRadius)
                case .ended:
                    hoveredPosition = nil
                }
            }
        }
    }
    
    private func updateHover(at location: CGPoint, center: CGPoint, innerRadius: CGFloat, outerRadius: CGFloat) {
        let dx = location.x - center.x
        let dy = location.y - center.y
        let distance = hypot(dx, dy)
        
        DebugLog.app("Mouse at (\(Int(location.x)), \(Int(location.y)), center at (\(Int(center.x)), \(Int(center.y)))", level: .debug)
        DebugLog.app("dx=\(Int(dx)), dy=\(Int(dy)), distance=\(Int(distance)), inner=\(Int(innerRadius)), outer=\(Int(outerRadius))", level: .debug)
        
        // 如果在中心圆内，不悬停任何扇形
        if distance < innerRadius {
            DebugLog.app("In center, no hover", level: .debug)
            hoveredPosition = nil
            return
        }
        
        // 如果在外圆外，不悬停
        if distance > outerRadius {
            DebugLog.app("Outside ring, no hover", level: .debug)
            hoveredPosition = nil
            return
        }
        
        // 计算角度
        // SwiftUI坐标系：Y轴向下为正
        // atan2期望：Y轴向上为正，所以dy要取反
        var angle = atan2(-dy, dx) * 180 / .pi
        DebugLog.app("Raw angle (after Y-flip): \(angle)", level: .debug)
        
        // atan2 返回：右0，上90，左180/-180，下-90
        // 转换为：上0，右90，下180，左270（顺时针）
        angle = 90 - angle
        if angle < 0 {
            angle += 360
        }
        if angle >= 360 {
            angle -= 360
        }
        
        DebugLog.app("Converted angle: \(angle)", level: .debug)
        
        // 找到对应的扇形 (每个45度)
        // 扇形0: -22.5 to 22.5 (顶部)
        let sectorIndex = Int((angle + 22.5) / 45.0) % 8
        
        DebugLog.app("Sector index: \(sectorIndex)", level: .debug)
        
        if hoveredPosition != sectorIndex {
            DebugLog.app("Hover changed to sector \(sectorIndex)", level: .debug)
            hoveredPosition = sectorIndex
        }
    }
}

/// 中心内容
struct CenterContent: View {
    let hoveredAction: ShortcutAction?
    let scale: CGFloat
    
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        VStack(spacing: 4 * scale) {
            if let action = hoveredAction {
                Image(systemName: action.icon)
                    .font(.system(size: 26 * scale))
                    .foregroundStyle(themeManager.accentColor)
                Text(action.displayName)
                    .font(.system(size: 12 * scale, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            } else {
                Image(systemName: "hand.tap")
                    .font(.system(size: 26 * scale))
                    .foregroundStyle(.secondary)
                Text("选择功能")
                    .font(.system(size: 12 * scale, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 80 * scale)
    }
}

/// 扇形视图
struct SectorView: View {
    let center: CGPoint
    let innerRadius: CGFloat
    let outerRadius: CGFloat
    let startAngle: Double
    let endAngle: Double
    let action: ShortcutAction?
    let isHovered: Bool
    let scale: CGFloat
    let onSelect: () -> Void
    
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        // 计算图标位置
        let midAngle = (startAngle + endAngle) / 2
        let iconRadius = (innerRadius + outerRadius) / 2
        let iconX = center.x + iconRadius * cos((90 - midAngle) * .pi / 180)
        let iconY = center.y - iconRadius * sin((90 - midAngle) * .pi / 180)
        
        ZStack {
            // 扇形背景（仅在悬停时显示）
            if isHovered && action != nil {
                SectorShape(
                    center: center,
                    innerRadius: innerRadius,
                    outerRadius: outerRadius,
                    startAngle: startAngle,
                    endAngle: endAngle
                )
                .fill(themeManager.accentColor)
            }
            
            // 图标
            if let action = action {
                Button(action: {
                    DebugLog.app("Button clicked for action: \(action)", level: .debug)
                    onSelect()
                }) {
                    Image(systemName: action.icon)
                        .font(.system(size: 20 * scale, weight: .semibold))
                        .foregroundStyle(isHovered ? .white : .primary)
                        .frame(width: 40 * scale, height: 40 * scale)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PlainButtonStyle())
                .position(x: iconX, y: iconY)
            }
        }
    }
}

/// 扇形形状
struct SectorShape: Shape {
    let center: CGPoint
    let innerRadius: CGFloat
    let outerRadius: CGFloat
    let startAngle: Double
    let endAngle: Double
    
    func path(in rect: CGRect) -> Path {
        var path = Path()
        
        // SwiftUI角度：0在右侧，顺时针增加
        // 我们的角度：0在顶部，顺时针增加
        // 转换：SwiftUI角度 = 我们的角度 - 90
        let start = Angle(degrees: startAngle - 90)
        let end = Angle(degrees: endAngle - 90)
        
        // 外圆弧（逆时针绘制，因为我们想要顺时针方向）
        path.addArc(
            center: center,
            radius: outerRadius,
            startAngle: start,
            endAngle: end,
            clockwise: false
        )
        
        // 连接到内圆
        let innerEndX = center.x + innerRadius * cos(end.radians)
        let innerEndY = center.y + innerRadius * sin(end.radians)
        path.addLine(to: CGPoint(x: innerEndX, y: innerEndY))
        
        // 内圆弧（顺时针绘制）
        path.addArc(
            center: center,
            radius: innerRadius,
            startAngle: end,
            endAngle: start,
            clockwise: true
        )
        
        path.closeSubpath()
        
        return path
    }
}
