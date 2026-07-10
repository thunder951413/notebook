import Foundation
import SwiftUI
import Combine

// MARK: - AI 服务配置

nonisolated struct AIServiceConfig: Identifiable, Codable, Equatable {
    var id: UUID
    var name: String
    var baseURL: String
    var apiKey: String
    var model: String
    var temperature: Double
    var maxTokens: Int
    var isDefault: Bool

    /// `apiKey` 只在内存中存在；持久化由 `AIConfigKeychainStore` 负责。
    /// 自定义 Codable 会读取旧版 JSON 中的 apiKey 以完成无损迁移，但永远不会再写出它。
    private enum CodingKeys: String, CodingKey {
        case id, name, baseURL, apiKey, model, temperature, maxTokens, isDefault
    }
    
    init(
        id: UUID = UUID(),
        name: String,
        baseURL: String = "https://api.openai.com/v1",
        apiKey: String = "",
        model: String = "gpt-4",
        temperature: Double = 0.7,
        maxTokens: Int = 2000,
        isDefault: Bool = false
    ) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.model = model
        self.temperature = temperature
        self.maxTokens = maxTokens
        self.isDefault = isDefault
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try container.decode(String.self, forKey: .name)
        baseURL = try container.decode(String.self, forKey: .baseURL)
        // 兼容读取历史明文配置；loadConfigs/import 会立即迁移到 Keychain。
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decode(String.self, forKey: .model)
        temperature = try container.decodeIfPresent(Double.self, forKey: .temperature) ?? 0.7
        maxTokens = try container.decodeIfPresent(Int.self, forKey: .maxTokens) ?? 2_000
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(baseURL, forKey: .baseURL)
        try container.encode(model, forKey: .model)
        try container.encode(temperature, forKey: .temperature)
        try container.encode(maxTokens, forKey: .maxTokens)
        try container.encode(isDefault, forKey: .isDefault)
    }
    
    // 预设配置
    static let openAI = AIServiceConfig(
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-4",
        temperature: 0.7,
        maxTokens: 2000
    )
    
    static let openAIGPT35 = AIServiceConfig(
        name: "OpenAI GPT-3.5",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-3.5-turbo",
        temperature: 0.7,
        maxTokens: 2000
    )
    
    static let azureOpenAI = AIServiceConfig(
        name: "Azure OpenAI",
        baseURL: "https://your-resource.openai.azure.com/openai/deployments/your-deployment",
        model: "gpt-4",
        temperature: 0.7,
        maxTokens: 2000
    )
    
    static let ollama = AIServiceConfig(
        name: "Ollama (本地)",
        baseURL: "http://localhost:11434/v1",
        model: "llama2",
        temperature: 0.7,
        maxTokens: 2000
    )
    
    static let lmStudio = AIServiceConfig(
        name: "LM Studio (本地)",
        baseURL: "http://localhost:1234/v1",
        model: "local-model",
        temperature: 0.7,
        maxTokens: 2000
    )
}

enum AIConfigKeychainStore {
    private static let service = "yy.Notebook.ai-api-key"

    static func load(configID: UUID) -> String? {
        KeychainHelper.loadString(service: service, account: configID.uuidString)
    }

    static func save(_ apiKey: String, configID: UUID) throws {
        if apiKey.isEmpty {
            try delete(configID: configID)
        } else {
            try KeychainHelper.save(
                Data(apiKey.utf8),
                service: service,
                account: configID.uuidString
            )
        }
    }

    static func delete(configID: UUID) throws {
        try KeychainHelper.delete(service: service, account: configID.uuidString)
    }
}

// MARK: - AI 配置管理器

@MainActor
class AIConfigManager: ObservableObject {
    static let shared = AIConfigManager()
    
    @Published var configs: [AIServiceConfig] = []
    @Published var selectedConfigID: UUID?
    
    private let configsKey = "ai.serviceConfigs"
    private let selectedConfigKey = "ai.selectedConfigID"
    private var cancellables = Set<AnyCancellable>()
    
    var selectedConfig: AIServiceConfig? {
        configs.first { $0.id == selectedConfigID }
    }
    
    private init() {
        loadConfigs()
    }
    
