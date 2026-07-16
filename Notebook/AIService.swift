import Foundation
import SwiftUI
import Combine

// MARK: - AI 服务

@MainActor
class AIService: ObservableObject {
    static let shared = AIService()
    
    @Published var isLoading = false
    @Published var error: Error?
    
    private var cancellables = Set<AnyCancellable>()
    
    private init() {}
    
    // MARK: - 发送消息
    
    func sendMessage(
        messages: [AIMessageDTO],
        apiKey: String,
        baseURL: String,
        model: String,
        temperature: Double,
        maxTokens: Int
    ) async throws -> String {
        guard !apiKey.isEmpty else {
            throw AIServiceError.missingAPIKey
        }
        
        let url = try Self.endpointURL(baseURL: baseURL)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        
        let body = RequestBody(
            model: model,
            messages: messages.map { Message(role: $0.resolvedRole, text: $0.content, images: $0.images) },
            temperature: temperature,
            max_tokens: maxTokens
        )
        
        request.httpBody = try JSONEncoder().encode(body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AIServiceError.invalidResponse
        }
        
        guard httpResponse.statusCode == 200 else {
            let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            throw AIServiceError.apiError(errorResponse?.error.message ?? "HTTP \(httpResponse.statusCode)")
        }
        
        let responseBody = try JSONDecoder().decode(ResponseBody.self, from: data)
        
        guard let choice = responseBody.choices.first else {
            throw AIServiceError.noResponse
        }
        
        return choice.message.textContent
    }
    
    // MARK: - 流式发送消息
    
    func sendMessageStream(
        messages: [AIMessageDTO],
        apiKey: String,
        baseURL: String,
        model: String,
        temperature: Double,
        maxTokens: Int,
        onReceive: @escaping (String) -> Void
    ) async throws {
        guard !apiKey.isEmpty else {
            throw AIServiceError.missingAPIKey
        }
        
        let url = try Self.endpointURL(baseURL: baseURL)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        
        // 使用非流式模式，简化处理
        let body = RequestBody(
            model: model,
            messages: messages.map { Message(role: $0.resolvedRole, text: $0.content, images: $0.images) },
            temperature: temperature,
            max_tokens: maxTokens,
            stream: false
        )
        
        request.httpBody = try JSONEncoder().encode(body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AIServiceError.invalidResponse
        }
        
        guard httpResponse.statusCode == 200 else {
            let responseString = String(data: data, encoding: .utf8) ?? "无法读取响应"
            DebugLog.app("HTTP \(httpResponse.statusCode): \(responseString)", level: .debug)
            
            // 尝试解析错误响应
            if let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw AIServiceError.apiError(errorResponse.error.message)
            }
            
            // 检查常见错误
            if responseString.contains("Unexpected endpoint") {
                throw AIServiceError.apiError("API 端点错误，请检查 Base URL 配置是否正确")
            }
            if responseString.contains("invalid_api_key") || responseString.contains("Incorrect API key") {
                throw AIServiceError.apiError("API Key 无效，请检查配置")
            }
            if httpResponse.statusCode == 401 {
                throw AIServiceError.apiError("认证失败 (401)，请检查 API Key")
            }
            if httpResponse.statusCode == 429 {
                throw AIServiceError.apiError("请求过于频繁 (429)，请稍后再试")
            }
            
            throw AIServiceError.apiError("HTTP \(httpResponse.statusCode): \(responseString.prefix(200))")
        }
        
        // 解析非流式响应
        let responseString = String(data: data, encoding: .utf8) ?? ""
        DebugLog.app(": \(responseString.prefix(500))", level: .debug)
        
        let responseBody = try JSONDecoder().decode(ResponseBody.self, from: data)
        
        guard let choice = responseBody.choices.first else {
            throw AIServiceError.noResponse
        }
        
        // 模拟流式效果，逐字输出
        let content = choice.message.textContent
        for char in content {
            onReceive(String(char))
            // 添加小延迟模拟打字效果
            try await Task.sleep(nanoseconds: 10_000_000) // 10ms
        }
    }

    static func endpointURL(baseURL: String) throws -> URL {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty else {
            throw AIServiceError.invalidBaseURL
        }

        let isLoopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && isLoopback) else {
            throw AIServiceError.insecureBaseURL
        }

        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + ([basePath, "chat/completions"].filter { !$0.isEmpty }.joined(separator: "/"))
        components.query = nil
        components.fragment = nil
        guard let url = components.url else {
            throw AIServiceError.invalidBaseURL
        }
        return url
    }
}

