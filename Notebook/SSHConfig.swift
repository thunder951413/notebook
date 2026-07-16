import Foundation
import Combine
import os

/// 首次连接时记录主机密钥，后续连接拒绝密钥发生变化的服务器。
/// 使用 OpenSSH 默认的 known_hosts，便于系统 ssh、配置同步和移动端配对共享同一信任记录。
enum SSHHostKeyPolicy {
    static let options = [
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "HashKnownHosts=yes"
    ]
}

/// SSH 与配置同步共用的进程参数构造器。
/// 密码只通过 SSHPASS 环境变量传递，绝不能出现在可被系统进程列表读取的参数中。
enum SSHProcessTransport {
    static func findSSHpassPath(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> String? {
        let searchPath = environment["PATH"] ?? ""
        let directories = searchPath.split(separator: ":").map(String.init) + [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ]
        var visited = Set<String>()
        for directory in directories where visited.insert(directory).inserted {
            let candidate = URL(fileURLWithPath: directory)
                .appendingPathComponent("sshpass")
                .path
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func environment(password: String) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["SSHPASS"] = password
        return environment
    }

    static func sshArguments(config: SSHConfig, command: String, controlPath: String? = nil) -> [String] {
        ["-e", "ssh"] + commonOptions(port: config.port, portFlag: "-p", controlPath: controlPath) + [
            "\(config.username)@\(config.host)",
            command
        ]
    }

    static func scpUploadArguments(
        config: SSHConfig,
        localPath: String,
        remotePath: String,
        controlPath: String? = nil
    ) -> [String] {
        ["-e", "scp"] + commonOptions(port: config.port, portFlag: "-P", controlPath: controlPath) + [
            localPath,
            "\(config.username)@\(config.host):\(remotePath)"
        ]
    }

    static func scpDownloadArguments(
        config: SSHConfig,
        remotePath: String,
        localPath: String,
        controlPath: String? = nil
    ) -> [String] {
        ["-e", "scp"] + commonOptions(port: config.port, portFlag: "-P", controlPath: controlPath) + [
            "\(config.username)@\(config.host):\(remotePath)",
            localPath
        ]
    }

    private static func commonOptions(port: Int, portFlag: String, controlPath: String?) -> [String] {
        var options = SSHHostKeyPolicy.options + [
            "-o", "PreferredAuthentications=keyboard-interactive,password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=2",
            portFlag, String(port)
        ]
        if let controlPath {
            options += [
                "-o", "ControlMaster=auto",
                "-o", "ControlPath=\(controlPath)",
                "-o", "ControlPersist=600"
            ]
        }
        return options
    }
}

struct ProcessExecutionOutput: Sendable {
    let terminationStatus: Int32
    let standardOutput: String
    let standardError: String
}

/// 统一管理外部进程的完成、超时和 Swift Task 取消，保证 continuation 只恢复一次。
enum CancellableProcessRunner {
    static func run(
        executablePath: String,
        arguments: [String],
        environment: [String: String],
        timeout: TimeInterval,
        timeoutError: Error
    ) async throws -> ProcessExecutionOutput {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = arguments
        process.environment = environment
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        let didFinish = OSAllocatedUnfairLock(initialState: false)

        let output = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ProcessExecutionOutput, Error>) in
                @Sendable func resume(_ result: Result<ProcessExecutionOutput, Error>) {
                    let shouldResume = didFinish.withLock { finished in
                        guard !finished else { return false }
                        finished = true
                        return true
                    }
                    guard shouldResume else { return }
                    continuation.resume(with: result)
                }

                process.terminationHandler = { terminatedProcess in
                    let standardOutput = String(
                        data: outputPipe.fileHandleForReading.readDataToEndOfFile(),
                        encoding: .utf8
                    ) ?? ""
                    let standardError = String(
                        data: errorPipe.fileHandleForReading.readDataToEndOfFile(),
                        encoding: .utf8
                    ) ?? ""
                    resume(.success(ProcessExecutionOutput(
                        terminationStatus: terminatedProcess.terminationStatus,
                        standardOutput: standardOutput,
                        standardError: standardError
                    )))
                }

                do {
                    try process.run()
                } catch {
                    resume(.failure(error))
                    return
                }

                if withUnsafeCurrentTask(body: { $0?.isCancelled ?? false }) {
                    if process.isRunning { process.terminate() }
                    resume(.failure(CancellationError()))
                    return
                }

                Task.detached {
                    let delay = UInt64(max(0.01, timeout) * 1_000_000_000)
                    try? await Task.sleep(nanoseconds: delay)
                    guard process.isRunning else { return }
                    resume(.failure(timeoutError))
                    if process.isRunning { process.terminate() }
                }
            }
        } onCancel: {
            if process.isRunning { process.terminate() }
        }

