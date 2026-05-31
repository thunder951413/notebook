import Foundation
import SwiftData
import CryptoKit
import Dispatch

struct RemoteNoteIndex: Codable {
    let generatedAt: Date
    let deviceID: String
    let entries: [RemoteNoteIndexEntry]
    /// 已永久删除的笔记记录，用于多端同步删除状态
    let deletedEntries: [RemoteDeletedEntry]

    init(generatedAt: Date, deviceID: String, entries: [RemoteNoteIndexEntry], deletedEntries: [RemoteDeletedEntry] = []) {
        self.generatedAt = generatedAt
        self.deviceID = deviceID
        self.entries = entries
        self.deletedEntries = deletedEntries
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try container.decode(Date.self, forKey: .generatedAt)
        deviceID = try container.decode(String.self, forKey: .deviceID)
        entries = try container.decode([RemoteNoteIndexEntry].self, forKey: .entries)
        deletedEntries = try container.decodeIfPresent([RemoteDeletedEntry].self, forKey: .deletedEntries) ?? []
    }
}

struct RemoteNoteIndexEntry: Codable {
    let noteID: UUID
    let version: Int64
    let contentHash: String
    let historyCount: Int
}

/// 远程已删除笔记记录
struct RemoteDeletedEntry: Codable {
    let noteID: UUID
    let deletedAt: Date
    let deletedByDeviceID: String
}

/// 附件清单 - 记录远程已同步附件的哈希，用于增量同步
struct AssetsManifest: Codable {
    let generatedAt: Date
    let deviceID: String
    let entries: [AssetsManifestEntry]
}

struct AssetsManifestEntry: Codable {
    let relativePath: String
    let contentHash: String
    let size: Int
}

/// 文件夹和标签同步信封
struct LibrarySyncEnvelope: Codable {
    let exportedAt: Date
    let deviceID: String
    let folders: [FolderSyncEntry]
    let tags: [TagSyncEntry]
    let encryptedData: EncryptedFolderSyncData?
}

struct FolderSyncEntry: Codable {
    let id: UUID
    let name: String
    let sortOrder: Int
    let isSystem: Bool
    let createdAt: Date?
}

struct TagSyncEntry: Codable {
    let id: UUID
    let name: String
    let color: String
    let createdAt: Date
}

/// 加密文件夹同步数据
struct EncryptedFolderSyncData: Codable {
    let encryptedFolders: [EncryptedFolder]
    let encryptedNoteIDs: [String]
    let noteToFolderMapping: [String: String]
}

/// 同步进度
struct SSHSyncProgress {
    let phase: SyncPhase
    let current: Int
    let total: Int
    let message: String

    var fraction: Double {
        guard total > 0 else { return 0 }
        return Double(current) / Double(total)
    }
}

typealias SSHSyncProgressHandler = @Sendable (SSHSyncProgress) async -> Void

enum SyncPhase: String {
    case pushLibrary = "推送文件夹/标签"
    case pushNotes = "推送笔记"
    case pushAssets = "推送附件"
    case pushConfig = "推送配置"
    case pullLibrary = "拉取文件夹/标签"
    case pullNotes = "拉取笔记"
    case pullAssets = "拉取附件"
    case pullConfig = "拉取配置"
    case checkMissingAssets = "检查缺失附件"
}

/// SSH 同步管理器 - 使用 sshpass 进行密码认证
final class SSHSyncManager: @unchecked Sendable {
    static let shared = SSHSyncManager()

