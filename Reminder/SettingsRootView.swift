import SwiftUI
import SwiftData

/// 设置界面根视图：展示/修改数据存储路径
struct SettingsRootView: View {
    @EnvironmentObject private var storage: StorageLocationManager
    @EnvironmentObject private var persistence: PersistenceController
    @EnvironmentObject private var store: NoteStore
    @StateObject private var languageManager = LanguageManager.shared

    @State private var isChoosingDirectory = false
    @State private var errorMessage: String?
    @State private var showRestartAlert = false
    @State private var showBackupRestoreSheet = false
    @State private var showClearBackupConfirmation = false

    var body: some View {
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

                Text("重启应用后语言设置生效")
                    .font(.caption)
                    .foregroundColor(.secondary)
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
                            Text("iCloud 同步")
                                .font(.headline)

                            if iCloudBackupManager.shared.isiCloudAvailable {
                                if let lastSync = iCloudBackupManager.shared.lastSyncDate {
                                    Text("上次同步: \(formattedDate(lastSync))")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                } else {
                                    Text("尚未同步")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            } else {
                                Text("iCloud 不可用")
                                    .font(.caption)
                                    .foregroundColor(.red)
                            }
                        }

                        Spacer()

                        if iCloudBackupManager.shared.isSyncing {
                            ProgressView()
                                .scaleEffect(0.8)
                        } else if iCloudBackupManager.shared.isiCloudAvailable {
                            Button("立即同步") {
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

            if let error = errorMessage {
                Text(error)
                    .foregroundColor(.red)
                    .font(.footnote)
            }

            Spacer()
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 400)
        .alert("需要重启", isPresented: $showRestartAlert) {
            Button("确定") {}
        } message: {
            Text("语言设置已更改，重启应用后生效。")
        }
        .sheet(isPresented: $showBackupRestoreSheet) {
            BackupRestoreView()
                .frame(minWidth: 600, minHeight: 400)
        }
        .alert("清除所有备份", isPresented: $showClearBackupConfirmation) {
            Button("取消", role: .cancel) {}
            Button("清除", role: .destructive) {
                BackupManager.shared.clearAllBackups()
            }
        } message: {
            Text("确定要清除所有备份吗？此操作不可撤销。")
        }
    }

    private func chooseDirectory() {
        errorMessage = nil
        isChoosingDirectory = true

        Task { @MainActor in
            do {
                try await storage.promptUserToChooseBaseDirectory()
                // 重新配置 SwiftData 容器
                try persistence.configureIfPossible()

                // 关键：切换路径后必须把新的 ModelContext 注入 NoteStore，否则无法读取/写入数据
                if let container = persistence.modelContainer {
                    store.setContext(container.mainContext)
                    // 同时更新 NoteSaveManager 的 context
                    NoteSaveManager.shared.setContext(container.mainContext)
                } else {
                    // 配置失败时清空展示，避免误导
                    store.notes = []
                    store.folders = []
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isChoosingDirectory = false
        }
    }

    /// 格式化日期
    private func formattedDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
