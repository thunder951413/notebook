import SwiftUI
import SwiftData
import UniformTypeIdentifiers

/// 设置界面根视图：展示/修改数据存储路径
struct SettingsRootView: View {
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
    @State private var showPasswordSheet = false
    @State private var showSSHSettingsSheet = false
    @State private var startupBehavior = AppSettings.shared.startupBehavior
    @State private var showLogExportAlert = false
    @State private var logExportMessage = ""
    @State private var isSyncing = false
    @State private var syncResultMessage: String?
    @State private var showSyncResultAlert = false
    @State private var showMergeStrategyAlert = false
    @State private var pendingSyncAction: ((ConfigMergeStrategy) -> Void)?

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

                    // SSH 同步配置
                    Divider()
                        .padding(.vertical, 8)

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("SSH 同步")
                                    .font(.headline)

                                if SSHConfigManager.shared.isConfigured {
                                    let config = SSHConfigManager.shared.config
                                    Text("已配置: \(config.username)@\(config.host)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                } else {
                                    Text("未配置 SSH 服务器")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }

                            Spacer()

                            Button {
                                showSSHSettingsSheet = true
                            } label: {
                                Text(SSHConfigManager.shared.isConfigured ? "修改配置" : "配置服务器")
                            }
                        }

                        if SSHConfigManager.shared.isConfigured {
                            HStack(spacing: 12) {
                                Button("上传配置") {
                                    syncConfigToRemote()
                                }
                                .disabled(isSyncing)

                                Button("下载配置") {
                                    syncConfigFromRemote()
                                }
                                .disabled(isSyncing)

                                Button("导出配置") {
                                    exportConfig()
                                }
                                .disabled(isSyncing)

                                Button("导入配置") {
                                    importConfig()
                                }
                                .disabled(isSyncing)

                                if isSyncing {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                }
                            }
                        }
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

