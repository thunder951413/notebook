import SwiftUI
import AppKit
import SwiftData

extension Notification.Name {
    static let openMainWindow = Notification.Name("openMainWindow")
    static let appShouldTerminate = Notification.Name("appShouldTerminate")
}

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem?
    var popover: NSPopover?
    
    // Store 用于跨视图共享数据
    @MainActor let store = NoteStore()
    @MainActor let storage = StorageLocationManager.shared
    @MainActor let persistence = PersistenceController.shared
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        print("[AppDelegate] applicationDidFinishLaunching - 程序启动")

        // 初始化数据存储并注入到 NoteStore
        Task { @MainActor in
            _ = storage.startAccessIfPossible()
            try? persistence.configureIfPossible()
            if let container = persistence.modelContainer {
                store.setContext(container.mainContext)
            }
        }

        setupStatusItem()
        setupPopover()
        
        // 启动时显示主窗口
        Task { @MainActor in
            MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        print("[AppDelegate] applicationWillTerminate - 程序正在退出！")
    }
    
    /// 应用即将退出时调用 - 返回 .terminateLater 以延迟退出，确保保存完成
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        print("[AppDelegate] applicationShouldTerminate - 准备退出，触发保存...")
        
        // 发送通知让 ContentView 保存当前笔记
        NotificationCenter.default.post(name: .appShouldTerminate, object: nil)
        
        // 刷新所有待保存内容
        NoteSaveManager.shared.flushAllPending()
        
        // 延迟一小段时间确保保存完成
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            print("[AppDelegate] 保存完成，允许退出")
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        
        // 返回 .terminateLater 延迟退出
        return .terminateLater
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // 方案 A：关闭最后一个窗口时不退出，让应用常驻（Dock 图标和菜单栏入口都保留）
        print("[AppDelegate] applicationShouldTerminateAfterLastWindowClosed - 返回 false，保持应用常驻")
        return false
    }
    
    func setupStatusItem() {
        print("[AppDelegate] setupStatusItem - 创建菜单栏图标")
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: nil)
            button.action = #selector(togglePopover)
            button.target = self
        }
    }
    
    func setupPopover() {
        popover = NSPopover()
        popover?.contentSize = NSSize(width: 320, height: 420)
        popover?.behavior = .transient
        popover?.contentViewController = NSHostingController(rootView: PopoverView().environmentObject(store))
    }
    
    @objc func togglePopover() {
        if let button = statusItem?.button {
            if popover?.isShown == true {
                popover?.performClose(nil)
            } else {
                popover?.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                popover?.contentViewController?.view.window?.makeKey()
            }
        }
    }
    
    @objc func openMainWindow() {
        print("[AppDelegate] openMainWindow - 通过 MainWindowController 显示主窗口")
        Task { @MainActor in
            MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
        }
        popover?.performClose(nil)
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        print("[AppDelegate] applicationShouldHandleReopen - flag: \(flag)")
        Task { @MainActor in
            MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
        }
        return true
    }
}
