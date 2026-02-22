import SwiftUI
import AppKit

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem?
    var popover: NSPopover?
    
    // Store 用于跨视图共享数据
    @MainActor let store = NoteStore()
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        print("[AppDelegate] applicationDidFinishLaunching - 程序启动")
        setupStatusItem()
        setupPopover()
        
        // 关键：初始时也要尝试绑定
        rebindWindowDelegates()
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        print("[AppDelegate] applicationWillTerminate - 程序正在退出！")
    }

    func applicationDidResignActive(_ notification: Notification) {
        print("[AppDelegate] applicationDidResignActive - 程序失去焦点")
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        print("[AppDelegate] applicationDidBecomeActive - 程序获得焦点")
        rebindWindowDelegates()
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        print("[AppDelegate] applicationShouldTerminateAfterLastWindowClosed - 返回 false，防止程序退出")
        return false
    }

    func applicationWillUpdate(_ notification: Notification) {
        rebindWindowDelegates()
    }

    private func rebindWindowDelegates() {
        for window in NSApp.windows {
            let className = window.className
            // 排除状态栏和 Popover 窗口
            if !className.contains("StatusItem") && 
               !className.contains("Popover") &&
               !className.contains("StatusBar") &&
               !className.contains("TUI") { // 排除系统/第三方透明窗口
                if window.delegate == nil {
                    print("[AppDelegate] 绑定窗口代理: \(className)")
                    window.delegate = self
                }
            }
        }
    }
    
    // 拦截点击关闭按钮或 Cmd+W 的行为
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        print("[AppDelegate] windowShouldClose - 拦截关闭事件，改为 orderOut (仅隐藏窗口)")
        sender.orderOut(nil) // 仅让窗口不显示，不销毁，也不使用 NSApp.hide
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
        print("[AppDelegate] openMainWindow - 尝试恢复显示主窗口")
        
        // 1. 确保应用处于激活状态
        NSApp.activate(ignoringOtherApps: true)
        
        // 2. 查找主窗口：排除掉系统和工具窗口
        let mainWindow = NSApp.windows.first { window in
            let className = window.className
            return !className.contains("StatusItem") && 
                   !className.contains("Popover") &&
                   !className.contains("StatusBar") &&
                   !className.contains("TUI") &&
                   window.canBecomeKey
        }
        
        if let window = mainWindow {
            print("[AppDelegate] 找到主窗口 \(window.className)，执行 makeKeyAndOrderFront")
            NSApp.unhide(nil) // 确保应用层级没有被隐藏
            window.makeKeyAndOrderFront(nil)
            window.deminiaturize(nil) // 如果被最小化了也恢复
        } else {
            // 兜底：如果实在找不到，尝试让所有隐藏的窗口显示（针对 NSApp.hide 的补救）
            print("[AppDelegate] 未找到明确的主窗口，尝试 unhideAll")
            NSApp.unhide(nil)
            for window in NSApp.windows {
                if !window.isVisible && window.canBecomeKey {
                    window.makeKeyAndOrderFront(nil)
                }
            }
        }
        
        popover?.performClose(nil)
    }
}
