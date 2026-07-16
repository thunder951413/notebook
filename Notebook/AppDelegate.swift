import SwiftUI
import AppKit
import SwiftData
import UserNotifications

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

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, UNUserNotificationCenterDelegate {
    var statusItem: NSStatusItem?
    var popover: NSPopover?
    var aboutWindow: NSWindow?

    // Store 用于跨视图共享数据
    @MainActor let store = NoteStore()
    @MainActor let storage = StorageLocationManager.shared
    @MainActor let persistence = PersistenceController.shared

    private var isRunningUITests: Bool {
        ProcessInfo.processInfo.environment["NOTEBOOK_UI_TEST_DATA_DIR"] != nil
    }

    private var isRunningUnitTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil && !isRunningUITests
    }

    private var isRunningTests: Bool { isRunningUITests || isRunningUnitTests }
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        Logger.shared.log(.app, .info, "[AppDelegate] applicationDidFinishLaunching - 程序启动")
        UNUserNotificationCenter.current().delegate = self
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(workspaceWillSleep(_:)),
            name: NSWorkspace.willSleepNotification,
            object: nil
        )

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
            if !isRunningTests {
                AutoSyncCoordinator.shared.configure(store: store)
            }
            if let container = persistence.modelContainer {
                store.setContext(container.mainContext)
                // 同时设置 NoteSaveManager 的 context
                NoteSaveManager.shared.setContext(container.mainContext)
                if !isRunningTests {
                    presentIncompleteSaveWarningIfNeeded()
                    AutoSyncCoordinator.shared.handleApplicationLaunched()
                }
            }
        }

        // 单元测试只需要隔离的数据层，不创建窗口、菜单栏入口或任何外部副作用。
        if isRunningUnitTests {
            return
        }

        setupMenu()
        setupStatusItem()
        setupPopover()

        // 启动时显示主窗口
        Task { @MainActor in
            MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
        }

        // 启动鼠标中键监控
        if !isRunningUITests {
            RadialMenuEventMonitor.shared.startMonitoring()
        }

        if !isRunningUITests && AppSettings.shared.automaticUpdateChecksEnabled {
            Task { @MainActor in
                if let release = await UpdateChecker.shared.checkForUpdates(silently: true) {
                    presentUpdateAlert(for: release)
                }
            }
        }
    }

    @MainActor
    private func presentIncompleteSaveWarningIfNeeded() {
        guard let incomplete = BackupManager.shared.checkForIncompleteSave() else { return }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "检测到上次保存可能未完成"
        alert.informativeText = "笔记 \(incomplete.noteID.uuidString) 在 \(formatter.string(from: incomplete.timestamp)) 保存时异常中断。现有数据未被自动替换，请在“数据管理 → 备份恢复”中核对并按需恢复。"
        alert.addButton(withTitle: "知道了")
        alert.runModal()
        BackupManager.shared.markSaveComplete()
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        Logger.shared.log(.app, .info, "[AppDelegate] applicationWillTerminate - 程序正在退出！")
    }

    @objc private func workspaceWillSleep(_ notification: Notification) {
        do {
            try NoteSaveManager.shared.prepareForSync()
            Logger.shared.log(.save, .info, "系统睡眠前已保存当前编辑内容")
        } catch {
            Logger.shared.log(.save, .error, "系统睡眠前保存失败：\(error.localizedDescription)")
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard !isRunningTests else { return }
        Task { @MainActor in
            AutoSyncCoordinator.shared.handleApplicationDidBecomeActive()
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let itemIDString = (userInfo["itemID"] as? String) ?? (userInfo["noteID"] as? String)
        let itemType = (userInfo["itemType"] as? String) ?? "note"

        Task { @MainActor in
            if let itemIDString, let id = UUID(uuidString: itemIDString) {
                MainWindowController.shared.show(with: store, storage: storage, persistence: persistence)
                if itemType == "todo" {
                    store.selectedTodoId = id
                } else {
                    store.selectedNoteId = id
                }
            }
            completionHandler()
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
    
    /// 应用即将退出时调用 - 返回 .terminateLater 以延迟退出，确保保存完成
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Logger.shared.log(.app, .info, "[AppDelegate] applicationShouldTerminate - 准备退出，触发保存...")
        
        do {
            try NoteSaveManager.shared.prepareForSync()
        } catch {
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "无法安全退出"
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: "返回笔记")
            alert.runModal()
            return .terminateCancel
        }

        // 当前笔记已可靠落盘，通知视图保存导航状态。
        NotificationCenter.default.post(name: .appShouldTerminate, object: nil)

        if isRunningTests {
            return .terminateNow
        }

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

            // 无论自动同步是完成还是达到退出等待上限，都关闭复用连接并清理 socket。
            // 清理本身也设置上限，不能反过来无限阻塞应用退出。
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    await SSHSyncManager.shared.closeAllControlMasterConnections()
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
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

    @MainActor
    private func presentUpdateAlert(for release: GitHubReleaseInfo) {
        let alert = NSAlert()
        alert.messageText = "发现新版本 \(release.version)"
        let publishedText: String
        if let publishedAt = release.publishedAt {
            publishedText = publishedAt.formatted(date: .abbreviated, time: .shortened)
        } else {
            publishedText = "未知"
        }

        alert.informativeText = """
        当前版本: \(AppVersion.current.shortVersion)
        最新版本: \(release.version)
        发布时间: \(publishedText)

        是否立即下载更新？若当前 Release 没有可下载资源，将自动打开 Release 页面。
        """
        alert.addButton(withTitle: "立即下载")
        alert.addButton(withTitle: "稍后")

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            UpdateChecker.shared.openPreferredDownload(for: release)
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
