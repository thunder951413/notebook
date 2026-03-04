import SwiftUI

/// 自动备份设置视图
struct AutoBackupSettingsView: View {
    @StateObject private var backupManager = AutoBackupManager.shared
    @State private var showingDeleteConfirmation = false
    @State private var recordToDelete: AutoBackupManager.BackupRecord?
    @State private var showingRestoreConfirmation = false
    @State private var recordToRestore: AutoBackupManager.BackupRecord?
    @State private var errorMessage: String?
    @State private var showingError = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // 自动备份设置
            VStack(alignment: .leading, spacing: 12) {
                Text("自动备份设置")
                    .font(.title2)
                    .bold()
                
                Toggle("启用自动备份", isOn: $backupManager.isAutoBackupEnabled)
                
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
                
                Text("每天首次启动时自动备份所有数据到 history 目录")
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
                    
                    if backupManager.isBackingUp {
                        ProgressView()
                            .scaleEffect(0.8)
                        Text("正在备份...")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    
                    Button("刷新") {
                        backupManager.refreshBackupRecords()
                    }
                    .disabled(backupManager.isBackingUp)
                }
                
                if backupManager.backupRecords.isEmpty {
                    Text("暂无备份记录")
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 40)
                } else {
                    List {
                        ForEach(backupManager.backupRecords) { record in
                            BackupRecordRow(record: record) {
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
        .frame(minWidth: 500, minHeight: 400)
        .alert("确认删除", isPresented: $showingDeleteConfirmation) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                if let record = recordToDelete {
                    do {
                        try backupManager.deleteBackup(record: record)
                    } catch {
                        errorMessage = error.localizedDescription
                        showingError = true
                    }
                }
            }
        } message: {
            if let record = recordToDelete {
                Text("确定要删除备份 \"\(record.fileName)\" 吗？此操作不可撤销。")
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
                        } catch {
                            errorMessage = error.localizedDescription
                            showingError = true
                        }
                    }
                }
            }
        } message: {
            if let record = recordToRestore {
                Text("确定要恢复备份 \"\(record.fileName)\" 吗？当前数据将被覆盖。")
            }
        }
        .alert("错误", isPresented: $showingError) {
            Button("确定") {}
        } message: {
            Text(errorMessage ?? "发生未知错误")
        }
    }
}

/// 备份记录行视图
struct BackupRecordRow: View {
    let record: AutoBackupManager.BackupRecord
    let onRestore: () -> Void
    let onDelete: () -> Void
    let onReveal: () -> Void
    
    var body: some View {
        HStack {
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
                }
            }
            
            Spacer()
            
            HStack(spacing: 8) {
                Button("在 Finder 中显示") {
                    onReveal()
                }
                .buttonStyle(.link)
                
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
