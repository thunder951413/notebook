import Foundation

/// SSH 同步管理器 - 使用 sshpass 进行密码认证
class SSHSyncManager {
    static let shared = SSHSyncManager()

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

    private func sanitizeLog(_ text: String, password: String) -> String {
        guard !password.isEmpty else { return text }
        return text.replacingOccurrences(of: password, with: "******")
    }

    /// 使用密码认证测试连接
    func testConnectionWithPassword(config: SSHConfig) async throws {
        let sshpassPath = try checkSshpassAvailable()

        let task = Process()
        task.executableURL = URL(fileURLWithPath: sshpassPath)
        task.arguments = [
            "-p", config.password,
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-p", String(config.port),
            "\(config.username)@\(config.host)",
            "echo NB_CONNECTION_SUCCESS"
        ]

        // 设置环境变量
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        task.environment = env

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        task.standardOutput = outputPipe
        task.standardError = errorPipe

        try task.run()
        task.waitUntilExit()

        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: outputData, encoding: .utf8) ?? ""
        let errorOutput = String(data: errorData, encoding: .utf8) ?? ""

        print("SSH Test Output: \(sanitizeLog(output, password: config.password))")
        print("SSH Test Error: \(sanitizeLog(errorOutput, password: config.password))")
        print("SSH Test Exit Code: \(task.terminationStatus)")

        if task.terminationStatus != 0 {
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
            throw NSError(domain: "SSHConnection", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMessage])
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

        let task = Process()
        task.executableURL = URL(fileURLWithPath: sshpassPath)
        task.arguments = [
            "-p", config.password,
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-p", String(config.port),
            "\(config.username)@\(config.host)",
            "mkdir -p '\(quotedRemotePath)'"
        ]

        // 设置环境变量
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        try task.run()
        task.waitUntilExit()

        if task.terminationStatus != 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let errorMessage = String(data: data, encoding: .utf8) ?? "创建远程目录失败"
            throw NSError(domain: "SSHSync", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: sanitizeLog(errorMessage, password: config.password)])
        }
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
            let errorMessage = sanitizeLog(rawErrorMessage, password: config.password)
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
            throw NSError(domain: "SSHSync", code: Int(extractTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: sanitizeLog(errorMessage, password: config.password)])
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
            throw NSError(domain: "SSHSync", code: Int(packTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: sanitizeLog(errorMessage, password: config.password)])
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
            throw NSError(domain: "SSHSync", code: Int(scpTask.terminationStatus), userInfo: [NSLocalizedDescriptionKey: sanitizeLog(rawErrorMessage, password: config.password)])
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
}
