import SwiftUI

/// 设置页面 Tab 类型
enum SettingsTab: String, CaseIterable, Identifiable {
    case general = "general"
    case shortcuts = "shortcuts"
    
    var id: String { rawValue }
    
    var displayName: String {
        switch self {
        case .general: return l10n(L10nKeys.Settings.tabGeneral)
        case .shortcuts: return l10n(L10nKeys.Settings.tabShortcuts)
        }
    }
    
    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .shortcuts: return "keyboard"
        }
    }
}

/// 设置容器视图 - 包含 Tab 切换
struct SettingsContainerView: View {
    @State private var selectedTab: SettingsTab = .general
    
    var body: some View {
        TabView(selection: $selectedTab) {
            SettingsGeneralView()
                .tabItem {
                    Label(SettingsTab.general.displayName, systemImage: SettingsTab.general.icon)
                }
                .tag(SettingsTab.general)
            
            KeyboardShortcutSettingsView()
                .tabItem {
                    Label(SettingsTab.shortcuts.displayName, systemImage: SettingsTab.shortcuts.icon)
                }
                .tag(SettingsTab.shortcuts)
        }
        .frame(minWidth: 600, minHeight: 500)
        .padding(.top, 8)
    }
}

/// 通用设置视图（原 SettingsRootView 的内容）
struct SettingsGeneralView: View {
    @EnvironmentObject private var storage: StorageLocationManager
    @EnvironmentObject private var persistence: PersistenceController
    @EnvironmentObject private var store: NoteStore
    @StateObject private var languageManager = LanguageManager.shared
    @StateObject private var themeManager = ThemeManager.shared

