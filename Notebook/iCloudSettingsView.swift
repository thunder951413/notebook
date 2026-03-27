//
//  iCloudSettingsView.swift
//  Notebook
//
//  iCloud 同步设置界面
//

import SwiftUI
import SwiftData

struct iCloudSettingsView: View {
    @StateObject private var syncManager = iCloudSyncManager.shared
    @State private var showingSyncConfirmation = false
    @State private var showingResetConfirmation = false
    @State private var syncDirection: SyncDirection = .bidirectional
    
    enum SyncDirection {
        case toiCloud    // 上传到 iCloud
        case fromiCloud  // 从 iCloud 下载
        case bidirectional // 双向同步
        
        var title: String {
            switch self {
            case .toiCloud: return "上传到 iCloud"
            case .fromiCloud: return "从 iCloud 下载"
            case .bidirectional: return "双向同步"
            }
        }
        
        var icon: String {
            switch self {
            case .toiCloud: return "icloud.and.arrow.up"
            case .fromiCloud: return "icloud.and.arrow.down"
            case .bidirectional: return "arrow.triangle.2.circlepath.icloud"
            }
        }
    }
    
    var body: some View {
        VStack(spacing: 20) {
            // iCloud 状态卡片
            iCloudStatusCard
            
            Divider()
            
            // 同步控制
            SyncControlSection
            
            Divider()
            
            // 同步详情
            SyncDetailsSection
            
            Spacer()
        }
        .padding()
        .frame(width: 400, height: 500)
        .alert("确认同步", isPresented: $showingSyncConfirmation) {
            Button("取消", role: .cancel) { }
            Button("开始同步") {
                performSync()
            }
        } message: {
            Text("这将执行\(syncDirection.title)操作，是否继续？")
        }
        .alert("重置同步", isPresented: $showingResetConfirmation) {
            Button("取消", role: .cancel) { }
            Button("重置", role: .destructive) {
                resetSync()
            }
        } message: {
            Text("这将清除所有 iCloud 同步数据，此操作不可恢复。是否继续？")
        }
    }
    
    // MARK: - iCloud 状态卡片
    
