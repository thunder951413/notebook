import SwiftUI
import AppKit
import SwiftData
import Combine

struct AIServiceSelectorHeader: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var configManager = AIConfigManager.shared
    @State private var showingSettings = false
    
    var body: some View {
        HStack {
            Menu {
                if configManager.configs.isEmpty {
                    Text("没有配置的服务")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(configManager.configs) { config in
                        Button {
                            configManager.selectConfig(id: config.id)
                        } label: {
                            HStack {
                                Text(config.name)
                                if config.id == configManager.selectedConfigID {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                }
                
                Divider()
                
                Button {
                    showingSettings = true
                } label: {
                    Label("管理配置...", systemImage: "gearshape")
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "cpu")
                        .font(.caption2)
                    Text(configManager.selectedConfig?.model ?? "未选择模型")
                        .font(.caption2)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                }
                .foregroundStyle(.secondary.opacity(0.7))
            }
            .buttonStyle(.plain)
            
            Spacer()
        }
        .sheet(isPresented: $showingSettings) {
            AIConfigManagementView()
        }
    }
}

struct AIServiceSelectorButton: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var configManager = AIConfigManager.shared
    @State private var showingSettings = false
    
    var body: some View {
        Menu {
            if configManager.configs.isEmpty {
                Text("没有配置的服务")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(configManager.configs) { config in
                    Button {
                        configManager.selectConfig(id: config.id)
                    } label: {
                        HStack {
                            Text(config.name)
                            if config.id == configManager.selectedConfigID {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }
            
            Divider()
            
            Button {
                showingSettings = true
            } label: {
                Label("管理配置...", systemImage: "gearshape")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.caption)
                Text(configManager.selectedConfig?.name ?? "AI")
                    .font(.caption)
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("选择 AI 服务")
        .sheet(isPresented: $showingSettings) {
            AIConfigManagementView()
        }
    }
}

struct AISettingsButton: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared
    @State private var showingSettings = false
    
    var body: some View {
        Button {
            showingSettings = true
        } label: {
            Image(systemName: "gearshape")
                .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("AI 设置")
        .sheet(isPresented: $showingSettings) {
            AIConfigManagementView()
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = FlowResult(in: proposal.width ?? 0, subviews: subviews, spacing: spacing)
        return result.size
    }
    
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = FlowResult(in: bounds.width, subviews: subviews, spacing: spacing)
        for (index, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: bounds.minX + result.positions[index].x, y: bounds.minY + result.positions[index].y), proposal: .unspecified)
        }
    }
    
    struct FlowResult {
        var size: CGSize = .zero
        var positions: [CGPoint] = []
        
        init(in maxWidth: CGFloat, subviews: Subviews, spacing: CGFloat) {
            var x: CGFloat = 0
            var y: CGFloat = 0
            var rowHeight: CGFloat = 0
            
            for subview in subviews {
                let size = subview.sizeThatFits(.unspecified)
                if x + size.width > maxWidth && x > 0 {
                    x = 0
                    y += rowHeight + spacing
                    rowHeight = 0
                }
                positions.append(CGPoint(x: x, y: y))
                rowHeight = max(rowHeight, size.height)
                x += size.width + spacing
            }
            
            self.size = CGSize(width: maxWidth, height: y + rowHeight)
        }
    }
}

struct AIMessage: Identifiable {
    let id: UUID
    var content: String
    let isUser: Bool
    let timestamp: Date
    
    init(id: UUID = UUID(), content: String, isUser: Bool, timestamp: Date = Date()) {
        self.id = id
        self.content = content
        self.isUser = isUser
        self.timestamp = timestamp
    }
}

struct TableOfContentsMenu: NSViewRepresentable {
    let content: String
    let viewMode: NoteViewMode
    let onSelect: (String) -> Void

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton()
        button.image = NSImage(systemSymbolName: "list.bullet", accessibilityDescription: "目录")
        button.bezelStyle = .shadowlessSquare
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.target = context.coordinator
        button.action = #selector(Coordinator.showMenu(_:))
        button.toolTip = "目录 (⌘⇧T)"

        // 设置固定大小
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 20),
            button.heightAnchor.constraint(equalToConstant: 20)
        ])

        return button
    }

    func updateNSView(_ nsView: NSButton, context: Context) {
        let tocItems = extractTableOfContents(from: content)
        let isAvailable = viewMode != .text && !tocItems.isEmpty
        nsView.isEnabled = isAvailable
        nsView.alphaValue = viewMode != .text ? 1.0 : 0.0

        // 更新 coordinator 的数据
        context.coordinator.content = content
        context.coordinator.onSelect = onSelect
        context.coordinator.button = nsView
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(content: content, onSelect: onSelect)
    }

    class Coordinator: NSObject {
        var content: String
        var onSelect: (String) -> Void
        weak var button: NSButton?
        var cancellable: AnyCancellable?

        init(content: String, onSelect: @escaping (String) -> Void) {
            self.content = content
            self.onSelect = onSelect
            super.init()

            // 监听快捷键 publisher
            cancellable = ShortcutActionHandler.shared.toggleTableOfContentsPublisher
                .sink { [weak self] in
                    guard let self = self,
                          let button = self.button,
                          button.isEnabled,
                          button.alphaValue > 0 else { return }
                    self.showTableOfContentsMenu(from: button)
                }
        }

        @objc func showMenu(_ sender: NSButton) {
            showTableOfContentsMenu(from: sender)
        }

        private func showTableOfContentsMenu(from button: NSButton) {
            let tocItems = extractTableOfContents(from: content)
            guard !tocItems.isEmpty else { return }

            let menu = NSMenu()
            for item in tocItems {
                let menuItem = NSMenuItem(
                    title: indentText(for: item),
                    action: #selector(menuItemSelected(_:)),
                    keyEquivalent: ""
                )
                menuItem.target = self
                menuItem.representedObject = item.anchor
                menu.addItem(menuItem)
            }

            // 在按钮下方显示菜单
            let location = NSPoint(x: 0, y: button.bounds.minY)
            menu.popUp(positioning: nil, at: location, in: button)
        }

        @objc private func menuItemSelected(_ sender: NSMenuItem) {
            if let anchor = sender.representedObject as? String {
                onSelect(anchor)
            }
        }

        private func indentText(for item: TableOfContentsItem) -> String {
            let indent = String(repeating: "    ", count: max(0, item.level - 1))
            return indent + item.title
        }

        deinit {
            cancellable?.cancel()
        }
    }
}

