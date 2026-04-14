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
class SSHSyncManager {
    static let shared = SSHSyncManager()

    private struct ProcessExecutionResult {
        let terminationStatus: Int32
        let standardOutput: String
        let standardError: String
    }

    private init() {}

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
            print("which sshpass 失败: \(error)")
        }

        // 回退到硬编码路径
        let hardcodedPath = "/usr/local/bin/sshpass"
        print("使用硬编码路径: \(hardcodedPath)")
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
        guard !password.isEmpty else { return text }
        return text.replacingOccurrences(of: password, with: "******")
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

        print("SSH Test Output: \(Self.sanitizeLog(output, password: config.password))")
        print("SSH Test Error: \(Self.sanitizeLog(errorOutput, password: config.password))")
        print("SSH Test Exit Code: \(result.terminationStatus)")

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
    func ensureRemoteDirectory(config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()

        let quotedRemotePath = config.repositoryPath
            .replacingOccurrences(of: "'", with: "'\"'\"'")
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p '\(quotedRemotePath)'"
        )
    }

    func syncNoteToRemote(noteID: UUID, context: ModelContext, config: SSHConfig) async throws {
        guard let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: noteID, context: context) else {
            return
        }

        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config)

        let remoteNoteDirectory = "\(config.repositoryPath)/notes"
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p '\(escapeSingleQuoted(remoteNoteDirectory))'"
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
            remotePath: remoteTempPath
        )
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv '\(escapeSingleQuoted(remoteTempPath))' '\(escapeSingleQuoted(remoteTargetPath))'"
        )

        // 上传附件文件
        try await uploadAssetsForNote(envelope: envelope, sshpassPath: sshpassPath, config: config)

        try BlockDocumentNoteVersionStore.markSynced(
            noteID: noteID,
            syncedVersion: envelope.currentVersion,
            context: context
        )
    }

    func syncAllNotesToRemote(context: ModelContext, config: SSHConfig) async throws -> [UUID] {
        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
            .sorted { $0.updatedAt > $1.updatedAt }
        let existingNoteIDs = Set(notes.map { $0.id })
        var syncedNoteIDs: [UUID] = []
        var indexEntries: [RemoteNoteIndexEntry] = []
        var allAssetEntries: [AssetsManifestEntry] = []

        for note in notes {
            let syncState = try fetchSyncState(noteID: note.id, context: context)
            let shouldSync =
                syncState == nil ||
                syncState!.lastSyncedVersion < note.version ||
                syncState!.pendingHistoryCount > 0
            if shouldSync {
                try await syncNoteToRemote(noteID: note.id, context: context, config: config)
                syncedNoteIDs.append(note.id)
            }
            if let entry = try makeRemoteIndexEntry(noteID: note.id, context: context) {
                indexEntries.append(entry)
            }

            // 收集附件清单
            if let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: note.id, context: context) {
                allAssetEntries.append(contentsOf: try collectAssetsManifestEntries(from: envelope))
            }
        }

        // 收集本地已永久删除的笔记记录（SyncState存在但NoteEntity已不存在）
        let deletedEntries = try collectLocallyDeletedEntries(
            existingNoteIDs: existingNoteIDs,
            context: context
        )

        try await uploadRemoteIndex(entries: indexEntries, deletedEntries: deletedEntries, config: config)
        try await uploadAssetsManifest(entries: allAssetEntries, config: config)
        try await syncLibraryToRemote(context: context, config: config)

        // 清理远程孤儿文件（已删除笔记的 .json 和附件）
        let activeNoteIDs = Set(indexEntries.map { $0.noteID })
        try await cleanupRemoteOrphanFiles(
            activeNoteIDs: activeNoteIDs,
            deletedNoteIDs: Set(deletedEntries.map { $0.noteID }),
            config: config
        )

        return syncedNoteIDs
    }

    func syncNoteFromRemote(noteID: UUID, context: ModelContext, config: SSHConfig) async throws -> NoteSyncMergeResult {
        let sshpassPath = try checkSshpassAvailable()
        let remotePath = "\(config.repositoryPath)/notes/\(noteID.uuidString).json"
        let tempFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("note_sync_pull_\(noteID.uuidString)_\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tempFileURL) }

        try await runSCPDownload(
            sshpassPath: sshpassPath,
            config: config,
            remotePath: remotePath,
            localPath: tempFileURL.path
        )

        let payload = try Data(contentsOf: tempFileURL)
        let envelope = try JSONDecoder().decode(VersionedNoteSyncEnvelope.self, from: payload)

        // 先下载附件文件，确保文件到位后再导入笔记数据
        // 这样如果附件下载失败，同步状态不会被更新，下次同步会重试
        try await downloadAssetsForNote(envelope: envelope, sshpassPath: sshpassPath, config: config)

        let result = try BlockDocumentNoteVersionStore.mergeRemoteEnvelope(envelope, context: context)

        if !result.detectedConflict {
            try BlockDocumentNoteVersionStore.markSynced(
                noteID: noteID,
                syncedVersion: min(result.localVersion, result.remoteVersion),
                context: context
            )
        }
        return result
    }

    func syncAllNotesFromRemote(context: ModelContext, config: SSHConfig) async throws -> [NoteSyncMergeResult] {
        // 先拉取文件夹和标签
        try await syncLibraryFromRemote(context: context, config: config)

        let remoteIndex = try await downloadRemoteIndex(config: config)
        guard let remoteIndex else {
            // index.json 不存在视为空仓库，不做任何拉取
            // 但仍需处理本地已有笔记的补充附件下载
            print("[SSHSync] 远程 index.json 不存在，视为空仓库")
            return []
        }

        // 处理远程已删除的笔记：对本地存在的笔记执行软删除
        try applyRemoteDeletedEntries(remoteIndex.deletedEntries, context: context)

        // 过滤出需要拉取的笔记（排除已在 deletedEntries 中的）
        let remoteDeletedIDs = Set(remoteIndex.deletedEntries.map { $0.noteID })
        let noteIDs = remoteIndex.entries
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

        var results: [NoteSyncMergeResult] = []
        for noteID in noteIDs {
            do {
                let result = try await syncNoteFromRemote(noteID: noteID, context: context, config: config)
                results.append(result)
            } catch {
                if isRemoteFileMissing(error) {
                    print("[SSHSync] 远程笔记文件不存在，跳过：\(noteID.uuidString)")
                    continue
                }
                throw error
            }
        }

        // 补充下载：检查所有已有笔记中缺失的附件文件
        do {
            try await downloadMissingAssetsForExistingNotes(context: context, config: config)
        } catch {
            if !isRemoteFileMissing(error) {
                throw error
            }
            print("[SSHSync] 补充下载附件时远程文件缺失，跳过：\(error.localizedDescription)")
        }

        return results
    }

    private func makeRemoteIndexEntry(noteID: UUID, context: ModelContext) throws -> RemoteNoteIndexEntry? {
        guard let envelope = try BlockDocumentNoteVersionStore.exportEnvelope(noteID: noteID, context: context) else {
            return nil
        }
        let snapshotData = try JSONEncoder().encode(envelope.currentSnapshot)
        let contentHash = SHA256.hash(data: snapshotData).map { String(format: "%02x", $0) }.joined()
        return RemoteNoteIndexEntry(
            noteID: noteID,
            version: envelope.currentVersion,
            contentHash: contentHash,
            historyCount: envelope.history.count
        )
    }

    private func uploadRemoteIndex(entries: [RemoteNoteIndexEntry], deletedEntries: [RemoteDeletedEntry] = [], config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config)
        let remoteNoteDirectory = "\(config.repositoryPath)/notes"
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mkdir -p '\(escapeSingleQuoted(remoteNoteDirectory))'"
        )

        let index = RemoteNoteIndex(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: entries.sorted { $0.noteID.uuidString < $1.noteID.uuidString },
            deletedEntries: deletedEntries.sorted { $0.noteID.uuidString < $1.noteID.uuidString }
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(index)
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
            remotePath: remoteTempPath
        )
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv '\(escapeSingleQuoted(remoteTempPath))' '\(escapeSingleQuoted(remoteTargetPath))'"
        )
    }

    private func downloadRemoteIndex(config: SSHConfig) async throws -> RemoteNoteIndex? {
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
                localPath: tempFileURL.path
            )
        } catch {
            return nil
        }

        let payload = try Data(contentsOf: tempFileURL)
        return try JSONDecoder().decode(RemoteNoteIndex.self, from: payload)
    }

    private func listRemoteNoteIDs(config: SSHConfig) async throws -> [UUID] {
        let sshpassPath = try checkSshpassAvailable()
        let remoteNoteDirectory = "\(config.repositoryPath)/notes"
        let rawListing = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: config,
            command: "if [ -d '\(escapeSingleQuoted(remoteNoteDirectory))' ]; then ls '\(escapeSingleQuoted(remoteNoteDirectory))'; fi"
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

    private func runSSHCommand(sshpassPath: String, config: SSHConfig, command: String) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: sshArguments(config: config, command: command),
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

    private func runSSHCommandForOutput(sshpassPath: String, config: SSHConfig, command: String) async throws -> String {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: sshArguments(config: config, command: command),
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

    private func runSCPUpload(sshpassPath: String, config: SSHConfig, localPath: String, remotePath: String) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: scpUploadArguments(config: config, localPath: localPath, remotePath: remotePath),
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

    private func runSCPDownload(sshpassPath: String, config: SSHConfig, remotePath: String, localPath: String) async throws {
        let result = try await executeProcess(
            executablePath: sshpassPath,
            arguments: scpDownloadArguments(config: config, remotePath: remotePath, localPath: localPath),
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

    private func sshArguments(config: SSHConfig, command: String) -> [String] {
        [
            "-p", config.password,
            "ssh"
        ] + commonSSHOptions(port: config.port) + [
            "\(config.username)@\(config.host)",
            command
        ]
    }

    private func scpUploadArguments(config: SSHConfig, localPath: String, remotePath: String) -> [String] {
        [
            "-p", config.password,
            "scp"
        ] + commonSCPOptions(port: config.port) + [
            localPath,
            "\(config.username)@\(config.host):\(remotePath)"
        ]
    }

    private func scpDownloadArguments(config: SSHConfig, remotePath: String, localPath: String) -> [String] {
        [
            "-p", config.password,
            "scp"
        ] + commonSCPOptions(port: config.port) + [
            "\(config.username)@\(config.host):\(remotePath)",
            localPath
        ]
    }

    private func commonSSHOptions(port: Int) -> [String] {
        [
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
    }

    private func commonSCPOptions(port: Int) -> [String] {
        [
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
    }

    private func executeProcess(
        executablePath: String,
        arguments: [String],
        password: String,
        timeout: TimeInterval = 45
    ) async throws -> ProcessExecutionResult {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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

    /// 判断错误是否为远程文件不存在
    private func isRemoteFileMissing(_ error: Error) -> Bool {
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
            let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
            )
            guard let localNote = try context.fetch(descriptor).first else {
                // 本地不存在该笔记，无需操作
                continue
            }

            // 本地笔记尚未标记删除 → 执行软删除
            if localNote.deletedAt == nil {
                print("[SSHSync] 远程已删除笔记，本地执行软删除：\(noteID.uuidString)")
                localNote.deletedAt = entry.deletedAt
                localNote.originalFolderID = localNote.folderID
                localNote.originalFolderName = localNote.folderName
                localNote.updatedAt = entry.deletedAt
            }
        }
        try context.save()
    }

    /// 收集本地已永久删除的笔记记录（SyncState存在但NoteEntity已不存在）
    private func collectLocallyDeletedEntries(existingNoteIDs: Set<UUID>, context: ModelContext) throws -> [RemoteDeletedEntry] {
        let allSyncStates = try context.fetch(FetchDescriptor<BlockDocumentNoteSyncStateEntity>())
        let deviceID = BlockDocumentNoteVersionStore.currentDeviceID()
        var deletedEntries: [RemoteDeletedEntry] = []

        for syncState in allSyncStates {
            // SyncState 存在但对应的 NoteEntity 已不存在 → 笔记已被永久删除
            if !existingNoteIDs.contains(syncState.noteID) {
                deletedEntries.append(RemoteDeletedEntry(
                    noteID: syncState.noteID,
                    deletedAt: syncState.lastSyncAt ?? Date(),
                    deletedByDeviceID: syncState.lastRemoteDeviceID ?? deviceID
                ))
            }
        }
        return deletedEntries
    }

    /// 清理远程孤儿文件（已删除笔记的 .json 和附件目录）
    private func cleanupRemoteOrphanFiles(activeNoteIDs: Set<UUID>, deletedNoteIDs: Set<UUID>, config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let remoteNoteDirectory = "\(config.repositoryPath)/notes"

        // 列出远程 notes/ 目录下所有 .json 文件
        let listing = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: config,
            command: "if [ -d '\\(escapeSingleQuoted(remoteNoteDirectory))' ]; then ls '\\(escapeSingleQuoted(remoteNoteDirectory))'; else echo ''; fi"
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
                print("[SSHSync] 清理远程孤儿笔记文件：\(remotePath)")
                try? await runSSHCommand(
                    sshpassPath: sshpassPath,
                    config: config,
                    command: "rm -f '\\(escapeSingleQuoted(remotePath))'"
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
                    command: "if [ -d '\\(escapeSingleQuoted(noteAttachmentDir))' ]; then rm -rf '\\(escapeSingleQuoted(noteAttachmentDir))'; echo DELETED; else echo SKIP; fi"
                )
            }
        }
    }

    /// 清理本地已同步删除记录的 SyncState（避免每次推送都重复收集）
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
        try? context.save()
    }

    // MARK: - Attachment Sync Helpers

    private func uploadAssetsForNote(envelope: VersionedNoteSyncEnvelope, sshpassPath: String, config: SSHConfig) async throws {
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
            command: "mkdir -p '\(escapeSingleQuoted(remoteAttachmentsDir))'"
        )

        for asset in envelope.currentSnapshot.assets {
            let paths = [asset.relativeFilePath] + asset.sidecarRelativePaths
            for relativePath in paths {
                let localURL = attachmentsRoot.appendingPathComponent(relativePath)
                guard FileManager.default.fileExists(atPath: localURL.path) else { continue }

                let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"
                let remoteDir = String(remotePath[..<remotePath.range(of: "/", options: .backwards)!.lowerBound])

                try await runSSHCommand(
                    sshpassPath: sshpassPath,
                    config: config,
                    command: "mkdir -p '\(escapeSingleQuoted(remoteDir))'"
                )
                try await runSCPUpload(
                    sshpassPath: sshpassPath,
                    config: config,
                    localPath: localURL.path,
                    remotePath: remotePath
                )
            }
        }
    }

    private func downloadAssetsForNote(envelope: VersionedNoteSyncEnvelope, sshpassPath: String, config: SSHConfig) async throws {
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
                // 如果本地已存在且文件大小大于 0，跳过
                if let attrs = try? FileManager.default.attributesOfItem(atPath: localURL.path),
                   let fileSize = attrs[.size] as? Int, fileSize > 0 {
                    continue
                }

                let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"

                // 确保本地目录存在
                let localDir = localURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)

                // 检查远程文件是否存在后再下载
                let checkResult = try await runSSHCommandForOutput(
                    sshpassPath: sshpassPath,
                    config: config,
                    command: "test -f '\(escapeSingleQuoted(remotePath))' && echo EXISTS || echo MISSING"
                )
                guard checkResult.trimmingCharacters(in: .whitespacesAndNewlines) == "EXISTS" else { continue }

                try await runSCPDownload(
                    sshpassPath: sshpassPath,
                    config: config,
                    remotePath: remotePath,
                    localPath: localURL.path
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

    private func uploadAssetsManifest(entries: [AssetsManifestEntry], config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()
        let manifest = AssetsManifest(
            generatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID(),
            entries: entries.sorted { $0.relativePath < $1.relativePath }
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = try encoder.encode(manifest)
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
            remotePath: remoteTempPath
        )
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv '\(escapeSingleQuoted(remoteTempPath))' '\(escapeSingleQuoted(remoteTargetPath))'"
        )
    }

    /// 下载远程附件清单
    private func downloadAssetsManifest(config: SSHConfig) async throws -> AssetsManifest? {
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
                localPath: tempFileURL.path
            )
        } catch {
            // 如果文件不存在，返回nil（兼容旧版本）
            return nil
        }

        let payload = try Data(contentsOf: tempFileURL)
        return try JSONDecoder().decode(AssetsManifest.self, from: payload)
    }

    /// 检查并下载本地已有笔记中缺失的附件
    private func downloadMissingAssetsForExistingNotes(context: ModelContext, config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()

        // 1. 获取所有本地笔记的附件
        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
        let allAssets = try context.fetch(FetchDescriptor<BlockDocumentAssetEntity>())

        // 如果没有任何附件，直接返回
        guard !allAssets.isEmpty else {
            return
        }

        // 2. 下载远程附件清单（如果存在）
        let remoteManifest = try? await downloadAssetsManifest(config: config)

        // 3. 准备远程附件路径映射
        let remoteAssetMap = remoteManifest?.entries.reduce(into: [String: AssetsManifestEntry]()) {
            $0[$1.relativePath] = $1
        } ?? [:]

        // 4. 检查并下载缺失附件
        let storage = StorageLocationManager.shared
        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let remoteAttachmentsDir = "\(config.repositoryPath)/attachments"

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
                    sshpassPath: sshpassPath,
                    config: config,
                    remoteAttachmentsDir: remoteAttachmentsDir
                )

                if shouldDownload {
                    try await downloadSingleAsset(
                        relativePath: relativePath,
                        localURL: localURL,
                        sshpassPath: sshpassPath,
                        config: config,
                        remoteAttachmentsDir: remoteAttachmentsDir
                    )
                }
            }
        }
    }

    /// 判断是否需要下载某个附件
    private func shouldDownloadAsset(
        localURL: URL,
        relativePath: String,
        remoteEntry: AssetsManifestEntry?,
        sshpassPath: String,
        config: SSHConfig,
        remoteAttachmentsDir: String
    ) async throws -> Bool {
        let fileManager = FileManager.default

        // 如果本地文件存在且大小大于0，检查是否需要验证哈希
        if fileManager.fileExists(atPath: localURL.path) {
            if let attributes = try? fileManager.attributesOfItem(atPath: localURL.path),
               let fileSize = attributes[.size] as? Int, fileSize > 0 {

                // 如果有远程清单条目，验证哈希
                if let remoteEntry = remoteEntry,
                   let localData = try? Data(contentsOf: localURL) {
                    let localHash = SHA256.hash(data: localData).map { String(format: "%02x", $0) }.joined()
                    return localHash != remoteEntry.contentHash
                }

                // 没有远程清单，认为文件完整
                return false
            }
        }

        // 本地文件不存在或大小为0，需要检查远程是否存在
        let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"
        let checkResult = try await runSSHCommandForOutput(
            sshpassPath: sshpassPath,
            config: config,
            command: "test -f '\(escapeSingleQuoted(remotePath))' && echo EXISTS || echo MISSING"
        )

        let exists = checkResult.trimmingCharacters(in: .whitespacesAndNewlines) == "EXISTS"

        // 如果远程文件不存在，记录警告但继续处理其他文件
        if !exists {
            print("警告：远程附件不存在：\(remotePath)")
        }

        return exists
    }

    /// 下载单个附件文件
    private func downloadSingleAsset(
        relativePath: String,
        localURL: URL,
        sshpassPath: String,
        config: SSHConfig,
        remoteAttachmentsDir: String
    ) async throws {
        // 确保本地目录存在
        let localDir = localURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)

        let remotePath = "\(remoteAttachmentsDir)/\(relativePath)"

        try await runSCPDownload(
            sshpassPath: sshpassPath,
            config: config,
            remotePath: remotePath,
            localPath: localURL.path
        )

        print("已下载附件：\(relativePath)")
    }

    // MARK: - Library Sync (Folders & Tags)

    private func syncLibraryToRemote(context: ModelContext, config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()
        try await ensureRemoteDirectory(config: config)

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
            remotePath: remoteTempPath
        )
        try await runSSHCommand(
            sshpassPath: sshpassPath,
            config: config,
            command: "mv '\(escapeSingleQuoted(remoteTempPath))' '\(escapeSingleQuoted(remoteTargetPath))'"
        )
    }

    private func syncLibraryFromRemote(context: ModelContext, config: SSHConfig) async throws {
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
                localPath: tempFileURL.path
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
