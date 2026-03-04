import SwiftUI
import AppKit

/// 专门管理主窗口的 NSWindowController，避免依赖 SwiftUI WindowGroup 的生命周期
final class MainWindowController: NSWindowController, NSWindowDelegate {
    static let shared = MainWindowController()

    private var hostingController: NSHostingController<AnyView>?
    private var windowState = WindowStateManager.shared
    
    // 用于跟踪是否正在恢复状态，避免在恢复过程中触发保存
    private var isRestoringState = false

    private override init(window: NSWindow?) {
        // 恢复保存的窗口大小和位置
        let savedState = WindowStateManager.shared.state
        let savedFrame = NSRect(
            x: savedState.windowFrame.origin.x,
            y: savedState.windowFrame.origin.y,
            width: savedState.windowFrame.width,
            height: savedState.windowFrame.height
        )
        
        let window = NSWindow(
            contentRect: savedFrame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Notebook"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 800, height: 500)
        
        // 如果没有保存的位置，则居中显示
        if savedFrame.origin.x == 0 && savedFrame.origin.y == 0 {
            window.center()
        }
        
        super.init(window: window)
        window.delegate = self
        
        // 延迟恢复最大化状态，等窗口完全初始化后再执行
        if savedState.isMaximized {
            DispatchQueue.main.async { [weak self] in
                self?.restoreMaximizedState()
            }
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    /// 恢复最大化状态
    private func restoreMaximizedState() {
        guard let window = window, let screen = window.screen else { return }
        
        isRestoringState = true
        
        // 获取屏幕的可见区域（排除菜单栏和 Dock）
        let screenFrame = screen.visibleFrame
        
        // 设置窗口为屏幕大小
        window.setFrame(screenFrame, display: true, animate: false)
        
        // 标记为最大化状态
        windowState.isMaximized = true
        
        isRestoringState = false
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

    // 窗口大小或位置改变时保存
    func windowDidResize(_ notification: Notification) {
        guard !isRestoringState else { return }
        saveWindowState()
    }
    
    func windowDidMove(_ notification: Notification) {
        guard !isRestoringState else { return }
        saveWindowState()
    }
    
    // 窗口即将进入全屏/最大化时
    func windowWillEnterFullScreen(_ notification: Notification) {
        // macOS 原生全屏模式
    }
    
    func windowDidEnterFullScreen(_ notification: Notification) {
        windowState.isMaximized = true
    }
    
    func windowDidExitFullScreen(_ notification: Notification) {
        windowState.isMaximized = false
        saveWindowState()
    }
    
    // 检测最大化状态变化 - 使用更可靠的方法
    private func checkMaximizedState() {
        guard let window = window, let screen = window.screen else { return }
        
        // 获取屏幕的可见区域
        let screenFrame = screen.visibleFrame
        let windowFrame = window.frame
        
        // 判断窗口是否占满整个屏幕（允许 20 像素的误差）
        let widthMatch = abs(windowFrame.width - screenFrame.width) < 20
        let heightMatch = abs(windowFrame.height - screenFrame.height) < 20
        let xMatch = abs(windowFrame.origin.x - screenFrame.origin.x) < 20
        let yMatch = abs(windowFrame.origin.y - screenFrame.origin.y) < 20
        
        let isMaximized = widthMatch && heightMatch && xMatch && yMatch
        
        if windowState.isMaximized != isMaximized {
            windowState.isMaximized = isMaximized
        }
    }
    
    private func saveWindowState() {
        guard let window = window else { return }
        
        // 在保存前检查当前是否最大化
        checkMaximizedState()
        
        // 如果当前是最大化状态，保存最大化前的尺寸（用于恢复时）
        let frame = window.frame
        
        // 只有当不是最大化状态时才保存窗口大小
        // 最大化状态下只保存位置和最大化标志
        if !windowState.isMaximized {
            windowState.updateWindowFrame(CGRect(
                x: frame.origin.x,
                y: frame.origin.y,
                width: frame.width,
                height: frame.height
            ))
        } else {
            // 最大化状态下只更新位置，保持之前保存的尺寸
            windowState.state.windowFrame.origin.x = frame.origin.x
            windowState.state.windowFrame.origin.y = frame.origin.y
            windowState.saveState()
        }
    }

    // 关闭按钮：只隐藏窗口，不销毁控制器
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // 关闭前保存窗口状态
        saveWindowState()
        sender.orderOut(nil)
        return false
    }
    
    // 窗口即将关闭时保存状态
    func windowWillClose(_ notification: Notification) {
        saveWindowState()
    }
}