struct MessageBubble: View {
    let message: AIMessage
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared
    @State private var isHovered = false
    @State private var webViewHeight: CGFloat = 50
    
    var body: some View {
        HStack {
            if message.isUser {
                Spacer(minLength: 40)
            }
            
            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                if message.isUser {
                    Text(message.content)
                        .font(.system(size: 13))
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(themeManager.accentColor)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .contextMenu {
                            Button {
                                copyToClipboard(message.content)
                            } label: {
                                Label("复制", systemImage: "doc.on.doc")
                            }
                        }
                } else {
                    MarkdownWebView(markdown: message.content, attributedContent: nil, colorScheme: colorScheme, height: $webViewHeight, noteID: UUID())
                        .frame(height: webViewHeight)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .contextMenu {
                            Button {
                                copyToClipboard(message.content)
                            } label: {
                                Label("复制", systemImage: "doc.on.doc")
                            }

                            Button {
                                copyToClipboard(message.content)
                            } label: {
                                Label("复制并粘贴到笔记", systemImage: "arrow.down.doc")
                            }
                        }
                }
                
                HStack(spacing: 6) {
                    Text(message.timestamp, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.secondary.opacity(0.6))
                    
                    if isHovered {
                        Button {
                            copyToClipboard(message.content)
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .transition(.opacity)
                    }
                }
            }
            .onHover { hovering in
                withAnimation(.easeInOut(duration: 0.15)) {
                    isHovered = hovering
                }
            }
            
            if !message.isUser {
                Spacer(minLength: 40)
            }
        }
    }
    
    private func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
