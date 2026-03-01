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
        
        let url = URL(string: "\(baseURL)/chat/completions")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        
        let body = RequestBody(
            model: model,
            messages: messages.map { Message(role: $0.isUser ? "user" : "assistant", content: $0.content) },
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
        
        return choice.message.content
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
        
        let url = URL(string: "\(baseURL)/chat/completions")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        
        // 使用非流式模式，简化处理
        let body = RequestBody(
            model: model,
            messages: messages.map { Message(role: $0.isUser ? "user" : "assistant", content: $0.content) },
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
            print("[AI Error] HTTP \(httpResponse.statusCode): \(responseString)")
            
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
        print("[AI Response]: \(responseString.prefix(500))")
        
        let responseBody = try JSONDecoder().decode(ResponseBody.self, from: data)
        
        guard let choice = responseBody.choices.first else {
            throw AIServiceError.noResponse
        }
        
        // 模拟流式效果，逐字输出
        let content = choice.message.content
        for char in content {
            onReceive(String(char))
            // 添加小延迟模拟打字效果
            try await Task.sleep(nanoseconds: 10_000_000) // 10ms
        }
    }
}

// MARK: - 数据模型

struct AIMessageDTO: Identifiable {
    let id = UUID()
    let content: String
    let isUser: Bool
}

// MARK: - 请求/响应模型

private struct RequestBody: Codable {
    let model: String
    let messages: [Message]
    let temperature: Double
    let max_tokens: Int
    var stream: Bool = false
}

private struct Message: Codable {
    let role: String
    let content: String
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
    case invalidResponse
    case apiError(String)
    case noResponse
    
    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "请先配置 API Key"
        case .invalidResponse:
            return "无效的响应"
        case .apiError(let message):
            return "API 错误: \(message)"
        case .noResponse:
            return "没有收到回复"
        }
    }
}