    private struct ProcessExecutionResult {
        let terminationStatus: Int32
        let standardOutput: String
        let standardError: String
    }

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
    }

    private let noteDownloadConcurrencyLimit = 4
    private let assetDownloadConcurrencyLimit = 4

    // SSH 连接复用相关
    private var activeControlMasterPaths: Set<String> = []
    private let controlMasterLock = NSLock()
    private var activeSyncOperationName: String?
    private let syncOperationLock = NSLock()

    private init() {}

    var isSyncOperationRunning: Bool {
        syncOperationLock.withLock {
            activeSyncOperationName != nil
        }
    }

    private func beginSyncOperation(named operationName: String) throws {
        let runningOperation = syncOperationLock.withLock { () -> String? in
            if let activeSyncOperationName {
                return activeSyncOperationName
            }
            activeSyncOperationName = operationName
            return nil
        }

        if let runningOperation {
            throw NSError(
                domain: "SSHSync",
                code: -2001,
                userInfo: [NSLocalizedDescriptionKey: "已有同步任务正在执行：\(runningOperation)"]
            )
        }
    }

    private func endSyncOperation() {
        _ = syncOperationLock.withLock {
            activeSyncOperationName = nil
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
        let alreadyActive = controlMasterLock.withLock {
            activeControlMasterPaths.contains(controlPath)
        }
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
                _ = controlMasterLock.withLock {
                    activeControlMasterPaths.insert(controlPath)
                }
                return
            } else {
                // 旧连接已失效，清理
                try? FileManager.default.removeItem(atPath: controlPath)
            }
        }

        // 建立新的主连接
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: [
                "-e",
                "ssh",
                "-f",  // 后台运行
                "-N",  // 不执行远程命令
                "-o", "ControlMaster=yes",
                "-o", "ControlPath=\(controlPath)",
                "-o", "ControlPersist=600",  // 10 分钟无连接自动关闭
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "PreferredAuthentications=keyboard-interactive,password",
                "-o", "PubkeyAuthentication=no",
                "-o", "NumberOfPasswordPrompts=1",
                "-o", "ConnectTimeout=15",
                "-p", String(config.port),
                "\(config.username)@\(config.host)"
            ],
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

        _ = controlMasterLock.withLock {
            activeControlMasterPaths.insert(controlPath)
        }

        Logger.shared.log(.storage, .info, "[SSHSync] SSH 主连接已建立: \(config.username)@\(config.host):\(config.port)")
    }

    /// 关闭 SSH 主连接
    private func closeControlMasterConnection(config: SSHConfig) {
        let controlPath = sshControlPath(for: config)

        let didRemove = controlMasterLock.withLock { () -> Bool in
            guard activeControlMasterPaths.contains(controlPath) else { return false }
            activeControlMasterPaths.remove(controlPath)
            return true
        }
        guard didRemove else { return }

        // 发送退出信号给 ControlMaster
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        task.arguments = [
            "-o", "ControlPath=\(controlPath)",
            "-o", "ControlMaster=no",
            "-O", "exit",
            "\(config.username)@\(config.host)"
        ]

        do {
            try task.run()
            task.waitUntilExit()
            Logger.shared.log(.storage, .debug, "[SSHSync] SSH 主连接已关闭: \(config.username)@\(config.host):\(config.port)")
        } catch {
            Logger.shared.log(.storage, .warn, "[SSHSync] 关闭 SSH 主连接失败: \(error.localizedDescription)")
        }

        // 清理控制 socket 文件
        try? FileManager.default.removeItem(atPath: controlPath)
    }

    /// 关闭所有活跃的 SSH 主连接
    func closeAllControlMasterConnections() {
        let paths = controlMasterLock.withLock {
            Array(activeControlMasterPaths)
        }

        for path in paths {
            if let config = extractConfigFromControlPath(path) {
                closeControlMasterConnection(config: config)
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
        // 首先尝试通过 which 命令查找
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/zsh")
        task.arguments = ["-c", "which sshpass 2>/dev/null || echo ''"]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        do {
            try task.run()
            task.waitUntilExit()

            if task.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty {
                    return path
                }
            }
        } catch {
            Logger.shared.log(.storage, .warn, "which sshpass 失败: \(error.localizedDescription)")
        }

        // 回退到硬编码路径
        let hardcodedPath = "/usr/local/bin/sshpass"
        Logger.shared.log(.storage, .warn, "使用硬编码路径: \(hardcodedPath)")
        return hardcodedPath
    }

    /// 检查 sshpass 是否可用
    private func checkSshpassAvailable() throws -> String {
        if let path = findSshpassPath(), !path.isEmpty {
            return path
        }
        // 最后的回退：直接尝试硬编码路径
        return "/usr/local/bin/sshpass"
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

        let quotedRemotePath = config.repositoryPath
            .replacingOccurrences(of: "'", with: "'\"'\"'")
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p '\(quotedRemotePath)'",
            controlPath: controlPath
        )
    }

    func syncNoteToRemote(
        noteID: UUID,
        context: ModelContext,
        config: SSHConfig,
        controlPath: String? = nil,
        updateRemoteCatalog: Bool = true
    ) async throws {
        guard let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: noteID, context: context) else {
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

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(envelope)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("note_sync_\(noteID.uuidString)_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTempPath = "\(remoteNoteDirectory)/\(noteID.uuidString).json.tmp"
        let remoteTargetPath = "\(remoteNoteDirectory)/\(noteID.uuidString).json"

        try await runSCPUpload(
            sshpassPath: sshpassPath,
            config: config,
            localPath: tempFileURL.path,
            remotePath: remoteTempPath,
            controlPath: controlPath
        )

        // 上传校验：比对本地与远程文件的 sha256 哈希
        let localHash = Self.payloadDigest(for: payload)
        var uploadVerifyRetryCount = 0
        while true {
            let remoteHashOutput = try await runSSHCommandForOutput(
                sshpassPath: sshpassPath,
                config: config,
                command: "shasum -a 256 \(shellQuotedRemotePath(remoteTempPath)) 2>/dev/null | cut -d' ' -f1",
                controlPath: controlPath
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            if remoteHashOutput == localHash {
                break
            }
            uploadVerifyRetryCount += 1
            if uploadVerifyRetryCount >= 2 {
                Logger.shared.log(.storage, .error, "[SSHSync] 上传校验失败：本地=\(localHash.prefix(16))... 远程=\(remoteHashOutput.prefix(16))... noteID=\(noteID.uuidString.prefix(8))")
                throw NSError(
                    domain: "SSHSync",
                    code: -2002,
                    userInfo: [NSLocalizedDescriptionKey: "上传校验失败：远程文件哈希与本地不一致"]
                )
            }
            Logger.shared.log(.storage, .warn, "[SSHSync] 上传校验不一致，重试 \(uploadVerifyRetryCount)/2：noteID=\(noteID.uuidString.prefix(8))")
            try await runSCPUpload(
                sshpassPath: sshpassPath,
                config: config,
                localPath: tempFileURL.path,
                remotePath: remoteTempPath,
                controlPath: controlPath
            )
        }

        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv \(shellQuotedRemotePath(remoteTempPath)) \(shellQuotedRemotePath(remoteTargetPath))",
            controlPath: controlPath
        )

        // 上传附件文件
        try await uploadAssetsForNote(envelope: envelope, sshpassPath: sshpassPath, config: config, controlPath: controlPath)

        try BlockDocumentNoteVersionStore.markSynced(envelope: envelope, context: context)

        if updateRemoteCatalog {
            try await updateRemoteCatalogForSingleNote(
                envelope: envelope,
                context: context,
                config: config,
                controlPath: controlPath
            )
        }
    }

    func syncAllNotesToRemote(
        context: ModelContext,
        config: SSHConfig,
        progressHandler: SSHSyncProgressHandler? = nil
    ) async throws -> [UUID] {
        try beginSyncOperation(named: "推送笔记")
        defer { endSyncOperation() }

        let sshpassPath = try checkSshpassAvailable()
        let controlPath = sshControlPath(for: config)
        
        // 建立 SSH 主连接
        try await establishControlMasterConnection(sshpassPath: sshpassPath, config: config)
        
        defer {
            // 同步完成后关闭主连接
            closeControlMasterConnection(config: config)
        }
        
        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
            .sorted { $0.updatedAt > $1.updatedAt }
        let existingNoteIDs = Set(notes.map { $0.id })
        let tombstonedNoteIDs = Set(try BlockDocumentNoteVersionStore.deletedTombstones(context: context).map(\.noteID))
        var syncedNoteIDs: [UUID] = []
        var indexEntries: [RemoteNoteIndexEntry] = []
        var allAssetEntries: [AssetsManifestEntry] = []
        let totalNotes = max(notes.count, 1)

        await reportProgress(
            progressHandler,
            phase: .pushNotes,
            current: notes.isEmpty ? 1 : 0,
            total: totalNotes,
            message: notes.isEmpty ? "没有需要推送的笔记，正在整理远程索引..." : "正在推送笔记 0/\(notes.count)"
        )

        for (index, note) in notes.enumerated() {
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

            let syncState = try fetchSyncState(noteID: note.id, context: context)
            let hasUnresolvedConflict = note.hasConflict
            let shouldSync = !hasUnresolvedConflict && (
                syncState == nil ||
                syncState!.lastSyncedVersion < note.version ||
                syncState!.pendingHistoryCount > 0
            )
            if shouldSync {
                try await syncNoteToRemote(
                    noteID: note.id,
                    context: context,
                    config: config,
                    controlPath: controlPath,
                    updateRemoteCatalog: false
                )
                syncedNoteIDs.append(note.id)
            }
            if let entry = try makeRemoteIndexEntry(noteID: note.id, context: context) {
                indexEntries.append(entry)
            }

            // 收集附件清单
            if let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: note.id, context: context) {
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

        await reportProgress(
            progressHandler,
            phase: .pushConfig,
            current: 0,
            total: 1,
            message: "正在更新远程索引..."
        )
        try await uploadRemoteIndex(entries: indexEntries, deletedEntries: deletedEntries, config: config, controlPath: controlPath)

        // 清理已同步删除记录的 SyncState，避免下次推送重复收集
        cleanupDeletedSyncStates(
            deletedNoteIDs: Set(deletedEntries.map { $0.noteID }),
            context: context
        )
        try await uploadAssetsManifest(entries: allAssetEntries, config: config, controlPath: controlPath)
        await reportProgress(
            progressHandler,
            phase: .pushLibrary,
            current: 0,
            total: 1,
            message: "正在同步文件夹和标签..."
        )
        try await syncLibraryToRemote(context: context, config: config, controlPath: controlPath)
        await reportProgress(
            progressHandler,
            phase: .pushLibrary,
            current: 1,
            total: 1,
            message: "文件夹和标签同步完成"
        )

        // 清理远程孤儿文件（已删除笔记的 .json 和附件）
        let activeNoteIDs = Set(indexEntries.map { $0.noteID })
        try await cleanupRemoteOrphanFiles(
            activeNoteIDs: activeNoteIDs,
            deletedNoteIDs: Set(deletedEntries.map { $0.noteID }),
            config: config,
            controlPath: controlPath
        )

        // 裁剪历史版本，避免无限增长
        for note in notes {
            try? BlockDocumentNoteVersionStore.pruneHistory(noteID: note.id, context: context)
        }

        return syncedNoteIDs
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
        try beginSyncOperation(named: "拉取笔记")
        defer { endSyncOperation() }

        let sshpassPath = try checkSshpassAvailable()
        let controlPath = sshControlPath(for: config)
        
        // 建立 SSH 主连接
        try await establishControlMasterConnection(sshpassPath: sshpassPath, config: config)
        
        defer {
            // 同步完成后关闭主连接
            closeControlMasterConnection(config: config)
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

        // 处理远程已删除的笔记：对本地存在的笔记执行软删除
        if didRemoteIndexChange {
            try applyRemoteDeletedEntries(remoteIndex.deletedEntries, context: context)
        }

        // 过滤出需要拉取的笔记（排除已在 deletedEntries 中的）
        let noteIDs: [UUID]
        if didRemoteIndexChange {
            let remoteDeletedIDs = Set(remoteIndex.deletedEntries.map { $0.noteID })
            noteIDs = remoteIndex.entries
                .filter { entry in
                    // 跳过已删除的笔记
                    guard !remoteDeletedIDs.contains(entry.noteID) else { return false }
                    guard let syncState = try? fetchSyncState(noteID: entry.noteID, context: context) else {
                        return true
                    }
                    if entry.version > syncState.lastRemoteVersion {
                        return true
                    }
                    return entry.contentHash != syncState.remoteFingerprint
                }
                .map(\.noteID)
                .sorted { $0.uuidString < $1.uuidString }
        } else {
            noteIDs = []
        }
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
            controlPath: controlPath
        )

        let manifestBundle = try await downloadAssetsManifestBundle(config: config, controlPath: controlPath)
        var manifestEntries = manifestBundle.manifest?.entries ?? []
        let noteAssetPaths = Set(envelope.currentSnapshot.assets.flatMap { [$0.relativeFilePath] + $0.sidecarRelativePaths })
        manifestEntries.removeAll { noteAssetPaths.contains($0.relativePath) }
        manifestEntries.append(contentsOf: try collectAssetsManifestEntries(from: envelope))
        try await uploadAssetsManifest(
            entries: manifestEntries,
            config: config,
            controlPath: controlPath
        )
    }

    private func uploadRemoteIndex(entries: [RemoteNoteIndexEntry], deletedEntries: [RemoteDeletedEntry] = [], config: SSHConfig, controlPath: String? = nil) async throws {
        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config, controlPath: controlPath)
        let remoteNoteDirectory = "\(config.repositoryPath)/notes"
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p \(shellQuotedRemotePath(remoteNoteDirectory))",
            controlPath: controlPath
        )

        let index = RemoteNoteIndex(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: entries.sorted { $0.noteID.uuidString < $1.noteID.uuidString },
            deletedEntries: deletedEntries.sorted { $0.noteID.uuidString < $1.noteID.uuidString }
        )
        let payload = try encodeRemoteNoteIndex(index)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("note_sync_index_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTempPath = "\(remoteNoteDirectory)/index.json.tmp"
        let remoteTargetPath = "\(remoteNoteDirectory)/index.json"
        try await runSCPUpload(
            sshpassPath: sshpassPath,
            config: config,
            localPath: tempFileURL.path,
            remotePath: remoteTempPath,
            controlPath: controlPath
        )
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv \(shellQuotedRemotePath(remoteTempPath)) \(shellQuotedRemotePath(remoteTargetPath))",
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
            command: "if [ -d '\(escapeSingleQuoted(remoteNoteDirectory))' ]; then ls '\(escapeSingleQuoted(remoteNoteDirectory))'; fi",
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

    private func fetchSyncState(noteID: UUID, context: ModelContext) throws -> BlockDocumentNoteSyncStateEntity? {
        let descriptor = FetchDescriptor<BlockDocumentNoteSyncStateEntity>(
            predicate: #Predicate<BlockDocumentNoteSyncStateEntity> { $0.noteID == noteID }
        )
        return try context.fetch(descriptor).first
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

    private func sshArguments(config: SSHConfig, command: String, controlPath: String? = nil) -> [String] {
        [
            "-e",
            "ssh"
        ] + commonSSHOptions(port: config.port, controlPath: controlPath) + [
            "\(config.username)@\(config.host)",
            command
        ]
    }

    private func scpUploadArguments(config: SSHConfig, localPath: String, remotePath: String, controlPath: String? = nil) -> [String] {
        [
            "-e",
            "scp"
        ] + commonSCPOptions(port: config.port, controlPath: controlPath) + [
            localPath,
            "\(config.username)@\(config.host):\(remotePath)"
        ]
    }

    private func scpDownloadArguments(config: SSHConfig, remotePath: String, localPath: String, controlPath: String? = nil) -> [String] {
        [
            "-e",
            "scp"
        ] + commonSCPOptions(port: config.port, controlPath: controlPath) + [
            "\(config.username)@\(config.host):\(remotePath)",
            localPath
        ]
    }

    private func commonSSHOptions(port: Int, controlPath: String? = nil) -> [String] {
        var options = [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=2",
            "-p", String(port)
        ]
        
        // 如果提供了 controlPath，使用连接复用
        if let controlPath = controlPath {
            options.append(contentsOf: [
                "-o", "ControlMaster=auto",
                "-o", "ControlPath=\(controlPath)",
                "-o", "ControlPersist=600"
            ])
        }
        
        return options
    }

    private func commonSCPOptions(port: Int, controlPath: String? = nil) -> [String] {
        var options = [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=2",
            "-P", String(port)
        ]
        
        // 如果提供了 controlPath，使用连接复用
        if let controlPath = controlPath {
            options.append(contentsOf: [
                "-o", "ControlMaster=auto",
                "-o", "ControlPath=\(controlPath)",
                "-o", "ControlPersist=600"
            ])
        }
        
        return options
    }

    private func executeProcess(
        executablePath: String,
        arguments: [String],
        password: String,
        timeout: TimeInterval = 45
    ) async throws -> ProcessExecutionResult {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["SSHPASS"] = password
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executablePath)
        task.arguments = arguments
        task.environment = env
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        task.standardOutput = outputPipe
        task.standardError = errorPipe

        let timeoutErrorMessage = Self.sanitizeLog("SSH 操作超时，请检查服务器连通性、端口配置或网络状态", password: password)

        return try await withCheckedThrowingContinuation { continuation in
            let lock = NSLock()
            var finished = false
            let finishedQueue = DispatchQueue(label: "com.notebook.ssh.finished")

            @Sendable func resume(_ result: Result<ProcessExecutionResult, Error>) {
                lock.lock()
                defer { lock.unlock() }

                var shouldResume = false
                finishedQueue.sync {
                    guard !finished else { return }
                    finished = true
                    shouldResume = true
                }

                guard shouldResume else { return }
                continuation.resume(with: result)
            }

            task.terminationHandler = { process in
                let output = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let error = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                resume(.success(ProcessExecutionResult(
                    terminationStatus: process.terminationStatus,
                    standardOutput: output,
                    standardError: error
                )))
            }

            do {
                try task.run()
            } catch {
                resume(.failure(error))
                return
            }

            Task.detached {
                let delay = UInt64(max(1, timeout) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: delay)
                guard task.isRunning else { return }
                task.terminate()
                resume(.failure(NSError(
                    domain: "SSHSync",
                    code: -1001,
                    userInfo: [NSLocalizedDescriptionKey: timeoutErrorMessage]
                )))
            }
        }
    }

    private func escapeSingleQuoted(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "'\"'\"'")
    }

    private func shellQuotedRemotePath(_ path: String) -> String {
        if path == "~" {
            return "~"
        }
        if path.hasPrefix("~/") {
            let suffix = String(path.dropFirst(2))
            return "~/" + "'\(escapeSingleQuoted(suffix))'"
        }
        return "'\(escapeSingleQuoted(path))'"
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

    /// 清理远程孤儿文件（已删除笔记的 .json 和附件目录）
    private func cleanupRemoteOrphanFiles(activeNoteIDs: Set<UUID>, deletedNoteIDs: Set<UUID>, config: SSHConfig, controlPath: String? = nil) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let remoteNoteDirectory = "\(config.repositoryPath)/notes"

        // 列出远程 notes/ 目录下所有 .json 文件
        let listing = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: config,
            command: "if [ -d '\\(escapeSingleQuoted(remoteNoteDirectory))' ]; then ls '\\(escapeSingleQuoted(remoteNoteDirectory))'; else echo ''; fi",
            controlPath: controlPath
        )

        let remoteFiles = listing.split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.hasSuffix(".json") && $0 != "index.json" && $0 != "assets_manifest.json" }

        for filename in remoteFiles {
            let idString = filename.replacingOccurrences(of: ".json", with: "")
            guard let noteID = UUID(uuidString: idString) else { continue }

            // 仅删除明确在已删除列表中的远程文件，避免误删未同步过的笔记
            if deletedNoteIDs.contains(noteID) {
                let remotePath = "\(remoteNoteDirectory)/\(filename)"
                Logger.shared.log(.storage, .info, "[SSHSync] 清理远程孤儿笔记文件：\(remotePath)")
                try? await runSSHCommand(
                    sshpassPath: sshpassPath,
                    config: config,
                    command: "rm -f '\\(escapeSingleQuoted(remotePath))'",
                    controlPath: controlPath
                )
            }
        }

        // 清理已删除笔记的远程附件目录
        // 通过 assets_manifest.json 确定哪些附件属于已删除笔记
        if !deletedNoteIDs.isEmpty {
            // 获取附件清单中属于已删除笔记的附件路径
            let remoteAttachmentsDir = "\(config.repositoryPath)/attachments"
            // 简单策略：删除以笔记ID为路径前缀的附件目录
            // 附件路径格式通常为 {noteID}/... 或直接文件名
            for deletedID in deletedNoteIDs {
                let noteAttachmentDir = "\(remoteAttachmentsDir)/\(deletedID.uuidString)"
                // 检查目录是否存在，存在则删除
                _ = try? await runSSHCommandForOutput(
                    sshpassPath: sshpassPath,
                    config: config,
                    command: "if [ -d '\(escapeSingleQuoted(noteAttachmentDir))' ]; then rm -rf '\(escapeSingleQuoted(noteAttachmentDir))'; echo DELETED; else echo SKIP; fi",
                    controlPath: controlPath
                )
            }
        }
    }

    /// 清理本地已同步删除记录（避免每次推送都重复收集）
    private func cleanupDeletedSyncStates(deletedNoteIDs: Set<UUID>, context: ModelContext) {
        guard !deletedNoteIDs.isEmpty else { return }
        for noteID in deletedNoteIDs {
            let descriptor = FetchDescriptor<BlockDocumentNoteSyncStateEntity>(
                predicate: #Predicate<BlockDocumentNoteSyncStateEntity> { $0.noteID == noteID }
            )
            if let syncState = try? context.fetch(descriptor).first {
                context.delete(syncState)
            }
        }
        try? BlockDocumentNoteVersionStore.cleanupDeletedTombstones(noteIDs: deletedNoteIDs, context: context)
        try? context.save()
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
                let localURL = attachmentsRoot.appendingPathComponent(relativePath)
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
                try await runSCPUpload(
                    sshpassPath: sshpassPath,
                    config: config,
                    localPath: localURL.path,
                    remotePath: remotePath,
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
                let localURL = attachmentsRoot.appendingPathComponent(relativePath)
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

                try await runSCPDownload(
                    sshpassPath: sshpassPath,
                    config: config,
                    remotePath: remotePath,
                    localPath: localURL.path,
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
                let localURL = attachmentsRoot.appendingPathComponent(relativePath)
                guard FileManager.default.fileExists(atPath: localURL.path),
                      let data = try? Data(contentsOf: localURL) else { continue }
                let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                entries.append(AssetsManifestEntry(
                    relativePath: relativePath,
                    contentHash: hash,
                    size: data.count
                ))
            }
        }
        return entries
    }

    private func uploadAssetsManifest(entries: [AssetsManifestEntry], config: SSHConfig, controlPath: String? = nil) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let manifest = AssetsManifest(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: entries.sorted { $0.relativePath < $1.relativePath }
        )
        let payload = try encodeAssetsManifest(manifest)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("assets_manifest_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTempPath = "\(config.repositoryPath)/notes/assets_manifest.json.tmp"
        let remoteTargetPath = "\(config.repositoryPath)/notes/assets_manifest.json"

        try await runSCPUpload(
            sshpassPath: sshpassPath,
            config: config,
            localPath: tempFileURL.path,
            remotePath: remoteTempPath,
            controlPath: controlPath
        )
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv \(shellQuotedRemotePath(remoteTempPath)) \(shellQuotedRemotePath(remoteTargetPath))",
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
                let localURL = attachmentsRoot.appendingPathComponent(relativePath)

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
                    downloadJobs.append(AssetDownloadJob(relativePath: relativePath, localURL: localURL))
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
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(RemoteSyncCacheState.self, from: data)
    }

    private func saveRemoteSyncCacheState(_ state: RemoteSyncCacheState, config: SSHConfig) {
        let key = remoteSyncCacheKey(for: config)
        guard let data = try? JSONEncoder().encode(state) else { return }
        UserDefaults.standard.set(data, forKey: key)
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
        sshpassPath: String,
        config: SSHConfig,
        remoteAttachmentsDir: String,
        controlPath: String?
    ) async throws {
        // 确保本地目录存在
        let localDir = localURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)

        let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"

        try await runSCPDownload(
            sshpassPath: sshpassPath,
            config: config,
            remotePath: remotePath,
            localPath: localURL.path,
            controlPath: controlPath
        )

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

        // 收集加密文件夹数据
        let encryptedData = collectEncryptedFolderSyncData()

        let envelope = LibrarySyncEnvelope(
            exportedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            folders: folders.map {
                FolderSyncEntry(id: $0.id, name: $0.name, sortOrder: $0.sortOrder, isSystem: $0.isSystem, createdAt: $0.createdAt)
            },
            tags: tags.map {
                TagSyncEntry(id: $0.id, name: $0.name, color: $0.color, createdAt: $0.createdAt)
            },
            encryptedData: encryptedData
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(envelope)
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("library_sync_\(UUID().uuidString).json")
        try payload.write(to: tempFileURL, options: [.atomic])
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        let remoteTempPath = "\(config.repositoryPath)/library.json.tmp"
        let remoteTargetPath = "\(config.repositoryPath)/library.json"

        try await runSCPUpload(
            sshpassPath: sshpassPath,
            config: config,
            localPath: tempFileURL.path,
            remotePath: remoteTempPath,
            controlPath: controlPath
        )
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv '\(escapeSingleQuoted(remoteTempPath))' '\(escapeSingleQuoted(remoteTargetPath))'",
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

        // 合并文件夹
        for remoteFolder in envelope.folders {
            let idToMatch = remoteFolder.id
            let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(
                predicate: #Predicate<BlockDocumentFolderEntity> { $0.id == idToMatch }
            )
            if let existing = try context.fetch(descriptor).first {
                existing.name = remoteFolder.name
                existing.sortOrder = remoteFolder.sortOrder
            } else {
                let entity = BlockDocumentFolderEntity(
                    id: remoteFolder.id,
                    libraryID: localLibraryID,
                    name: remoteFolder.name,
                    sortOrder: remoteFolder.sortOrder,
                    isSystem: remoteFolder.isSystem,
                    createdAt: remoteFolder.createdAt
                )
                context.insert(entity)
            }
        }

        // 合并标签
        for remoteTag in envelope.tags {
            let idToMatch = remoteTag.id
            let descriptor = FetchDescriptor<BlockDocumentTagEntity>(
                predicate: #Predicate<BlockDocumentTagEntity> { $0.id == idToMatch }
            )
            if let existing = try context.fetch(descriptor).first {
                existing.name = remoteTag.name
                existing.color = remoteTag.color
            } else {
                let entity = BlockDocumentTagEntity(
                    id: remoteTag.id,
                    libraryID: localLibraryID,
                    name: remoteTag.name,
                    color: remoteTag.color,
                    createdAt: remoteTag.createdAt
                )
                context.insert(entity)
            }
        }

        // 合并加密文件夹数据
        if let encryptedData = envelope.encryptedData {
            importEncryptedFolderSyncData(encryptedData)
        }

        try context.save()
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
        try? context.save()
        return library.id
    }

    // MARK: - Encrypted Folder Sync

    private func collectEncryptedFolderSyncData() -> EncryptedFolderSyncData {
        let defaults = UserDefaults.standard

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
        let defaults = UserDefaults.standard

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
