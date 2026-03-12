import SwiftUI

/// 自动备份设置视图
struct AutoBackupSettingsView: View {
    @StateObject private var backupManager = AutoBackupManager.shared
    @StateObject private var sshConfigManager = SSHConfigManager.shared
    @State private var showingDeleteConfirmation = false
    @State private var recordToDelete: AutoBackupManager.BackupRecord?
    @State private var showingRestoreConfirmation = false
    @State private var recordToRestore: AutoBackupManager.BackupRecord?
    @State private var errorMessage: String?
    @State private var showingError = false
    @State private var selectedLocation: BackupLocation = .local
    @State private var isLoadingRemote = false
    @State private var isSyncing = false
    @State private var syncProgress = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // 自动备份设置
            VStack(alignment: .leading, spacing: 12) {
                Text("自动备份设置")
                    .font(.title2)
                    .bold()

                Toggle("启用自动备份", isOn: $backupManager.isAutoBackupEnabled)

                // SSH备份开关
                Toggle("同时备份到SSH服务器", isOn: $backupManager.enableSSHBackup)
                    .disabled(!sshConfigManager.isConfigured)

                if backupManager.enableSSHBackup && !sshConfigManager.isConfigured {
                    Text("⚠️ 请先配置SSH服务器信息")
                        .font(.caption)
                        .foregroundColor(.orange)
                }

                HStack {
                    Text("最大保存数量:")
                    Picker("", selection: $backupManager.maxBackupCount) {
                        ForEach([5, 10, 20, 50], id: \.self) { count in
                            Text("\(count) 个").tag(count)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }

                Text("每天首次启动时自动备份所有数据到 history 目录，同时可选择同步到 SSH 服务器")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Divider()

            // 历史备份记录
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("历史备份记录")
                        .font(.title2)
                        .bold()

                    Spacer()

                    // 同步按钮组
                    if sshConfigManager.isConfigured {
                        Menu {
                            Button {
                                Task {
                                    await syncLocalToRemote()
                                }
                            } label: {
                                Label("同步本地到SSH", systemImage: "arrow.up.to.line")
                            }

                            Button {
                                Task {
                                    await syncRemoteToLocal()
                                }
                            } label: {
                                Label("同步SSH到本地", systemImage: "arrow.down.to.line")
                            }
                        } label: {
                            Label("同步", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .menuStyle(.borderedButton)
                        .disabled(isSyncing)
                    }

                    // 位置选择器
                    Picker("备份位置", selection: $selectedLocation) {
                        Text("本地 (\(backupManager.localBackupRecords.count))").tag(BackupLocation.local)
                        Text("SSH服务器 (\(backupManager.remoteBackupRecords.count))").tag(BackupLocation.remote)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 250)
                    .onChange(of: selectedLocation) { _, newValue in
                        if newValue == .remote {
                            Task {
                                await refreshRemoteBackups()
                            }
                        }
                    }

                    if backupManager.isBackingUp || isSyncing {
                        ProgressView()
                            .scaleEffect(0.8)
                        Text(syncProgress.isEmpty ? backupManager.backupProgress : syncProgress)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    if isLoadingRemote {
                        ProgressView()
                            .scaleEffect(0.8)
                    }

                    Button("刷新") {
                        if selectedLocation == .local {
                            backupManager.refreshBackupRecords()
                        } else {
                            Task {
                                await refreshRemoteBackups()
                            }
                        }
                    }
                    .disabled(backupManager.isBackingUp || isLoadingRemote || isSyncing)
                }

                let records = selectedLocation == .local ? backupManager.localBackupRecords : backupManager.remoteBackupRecords

                if records.isEmpty {
                    VStack(spacing: 8) {
                        Text("暂无备份记录")
                            .foregroundColor(.secondary)
                        if selectedLocation == .remote && !sshConfigManager.isConfigured {
                            Text("请先配置SSH服务器")
                                .font(.caption)
                                .foregroundColor(.orange)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 40)
                } else {
                    List {
                        ForEach(records) { record in
                            BackupRecordRow(
                                record: record,
                                showRevealButton: selectedLocation == .local
                            ) {
                                recordToRestore = record
                                showingRestoreConfirmation = true
                            } onDelete: {
                                recordToDelete = record
                                showingDeleteConfirmation = true
                            } onReveal: {
                                do {
                                    try backupManager.revealBackupInFinder(record: record)
                                } catch {
                                    errorMessage = error.localizedDescription
                                    showingError = true
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .frame(minHeight: 200)
                }
            }

            Spacer()
        }
        .padding(20)
        .frame(minWidth: 600, minHeight: 450)
        .alert("确认删除", isPresented: $showingDeleteConfirmation) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                if let record = recordToDelete {
                    Task {
                        do {
                            try await backupManager.deleteBackup(record: record)
                            // 刷新列表
                            if selectedLocation == .remote {
                                await refreshRemoteBackups()
                            }
                        } catch {
                            errorMessage = error.localizedDescription
                            showingError = true
                        }
                    }
                }
            }
        } message: {
            if let record = recordToDelete {
                let location = record.location == .local ? "本地" : "SSH服务器"
                Text("确定要删除\(location)的备份 \"\(record.fileName)\" 吗？此操作不可撤销。")
            }
        }
        .alert("确认恢复", isPresented: $showingRestoreConfirmation) {
            Button("取消", role: .cancel) {}
            Button("恢复") {
                if let record = recordToRestore {
                    Task {
                        do {
                            let backupURL = try await backupManager.restoreBackup(record: record)
                            // 这里可以添加恢复逻辑
                            print("准备恢复备份: \(backupURL)")
                            errorMessage = "备份已准备好恢复: \(backupURL.lastPathComponent)"
                            showingError = true
                        } catch {
                            errorMessage = error.localizedDescription
                            showingError = true
                        }
                    }
                }
            }
        } message: {
            if let record = recordToRestore {
                let location = record.location == .local ? "本地" : "SSH服务器"
                Text("确定要从\(location)恢复备份 \"\(record.fileName)\" 吗？当前数据将被覆盖。")
            }
        }
        .alert("提示", isPresented: $showingError) {
            Button("确定") {}
        } message: {
            Text(errorMessage ?? "发生未知错误")
        }
    }

    private func refreshRemoteBackups() async {
        guard sshConfigManager.isConfigured else { return }
        isLoadingRemote = true
        defer { isLoadingRemote = false }

        do {
            try await backupManager.refreshRemoteBackupList()
        } catch {
            errorMessage = "刷新远程备份列表失败: \(error.localizedDescription)"
            showingError = true
        }
    }

    private func syncLocalToRemote() async {
        guard sshConfigManager.isConfigured else {
            errorMessage = "请先配置SSH服务器"
            showingError = true
            return
        }

        isSyncing = true
        syncProgress = "正在同步本地到SSH..."
        defer {
            isSyncing = false
            syncProgress = ""
        }

        do {
            let result = try await backupManager.syncAllLocalToRemote { progress in
                Task { @MainActor in
                    syncProgress = progress
                }
            }

            errorMessage = "同步完成: 上传 \(result.uploaded) 个文件, 跳过 \(result.skipped) 个已存在的文件"
            showingError = true

            // 如果当前显示的是远程列表，刷新它
            if selectedLocation == .remote {
                await refreshRemoteBackups()
            }
        } catch {
            errorMessage = "同步失败: \(error.localizedDescription)"
            showingError = true
        }
    }

    private func syncRemoteToLocal() async {
        guard sshConfigManager.isConfigured else {
            errorMessage = "请先配置SSH服务器"
            showingError = true
            return
        }

        isSyncing = true
        syncProgress = "正在同步SSH到本地..."
        defer {
            isSyncing = false
            syncProgress = ""
        }

        do {
            let result = try await backupManager.syncAllRemoteToLocal { progress in
                Task { @MainActor in
                    syncProgress = progress
                }
            }

            errorMessage = "同步完成: 下载 \(result.downloaded) 个文件, 跳过 \(result.skipped) 个已存在的文件"
            showingError = true

            // 如果当前显示的是本地列表，刷新它
            if selectedLocation == .local {
                backupManager.refreshBackupRecords()
            }
        } catch {
            errorMessage = "同步失败: \(error.localizedDescription)"
            showingError = true
        }
    }
}

/// 备份记录行视图
struct BackupRecordRow: View {
    let record: AutoBackupManager.BackupRecord
    let showRevealButton: Bool
    let onRestore: () -> Void
    let onDelete: () -> Void
    let onReveal: () -> Void

    var body: some View {
        HStack {
            // 位置标识
            HStack(spacing: 4) {
                Image(systemName: record.location == .local ? "internaldrive" : "network")
                    .foregroundColor(record.location == .local ? .blue : .green)
                    .font(.caption)

                VStack(alignment: .leading, spacing: 4) {
                    Text(record.fileName)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)

                    HStack(spacing: 12) {
                        Text(record.formattedDate)
                            .font(.caption)
                            .foregroundColor(.secondary)

                        Text(record.formattedSize)
                            .font(.caption)
                            .foregroundColor(.secondary)

                        Text(record.location.rawValue)
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(record.location == .local ? Color.blue.opacity(0.2) : Color.green.opacity(0.2))
                            .foregroundColor(record.location == .local ? .blue : .green)
                            .cornerRadius(4)
                    }
                }
            }

            Spacer()

            HStack(spacing: 8) {
                if showRevealButton {
                    Button("在 Finder 中显示") {
                        onReveal()
                    }
                    .buttonStyle(.link)
                }

                Button("恢复") {
                    onRestore()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Button("删除") {
                    onDelete()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .foregroundColor(.red)
            }
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    AutoBackupSettingsView()
}
