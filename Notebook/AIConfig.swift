import Foundation
import SwiftUI
import Combine

// MARK: - AI 服务配置

struct AIServiceConfig: Identifiable, Codable, Equatable {
    var id: UUID
    var name: String
    var baseURL: String
    var apiKey: String
    var model: String
    var temperature: Double
    var maxTokens: Int
    var isDefault: Bool
    
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
            configs = decoded
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
        if let encoded = try? JSONEncoder().encode(configs) {
            UserDefaults.standard.set(encoded, forKey: configsKey)
        }
        if let selectedConfigID = selectedConfigID {
            UserDefaults.standard.set(selectedConfigID.uuidString, forKey: selectedConfigKey)
        }
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
