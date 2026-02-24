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

    var body: some Scene {
        // 不再使用 WindowGroup 生成窗口，由 AppDelegate + MainWindowController 统一管理
        Settings {
            SettingsRootView()
                .environmentObject(StorageLocationManager.shared)
                .environmentObject(PersistenceController.shared)
                .environmentObject(appDelegate.store)
        }
    }
}
