import Foundation
import Combine
import Security

/// SSH 配置模型
struct SSHConfig: Codable {
    var host: String
    var port: Int
    var username: String
    /// 密码不序列化到 JSON，而是存储在 Keychain 中
    var password: String = ""
    var repositoryPath: String

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
}

/// SSH 配置管理器
class SSHConfigManager: ObservableObject {
    static let shared = SSHConfigManager()

    private let configKey = "ssh_config"
    private static let keychainService = "com.notebook.ssh.password"
    private static let keychainAccount = "ssh_password"

    @Published var config: SSHConfig {
        didSet {
            saveConfig(config)
        }
    }

    var isConfigured: Bool {
        !config.host.isEmpty && !config.username.isEmpty
    }

    private init() {
        if let data = UserDefaults.standard.data(forKey: configKey),
           let loaded = try? JSONDecoder().decode(SSHConfig.self, from: data) {
            let pw = Self.loadPasswordFromKeychain() ?? loaded.password
            self.config = SSHConfig(
                host: loaded.host,
                port: loaded.port,
                username: loaded.username,
                password: pw,
                repositoryPath: loaded.repositoryPath
            )
        } else {
            self.config = .default
        }
    }

    func clearConfig() {
        UserDefaults.standard.removeObject(forKey: configKey)
        Self.deletePasswordFromKeychain()
        config = .default
    }

    private func saveConfig(_ config: SSHConfig) {
        do {
            let encoder = JSONEncoder()
            let data = try encoder.encode(config)
            UserDefaults.standard.set(data, forKey: configKey)
        } catch {
            print("[SSHConfig] Failed to save config: \(error)")
        }

        if !config.password.isEmpty {
            Self.savePasswordToKeychain(config.password)
        } else {
            Self.deletePasswordFromKeychain()
        }
    }

    // MARK: - Keychain Operations (static)

    private static func savePasswordToKeychain(_ password: String) {
        deletePasswordFromKeychain()

        guard let data = password.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            print("[SSHConfig] Failed to save password to Keychain: \(status)")
        }
    }

    private static func loadPasswordFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func deletePasswordFromKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]

        SecItemDelete(query as CFDictionary)
    }
}
