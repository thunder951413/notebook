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
        didSet { NotebookDefaults.shared.set(hasPendingLocalChanges, forKey: Self.pendingChangesKey) }
    }
    private var isAutomaticSyncRunning = false
    private var isManualSyncRunning = false
    private var didScheduleInitialPull = false
    private var indicatorDismissTask: Task<Void, Never>?
    private(set) var lastSuccessfulPullAt: Date?
    private(set) var lastSuccessfulPushAt: Date?

    @Published private(set) var sidebarIndicatorState: SidebarIndicatorState = .idle

    private let foregroundPullInterval: TimeInterval = 5 * 60
    private let savePushDebounceInterval: TimeInterval = 2 * 60
    private let pushRetryBaseInterval: TimeInterval = 2 * 60
    private let pushRetryMaxInterval: TimeInterval = 30 * 60
    private let successIndicatorDurationNanoseconds: UInt64 = 3_000_000_000
    private var pushRetryCount: Int = 0

    private init() {
        hasPendingLocalChanges = NotebookDefaults.shared.bool(forKey: Self.pendingChangesKey)
    }

    func configure(store: NoteStore) {
        self.store = store
    }

    func handleApplicationLaunched() {
        guard !didScheduleInitialPull else { return }
        didScheduleInitialPull = true

        Task { @MainActor [weak self] in
            await self?.runAutomaticPull(reason: "launch", force: true)

            // 应用重启后若有未推送的本地修改，调度推送
            if self?.hasPendingLocalChanges == true {
                self?.scheduleDebouncedPush(reason: "recoveryAfterLaunch")
            }
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

        isAutomaticSyncRunning = true
        defer { isAutomaticSyncRunning = false }
        setSidebarIndicatorSyncing()
        Logger.shared.log(.app, .debug, "[AutoSync] 开始自动拉取: \(reason)")

        // 确保自动拉取前，编辑器中的待保存内容已经落盘。
        NoteSaveManager.shared.flushAllPending()

        do {
            _ = try await SSHSyncManager.shared.syncAllNotesFromRemote(
                context: context,
                config: SSHConfigManager.shared.config
            )
            lastSuccessfulPullAt = Date()
            store?.fetchData()
            setSidebarIndicatorSuccess()
            Logger.shared.log(.app, .info, "[AutoSync] 自动拉取完成: \(reason)")
        } catch {
            clearSidebarIndicator()
            Logger.shared.log(.app, .error, "[AutoSync] 自动拉取失败 (\(reason)): \(error.localizedDescription)")
        }
    }

    private func runAutomaticPush(reason: String) async {
        guard canUseAutoSync else { return }
        guard hasPendingLocalChanges else { return }
        guard !isAutomaticSyncRunning, !isManualSyncRunning else {
            scheduleDebouncedPush(reason: "deferredBecauseSyncRunning")
            return
        }
        guard let context = PersistenceController.shared.modelContainer?.mainContext else { return }

        isAutomaticSyncRunning = true
        defer { isAutomaticSyncRunning = false }

        invalidatePendingPushTimer()
        setSidebarIndicatorSyncing()
        Logger.shared.log(.app, .debug, "[AutoSync] 开始自动推送: \(reason)")

        // 推送前再冲刷一次待保存内容，确保远端拿到的是最新数据。
        NoteSaveManager.shared.flushAllPending()

        do {
            _ = try await SSHSyncManager.shared.syncAllNotesFromRemote(
                context: context,
                config: SSHConfigManager.shared.config
            )
            lastSuccessfulPullAt = Date()

            _ = try await SSHSyncManager.shared.syncAllNotesToRemote(
                context: context,
                config: SSHConfigManager.shared.config
            )
            hasPendingLocalChanges = false
            lastSuccessfulPushAt = Date()
            setSidebarIndicatorSuccess()
            Logger.shared.log(.app, .info, "[AutoSync] 自动推送完成: \(reason)")
        } catch {
            clearSidebarIndicator()
            Logger.shared.log(.app, .error, "[AutoSync] 自动推送失败 (\(reason)): \(error.localizedDescription)")
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
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.successIndicatorDurationNanoseconds)
            guard !Task.isCancelled else { return }
            self.sidebarIndicatorState = .idle
            self.indicatorDismissTask = nil
        }
    }

    private func clearSidebarIndicator() {
        indicatorDismissTask?.cancel()
        indicatorDismissTask = nil
        sidebarIndicatorState = .idle
    }
}
