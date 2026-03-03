import SwiftUI

/// 环形菜单设置视图
struct RadialMenuSettingsView: View {
    @StateObject private var settings = RadialMenuSettings.shared
    @State private var selectedPosition: Int?
    @State private var showingActionPicker = false
    @State private var editingPosition: Int?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // 标题和开关
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("环形快捷菜单")
                            .font(.title2)
                            .bold()
                        Text("按下配置的鼠标组合键显示环形快捷菜单")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    Toggle("", isOn: $settings.isEnabled)
                        .toggleStyle(.switch)
                        .labelsHidden()
                }

                Divider()

                if settings.isEnabled {
                    // 触发方式设置
                    VStack(alignment: .leading, spacing: 12) {
                        Text("触发方式")
                            .font(.headline)

                        Picker("触发方式", selection: $settings.trigger) {
                            ForEach(RadialMenuTrigger.allCases) { trigger in
                                Text(trigger.displayName).tag(trigger)
                            }
                        }
                        .pickerStyle(.menu)
                        .frame(maxWidth: 250)

                        Text("当前触发方式: \(settings.trigger.displayName)")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    Divider()
                    // 预览区域
                    VStack(alignment: .leading, spacing: 12) {
                        Text("菜单预览")
                            .font(.headline)
                        
                        RadialMenuPreview()
                            .frame(height: 280)
                            .background(Color(NSColor.controlBackgroundColor))
                            .cornerRadius(8)
                    }
                    
                    Divider()
                    
                    // 配置项列表
                    VStack(alignment: .leading, spacing: 12) {
                        Text("菜单配置")
                            .font(.headline)
                        
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 200))], spacing: 12) {
                            ForEach(RadialMenuPosition.allCases, id: \.self) { position in
                                RadialMenuPositionConfig(
                                    position: position,
                                    action: actionForPosition(position.rawValue),
                                    onTap: {
                                        editingPosition = position.rawValue
                                        showingActionPicker = true
                                    },
                                    onClear: {
                                        settings.removeItem(at: position.rawValue)
                                    }
                                )
                            }
                        }
                    }
                    
                    Divider()
                    
                    // 外观设置
                    VStack(alignment: .leading, spacing: 12) {
                        Text("外观设置")
                            .font(.headline)

                        VStack(alignment: .leading, spacing: 8) {
                            Text("菜单缩放: \(String(format: "%.1f", settings.menuScale))x")
                                .font(.subheadline)
                            Slider(value: $settings.menuScale, in: 0.5...1.5, step: 0.1)
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("菜单半径: \(Int(settings.menuRadius))")
                                .font(.subheadline)
                            Slider(value: $settings.menuRadius, in: 80...200, step: 10)
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("按钮大小: \(Int(settings.itemSize))")
                                .font(.subheadline)
                            Slider(value: $settings.itemSize, in: 40...70, step: 5)
                        }
                    }
                    
                    Divider()
                    
                    // 重置按钮
                    Button {
                        settings.resetToDefaults()
                    } label: {
                        Label("恢复默认配置", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding()
        }
        .sheet(isPresented: $showingActionPicker) {
            ActionPickerSheet(
                selectedAction: actionForPosition(editingPosition ?? 0),
                onSelect: { action in
                    if let position = editingPosition {
                        settings.updateItem(at: position, action: action)
                    }
                    showingActionPicker = false
                },
                onCancel: {
                    showingActionPicker = false
                }
            )
        }
    }
    
    private func actionForPosition(_ position: Int) -> ShortcutAction? {
        settings.menuItems.first { $0.position == position }?.action
    }
}

/// 单个位置配置视图
struct RadialMenuPositionConfig: View {
    let position: RadialMenuPosition
    let action: ShortcutAction?
    let onTap: () -> Void
    let onClear: () -> Void
    
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        HStack {
            // 位置标签
            Text(position.displayName)
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(width: 40, alignment: .leading)
            
            // 动作显示
            if let action = action {
                HStack {
                    Image(systemName: action.icon)
                        .foregroundStyle(themeManager.accentColor)
                    Text(action.displayName)
                        .lineLimit(1)
                    Spacer()
                    Button {
                        onClear()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(Color(NSColor.controlBackgroundColor))
                .cornerRadius(6)
            } else {
                Text("未设置")
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(NSColor.controlBackgroundColor).opacity(0.5))
                    .cornerRadius(6)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            onTap()
        }
    }
}

/// 菜单预览视图
struct RadialMenuPreview: View {
    @StateObject private var settings = RadialMenuSettings.shared
    @State private var hoveredPosition: Int?

