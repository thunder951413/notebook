import SwiftUI
import AppKit
import SwiftData

extension Notification.Name {
    static let openMainWindow = Notification.Name("openMainWindow")
    static let appShouldTerminate = Notification.Name("appShouldTerminate")
    static let insertTextAtCursor = Notification.Name("insertTextAtCursor")
    static let editorFontDidChange = Notification.Name("editorFontDidChange")
    static let focusSearchField = Notification.Name("focusSearchField")
    static let focusCurrentNoteSearch = Notification.Name("focusCurrentNoteSearch")
    static let toggleMarkdownPreview = Notification.Name("toggleMarkdownPreview")
    static let insertConversation = Notification.Name("insertConversation")
    static let scrollToHeading = Notification.Name("scrollToHeading")
    static let showTableOfContentsMenu = Notification.Name("showTableOfContentsMenu")
    static let toggleTableOfContents = Notification.Name("toggleTableOfContents")
}

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem?
    var popover: NSPopover?
    var aboutWindow: NSWindow?

    // Store 用于跨视图共享数据
    @MainActor let store = NoteStore()
    @MainActor let storage = StorageLocationManager.shared
    @MainActor let persistence = PersistenceController.shared
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        Logger.shared.log(.app, .info, "[AppDelegate] applicationDidFinishLaunching - 程序启动")

        // 注册表格视图提供器（TextKit 2）
        if #available(macOS 12.0, *) {
            TableTextAttachment.registerViewProvider()
        }

        // 配置关于面板信息
        setupAboutPanel()

        // 应用语言设置
        LanguageManager.shared.applyLanguage()

        // 初始化数据存储并注入到 NoteStore
        Task { @MainActor in
            _ = storage.startAccessIfPossible()
            try? persistence.configureIfPossible()
            AutoSyncCoordinator.shared.configure(store: store)
            if let container = persistence.modelContainer {
                store.setContext(container.mainContext)
                // 同时设置 NoteSaveManager 的 context
                NoteSaveManager.shared.setContext(container.mainContext)
                AutoSyncCoordinator.shared.handleApplicationLaunched()
            }
        }

        setupMenu()
        setupStatusItem()
        setupPopover()

        // 启动时显示主窗口
        Task { @MainActor in
            MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
        }

        // 启动鼠标中键监控
        RadialMenuEventMonitor.shared.startMonitoring()
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        Logger.shared.log(.app, .info, "[AppDelegate] applicationWillTerminate - 程序正在退出！")
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Task { @MainActor in
            AutoSyncCoordinator.shared.handleApplicationDidBecomeActive()
        }
    }
    
    /// 应用即将退出时调用 - 返回 .terminateLater 以延迟退出，确保保存完成
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Logger.shared.log(.app, .info, "[AppDelegate] applicationShouldTerminate - 准备退出，触发保存...")
        
        // 发送通知让 ContentView 保存当前笔记
        NotificationCenter.default.post(name: .appShouldTerminate, object: nil)
        
        // 刷新所有待保存内容
        NoteSaveManager.shared.flushAllPending()

        Task { @MainActor in
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    await AutoSyncCoordinator.shared.flushPendingBeforeTermination()
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                }
                _ = await group.next()
                group.cancelAll()
            }

            Logger.shared.log(.app, .info, "[AppDelegate] 保存完成，允许退出")
            NSApp.reply(toApplicationShouldTerminate: true)
        }

        // 返回 .terminateLater 延迟退出
        return .terminateLater
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // 方案 A：关闭最后一个窗口时不退出，让应用常驻（Dock 图标和菜单栏入口都保留）
        Logger.shared.log(.app, .debug, "[AppDelegate] applicationShouldTerminateAfterLastWindowClosed - 返回 false，保持应用常驻")
        return false
    }
    
    /// 配置应用菜单
    func setupMenu() {
        // 获取主菜单
        guard let mainMenu = NSApp.mainMenu else { return }

        // 查找应用菜单（通常是第一个菜单）
        if let appMenuItem = mainMenu.items.first {
            // 查找关于菜单项并替换其 action
            if let aboutMenuItem = appMenuItem.submenu?.items.first(where: { $0.title.contains("关于") || $0.title.contains("About") }) {
                aboutMenuItem.target = self
                aboutMenuItem.action = #selector(showAboutPanel)
            }
        }
    }

    /// 配置关于面板信息
    func setupAboutPanel() {
        // 创建自定义关于窗口
        let aboutWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        aboutWindow.title = "关于 Notebook"
        aboutWindow.center()

        // 创建关于视图
        let aboutView = AboutView()
        aboutWindow.contentView = NSHostingView(rootView: aboutView)

        // 保存窗口引用
        self.aboutWindow = aboutWindow
    }

    /// 显示关于窗口
    @objc func showAboutPanel() {
        if let window = aboutWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            setupAboutPanel()
            aboutWindow?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func setupStatusItem() {
        Logger.shared.log(.app, .debug, "[AppDelegate] setupStatusItem - 创建菜单栏图标")
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
        Logger.shared.log(.app, .info, "[AppDelegate] openMainWindow - 通过 MainWindowController 显示主窗口")
        Task { @MainActor in
            MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
        }
        popover?.performClose(nil)
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        Logger.shared.log(.app, .debug, "[AppDelegate] applicationShouldHandleReopen - flag: \(flag)")
        Task { @MainActor in
            MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
        }
        return true
    }
}