// MARK: - 数据模型

struct AIMessageDTO: Identifiable {
    let id: UUID
    let content: String
    let isUser: Bool
    let images: [AIImageAttachment]
    /// 显式指定 role（如 "system"）。为 nil 时按 isUser 推导 "user"/"assistant"。
    let role: String?

    init(id: UUID = UUID(), content: String, isUser: Bool, images: [AIImageAttachment] = [], role: String? = nil) {
        self.id = id
        self.content = content
        self.isUser = isUser
        self.images = images
        self.role = role
    }

    /// 解析最终 role：显式 role 优先，否则按 isUser 推导
    var resolvedRole: String {
        role ?? (isUser ? "user" : "assistant")
    }
}

/// AI 图片附件
struct AIImageAttachment: Codable {
    let base64Data: String
    let mimeType: String
    
    /// 转换为 OpenAI 格式的 image_url
    func toOpenAIImageURL() -> String {
        return "data:\(mimeType);base64,\(base64Data)"
    }
}

// MARK: - 请求/响应模型

private struct RequestBody: Codable {
    let model: String
    let messages: [Message]
    let temperature: Double
    let max_tokens: Int
    var stream: Bool = false
}

/// 支持多模态的消息结构
private struct Message: Codable {
    let role: String
    let content: MessageContent
    
    /// 用于发送请求的初始化方法
    init(role: String, text: String, images: [AIImageAttachment] = []) {
        self.role = role
        
        var items: [ContentItem] = []
        
        // 添加文本内容
        if !text.isEmpty {
            items.append(ContentItem(type: "text", text: text))
        }
        
        // 添加图片
        for image in images {
            let imageURL = ["url": image.toOpenAIImageURL()]
            items.append(ContentItem(type: "image_url", image_url: imageURL))
        }
        
        // 如果没有内容，添加空文本
        if items.isEmpty {
            items.append(ContentItem(type: "text", text: ""))
        }
        
        self.content = .array(items)
    }
    
    /// 获取文本内容（用于响应解析）
    var textContent: String {
        switch content {
        case .string(let text):
            return text
        case .array(let items):
            return items.compactMap { $0.text }.joined()
        }
    }
}

/// 消息内容类型（支持字符串或数组）
private enum MessageContent: Codable {
    case string(String)
    case array([ContentItem])
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        
        // 尝试解码为字符串
        if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
            return
        }
        
        // 尝试解码为数组
        if let arrayValue = try? container.decode([ContentItem].self) {
            self = .array(arrayValue)
            return
        }
        
        throw DecodingError.typeMismatch(
            MessageContent.self,
            DecodingError.Context(
                codingPath: decoder.codingPath,
                debugDescription: "Expected String or Array<ContentItem>"
            )
        )
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        }
    }
}

/// 内容项（支持文本和图片）
private struct ContentItem: Codable {
    let type: String
    var text: String?
    var image_url: [String: String]?
    
    init(type: String, text: String? = nil, image_url: [String: String]? = nil) {
        self.type = type
        self.text = text
        self.image_url = image_url
    }
}

private struct ResponseBody: Codable {
    let choices: [Choice]
}

private struct Choice: Codable {
    let message: Message
}

private struct StreamResponse: Codable {
    let choices: [StreamChoice]
}

private struct StreamChoice: Codable {
    let delta: Delta
}

private struct Delta: Codable {
    let content: String?
}

private struct ErrorResponse: Codable {
    let error: APIError
}

private struct APIError: Codable {
    let message: String
}

// MARK: - 错误类型

enum AIServiceError: LocalizedError {
    case missingAPIKey
    case invalidBaseURL
    case insecureBaseURL
    case invalidResponse
    case apiError(String)
    case noResponse
    
    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "请先配置 API Key"
        case .invalidBaseURL:
            return "Base URL 无效，请输入完整的 HTTP(S) 地址"
        case .insecureBaseURL:
            return "远程 AI 服务必须使用 HTTPS；HTTP 仅允许 localhost"
        case .invalidResponse:
            return "无效的响应"
        case .apiError(let message):
            return "API 错误: \(message)"
        case .noResponse:
            return "没有收到回复"
        }
    }
}
