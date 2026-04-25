import Foundation
import SwiftData
import Combine

@MainActor
final class AutoSyncCoordinator: ObservableObject {
    static let shared = AutoSyncCoordinator()

    enum SidebarIndicatorState: Equatable {
        case idle
        case syncing
        case success
    }

    private static let pendingChangesKey = "AutoSyncCoordinator.hasPendingLocalChanges"

    private weak var store: NoteStore?
    private var pendingPushTimer: Timer?
    private var hasPendingLocalChanges: Bool {
        didSet { UserDefaults.standard.set(hasPendingLocalChanges, forKey: Self.pendingChangesKey) }
    }
    private var isAutomaticSyncRunning = false
    private var isManualSyncRunning = false
    private var didScheduleInitialPull = false
    private var indicatorDismissTask: Task<Void, Never>?
    private var currentSyncTask: Task<Void, Never>?
    private var syncGeneration: Int64 = 0
    private(set) var lastSuccessfulPullAt: Date?
    private(set) var lastSuccessfulPushAt: Date?

    @Published private(set) var sidebarIndicatorState: SidebarIndicatorState = .idle

    private let foregroundPullInterval: TimeInterval = 5 * 60
    private let savePushDebounceInterval: TimeInterval = 2 * 60
    private let pushRetryBaseInterval: TimeInterval = 2 * 60
    private let pushRetryMaxInterval: TimeInterval = 30 * 60
    private let successIndicatorDurationNanoseconds: UInt64 = 3_000_000_000
    private let syncOperationTimeout: TimeInterval = 3 * 60
    private var pushRetryCount: Int = 0

    private init() {
        hasPendingLocalChanges = UserDefaults.standard.bool(forKey: Self.pendingChangesKey)
    }

    func configure(store: NoteStore) {
        self.store = store
    }

    func handleApplicationLaunched() {
        guard !didScheduleInitialPull else { return }
        didScheduleInitialPull = true

        // runAutomaticPull 内部已实现超时保护，此处只需发起任务
        currentSyncTask = Task { @MainActor [weak self] in
            await self?.runAutomaticPull(reason: "launch", force: true)

            guard let self, !Task.isCancelled else { return }
            // 应用重启后若有未推送的本地修改，调度推送
            if self.hasPendingLocalChanges {
                self.scheduleDebouncedPush(reason: "recoveryAfterLaunch")
            }
            self.currentSyncTask = nil
        }
    }

    func handleApplicationDidBecomeActive() {
        Task { @MainActor [weak self] in
            await self?.runAutomaticPull(reason: "foreground", force: false)
        }
    }

    func noteDidSave(noteID: UUID, reason: String) {
        hasPendingLocalChanges = true
        pushRetryCount = 0
        // 如果同步正在进行，不额外调度推送（同步周期结束后会自动判断是否需要推送）
        guard !isAutomaticSyncRunning else { return }
        scheduleDebouncedPush(reason: "note=\(noteID.uuidString.prefix(8)) reason=\(reason)")
    }

    func beginManualSync() {
        isManualSyncRunning = true
        invalidatePendingPushTimer()
    }

    func endManualSync() {
        isManualSyncRunning = false

        if hasPendingLocalChanges {
            scheduleDebouncedPush(reason: "manualSyncFinished")
        }
    }

    /// 请求一次同步推送（用于删除等不经过 save 操作的场景）
    func requestPush(reason: String) {
        hasPendingLocalChanges = true
        pushRetryCount = 0
        guard !isAutomaticSyncRunning else { return }
        scheduleDebouncedPush(reason: reason)
    }

    func markLocalChangesPushed() {
        hasPendingLocalChanges = false
        pushRetryCount = 0
        lastSuccessfulPushAt = Date()
        invalidatePendingPushTimer()
    }

    func flushPendingBeforeTermination() async {
        invalidatePendingPushTimer()
        guard hasPendingLocalChanges else { return }
        await runAutomaticPush(reason: "termination")
    }

    private var canUseAutoSync: Bool {
        SSHConfigManager.shared.isConfigured && PersistenceController.shared.modelContainer != nil
    }

