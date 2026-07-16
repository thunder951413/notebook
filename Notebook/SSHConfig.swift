import Foundation
import Combine

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