    private var iCloudStatusCard: some View {
        VStack(spacing: 12) {
            HStack {
                Image(systemName: "icloud")
                    .font(.system(size: 40))
                    .foregroundColor(syncManager.isiCloudAvailable ? .blue : .gray)
                
                VStack(alignment: .leading, spacing: 4) {
                    Text("iCloud 同步")
                        .font(.headline)
                    
                    HStack(spacing: 6) {
                        Circle()
                            .fill(syncStatusColor)
                            .frame(width: 8, height: 8)
                        Text(syncStatusText)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                
                Spacer()
            }
            
            if !syncManager.isiCloudAvailable {
                HStack {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundColor(.orange)
                    Text("iCloud 不可用，请检查系统设置")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .padding(.top, 4)
            }
        }
        .padding()
        .background(Color.secondary.opacity(0.1))
        .cornerRadius(12)
    }
    
    // MARK: - 同步控制
    
    private var SyncControlSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("同步控制")
                .font(.headline)
            
            // 同步方向选择
            Picker("同步方向", selection: $syncDirection) {
                Text("双向同步").tag(SyncDirection.bidirectional)
                Text("上传到 iCloud").tag(SyncDirection.toiCloud)
                Text("从 iCloud 下载").tag(SyncDirection.fromiCloud)
            }
            .pickerStyle(.segmented)
            
            // 同步按钮
            Button {
                showingSyncConfirmation = true
            } label: {
                HStack {
                    Image(systemName: syncDirection.icon)
                    Text(syncDirection.title)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!syncManager.isiCloudAvailable || syncManager.syncStatus.isSyncing)
            
            // 进度条
            if syncManager.syncStatus.isSyncing {
                VStack(spacing: 4) {
                    ProgressView(value: syncManager.syncProgress)
                        .progressViewStyle(.linear)
                    Text("正在同步... \(Int(syncManager.syncProgress * 100))%")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
    }
    
    // MARK: - 同步详情
    
    private var SyncDetailsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("同步详情")
                .font(.headline)
            
            VStack(alignment: .leading, spacing: 8) {
                DetailRow(title: "上次同步", value: lastSyncText)
                DetailRow(title: "同步内容", value: "按笔记快照与历史、配置")
                DetailRow(title: "存储位置", value: "iCloud Drive/NotebookSync")
            }
            
            // 高级选项
            DisclosureGroup("高级选项") {
                VStack(alignment: .leading, spacing: 8) {
                    Button("立即同步配置") {
                        syncConfigurationOnly()
                    }
                    .disabled(!syncManager.isiCloudAvailable)
                    
                    Button("重置 iCloud 数据", role: .destructive) {
                        showingResetConfirmation = true
                    }
                    .disabled(!syncManager.isiCloudAvailable)
                }
                .padding(.top, 8)
            }
        }
    }
    
    // MARK: - 辅助视图
    
    private struct DetailRow: View {
        let title: String
        let value: String
        
        var body: some View {
            HStack {
                Text(title)
                    .foregroundColor(.secondary)
                Spacer()
                Text(value)
                    .foregroundColor(.primary)
            }
            .font(.caption)
        }
    }
    
    // MARK: - 计算属性
    
    private var syncStatusColor: Color {
        switch syncManager.syncStatus {
        case .idle:
            return syncManager.isiCloudAvailable ? .green : .gray
        case .syncing:
            return .blue
        case .completed:
            return .green
        case .failed:
            return .red
        }
    }
    
    private var syncStatusText: String {
        switch syncManager.syncStatus {
        case .idle:
            return syncManager.isiCloudAvailable ? "已就绪" : "未连接"
        case .syncing:
            return "同步中..."
        case .completed:
            return "同步完成"
        case .failed(let msg):
            return "失败: \(msg)"
        }
    }
    
    private var lastSyncText: String {
        guard let date = syncManager.lastSyncDate else {
            return "从未同步"
        }
        
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
    
    // MARK: - 方法
    
    private func performSync() {
        Task {
            guard let context = PersistenceController.shared.modelContainer?.mainContext else {
                syncManager.syncStatus = .failed("数据容器未配置")
                return
            }

            syncManager.syncStatus = .syncing
            syncManager.syncProgress = 0.0
            do {
                switch syncDirection {
                case .toiCloud:
                    let pushed = try await syncManager.syncAllNotesToiCloud(context: context)
                    syncManager.syncProgress = 1.0
                    syncManager.syncStatus = .completed
                    print("[iCloudSettingsView] 推送完成 \(pushed.count) 条")
                case .fromiCloud:
                    let pulled = try await syncManager.syncAllNotesFromiCloud(context: context)
                    let conflicts = pulled.filter(\.detectedConflict).count
                    syncManager.syncProgress = 1.0
                    syncManager.syncStatus = .completed
                    print("[iCloudSettingsView] 拉取完成 \(pulled.count) 条，冲突 \(conflicts) 条")
                case .bidirectional:
                    let summary = try await syncManager.syncBidirectional(context: context)
                    syncManager.syncProgress = 1.0
                    syncManager.syncStatus = .completed
                    print("[iCloudSettingsView] 双向完成，拉取 \(summary.pulled) 条，推送 \(summary.pushed) 条，冲突 \(summary.conflicts) 条")
                }
            } catch {
                syncManager.syncStatus = .failed(error.localizedDescription)
            }
        }
    }
    
    private func syncConfigurationOnly() {
        Task {
            try? await syncManager.syncConfiguration()
        }
    }
    
    private func resetSync() {
        // 清除 iCloud 数据
        // 这里可以实现重置逻辑
    }
}

// MARK: - 预览

struct iCloudSettingsView_Previews: PreviewProvider {
    static var previews: some View {
        iCloudSettingsView()
    }
}
