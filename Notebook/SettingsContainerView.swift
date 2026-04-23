import SwiftUI
import UniformTypeIdentifiers
import SwiftData
import AppKit

/// 设置页面 Tab 类型
enum SettingsTab: String, CaseIterable, Identifiable {
    case general = "general"
    case shortcuts = "shortcuts"
    case radialMenu = "radialMenu"
    case dataManagement = "dataManagement"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .general: return l10n(L10nKeys.Settings.tabGeneral)
        case .shortcuts: return l10n(L10nKeys.Settings.tabShortcuts)
        case .radialMenu: return "环形菜单"
        case .dataManagement: return "数据管理"
        }
    }

    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .shortcuts: return "keyboard"
        case .radialMenu: return "circle.circle"
        case .dataManagement: return "externaldrive"
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

            RadialMenuSettingsView()
                .tabItem {
                    Label(SettingsTab.radialMenu.displayName, systemImage: SettingsTab.radialMenu.icon)
                }
                .tag(SettingsTab.radialMenu)

            DataManagementView()
                .tabItem {
                    Label(SettingsTab.dataManagement.displayName, systemImage: SettingsTab.dataManagement.icon)
                }
                .tag(SettingsTab.dataManagement)
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
    @StateObject private var updateChecker = UpdateChecker.shared
    @StateObject private var gitHubTokenManager = GitHubTokenManager.shared

    @State private var isChoosingDirectory = false
    @State private var errorMessage: String?
    @State private var showRestartAlert = false
    @State private var showPasswordSheet = false
    @State private var startupBehavior = AppSettings.shared.startupBehavior
    @State private var showLogExportAlert = false
    @State private var logExportMessage = ""
    @State private var isFileLoggingEnabled = AppSettings.shared.isFileLoggingEnabled
    @State private var keepHistoricalLogFiles = AppSettings.shared.keepHistoricalLogFiles
    @State private var githubRepositoryURLString = AppSettings.shared.githubRepositoryURLString
    @State private var githubTokenInput = ""
    @State private var githubTokenStatusMessage = ""

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

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    Text("更新")
                        .font(.title2)
                        .bold()

                    Text("启动时会自动检查 GitHub Release，也可以在这里手动检查。支持 private 仓库；若仓库私有，请配置 GitHub Token。")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("当前版本: \(AppVersion.current.shortVersion) (\(AppVersion.current.buildVersion))")
                            .font(.caption)
                            .foregroundColor(.secondary)

                        Text("服务器版本: \(updateChecker.serverVersionText)")
                            .font(.caption)
                            .foregroundColor(.secondary)

                        if let latestServerInfo = updateChecker.latestServerInfo {
                            Text("检测来源: \(latestServerInfo.source == .release ? "Release" : "Tag")")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }

                        if let publishedAt = updateChecker.serverPublishedAt {
                            Text("发布时间: \(publishedAt.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }

                    TextField("GitHub 仓库地址或 owner/repo", text: $githubRepositoryURLString)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            AppSettings.shared.githubRepositoryURLString = githubRepositoryURLString
                        }

                    SecureField("GitHub Token（private 仓库需要）", text: $githubTokenInput)
                        .textFieldStyle(.roundedBorder)

                    HStack(spacing: 12) {
                        Button(gitHubTokenManager.hasToken ? "更新 Token" : "保存 Token") {
                            saveGitHubToken()
                        }

                        Button("清除 Token") {
                            clearGitHubToken()
                        }
                        .disabled(!gitHubTokenManager.hasToken && githubTokenInput.isEmpty)
                    }

                    Text(gitHubTokenManager.hasToken ? "Token 状态: 已保存到系统钥匙串" : "Token 状态: 未配置")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Text("推荐使用 Fine-grained PAT，只授权当前仓库，并开启 Repository permission: Contents = Read。")
                        .font(.caption2)
                        .foregroundColor(.secondary)

                    if !githubTokenStatusMessage.isEmpty {
                        Text(githubTokenStatusMessage)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }

                    HStack(spacing: 12) {
                        Button("保存更新源") {
                            AppSettings.shared.githubRepositoryURLString = githubRepositoryURLString
                        }

                        Button(updateChecker.isChecking ? "检查中..." : "检查更新") {
                            AppSettings.shared.githubRepositoryURLString = githubRepositoryURLString
                            Task {
                                _ = await updateChecker.checkForUpdates(silently: false)
                            }
                        }
                        .disabled(updateChecker.isChecking)

                        Button(updateChecker.isTestingToken ? "测试中..." : "测试 Token") {
                            AppSettings.shared.githubRepositoryURLString = githubRepositoryURLString
                            Task {
                                await updateChecker.testTokenAccess()
                            }
                        }
                        .disabled(updateChecker.isTestingToken)

                        if let latestRelease = updateChecker.latestRelease {
                            Button("直接下载 \(latestRelease.version)") {
                                updateChecker.openPreferredDownload(for: latestRelease)
                            }
                        }
                    }

                    Text(updateChecker.lastCheckMessage)
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Text(updateChecker.tokenTestMessage)
                        .font(.caption2)
                        .foregroundColor(.secondary)

                    if let lastCheckedAt = updateChecker.lastCheckedAt {
                        Text("上次检查: \(lastCheckedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }

                Divider()

                // 日志导出
                VStack(alignment: .leading, spacing: 12) {
                    Text("日志")
                        .font(.title2)
                        .bold()

                    Text("可将运行日志自动保存到文件，用于临时抓取问题；关闭历史保留时只保留当天日志。")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Toggle("自动保存日志到文件", isOn: $isFileLoggingEnabled)
                        .onChange(of: isFileLoggingEnabled) { _, newValue in
                            AppSettings.shared.isFileLoggingEnabled = newValue
                        }

                    Toggle("保留历史日志（按天）", isOn: $keepHistoricalLogFiles)
                        .disabled(!isFileLoggingEnabled)
                        .onChange(of: keepHistoricalLogFiles) { _, newValue in
                            AppSettings.shared.keepHistoricalLogFiles = newValue
                        }

                    Text(isFileLoggingEnabled
                         ? "日志目录: \(Logger.logsDirectoryPath)"
                         : "开启后将自动写入: \(Logger.logsDirectoryPath)")
                        .font(.system(size: 12, weight: .regular, design: .monospaced))
                        .foregroundColor(.secondary)
                        .textSelection(.enabled)

                    HStack(spacing: 12) {
                        Button("打开日志目录") {
                            do {
                                try Logger.ensureLogsDirectoryExists()
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: Logger.logsDirectoryPath)])
                            } catch {
                                logExportMessage = "打开日志目录失败: \(error.localizedDescription)"
                                showLogExportAlert = true
                            }
                        }

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

                // 关于/帮助信息
                VStack(alignment: .leading, spacing: 12) {
                    Text(l10n(L10nKeys.About.title))
                        .font(.title2)
                        .bold()

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(l10n(L10nKeys.About.appName))
                                .foregroundColor(.secondary)
                            Text("Notebook")
                        }

                        HStack {
                            Text(l10n(L10nKeys.About.author))
                                .foregroundColor(.secondary)
                            Text("Yanyan")
                        }

                        HStack {
                            Text(l10n(L10nKeys.About.email))
                                .foregroundColor(.secondary)
                            Text("thunder951413@gmail.com")
                                .textSelection(.enabled)
                        }

                        HStack {
                            Text(l10n(L10nKeys.About.projectHelp))
                                .foregroundColor(.secondary)
                            Button(l10n(L10nKeys.About.viewOnGitHub)) {
                                if let url = AppSettings.shared.githubRepositoryURL {
                                    NSWorkspace.shared.open(url)
                                }
                            }
                            .buttonStyle(.link)
                        }
                    }
                    .font(.body)
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
        .alert("日志导出", isPresented: $showLogExportAlert) {
            Button("确定", role: .cancel) {}
        } message: {
            Text(logExportMessage)
        }
        .sheet(isPresented: $showPasswordSheet) {
            PasswordSettingsView()
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

    private func saveGitHubToken() {
        let trimmed = githubTokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            githubTokenStatusMessage = "请输入 GitHub Token 后再保存。"
            return
        }

        if gitHubTokenManager.saveToken(trimmed) {
            githubTokenInput = ""
            githubTokenStatusMessage = "GitHub Token 已保存到系统钥匙串。"
        } else {
            githubTokenStatusMessage = "GitHub Token 保存失败，请检查系统钥匙串权限。"
        }
    }

    private func clearGitHubToken() {
        if gitHubTokenManager.deleteToken() {
            githubTokenInput = ""
            githubTokenStatusMessage = "已清除 GitHub Token。"
        } else {
            githubTokenStatusMessage = "清除 GitHub Token 失败，请稍后再试。"
        }
    }

    /// 选择目录
    private func chooseDirectory() {
        isChoosingDirectory = true
        errorMessage = nil

        Task {
            do {
                try await storage.promptUserToChooseBaseDirectory()
                try persistence.configureIfPossible()
                // 配置完成后，更新 NoteStore 的 context
                if let container = persistence.modelContainer {
                    let newContext = ModelContext(container)
                    store.setContext(newContext)
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isChoosingDirectory = false
        }
    }

    /// 导出日志
    private func exportLogs(module: LogModule?) {
        let savePanel = NSSavePanel()
        let suffix = module?.rawValue ?? "all"
        savePanel.nameFieldStringValue = "Notebook-Logs-\(suffix).log"
        savePanel.allowedContentTypes = [UTType.plainText]

        if savePanel.runModal() == .OK, let url = savePanel.url {
            let content = module == nil
                ? Logger.shared.exportLogsGroupedByModule()
                : Logger.shared.exportLogs(module: module)
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
                logExportMessage = "日志已导出到: \(url.path)"
            } catch {
                logExportMessage = "日志导出失败: \(error.localizedDescription)"
            }
            showLogExportAlert = true
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

// MARK: - 数据管理视图
struct DataManagementView: View {
    @EnvironmentObject private var persistence: PersistenceController
    @EnvironmentObject private var store: NoteStore
    @State private var errorMessage: String?
    @State private var showSSHSettingsSheet = false
    @State private var isSyncing = false
    @State private var syncResult: SyncResult?
    @State private var syncProgress: SSHSyncProgress?
    @State private var conflictResults: [NoteSyncMergeResult]?
    @State private var showMigrationPreviewSheet = false
    @State private var showPersistedBlockBrowserSheet = false
    @State private var showVersionManagerSheet = false
    @State private var migrationPreviewLibrary: ImportedDocumentLibrary?
    @State private var migrationPreviewPackage: LoadedDocumentMigrationPackage?

    enum SyncResult {
        case success(String)
        case failure(String)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // 标题
                Text("数据管理")
                    .font(.title2)
                    .bold()

                // SSH 同步配置
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Image(systemName: "network")
                            .font(.title3)
                            .foregroundColor(.orange)
                        Text("SSH 同步")
                            .font(.headline)
                    }

                    if SSHConfigManager.shared.isConfigured {
                        let config = SSHConfigManager.shared.config
                        Text("已配置: \(config.username)@\(config.host):\(config.repositoryPath)")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    } else {
                        Text("配置 SSH 服务器，将笔记数据同步到 NAS 或其他远程服务器。支持笔记、附件、文件夹和标签的完整多端同步。")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    HStack(spacing: 12) {
                        Button {
                            showSSHSettingsSheet = true
                        } label: {
                            Text(SSHConfigManager.shared.isConfigured ? "修改配置" : "配置服务器")
                        }

                        if SSHConfigManager.shared.isConfigured {
                            Button {
                                performPushSync()
                            } label: {
                                if isSyncing && syncProgress?.phase == .pushNotes {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                        .frame(width: 60)
                                } else {
                                    Text("推送同步")
                                }
                            }
                            .disabled(isSyncing)

                            Button("拉取同步") {
                                performPullSync()
                            }
                            .disabled(isSyncing)

                            Button("双向同步") {
                                performBidirectionalSync()
                            }
                            .disabled(isSyncing)
                        }
                    }

                    // 同步进度
                    if isSyncing, let progress = syncProgress {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(progress.phase.rawValue)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            ProgressView(value: progress.fraction)
                            Text(progress.message)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)
                    }

                    // 同步结果显示
                    if let result = syncResult {
                        HStack {
                            Image(systemName: result.isSuccess ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(result.isSuccess ? .green : .red)
                            Text(result.message)
                                .foregroundStyle(result.isSuccess ? .green : .red)
                                .font(.caption)
                        }
                        .padding(.top, 4)
                    }

                    // 冲突展示
                    if let conflicts = conflictResults, !conflicts.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.orange)
                                Text("检测到 \(conflicts.count) 条冲突笔记")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                            ForEach(conflicts, id: \.noteID) { conflict in
                                HStack {
                                    Text(conflict.noteID.uuidString.prefix(8) + "...")
                                        .font(.system(.caption, design: .monospaced))
                                    Text("本地 v\(conflict.localVersion) vs 远程 v\(conflict.remoteVersion)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Text("冲突笔记已自动创建本地副本（标题含 [冲突副本]），原笔记已应用远程版本。")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Image(systemName: "clock.badge")
                            .font(.title3)
                            .foregroundColor(.teal)
                        Text("版本历史")
                            .font(.headline)
                    }

                    Text("按笔记查看版本、比较差异并回退到指定版本。")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Button("打开版本管理") {
                        showVersionManagerSheet = true
                    }
                }

                Divider()

                // 数据导出
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Image(systemName: "square.and.arrow.up")
                            .font(.title3)
                            .foregroundColor(.blue)
                        Text("数据导出")
                            .font(.headline)
                    }

                    Text("导出配置、笔记、文件夹、标签和所有数据到 zip 文件，方便备份或迁移到其他设备。")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    VStack(alignment: .leading, spacing: 8) {
                        Button("导出配置") {
                            exportConfiguration()
                        }
                        .help("导出应用设置、快捷键和环形菜单配置")

                        Button("导出所有笔记") {
                            exportAllNotes()
                        }
                        .help("导出所有笔记、文件夹和标签（不包含附件）")

                        Button("预览笔记包") {
                            previewDocumentMigrationPackage()
                        }
                        .help("读取笔记导出包，并用块级只读视图验证显示效果")

                        Button("浏览当前文档库") {
                            browsePersistedBlockDocumentLibrary()
                        }
                        .help("浏览当前已写入 SwiftData 的块级文档数据")

                        Button("导出所有数据") {
                            exportAllData()
                        }
                        .help("导出所有数据，包括配置、笔记、文件夹、标签和附件")
                    }
                }

                Divider()

                // 数据导入
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Image(systemName: "square.and.arrow.down")
                            .font(.title3)
                            .foregroundColor(.green)
                        Text("数据导入")
                            .font(.headline)
                    }

                    Text("从 zip 文件导入配置、笔记或所有数据。导入前建议先导出当前数据作为备份。")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    VStack(alignment: .leading, spacing: 8) {
                        Button("导入配置") {
                            importConfiguration()
                        }
                        .help("导入应用设置、快捷键和环形菜单配置")

                        Button("导入笔记") {
                            importNotes()
                        }
                        .help("导入块级文档笔记包，并重建当前文档库")

                        Button("导入所有数据") {
                            importAllData()
                        }
                        .help("导入所有数据，包括配置、笔记、文件夹、标签和附件")
                    }
                }

                Divider()

                // 数据重置
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.title3)
                            .foregroundColor(.red)
                        Text("数据重置")
                            .font(.headline)
                            .foregroundColor(.red)
                    }

                    Text("⚠️ 危险操作：这将永久删除所有笔记、文件夹、标签、附件和配置，恢复到初始状态。此操作不可撤销！")
                        .font(.caption)
                        .foregroundColor(.red)

                    Button("重置所有数据") {
                        showResetConfirmation()
                    }
                    .foregroundColor(.red)
                    .help("删除所有数据，恢复到初始状态")
                }

                if let errorMessage {
                    Text(errorMessage)
                        .foregroundColor(.red)
                        .font(.footnote)
                        .padding(.top, 8)
                }

                Spacer()
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: $showSSHSettingsSheet) {
            SSHSettingsView()
        }
        .sheet(isPresented: $showMigrationPreviewSheet, onDismiss: cleanupMigrationPreviewPackage) {
            if let migrationPreviewLibrary {
                DocumentMigrationPreviewView(library: migrationPreviewLibrary)
            } else {
                ProgressView("正在加载笔记包预览")
                    .frame(width: 480, height: 320)
            }
        }
        .sheet(isPresented: $showPersistedBlockBrowserSheet) {
            if let container = persistence.modelContainer {
                PersistentBlockDocumentLibraryBrowserView()
                    .modelContainer(container)
            } else {
                ContentUnavailableView("数据容器未配置", systemImage: "externaldrive.badge.xmark")
                    .frame(width: 520, height: 360)
            }
        }
        .sheet(isPresented: $showVersionManagerSheet) {
            if let container = persistence.modelContainer {
                NoteVersionManagerView()
                    .modelContainer(container)
            } else {
                ContentUnavailableView("数据容器未配置", systemImage: "externaldrive.badge.xmark")
                    .frame(width: 680, height: 460)
            }
        }
    }

    // MARK: - 导出方法

    private func exportConfiguration() {
        Task {
            do {
                let zipURL = try await DataExportManager.shared.exportConfiguration()

                let savePanel = NSSavePanel()
                savePanel.nameFieldStringValue = zipURL.lastPathComponent
                savePanel.allowedContentTypes = [.zip]

                if savePanel.runModal() == .OK, let destinationURL = savePanel.url {
                    try FileManager.default.moveItem(at: zipURL, to: destinationURL)
                    NSWorkspace.shared.activateFileViewerSelecting([destinationURL])
                } else {
                    try? FileManager.default.removeItem(at: zipURL)
                }
            } catch {
                errorMessage = "导出配置失败: \(error.localizedDescription)"
            }
        }
    }

    private func exportAllNotes() {
        Task {
            do {
                guard let container = persistence.modelContainer else {
                    errorMessage = "数据容器未配置"
                    return
                }
                let context = container.mainContext
                let zipURL = try await DataExportManager.shared.exportAllNotesOnly(context: context)

                let savePanel = NSSavePanel()
                savePanel.nameFieldStringValue = zipURL.lastPathComponent
                savePanel.allowedContentTypes = [.zip]

                if savePanel.runModal() == .OK, let destinationURL = savePanel.url {
                    try FileManager.default.moveItem(at: zipURL, to: destinationURL)
                    NSWorkspace.shared.activateFileViewerSelecting([destinationURL])
                } else {
                    try? FileManager.default.removeItem(at: zipURL)
                }
            } catch {
                errorMessage = "导出笔记失败: \(error.localizedDescription)"
            }
        }
    }

    private func exportAllData() {
        Task {
            do {
                guard let container = persistence.modelContainer else {
                    errorMessage = "数据容器未配置"
                    return
                }
                let context = container.mainContext
                let zipURL = try await DataExportManager.shared.exportAllData(context: context)

                let savePanel = NSSavePanel()
                savePanel.nameFieldStringValue = zipURL.lastPathComponent
                savePanel.allowedContentTypes = [.zip]

                if savePanel.runModal() == .OK, let destinationURL = savePanel.url {
                    try FileManager.default.moveItem(at: zipURL, to: destinationURL)
                    NSWorkspace.shared.activateFileViewerSelecting([destinationURL])
                } else {
                    try? FileManager.default.removeItem(at: zipURL)
                }
            } catch {
                errorMessage = "导出数据失败: \(error.localizedDescription)"
            }
        }
    }

    private func previewDocumentMigrationPackage() {
        Task {
            do {
                let openPanel = NSOpenPanel()
                openPanel.allowedContentTypes = [.zip]
                openPanel.allowsMultipleSelection = false
                openPanel.canChooseDirectories = false
                openPanel.canChooseFiles = true
                openPanel.message = "选择要预览的笔记包"

                guard openPanel.runModal() == .OK, let zipURL = openPanel.url else {
                    return
                }

                cleanupMigrationPreviewPackage()

                let handler = InMemoryDocumentMigrationImportHandler()
                let importer = DocumentMigrationPackageImporter()
                let package = try importer.importArchive(from: zipURL, using: handler)

                guard let library = handler.library else {
                    package.cleanup()
                    errorMessage = "笔记包预览失败: 未生成预览数据"
                    return
                }

                migrationPreviewPackage = package
                migrationPreviewLibrary = library
                showMigrationPreviewSheet = true
            } catch {
                cleanupMigrationPreviewPackage()
                errorMessage = "预览笔记包失败: \(error.localizedDescription)"
            }
        }
    }

    private func browsePersistedBlockDocumentLibrary() {
        guard persistence.modelContainer != nil else {
            errorMessage = "数据容器未配置"
            return
        }
        showPersistedBlockBrowserSheet = true
    }

    private func cleanupMigrationPreviewPackage() {
        migrationPreviewPackage?.cleanup()
        migrationPreviewPackage = nil
        migrationPreviewLibrary = nil
    }

    // MARK: - 导入方法

    private func showImportConfirmation(message: String, confirmAction: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "确认导入"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "导入")
        alert.addButton(withTitle: "取消")

        if alert.runModal() == .alertFirstButtonReturn {
            confirmAction()
        }
    }

    private func importConfiguration() {
        showImportConfirmation(message: "导入配置将覆盖当前的快捷键、环形菜单等设置。\n建议在导入前先导出当前配置作为备份。\n\n是否继续导入？") {
            Task {
                await self.performImportConfiguration()
            }
        }
    }

    private func performImportConfiguration() async {
        do {
            let openPanel = NSOpenPanel()
            openPanel.allowedContentTypes = [.zip]
            openPanel.allowsMultipleSelection = false
            openPanel.canChooseDirectories = false
            openPanel.canChooseFiles = true
            openPanel.message = "选择要导入的配置文件"

            guard openPanel.runModal() == .OK, let zipURL = openPanel.url else {
                return
            }

            try await DataExportManager.shared.importConfiguration(from: zipURL)

            await MainActor.run {
                errorMessage = "配置导入成功，请重启应用以应用更改"
            }
        } catch {
            await MainActor.run {
                errorMessage = "导入配置失败: \(error.localizedDescription)"
            }
        }
    }

    private func importNotes() {
        showImportConfirmation(message: "导入笔记会清空当前块级文档库，并用所选笔记包重新写入全部笔记、文件夹和标签。\n建议在导入前先导出当前数据作为备份。\n\n是否继续导入？") {
            Task {
                await self.performImportNotes()
            }
        }
    }

    private func performImportNotes() async {
        do {
            guard let container = persistence.modelContainer else {
                await MainActor.run {
                    errorMessage = "数据容器未配置"
                }
                return
            }

            let openPanel = NSOpenPanel()
            openPanel.allowedContentTypes = [.zip]
            openPanel.allowsMultipleSelection = false
            openPanel.canChooseDirectories = false
            openPanel.canChooseFiles = true
            openPanel.message = "选择要导入的笔记包"

            guard openPanel.runModal() == .OK, let zipURL = openPanel.url else {
                return
            }

            let context = container.mainContext
            try await DataExportManager.shared.importNotes(from: zipURL, context: context)

            await MainActor.run {
                errorMessage = "笔记包导入成功，当前文档库已更新"
                showPersistedBlockBrowserSheet = true
            }
        } catch {
            await MainActor.run {
                errorMessage = "导入笔记包失败: \(error.localizedDescription)"
            }
        }
    }

    private func importAllData() {
        showImportConfirmation(message: "导入所有数据将覆盖当前的配置、笔记、文件夹、标签和附件。\n⚠️ 此操作不可撤销！\n\n强烈建议先导出当前数据作为备份。\n\n是否继续导入？") {
            Task {
                await self.performImportAllData()
            }
        }
    }

    private func performImportAllData() async {
        do {
            guard let container = persistence.modelContainer else {
                await MainActor.run {
                    errorMessage = "数据容器未配置"
                }
                return
            }

            let openPanel = NSOpenPanel()
            openPanel.allowedContentTypes = [.zip]
            openPanel.allowsMultipleSelection = false
            openPanel.canChooseDirectories = false
            openPanel.canChooseFiles = true
            openPanel.message = "选择要导入的数据文件"

            guard openPanel.runModal() == .OK, let zipURL = openPanel.url else {
                return
            }

            let context = container.mainContext
            try await DataExportManager.shared.importAllData(from: zipURL, context: context)

            await MainActor.run {
                errorMessage = "数据导入成功，请重启应用以应用所有更改"
            }
        } catch {
            await MainActor.run {
                errorMessage = "导入数据失败: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - 重置功能

    private func showResetConfirmation() {
        let alert = NSAlert()
        alert.messageText = "⚠️ 确认重置所有数据"
        alert.informativeText = "此操作将永久删除以下内容：\n\n• 所有笔记\n• 所有文件夹\n• 所有标签\n• 所有附件\n• 所有配置（快捷键、环形菜单等）\n\n此操作不可撤销！\n\n强烈建议先导出所有数据作为备份。\n\n确定要继续吗？"
        alert.alertStyle = .critical
        alert.addButton(withTitle: "重置")
        alert.addButton(withTitle: "取消")

        if let resetButton = alert.buttons.first {
            resetButton.hasDestructiveAction = true
        }

        if alert.runModal() == .alertFirstButtonReturn {
            Task {
                await performReset()
            }
        }
    }

    private func performReset() async {
        do {
            guard let container = persistence.modelContainer else {
                await MainActor.run {
                    errorMessage = "数据容器未配置"
                }
                return
            }

            let context = container.mainContext
            try await DataExportManager.shared.resetAllData(context: context)

            await MainActor.run {
                errorMessage = "重置成功，应用将退出。请重新启动应用。"

                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    NSApp.terminate(nil)
                }
            }
        } catch {
            await MainActor.run {
                errorMessage = "重置失败: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - SSH 同步

    private func performPushSync() {
        runSync { [self] in
            let config = SSHConfigManager.shared.config
            guard let container = self.persistence.modelContainer else {
                throw NSError(domain: "SSHSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "数据容器未配置"])
            }
            let progressHandler: SSHSyncProgressHandler = { progress in
                await MainActor.run {
                    self.syncProgress = progress
                }
            }
            await MainActor.run {
                self.syncProgress = SSHSyncProgress(phase: .pushNotes, current: 0, total: 1, message: "正在推送笔记...")
            }
            let syncedNoteIDs = try await SSHSyncManager.shared.syncAllNotesToRemote(
                context: container.mainContext,
                config: config,
                progressHandler: progressHandler
            )
            await MainActor.run {
                AutoSyncCoordinator.shared.markLocalChangesPushed()
            }
            return "推送完成，更新 \(syncedNoteIDs.count) 条笔记（含附件和文件夹/标签）"
        }
    }

    private func performPullSync() {
        runSync { [self] in
            let config = SSHConfigManager.shared.config
            guard let container = self.persistence.modelContainer else {
                throw NSError(domain: "SSHSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "数据容器未配置"])
            }
            let progressHandler: SSHSyncProgressHandler = { progress in
                await MainActor.run {
                    self.syncProgress = progress
                }
            }
            await MainActor.run {
                self.syncProgress = SSHSyncProgress(phase: .pullNotes, current: 0, total: 1, message: "正在拉取笔记...")
            }
            let results = try await SSHSyncManager.shared.syncAllNotesFromRemote(
                context: container.mainContext,
                config: config,
                progressHandler: progressHandler
            )
            let conflicts = results.filter(\.detectedConflict)
            await MainActor.run {
                if !conflicts.isEmpty {
                    self.conflictResults = conflicts
                }
            }
            return "拉取完成，共处理 \(results.count) 条笔记（含附件和文件夹/标签），冲突 \(conflicts.count) 条"
        }
    }

    private func performBidirectionalSync() {
        runSync { [self] in
            let config = SSHConfigManager.shared.config
            guard let container = self.persistence.modelContainer else {
                throw NSError(domain: "SSHSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "数据容器未配置"])
            }
            let progressHandler: SSHSyncProgressHandler = { progress in
                await MainActor.run {
                    self.syncProgress = progress
                }
            }
            await MainActor.run {
                self.syncProgress = SSHSyncProgress(phase: .pullNotes, current: 0, total: 1, message: "正在拉取...")
            }
            let pullResults = try await SSHSyncManager.shared.syncAllNotesFromRemote(
                context: container.mainContext,
                config: config,
                progressHandler: progressHandler
            )
            await MainActor.run {
                self.syncProgress = SSHSyncProgress(phase: .pushNotes, current: 0, total: 1, message: "正在推送...")
            }
            let pushIDs = try await SSHSyncManager.shared.syncAllNotesToRemote(
                context: container.mainContext,
                config: config,
                progressHandler: progressHandler
            )
            await MainActor.run {
                AutoSyncCoordinator.shared.markLocalChangesPushed()
            }
            let conflicts = pullResults.filter(\.detectedConflict)
            await MainActor.run {
                if !conflicts.isEmpty {
                    self.conflictResults = conflicts
                }
            }
            return "双向完成，拉取 \(pullResults.count) 条，推送 \(pushIDs.count) 条（含附件和文件夹/标签），冲突 \(conflicts.count) 条"
        }
    }

    private func runSync(operation: @escaping () async throws -> String) {
        guard !isSyncing else { return }

        isSyncing = true
        syncResult = nil
        conflictResults = nil
        syncProgress = nil
        AutoSyncCoordinator.shared.beginManualSync()

        Task { @MainActor [self] in
            defer {
                AutoSyncCoordinator.shared.endManualSync()
            }

            do {
                let message = try await operation()

                // 同步完成后刷新 NoteStore，让 UI 立即反映最新数据
                self.store.fetchData()

                self.syncResult = .success(message)
                self.isSyncing = false
                self.syncProgress = nil

                DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                    self.syncResult = nil
                    self.conflictResults = nil
                }
            } catch {
                self.syncResult = .failure("同步失败: \(error.localizedDescription)")
                self.isSyncing = false
                self.syncProgress = nil
            }
        }
    }
}

private struct NoteVersionManagerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var notes: [BlockDocumentNoteEntity] = []
    @State private var selectedNoteID: UUID?
    @State private var history: [BlockDocumentNoteVersionEntity] = []
    @State private var baseVersion: Int64?
    @State private var targetVersion: Int64?
    @State private var comparison: NoteVersionComparison?
    @State private var resultMessage: String?

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("版本管理")
                    .font(.title2)
                    .bold()
                Spacer()
                Button("关闭") {
                    dismiss()
                }
            }

            HStack(alignment: .top, spacing: 16) {
                List(selection: $selectedNoteID) {
                    ForEach(notes, id: \.id) { note in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(note.title.isEmpty ? "无标题" : note.title)
                                .lineLimit(1)
                            Text("v\(note.version)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .tag(note.id)
                    }
                }
                .frame(minWidth: 220)

                VStack(alignment: .leading, spacing: 12) {
                    Text("历史版本")
                        .font(.headline)

                    if history.isEmpty {
                        ContentUnavailableView("没有历史版本", systemImage: "clock.badge.xmark")
                    } else {
                        Picker("基线版本", selection: $baseVersion) {
                            Text("未选择").tag(Optional<Int64>.none)
                            ForEach(history, id: \.id) { entry in
                                Text("v\(entry.version) · \(entry.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                                    .tag(Optional(entry.version))
                            }
                        }

                        Picker("目标版本", selection: $targetVersion) {
                            Text("未选择").tag(Optional<Int64>.none)
                            ForEach(history, id: \.id) { entry in
                                Text("v\(entry.version) · \(entry.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                                    .tag(Optional(entry.version))
                            }
                        }

                        HStack {
                            Button("比较版本") {
                                compareSelectedVersions()
                            }
                            .disabled(selectedNoteID == nil || baseVersion == nil || targetVersion == nil)

                            Button("回退到目标版本") {
                                restoreTargetVersion()
                            }
                            .disabled(selectedNoteID == nil || targetVersion == nil)
                        }
                    }

                    if let comparison {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("比较结果")
                                .font(.headline)
                            Text("标题变化: \(comparison.titleChanged ? "是" : "否")")
                            Text("元数据变化: \(comparison.metadataChanged ? "是" : "否")")
                            Text("块数量变化: \(comparison.blockCountDelta)")
                            Text("资源数量变化: \(comparison.assetCountDelta)")
                            Text("修改块: \(comparison.changedBlockIDs.count)")
                            Text("资源变化: +\(comparison.addedAssetIDs.count) / -\(comparison.removedAssetIDs.count)")
                        }
                        .font(.caption)
                    }

                    if let resultMessage {
                        Text(resultMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Spacer()
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .padding(20)
        .frame(minWidth: 860, minHeight: 520)
        .onAppear(perform: reloadNotes)
        .onChange(of: selectedNoteID) {
            reloadHistory()
        }
    }

    private func reloadNotes() {
        do {
            notes = try modelContext.fetch(
                FetchDescriptor<BlockDocumentNoteEntity>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)])
            )
            if selectedNoteID == nil {
                selectedNoteID = notes.first?.id
            }
            reloadHistory()
        } catch {
            resultMessage = "加载笔记失败: \(error.localizedDescription)"
        }
    }

    private func reloadHistory() {
        comparison = nil
        guard let selectedNoteID else {
            history = []
            return
        }
        do {
            history = try BlockDocumentNoteVersionStore.history(for: selectedNoteID, context: modelContext)
            baseVersion = history.first?.version
            targetVersion = history.last?.version
        } catch {
            history = []
            resultMessage = "加载历史失败: \(error.localizedDescription)"
        }
    }

    private func compareSelectedVersions() {
        guard let selectedNoteID, let baseVersion, let targetVersion else { return }
        do {
            comparison = try BlockDocumentNoteVersionStore.compare(
                noteID: selectedNoteID,
                from: baseVersion,
                to: targetVersion,
                context: modelContext
            )
            resultMessage = comparison == nil ? "未找到可比较版本" : "版本对比完成"
        } catch {
            resultMessage = "版本对比失败: \(error.localizedDescription)"
        }
    }

    private func restoreTargetVersion() {
        guard let selectedNoteID, let targetVersion else { return }
        do {
            let restoredVersion = try BlockDocumentNoteVersionStore.restore(
                noteID: selectedNoteID,
                toVersion: targetVersion,
                context: modelContext
            )
            resultMessage = "回退完成，当前版本 v\(restoredVersion)"
            reloadNotes()
        } catch {
            resultMessage = "回退失败: \(error.localizedDescription)"
        }
    }
}

private struct DocumentMigrationPreviewView: View {
    let title: String
    let library: ImportedDocumentLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var selectedNoteID: UUID?

    init(title: String = "笔记包只读预览", library: ImportedDocumentLibrary) {
        self.title = title
        self.library = library
        _selectedNoteID = State(initialValue: library.notes.first?.id)
    }

    private var selectedNote: ImportedDocumentNote? {
        if let selectedNoteID {
            return library.notes.first { $0.id == selectedNoteID } ?? library.notes.first
        }
        return library.notes.first
    }

    var body: some View {
        VStack(spacing: 0) {
            headerView
            Divider()
            HSplitView {
                sidebarView
                    .frame(minWidth: 240, idealWidth: 280, maxWidth: 320)
                detailView
                    .frame(minWidth: 500)
            }
            Divider()
            HStack {
                Text("已加载 \(library.notes.count) 条笔记")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("关闭") {
                    dismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
            .padding(16)
        }
        .frame(minWidth: 980, minHeight: 680)
    }

    private var headerView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.title2)
                .bold()

            HStack(spacing: 16) {
                Label("\(library.notes.count) 条笔记", systemImage: "note.text")
                Label("\(library.folders.count) 个文件夹", systemImage: "folder")
                Label("\(library.tags.count) 个标签", systemImage: "tag")
                Text("导出时间 \(library.sourceExportedAt.formatted(date: .abbreviated, time: .shortened))")
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
    }

    private var sidebarView: some View {
        List(selection: $selectedNoteID) {
            ForEach(library.notes, id: \.id) { note in
                VStack(alignment: .leading, spacing: 4) {
                    Text(note.title.isEmpty ? "无标题" : note.title)
                        .font(.headline)
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        Text(note.folderName)
                        Text("\(note.document.blocks.count) 块")
                        if !note.assets.isEmpty {
                            Text("\(note.assets.count) 资源")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                .tag(note.id)
            }
        }
        .listStyle(.sidebar)
    }

    private var detailView: some View {
        Group {
            if let selectedNote {
                MigrationPreviewNoteDetailView(note: selectedNote)
            } else {
                ContentUnavailableView("没有可预览的笔记", systemImage: "doc.text.magnifyingglass")
            }
        }
    }
}

private struct PersistentBlockDocumentLibraryBrowserView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @State private var library: ImportedDocumentLibrary?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let library {
                DocumentMigrationPreviewView(title: "块级文档库浏览", library: library)
            } else if let errorMessage {
                VStack(spacing: 16) {
                    ContentUnavailableView("无法加载块级文档库", systemImage: "doc.text.magnifyingglass", description: Text(errorMessage))
                    Button("关闭") {
                        dismiss()
                    }
                }
                .frame(width: 560, height: 420)
            } else {
                ProgressView("正在加载块级文档库")
                    .frame(width: 560, height: 420)
                    .task {
                        await loadLibrary()
                    }
            }
        }
    }

    @MainActor
    private func loadLibrary() async {
        do {
            library = try PersistedBlockDocumentLibraryLoader.load(from: modelContext)
            if library == nil {
                errorMessage = "当前还没有导入到 SwiftData 的块级文档数据。"
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct MigrationPreviewNoteDetailView: View {
    let note: ImportedDocumentNote

    private var assetByID: [String: ImportedDocumentAsset] {
        Dictionary(uniqueKeysWithValues: note.assets.map { ($0.reference.id, $0) })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(note.title.isEmpty ? "无标题" : note.title)
                        .font(.largeTitle)
                        .bold()

                    HStack(spacing: 12) {
                        Label(note.folderName, systemImage: "folder")
                        if !note.tagIDs.isEmpty {
                            Label("\(note.tagIDs.count) 个标签", systemImage: "tag")
                        }
                        if let reminderAt = note.reminderAt {
                            Label(reminderAt.formatted(date: .abbreviated, time: .shortened), systemImage: "bell")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Divider()

                ForEach(note.document.blocks, id: \.id) { block in
                    MigrationPreviewBlockView(
                        block: block,
                        asset: block.asset.flatMap { assetByID[$0.id] }
                    )
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(NSColor.textBackgroundColor))
    }
}

private struct MigrationPreviewBlockView: View {
    let block: ImportedDocumentBlock
    let asset: ImportedDocumentAsset?

    var body: some View {
        switch block.kind {
        case .heading:
            MigrationPreviewInlineTextView(spans: block.text)
                .font(headingFont)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .listItem:
            HStack(alignment: .top, spacing: 10) {
                Text(listMarker)
                    .foregroundStyle(.secondary)
                MigrationPreviewInlineTextView(spans: block.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .todoItem:
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: block.checked == true ? "checkmark.square.fill" : "square")
                    .foregroundStyle(block.checked == true ? .green : .secondary)
                MigrationPreviewInlineTextView(spans: block.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .image:
            MigrationPreviewImageBlockView(block: block, asset: asset)

        case .audio:
            MigrationPreviewAudioBlockView(block: block, asset: asset)

        case .table:
            if let table = block.table {
                MigrationPreviewTableBlockView(table: table)
            }

        case .paragraph, .unsupported:
            MigrationPreviewInlineTextView(spans: block.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var headingFont: Font {
        switch block.level ?? 3 {
        case 1:
            return .system(size: 28, weight: .bold)
        case 2:
            return .system(size: 22, weight: .semibold)
        default:
            return .system(size: 18, weight: .semibold)
        }
    }

    private var listMarker: String {
        switch block.listStyle {
        case .ordered:
            return "\(block.order ?? 1)."
        case .dash:
            return "-"
        default:
            return "•"
        }
    }
}

private struct MigrationPreviewInlineTextView: View {
    let spans: [ImportedInlineText]

    var body: some View {
        if spans.isEmpty {
            Text(" ")
        } else {
            styledText
                .textSelection(.enabled)
        }
    }

    private var styledText: Text {
        spans.reduce(Text("")) { partial, span in
            partial + styledText(for: span)
        }
    }

    private func styledText(for span: ImportedInlineText) -> Text {
        var text = Text(verbatim: span.text)
        if span.bold {
            text = text.bold()
        }
        if span.italic {
            text = text.italic()
        }
        if span.underline {
            text = text.underline()
        }
        if span.strikethrough {
            text = text.strikethrough()
        }
        if let color = nsColor(from: span.textColor) {
            text = text.foregroundColor(Color(nsColor: color))
        }
        return text
    }

    private func nsColor(from hex: String?) -> NSColor? {
        guard let hex else { return nil }
        let raw = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard raw.count == 6 || raw.count == 8 else { return nil }

        var value: UInt64 = 0
        guard Scanner(string: raw).scanHexInt64(&value) else { return nil }

        if raw.count == 6 {
            return NSColor(
                red: CGFloat((value & 0xFF0000) >> 16) / 255,
                green: CGFloat((value & 0x00FF00) >> 8) / 255,
                blue: CGFloat(value & 0x0000FF) / 255,
                alpha: 1
            )
        }

        return NSColor(
            red: CGFloat((value & 0xFF000000) >> 24) / 255,
            green: CGFloat((value & 0x00FF0000) >> 16) / 255,
            blue: CGFloat((value & 0x0000FF00) >> 8) / 255,
            alpha: CGFloat(value & 0x000000FF) / 255
        )
    }
}

private struct MigrationPreviewImageBlockView: View {
    let block: ImportedDocumentBlock
    let asset: ImportedDocumentAsset?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let sourceURL = asset?.sourceURL,
               let image = NSImage(contentsOf: sourceURL) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 680, maxHeight: 360, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                placeholder("图片资源缺失")
            }

            if let asset {
                HStack(spacing: 12) {
                    Text(asset.reference.filename)
                    if let width = asset.reference.width, let height = asset.reference.height {
                        Text("\(Int(width)) × \(Int(height))")
                    }
                    Button("在访达中显示") {
                        NSWorkspace.shared.activateFileViewerSelecting([asset.sourceURL])
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    private func placeholder(_ text: String) -> some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color.secondary.opacity(0.08))
            .frame(maxWidth: 680, minHeight: 120, maxHeight: 180)
            .overlay {
                Label(text, systemImage: "photo")
                    .foregroundStyle(.secondary)
            }
    }
}

private struct MigrationPreviewAudioBlockView: View {
    let block: ImportedDocumentBlock
    let asset: ImportedDocumentAsset?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "waveform")
                .font(.title2)
                .foregroundStyle(.blue)

            VStack(alignment: .leading, spacing: 4) {
                Text(asset?.reference.filename ?? block.asset?.filename ?? "音频")
                    .font(.headline)

                HStack(spacing: 12) {
                    if let duration = asset?.reference.duration ?? block.asset?.duration {
                        Text(durationLabel(duration))
                    }
                    Text(asset?.reference.mimeType ?? block.asset?.mimeType ?? "audio")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            if let asset {
                Button("在访达中显示") {
                    NSWorkspace.shared.activateFileViewerSelecting([asset.sourceURL])
                }
            }
        }
        .padding(14)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func durationLabel(_ duration: Double) -> String {
        let totalSeconds = max(0, Int(duration.rounded()))
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }
}

private struct MigrationPreviewTableBlockView: View {
    let table: ImportedDocumentTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(spacing: 0) {
                ForEach(table.rows.indices, id: \.self) { rowIndex in
                    HStack(spacing: 0) {
                        ForEach(table.rows[rowIndex].indices, id: \.self) { columnIndex in
                            Text(table.rows[rowIndex][columnIndex])
                                .frame(
                                    minWidth: max(120, width(for: columnIndex)),
                                    alignment: .leading
                                )
                                .padding(8)
                                .background(rowIndex == 0 ? Color.secondary.opacity(0.10) : Color.clear)
                                .overlay(
                                    Rectangle()
                                        .stroke(Color.secondary.opacity(0.25), lineWidth: 0.5)
                                )
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func width(for columnIndex: Int) -> CGFloat {
        guard columnIndex < table.columnWidths.count else { return 120 }
        return CGFloat(table.columnWidths[columnIndex])
    }
}

private enum PersistedBlockDocumentLibraryLoader {
    static func load(from modelContext: ModelContext) throws -> ImportedDocumentLibrary? {
        let libraries = try modelContext.fetch(FetchDescriptor<BlockDocumentLibraryEntity>())
        guard let libraryEntity = libraries.sorted(by: { $0.importedAt > $1.importedAt }).first else {
            return nil
        }

        let folderEntities = try modelContext.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
            .filter { $0.libraryID == libraryEntity.id }
            .sorted { $0.sortOrder < $1.sortOrder }
        let tagEntities = try modelContext.fetch(FetchDescriptor<BlockDocumentTagEntity>())
            .filter { $0.libraryID == libraryEntity.id }
            .sorted { $0.createdAt < $1.createdAt }
        let noteEntities = try modelContext.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
            .filter { $0.libraryID == libraryEntity.id }
            .sorted { $0.updatedAt > $1.updatedAt }
        let blockEntities = try modelContext.fetch(FetchDescriptor<BlockDocumentBlockEntity>())
        let assetEntities = try modelContext.fetch(FetchDescriptor<BlockDocumentAssetEntity>())
        let attachmentsRoot = try StorageLocationManager.shared.attachmentsDirectoryURL()
        let decoder = JSONDecoder()

        let blocksByNoteID = Dictionary(grouping: blockEntities, by: \.noteID)
        let assetsByNoteID = Dictionary(grouping: assetEntities, by: \.noteID)

        let notes = try noteEntities.map { noteEntity in
            let persistedAssets = try (assetsByNoteID[noteEntity.id] ?? []).map {
                try importedAsset(from: $0, attachmentsRoot: attachmentsRoot, decoder: decoder)
            }
            let assetReferenceByID = Dictionary(uniqueKeysWithValues: persistedAssets.map { ($0.reference.id, $0.reference) })
            let blocks = try (blocksByNoteID[noteEntity.id] ?? [])
                .sorted { $0.position < $1.position }
                .map { try importedBlock(from: $0, assetReferenceByID: assetReferenceByID, decoder: decoder) }

            return ImportedDocumentNote(
                id: noteEntity.id,
                title: noteEntity.title,
                createdAt: noteEntity.createdAt,
                updatedAt: noteEntity.updatedAt,
                folderID: noteEntity.folderID,
                folderName: noteEntity.folderName,
                reminderAt: noteEntity.reminderAt,
                recurrenceRule: noteEntity.recurrenceRule,
                version: noteEntity.version,
                tagIDs: decodeUUIDList(noteEntity.tagIDs),
                viewMode: noteEntity.viewMode,
                deletedAt: noteEntity.deletedAt,
                originalFolderID: noteEntity.originalFolderID,
                originalFolderName: noteEntity.originalFolderName,
                document: ImportedDocument(
                    schemaVersion: noteEntity.documentSchemaVersion,
                    source: noteEntity.documentSource,
                    blocks: blocks
                ),
                assets: persistedAssets
            )
        }

        return ImportedDocumentLibrary(
            schemaVersion: libraryEntity.schemaVersion,
            sourceExportedAt: libraryEntity.sourceExportedAt,
            importedAt: libraryEntity.importedAt,
            folders: folderEntities.map {
                ImportedDocumentFolder(
                    id: $0.id,
                    name: $0.name,
                    sortOrder: $0.sortOrder,
                    isSystem: $0.isSystem,
                    createdAt: $0.createdAt
                )
            },
            tags: tagEntities.map {
                ImportedDocumentTag(
                    id: $0.id,
                    name: $0.name,
                    color: $0.color,
                    createdAt: $0.createdAt
                )
            },
            notes: notes
        )
    }

    private static func importedBlock(
        from entity: BlockDocumentBlockEntity,
        assetReferenceByID: [String: ImportedDocumentAssetReference],
        decoder: JSONDecoder
    ) throws -> ImportedDocumentBlock {
        ImportedDocumentBlock(
            id: entity.blockID,
            kind: ImportedDocumentBlockKind(rawValue: entity.kind) ?? .unsupported,
            text: try decodeTextPayload(entity.textPayload, decoder: decoder),
            level: entity.level,
            listStyle: entity.listStyle.map { ImportedDocumentListStyle(rawValue: $0) ?? .unknown },
            order: entity.order,
            checked: entity.checked,
            indent: entity.indent,
            asset: entity.assetID.flatMap { assetReferenceByID[$0] },
            table: try decodeTablePayload(entity.tablePayload, decoder: decoder),
            sourceType: entity.sourceType
        )
    }

    private static func importedAsset(
        from entity: BlockDocumentAssetEntity,
        attachmentsRoot: URL,
        decoder: JSONDecoder
    ) throws -> ImportedDocumentAsset {
        let sidecarPaths = try decodeStringArray(entity.sidecarPathsPayload, decoder: decoder)
        return ImportedDocumentAsset(
            reference: ImportedDocumentAssetReference(
                id: entity.assetID,
                kind: ImportedDocumentAssetKind(rawValue: entity.kind) ?? .unsupported,
                filename: entity.filename,
                mimeType: entity.mimeType,
                width: entity.width,
                height: entity.height,
                duration: entity.duration,
                createdAt: entity.createdAt,
                sidecarFiles: sidecarPaths,
                sourceKind: entity.sourceKind
            ),
            sourceURL: attachmentsRoot.appendingPathComponent(entity.relativeFilePath),
            sidecarURLs: sidecarPaths.map { attachmentsRoot.appendingPathComponent($0) }
        )
    }

    private static func decodeTextPayload(_ data: Data?, decoder: JSONDecoder) throws -> [ImportedInlineText] {
        guard let data else {
            return []
        }

        let payload = try decoder.decode([BlockDocumentTextSpanPayload].self, from: data)
        return payload.map {
            ImportedInlineText(
                text: $0.text,
                bold: $0.bold,
                italic: $0.italic,
                underline: $0.underline,
                strikethrough: $0.strikethrough,
                textColor: $0.textColor,
                backgroundColor: $0.backgroundColor,
                link: $0.link,
                fontFamily: $0.fontFamily,
                fontSize: $0.fontSize,
                kern: $0.kern,
                baselineOffset: $0.baselineOffset,
                paragraphStyle: $0.paragraphStyle.map {
                    MigratedParagraphStyle(
                        alignment: $0.alignment,
                        lineSpacing: $0.lineSpacing,
                        paragraphSpacing: $0.paragraphSpacing,
                        paragraphSpacingBefore: $0.paragraphSpacingBefore,
                        firstLineHeadIndent: $0.firstLineHeadIndent,
                        headIndent: $0.headIndent,
                        tailIndent: $0.tailIndent
                    )
                }
            )
        }
    }

    private static func decodeTablePayload(_ data: Data?, decoder: JSONDecoder) throws -> ImportedDocumentTable? {
        guard let data else {
            return nil
        }

        let payload = try decoder.decode(BlockDocumentTablePayload.self, from: data)
        return ImportedDocumentTable(
            rows: payload.rows,
            columnWidths: payload.columnWidths,
            rowHeights: payload.rowHeights
        )
    }

    private static func decodeStringArray(_ data: Data?, decoder: JSONDecoder) throws -> [String] {
        guard let data else {
            return []
        }
        return try decoder.decode([String].self, from: data)
    }

    private static func decodeUUIDList(_ rawValue: String) -> [UUID] {
        rawValue
            .split(separator: ",")
            .compactMap { UUID(uuidString: String($0)) }
    }
}

// MARK: - SyncResult 扩展
extension DataManagementView.SyncResult {
    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }

    var message: String {
        switch self {
        case .success(let msg): return msg
        case .failure(let msg): return msg
        }
    }
}

// MARK: - 本地化键值扩展
extension L10nKeys.Settings {
    static let tabGeneral = "settings_tab_general"
    static let tabShortcuts = "settings_tab_shortcuts"
}