    @State private var isChoosingDirectory = false
    @State private var errorMessage: String?
    @State private var showRestartAlert = false
    @State private var showBackupRestoreSheet = false
    @State private var showClearBackupConfirmation = false
    @State private var startupBehavior = AppSettings.shared.startupBehavior

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // 语言设置
                VStack(alignment: .leading, spacing: 12) {
                    Text(l10n(L10nKeys.Language.title))
                        .font(.title2)
                        .bold()

                    Picker(l10n(L10nKeys.Language.title), selection: $languageManager.currentLanguage) {
                        ForEach(AppLanguage.allCases) { language in
                            Text(language.displayName).tag(language)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 300)
                    .onChange(of: languageManager.currentLanguage) { _, _ in
                        showRestartAlert = true
                    }

                    Text(l10n(L10nKeys.Language.restartRequired))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Divider()

                // 启动行为设置
                VStack(alignment: .leading, spacing: 12) {
                    Text(l10n(L10nKeys.Settings.startupTitle))
                        .font(.title2)
                        .bold()

                    Picker(l10n(L10nKeys.Settings.startupBehavior), selection: $startupBehavior) {
                        ForEach(AppSettings.StartupBehavior.allCases, id: \.self) { behavior in
                            Text(behavior.displayName).tag(behavior)
                        }
                    }
                    .pickerStyle(.radioGroup)
                    .frame(maxWidth: 300, alignment: .leading)
                    .onChange(of: startupBehavior) { _, newValue in
                        AppSettings.shared.startupBehavior = newValue
                    }

                    Text(l10n(L10nKeys.Settings.startupDescription))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Divider()

                // 主题色设置
                VStack(alignment: .leading, spacing: 12) {
                    Text(l10n(L10nKeys.Settings.themeColor))
                        .font(.title2)
                        .bold()

                    Text(l10n(L10nKeys.Settings.themeDescription))
                        .font(.caption)
                        .foregroundColor(.secondary)

                    HStack(spacing: 12) {
                        ForEach(0..<AppSettings.presetColors.count, id: \.self) { index in
                            let color = AppSettings.presetColors[index]
                            Button {
                                themeManager.updateAccentColor(color)
                            } label: {
                                Circle()
                                    .fill(color)
                                    .frame(width: 28, height: 28)
                                    .overlay(
                                        Circle()
                                            .stroke(Color.primary.opacity(0.3), lineWidth: 1)
                                    )
                                    .overlay(
                                        Circle()
                                            .stroke(isColorSelected(color) ? Color.primary : Color.clear, lineWidth: 2)
                                            .padding(-2)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Divider()

                // 备份与恢复
                VStack(alignment: .leading, spacing: 12) {
                    Text(l10n(L10nKeys.Backup.title))
                        .font(.title2)
                        .bold()

                    VStack(alignment: .leading, spacing: 8) {
                        Text(l10n(L10nKeys.Backup.description))
                            .font(.caption)
                            .foregroundColor(.secondary)

                        HStack(spacing: 12) {
                            Button(l10n(L10nKeys.Backup.restore)) {
                                showBackupRestoreSheet = true
                            }

                            Button(l10n(L10nKeys.Backup.clear)) {
                                showClearBackupConfirmation = true
                            }
                            .foregroundColor(.red)
                        }

                        // iCloud 同步
                        Divider()
                            .padding(.vertical, 8)

                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(l10n(L10nKeys.Settings.iCloudSync))
                                    .font(.headline)

                                if iCloudBackupManager.shared.isiCloudAvailable {
                                    if let lastSync = iCloudBackupManager.shared.lastSyncDate {
                                        Text(String(format: l10n(L10nKeys.Settings.iCloudLastSync), formattedDate(lastSync)))
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    } else {
                                        Text(l10n(L10nKeys.Settings.iCloudNotSynced))
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                } else {
                                    Text(l10n(L10nKeys.Settings.iCloudUnavailable))
                                        .font(.caption)
                                        .foregroundColor(.red)
                                }
                            }

                            Spacer()

                            if iCloudBackupManager.shared.isSyncing {
                                ProgressView()
                                    .scaleEffect(0.8)
                            } else if iCloudBackupManager.shared.isiCloudAvailable {
                                Button(l10n(L10nKeys.Settings.iCloudSyncNow)) {
                                    Task {
                                        await iCloudBackupManager.shared.syncToiCloud()
                                    }
                                }
                            }
                        }
                    }
                }

                Divider()

                // 数据存储位置
                VStack(alignment: .leading, spacing: 12) {
                    Text(l10n(L10nKeys.Settings.storageLocation))
                        .font(.title2)
                        .bold()

                    VStack(alignment: .leading, spacing: 8) {
                        Text(l10n(L10nKeys.Settings.storageCurrentPath))
                            .font(.headline)

                        if let url = storage.baseDirectoryURL {
                            Text(url.path)
                                .font(.system(size: 12, weight: .regular, design: .monospaced))
                                .lineLimit(3)
                                .textSelection(.enabled)
                        } else {
                            Text(l10n(L10nKeys.Settings.storageNotConfigured))
                                .foregroundColor(.secondary)
                        }
                    }

                    HStack(spacing: 12) {
                        Button {
                            chooseDirectory()
                        } label: {
                            Text(storage.isConfigured ? l10n(L10nKeys.Settings.storageChange) : l10n(L10nKeys.Settings.storageSelect))
                        }

                        if storage.isConfigured {
                            Button(l10n(L10nKeys.Settings.storageShowInFinder)) {
                                if let url = storage.baseDirectoryURL {
                                    NSWorkspace.shared.activateFileViewerSelecting([url])
                                }
                            }
                        }
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .foregroundColor(.red)
                        .font(.footnote)
                }

                Spacer()
            }
            .padding(20)
        }
        .alert(l10n(L10nKeys.Settings.restartAlertTitle), isPresented: $showRestartAlert) {
            Button(l10n(L10nKeys.Restart.later)) {}
            Button(l10n(L10nKeys.Restart.restartNow)) {
                restartApp()
            }
        } message: {
            Text(l10n(L10nKeys.Settings.restartAlertMessage))
        }
        .sheet(isPresented: $showBackupRestoreSheet) {
            BackupRestoreView()
                .frame(minWidth: 600, minHeight: 400)
        }
        .alert(l10n(L10nKeys.Settings.clearBackupsTitle), isPresented: $showClearBackupConfirmation) {
            Button(l10n(L10nKeys.common.cancel), role: .cancel) {}
            Button(l10n(L10nKeys.Backup.clear), role: .destructive) {
                BackupManager.shared.clearAllBackups()
            }
        } message: {
            Text(l10n(L10nKeys.Settings.clearBackupsMessage))
        }
    }

    /// 检查颜色是否被选中
    private func isColorSelected(_ color: Color) -> Bool {
        let currentNSColor = NSColor(AppSettings.shared.accentColor)
        let compareNSColor = NSColor(color)

        var currentR: CGFloat = 0, currentG: CGFloat = 0, currentB: CGFloat = 0, currentA: CGFloat = 0
        var compareR: CGFloat = 0, compareG: CGFloat = 0, compareB: CGFloat = 0, compareA: CGFloat = 0

        currentNSColor.getRed(&currentR, green: &currentG, blue: &currentB, alpha: &currentA)
        compareNSColor.getRed(&compareR, green: &compareG, blue: &compareB, alpha: &compareA)

        let tolerance: CGFloat = 0.01
        return abs(currentR - compareR) < tolerance &&
               abs(currentG - compareG) < tolerance &&
               abs(currentB - compareB) < tolerance
    }

    /// 格式化日期
    private func formattedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// 选择目录
    private func chooseDirectory() {
        isChoosingDirectory = true
        errorMessage = nil

        Task {
            do {
                try await storage.promptUserToChooseBaseDirectory()
                try persistence.configureIfPossible()
                store.fetchData()
            } catch {
                errorMessage = error.localizedDescription
            }
            isChoosingDirectory = false
        }
    }

    /// 重启应用
    private func restartApp() {
        let url = URL(fileURLWithPath: Bundle.main.resourcePath!)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let task = Process()
        task.launchPath = "/usr/bin/open"
        task.arguments = [url.path]
        task.launch()
        NSApp.terminate(nil)
    }
}

// MARK: - 本地化键值扩展
extension L10nKeys.Settings {
    static let tabGeneral = "settings_tab_general"
    static let tabShortcuts = "settings_tab_shortcuts"
}
