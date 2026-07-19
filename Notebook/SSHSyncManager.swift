import Foundation
import SwiftData
import CryptoKit
import Dispatch

struct RemoteRepositoryRebuildResult: Sendable {
    let repositoryPath: String
    let noteCount: Int
    let assetCount: Int
}

/// SSH 同步管理器 - 使用 sshpass 进行密码认证
///
/// ## 并发安全
/// 可变状态全部封装在内部 `SSHSyncState` actor 中，由 actor 模型自动串行化访问。
/// 不可变属性（`noteDownloadConcurrencyLimit` / `assetDownloadConcurrencyLimit`）天然 Sendable。
/// 因此本类不再需要 `@unchecked Sendable` 标记。
final class SSHSyncManager: Sendable {
    static let shared = SSHSyncManager()

    private typealias ProcessExecutionResult = ProcessExecutionOutput

    private struct RemoteSyncCacheState: Codable {
        let noteIndexHash: String?
        let noteIndexPayload: Data?
        let assetsManifestHash: String?
        let assetsManifestPayload: Data?
        let updatedAt: Date
    }

    private struct RemoteNoteIndexBundle {
        let index: RemoteNoteIndex?
        let payloadHash: String?
        let payload: Data?
    }

    private struct AssetsManifestBundle {
        let manifest: AssetsManifest?
        let payloadHash: String?
        let payload: Data?
    }

    private struct RemoteFileDigestProbe {
        let exists: Bool
        let digest: String?
    }

    private struct RemoteNotePayloadDownload {
        let noteID: UUID
        let payload: Data?
        let isMissing: Bool
    }

    private struct AssetDownloadJob {
        let relativePath: String
        let localURL: URL
        let expectedHash: String?
    }

    private let noteDownloadConcurrencyLimit = 4
    private let assetDownloadConcurrencyLimit = 4

    // SSH 连接复用相关
    /// 内部同步状态 actor，自动串行化所有可变状态访问
    private let state = SSHSyncState()

    private init() {}

    var isSyncOperationRunning: Bool {
        get async {
            await state.isSyncOperationRunning()
        }
    }

    private func beginSyncOperation(named operationName: String) async throws {
        let runningOperation = await state.beginSyncOperation(named: operationName)

        if let runningOperation {
            throw NSError(
                domain: "SSHSync",
                code: -2001,
                userInfo: [NSLocalizedDescriptionKey: "已有同步任务正在执行：\(runningOperation)"]
            )
        }
    }

    private func endSyncOperation() async {
        await state.endSyncOperation()
    }

    /// 包裹一个同步操作体，保证 begin/end 配对且无竞态。
    ///
    /// 相比 `defer { Task { await endSyncOperation() } }`，此 helper 在 body 抛错或返回前
    /// 同步 await 完清理，避免清理 Task 排在下一个调用者的 beginSyncOperation 之后执行。
    private func withSyncOperation<T>(
        named operationName: String,
        _ body: () async throws -> T
    ) async throws -> T {
        try await beginSyncOperation(named: operationName)
        do {
            let result = try await body()
            await endSyncOperation()
            return result
        } catch {
            await endSyncOperation()
            throw error
        }
    }

    /// 生成 SSH ControlPath
    private func sshControlPath(for config: SSHConfig) -> String {
        let sanitizedHost = config.host.replacingOccurrences(of: "/", with: "_")
        return "/tmp/ssh-notebook-\(config.username)@\(sanitizedHost)-\(config.port)"
    }

    /// 建立 SSH 主连接（用于连接复用）
    private func establishControlMasterConnection(
        sshpassPath: String,
        config: SSHConfig
    ) async throws {
        let controlPath = sshControlPath(for: config)

        // 检查是否已经建立了主连接
        let alreadyActive = await state.containsControlMasterPath(controlPath)
        if alreadyActive {
            return
        }

        // 检查控制 socket 是否已存在
        if FileManager.default.fileExists(atPath: controlPath) {
            // 验证连接是否仍然活跃
            let checkResult = try await executeProcess(
                executablePath: sshpassPath,
                arguments: [
                    "-e",
                    "ssh",
                    "-o", "ControlPath=\(controlPath)",
                    "-o", "ControlMaster=no",
                    "-o", "BatchMode=yes",
                    "-o", "ConnectTimeout=5",
                    "-p", String(config.port),
                    "\(config.username)@\(config.host)",
                    "echo CONNECTED"
                ],
                password: config.password,
                timeout: 10
            )
            if checkResult.terminationStatus == 0 && checkResult.standardOutput.contains("CONNECTED") {
                await state.insertControlMasterPath(controlPath)
                return
            } else {
                // 旧连接已失效，清理
                try? FileManager.default.removeItem(atPath: controlPath)
            }
        }

        // 建立新的主连接
        let connectionArguments = [
            "-e",
            "ssh",
            "-f",  // 后台运行
            "-N",  // 不执行远程命令
            "-o", "ControlMaster=yes",
            "-o", "ControlPath=\(controlPath)",
            "-o", "ControlPersist=600"  // 10 分钟无连接自动关闭
        ] + SSHHostKeyPolicy.options + [
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "ConnectTimeout=15",
            "-p", String(config.port),
            "\(config.username)@\(config.host)"
        ]
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: connectionArguments,
            password: config.password,
            timeout: 20
        )

