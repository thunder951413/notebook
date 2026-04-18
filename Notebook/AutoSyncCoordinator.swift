import Foundation
import SwiftData

@MainActor
final class AutoSyncCoordinator {
    static let shared = AutoSyncCoordinator()

    private weak var store: NoteStore?
    private var pendingPushTimer: Timer?
    private var hasPendingLocalChanges = false
    private var isAutomaticSyncRunning = false
    private var isManualSyncRunning = false
    private var didScheduleInitialPull = false
    private(set) var lastSuccessfulPullAt: Date?
    private(set) var lastSuccessfulPushAt: Date?

    private let foregroundPullInterval: TimeInterval = 5 * 60
    private let savePushDebounceInterval: TimeInterval = 10 * 60

    private init() {}

    func configure(store: NoteStore) {
        self.store = store
    }

    func handleApplicationLaunched() {
        guard !didScheduleInitialPull else { return }
        didScheduleInitialPull = true

        Task { @MainActor [weak self] in
            await self?.runAutomaticPull(reason: "launch", force: true)
        }
    }

    func handleApplicationDidBecomeActive() {
        Task { @MainActor [weak self] in
            await self?.runAutomaticPull(reason: "foreground", force: false)
        }
    }

    func noteDidSave(noteID: UUID, reason: String) {
        hasPendingLocalChanges = true
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

        pendingPushTimer = Timer.scheduledTimer(withTimeInterval: savePushDebounceInterval, repeats: false) { [weak self] _ in
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

        // 确保自动拉取前，编辑器中的待保存内容已经落盘。
        NoteSaveManager.shared.flushAllPending()

        do {
            _ = try await SSHSyncManager.shared.syncAllNotesFromRemote(
                context: context,
                config: SSHConfigManager.shared.config
            )
            lastSuccessfulPullAt = Date()
            store?.fetchData()
            Logger.shared.log(.app, .info, "[AutoSync] 自动拉取完成: \(reason)")
        } catch {
            Logger.shared.log(.app, .error, "[AutoSync] 自动拉取失败 (\(reason)): \(error.localizedDescription)")
        }
    }

    private func runAutomaticPush(reason: String) async {
        guard canUseAutoSync else { return }
        guard hasPendingLocalChanges else { return }
        guard !isAutomaticSyncRunning, !isManualSyncRunning else { return }
        guard let context = PersistenceController.shared.modelContainer?.mainContext else { return }

        isAutomaticSyncRunning = true
        defer { isAutomaticSyncRunning = false }

        invalidatePendingPushTimer()

        // 推送前再冲刷一次待保存内容，确保远端拿到的是最新数据。
        NoteSaveManager.shared.flushAllPending()

        do {
            _ = try await SSHSyncManager.shared.syncAllNotesToRemote(
                context: context,
                config: SSHConfigManager.shared.config
            )
            hasPendingLocalChanges = false
            lastSuccessfulPushAt = Date()
            Logger.shared.log(.app, .info, "[AutoSync] 自动推送完成: \(reason)")
        } catch {
            Logger.shared.log(.app, .error, "[AutoSync] 自动推送失败 (\(reason)): \(error.localizedDescription)")
            if hasPendingLocalChanges && !isManualSyncRunning {
                scheduleDebouncedPush(reason: "retryAfterFailure")
            }
        }
    }
}
