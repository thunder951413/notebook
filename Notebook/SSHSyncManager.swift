import Foundation
import SwiftData
import CryptoKit

struct RemoteNoteIndex: Codable {
    let generatedAt: Date
    let deviceID: String
    let entries: [RemoteNoteIndexEntry]
}

struct RemoteNoteIndexEntry: Codable {
    let noteID: UUID
    let version: Int64
    let contentHash: String
    let historyCount: Int
}

struct SSHPushSyncSummary {
    let uploadedNoteIDs: [UUID]
    let pulledResults: [NoteSyncMergeResult]
    let skippedNoteIDs: [UUID]
}

/// SSH 同步管理器 - 使用 sshpass 进行密码认证
class SSHSyncManager {
    static let shared = SSHSyncManager()

    private struct ProcessExecutionResult {
        let terminationStatus: Int32
        let standardOutput: String
        let standardError: String
    }

    enum PushDecision: Equatable {
        case upload
        case pull
        case skip
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

    /// 同步文件到远程（上传）- 使用 scp 代替 sftp
    func syncToRemote(localURL: URL, config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()

        // 先确保远程目录存在
        try await ensureRemoteDirectory(config: config)

        // 使用 scp 递归上传目录
        // 先创建一个临时 tar 归档，然后上传并解压
        let tempDir = FileManager.default.temporaryDirectory
        let tarFileName = "notebook_backup_\(UUID().uuidString).tar.gz"
        let tarURL = tempDir.appendingPathComponent(tarFileName)

        // 创建 tar 归档
        let tarTask = Process()
        tarTask.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tarTask.arguments = ["-czf", tarURL.path, "-C", localURL.deletingLastPathComponent().path, localURL.lastPathComponent]

        let tarPipe = Pipe()
        tarTask.standardOutput = tarPipe
        tarTask.standardError = tarPipe

        try tarTask.run()
        tarTask.waitUntilExit()

        guard tarTask.terminationStatus == 0 else {
            let data = tarPipe.fileHandleForReading.readDataToEndOfFile()
            let errorMsg = String(data: data, encoding: .utf8) ?? "创建归档失败"
            throw NSError(domain: "SSHSync", code: Int(tarTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMsg])
        }

        defer {
            try? FileManager.default.removeItem(at: tarURL)
        }

        // 使用 scp 上传 tar 文件
        let scpTask = Process()
        scpTask.executableURL = URL(fileURLWithPath: sshpassPath)
        scpTask.arguments = [
            "-p", config.password,
            "scp",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-P", String(config.port),
            tarURL.path,
            "\(config.username)@\(config.host):\(config.repositoryPath)/\(tarFileName)"
        ]

        // 设置环境变量
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        scpTask.environment = env

        let scpPipe = Pipe()
        scpTask.standardOutput = scpPipe
        scpTask.standardError = scpPipe

        try scpTask.run()
        scpTask.waitUntilExit()

        if scpTask.terminationStatus != 0 {
            let data = scpPipe.fileHandleForReading.readDataToEndOfFile()
            let rawErrorMessage = String(data: data, encoding: .utf8) ?? "上传失败"
            let errorMessage = Self.sanitizeLog(rawErrorMessage, password: config.password)
            throw NSError(domain: "SSHSync", code: Int(scpTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMessage])
        }

        // 在远程解压 tar 文件
        let extractTask = Process()
        extractTask.executableURL = URL(fileURLWithPath: sshpassPath)
        extractTask.arguments = [
            "-p", config.password,
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-p", String(config.port),
            "\(config.username)@\(config.host)",
            "cd '\(config.repositoryPath)' && tar -xzf '\(tarFileName)' && rm '\(tarFileName)'"
        ]

        extractTask.environment = env
        let extractPipe = Pipe()
        extractTask.standardOutput = extractPipe
        extractTask.standardError = extractPipe

        try extractTask.run()
        extractTask.waitUntilExit()

        if extractTask.terminationStatus != 0 {
            let data = extractPipe.fileHandleForReading.readDataToEndOfFile()
            let errorMessage = String(data: data, encoding: .utf8) ?? "解压失败"
            throw NSError(domain: "SSHSync", code: Int(extractTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog(errorMessage, password: config.password)])
        }
    }

