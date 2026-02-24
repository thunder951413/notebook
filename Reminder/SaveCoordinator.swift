import Foundation
import SwiftUI

/// 统一保存协调器：按 noteID 去抖/合并/串行，避免 AutoSave / Cmd+S / 切换笔记等触发导致竞态。
///
/// 设计目标：
/// 1) 保存内容来源以编辑器 NSTextView 为准（由调用方传入 snapshot）。
/// 2) 同一 noteID 在任意时刻最多只有一个保存任务在跑。
/// 3) 连续多次请求会合并成最后一次（last-write-wins）。
actor SaveCoordinator {
    static let shared = SaveCoordinator()

    struct SavePayload: Sendable {
        let noteID: UUID
        let version: Int64
        let title: String
        let folder: String
        let reminderAt: Date?
        let recurrenceRule: String
        let rtfdData: Data
        let reason: String
    }

    private var debounceTasks: [UUID: Task<Void, Never>] = [:]
    private var runningTasks: [UUID: Task<Void, Never>] = [:]
    private var pending: [UUID: SavePayload] = [:]

    /// 发起一次保存请求（会去抖并合并）。
    func requestSave(
        payload: SavePayload,
        debounce delay: TimeInterval = 0.6,
        perform: @escaping @Sendable (SavePayload) async -> Void
    ) {
        let id = payload.noteID
        pending[id] = payload

        // 重置去抖任务
        debounceTasks[id]?.cancel()
        debounceTasks[id] = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
            await self.startSaveIfPossible(noteID: id, perform: perform)
        }
    }

    /// 立即保存（跳过去抖），但仍然合并并保证串行。
    func flush(
        payload: SavePayload,
        perform: @escaping @Sendable (SavePayload) async -> Void
    ) {
        let id = payload.noteID
        pending[id] = payload
        debounceTasks[id]?.cancel()
        debounceTasks[id] = nil
        Task { [weak self] in
            guard let self = self else { return }
            await self.startSaveIfPossible(noteID: id, perform: perform)
        }
    }

    /// 立即保存并等待完成（同步阻塞版本，用于切换笔记等关键场景）
    func flushAndWait(
        payload: SavePayload,
        perform: @escaping @Sendable (SavePayload) async -> Void
    ) async {
        let id = payload.noteID
        pending[id] = payload
        debounceTasks[id]?.cancel()
        debounceTasks[id] = nil

        // 等待当前正在运行的保存任务完成
        if let runningTask = runningTasks[id] {
            await runningTask.value
        }

        // 执行本次保存
        await startSaveIfPossible(noteID: id, perform: perform)

        // 等待本次保存完成
        if let task = runningTasks[id] {
            await task.value
        }
    }

    /// 取消某条笔记尚未执行的去抖保存（切换笔记时可用）。
    func cancelDebounce(noteID: UUID) {
        debounceTasks[noteID]?.cancel()
        debounceTasks[noteID] = nil
    }

    private func startSaveIfPossible(
        noteID: UUID,
        perform: @escaping @Sendable (SavePayload) async -> Void
    ) async {
        // 已有保存在跑：不并发，等当前结束后会自动检查 pending
        if runningTasks[noteID] != nil {
            return
        }

        guard let payload = pending[noteID] else {
            return
        }

        // 取出本轮要保存的最新 payload
        pending[noteID] = nil

        let task = Task {
            await perform(payload)
            await self.finishSave(noteID: noteID, perform: perform)
        }

        runningTasks[noteID] = task
    }

    private func finishSave(
        noteID: UUID,
        perform: @escaping @Sendable (SavePayload) async -> Void
    ) async {
        runningTasks[noteID] = nil

        // 如果保存过程中又来了新的请求，则继续保存（last-write-wins）
        if pending[noteID] != nil {
            await startSaveIfPossible(noteID: noteID, perform: perform)
        }
    }
}
