import Foundation

/// SSH 同步管理器 - 使用系统 sftp 命令
class SSHSyncManager {
    static let shared = SSHSyncManager()

    private init() {}

    private let hostKeyBypassOptions = "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null"
    private let authOptions = "-o PreferredAuthentications=keyboard-interactive,password -o PubkeyAuthentication=no -o KbdInteractiveAuthentication=yes -o PasswordAuthentication=yes -o NumberOfPasswordPrompts=3 -o GSSAPIAuthentication=no -o IdentityAgent=none -o IdentitiesOnly=yes"

    private func escapeForTcl(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    private func escapeForRemoteShellSingleQuote(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "'\"'\"'")
    }

    private func sanitizeLog(_ text: String, password: String) -> String {
        guard !password.isEmpty else { return text }
        return text.replacingOccurrences(of: password, with: "******")
    }

    /// 使用密码认证测试连接
    func testConnectionWithPassword(config: SSHConfig) async throws {
        let escapedUsername = escapeForTcl(config.username)
        let escapedHost = escapeForTcl(config.host)
        // 创建 expect 脚本文件 - 支持密码重试
        let expectScript = """
#!/usr/bin/expect -f
set timeout 20
set password $env(EXPECT_SSH_PASSWORD)
set retry_count 0
set max_retries 3
set password_prompt_seen 0
set auth_failed 0

spawn ssh \(authOptions) \(hostKeyBypassOptions) -p \(config.port) \(escapedUsername)@\(escapedHost) echo "NB_CONNECTION_SUCCESS"

while { $retry_count < $max_retries } {
    expect {
        -re "(?i)are you sure you want to continue connecting.*" {
            send "yes\\r"
            exp_continue
        }
        -re {(?i)(password|passphrase|verification code|otp|one-time|token|code|验证码|密码)[^\\n\\r]*[:：]\\s*} {
            set password_prompt_seen 1
            send -- "$password\\r"
            incr retry_count
            exp_continue
        }
        -re {(?i)permission denied} {
            set auth_failed 1
            exp_continue
        }
        "NB_CONNECTION_SUCCESS" {
            exit 0
        }
        timeout {
            puts "ERROR: Connection timeout"
            exit 1
        }
        eof {
            if { $auth_failed == 1 } {
                puts "ERROR: AUTH_FAILED"
            } elseif { $password_prompt_seen == 0 } {
                puts "ERROR: PASSWORD_PROMPT_NOT_SEEN"
            }
            exit 1
        }
    }
}
puts "ERROR: Max retries exceeded"
exit 1
"""

        let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("ssh_test_\(UUID().uuidString).exp")
        try expectScript.write(to: tempFile, atomically: true, encoding: .utf8)

        // 设置可执行权限
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tempFile.path)