    private func scheduleDebouncedPush(reason: String) {
        invalidatePendingPushTimer()
        guard canUseAutoSync else { return }

        let interval: TimeInterval
        if pushRetryCount > 0 {
            // 指数退避：base * 2^retryCount，上限 maxInterval
            interval = min(pushRetryBaseInterval * pow(2.0, Double(pushRetryCount)), pushRetryMaxInterval)
        } else {
            interval = savePushDebounceInterval
        }

        pendingPushTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                await self.runAutomaticPush(reason: reason)
            }
        }
    }

    private func invalidatePendingPushTimer() {
        pendingPushTimer?.invalidate()
        pendingPushTimer = nil
    }

    private func shouldPullOnForeground(at now: Date = Date()) -> Bool {
        guard let lastSuccessfulPullAt else { return true }
        return now.timeIntervalSince(lastSuccessfulPullAt) >= foregroundPullInterval
    }

    private func runAutomaticPull(reason: String, force: Bool) async {
        guard canUseAutoSync else { return }
        guard !isAutomaticSyncRunning, !isManualSyncRunning else { return }
        guard force || shouldPullOnForeground() else { return }
        guard let context = PersistenceController.shared.modelContainer?.mainContext else { return }

        let generation = syncGeneration + 1
        syncGeneration = generation
        isAutomaticSyncRunning = true
        invalidatePendingPushTimer()
        defer {
            isAutomaticSyncRunning = false
            // 同步结束后，如果还有待推送的更改，调度推送
            if hasPendingLocalChanges && !isManualSyncRunning {
                scheduleDebouncedPush(reason: "postPull(\(reason))")
            }
        }
        setSidebarIndicatorSyncing()
        Logger.shared.log(.app, .debug, "[AutoSync] 开始自动拉取: \(reason) gen=\(generation)")

        // 确保自动拉取前，编辑器中的待保存内容已经落盘。
        NoteSaveManager.shared.flushAllPending()

        let pullTask = Task {
            try await SSHSyncManager.shared.syncAllNotesFromRemote(
                context: context,
                config: SSHConfigManager.shared.config
            )
        }
        // 超时保护
        let pullTimeoutNs = UInt64(syncOperationTimeout * 1_000_000_000)
        let pullTimeoutTask = Task {
            try? await Task.sleep(nanoseconds: pullTimeoutNs)
            pullTask.cancel()
        }
        defer { pullTimeoutTask.cancel() }

        do {
            _ = try await pullTask.value
            lastSuccessfulPullAt = Date()
            store?.fetchData()
            setSidebarIndicatorSuccess()
            Logger.shared.log(.app, .info, "[AutoSync] 自动拉取完成: \(reason) gen=\(generation)")
        } catch {
            if error is CancellationError {
                Logger.shared.log(.app, .warn, "[AutoSync] 自动拉取超时 (\(reason))")
            } else {
                Logger.shared.log(.app, .error, "[AutoSync] 自动拉取失败 (\(reason)): \(error.localizedDescription)")
            }
            clearSidebarIndicator()
        }
    }

    private func runAutomaticPush(reason: String) async {
        guard canUseAutoSync else { return }
        guard hasPendingLocalChanges else { return }
        guard !isAutomaticSyncRunning, !isManualSyncRunning else { return }
        guard let context = PersistenceController.shared.modelContainer?.mainContext else { return }

        let generation = syncGeneration + 1
        syncGeneration = generation
        isAutomaticSyncRunning = true
        defer { isAutomaticSyncRunning = false }

        invalidatePendingPushTimer()
        setSidebarIndicatorSyncing()
        Logger.shared.log(.app, .debug, "[AutoSync] 开始自动推送: \(reason) gen=\(generation)")

        // 推送前再冲刷一次待保存内容，确保远端拿到的是最新数据。
        NoteSaveManager.shared.flushAllPending()

        let pushTask = Task {
            _ = try await SSHSyncManager.shared.syncAllNotesToRemote(
                context: context,
                config: SSHConfigManager.shared.config
            )
        }
        // 超时保护
        let pushTimeoutNs = UInt64(syncOperationTimeout * 1_000_000_000)
        let pushTimeoutTask = Task {
            try? await Task.sleep(nanoseconds: pushTimeoutNs)
            pushTask.cancel()
        }
        defer { pushTimeoutTask.cancel() }

        do {
            _ = try await pushTask.value

            hasPendingLocalChanges = false
            lastSuccessfulPushAt = Date()
            setSidebarIndicatorSuccess()
            Logger.shared.log(.app, .info, "[AutoSync] 自动推送完成: \(reason) gen=\(generation)")
        } catch {
            if error is CancellationError {
                Logger.shared.log(.app, .warn, "[AutoSync] 自动推送超时 (\(reason))")
            } else {
                Logger.shared.log(.app, .error, "[AutoSync] 自动推送失败 (\(reason)): \(error.localizedDescription)")
            }
            clearSidebarIndicator()
            if hasPendingLocalChanges && !isManualSyncRunning {
                pushRetryCount += 1
                scheduleDebouncedPush(reason: "retryAfterFailure(\(pushRetryCount))")
            }
        }
    }

    private func setSidebarIndicatorSyncing() {
        indicatorDismissTask?.cancel()
        indicatorDismissTask = nil
        sidebarIndicatorState = .syncing
    }

    private func setSidebarIndicatorSuccess() {
        indicatorDismissTask?.cancel()
        sidebarIndicatorState = .success
        indicatorDismissTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: successIndicatorDurationNanoseconds)
            guard !Task.isCancelled else { return }
            self?.sidebarIndicatorState = .idle
            self?.indicatorDismissTask = nil
        }
    }

    private func clearSidebarIndicator() {
        indicatorDismissTask?.cancel()
        indicatorDismissTask = nil
        sidebarIndicatorState = .idle
    }
}