    var body: some View {
        GeometryReader { geometry in
            let scale = settings.menuScale
            let center = CGPoint(x: geometry.size.width / 2, y: geometry.size.height / 2)
            let outerRadius: CGFloat = min(100, 100 * scale)
            let innerRadius: CGFloat = 35 * scale

            ZStack {
                // 扇形按钮预览
                ForEach(RadialMenuPosition.allCases, id: \.self) { position in
                    let action = settings.menuItems.first { $0.position == position.rawValue }?.action
                    let isHovered = hoveredPosition == position.rawValue
                    let startAngle = position.sectorStartAngle
                    let endAngle = position.sectorEndAngle

                    PreviewSectorShape(
                        center: center,
                        innerRadius: innerRadius,
                        outerRadius: outerRadius,
                        startAngle: startAngle,
                        endAngle: endAngle
                    )
                    .fill(action != nil ?
                          (isHovered ? themeManager.accentColor : Color(NSColor.controlBackgroundColor).opacity(0.9)) :
                            Color(NSColor.controlBackgroundColor).opacity(0.3))
                    .shadow(color: .black.opacity(action != nil ? 0.1 : 0), radius: isHovered ? 3 : 1, x: 0, y: isHovered ? 1 : 0)
                    .overlay(
                        Group {
                            if let action = action {
                                let midAngle = (startAngle + endAngle) / 2
                                let iconRadius = (innerRadius + outerRadius) / 2
                                let iconX = center.x + iconRadius * cos((90 - midAngle) * .pi / 180)
                                let iconY = center.y - iconRadius * sin((90 - midAngle) * .pi / 180)

                                Image(systemName: action.icon)
                                    .font(.system(size: 14 * scale, weight: .semibold))
                                    .foregroundStyle(isHovered ? .white : .primary)
                                    .position(x: iconX, y: iconY)
                            }
                        }
                    )
                    .onHover { isHovering in
                        hoveredPosition = isHovering ? position.rawValue : nil
                    }
                }

                // 中心圆
                Circle()
                    .fill(Color(NSColor.controlBackgroundColor))
                    .frame(width: innerRadius * 2, height: innerRadius * 2)
                    .position(center)
                    .shadow(color: .black.opacity(0.1), radius: 3, x: 0, y: 1)

                // 中心图标
                Image(systemName: "hand.tap")
                    .font(.system(size: 16 * scale))
                    .foregroundStyle(.secondary)
                    .position(center)
            }
        }
    }

    @StateObject private var themeManager = ThemeManager.shared
}

/// 预览用的扇形形状
struct PreviewSectorShape: Shape {
    let center: CGPoint
    let innerRadius: CGFloat
    let outerRadius: CGFloat
    let startAngle: Double
    let endAngle: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()

        let startRad = (90 - startAngle) * .pi / 180
        let endRad = (90 - endAngle) * .pi / 180

        path.addArc(
            center: center,
            radius: outerRadius,
            startAngle: .radians(startRad),
            endAngle: .radians(endRad),
            clockwise: true
        )

        let innerEndX = center.x + innerRadius * cos(endRad)
        let innerEndY = center.y - innerRadius * sin(endRad)
        path.addLine(to: CGPoint(x: innerEndX, y: innerEndY))

        path.addArc(
            center: center,
            radius: innerRadius,
            startAngle: .radians(endRad),
            endAngle: .radians(startRad),
            clockwise: false
        )

        path.closeSubpath()

        return path
    }
}

/// 动作选择 sheet
struct ActionPickerSheet: View {
    let selectedAction: ShortcutAction?
    let onSelect: (ShortcutAction) -> Void
    let onCancel: () -> Void
    
    @State private var searchText = ""
    
    var filteredActions: [ShortcutAction] {
        if searchText.isEmpty {
            return ShortcutAction.allCases
        }
        return ShortcutAction.allCases.filter { action in
            action.displayName.localizedCaseInsensitiveContains(searchText)
        }
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text("选择快捷键")
                    .font(.headline)
                Spacer()
                Button("取消") {
                    onCancel()
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
            .padding()
            .background(Color(NSColor.controlBackgroundColor))
            
            // 搜索框
            TextField("搜索...", text: $searchText)
                .textFieldStyle(.roundedBorder)
                .padding()
            
            // 动作列表
            List(filteredActions, id: \.self, selection: .constant(selectedAction)) { action in
                Button {
                    onSelect(action)
                } label: {
                    HStack {
                        Image(systemName: action.icon)
                            .frame(width: 24)
                            .foregroundStyle(ThemeManager.shared.accentColor)
                        Text(action.displayName)
                        Spacer()
                        if selectedAction == action {
                            Image(systemName: "checkmark")
                                .foregroundStyle(ThemeManager.shared.accentColor)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, 4)
            }
            .listStyle(.plain)
        }
        .frame(width: 300, height: 400)
    }
}