        defer {
            try? FileManager.default.removeItem(at: tempFile)
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        task.arguments = [tempFile.path]
        var env = ProcessInfo.processInfo.environment
        env["EXPECT_SSH_PASSWORD"] = config.password
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
            if output.contains("Max retries exceeded") {
                errorMessage = "认证失败：密码错误，已达到最大重试次数"
            } else if output.contains("ERROR: AUTH_FAILED") || output.contains("Permission denied") || errorOutput.contains("Permission denied") {
                errorMessage = "认证失败：用户名或密码错误，或服务器未允许该用户使用密码登录"
            } else if output.contains("Connection refused") || errorOutput.contains("Connection refused") {
                errorMessage = "连接被拒绝：请检查主机地址和端口"
            } else if output.contains("timeout") || errorOutput.contains("timeout") {
                errorMessage = "连接超时：请检查网络或防火墙设置"
            } else if output.contains("Could not resolve") || errorOutput.contains("Could not resolve") {
                errorMessage = "无法解析主机名：请检查服务器地址"
            } else if output.contains("Host key verification failed") || errorOutput.contains("Host key verification failed") {
                errorMessage = "主机指纹验证失败：请删除本机 known_hosts 中旧记录后重试"
            } else if output.contains("no matching host key type found") || errorOutput.contains("no matching host key type found") {
                errorMessage = "SSH 算法不兼容：请在服务器启用现代主机密钥算法"
            } else if output.contains("Load key") && output.contains("Operation not permitted") {
                errorMessage = "本地私钥读取被系统限制，已自动切换密码模式；请确认服务器已开启 PasswordAuthentication"
            } else if output.contains("PASSWORD_PROMPT_NOT_SEEN") {
                errorMessage = "服务器未返回密码提示，可能未开启密码登录或启用了仅密钥认证"
            }
            throw NSError(domain: "SSHConnection", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMessage])
        }

        if !output.contains("NB_CONNECTION_SUCCESS") {
            throw NSError(domain: "SSHConnection", code: -1, userInfo: [NSLocalizedDescriptionKey: "连接验证失败，未收到服务器响应"])
        }
    }

    /// 确保远程目录存在
    func ensureRemoteDirectory(config: SSHConfig) async throws {
        let escapedUsername = escapeForTcl(config.username)
        let escapedHost = escapeForTcl(config.host)
        let quotedRemotePath = escapeForRemoteShellSingleQuote(config.repositoryPath)
        let expectScript = """
#!/usr/bin/expect -f
set timeout 20
set password $env(EXPECT_SSH_PASSWORD)

spawn ssh \(authOptions) \(hostKeyBypassOptions) -p \(config.port) \(escapedUsername)@\(escapedHost) "mkdir -p '\(quotedRemotePath)'"

expect {
    -re "(?i)are you sure you want to continue connecting.*" {
        send "yes\\r"
        exp_continue
    }
    -re {(?i)(password|passphrase|verification code|otp|one-time|token|code|验证码|密码)[^\\n\\r]*[:：]?\\s*$} {
        send -- "$password\\r"
        exp_continue
    }
    -re {(?i)permission denied} {
        exp_continue
    }
    timeout {
        exit 1
    }
    eof {
        exit 0
    }
}
"""

        let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("ssh_mkdir_\(UUID().uuidString).exp")
        try expectScript.write(to: tempFile, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tempFile.path)

        defer {
            try? FileManager.default.removeItem(at: tempFile)
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        task.arguments = [tempFile.path]
        var env = ProcessInfo.processInfo.environment
        env["EXPECT_SSH_PASSWORD"] = config.password
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        try task.run()
        task.waitUntilExit()

        if task.terminationStatus != 0 {
            throw NSError(domain: "SSHSync", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "创建远程目录失败"])
        }
    }

    /// 同步文件到远程（上传）
    func syncToRemote(localURL: URL, config: SSHConfig) async throws {
        let escapedUsername = escapeForTcl(config.username)
        let escapedHost = escapeForTcl(config.host)
        let escapedRepositoryPath = escapeForTcl(config.repositoryPath)
        let escapedLocalPath = escapeForTcl(localURL.path)
        let expectScript = """
#!/usr/bin/expect -f
set timeout 120
set password $env(EXPECT_SSH_PASSWORD)

spawn sftp \(authOptions) \(hostKeyBypassOptions) -P \(config.port) \(escapedUsername)@\(escapedHost)

expect {
    -re "(?i)are you sure you want to continue connecting.*" {
        send "yes\\r"
        exp_continue
    }
    -re {(?i)(password|passphrase|verification code|otp|one-time|token|code|验证码|密码)[^\\n\\r]*[:：]?\\s*$} {
        send -- "$password\\r"
        exp_continue
    }
    -re {(?i)permission denied} {
        exp_continue
    }
    -re "sftp>" {
        send "mkdir \(escapedRepositoryPath)\\r"
        expect "sftp>"
        send "cd \(escapedRepositoryPath)\\r"
        expect "sftp>"
        send "put -r \(escapedLocalPath) .\\r"
        expect "sftp>"
        send "bye\\r"
        expect eof
    }
    timeout { exit 1 }
}
"""

        let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("sftp_upload_\(UUID().uuidString).exp")
        try expectScript.write(to: tempFile, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tempFile.path)

        defer {
            try? FileManager.default.removeItem(at: tempFile)
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        task.arguments = [tempFile.path]
        var uploadEnv = ProcessInfo.processInfo.environment
        uploadEnv["EXPECT_SSH_PASSWORD"] = config.password
        task.environment = uploadEnv

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        try task.run()
        task.waitUntilExit()

        if task.terminationStatus != 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let rawErrorMessage = String(data: data, encoding: .utf8) ?? "同步失败"
            let errorMessage = sanitizeLog(rawErrorMessage, password: config.password)
            throw NSError(domain: "SSHSync", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMessage])
        }
    }

    /// 从远程同步文件（下载）
    func syncFromRemote(localURL: URL, config: SSHConfig) async throws {
        let escapedUsername = escapeForTcl(config.username)
        let escapedHost = escapeForTcl(config.host)
        let escapedRepositoryPath = escapeForTcl(config.repositoryPath)
        let escapedLocalParentPath = escapeForTcl(localURL.deletingLastPathComponent().path)
        let expectScript = """
#!/usr/bin/expect -f
set timeout 120
set password $env(EXPECT_SSH_PASSWORD)

spawn sftp \(authOptions) \(hostKeyBypassOptions) -P \(config.port) \(escapedUsername)@\(escapedHost)

expect {
    -re "(?i)are you sure you want to continue connecting.*" {
        send "yes\\r"
        exp_continue
    }
    -re {(?i)(password|passphrase|verification code|otp|one-time|token|code|验证码|密码)[^\\n\\r]*[:：]?\\s*$} {
        send -- "$password\\r"
        exp_continue
    }
    -re {(?i)permission denied} {
        exp_continue
    }
    -re "sftp>" {
        send "lcd \(escapedLocalParentPath)\\r"
        expect "sftp>"
        send "get -r \(escapedRepositoryPath)/* .\\r"
        expect "sftp>"
        send "bye\\r"
        expect eof
    }
    timeout { exit 1 }
}
"""

        let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("sftp_download_\(UUID().uuidString).exp")
        try expectScript.write(to: tempFile, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tempFile.path)

        defer {
            try? FileManager.default.removeItem(at: tempFile)
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        task.arguments = [tempFile.path]
        var downloadEnv = ProcessInfo.processInfo.environment
        downloadEnv["EXPECT_SSH_PASSWORD"] = config.password
        task.environment = downloadEnv

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        try task.run()
        task.waitUntilExit()

        if task.terminationStatus != 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let rawErrorMessage = String(data: data, encoding: .utf8) ?? "同步失败"
            let errorMessage = sanitizeLog(rawErrorMessage, password: config.password)
            throw NSError(domain: "SSHSync", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorMessage])
        }
    }
}
