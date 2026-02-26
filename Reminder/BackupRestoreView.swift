//
//  BackupRestoreView.swift
//  Reminder
//
//  备份恢复界面
//

import SwiftUI
import SwiftData

/// 备份恢复视图
struct BackupRestoreView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var persistence: PersistenceController
    @EnvironmentObject private var store: NoteStore

    @State private var backups: [BackupItem] = []
    @State private var selectedBackup: BackupItem?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showRestoreConfirmation = false
    @State private var restoreSuccess = false

    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text("从备份恢复")
                    .font(.title2)
                    .bold()

                Spacer()

                Button("关闭") {
                    dismiss()
                }
            }
            .padding()
            .background(Color(NSColor.controlBackgroundColor))

            Divider()

            // 备份列表
            if backups.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "archivebox")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)

                    Text("暂无备份")
                        .font(.headline)
                        .foregroundColor(.secondary)

                    Text("备份会在每次保存笔记时自动创建")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(backups) { backup in
                        BackupRowView(backup: backup, isSelected: selectedBackup?.id == backup.id)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                selectedBackup = backup
                            }
                    }
                }
                .listStyle(.plain)
            }

            Divider()

            // 底部操作栏
            HStack {
                if let error = errorMessage {
                    Text(error)
                        .foregroundColor(.red)
                        .font(.caption)
                }

                Spacer()

                if isLoading {
                    ProgressView()
                        .scaleEffect(0.8)
                        .padding(.trailing, 8)
                }

                Button("刷新") {
                    loadBackups()
                }
                .disabled(isLoading)

                Button("恢复选中备份") {
                    if selectedBackup != nil {
                        showRestoreConfirmation = true
                    }
                }
                .disabled(selectedBackup == nil || isLoading)
                .buttonStyle(.borderedProminent)
            }
            .padding()
            .background(Color(NSColor.controlBackgroundColor))
        }
        .onAppear {
            loadBackups()
        }
        .alert("确认恢复", isPresented: $showRestoreConfirmation) {
            Button("取消", role: .cancel) {}
            Button("恢复", role: .destructive) {
                performRestore()
            }
        } message: {
            if let backup = selectedBackup {
                Text("确定要恢复到 \(backup.title) 的备份版本吗？当前内容将被替换。")
            }
        }
        .alert("恢复成功", isPresented: $restoreSuccess) {
            Button("确定") {
                dismiss()
            }
        } message: {
            Text("备份已成功恢复。")
        }
    }

    /// 加载所有备份
    private func loadBackups() {
        isLoading = true
        errorMessage = nil

        Task { @MainActor in
            // 获取所有笔记的备份
            var allBackups: [BackupItem] = []
            for note in store.notes {
                let noteBackups = BackupManager.shared.getBackups(for: note.id)
                allBackups.append(contentsOf: noteBackups)
            }

            // 按时间倒序排列
            backups = allBackups.sorted { $0.timestamp > $1.timestamp }
            isLoading = false
        }
    }

    /// 执行恢复
    private func performRestore() {
        guard let backup = selectedBackup else { return }

        isLoading = true
        errorMessage = nil

        Task { @MainActor in
            if let context = persistence.modelContainer?.mainContext {
                let success = BackupManager.shared.restoreBackup(backup, context: context)

                if success {
                    // 刷新笔记列表
                    store.fetchData()
                    restoreSuccess = true
                } else {
                    errorMessage = "恢复失败，请重试"
                }
            } else {
                errorMessage = "无法获取数据库上下文"
            }

            isLoading = false
        }
    }
}

/// 备份行视图
struct BackupRowView: View {
    let backup: BackupItem
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            // 选中指示器
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.accentColor)
                    .font(.title3)
            } else {
                Image(systemName: "circle")
                    .foregroundColor(.secondary.opacity(0.3))
                    .font(.title3)
            }

            // 图标
            Image(systemName: "doc.text")
                .font(.title3)
                .foregroundColor(.accentColor)
                .frame(width: 32, height: 32)
                .background(Color.accentColor.opacity(0.1))
                .cornerRadius(6)

            // 信息
            VStack(alignment: .leading, spacing: 4) {
                Text(backup.title.isEmpty ? "无标题" : backup.title)
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)

                HStack(spacing: 8) {
                    Text(formattedDate(backup.timestamp))
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Text("•")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Text(backup.backupReason)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            Spacer()

            // 大小
            Text(formattedSize(backup.rtfdData.count))
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 4)
    }

    /// 格式化日期
    private func formattedDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    /// 格式化大小
    private func formattedSize(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

#Preview {
    BackupRestoreView()
        .frame(width: 600, height: 400)
}