    /// 从远程同步文件（下载）- 使用 scp 代替 sftp
    func syncFromRemote(localURL: URL, config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()

        // 先在远程打包数据
        let tarFileName = "notebook_restore_\(UUID().uuidString).tar.gz"

        let packTask = Process()
        packTask.executableURL = URL(fileURLWithPath: sshpassPath)
        packTask.arguments = [
            "-p", config.password,
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-p", String(config.port),
            "\(config.username)@\(config.host)",
            "cd '\(config.repositoryPath)' && tar -czf '\(tarFileName)' ."
        ]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        packTask.environment = env

        let packPipe = Pipe()
        packTask.standardOutput = packPipe
        packTask.standardError = packPipe

        try packTask.run()
        packTask.waitUntilExit()

        if packTask.terminationStatus != 0 {
            let data = packPipe.fileHandleForReading.readDataToEndOfFile()
            let errorMessage = String(data: data, encoding: .utf8) ?? "远程打包失败"
            throw NSError(domain: "SSHSync", code: Int(packTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog(errorMessage, password: config.password)])
        }

        // 下载 tar 文件
        let tempDir = FileManager.default.temporaryDirectory
        let tarURL = tempDir.appendingPathComponent(tarFileName)

        defer {
            // 清理远程和本地临时文件
            let cleanupTask = Process()
            cleanupTask.executableURL = URL(fileURLWithPath: sshpassPath)
            cleanupTask.arguments = [
                "-p", config.password,
                "ssh",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "PreferredAuthentications=keyboard-interactive,password",
                "-o", "PubkeyAuthentication=no",
                "-p", String(config.port),
                "\(config.username)@\(config.host)",
                "rm -f '\(config.repositoryPath)/\(tarFileName)'"
            ]
            cleanupTask.environment = env
            try? cleanupTask.run()
            cleanupTask.waitUntilExit()

            try? FileManager.default.removeItem(at: tarURL)
        }

        let scpTask = Process()
        scpTask.executableURL = URL(fileURLWithPath: sshpassPath)
        scpTask.arguments = [
            "-p", config.password,
            "scp",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-P", String(config.port),
            "\(config.username)@\(config.host):\(config.repositoryPath)/\(tarFileName)",
            tarURL.path
        ]

        scpTask.environment = env
        let scpPipe = Pipe()
        scpTask.standardOutput = scpPipe
        scpTask.standardError = scpPipe

        try scpTask.run()
        scpTask.waitUntilExit()

        if scpTask.terminationStatus != 0 {
            let data = scpPipe.fileHandleForReading.readDataToEndOfFile()
            let rawErrorMessage = String(data: data, encoding: .utf8) ?? "下载失败"
            throw NSError(domain: "SSHSync", code: Int(scpTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: Self.sanitizeLog(rawErrorMessage, password: config.password)])
        }

        // 解压到本地
        let extractTask = Process()
        extractTask.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        extractTask.arguments = ["-xzf", tarURL.path, "-C", localURL.path]

        let extractPipe = Pipe()
        extractTask.standardOutput = extractPipe
        extractTask.standardError = extractPipe

        try extractTask.run()
        extractTask.waitUntilExit()

        if extractTask.terminationStatus != 0 {
            let data = extractPipe.fileHandleForReading.readDataToEndOfFile()
            let errorMessage = String(data: data, encoding: .utf8) ?? "解压失败"
            throw NSError(domain: "SSHSync", code: Int(extractTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMessage])
        }
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

        try BlockDocumentNoteVersionStore.markSynced(
            noteID: noteID,
            syncedVersion: envelope.currentVersion,
            context: context
        )
    }

    static func pushDecision(
        localEntry: RemoteNoteIndexEntry,
        remoteEntry: RemoteNoteIndexEntry?,
        syncState: BlockDocumentNoteSyncStateEntity?
    ) -> PushDecision {
        guard let remoteEntry else {
            return .upload
        }

        guard let syncState else {
            if remoteEntry.version > localEntry.version {
                return .pull
            }
            if remoteEntry.version < localEntry.version {
                return .upload
            }
            if remoteEntry.contentHash != localEntry.contentHash {
                return .pull
            }
            if remoteEntry.historyCount > localEntry.historyCount {
                return .pull
            }
            if remoteEntry.historyCount < localEntry.historyCount {
                return .upload
            }
            return .skip
        }

        let remoteChanged =
            remoteEntry.version > syncState.lastRemoteVersion ||
            remoteEntry.contentHash != syncState.remoteFingerprint ||
            remoteEntry.historyCount > localEntry.historyCount
        let localChanged =
            localEntry.version > syncState.lastSyncedVersion ||
            syncState.pendingHistoryCount > 0

        if remoteChanged {
            return .pull
        }
        if localChanged {
            return .upload
        }
        if localEntry.version > remoteEntry.version {
            return .upload
        }
        if localEntry.version < remoteEntry.version {
            return .pull
        }
        if localEntry.contentHash != remoteEntry.contentHash {
            if remoteEntry.contentHash == syncState.remoteFingerprint &&
                remoteEntry.version == syncState.lastRemoteVersion {
                return .upload
            }
            return .pull
        }
        if localEntry.historyCount > remoteEntry.historyCount {
            return .upload
        }
        if localEntry.historyCount < remoteEntry.historyCount {
            return .pull
        }
        return .skip
    }

