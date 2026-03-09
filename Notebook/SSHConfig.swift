import Foundation

/// SSH 配置模型
struct SSHConfig: Codable {
    var host: String
    var port: Int
    var username: String
    var password: String
    var repositoryPath: String
    
    static let `default` = SSHConfig(
        host: "",
        port: 22,
        username: "",
        password: "",
        repositoryPath: "~/notebook_backup"
    )
}

/// SSH 配置管理器
class SSHConfigManager {
    static let shared = SSHConfigManager()
    
    private let configKey = "ssh_config"
    
    var config: SSHConfig {
        get {
            guard let data = UserDefaults.standard.data(forKey: configKey),
                  let config = try? JSONDecoder().decode(SSHConfig.self, from: data) else {
                return .default
            }
            return config
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: configKey)
            }
        }
    }
    
    var isConfigured: Bool {
        !config.host.isEmpty && !config.username.isEmpty
    }
    
    func clearConfig() {
        UserDefaults.standard.removeObject(forKey: configKey)
    }
}
