import SwiftUI

/// 环形菜单视图
struct RadialMenuView: View {
    @ObservedObject var settings = RadialMenuSettings.shared
    @State private var selectedItem: RadialMenuItem?
    @State private var isVisible = false
    @State private var menuCenter: CGPoint = .zero
    
    var onSelect: ((ShortcutAction) -> Void)?
    var onDismiss: (() -> Void)?
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // 背景遮罩
                Color.black.opacity(0.001)
                    .ignoresSafeArea()
                    .onTapGesture {
                        dismiss()
                    }
                
                // 中心圆
                Circle()
                    .fill(ThemeManager.shared.accentColor.opacity(0.2))
                    .frame(width: 40, height: 40)
                    .position(menuCenter)
                
                // 菜单项
                ForEach(settings.menuItems) { item in
                    if let position = RadialMenuPosition(rawValue: item.position) {
                        RadialMenuItemView(
                            item: item,
                            position: position,
                            center: menuCenter,
                            radius: settings.menuRadius,
                            itemSize: settings.itemSize,
                            isSelected: selectedItem?.id == item.id
                        )
                        .position(
                            position.point(in: settings.menuRadius, center: menuCenter)
                        )
                        .onTapGesture {
                            selectItem(item)
                        }
                        .onHover { isHovering in
                            if isHovering {
                                withAnimation(.easeInOut(duration: 0.15)) {
                                    selectedItem = item
                                }
                            }
                        }
                    }
                }
                
                // 连接线
                Canvas { context, size in
                    for item in settings.menuItems {
                        guard let position = RadialMenuPosition(rawValue: item.position) else { continue }
                        
                        let centerPoint = menuCenter
                        let itemPoint = position.point(in: settings.menuRadius, center: menuCenter)
                        
                        var path = Path()
                        path.move(to: centerPoint)
                        path.addLine(to: itemPoint)
                        
                        context.stroke(
                            path,
                            with: .color(ThemeManager.shared.accentColor.opacity(0.3)),
                            lineWidth: 1
                        )
                    }
                }
                .allowsHitTesting(false)
            }
            .opacity(isVisible ? 1 : 0)
            .scaleEffect(isVisible ? 1 : 0.8)
            .animation(.easeOut(duration: 0.2), value: isVisible)
        }
    }
    
    func show(at point: CGPoint) {
        menuCenter = point
        isVisible = true
    }
    
    func dismiss() {
        isVisible = false
        onDismiss?()
    }
    
    private func selectItem(_ item: RadialMenuItem) {
        onSelect?(item.action)
        dismiss()
    }
}

/// 单个菜单项视图
struct RadialMenuItemView: View {
    let item: RadialMenuItem
    let position: RadialMenuPosition
    let center: CGPoint
    let radius: CGFloat
    let itemSize: CGFloat
    let isSelected: Bool
    
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        ZStack {
            // 背景圆形
            Circle()
                .fill(isSelected ? themeManager.accentColor : Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.2), radius: isSelected ? 6 : 3, x: 0, y: 2)
            
            // 图标
            Image(systemName: item.action.icon)
                .font(.system(size: itemSize * 0.4, weight: .medium))
                .foregroundStyle(isSelected ? .white : .primary)
        }
        .frame(width: itemSize, height: itemSize)
        .scaleEffect(isSelected ? 1.15 : 1.0)
        .animation(.easeInOut(duration: 0.15), value: isSelected)
        .help(item.action.displayName)
    }
}

/// 鼠标中键检测视图修饰符
struct RadialMenuGestureModifier: ViewModifier {
    @State private var isShowingMenu = false
    @State private var menuLocation: CGPoint = .zero
    
    func body(content: Content) -> some View {
        content
            .overlay(
                RadialMenuOverlay(isShowing: $isShowingMenu, location: $menuLocation)
            )
    }
}

/// 环形菜单覆盖层
struct RadialMenuOverlay: NSViewRepresentable {
    @Binding var isShowing: Bool
    @Binding var location: CGPoint
    
    func makeNSView(context: Context) -> RadialMenuNSView {
        let view = RadialMenuNSView()
        view.onMiddleClick = { point in
            location = point
            isShowing = true
        }
        return view
    }
    
    func updateNSView(_ nsView: RadialMenuNSView, context: Context) {
        // 更新逻辑
    }
}

/// 用于检测鼠标中键的 NSView
class RadialMenuNSView: NSView {
    var onMiddleClick: ((CGPoint) -> Void)?
    
    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
    }
    
    override func rightMouseDown(with event: NSEvent) {
        super.rightMouseDown(with: event)
    }
    
    override func otherMouseDown(with event: NSEvent) {
        // 鼠标中键是 buttonNumber 2
        if event.buttonNumber == 2 {
            let location = convert(event.locationInWindow, from: nil)
            onMiddleClick?(location)
        }
        super.otherMouseDown(with: event)
    }
}

extension View {
    func radialMenu() -> some View {
        modifier(RadialMenuGestureModifier())
    }
}
