import SwiftUI
import AppKit

/// 单独的设置窗口控制器，用于选择/显示保存路径
final class SettingsWindowController: NSWindowController {
    static let shared = SettingsWindowController()

    private var hostingController: NSHostingController<AnyView>?

    private override init(window: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 400),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = l10n(L10nKeys.Settings.windowTitle)
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(with storage: StorageLocationManager, persistence: PersistenceController, store: NoteStore) {
        // 每次都重新创建视图，确保使用最新的布局
        let view = SettingsContainerView()
            .environmentObject(storage)
            .environmentObject(persistence)
            .environmentObject(store)
        let host = NSHostingController(rootView: AnyView(view))
        hostingController = host
        window?.contentViewController = host
        // 调整窗口大小以适应新的 Tab 布局
        window?.setContentSize(NSSize(width: 800, height: 550))

        guard let window = window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
