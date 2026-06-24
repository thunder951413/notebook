import SwiftUI
import AppKit
import SwiftData

struct AIConfigManagementView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @StateObject private var configManager = AIConfigManager.shared
    @State private var editingConfig: AIServiceConfig?
    @State private var showingAddSheet = false
    
    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text("AI 服务配置")
                    .font(.headline)
                Spacer()
                Button {
                    showingAddSheet = true
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                Button {
                    dismiss()
                } label: {
                    Text("关闭")
                }
                .buttonStyle(.plain)
            }
            .padding()
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 配置列表
            List {
                Section {
                    ForEach(configManager.configs) { config in
                        ConfigRow(config: config, isSelected: config.id == configManager.selectedConfigID)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                configManager.selectConfig(id: config.id)
                            }
                            .contextMenu {
                                Button {
                                    editingConfig = config
                                } label: {
                                    Label("编辑", systemImage: "pencil")
                                }
                                Button {
                                    configManager.duplicateConfig(config)
                                } label: {
                                    Label("复制", systemImage: "doc.on.doc")
                                }
                                Divider()
                                Button(role: .destructive) {
                                    configManager.deleteConfig(id: config.id)
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                    }
                }
                
                Section("添加预设") {
                    HStack(spacing: 12) {
                        PresetButton(title: "OpenAI", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.openAI)
                        }
                        PresetButton(title: "GPT-3.5", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.openAIGPT35)
                        }
                        PresetButton(title: "Azure", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.azureOpenAI)
                        }
                    }
                    HStack(spacing: 12) {
                        PresetButton(title: "Ollama", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.ollama)
                        }
                        PresetButton(title: "LM Studio", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.lmStudio)
                        }
                        Spacer()
                    }
                }
            }
            .listStyle(.plain)
        }
        .frame(width: 400, height: 500)
        .background(AppColors.editorBackground(colorScheme))
        .sheet(item: $editingConfig) { config in
            AIConfigEditView(config: config, isNew: false)
        }
        .sheet(isPresented: $showingAddSheet) {
            AIConfigEditView(
                config: AIServiceConfig(name: "新配置"),
                isNew: true
            )
        }
    }
}

struct PresetButton: View {
    let title: String
    let icon: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption)
                Text(title)
                    .font(.caption)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.blue.opacity(0.1))
            .foregroundStyle(.blue)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

struct ConfigRow: View {
    let config: AIServiceConfig
    let isSelected: Bool
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(config.name)
                    .font(.headline)
                Text("\(config.model) @ \(config.baseURL)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            
            Spacer()
            
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.blue)
            }
            
            if config.apiKey.isEmpty {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .help("未配置 API Key")
            }
        }
        .padding(.vertical, 4)
    }
}

struct AIConfigEditView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @StateObject private var configManager = AIConfigManager.shared
    
    @State var config: AIServiceConfig
    let isNew: Bool
    
    @State private var name: String = ""
    @State private var baseURL: String = ""
    @State private var apiKey: String = ""
    @State private var model: String = ""
    @State private var temperature: Double = 0.7
    @State private var maxTokens: Int = 2000
    
    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Button("取消") {
                    dismiss()
                }
                .buttonStyle(.plain)
                
                Spacer()
                
                Text(isNew ? "添加配置" : "编辑配置")
                    .font(.headline)
                
                Spacer()
                
                Button("保存") {
                    saveConfig()
                }
                .buttonStyle(.plain)
                .disabled(name.isEmpty || baseURL.isEmpty || model.isEmpty)
            }
            .padding()
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 表单内容
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // 基本信息
                    Group {
                        Text("基本信息")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        TextField("配置名称", text: $name)
                            .textFieldStyle(.roundedBorder)
                        
                        TextField("Base URL", text: $baseURL)
                            .textFieldStyle(.roundedBorder)
                    }
                    
                    Divider()
                    
                    // 认证
                    Group {
                        Text("认证")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        SecureField("API Key", text: $apiKey)
                            .textFieldStyle(.roundedBorder)
                    }
                    
                    Divider()
                    
                    // 模型设置
                    Group {
                        Text("模型设置")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        TextField("模型名称", text: $model)
                            .textFieldStyle(.roundedBorder)
                        
                        HStack {
                            Text("Temperature: \(String(format: "%.1f", temperature))")
                            Spacer()
                        }
                        Slider(value: $temperature, in: 0...2, step: 0.1)
                        
                        HStack {
                            Text("Max Tokens: \(maxTokens)")
                            Spacer()
                        }
                        Slider(value: Binding(
                            get: { Double(maxTokens) },
                            set: { maxTokens = Int($0) }
                        ), in: 100...8000, step: 100)
                    }
                    
                    Divider()
                    
                    // 常用模型
                    Group {
                        Text("常用模型")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        FlowLayout(spacing: 8) {
                            ModelButton(title: "GPT-4") { model = "gpt-4" }
                            ModelButton(title: "GPT-4 Turbo") { model = "gpt-4-turbo-preview" }
                            ModelButton(title: "GPT-3.5") { model = "gpt-3.5-turbo" }
                            ModelButton(title: "Claude 3 Opus") { model = "claude-3-opus-20240229" }
                            ModelButton(title: "Claude 3 Sonnet") { model = "claude-3-sonnet-20240229" }
                            ModelButton(title: "Llama 2") { model = "llama2" }
                            ModelButton(title: "Mistral") { model = "mistral" }
                        }
                    }
                }
                .padding()
            }
        }
        .frame(width: 400, height: 500)
        .background(AppColors.editorBackground(colorScheme))
        .onAppear {
            name = config.name
            baseURL = config.baseURL
            apiKey = config.apiKey
            model = config.model
            temperature = config.temperature
            maxTokens = config.maxTokens
        }
    }
    
    private func saveConfig() {
        var updatedConfig = config
        updatedConfig.name = name
        updatedConfig.baseURL = baseURL
        updatedConfig.apiKey = apiKey
        updatedConfig.model = model
        updatedConfig.temperature = temperature
        updatedConfig.maxTokens = maxTokens
        
        if isNew {
            configManager.addConfig(updatedConfig)
        } else {
            configManager.updateConfig(updatedConfig)
        }
        
        dismiss()
    }
}

struct ModelButton: View {
    let title: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.blue.opacity(0.1))
                .foregroundStyle(.blue)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

