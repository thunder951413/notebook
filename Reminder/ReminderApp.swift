//
//  ReminderApp.swift
//  Reminder
//
//  Created by 闫延 on 2026/2/20.
//

import SwiftUI
import SwiftData

@main
struct ReminderApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var storage = StorageLocationManager.shared
    @StateObject private var persistence = PersistenceController.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appDelegate.store)
                .environmentObject(storage)
                .environmentObject(persistence)
                .onReceive(NotificationCenter.default.publisher(for: NSWindow.willCloseNotification)) { notification in
                    if let window = notification.object as? NSWindow, window.isMainWindow {
                        // 如果是主窗口，且不是由应用退出引起的关闭，则隐藏应用
                        NSApp.hide(nil)
                    }
                }
                .task {
                    // 启动时：如果已有 bookmark，先开启 security-scoped 访问再初始化 SwiftData
                    _ = storage.startAccessIfPossible()
                    try? persistence.configureIfPossible()
                }
        }
    }
}

private struct RootView: View {
    @EnvironmentObject private var storage: StorageLocationManager
    @EnvironmentObject private var persistence: PersistenceController
    @EnvironmentObject private var store: NoteStore

    var body: some View {
        Group {
            if storage.isConfigured, let container = persistence.modelContainer {
                ContentView()
                    .onAppear {
                        store.setContext(container.mainContext)
                    }
            } else {
                OnboardingView()
            }
        }
    }
}
