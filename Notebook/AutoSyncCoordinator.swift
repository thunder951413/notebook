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

    private struct PendingNotePush {
        let reason: String
        let revision: UInt64
    }

    private weak var store: NoteStore?
    private var pendingPushTimer: Timer?
    private var hasPendingLocalChanges: Bool {
        didSet { NotebookDefaults.shared.set(hasPendingLocalChanges, forKey: Self.pendingChangesKey) }
    }
    private var isAutomaticSyncRunning = false
    private var isManualSyncRunning = false
    private var didScheduleInitialPull = false
    private var requiresFullPush: Bool
    private var pendingNotePushes: [UUID: PendingNotePush] = [:]
    private var notePushTask: Task<Void, Never>?
    private var nextNotePushRevision: UInt64 = 0
    private var notePushRetryCount = 0
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

    private let backend: any NoteSyncBackend

    init(backend: (any NoteSyncBackend)? = nil) {
        let hadPendingLocalChanges = NotebookDefaults.shared.bool(forKey: Self.pendingChangesKey)
        hasPendingLocalChanges = hadPendingLocalChanges
        requiresFullPush = hadPendingLocalChanges
        self.backend = backend ?? SSHNoteSyncBackend.shared
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
        guard canUseAutoSync else {
            Logger.shared.log(
                .app,
                .debug,
                "[AutoSync] 笔记保存后跳过远程推送（SSH 远程或数据容器未配置）: note=\(noteID.uuidString.prefix(8))"
            )
            return
        }

        hasPendingLocalChanges = true
        if reason == "deletePermanently" {
            // 单篇上传需要笔记实体；永久删除只能通过全量索引中的墓碑传播。
            requiresFullPush = true
            pushRetryCount = 0
            scheduleDebouncedPush(reason: "noteDeletion=\(noteID.uuidString.prefix(8))")
            return
        }

        notePushRetryCount = 0
        nextNotePushRevision &+= 1
        pendingNotePushes[noteID] = PendingNotePush(reason: reason, revision: nextNotePushRevision)
        schedulePendingNotePush()
    }

    func libraryDidChange(reason: String) {
        hasPendingLocalChanges = true
        requiresFullPush = true
        pushRetryCount = 0
        scheduleDebouncedPush(reason: "library=\(reason)")
    }

    func beginManualSync() {
        isManualSyncRunning = true
        invalidatePendingPushTimer()
    }

    func endManualSync() {
        isManualSyncRunning = false

        if requiresFullPush {
            scheduleDebouncedPush(reason: "manualSyncFinished")
        }
        schedulePendingNotePush()
    }

    func markLocalChangesPushed() {
        hasPendingLocalChanges = false
        requiresFullPush = false
        pendingNotePushes.removeAll()
        notePushTask?.cancel()
        notePushTask = nil
        pushRetryCount = 0
        notePushRetryCount = 0
        lastSuccessfulPushAt = Date()
        invalidatePendingPushTimer()
    }

    func flushPendingBeforeTermination() async {
        invalidatePendingPushTimer()
        guard hasPendingLocalChanges else { return }
        await runAutomaticPush(reason: "termination")
    }

    private var canUseAutoSync: Bool {
        backend.isConfigured && backend.isPersistenceAvailable
    }

    private func schedulePendingNotePush(after delay: TimeInterval = 0) {
        guard notePushTask == nil, !pendingNotePushes.isEmpty, canUseAutoSync else { return }

        notePushTask = Task { @MainActor [weak self] in
            if delay > 0 {
                let nanoseconds = UInt64(delay * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanoseconds)
            }
            guard !Task.isCancelled, let self else { return }
            await self.pushNextSavedNote()
        }
    }

    private func pushNextSavedNote() async {
        guard canUseAutoSync else {
            pendingNotePushes.removeAll()
            if !requiresFullPush {
                hasPendingLocalChanges = false
            }
            finishNotePushTask()
            return
        }
        guard !isAutomaticSyncRunning, !isManualSyncRunning else {
            finishNotePushTask(retryAfter: 1)
            return
        }
        guard let (noteID, pendingPush) = pendingNotePushes.first else {
            finishNotePushTask()
            return
        }

        isAutomaticSyncRunning = true
        setSidebarIndicatorSyncing()
        Logger.shared.log(
            .app,
            .debug,
            "[AutoSync] 开始推送已保存笔记: note=\(noteID.uuidString.prefix(8)) reason=\(pendingPush.reason)"
        )

        do {
            try await SyncSessionCoordinator.shared.withSession(named: "保存后推送笔记") {
                try await backend.pushSavedNote(noteID: noteID)
            }
            if pendingNotePushes[noteID]?.revision == pendingPush.revision {
                pendingNotePushes.removeValue(forKey: noteID)
            }
            notePushRetryCount = 0
            lastSuccessfulPushAt = Date()
            isAutomaticSyncRunning = false
            if pendingNotePushes.isEmpty && !requiresFullPush {
                hasPendingLocalChanges = false
            }
            setSidebarIndicatorSuccess()
            Logger.shared.log(.app, .info, "[AutoSync] 已保存笔记推送完成: note=\(noteID.uuidString.prefix(8))")
            finishNotePushTask()
        } catch let error as SyncSessionError {
            isAutomaticSyncRunning = false
            switch error {
            case .alreadyRunning:
                clearSidebarIndicator()
                finishNotePushTask(retryAfter: 1)
            }
        } catch {
            isAutomaticSyncRunning = false
            clearSidebarIndicator()
            notePushRetryCount += 1
            let retryDelay = min(
                pushRetryBaseInterval * pow(2.0, Double(max(0, notePushRetryCount - 1))),
                pushRetryMaxInterval
            )
            Logger.shared.log(
                .app,
                .error,
                "[AutoSync] 已保存笔记推送失败，稍后重试: note=\(noteID.uuidString.prefix(8)) error=\(error.localizedDescription)"
            )
            finishNotePushTask(retryAfter: retryDelay)
        }
    }

    private func finishNotePushTask(retryAfter delay: TimeInterval = 0) {
        notePushTask = nil
        if !pendingNotePushes.isEmpty {
            schedulePendingNotePush(after: delay)
        }
    }

    func waitForSavedNotePushesForTesting() async {
        while let task = notePushTask {
            await task.value
        }
    }

    var pendingSavedNotePushCountForTesting: Int {
        pendingNotePushes.count
    }

    func runAutomaticPullForTesting() async {
        await runAutomaticPull(reason: "test", force: true)
    }

    func runAutomaticPushForTesting() async {
        await runAutomaticPush(reason: "test")
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
        isAutomaticSyncRunning = true
        defer { isAutomaticSyncRunning = false }
        setSidebarIndicatorSyncing()
        Logger.shared.log(.app, .debug, "[AutoSync] 开始自动拉取: \(reason)")

        do {
            _ = try await SyncSessionCoordinator.shared.withSession(named: "自动拉取") {
                try await backend.pullAllNotes()
            }
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
        isAutomaticSyncRunning = true
        defer { isAutomaticSyncRunning = false }

        invalidatePendingPushTimer()
        setSidebarIndicatorSyncing()
        Logger.shared.log(.app, .debug, "[AutoSync] 开始自动推送: \(reason)")

        do {
            try await SyncSessionCoordinator.shared.withSession(named: "自动双向同步") {
                try await backend.pullAllNotes()
                lastSuccessfulPullAt = Date()

                try await backend.pushAllNotes()
            }
            hasPendingLocalChanges = false
            requiresFullPush = false
            pendingNotePushes.removeAll()
            notePushTask?.cancel()
            notePushTask = nil
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
