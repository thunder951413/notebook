import Foundation
import Combine

@MainActor
final class GitHubTokenManager: ObservableObject {
    static let shared = GitHubTokenManager()

    @Published private(set) var hasToken: Bool

    private let service = "com.notebook.app.github"
    private let account = "update_token"

    private init() {
        self.hasToken = KeychainHelper.load(service: service, account: account) != nil
    }

    func loadToken() -> String? {
        KeychainHelper.loadString(service: service, account: account)
    }

    @discardableResult
    func saveToken(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            return false
        }

        do {
            try KeychainHelper.save(data, service: service, account: account)
            hasToken = true
            return true
        } catch {
            Logger.shared.log(.app, .error, "保存 GitHub Token 到 Keychain 失败: \(error.localizedDescription)")
            hasToken = false
            return false
        }
    }

    @discardableResult
    func deleteToken() -> Bool {
        do {
            try KeychainHelper.delete(service: service, account: account)
            hasToken = false
            return true
        } catch {
            Logger.shared.log(.app, .error, "删除 GitHub Token 失败: \(error.localizedDescription)")
            return false
        }
    }
}
