import SwiftUI
import AppKit

/// 专门管理主窗口的 NSWindowController，避免依赖 SwiftUI WindowGroup 的生命周期
final class MainWindowController: NSWindowController, NSWindowDelegate {
    static let shared = MainWindowController()

    private var hostingController: NSHostingController<AnyView>?

    private override init(window: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Reminder"
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// 显示或前置主窗口
    func show(with store: NoteStore, storage: StorageLocationManager, persistence: PersistenceController) {
        if hostingController == nil {
            let contentView = ContentView()
                .environmentObject(store)
                .environmentObject(storage)
                .environmentObject(persistence)
            let host = NSHostingController(rootView: AnyView(contentView))
            hostingController = host
            window?.contentViewController = host
        }

        guard let window = window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // 关闭按钮：只隐藏窗口，不销毁控制器
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}