    func syncAllNotesToRemote(context: ModelContext, config: SSHConfig) async throws -> SSHPushSyncSummary {
        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
            .sorted { $0.updatedAt > $1.updatedAt }
        let remoteIndex = try await downloadRemoteIndex(config: config)
        var remoteEntriesByID = Dictionary(
            uniqueKeysWithValues: (remoteIndex?.entries ?? []).map { ($0.noteID, $0) }
        )
        var syncedNoteIDs: [UUID] = []
        var pulledResults: [NoteSyncMergeResult] = []
        var skippedNoteIDs: [UUID] = []

        for note in notes {
            guard var localEntry = try makeRemoteIndexEntry(noteID: note.id, context: context) else {
                continue
            }

            var syncState = try fetchSyncState(noteID: note.id, context: context)
            var remoteEntry = remoteEntriesByID[note.id]
            let initialDecision = Self.pushDecision(
                localEntry: localEntry,
                remoteEntry: remoteEntry,
                syncState: syncState
            )

            if initialDecision == .pull {
                let pullResult = try await syncNoteFromRemote(noteID: note.id, context: context, config: config)
                pulledResults.append(pullResult)
                if pullResult.detectedConflict {
                    skippedNoteIDs.append(note.id)
                    if let remoteEntry {
                        remoteEntriesByID[note.id] = remoteEntry
                    }
                    continue
                }

                guard let refreshedLocalEntry = try makeRemoteIndexEntry(noteID: note.id, context: context) else {
                    continue
                }
                localEntry = refreshedLocalEntry
                syncState = try fetchSyncState(noteID: note.id, context: context)
                remoteEntry = remoteEntriesByID[note.id]
            }

            let finalDecision = Self.pushDecision(
                localEntry: localEntry,
                remoteEntry: remoteEntry,
                syncState: syncState
            )

            if finalDecision == .upload {
                try await syncNoteToRemote(noteID: note.id, context: context, config: config)
                syncedNoteIDs.append(note.id)
                if let refreshedLocalEntry = try makeRemoteIndexEntry(noteID: note.id, context: context) {
                    localEntry = refreshedLocalEntry
                }
                remoteEntriesByID[note.id] = localEntry
            } else {
                if finalDecision == .skip {
                    skippedNoteIDs.append(note.id)
                }
                if remoteEntry == nil {
                    remoteEntriesByID[note.id] = localEntry
                }
            }
        }

        try await uploadRemoteIndex(
            entries: remoteEntriesByID.values.sorted { $0.noteID.uuidString < $1.noteID.uuidString },
            config: config
        )
        return SSHPushSyncSummary(
            uploadedNoteIDs: syncedNoteIDs,
            pulledResults: pulledResults,
            skippedNoteIDs: skippedNoteIDs
        )
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
        let remoteIndex = try await downloadRemoteIndex(config: config)
        let noteIDs: [UUID]
        if let remoteIndex {
            noteIDs = remoteIndex.entries
                .filter { entry in
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
            noteIDs = try await listRemoteNoteIDs(config: config)
        }

        var results: [NoteSyncMergeResult] = []
        for noteID in noteIDs {
            let result = try await syncNoteFromRemote(noteID: noteID, context: context, config: config)
            results.append(result)
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

    private func uploadRemoteIndex(entries: [RemoteNoteIndexEntry], config: SSHConfig) async throws {
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
            entries: entries.sorted { $0.noteID.uuidString < $1.noteID.uuidString }
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

            func resume(_ result: Result<ProcessExecutionResult, Error>) {
                lock.lock()
                defer { lock.unlock() }
                guard !finished else { return }
                finished = true
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
}