    func loadConfigs() {
        if let data = UserDefaults.standard.data(forKey: configsKey),
           let decoded = try? JSONDecoder().decode([AIServiceConfig].self, from: data) {
            configs = decoded.map { decodedConfig in
                var config = decodedConfig
                if !config.apiKey.isEmpty {
                    // 旧版本把密钥明文放在 UserDefaults。先写入 Keychain；成功后再由
                    // saveConfigs() 覆盖旧 JSON，避免任何迁移失败造成密钥丢失。
                    do {
                        try AIConfigKeychainStore.save(config.apiKey, configID: config.id)
                    } catch {
                        Logger.shared.log(.app, .error, "迁移 AI API Key 到 Keychain 失败: \(error.localizedDescription)")
                    }
                }
                if let keychainValue = AIConfigKeychainStore.load(configID: config.id) {
                    config.apiKey = keychainValue
                }
                return config
            }
            // 自定义编码不包含 apiKey；只有确认每个非空密钥都已进入 Keychain 后才清理旧明文。
            let migrationSucceeded = configs.allSatisfy { config in
                config.apiKey.isEmpty || AIConfigKeychainStore.load(configID: config.id) == config.apiKey
            }
            if migrationSucceeded {
                saveConfigs()
            }
        } else {
            // 默认配置
            configs = [
                AIServiceConfig(
                    name: "OpenAI GPT-4",
                    baseURL: "https://api.openai.com/v1",
                    model: "gpt-4",
                    isDefault: true
                )
            ]
        }
        
        // 加载选中的配置
        if let selectedID = UserDefaults.standard.string(forKey: selectedConfigKey),
           let uuid = UUID(uuidString: selectedID),
           configs.contains(where: { $0.id == uuid }) {
            selectedConfigID = uuid
        } else {
            selectedConfigID = configs.first?.id
        }
    }
    
    func saveConfigs() {
        for config in configs {
            do {
                try AIConfigKeychainStore.save(config.apiKey, configID: config.id)
            } catch {
                Logger.shared.log(.app, .error, "保存 AI API Key 到 Keychain 失败: \(error.localizedDescription)")
            }
        }
        if let encoded = try? JSONEncoder().encode(configs) {
            UserDefaults.standard.set(encoded, forKey: configsKey)
        }
        if let selectedConfigID = selectedConfigID {
            UserDefaults.standard.set(selectedConfigID.uuidString, forKey: selectedConfigKey)
        }
    }

    /// 导入公开配置。旧导出文件若仍含明文 apiKey，会先安全迁移到 Keychain；
    /// 新导出文件不含密钥，因此不会覆盖本机已有 Keychain 值。
    func importConfigs(_ imported: [AIServiceConfig]) {
        configs = imported.map { importedConfig in
            var config = importedConfig
            if !config.apiKey.isEmpty {
                do {
                    try AIConfigKeychainStore.save(config.apiKey, configID: config.id)
                } catch {
                    Logger.shared.log(.app, .error, "导入 AI API Key 到 Keychain 失败: \(error.localizedDescription)")
                }
            }
            config.apiKey = AIConfigKeychainStore.load(configID: config.id) ?? ""
            return config
        }
        saveConfigs()
    }
    
    func addConfig(_ config: AIServiceConfig) {
        configs.append(config)
        if selectedConfigID == nil {
            selectedConfigID = config.id
        }
        saveConfigs()
    }
    
    func updateConfig(_ config: AIServiceConfig) {
        if let index = configs.firstIndex(where: { $0.id == config.id }) {
            configs[index] = config
            saveConfigs()
        }
    }
    
    func deleteConfig(id: UUID) {
        do {
            try AIConfigKeychainStore.delete(configID: id)
        } catch {
            Logger.shared.log(.app, .warn, "删除 AI API Key 失败: \(error.localizedDescription)")
        }
        configs.removeAll { $0.id == id }
        if selectedConfigID == id {
            selectedConfigID = configs.first?.id
        }
        saveConfigs()
    }
    
    func selectConfig(id: UUID) {
        selectedConfigID = id
        saveConfigs()
    }
    
    func duplicateConfig(_ config: AIServiceConfig) {
        var newConfig = config
        newConfig.id = UUID()
        newConfig.name = "\(config.name) 副本"
        newConfig.isDefault = false
        configs.append(newConfig)
        saveConfigs()
    }
}
