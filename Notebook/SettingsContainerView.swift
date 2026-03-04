import SwiftUI
import UniformTypeIdentifiers
import SwiftData

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
                                if let url = URL(string: "https://github.com/your-username/Notebook") {
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
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // 标题
                Text("数据管理")
                    .font(.title2)
                    .bold()

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
                        .help("导入笔记、文件夹和标签")

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
        showImportConfirmation(message: "导入笔记将合并或覆盖现有的笔记、文件夹和标签。\n如果 ID 相同，现有数据将被更新。\n建议在导入前先导出当前数据作为备份。\n\n是否继续导入？") {
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
            openPanel.message = "选择要导入的笔记文件"

            guard openPanel.runModal() == .OK, let zipURL = openPanel.url else {
                return
            }

            let context = container.mainContext
            try await DataExportManager.shared.importNotes(from: zipURL, context: context)

            await MainActor.run {
                errorMessage = "笔记导入成功"
            }
        } catch {
            await MainActor.run {
                errorMessage = "导入笔记失败: \(error.localizedDescription)"
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
}

// MARK: - 本地化键值扩展
extension L10nKeys.Settings {
    static let tabGeneral = "settings_tab_general"
    static let tabShortcuts = "settings_tab_shortcuts"
}