        if result.terminationStatus != 0 {
            let errorMessage = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "SSHSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog("建立 SSH 主连接失败: \(errorMessage)", password: config.password)]
            )
        }

        await state.insertControlMasterPath(controlPath)

        Logger.shared.log(.storage, .info, "[SSHSync] SSH 主连接已建立: \(config.username)@\(config.host):\(config.port)")
    }

    /// 关闭 SSH 主连接
    private func closeControlMasterConnection(config: SSHConfig) async {
        let controlPath = sshControlPath(for: config)

        let didRemove = await state.removeControlMasterPath(controlPath)
        guard didRemove else { return }

        // 发送退出信号给 ControlMaster；退出清理也必须有超时并响应 Task 取消，
        // 避免 ssh -O exit 异常时卡住整个应用退出流程。
        let arguments = [
            "-o", "ControlPath=\(controlPath)",
            "-o", "ControlMaster=no",
            "-O", "exit",
            "\(config.username)@\(config.host)"
        ]

        do {
            let result = try await CancellableProcessRunner.run(
                executablePath: "/usr/bin/ssh",
                arguments: arguments,
                environment: ProcessInfo.processInfo.environment,
                timeout: 3,
                timeoutError: NSError(
                    domain: "SSHSync",
                    code: -2002,
                    userInfo: [NSLocalizedDescriptionKey: "关闭 SSH 主连接超时"]
                )
            )
            if result.terminationStatus == 0 {
                Logger.shared.log(.storage, .debug, "[SSHSync] SSH 主连接已关闭: \(config.username)@\(config.host):\(config.port)")
            } else {
                Logger.shared.log(.storage, .warn, "[SSHSync] SSH 主连接退出码: \(result.terminationStatus)")
            }
        } catch {
            Logger.shared.log(.storage, .warn, "[SSHSync] 关闭 SSH 主连接失败: \(error.localizedDescription)")
        }

        // 清理控制 socket 文件
        try? FileManager.default.removeItem(atPath: controlPath)
    }

    /// 关闭所有活跃的 SSH 主连接
    func closeAllControlMasterConnections() async {
        let paths = await state.snapshotControlMasterPaths()

        for path in paths {
            if let config = extractConfigFromControlPath(path) {
                await closeControlMasterConnection(config: config)
            }
        }
    }

    /// 从 ControlPath 提取配置（用于清理）
    private func extractConfigFromControlPath(_ controlPath: String) -> SSHConfig? {
        // 解析格式: /tmp/ssh-notebook-username@host-port
        let prefix = "/tmp/ssh-notebook-"
        guard controlPath.hasPrefix(prefix) else { return nil }

        let identifier = String(controlPath.dropFirst(prefix.count))
        let parts = identifier.split(separator: "@")
        guard parts.count == 2 else { return nil }

        let username = String(parts[0])
        let hostAndPort = String(parts[1]).split(separator: "-")
        guard hostAndPort.count >= 2 else { return nil }

        let port = Int(String(hostAndPort.last ?? "22")) ?? 22
        let host = hostAndPort.dropLast().joined(separator: "-")

        let config = SSHConfig(
            host: host,
            port: port,
            username: username,
            password: "",
            repositoryPath: ""
        )
        return config
    }

    /// 查找 sshpass 可执行文件路径 - 简化版本
    private func findSshpassPath() -> String? {
        SSHProcessTransport.findSSHpassPath()
    }

    /// 检查 sshpass 是否可用
    private func checkSshpassAvailable() throws -> String {
        if let path = findSshpassPath(), !path.isEmpty {
            return path
        }
        throw NSError(
            domain: "SSHSync",
            code: -1000,
            userInfo: [NSLocalizedDescriptionKey: "未找到 sshpass，请先安装后再配置 SSH 同步"]
        )
    }

    private static func sanitizeLog(_ text: String, password: String) -> String {
        let redacted = password.isEmpty ? text : text.replacingOccurrences(of: password, with: "******")
        let filteredLines = redacted
            .components(separatedBy: .newlines)
            .filter { line in
                let lowercased = line.lowercased()
                return !lowercased.contains("warning: permanently added")
                    && !lowercased.contains("permanently added")
            }
        let filtered = filteredLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return filtered.isEmpty ? redacted.trimmingCharacters(in: .whitespacesAndNewlines) : filtered
    }

    /// 使用密码认证测试连接
    func testConnectionWithPassword(config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: sshArguments(config: config, command: "echo NB_CONNECTION_SUCCESS"),
            password: config.password
        )
        let output = result.standardOutput
        let errorOutput = result.standardError

        Logger.shared.log(.storage, .debug, "SSH Test Output: \(Self.sanitizeLog(output, password: config.password))")
        Logger.shared.log(.storage, .debug, "SSH Test Error: \(Self.sanitizeLog(errorOutput, password: config.password))")
        Logger.shared.log(.storage, .debug, "SSH Test Exit Code: \(result.terminationStatus)")

        if result.terminationStatus != 0 {
            var errorMessage = "连接失败"
            if errorOutput.contains("Permission denied") || output.contains("Permission denied") {
                errorMessage = "认证失败：用户名或密码错误，或服务器未允许该用户使用密码登录"
            } else if errorOutput.contains("Connection refused") || output.contains("Connection refused") {
                errorMessage = "连接被拒绝：请检查主机地址和端口"
            } else if errorOutput.contains("timeout") || output.contains("timeout") || errorOutput.contains("Connection timed out") {
                errorMessage = "连接超时：请检查网络或防火墙设置"
            } else if errorOutput.contains("Could not resolve") || output.contains("Could not resolve") {
                errorMessage = "无法解析主机名：请检查服务器地址"
            } else if errorOutput.contains("Host key verification failed") || output.contains("Host key verification failed") {
                errorMessage = "主机指纹验证失败：请删除本机 known_hosts 中旧记录后重试"
            } else if errorOutput.contains("no matching host key type found") || output.contains("no matching host key type found") {
                errorMessage = "SSH 算法不兼容：请在服务器启用现代主机密钥算法"
            } else if errorOutput.contains("Bad port") || output.contains("Bad port") {
                errorMessage = "端口号无效"
            } else if errorOutput.contains("sshpass") && (errorOutput.contains("not found") || errorOutput.contains("No such file")) {
                errorMessage = "未找到 sshpass，请先运行: brew install sshpass"
            }
            throw NSError(domain: "SSHConnection", code: Int(result.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMessage])
        }

        if !output.contains("NB_CONNECTION_SUCCESS") {
            throw NSError(domain: "SSHConnection", code: -1, userInfo: [NSLocalizedDescriptionKey: "连接验证失败，未收到服务器响应"])
        }
    }

    /// 确保远程目录存在
    func ensureRemoteDirectory(config: SSHConfig, controlPath: String? = nil) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let repositoryPath = try SSHRemotePath.normalizedRepositoryPath(config.repositoryPath)
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p \(SSHRemotePath.shellQuoted(repositoryPath))",
            controlPath: controlPath
        )
    }

    private func withRemoteRepositoryWriteLock<T>(
        config: SSHConfig,
        controlPath: String?,
        _ body: (RemoteRepositoryWriteLock) async throws -> T
    ) async throws -> T {
        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config, controlPath: controlPath)
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p \(shellQuotedRemotePath("\(config.repositoryPath)/notes"))",
            controlPath: controlPath
        )

        let lock = RemoteRepositoryWriteLock.make(repositoryPath: config.repositoryPath)
        do {
            try await runSSHCommand(
                sshpassPath: sshpassPath,
                config: config,
                command: lock.acquireCommand,
                controlPath: controlPath
            )
        } catch {
            // Acquisition may have reached the server just before local task
            // cancellation. Owner-aware cleanup is safe even if mkdir failed.
            try? await releaseRemoteRepositoryWriteLock(
                lock,
                sshpassPath: sshpassPath,
                config: config,
                controlPath: controlPath
            )
            let nsError = error as NSError
            if nsError.domain == "SSHSync", nsError.code == 75 {
                throw NSError(
                    domain: "SSHSync",
                    code: -2020,
                    userInfo: [NSLocalizedDescriptionKey: "另一个设备正在发布远程数据，请稍后重试"]
                )
            }
            throw error
        }

        do {
            let result = try await body(lock)
            try await releaseRemoteRepositoryWriteLock(
                lock,
                sshpassPath: sshpassPath,
                config: config,
                controlPath: controlPath
            )
            return result
        } catch {
            do {
                try await releaseRemoteRepositoryWriteLock(
                    lock,
                    sshpassPath: sshpassPath,
                    config: config,
                    controlPath: controlPath
                )
            } catch {
                Logger.shared.log(.storage, .error, "[SSHSync] 释放远程发布锁失败：\(error.localizedDescription)")
            }
            throw error
        }
    }

    private func releaseRemoteRepositoryWriteLock(
        _ lock: RemoteRepositoryWriteLock,
        sshpassPath: String,
        config: SSHConfig,
        controlPath: String?
    ) async throws {
        // A cancelled parent task must still release its owned lease. The
        // detached cleanup does not inherit cancellation, but is awaited so the
        // next sync cannot race ahead of lock cleanup.
        let cleanup = Task.detached {
            try await self.runSSHCommand(
                sshpassPath: sshpassPath,
                config: config,
                command: lock.releaseCommand,
                controlPath: controlPath
            )
        }
        try await cleanup.value
    }

    private func refreshRemoteRepositoryWriteLock(
        _ lock: RemoteRepositoryWriteLock,
        config: SSHConfig,
        controlPath: String?
    ) async throws {
        try await runSSHCommand(
            sshpassPath: try checkSshpassAvailable(),
            config: config,
            command: lock.refreshCommand,
            controlPath: controlPath
        )
    }

    @discardableResult
    func syncNoteToRemote(
        noteID: UUID,
        context: ModelContext,
        config: SSHConfig,
        controlPath: String? = nil,
        updateRemoteCatalog: Bool = true,
        recordSyncState: Bool = true,
        remoteLockAlreadyHeld: Bool = false,
        remotePublicationValidated: Bool = false
    ) async throws -> VersionedNoteSyncEnvelope? {
        if !remoteLockAlreadyHeld {
            return try await withRemoteRepositoryWriteLock(config: config, controlPath: controlPath) { _ in
                try await syncNoteToRemote(
                    noteID: noteID,
                    context: context,
                    config: config,
                    controlPath: controlPath,
                    updateRemoteCatalog: updateRemoteCatalog,
                    recordSyncState: recordSyncState,
                    remoteLockAlreadyHeld: true,
                    remotePublicationValidated: remotePublicationValidated
                )
            }
        }

        guard let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: noteID, context: context) else {
            return nil
        }

        let localEntry = RemoteNoteIndexEntry(
            noteID: noteID,
            version: envelope.currentVersion,
            contentHash: try BlockDocumentNoteVersionStore.snapshotFingerprint(envelope.currentSnapshot),
            historyCount: envelope.history.count
        )
        if !remotePublicationValidated {
            let remoteIndex = try await downloadRemoteIndexBundle(config: config, controlPath: controlPath).index
            try validateRemotePublication(localEntry: localEntry, remoteIndex: remoteIndex)
        }

        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config, controlPath: controlPath)

        let remoteNoteDirectory = "\(config.repositoryPath)/notes"
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p \(shellQuotedRemotePath(remoteNoteDirectory))",
            controlPath: controlPath
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(envelope)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("note_sync_\(noteID.uuidString)_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTargetPath = "\(remoteNoteDirectory)/\(noteID.uuidString).json"

        // Publish dependencies first. If anything fails, the existing note JSON
        // remains authoritative and newly uploaded assets are only harmless orphans.
        try await uploadAssetsForNote(
            envelope: envelope,
            sshpassPath: sshpassPath,
            config: config,
            controlPath: controlPath
        )

        try await uploadVerifiedFileAtomically(
            localURL: tempFileURL,
            expectedDigest: Self.payloadDigest(for: payload),
            remoteTargetPath: remoteTargetPath,
            sshpassPath: sshpassPath,
            config: config,
            controlPath: controlPath
        )

        if updateRemoteCatalog {
            try await updateRemoteCatalogForSingleNote(
                envelope: envelope,
                context: context,
                config: config,
                controlPath: controlPath
            )
        }

        // Only mark the exact uploaded envelope as synced after the catalog
        // publication point has succeeded. A failed index write must remain dirty.
        if recordSyncState {
            try BlockDocumentNoteVersionStore.markSynced(envelope: envelope, context: context)
        }
        return envelope
    }

    private func validateRemotePublication(
        localEntry: RemoteNoteIndexEntry,
        remoteIndex: RemoteNoteIndex?
    ) throws {
        guard let rejection = RemoteNotePublicationGuard.rejection(
            localEntry: localEntry,
            remoteIndex: remoteIndex
        ) else { return }

        let message: String
        switch rejection {
        case .remoteVersionIsNewer(let version):
            message = "远程笔记已有较新版本（v\(version)），已停止推送，请先拉取并处理冲突"
        case .sameVersionHasDifferentContent:
            message = "远程笔记与本地笔记版本号相同但内容不同，已停止推送以防覆盖"
        case .remotelyDeleted:
            message = "远程笔记已有删除记录，已停止推送，请先拉取确认"
        }
        throw NSError(
            domain: "SSHSync",
            code: -2021,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    func syncAllNotesToRemote(
        context: ModelContext,
        config: SSHConfig,
        progressHandler: SSHSyncProgressHandler? = nil,
        forceUploadAll: Bool = false,
        recordSyncState: Bool = true,
        pruneHistoryAfterPush: Bool = true
    ) async throws -> [UUID] {
        try await withSyncOperation(named: "推送笔记") {
            let sshpassPath = try checkSshpassAvailable()
            let controlPath = sshControlPath(for: config)

            // 建立 SSH 主连接
            try await establishControlMasterConnection(sshpassPath: sshpassPath, config: config)

            // 注意：control master 关闭仍走 defer + Task，
            // 因为它不参与互斥锁的 begin/end 状态，仅是 socket 资源清理，
            // 排在后面执行只会延后释放 socket，不影响下一次同步语义。
            defer {
                Task { await closeControlMasterConnection(config: config) }
            }

            return try await withRemoteRepositoryWriteLock(config: config, controlPath: controlPath) { remoteLock in
            let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
                .sorted { $0.updatedAt > $1.updatedAt }
            let existingNoteIDs = Set(notes.map { $0.id })
            let tombstonedNoteIDs = Set(try BlockDocumentNoteVersionStore.deletedTombstones(context: context).map(\.noteID))
            var syncedNoteIDs: [UUID] = []
            var uploadedEnvelopes: [VersionedNoteSyncEnvelope] = []
            var indexEntries: [RemoteNoteIndexEntry] = []
            var allAssetEntries: [AssetsManifestEntry] = []
            let totalNotes = max(notes.count, 1)
            let publishableNoteIDs = Set(notes.lazy.filter {
                !tombstonedNoteIDs.contains($0.id) && !$0.hasConflict
            }.map(\.id))
            let remoteIndexForValidation = try await downloadRemoteIndexBundle(
                config: config,
                controlPath: controlPath
            ).index
            var noteIDsToUpload: Set<UUID> = []

            // Validate every candidate before changing any remote note payload.
            // This prevents a later conflict from leaving earlier payloads ahead
            // of the still-unpublished index.
            for note in notes where publishableNoteIDs.contains(note.id) {
                let syncState = try fetchSyncState(noteID: note.id, context: context)
                let hasPendingChanges = syncState.map {
                    $0.lastSyncedVersion < note.version || $0.pendingHistoryCount > 0
                } ?? true
                guard forceUploadAll || hasPendingChanges else { continue }
                if let entry = try makeRemoteIndexEntry(noteID: note.id, context: context) {
                    try validateRemotePublication(localEntry: entry, remoteIndex: remoteIndexForValidation)
                    noteIDsToUpload.insert(note.id)
                }
            }

            await reportProgress(
                progressHandler,
                phase: .pushNotes,
                current: notes.isEmpty ? 1 : 0,
                total: totalNotes,
                message: notes.isEmpty ? "没有需要推送的笔记，正在整理远程索引..." : "正在推送笔记 0/\(notes.count)"
            )

            for (index, note) in notes.enumerated() {
                try await refreshRemoteRepositoryWriteLock(remoteLock, config: config, controlPath: controlPath)
                guard !tombstonedNoteIDs.contains(note.id) else {
                    await reportProgress(
                        progressHandler,
                        phase: .pushNotes,
                        current: index + 1,
                        total: totalNotes,
                        message: "跳过已永久删除笔记 \(index + 1)/\(notes.count)"
                    )
                    continue
                }

                let shouldSync = noteIDsToUpload.contains(note.id)
                if shouldSync {
                    if let uploadedEnvelope = try await syncNoteToRemote(
                        noteID: note.id,
                        context: context,
                        config: config,
                        controlPath: controlPath,
                        updateRemoteCatalog: false,
                        recordSyncState: false,
                        remoteLockAlreadyHeld: true,
                        remotePublicationValidated: true
                    ) {
                        uploadedEnvelopes.append(uploadedEnvelope)
                    }
                    syncedNoteIDs.append(note.id)
                }
                if publishableNoteIDs.contains(note.id),
                   let entry = try makeRemoteIndexEntry(noteID: note.id, context: context) {
                    indexEntries.append(entry)
                }

                // 收集附件清单
                if publishableNoteIDs.contains(note.id),
                   let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: note.id, context: context) {
                    allAssetEntries.append(contentsOf: try collectAssetsManifestEntries(from: envelope))
                }

                await reportProgress(
                    progressHandler,
                    phase: .pushNotes,
                    current: index + 1,
                    total: totalNotes,
                    message: "正在处理笔记 \(index + 1)/\(notes.count)"
                )
            }

            // 收集本地已永久删除的笔记记录
            let deletedEntries = try collectLocallyDeletedEntries(
                existingNoteIDs: existingNoteIDs,
                context: context
            )

            try await refreshRemoteRepositoryWriteLock(remoteLock, config: config, controlPath: controlPath)
            try await uploadAssetsManifest(
                entries: allAssetEntries,
                replacingEntriesForNoteIDs: publishableNoteIDs,
                config: config,
                controlPath: controlPath
            )
            await reportProgress(
                progressHandler,
                phase: .pushLibrary,
                current: 0,
                total: 1,
                message: "正在同步文件夹和标签..."
            )
            try await syncLibraryToRemote(context: context, config: config, controlPath: controlPath)
            try await refreshRemoteRepositoryWriteLock(remoteLock, config: config, controlPath: controlPath)
            try await syncReadingPositionsToRemote(context: context, config: config, controlPath: controlPath)

            // index.json is the repository publication point. Commit it last so
            // readers never observe references to files that are not yet present.
            await reportProgress(
                progressHandler,
                phase: .pushConfig,
                current: 0,
                total: 1,
                message: "正在发布远程索引..."
            )
            try await refreshRemoteRepositoryWriteLock(remoteLock, config: config, controlPath: controlPath)
            try await uploadRemoteIndex(
                entries: indexEntries,
                deletedEntries: deletedEntries,
                config: config,
                controlPath: controlPath,
                remoteLockAlreadyHeld: true
            )

            if recordSyncState {
                for envelope in uploadedEnvelopes {
                    try BlockDocumentNoteVersionStore.markSynced(envelope: envelope, context: context)
                }
            }

            cleanupDeletedSyncStates(
                deletedNoteIDs: Set(deletedEntries.map { $0.noteID }),
                context: context
            )
            await reportProgress(
                progressHandler,
                phase: .pushLibrary,
                current: 1,
                total: 1,
                message: "文件夹和标签同步完成"
            )

            if pruneHistoryAfterPush {
                // 裁剪历史版本，避免无限增长
                for note in notes {
                    try? BlockDocumentNoteVersionStore.pruneHistory(noteID: note.id, context: context)
                }
            }

            return syncedNoteIDs
            }
        }
    }

    /// Rebuilds the repository in a new sibling directory, validates the remote
    /// catalog, and leaves the current repository untouched. The caller switches
    /// the persisted SSH configuration only after this method returns success.
    func rebuildRemoteRepository(
        context: ModelContext,
        config: SSHConfig,
        destinationPath: String,
        progressHandler: SSHSyncProgressHandler? = nil
    ) async throws -> RemoteRepositoryRebuildResult {
        let normalizedCurrentPath = try SSHRemotePath.normalizedRepositoryPath(config.repositoryPath)
        let normalizedDestinationPath = try SSHRemotePath.normalizedRepositoryPath(destinationPath)
        guard normalizedDestinationPath != normalizedCurrentPath else {
            throw NSError(
                domain: "SSHSync",
                code: -2010,
                userInfo: [NSLocalizedDescriptionKey: "无损重建必须使用新的远程目录"]
            )
        }

        // Merge the current remote repository first so a note created only on
        // another device is not omitted from the new repository.
        _ = try await syncAllNotesFromRemote(
            context: context,
            config: config,
            progressHandler: progressHandler
        )

        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
        let tombstonedNoteIDs = Set(
            try BlockDocumentNoteVersionStore.deletedTombstones(context: context).map(\.noteID)
        )
        let activeNotes = notes.filter { !tombstonedNoteIDs.contains($0.id) }
        guard !activeNotes.contains(where: \.hasConflict) else {
            throw NSError(
                domain: "SSHSync",
                code: -2011,
                userInfo: [NSLocalizedDescriptionKey: "存在尚未解决的同步冲突，请先处理冲突再重建远程仓库"]
            )
        }

        var destinationConfig = SSHConfig(
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            repositoryPath: normalizedDestinationPath
        )
        destinationConfig.password = config.password

        let sshpassPath = try checkSshpassAvailable()
        let existence = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: destinationConfig,
            command: "if [ -e \(SSHRemotePath.shellQuoted(normalizedDestinationPath)) ]; then echo EXISTS; else echo MISSING; fi"
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard existence == "MISSING" else {
            throw NSError(
                domain: "SSHSync",
                code: -2012,
                userInfo: [NSLocalizedDescriptionKey: "新的远程目录已经存在，未覆盖任何数据"]
            )
        }

        _ = try await syncAllNotesToRemote(
            context: context,
            config: destinationConfig,
            progressHandler: progressHandler,
            forceUploadAll: true,
            recordSyncState: false,
            pruneHistoryAfterPush: false
        )

        let expectedEntries = try activeNotes.reduce(into: [UUID: RemoteNoteIndexEntry]()) { result, note in
            if let entry = try makeRemoteIndexEntry(noteID: note.id, context: context) {
                result[note.id] = entry
            }
        }
        let remoteIndex = try await downloadRemoteIndexBundle(config: destinationConfig, controlPath: nil).index
        let remoteEntries = (remoteIndex?.entries ?? []).reduce(into: [UUID: RemoteNoteIndexEntry]()) {
            $0[$1.noteID] = $1
        }
        guard remoteEntries.count == expectedEntries.count,
              expectedEntries.allSatisfy({ pair in
                  guard let actual = remoteEntries[pair.key] else { return false }
                  return actual.version == pair.value.version && actual.contentHash == pair.value.contentHash
              }) else {
            throw NSError(
                domain: "SSHSync",
                code: -2013,
                userInfo: [NSLocalizedDescriptionKey: "新远程目录的笔记索引校验失败，原目录和配置均未改变"]
            )
        }

        var expectedAssets: [String: AssetsManifestEntry] = [:]
        for note in activeNotes {
            if let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: note.id, context: context) {
                for entry in try collectAssetsManifestEntries(from: envelope) {
                    expectedAssets[entry.relativePath] = entry
                }
            }
        }
        let remoteManifest = try await downloadAssetsManifestBundle(config: destinationConfig, controlPath: nil).manifest
        let remoteAssets = (remoteManifest?.entries ?? []).reduce(into: [String: AssetsManifestEntry]()) {
            $0[$1.relativePath] = $1
        }
        guard remoteAssets.count == expectedAssets.count,
              expectedAssets.allSatisfy({ pair in
                  guard let actual = remoteAssets[pair.key] else { return false }
                  return actual.contentHash == pair.value.contentHash && actual.size == pair.value.size
              }) else {
            throw NSError(
                domain: "SSHSync",
                code: -2014,
                userInfo: [NSLocalizedDescriptionKey: "新远程目录的附件清单校验失败，原目录和配置均未改变"]
            )
        }

        for note in activeNotes {
            if let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: note.id, context: context) {
                try BlockDocumentNoteVersionStore.markSynced(envelope: envelope, context: context)
            }
        }
        return RemoteRepositoryRebuildResult(
            repositoryPath: normalizedDestinationPath,
            noteCount: expectedEntries.count,
            assetCount: expectedAssets.count
        )
    }

    func syncNoteFromRemote(noteID: UUID, context: ModelContext, config: SSHConfig) async throws -> NoteSyncMergeResult {
        let sshpassPath = try checkSshpassAvailable()
        let payload = try await downloadRemoteNotePayload(
            noteID: noteID,
            sshpassPath: sshpassPath,
            config: config,
            controlPath: nil
        )
        return try await syncDownloadedRemoteNotePayload(
            noteID: noteID,
            payload: payload,
            context: context,
            sshpassPath: sshpassPath,
            config: config
        )
    }

    func syncAllNotesFromRemote(
        context: ModelContext,
        config: SSHConfig,
        progressHandler: SSHSyncProgressHandler? = nil
    ) async throws -> [NoteSyncMergeResult] {
        try await withSyncOperation(named: "拉取笔记") {
            let sshpassPath = try checkSshpassAvailable()
            let controlPath = sshControlPath(for: config)

            // 建立 SSH 主连接
            try await establishControlMasterConnection(sshpassPath: sshpassPath, config: config)

            // control master 关闭不参与 begin/end 互斥，延后释放 socket 即可
            defer {
                Task { await closeControlMasterConnection(config: config) }
            }

            // 先拉取文件夹和标签
            await reportProgress(
                progressHandler,
                phase: .pullLibrary,
                current: 0,
                total: 1,
                message: "正在拉取文件夹和标签..."
            )
            try await syncLibraryFromRemote(context: context, config: config, controlPath: controlPath)
            try await syncReadingPositionsFromRemote(context: context, config: config, controlPath: controlPath)
            await reportProgress(
                progressHandler,
                phase: .pullLibrary,
                current: 1,
                total: 1,
                message: "文件夹和标签拉取完成"
            )

            let cachedSyncState = loadRemoteSyncCacheState(config: config)
            let remoteIndexBundle = try await resolveRemoteIndexBundle(config: config, cachedState: cachedSyncState, controlPath: controlPath)
            let remoteManifestBundle = try await resolveAssetsManifestBundle(config: config, cachedState: cachedSyncState, controlPath: controlPath)
            let remoteAssetMap = remoteManifestBundle.manifest?.entries.reduce(into: [String: AssetsManifestEntry]()) {
                $0[$1.relativePath] = $1
            } ?? [:]
            var finalNoteIndexHash = remoteIndexBundle.payloadHash
            var finalNoteIndexPayload = remoteIndexBundle.payload
            let finalAssetsManifestHash = remoteManifestBundle.payloadHash
            let finalAssetsManifestPayload = remoteManifestBundle.payload

            guard let remoteIndex = remoteIndexBundle.index else {
                // index.json 不存在视为空仓库，不做任何拉取
                // 但仍需处理本地已有笔记的补充附件下载
                Logger.shared.log(.storage, .info, "[SSHSync] 远程 index.json 不存在，视为空仓库")
                await reportProgress(
                    progressHandler,
                    phase: .pullNotes,
                    current: 1,
                    total: 1,
                    message: "远程暂无可拉取的笔记"
                )
                _ = try await downloadMissingAssetsForExistingNotes(
                    context: context,
                    config: config,
                    remoteManifest: remoteManifestBundle.manifest,
                    progressHandler: progressHandler,
                    controlPath: controlPath
                )
                saveRemoteSyncCacheState(
                    RemoteSyncCacheState(
                        noteIndexHash: finalNoteIndexHash,
                        noteIndexPayload: finalNoteIndexPayload,
                        assetsManifestHash: finalAssetsManifestHash,
                        assetsManifestPayload: finalAssetsManifestPayload,
                        updatedAt: Date()
                    ),
                    config: config
                )
                return []
            }

            let didRemoteIndexChange = remoteIndexBundle.payloadHash == nil || remoteIndexBundle.payloadHash != cachedSyncState?.noteIndexHash

            // Tombstones are idempotent and must also be applied when a local
            // restore reintroduces an old note while the cached index hash stays
            // unchanged.
            try applyRemoteDeletedEntries(remoteIndex.deletedEntries, context: context)

            // 过滤出需要拉取的笔记（排除已在 deletedEntries 中的）
            let remoteDeletedIDs = Set(remoteIndex.deletedEntries.map { $0.noteID })
            let localNoteIDs = Set(
                try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>()).map(\.id)
            )
            let noteIDs = remoteIndex.entries
                .filter { entry in
                    guard !remoteDeletedIDs.contains(entry.noteID) else { return false }
                    let syncState = try? fetchSyncState(noteID: entry.noteID, context: context)
                    return RemoteNoteFetchPolicy.shouldFetch(
                        isLocallyPresent: localNoteIDs.contains(entry.noteID),
                        didRemoteIndexChange: didRemoteIndexChange,
                        remoteVersion: entry.version,
                        lastRemoteVersion: syncState?.lastRemoteVersion,
                        remoteContentHash: entry.contentHash,
                        lastRemoteFingerprint: syncState?.remoteFingerprint
                    )
                }
                .map(\.noteID)
                .sorted { $0.uuidString < $1.uuidString }
            let totalNotes = max(noteIDs.count, 1)

            await reportProgress(
                progressHandler,
                phase: .pullNotes,
                current: noteIDs.isEmpty ? 1 : 0,
                total: totalNotes,
                message: didRemoteIndexChange
                    ? (noteIDs.isEmpty ? "远程笔记清单有更新，但没有需要拉取的笔记" : "正在拉取笔记 0/\(noteIDs.count)")
                    : "远程笔记清单未变化，跳过笔记下载"
            )

            let syncOutcome = try await syncRemoteNotesInBatches(
                noteIDs: noteIDs,
                context: context,
                config: config,
                remoteAssetMap: remoteAssetMap,
                hasRemoteAssetsManifest: remoteManifestBundle.manifest != nil,
                progressHandler: progressHandler,
                controlPath: controlPath
            )
            let results = syncOutcome.results
            let missingRemoteNoteIDs = syncOutcome.missingRemoteNoteIDs

            if !missingRemoteNoteIDs.isEmpty {
                do {
                    let healedIndex = try await healRemoteIndex(
                        remoteIndex,
                        removingMissingNoteIDs: Set(missingRemoteNoteIDs),
                        config: config,
                        controlPath: controlPath
                    )
                    finalNoteIndexPayload = try encodeRemoteNoteIndex(healedIndex)
                    if let finalNoteIndexPayload {
                        finalNoteIndexHash = Self.payloadDigest(for: finalNoteIndexPayload)
                    }
                    Logger.shared.log(.storage, .info, "[SSHSync] 远程索引自愈完成，移除 \(missingRemoteNoteIDs.count) 条缺失笔记引用")
                } catch {
                    Logger.shared.log(.storage, .error, "[SSHSync] 远程索引自愈失败：\(error.localizedDescription)")
                }
            }

            // 补充下载：检查所有已有笔记中缺失的附件文件
            do {
                _ = try await downloadMissingAssetsForExistingNotes(
                    context: context,
                    config: config,
                    remoteManifest: remoteManifestBundle.manifest,
                    progressHandler: progressHandler,
                    controlPath: controlPath
                )
            } catch {
                if !isRemoteFileMissing(error) {
                    throw error
                }
                Logger.shared.log(.storage, .warn, "[SSHSync] 补充下载附件时远程文件缺失，跳过：\(error.localizedDescription)")
            }

            saveRemoteSyncCacheState(
                RemoteSyncCacheState(
                    noteIndexHash: finalNoteIndexHash,
                    noteIndexPayload: finalNoteIndexPayload,
                    assetsManifestHash: finalAssetsManifestHash,
                    assetsManifestPayload: finalAssetsManifestPayload,
                    updatedAt: Date()
                ),
                config: config
            )

            // 裁剪历史版本，避免远程导入后本地历史无限增长
            for result in results {
                try? BlockDocumentNoteVersionStore.pruneHistory(noteID: result.noteID, context: context)
            }

            return results
        }
    }

    private func syncRemoteNotesInBatches(
        noteIDs: [UUID],
        context: ModelContext,
        config: SSHConfig,
        remoteAssetMap: [String: AssetsManifestEntry],
        hasRemoteAssetsManifest: Bool,
        progressHandler: SSHSyncProgressHandler?,
        controlPath: String?
    ) async throws -> (results: [NoteSyncMergeResult], missingRemoteNoteIDs: [UUID]) {
        guard !noteIDs.isEmpty else {
            return ([], [])
        }

        let sshpassPath = try checkSshpassAvailable()
        let totalNotes = max(noteIDs.count, 1)
        var results: [NoteSyncMergeResult] = []
        var missingRemoteNoteIDs: [UUID] = []

        for batchStart in stride(from: 0, to: noteIDs.count, by: noteDownloadConcurrencyLimit) {
            let batchEnd = min(batchStart + noteDownloadConcurrencyLimit, noteIDs.count)
            let batchNoteIDs = Array(noteIDs[batchStart..<batchEnd])
            let downloads = try await downloadRemoteNotePayloads(
                noteIDs: batchNoteIDs,
                sshpassPath: sshpassPath,
                config: config,
                controlPath: controlPath
            )
            let downloadMap = Dictionary(uniqueKeysWithValues: downloads.map { ($0.noteID, $0) })

            for noteID in batchNoteIDs {
                guard let download = downloadMap[noteID] else { continue }
                let currentIndex = results.count + missingRemoteNoteIDs.count + 1

                if download.isMissing {
                    missingRemoteNoteIDs.append(noteID)
                    await reportProgress(
                        progressHandler,
                        phase: .pullNotes,
                        current: currentIndex,
                        total: totalNotes,
                        message: "发现远程脏索引，已跳过 \(missingRemoteNoteIDs.count) 条"
                    )
                    continue
                }

                guard let payload = download.payload else { continue }
                let result = try await syncDownloadedRemoteNotePayload(
                    noteID: noteID,
                    payload: payload,
                    context: context,
                    sshpassPath: sshpassPath,
                    config: config,
                    remoteAssetMap: remoteAssetMap,
                    hasRemoteAssetsManifest: hasRemoteAssetsManifest,
                    controlPath: controlPath
                )
                results.append(result)

                await reportProgress(
                    progressHandler,
                    phase: .pullNotes,
                    current: currentIndex,
                    total: totalNotes,
                    message: "正在拉取笔记 \(currentIndex)/\(noteIDs.count)"
                )
            }
        }

        return (results, missingRemoteNoteIDs)
    }

    private func downloadRemoteNotePayloads(
        noteIDs: [UUID],
        sshpassPath: String,
        config: SSHConfig,
        controlPath: String?
    ) async throws -> [RemoteNotePayloadDownload] {
        try await withThrowingTaskGroup(of: RemoteNotePayloadDownload.self) { group in
            for noteID in noteIDs {
                group.addTask {
                    do {
                        let payload = try await self.downloadRemoteNotePayload(
                            noteID: noteID,
                            sshpassPath: sshpassPath,
                            config: config,
                            controlPath: controlPath
                        )
                        return RemoteNotePayloadDownload(noteID: noteID, payload: payload, isMissing: false)
                    } catch {
                        if self.isRemoteFileMissing(error) {
                            return RemoteNotePayloadDownload(noteID: noteID, payload: nil, isMissing: true)
                        }
                        throw error
                    }
                }
            }

            var downloads: [RemoteNotePayloadDownload] = []
            for try await download in group {
                downloads.append(download)
            }
            return downloads
        }
    }

    private func downloadRemoteNotePayload(
        noteID: UUID,
        sshpassPath: String,
        config: SSHConfig,
        controlPath: String?
    ) async throws -> Data {
        let remotePath = "\(config.repositoryPath)/notes/\(noteID.uuidString).json"
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("note_sync_pull_\(noteID.uuidString)_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        try await runSCPDownload(
            sshpassPath: sshpassPath,
            config: config,
            remotePath: remotePath,
            localPath: tempFileURL.path,
            controlPath: controlPath
        )

        return try Data(contentsOf: tempFileURL)
    }

    /// 阅读位置使用独立文件同步，避免仅浏览笔记就覆盖远程正文或增加正文版本。
    private func syncReadingPositionsToRemote(
        context: ModelContext,
        config: SSHConfig,
        controlPath: String?
    ) async throws {
        let localPositions = try NoteReadingPositionStore.all(context: context)
        let remoteEnvelope = try await downloadReadingPositionsEnvelopeIfPresent(
            config: config,
            controlPath: controlPath
        )
        if let remoteEnvelope,
           remoteEnvelope.schemaVersion > NoteReadingPosition.schemaVersion {
            Logger.shared.log(.storage, .warn, "[SSHSync] 远程阅读位置协议版本过新，保留远程文件并跳过推送")
            return
        }
        let deletedNoteIDs = Set(try BlockDocumentNoteVersionStore.deletedTombstones(context: context).map(\.noteID))
        var merged = Dictionary(uniqueKeysWithValues: localPositions.map { ($0.noteID, $0) })
        for position in remoteEnvelope?.positions ?? []
        where !deletedNoteIDs.contains(position.noteID) && NoteReadingPosition.wins(position, over: merged[position.noteID]) {
            merged[position.noteID] = position
        }
        for deletedNoteID in deletedNoteIDs {
            merged.removeValue(forKey: deletedNoteID)
        }
        let positions = merged.values.sorted { $0.noteID.uuidString < $1.noteID.uuidString }
        guard !positions.isEmpty || remoteEnvelope != nil else { return }

        _ = try NoteReadingPositionStore.merge(positions, context: context)
        let envelope = ReadingPositionSyncEnvelope(
            schemaVersion: NoteReadingPosition.schemaVersion,
            exportedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            positions: positions
        )
        try await uploadReadingPositionsEnvelope(envelope, config: config, controlPath: controlPath)
    }

    private func syncReadingPositionsFromRemote(
        context: ModelContext,
        config: SSHConfig,
        controlPath: String?
    ) async throws {
        guard let envelope = try await downloadReadingPositionsEnvelopeIfPresent(
            config: config,
            controlPath: controlPath
        ) else { return }
        guard envelope.schemaVersion <= NoteReadingPosition.schemaVersion else {
            Logger.shared.log(.storage, .warn, "[SSHSync] 远程阅读位置协议版本过新，已跳过")
            return
        }
        _ = try NoteReadingPositionStore.merge(envelope.positions, context: context)
    }

    private func downloadReadingPositionsEnvelopeIfPresent(
        config: SSHConfig,
        controlPath: String?
    ) async throws -> ReadingPositionSyncEnvelope? {
        let sshpassPath = try checkSshpassAvailable()
        let remotePath = "\(config.repositoryPath)/notes/reading_positions.json"
        let temporaryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("reading_positions_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: temporaryURL) }
        do {
            try await runSCPDownload(
                sshpassPath: sshpassPath,
                config: config,
                remotePath: remotePath,
                localPath: temporaryURL.path,
                controlPath: controlPath
            )
        } catch {
            if isRemoteFileMissing(error) { return nil }
            throw error
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(ReadingPositionSyncEnvelope.self, from: Data(contentsOf: temporaryURL))
    }

    private func uploadReadingPositionsEnvelope(
        _ envelope: ReadingPositionSyncEnvelope,
        config: SSHConfig,
        controlPath: String?
    ) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let remoteDirectory = "\(config.repositoryPath)/notes"
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p \(shellQuotedRemotePath(remoteDirectory))",
            controlPath: controlPath
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(envelope)
        let temporaryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("reading_positions_upload_\(UUID().uuidString).json")
        try data.write(to: temporaryURL, options: .atomic)
        defer { try? FileManager.default.removeItem(at: temporaryURL) }

        let remoteTargetPath = "\(remoteDirectory)/reading_positions.json"
        try await uploadVerifiedFileAtomically(
            localURL: temporaryURL,
            expectedDigest: Self.payloadDigest(for: data),
            remoteTargetPath: remoteTargetPath,
            sshpassPath: sshpassPath,
            config: config,
            controlPath: controlPath
        )
    }

    private func syncDownloadedRemoteNotePayload(
        noteID: UUID,
        payload: Data,
        context: ModelContext,
        sshpassPath: String,
        config: SSHConfig,
        remoteAssetMap: [String: AssetsManifestEntry] = [:],
        hasRemoteAssetsManifest: Bool = false,
        controlPath: String? = nil
    ) async throws -> NoteSyncMergeResult {
        let envelope = try JSONDecoder().decode(VersionedNoteSyncEnvelope.self, from: payload)

        try await downloadAssetsForNote(
            envelope: envelope,
            sshpassPath: sshpassPath,
            config: config,
            remoteAssetMap: remoteAssetMap,
            hasRemoteAssetsManifest: hasRemoteAssetsManifest,
            controlPath: controlPath
        )

        let result = try BlockDocumentNoteVersionStore.mergeRemoteEnvelope(envelope, context: context)
        if result.appliedRemoteSnapshot {
            try BlockDocumentNoteVersionStore.markSynced(
                noteID: noteID,
                syncedVersion: min(result.localVersion, result.remoteVersion),
                context: context
            )
        }
        return result
    }

    private func makeRemoteIndexEntry(noteID: UUID, context: ModelContext) throws -> RemoteNoteIndexEntry? {
        guard let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: noteID, context: context) else {
            return nil
        }
        let contentHash = try BlockDocumentNoteVersionStore.snapshotFingerprint(envelope.currentSnapshot)
        return RemoteNoteIndexEntry(
            noteID: noteID,
            version: envelope.currentVersion,
            contentHash: contentHash,
            historyCount: envelope.history.count
        )
    }

    private func updateRemoteCatalogForSingleNote(
        envelope: VersionedNoteSyncEnvelope,
        context: ModelContext,
        config: SSHConfig,
        controlPath: String?
    ) async throws {
        let manifestBundle = try await downloadAssetsManifestBundle(config: config, controlPath: controlPath)
        var manifestEntries = manifestBundle.manifest?.entries ?? []
        manifestEntries.removeAll { entry in
            entry.relativePath.split(separator: "/", maxSplits: 1).first.map(String.init) == envelope.noteID.uuidString
        }
        manifestEntries.append(contentsOf: try collectAssetsManifestEntries(from: envelope))
        try await uploadAssetsManifest(
            entries: manifestEntries,
            config: config,
            controlPath: controlPath
        )

        // index.json remains the final publication point after every referenced
        // payload and manifest has been verified remotely.
        let remoteIndexBundle = try await downloadRemoteIndexBundle(config: config, controlPath: controlPath)
        var indexEntries = remoteIndexBundle.index?.entries ?? []
        if let entry = try makeRemoteIndexEntry(noteID: envelope.noteID, context: context) {
            indexEntries.removeAll { $0.noteID == envelope.noteID }
            indexEntries.append(entry)
        }
        let deletedEntries = (remoteIndexBundle.index?.deletedEntries ?? [])
            .filter { $0.noteID != envelope.noteID }
        try await uploadRemoteIndex(
            entries: indexEntries,
            deletedEntries: deletedEntries,
            config: config,
            controlPath: controlPath,
            remoteLockAlreadyHeld: true
        )
    }

    private func uploadRemoteIndex(
        entries: [RemoteNoteIndexEntry],
        deletedEntries: [RemoteDeletedEntry] = [],
        config: SSHConfig,
        controlPath: String? = nil,
        remoteLockAlreadyHeld: Bool = false
    ) async throws {
        if !remoteLockAlreadyHeld {
            try await withRemoteRepositoryWriteLock(config: config, controlPath: controlPath) { _ in
                try await uploadRemoteIndex(
                    entries: entries,
                    deletedEntries: deletedEntries,
                    config: config,
                    controlPath: controlPath,
                    remoteLockAlreadyHeld: true
                )
            }
            return
        }

        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config, controlPath: controlPath)
        let remoteNoteDirectory = "\(config.repositoryPath)/notes"
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p \(shellQuotedRemotePath(remoteNoteDirectory))",
            controlPath: controlPath
        )

        let current = try? await downloadRemoteIndexBundle(config: config, controlPath: controlPath).index
        var mergedEntries = Dictionary(uniqueKeysWithValues: (current?.entries ?? []).map { ($0.noteID, $0) })
        for entry in entries {
            if let existing = mergedEntries[entry.noteID] {
                if existing.version > entry.version { continue }
                if existing.version == entry.version,
                   existing.contentHash != entry.contentHash {
                    continue
                }
            }
            mergedEntries[entry.noteID] = entry
        }
        var mergedDeleted = Dictionary(uniqueKeysWithValues: (current?.deletedEntries ?? []).map { ($0.noteID, $0) })
        for deleted in deletedEntries {
            if let existing = mergedDeleted[deleted.noteID], existing.deletedAt > deleted.deletedAt {
                continue
            }
            mergedDeleted[deleted.noteID] = deleted
        }
        for noteID in mergedDeleted.keys {
            mergedEntries.removeValue(forKey: noteID)
        }

        let index = RemoteNoteIndex(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: mergedEntries.values.sorted { $0.noteID.uuidString < $1.noteID.uuidString },
            deletedEntries: mergedDeleted.values.sorted { $0.noteID.uuidString < $1.noteID.uuidString }
        )
        let payload = try encodeRemoteNoteIndex(index)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("note_sync_index_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTargetPath = "\(remoteNoteDirectory)/index.json"
        try await uploadVerifiedFileAtomically(
            localURL: tempFileURL,
            expectedDigest: Self.payloadDigest(for: payload),
            remoteTargetPath: remoteTargetPath,
            sshpassPath: sshpassPath,
            config: config,
            controlPath: controlPath
        )
    }

    private func resolveRemoteIndexBundle(
        config: SSHConfig,
        cachedState: RemoteSyncCacheState?,
        controlPath: String?
    ) async throws -> RemoteNoteIndexBundle {
        let sshpassPath = try checkSshpassAvailable()
        let remotePath = "\(config.repositoryPath)/notes/index.json"
        let probe = try await probeRemoteFileDigest(
            sshpassPath: sshpassPath,
            config: config,
            remotePath: remotePath,
            controlPath: controlPath
        )

        guard probe.exists else {
            return RemoteNoteIndexBundle(index: nil, payloadHash: nil, payload: nil)
        }

        if let digest = probe.digest,
           digest == cachedState?.noteIndexHash,
           let cachedPayload = cachedState?.noteIndexPayload {
            return RemoteNoteIndexBundle(
                index: try JSONDecoder().decode(RemoteNoteIndex.self, from: cachedPayload),
                payloadHash: digest,
                payload: cachedPayload
            )
        }

        return try await downloadRemoteIndexBundle(config: config, controlPath: controlPath)
    }

    private func downloadRemoteIndexBundle(config: SSHConfig, controlPath: String?) async throws -> RemoteNoteIndexBundle {
        let sshpassPath = try checkSshpassAvailable()
        let remotePath = "\(config.repositoryPath)/notes/index.json"
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("note_sync_index_pull_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        do {
            try await runSCPDownload(
                sshpassPath: sshpassPath,
                config: config,
                remotePath: remotePath,
                localPath: tempFileURL.path,
                controlPath: controlPath
            )
        } catch {
            return RemoteNoteIndexBundle(index: nil, payloadHash: nil, payload: nil)
        }

        let payload = try Data(contentsOf: tempFileURL)
        return RemoteNoteIndexBundle(
            index: try JSONDecoder().decode(RemoteNoteIndex.self, from: payload),
            payloadHash: Self.payloadDigest(for: payload),
            payload: payload
        )
    }

    private func resolveAssetsManifestBundle(
        config: SSHConfig,
        cachedState: RemoteSyncCacheState?,
        controlPath: String?
    ) async throws -> AssetsManifestBundle {
        let sshpassPath = try checkSshpassAvailable()
        let remotePath = "\(config.repositoryPath)/notes/assets_manifest.json"
        let probe = try await probeRemoteFileDigest(
            sshpassPath: sshpassPath,
            config: config,
            remotePath: remotePath,
            controlPath: controlPath
        )

        guard probe.exists else {
            return AssetsManifestBundle(manifest: nil, payloadHash: nil, payload: nil)
        }

        if let digest = probe.digest,
           digest == cachedState?.assetsManifestHash,
           let cachedPayload = cachedState?.assetsManifestPayload {
            return AssetsManifestBundle(
                manifest: try JSONDecoder().decode(AssetsManifest.self, from: cachedPayload),
                payloadHash: digest,
                payload: cachedPayload
            )
        }

        return try await downloadAssetsManifestBundle(config: config, controlPath: controlPath)
    }

    private func listRemoteNoteIDs(config: SSHConfig, controlPath: String?) async throws -> [UUID] {
        let sshpassPath = try checkSshpassAvailable()
        let remoteNoteDirectory = "\(config.repositoryPath)/notes"
        let rawListing = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: config,
            command: "if [ -d \(SSHRemotePath.shellQuoted(remoteNoteDirectory)) ]; then ls \(SSHRemotePath.shellQuoted(remoteNoteDirectory)); fi",
            controlPath: controlPath
        )
        return rawListing
            .split(whereSeparator: \.isNewline)
            .compactMap { line -> UUID? in
                let filename = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
                guard filename.hasSuffix(".json"), filename != "index.json" else { return nil }
                let id = filename.replacingOccurrences(of: ".json", with: "")
                return UUID(uuidString: id)
            }
            .sorted { $0.uuidString < $1.uuidString }
    }

    private func fetchSyncState(noteID: UUID, context: ModelContext) throws -> BlockDocumentBackendSyncStateEntity? {
        try BlockDocumentNoteVersionStore.syncState(
            noteID: noteID,
            backendID: BlockDocumentNoteVersionStore.Backend.ssh,
            context: context
        )
    }

    private func runSSHCommand(sshpassPath: String, config: SSHConfig, command: String, controlPath: String? = nil) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: sshArguments(config: config, command: command, controlPath: controlPath),
            password: config.password
        )
        if result.terminationStatus != 0 {
            let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "SSHSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog(message.isEmpty ? "执行远程命令失败" : message, password: config.password)]
            )
        }
    }

    private func runSSHCommandForOutput(sshpassPath: String, config: SSHConfig, command: String, controlPath: String? = nil) async throws -> String {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: sshArguments(config: config, command: command, controlPath: controlPath),
            password: config.password
        )
        if result.terminationStatus != 0 {
            let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "SSHSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog(message.isEmpty ? "执行远程命令失败" : message, password: config.password)]
            )
        }
        return result.standardOutput
    }

    private func probeRemoteFileDigest(
        sshpassPath: String,
        config: SSHConfig,
        remotePath: String,
        controlPath: String?
    ) async throws -> RemoteFileDigestProbe {
        let quotedPath = shellQuotedRemotePath(remotePath)
        let output = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: config,
            command: """
            if [ ! -f \(quotedPath) ]; then
              echo NB_MISSING
            elif command -v sha256sum >/dev/null 2>&1; then
              sha256sum \(quotedPath) | awk '{print $1}'
            elif command -v shasum >/dev/null 2>&1; then
              shasum -a 256 \(quotedPath) | awk '{print $1}'
            elif command -v openssl >/dev/null 2>&1; then
              openssl dgst -sha256 \(quotedPath) | awk '{print $NF}'
            else
              echo NB_NO_DIGEST
            fi
            """,
            controlPath: controlPath
        )

        let value = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if value == "NB_MISSING" {
            return RemoteFileDigestProbe(exists: false, digest: nil)
        }
        if value.isEmpty || value == "NB_NO_DIGEST" {
            return RemoteFileDigestProbe(exists: true, digest: nil)
        }
        return RemoteFileDigestProbe(exists: true, digest: value)
    }

    private func runSCPUpload(sshpassPath: String, config: SSHConfig, localPath: String, remotePath: String, controlPath: String? = nil) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: scpUploadArguments(config: config, localPath: localPath, remotePath: remotePath, controlPath: controlPath),
            password: config.password,
            timeout: 120
        )
        if result.terminationStatus != 0 {
            let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "SSHSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog(message.isEmpty ? "上传失败" : message, password: config.password)]
            )
        }
    }

    private func runSCPDownload(sshpassPath: String, config: SSHConfig, remotePath: String, localPath: String, controlPath: String? = nil) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: scpDownloadArguments(config: config, remotePath: remotePath, localPath: localPath, controlPath: controlPath),
            password: config.password,
            timeout: 120
        )
        if result.terminationStatus != 0 {
            let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
            throw NSError(
                domain: "SSHSync",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog(message.isEmpty ? "下载失败" : message, password: config.password)]
            )
        }
    }

    /// Uploads to a unique temporary path, verifies the remote bytes, and only
    /// then atomically publishes the file. Existing remote data is never removed
    /// before a complete replacement has been verified.
    private func uploadVerifiedFileAtomically(
        localURL: URL,
        expectedDigest: String,
        remoteTargetPath: String,
        sshpassPath: String,
        config: SSHConfig,
        controlPath: String?
    ) async throws {
        let remoteTemporaryPath = "\(remoteTargetPath).tmp.\(UUID().uuidString)"
        var lastRemoteDigest: String?

        for attempt in 1...2 {
            try Task.checkCancellation()
            try await runSCPUpload(
                sshpassPath: sshpassPath,
                config: config,
                localPath: localURL.path,
                remotePath: remoteTemporaryPath,
                controlPath: controlPath
            )
            let probe = try await probeRemoteFileDigest(
                sshpassPath: sshpassPath,
                config: config,
                remotePath: remoteTemporaryPath,
                controlPath: controlPath
            )
            lastRemoteDigest = probe.digest
            if probe.exists, probe.digest == expectedDigest {
                try await runSSHCommand(
                    sshpassPath: sshpassPath,
                    config: config,
                    command: "mv \(shellQuotedRemotePath(remoteTemporaryPath)) \(shellQuotedRemotePath(remoteTargetPath))",
                    controlPath: controlPath
                )
                return
            }
            Logger.shared.log(
                .storage,
                .warn,
                "[SSHSync] 远程临时文件校验失败，重试 \(attempt)/2：target=\(URL(fileURLWithPath: remoteTargetPath).lastPathComponent)"
            )
        }

        // Only the unique, unpublished temporary file is safe to remove.
        try? await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "rm -f \(shellQuotedRemotePath(remoteTemporaryPath))",
            controlPath: controlPath
        )
        Logger.shared.log(
            .storage,
            .error,
            "[SSHSync] 上传校验失败：expected=\(expectedDigest.prefix(16)) remote=\((lastRemoteDigest ?? "unavailable").prefix(16))"
        )
        throw NSError(
            domain: "SSHSync",
            code: -2002,
            userInfo: [NSLocalizedDescriptionKey: "上传校验失败，远程原文件已保留"]
        )
    }

    private func sshArguments(config: SSHConfig, command: String, controlPath: String? = nil) -> [String] {
        SSHProcessTransport.sshArguments(config: config, command: command, controlPath: controlPath)
    }

    private func scpUploadArguments(config: SSHConfig, localPath: String, remotePath: String, controlPath: String? = nil) -> [String] {
        SSHProcessTransport.scpUploadArguments(
            config: config,
            localPath: localPath,
            remotePath: remotePath,
            controlPath: controlPath
        )
    }

    private func scpDownloadArguments(config: SSHConfig, remotePath: String, localPath: String, controlPath: String? = nil) -> [String] {
        SSHProcessTransport.scpDownloadArguments(
            config: config,
            remotePath: remotePath,
            localPath: localPath,
            controlPath: controlPath
        )
    }

    private func executeProcess(
        executablePath: String,
        arguments: [String],
        password: String,
        timeout: TimeInterval = 45
    ) async throws -> ProcessExecutionResult {
        let timeoutErrorMessage = Self.sanitizeLog("SSH 操作超时，请检查服务器连通性、端口配置或网络状态", password: password)
        return try await CancellableProcessRunner.run(
            executablePath: executablePath,
            arguments: arguments,
            environment: SSHProcessTransport.environment(password: password),
            timeout: timeout,
            timeoutError: NSError(
                domain: "SSHSync",
                code: -1001,
                userInfo: [NSLocalizedDescriptionKey: timeoutErrorMessage]
            )
        )
    }

    private func shellQuotedRemotePath(_ path: String) -> String {
        SSHRemotePath.shellQuoted(path)
    }

    /// 判断错误是否为远程文件不存在
    private nonisolated func isRemoteFileMissing(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        if message.contains("no such file") { return true }
        if message.contains("not found") { return true }
        if message.contains("没有那个文件或目录") { return true }
        if message.contains("找不到") { return true }
        if message.contains("cannot stat") { return true }
        if message.contains("no such file or directory") { return true }
        return false
    }

    // MARK: - Delete Sync Helpers

    /// 处理远程已删除的笔记：对本地存在的笔记执行软删除（标记 deletedAt）
    private func applyRemoteDeletedEntries(_ deletedEntries: [RemoteDeletedEntry], context: ModelContext) throws {
        guard !deletedEntries.isEmpty else { return }

        for entry in deletedEntries {
            let noteID = entry.noteID
            try BlockDocumentNoteVersionStore.recordDeletedTombstone(
                noteID: noteID,
                deletedAt: entry.deletedAt,
                context: context
            )
            let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
            )
            guard let localNote = try context.fetch(descriptor).first else {
                // 本地不存在该笔记，无需操作
                continue
            }

            // 本地笔记尚未标记删除 → 执行软删除
            if localNote.deletedAt == nil {
                Logger.shared.log(.storage, .info, "[SSHSync] 远程已删除笔记，本地执行软删除：\(noteID.uuidString)")
                localNote.deletedAt = entry.deletedAt
                localNote.originalFolderID = localNote.folderID
                localNote.originalFolderName = localNote.folderName
                localNote.updatedAt = entry.deletedAt
                localNote.version = max(localNote.version + 1, 1)
                _ = try? BlockDocumentNoteVersionStore.ensureHistoryRecorded(noteID: noteID, context: context)
            }
        }
        try context.save()
    }

    /// 收集本地已永久删除的笔记记录
    private func collectLocallyDeletedEntries(existingNoteIDs: Set<UUID>, context: ModelContext) throws -> [RemoteDeletedEntry] {
        _ = existingNoteIDs
        var deletedEntries: [RemoteDeletedEntry] = []

        for tombstone in try BlockDocumentNoteVersionStore.deletedTombstones(context: context) {
            deletedEntries.append(RemoteDeletedEntry(
                noteID: tombstone.noteID,
                deletedAt: tombstone.deletedAt,
                deletedByDeviceID: tombstone.deletedByDeviceID
            ))
        }
        return deletedEntries
    }

    /// 清理本地已同步删除记录（避免每次推送都重复收集）
    private func cleanupDeletedSyncStates(deletedNoteIDs: Set<UUID>, context: ModelContext) {
        guard !deletedNoteIDs.isEmpty else { return }
        for noteID in deletedNoteIDs {
            let key = "\(BlockDocumentNoteVersionStore.Backend.ssh)|\(noteID.uuidString)"
            let descriptor = FetchDescriptor<BlockDocumentBackendSyncStateEntity>(
                predicate: #Predicate<BlockDocumentBackendSyncStateEntity> { $0.backendNoteKey == key }
            )
            if let syncState = try? context.fetch(descriptor).first {
                context.delete(syncState)
            }
        }
        // 墓碑必须长期保留并持续发布；离线设备可能在很久后重新上线，过早清理会导致笔记复活。
        context.saveLogging("AssetDownloadJob.cleanupDeletedSyncStates")
    }

    private func healRemoteIndex(
        _ remoteIndex: RemoteNoteIndex,
        removingMissingNoteIDs missingNoteIDs: Set<UUID>,
        config: SSHConfig,
        controlPath: String?
    ) async throws -> RemoteNoteIndex {
        guard !missingNoteIDs.isEmpty else { return remoteIndex }

        let healedIndex = RemoteNoteIndex(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: remoteIndex.entries.filter { !missingNoteIDs.contains($0.noteID) },
            deletedEntries: remoteIndex.deletedEntries
        )
        try await uploadRemoteIndex(
            entries: healedIndex.entries,
            deletedEntries: healedIndex.deletedEntries,
            config: config,
            controlPath: controlPath
        )
        return healedIndex
    }

    // MARK: - Attachment Sync Helpers

    private func uploadAssetsForNote(envelope: VersionedNoteSyncEnvelope, sshpassPath: String, config: SSHConfig, controlPath: String? = nil) async throws {
        let storage = StorageLocationManager.shared
        let attachmentsRoot = try storage.attachmentsDirectoryURL()

        // 对存储目录开启 security-scoped 访问（如果需要），覆盖整个上传过程
        let base = storage.baseDirectoryURL
        let didStartAccess = base?.startAccessingSecurityScopedResource() ?? false
        defer {
            if didStartAccess, let base { base.stopAccessingSecurityScopedResource() }
        }

        let remoteAttachmentsDir = "\(config.repositoryPath)/attachments"

        // 确保远程附件目录存在
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p \(shellQuotedRemotePath(remoteAttachmentsDir))",
            controlPath: controlPath
        )

        var missingRelativePaths: [String] = []
        for asset in envelope.currentSnapshot.assets {
            let paths = [asset.relativeFilePath] + asset.sidecarRelativePaths
            for relativePath in paths {
                let localURL = try SyncRelativePath.resolvedURL(relativePath, under: attachmentsRoot)
                guard FileManager.default.fileExists(atPath: localURL.path) else {
                    missingRelativePaths.append(relativePath)
                    continue
                }

                let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"
                let remoteDir = String(remotePath[..<remotePath.range(of: "/", options: .backwards)!.lowerBound])

                try await runSSHCommand(
                    sshpassPath: sshpassPath,
                    config: config,
                    command: "mkdir -p \(shellQuotedRemotePath(remoteDir))",
                    controlPath: controlPath
                )
                try await uploadVerifiedFileAtomically(
                    localURL: localURL,
                    expectedDigest: try Self.fileDigest(at: localURL),
                    remoteTargetPath: remotePath,
                    sshpassPath: sshpassPath,
                    config: config,
                    controlPath: controlPath
                )
            }
        }

        if !missingRelativePaths.isEmpty {
            Logger.shared.log(
                .storage,
                .error,
                "[SSHSync] 推送附件失败，本地附件缺失：\(missingRelativePaths.joined(separator: ", "))"
            )
            throw NSError(
                domain: "SSHSync",
                code: -2003,
                userInfo: [NSLocalizedDescriptionKey: "本地附件文件缺失，图片没有推送成功"]
            )
        }
    }

    private func downloadAssetsForNote(
        envelope: VersionedNoteSyncEnvelope,
        sshpassPath: String,
        config: SSHConfig,
        remoteAssetMap: [String: AssetsManifestEntry] = [:],
        hasRemoteAssetsManifest: Bool = false,
        controlPath: String? = nil
    ) async throws {
        let storage = StorageLocationManager.shared
        let attachmentsRoot = try storage.attachmentsDirectoryURL()

        // 对存储目录开启 security-scoped 访问（如果需要），覆盖整个下载过程
        let base = storage.baseDirectoryURL
        let didStartAccess = base?.startAccessingSecurityScopedResource() ?? false
        defer {
            if didStartAccess, let base { base.stopAccessingSecurityScopedResource() }
        }

        try FileManager.default.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
        let remoteAttachmentsDir = "\(config.repositoryPath)/attachments"

        for asset in envelope.currentSnapshot.assets {
            let paths = [asset.relativeFilePath] + asset.sidecarRelativePaths
            for relativePath in paths {
                let localURL = try SyncRelativePath.resolvedURL(relativePath, under: attachmentsRoot)
                if let attrs = try? FileManager.default.attributesOfItem(atPath: localURL.path),
                   let fileSize = attrs[.size] as? Int, fileSize > 0 {
                    if let remoteEntry = remoteAssetMap[relativePath],
                       let localData = try? Data(contentsOf: localURL),
                       Self.payloadDigest(for: localData) == remoteEntry.contentHash {
                        continue
                    }
                    if remoteAssetMap[relativePath] == nil {
                        continue
                    }
                }

                let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"

                let localDir = localURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)

                if remoteAssetMap[relativePath] == nil {
                    if hasRemoteAssetsManifest {
                        continue
                    }
                    let checkResult = try await runSSHCommandForOutput(
                        sshpassPath: sshpassPath,
                        config: config,
                        command: "test -f \(shellQuotedRemotePath(remotePath)) && echo EXISTS || echo MISSING",
                        controlPath: controlPath
                    )
                    guard checkResult.trimmingCharacters(in: .whitespacesAndNewlines) == "EXISTS" else { continue }
                }

                try await downloadSingleAsset(
                    relativePath: relativePath,
                    localURL: localURL,
                    expectedHash: remoteAssetMap[relativePath]?.contentHash,
                    sshpassPath: sshpassPath,
                    config: config,
                    remoteAttachmentsDir: remoteAttachmentsDir,
                    controlPath: controlPath
                )
            }
        }
    }

    private func collectAssetsManifestEntries(from envelope: VersionedNoteSyncEnvelope) throws -> [AssetsManifestEntry] {
        let attachmentsRoot = try StorageLocationManager.shared.attachmentsDirectoryURL()
        var entries: [AssetsManifestEntry] = []

        for asset in envelope.currentSnapshot.assets {
            let paths = [asset.relativeFilePath] + asset.sidecarRelativePaths
            for relativePath in paths {
                let localURL = try SyncRelativePath.resolvedURL(relativePath, under: attachmentsRoot)
                guard FileManager.default.fileExists(atPath: localURL.path) else {
                    throw NSError(
                        domain: "SSHSync",
                        code: -2003,
                        userInfo: [NSLocalizedDescriptionKey: "本地附件文件缺失，已取消发布远程附件清单"]
                    )
                }
                let attributes = try FileManager.default.attributesOfItem(atPath: localURL.path)
                let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
                entries.append(AssetsManifestEntry(
                    relativePath: relativePath,
                    contentHash: try Self.fileDigest(at: localURL),
                    size: size
                ))
            }
        }
        return entries
    }

    private func uploadAssetsManifest(
        entries: [AssetsManifestEntry],
        replacingEntriesForNoteIDs noteIDs: Set<UUID>? = nil,
        config: SSHConfig,
        controlPath: String? = nil
    ) async throws {
        let sshpassPath = try checkSshpassAvailable()
        var publishedEntries = entries
        if let noteIDs {
            let remoteEntries = try await downloadAssetsManifestBundle(
                config: config,
                controlPath: controlPath
            ).manifest?.entries ?? []
            var entriesByPath = Dictionary(uniqueKeysWithValues: remoteEntries.map { ($0.relativePath, $0) })
            entriesByPath = entriesByPath.filter { relativePath, _ in
                guard let component = relativePath.split(separator: "/", maxSplits: 1).first,
                      let noteID = UUID(uuidString: String(component)) else {
                    return true
                }
                return !noteIDs.contains(noteID)
            }
            for entry in entries {
                entriesByPath[entry.relativePath] = entry
            }
            publishedEntries = Array(entriesByPath.values)
        }
        let manifest = AssetsManifest(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: publishedEntries.sorted { $0.relativePath < $1.relativePath }
        )
        let payload = try encodeAssetsManifest(manifest)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("assets_manifest_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTargetPath = "\(config.repositoryPath)/notes/assets_manifest.json"

        try await uploadVerifiedFileAtomically(
            localURL: tempFileURL,
            expectedDigest: Self.payloadDigest(for: payload),
            remoteTargetPath: remoteTargetPath,
            sshpassPath: sshpassPath,
            config: config,
            controlPath: controlPath
        )
    }

    /// 下载远程附件清单
    private func downloadAssetsManifestBundle(config: SSHConfig, controlPath: String?) async throws -> AssetsManifestBundle {
        let sshpassPath = try checkSshpassAvailable()
        let remotePath = "\(config.repositoryPath)/notes/assets_manifest.json"
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("assets_manifest_download_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        do {
            try await runSCPDownload(
                sshpassPath: sshpassPath,
                config: config,
                remotePath: remotePath,
                localPath: tempFileURL.path,
                controlPath: controlPath
            )
        } catch {
            // 如果文件不存在，返回nil（兼容旧版本）
            return AssetsManifestBundle(manifest: nil, payloadHash: nil, payload: nil)
        }

        let payload = try Data(contentsOf: tempFileURL)
        return AssetsManifestBundle(
            manifest: try JSONDecoder().decode(AssetsManifest.self, from: payload),
            payloadHash: Self.payloadDigest(for: payload),
            payload: payload
        )
    }

    /// 检查并下载本地已有笔记中缺失的附件
    private func downloadMissingAssetsForExistingNotes(
        context: ModelContext,
        config: SSHConfig,
        remoteManifest: AssetsManifest? = nil,
        progressHandler: SSHSyncProgressHandler? = nil,
        controlPath: String? = nil
    ) async throws -> String? {
        let sshpassPath = try checkSshpassAvailable()

        // 1. 获取所有本地笔记的附件
        let allAssets = try context.fetch(FetchDescriptor<BlockDocumentAssetEntity>())

        // 如果没有任何附件，直接返回
        guard !allAssets.isEmpty else {
            await reportProgress(
                progressHandler,
                phase: .checkMissingAssets,
                current: 1,
                total: 1,
                message: "没有需要检查的附件"
            )
            return nil
        }

        // 2. 下载远程附件清单（如果存在）
        let resolvedRemoteManifest: AssetsManifest?
        if let remoteManifest {
            resolvedRemoteManifest = remoteManifest
        } else {
            let manifestBundle = try? await resolveAssetsManifestBundle(
                config: config,
                cachedState: loadRemoteSyncCacheState(config: config),
                controlPath: controlPath
            )
            resolvedRemoteManifest = manifestBundle?.manifest
        }

        // 3. 准备远程附件路径映射
        let remoteAssetMap = resolvedRemoteManifest?.entries.reduce(into: [String: AssetsManifestEntry]()) {
            $0[$1.relativePath] = $1
        } ?? [:]
        let hasRemoteAssetsManifest = resolvedRemoteManifest != nil

        // 4. 检查并下载缺失附件
        let storage = StorageLocationManager.shared
        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let remoteAttachmentsDir = "\(config.repositoryPath)/attachments"
        let assetPathsToCheck = allAssets.flatMap { asset -> [String] in
            let sidecarPaths: [String]
            if let sidecarPayload = asset.sidecarPathsPayload,
               let paths = try? JSONDecoder().decode([String].self, from: sidecarPayload) {
                sidecarPaths = paths
            } else {
                sidecarPaths = []
            }
            return [asset.relativeFilePath] + sidecarPaths
        }
        let totalAssets = max(assetPathsToCheck.count, 1)
        var processedAssets = 0
        var downloadJobs: [AssetDownloadJob] = []

        await reportProgress(
            progressHandler,
            phase: .checkMissingAssets,
            current: 0,
            total: totalAssets,
            message: "正在检查缺失附件 0/\(assetPathsToCheck.count)"
        )

        for asset in allAssets {
            let sidecarPaths: [String]
            if let sidecarPayload = asset.sidecarPathsPayload,
               let paths = try? JSONDecoder().decode([String].self, from: sidecarPayload) {
                sidecarPaths = paths
            } else {
                sidecarPaths = []
            }

            let paths = [asset.relativeFilePath] + sidecarPaths

            for relativePath in paths {
                let localURL = try SyncRelativePath.resolvedURL(relativePath, under: attachmentsRoot)

                // 检查本地文件是否存在且有效
                let shouldDownload = try await shouldDownloadAsset(
                    localURL: localURL,
                    relativePath: relativePath,
                    remoteEntry: remoteAssetMap[relativePath],
                    hasRemoteAssetsManifest: hasRemoteAssetsManifest,
                    sshpassPath: sshpassPath,
                    config: config,
                    remoteAttachmentsDir: remoteAttachmentsDir,
                    controlPath: controlPath
                )

                if shouldDownload {
                    downloadJobs.append(AssetDownloadJob(
                        relativePath: relativePath,
                        localURL: localURL,
                        expectedHash: remoteAssetMap[relativePath]?.contentHash
                    ))
                }

                processedAssets += 1
                await reportProgress(
                    progressHandler,
                    phase: .checkMissingAssets,
                    current: processedAssets,
                    total: totalAssets,
                    message: "正在检查缺失附件 \(processedAssets)/\(assetPathsToCheck.count)"
                )
            }
        }

        guard !downloadJobs.isEmpty else {
            return try resolvedRemoteManifest.map { try Self.payloadDigest(for: encodeAssetsManifest($0)) }
        }

        var downloadedAssets = 0
        for batchStart in stride(from: 0, to: downloadJobs.count, by: assetDownloadConcurrencyLimit) {
            let batchEnd = min(batchStart + assetDownloadConcurrencyLimit, downloadJobs.count)
            let batch = Array(downloadJobs[batchStart..<batchEnd])

            await reportProgress(
                progressHandler,
                phase: .pullAssets,
                current: downloadedAssets,
                total: downloadJobs.count,
                message: "正在补充附件 \(downloadedAssets)/\(downloadJobs.count)"
            )

            try await withThrowingTaskGroup(of: String.self) { group in
                for job in batch {
                    group.addTask {
                        try await self.downloadSingleAsset(
                            relativePath: job.relativePath,
                            localURL: job.localURL,
                            expectedHash: job.expectedHash,
                            sshpassPath: sshpassPath,
                            config: config,
                            remoteAttachmentsDir: remoteAttachmentsDir,
                            controlPath: controlPath
                        )
                        return job.relativePath
                    }
                }

                for try await _ in group {
                    downloadedAssets += 1
                    await reportProgress(
                        progressHandler,
                        phase: .pullAssets,
                        current: downloadedAssets,
                        total: downloadJobs.count,
                        message: "正在补充附件 \(downloadedAssets)/\(downloadJobs.count)"
                    )
                }
            }
        }
        return try resolvedRemoteManifest.map { try Self.payloadDigest(for: encodeAssetsManifest($0)) }
    }

    private func reportProgress(
        _ progressHandler: SSHSyncProgressHandler?,
        phase: SyncPhase,
        current: Int,
        total: Int,
        message: String
    ) async {
        guard let progressHandler else { return }
        await progressHandler(SSHSyncProgress(
            phase: phase,
            current: current,
            total: total,
            message: message
        ))
    }

    private func loadRemoteSyncCacheState(config: SSHConfig) -> RemoteSyncCacheState? {
        let key = remoteSyncCacheKey(for: config)
        guard let data = NotebookDefaults.shared.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(RemoteSyncCacheState.self, from: data)
    }

    private func saveRemoteSyncCacheState(_ state: RemoteSyncCacheState, config: SSHConfig) {
        let key = remoteSyncCacheKey(for: config)
        guard let data = try? JSONEncoder().encode(state) else { return }
        NotebookDefaults.shared.set(data, forKey: key)
    }

    private func remoteSyncCacheKey(for config: SSHConfig) -> String {
        let rawKey = "\(config.username)@\(config.host):\(config.port)|\(config.repositoryPath)"
        return "SSHSyncManager.remoteCache.\(Self.payloadDigest(for: Data(rawKey.utf8)))"
    }

    private func encodeRemoteNoteIndex(_ index: RemoteNoteIndex) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(index)
    }

    private func encodeAssetsManifest(_ manifest: AssetsManifest) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(manifest)
    }

    private static func payloadDigest(for data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func fileDigest(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// 判断是否需要下载某个附件
    private func shouldDownloadAsset(
        localURL: URL,
        relativePath: String,
        remoteEntry: AssetsManifestEntry?,
        hasRemoteAssetsManifest: Bool,
        sshpassPath: String,
        config: SSHConfig,
        remoteAttachmentsDir: String,
        controlPath: String?
    ) async throws -> Bool {
        let fileManager = FileManager.default

        // 如果本地文件存在且大小大于0，检查是否需要验证哈希
        if fileManager.fileExists(atPath: localURL.path) {
            if let attributes = try? fileManager.attributesOfItem(atPath: localURL.path),
               let fileSize = attributes[.size] as? Int, fileSize > 0 {

                // 如果有远程清单条目，验证哈希
                if let remoteEntry = remoteEntry,
                   let localData = try? Data(contentsOf: localURL) {
                    let localHash = Self.payloadDigest(for: localData)
                    return localHash != remoteEntry.contentHash
                }

                // 没有远程清单，认为文件完整
                return false
            }
        }

        if remoteEntry != nil {
            return true
        }
        if hasRemoteAssetsManifest {
            return false
        }

        // 本地文件不存在或大小为0，需要检查远程是否存在
        let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"
        let checkResult = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: config,
            command: "test -f \(shellQuotedRemotePath(remotePath)) && echo EXISTS || echo MISSING",
            controlPath: controlPath
        )

        let exists = checkResult.trimmingCharacters(in: .whitespacesAndNewlines) == "EXISTS"

        // 如果远程文件不存在，记录警告但继续处理其他文件
        if !exists {
            Logger.shared.log(.storage, .warn, "警告：远程附件不存在：\(remotePath)")
        }

        return exists
    }

    /// 下载单个附件文件
    private func downloadSingleAsset(
        relativePath: String,
        localURL: URL,
        expectedHash: String?,
        sshpassPath: String,
        config: SSHConfig,
        remoteAttachmentsDir: String,
        controlPath: String?
    ) async throws {
        // 确保本地目录存在
        let localDir = localURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)

        let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"
        let stagedURL = localDir.appendingPathComponent(".notebook-download-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: stagedURL) }

        try await runSCPDownload(
            sshpassPath: sshpassPath,
            config: config,
            remotePath: remotePath,
            localPath: stagedURL.path,
            controlPath: controlPath
        )

        if let expectedHash, try AtomicFileCommit.sha256(of: stagedURL) != expectedHash {
            throw NSError(
                domain: "SSHSync",
                code: -2004,
                userInfo: [NSLocalizedDescriptionKey: "附件下载校验失败：\(relativePath)"]
            )
        }
        try AtomicFileCommit.commit(stagedURL: stagedURL, to: localURL)

        Logger.shared.log(.storage, .debug, "已下载附件：\(relativePath)")
    }

    // MARK: - Library Sync (Folders & Tags)

    private func syncLibraryToRemote(context: ModelContext, config: SSHConfig, controlPath: String? = nil) async throws {
        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config, controlPath: controlPath)

        let folders = try context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
            .sorted { $0.sortOrder < $1.sortOrder }
        let tags = try context.fetch(FetchDescriptor<BlockDocumentTagEntity>())
            .sorted { $0.createdAt < $1.createdAt }
        let libraryTombstones = try context.fetch(FetchDescriptor<BlockDocumentLibraryTombstoneEntity>())

        // 收集加密文件夹数据
        let encryptedData = collectEncryptedFolderSyncData()

        let envelope = LibrarySyncEnvelope(
            exportedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            folders: folders.map {
                FolderSyncEntry(id: $0.id, name: $0.name, sortOrder: $0.sortOrder, isSystem: $0.isSystem, createdAt: $0.createdAt, folderType: $0.folderType, updatedAt: $0.updatedAt)
            },
            tags: tags.map {
                TagSyncEntry(id: $0.id, name: $0.name, color: $0.color, createdAt: $0.createdAt, updatedAt: $0.updatedAt)
            },
            encryptedData: encryptedData,
            deletedFolders: libraryTombstones.filter { $0.itemKind == "folder" }.map {
                LibraryDeletedEntry(id: $0.itemID, deletedAt: $0.deletedAt, deletedByDeviceID: $0.deletedByDeviceID)
            },
            deletedTags: libraryTombstones.filter { $0.itemKind == "tag" }.map {
                LibraryDeletedEntry(id: $0.itemID, deletedAt: $0.deletedAt, deletedByDeviceID: $0.deletedByDeviceID)
            }
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(envelope)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("library_sync_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTargetPath = "\(config.repositoryPath)/library.json"

        try await uploadVerifiedFileAtomically(
            localURL: tempFileURL,
            expectedDigest: Self.payloadDigest(for: payload),
            remoteTargetPath: remoteTargetPath,
            sshpassPath: sshpassPath,
            config: config,
            controlPath: controlPath
        )
    }

    private func syncLibraryFromRemote(context: ModelContext, config: SSHConfig, controlPath: String? = nil) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let remotePath = "\(config.repositoryPath)/library.json"
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("library_sync_pull_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        do {
            try await runSCPDownload(
                sshpassPath: sshpassPath,
                config: config,
                remotePath: remotePath,
                localPath: tempFileURL.path,
                controlPath: controlPath
            )
        } catch {
            // library.json 不存在时静默跳过
            return
        }

        let payload = try Data(contentsOf: tempFileURL)
        let envelope = try JSONDecoder().decode(LibrarySyncEnvelope.self, from: payload)

        // 获取本地 library，确保同步的文件夹/标签与本地 library 关联
        let localLibraryID = ensureLocalLibraryID(in: context)
        let localTombstones = try context.fetch(FetchDescriptor<BlockDocumentLibraryTombstoneEntity>())
        let tombstonesByKey = Dictionary(uniqueKeysWithValues: localTombstones.map { ($0.tombstoneKey, $0) })

        // 合并文件夹
        for remoteFolder in envelope.folders {
            let idToMatch = remoteFolder.id
            let remoteUpdatedAt = remoteFolder.updatedAt ?? remoteFolder.createdAt ?? envelope.exportedAt
            let tombstoneKey = "folder|\(remoteFolder.id.uuidString)"
            if let tombstone = tombstonesByKey[tombstoneKey], tombstone.deletedAt >= remoteUpdatedAt {
                continue
            }
            if let tombstone = tombstonesByKey[tombstoneKey] { context.delete(tombstone) }
            let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(
                predicate: #Predicate<BlockDocumentFolderEntity> { $0.id == idToMatch }
            )
            if let existing = try context.fetch(descriptor).first {
                guard remoteUpdatedAt > existing.updatedAt else { continue }
                existing.name = remoteFolder.name
                existing.sortOrder = remoteFolder.sortOrder
                existing.folderType = remoteFolder.folderType ?? FolderType.noteFolder.rawValue
                existing.updatedAt = remoteUpdatedAt
            } else {
                let entity = BlockDocumentFolderEntity(
                    id: remoteFolder.id,
                    libraryID: localLibraryID,
                    name: remoteFolder.name,
                    sortOrder: remoteFolder.sortOrder,
                    isSystem: remoteFolder.isSystem,
                    createdAt: remoteFolder.createdAt,
                    folderType: remoteFolder.folderType ?? FolderType.noteFolder.rawValue,
                    updatedAt: remoteUpdatedAt
                )
                context.insert(entity)
            }
        }

        // 合并标签
        for remoteTag in envelope.tags {
            let idToMatch = remoteTag.id
            let remoteUpdatedAt = remoteTag.updatedAt ?? remoteTag.createdAt
            let tombstoneKey = "tag|\(remoteTag.id.uuidString)"
            if let tombstone = tombstonesByKey[tombstoneKey], tombstone.deletedAt >= remoteUpdatedAt {
                continue
            }
            if let tombstone = tombstonesByKey[tombstoneKey] { context.delete(tombstone) }
            let descriptor = FetchDescriptor<BlockDocumentTagEntity>(
                predicate: #Predicate<BlockDocumentTagEntity> { $0.id == idToMatch }
            )
            if let existing = try context.fetch(descriptor).first {
                guard remoteUpdatedAt > existing.updatedAt else { continue }
                existing.name = remoteTag.name
                existing.color = remoteTag.color
                existing.updatedAt = remoteUpdatedAt
            } else {
                let entity = BlockDocumentTagEntity(
                    id: remoteTag.id,
                    libraryID: localLibraryID,
                    name: remoteTag.name,
                    color: remoteTag.color,
                    createdAt: remoteTag.createdAt,
                    updatedAt: remoteUpdatedAt
                )
                context.insert(entity)
            }
        }

        for deletion in envelope.deletedFolders ?? [] {
            try applyRemoteLibraryDeletion(deletion, kind: "folder", context: context)
        }
        for deletion in envelope.deletedTags ?? [] {
            try applyRemoteLibraryDeletion(deletion, kind: "tag", context: context)
        }

        // 合并加密文件夹数据
        if let encryptedData = envelope.encryptedData {
            importEncryptedFolderSyncData(encryptedData)
        }

        try context.save()
    }

    private func applyRemoteLibraryDeletion(
        _ deletion: LibraryDeletedEntry,
        kind: String,
        context: ModelContext
    ) throws {
        let key = "\(kind)|\(deletion.id.uuidString)"
        let tombstoneDescriptor = FetchDescriptor<BlockDocumentLibraryTombstoneEntity>(
            predicate: #Predicate<BlockDocumentLibraryTombstoneEntity> { $0.tombstoneKey == key }
        )
        if let tombstone = try context.fetch(tombstoneDescriptor).first {
            if deletion.deletedAt > tombstone.deletedAt {
                tombstone.deletedAt = deletion.deletedAt
                tombstone.deletedByDeviceID = deletion.deletedByDeviceID
            }
        } else {
            context.insert(BlockDocumentLibraryTombstoneEntity(
                itemID: deletion.id,
                itemKind: kind,
                deletedAt: deletion.deletedAt,
                deletedByDeviceID: deletion.deletedByDeviceID
            ))
        }

        let itemID = deletion.id
        if kind == "folder" {
            let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(
                predicate: #Predicate<BlockDocumentFolderEntity> { $0.id == itemID }
            )
            if let folder = try context.fetch(descriptor).first, deletion.deletedAt >= folder.updatedAt {
                let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.folderID == itemID }
                ))
                for note in notes {
                    note.folderID = nil
                    note.folderName = "未分类"
                }
                context.delete(folder)
            }
        } else {
            let descriptor = FetchDescriptor<BlockDocumentTagEntity>(
                predicate: #Predicate<BlockDocumentTagEntity> { $0.id == itemID }
            )
            if let tag = try context.fetch(descriptor).first, deletion.deletedAt >= tag.updatedAt {
                let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
                for note in notes {
                    var tagIDs = UUIDListCoding.decode(note.tagIDs)
                    guard tagIDs.contains(itemID) else { continue }
                    tagIDs.removeAll { $0 == itemID }
                    note.tagIDs = UUIDListCoding.encode(tagIDs)
                    note.version = max(note.version + 1, 1)
                    note.updatedAt = deletion.deletedAt
                    NoteStore.reconcileNoteTagLinks(
                        noteID: note.id,
                        libraryID: note.libraryID,
                        tagIDs: tagIDs,
                        context: context
                    )
                }
                context.delete(tag)
            }
        }
    }

    /// 获取本地 library 的 ID，确保同步过来的文件夹/标签与本地 library 关联
    private func ensureLocalLibraryID(in context: ModelContext) -> UUID {
        if let existing = try? context.fetch(
            FetchDescriptor<BlockDocumentLibraryEntity>(sortBy: [SortDescriptor(\.importedAt, order: .reverse)])
        ).first {
            return existing.id
        }

        let library = BlockDocumentLibraryEntity(
            schemaVersion: "1.0",
            sourceExportedAt: Date()
        )
        context.insert(library)
        context.saveLogging("AssetDownloadJob.ensureLocalLibraryID")
        return library.id
    }

    // MARK: - Encrypted Folder Sync

    private func collectEncryptedFolderSyncData() -> EncryptedFolderSyncData {
        let defaults = NotebookDefaults.shared

        // 加密文件夹列表
        let encryptedFoldersKey = "encrypted_folders"
        var encryptedFolders: [EncryptedFolder] = []
        if let data = defaults.data(forKey: encryptedFoldersKey),
           let folders = try? JSONDecoder().decode([EncryptedFolder].self, from: data) {
            encryptedFolders = folders
        }

        // 加密笔记ID列表
        let encryptedNoteIDs = defaults.stringArray(forKey: "encrypted_note_ids") ?? []

        // 笔记到加密文件夹的映射
        let noteToFolderMapping = defaults.dictionary(forKey: "note_to_encrypted_folder") as? [String: String] ?? [:]

        return EncryptedFolderSyncData(
            encryptedFolders: encryptedFolders,
            encryptedNoteIDs: encryptedNoteIDs,
            noteToFolderMapping: noteToFolderMapping
        )
    }

    private func importEncryptedFolderSyncData(_ data: EncryptedFolderSyncData) {
        let defaults = NotebookDefaults.shared

        // 合并加密文件夹列表（以远程为准，添加本地不存在的）
        let encryptedFoldersKey = "encrypted_folders"
        var localFolders: [EncryptedFolder] = []
        if let folderData = defaults.data(forKey: encryptedFoldersKey),
           let folders = try? JSONDecoder().decode([EncryptedFolder].self, from: folderData) {
            localFolders = folders
        }
        let localFolderIDs = Set(localFolders.map(\.id))
        for remoteFolder in data.encryptedFolders {
            if !localFolderIDs.contains(remoteFolder.id) {
                localFolders.append(remoteFolder)
            }
            // 保存文件夹名称
            let nameKey = "encrypted_folder_name_\(remoteFolder.id.uuidString)"
            defaults.set(remoteFolder.name, forKey: nameKey)
        }
        if let encoded = try? JSONEncoder().encode(localFolders) {
            defaults.set(encoded, forKey: encryptedFoldersKey)
        }

        // 合并加密笔记ID（取并集）
        var localEncryptedIDs = Set(defaults.stringArray(forKey: "encrypted_note_ids") ?? [])
        for id in data.encryptedNoteIDs {
            localEncryptedIDs.insert(id)
        }
        defaults.set(Array(localEncryptedIDs), forKey: "encrypted_note_ids")

        // 合并笔记到文件夹的映射（以远程为准覆盖）
        var localMapping = defaults.dictionary(forKey: "note_to_encrypted_folder") as? [String: String] ?? [:]
        for (noteID, folderID) in data.noteToFolderMapping {
            localMapping[noteID] = folderID
        }
        defaults.set(localMapping, forKey: "note_to_encrypted_folder")
    }
}