        try Task.checkCancellation()
        return output
    }
}

/// SSH 配置模型
struct SSHConfig: Codable {
    var host: String
    var port: Int
    var username: String
    /// 密码不序列化到 JSON，而是存储在 Keychain 中
    var password: String {
        get {
            transientPassword.isEmpty ? Self.loadPasswordFromKeychain() ?? "" : transientPassword
        }
        set {
            transientPassword = newValue
        }
    }
    var repositoryPath: String
    private var transientPassword: String = ""

    static let keychainService = "com.notebook.ssh.password"
    static let keychainAccount = "ssh_password"

    static let `default` = SSHConfig(
        host: "",
        port: 22,
        username: "",
        password: "",
        repositoryPath: "~/notebook_backup"
    )

    /// 用于 UserDefaults 存储的版本（不含密码）
    enum CodingKeys: String, CodingKey {
        case host, port, username, repositoryPath
    }

    init(host: String, port: Int, username: String, password: String = "", repositoryPath: String) {
        self.host = host
        self.port = port
        self.username = username
        self.repositoryPath = repositoryPath
        self.transientPassword = password
    }

    var hasTransientPassword: Bool {
        !transientPassword.isEmpty
    }

    mutating func clearTransientPassword() {
        transientPassword = ""
    }

    static func loadPasswordFromKeychain() -> String? {
        KeychainHelper.loadString(service: keychainService, account: keychainAccount)
    }
}

/// SSH 配置管理器
class SSHConfigManager: ObservableObject {
    static let shared = SSHConfigManager()

    private let configKey = "ssh_config"
    private var isNormalizingConfig = false

    @Published var config: SSHConfig {
        didSet {
            guard !isNormalizingConfig else { return }
            let shouldClearTransientPassword = config.hasTransientPassword
            saveConfig(config)
            if shouldClearTransientPassword {
                isNormalizingConfig = true
                config.clearTransientPassword()
                isNormalizingConfig = false
            }
        }
    }

    var isConfigured: Bool {
        !config.host.isEmpty && !config.username.isEmpty
    }

    private init() {
        if let data = NotebookDefaults.shared.data(forKey: configKey),
           let loaded = try? JSONDecoder().decode(SSHConfig.self, from: data) {
            self.config = SSHConfig(
                host: loaded.host,
                port: loaded.port,
                username: loaded.username,
                repositoryPath: loaded.repositoryPath
            )
        } else {
            self.config = .default
        }
    }

    func clearConfig() {
        NotebookDefaults.shared.removeObject(forKey: configKey)
        Self.deletePasswordFromKeychain()
        config = .default
    }

    private func saveConfig(_ config: SSHConfig) {
        do {
            let encoder = JSONEncoder()
            let data = try encoder.encode(config)
            NotebookDefaults.shared.set(data, forKey: configKey)
        } catch {
            Logger.shared.log(.storage, .error, "保存 SSH 配置失败: \(error.localizedDescription)")
        }

        if !config.password.isEmpty {
            Self.savePasswordToKeychain(config.password)
        } else {
            Self.deletePasswordFromKeychain()
        }
    }

    func loadPassword() -> String? {
        SSHConfig.loadPasswordFromKeychain()
    }

    // MARK: - Keychain Operations (static)

    private static func savePasswordToKeychain(_ password: String) {
        guard let data = password.data(using: .utf8) else { return }

        do {
            try KeychainHelper.save(
                data,
                service: SSHConfig.keychainService,
                account: SSHConfig.keychainAccount,
                accessibility: kSecAttrAccessibleAfterFirstUnlock
            )
        } catch {
            Logger.shared.log(.storage, .error, "保存 SSH 密码到 Keychain 失败: \(error.localizedDescription)")
        }
    }

    private static func loadPasswordFromKeychain() -> String? {
        SSHConfig.loadPasswordFromKeychain()
    }

    private static func deletePasswordFromKeychain() {
        do {
            try KeychainHelper.delete(service: SSHConfig.keychainService, account: SSHConfig.keychainAccount)
        } catch {
            Logger.shared.log(.storage, .error, "删除 SSH 密码失败: \(error.localizedDescription)")
        }
    }
}