            // 日志导出
            VStack(alignment: .leading, spacing: 12) {
                Text("日志")
                    .font(.title2)
                    .bold()

                Text("日志保存在内存中，可按模块导出用于排查问题")
                    .font(.caption)
                    .foregroundColor(.secondary)

                HStack(spacing: 12) {
                    Button("导出全部日志") {
                        exportLogs(module: nil)
                    }

                    Menu("按模块导出") {
                        ForEach([LogModule.app, .editor, .table, .save, .storage, .attachment, .search], id: \.self) { module in
                            Button(module.rawValue) {
                                exportLogs(module: module)
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

            Divider()

            // 密码设置
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("安全设置")
                        .font(.title2)
                        .bold()

                    Spacer()

                    Button {
                        showPasswordSheet = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: PasswordManager.shared.hasPassword ? "lock.fill" : "lock.open")
                            Text(PasswordManager.shared.hasPassword ? "修改密码" : "设置密码")
                        }
                    }
                    .buttonStyle(.bordered)
                }

                Text(PasswordManager.shared.hasPassword
                     ? "已启用密码保护"
                     : "未设置密码")
                    .font(.caption)
                    .foregroundColor(.secondary)
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
        .frame(minWidth: 520, minHeight: 400)
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
        .sheet(isPresented: $showPasswordSheet) {
            PasswordSettingsView()
        }
        .sheet(isPresented: $showSSHSettingsSheet) {
            SSHSettingsView()
        }
        .alert(l10n(L10nKeys.Settings.clearBackupsTitle), isPresented: $showClearBackupConfirmation) {
            Button(l10n(L10nKeys.common.cancel), role: .cancel) {}
            Button(l10n(L10nKeys.Backup.clear), role: .destructive) {
                BackupManager.shared.clearAllBackups()
            }
        } message: {
            Text(l10n(L10nKeys.Settings.clearBackupsMessage))
        }
        .alert("日志导出", isPresented: $showLogExportAlert) {
            Button("确定", role: .cancel) {}
        } message: {
            Text(logExportMessage)
        }
        .alert("配置同步", isPresented: $showSyncResultAlert) {
            Button("确定", role: .cancel) {}
        } message: {
            if let message = syncResultMessage {
                Text(message)
            }
        }
        .alert("选择合并策略", isPresented: $showMergeStrategyAlert) {
            Button("优先本地配置") {
                if let action = pendingSyncAction {
                    pendingSyncAction = nil
                    action(.preferLocal)
                }
            }
            Button("优先远程配置") {
                if let action = pendingSyncAction {
                    pendingSyncAction = nil
                    action(.preferRemote)
                }
            }
            Button("优先更新配置") {
                if let action = pendingSyncAction {
                    pendingSyncAction = nil
                    action(.preferNewer)
                }
            }
            Button("取消", role: .cancel) {
                pendingSyncAction = nil
            }
        } message: {
            Text("检测到配置冲突，请选择如何处理：\n\n• 优先本地配置：保留当前设备的设置\n• 优先远程配置：使用远程服务器的设置\n• 优先更新配置：保留更新时间最新的设置")
        }
    }

    /// 检查颜色是否被选中
    private func isColorSelected(_ color: Color) -> Bool {
        // 简单的颜色比较：转换为 NSColor 比较 RGB 值
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

    private func exportLogs(module: LogModule?) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = module == nil ? "notebook-logs.txt" : "notebook-\(module!.rawValue.lowercased())-logs.txt"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            let content = module == nil ? Logger.shared.exportLogsGroupedByModule() : Logger.shared.exportLogs(module: module)
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
                logExportMessage = "日志已导出到: \(url.path)"
            } catch {
                logExportMessage = "日志导出失败: \(error.localizedDescription)"
            }
            showLogExportAlert = true
        }
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
                // 刷新笔记列表
                store.fetchData()
            } catch {
                errorMessage = error.localizedDescription
            }
            isChoosingDirectory = false
        }
    }

    /// 上传配置到远程服务器
    private func syncConfigToRemote() {
        guard SSHConfigManager.shared.isConfigured else {
            syncResultMessage = "请先配置 SSH 服务器"
            showSyncResultAlert = true
            return
        }

        isSyncing = true
        syncResultMessage = nil

        Task {
            do {
                let config = SSHConfigManager.shared.config
                try await ConfigSyncManager.shared.syncConfigToRemote(config: config)

                await MainActor.run {
                    syncResultMessage = "配置上传成功"
                    showSyncResultAlert = true
                    isSyncing = false
                }
            } catch {
                await MainActor.run {
                    syncResultMessage = "上传失败: \(error.localizedDescription)"
                    showSyncResultAlert = true
                    isSyncing = false
                }
            }
        }
    }

    /// 从远程服务器下载配置
    private func syncConfigFromRemote() {
        guard SSHConfigManager.shared.isConfigured else {
            syncResultMessage = "请先配置 SSH 服务器"
            showSyncResultAlert = true
            return
        }

        pendingSyncAction = { [self] strategy in
            syncConfigFromRemote(with: strategy)
        }

        showMergeStrategyAlert = true
    }

    private func syncConfigFromRemote(with strategy: ConfigMergeStrategy) {
        isSyncing = true
        syncResultMessage = nil

        Task {
            do {
                let config = SSHConfigManager.shared.config
                let result = try await ConfigSyncManager.shared.syncConfigFromRemote(config: config, mergeStrategy: strategy)

                await MainActor.run {
                    if result.totalApplied > 0 {
                        syncResultMessage = "成功同步 \(result.totalApplied) 项配置\n设备: \(result.deviceID ?? "未知")\n时间: \(result.exportedAt.map { formattedDate($0) } ?? "未知")"
                    } else {
                        syncResultMessage = "没有新的配置需要同步"
                    }
                    showSyncResultAlert = true
                    isSyncing = false
                }
            } catch {
                await MainActor.run {
                    syncResultMessage = "下载失败: \(error.localizedDescription)"
                    showSyncResultAlert = true
                    isSyncing = false
                }
            }
        }
    }

    /// 导出配置到本地文件
    private func exportConfig() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "notebook-config-\(Date().formatted(date: .numeric, time: .shortened)).json"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }

            do {
                let configEnvelope = ConfigSyncManager.shared.collectLocalConfig()
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                encoder.dateEncodingStrategy = .iso8601
                let data = try encoder.encode(configEnvelope)
                try data.write(to: url)

                self.syncResultMessage = "配置已导出到: \(url.path)"
                self.showSyncResultAlert = true
            } catch {
                self.syncResultMessage = "导出失败: \(error.localizedDescription)"
                self.showSyncResultAlert = true
            }
        }
    }

    /// 从本地文件导入配置
    private func importConfig() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }

            Task {
                do {
                    let data = try Data(contentsOf: url)
                    let decoder = JSONDecoder()
                    decoder.dateDecodingStrategy = .iso8601
                    let configEnvelope = try decoder.decode(ConfigSyncManager.ConfigSyncEnvelope.self, from: data)

                    await MainActor.run {
                        self.pendingSyncAction = { [self] strategy in
                            Task {
                                self.isSyncing = true
                                self.syncResultMessage = nil

                                let result = ConfigSyncManager.shared.applyRemoteConfig(configEnvelope, mergeStrategy: strategy)

                                await MainActor.run {
                                    if result.totalApplied > 0 {
                                        self.syncResultMessage = "成功导入 \(result.totalApplied) 项配置\n设备: \(result.deviceID ?? "未知")\n时间: \(result.exportedAt.map { self.formattedDate($0) } ?? "未知")"
                                    } else {
                                        self.syncResultMessage = "没有新的配置需要导入"
                                    }
                                    self.showSyncResultAlert = true
                                    self.isSyncing = false
                                }
                            }
                        }
                        self.showMergeStrategyAlert = true
                    }
                } catch {
                    await MainActor.run {
                        self.syncResultMessage = "导入失败: \(error.localizedDescription)"
                        self.showSyncResultAlert = true
                    }
                }
            }
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
