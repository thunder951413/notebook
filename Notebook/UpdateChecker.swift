import Foundation
import AppKit
import Combine

struct GitHubReleaseInfo: Equatable {
    let version: String
    let tagName: String
    let releaseName: String
    let htmlURL: URL
    let preferredDownloadURL: URL?
    let body: String
    let publishedAt: Date?
    let source: Source

    enum Source: Equatable {
        case release
        case tag
    }
}

@MainActor
final class UpdateChecker: ObservableObject {
    static let shared = UpdateChecker()

    @Published private(set) var isChecking = false
    @Published private(set) var lastCheckedAt: Date?
    @Published private(set) var lastCheckMessage = "尚未检查更新"
    @Published private(set) var latestRelease: GitHubReleaseInfo?
    @Published private(set) var latestServerInfo: GitHubReleaseInfo?
    @Published private(set) var serverVersionText = "未检查"
    @Published private(set) var serverPublishedAt: Date?
    @Published private(set) var isTestingToken = false
    @Published private(set) var tokenTestMessage = "尚未测试 Token"

    private let automaticCheckInterval: TimeInterval = 24 * 60 * 60
    private let lastAutomaticCheckKey = "update.last_automatic_check_at"

    private init() {}

    func checkForUpdates(silently: Bool) async -> GitHubReleaseInfo? {
        guard !isChecking else { return nil }
        if silently,
           let lastCheck = NotebookDefaults.shared.object(forKey: lastAutomaticCheckKey) as? Date,
           Date().timeIntervalSince(lastCheck) < automaticCheckInterval {
            return nil
        }
        isChecking = true
        defer { isChecking = false }
        if silently {
            // 无论服务器结果如何都限频，避免仓库不可访问时每次启动重复联网。
            NotebookDefaults.shared.set(Date(), forKey: lastAutomaticCheckKey)
        }

        do {
            let release = try await fetchLatestRelease()
            lastCheckedAt = Date()
            latestServerInfo = release
            serverVersionText = release.version
            serverPublishedAt = release.publishedAt

            let currentVersion = AppVersion.current.shortVersion
            if Self.isVersion(release.version, newerThan: currentVersion) {
                latestRelease = release.source == .release ? release : nil
                if release.source == .release {
                    lastCheckMessage = "发现新版本 \(release.version)"
                } else {
                    lastCheckMessage = "检测到最新标签 \(release.version)，但仓库暂无可下载 Release"
                }
                Logger.shared.log(.app, .info, "[UpdateChecker] 发现新版本 \(release.version)，当前版本 \(currentVersion)")
                return release
            }

            latestRelease = nil
            lastCheckMessage = "当前已是最新版本 (\(currentVersion))"
            if !silently {
                Logger.shared.log(.app, .info, "[UpdateChecker] 当前已是最新版本 \(currentVersion)")
            }
            return nil
        } catch {
            latestRelease = nil
            latestServerInfo = nil
            lastCheckedAt = Date()
            serverVersionText = "获取失败"
            serverPublishedAt = nil
            lastCheckMessage = "检查更新失败: \(error.localizedDescription)"
            Logger.shared.log(.app, .warn, "[UpdateChecker] 检查更新失败: \(error.localizedDescription)")
            return nil
        }
    }

    func openReleasePage(for release: GitHubReleaseInfo? = nil) {
        if let url = release?.htmlURL ?? AppSettings.shared.githubRepositoryURL {
            NSWorkspace.shared.open(url)
        }
    }

    func openPreferredDownload(for release: GitHubReleaseInfo? = nil) {
        let url = release?.preferredDownloadURL ?? release?.htmlURL ?? AppSettings.shared.githubRepositoryURL
        guard let url else { return }
        NSWorkspace.shared.open(url)
    }

    func testTokenAccess() async {
        guard !isTestingToken else { return }
        guard let token = GitHubTokenManager.shared.loadToken(), !token.isEmpty else {
            tokenTestMessage = "请先保存 GitHub Token，再执行测试。"
            return
        }
        isTestingToken = true
        defer { isTestingToken = false }

        do {
            let repository = try await fetchRepositoryAccess()

            do {
                let latest = try await fetchLatestRelease()
                let sourceText = latest.source == .release ? "Release" : "tag"
                tokenTestMessage = "Token 有效，已成功访问仓库 \(repository.fullName) 并读取最新\(sourceText) \(latest.version)"
            } catch UpdateError.releaseNotFound {
                tokenTestMessage = "Token 有效，已成功访问仓库 \(repository.fullName)，但当前未找到可用的 Release 或 tag"
            } catch {
                tokenTestMessage = "Token 可访问仓库 \(repository.fullName)，但读取更新信息失败: \(error.localizedDescription)"
            }
        } catch {
            tokenTestMessage = "Token 测试失败: \(error.localizedDescription)"
        }
    }

    private func fetchLatestRelease() async throws -> GitHubReleaseInfo {
        let repositoryPath = try normalizedRepositoryPath(from: AppSettings.shared.githubRepositoryURLString)
        guard let apiURL = URL(string: "https://api.github.com/repos/\(repositoryPath)/releases/latest") else {
            throw UpdateError.invalidRepositoryURL
        }

        let request = makeRequest(url: apiURL)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw UpdateError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200:
            break
        case 404:
            return try await fetchLatestTag(repositoryPath: repositoryPath)
        case 401, 403:
            throw UpdateError.authenticationFailed
        default:
            throw UpdateError.httpStatus(httpResponse.statusCode)
        }

        let payload = try JSONDecoder.githubReleaseDecoder.decode(GitHubLatestReleaseResponse.self, from: data)
        guard !payload.draft, !payload.prerelease else {
            return try await fetchLatestTag(repositoryPath: repositoryPath)
        }

        let version = Self.normalizedVersion(fromTag: payload.tagName)
        return GitHubReleaseInfo(
            version: version,
            tagName: payload.tagName,
            releaseName: payload.name ?? payload.tagName,
            htmlURL: payload.htmlURL,
            preferredDownloadURL: Self.preferredAssetURL(from: payload.assets),
            body: payload.body ?? "",
            publishedAt: payload.publishedAt,
            source: .release
        )
    }

    private func fetchRepositoryAccess() async throws -> GitHubRepositoryResponse {
        let repositoryPath = try normalizedRepositoryPath(from: AppSettings.shared.githubRepositoryURLString)
        guard let apiURL = URL(string: "https://api.github.com/repos/\(repositoryPath)") else {
            throw UpdateError.invalidRepositoryURL
        }

        let request = makeRequest(url: apiURL)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw UpdateError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200:
            break
        case 401, 403:
            throw UpdateError.authenticationFailed
        case 404:
            throw UpdateError.repositoryNotAccessible
        default:
            throw UpdateError.httpStatus(httpResponse.statusCode)
        }

        return try JSONDecoder().decode(GitHubRepositoryResponse.self, from: data)
    }

    private func fetchLatestTag(repositoryPath: String) async throws -> GitHubReleaseInfo {
        guard let apiURL = URL(string: "https://api.github.com/repos/\(repositoryPath)/tags?per_page=1") else {
            throw UpdateError.invalidRepositoryURL
        }

        let request = makeRequest(url: apiURL)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw UpdateError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200:
            break
        case 404:
            throw UpdateError.repositoryNotAccessible
        case 401, 403:
            throw UpdateError.authenticationFailed
        default:
            throw UpdateError.httpStatus(httpResponse.statusCode)
        }

        let payload = try JSONDecoder().decode([GitHubTagResponse].self, from: data)
        guard let latestTag = payload.first else {
            throw UpdateError.releaseNotFound
        }

        let version = Self.normalizedVersion(fromTag: latestTag.name)
        guard let htmlURL = AppSettings.shared.githubRepositoryURL?.appending(path: "releases") else {
            throw UpdateError.invalidRepositoryURL
        }

        return GitHubReleaseInfo(
            version: version,
            tagName: latestTag.name,
            releaseName: latestTag.name,
            htmlURL: htmlURL,
            preferredDownloadURL: nil,
            body: "",
            publishedAt: nil,
            source: .tag
        )
    }

    private func makeRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Notebook/\(AppVersion.current.shortVersion)", forHTTPHeaderField: "User-Agent")
        if let token = GitHubTokenManager.shared.loadToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func normalizedRepositoryPath(from rawValue: String) throws -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw UpdateError.invalidRepositoryURL
        }

        if let shorthand = Self.repositoryShorthand(from: trimmed) {
            return shorthand
        }

        guard let url = URL(string: trimmed),
              let host = url.host?.lowercased(),
              host.contains("github.com") else {
            throw UpdateError.invalidRepositoryURL
        }

        let components = url.path
            .split(separator: "/")
            .map(String.init)
            .filter { !$0.isEmpty }

        guard components.count >= 2 else {
            throw UpdateError.invalidRepositoryURL
        }

        let owner = components[0]
        var repo = components[1]
        if repo.hasSuffix(".git") {
            repo.removeLast(4)
        }

        guard !owner.isEmpty, !repo.isEmpty else {
            throw UpdateError.invalidRepositoryURL
        }

        return "\(owner)/\(repo)"
    }

    private static func repositoryShorthand(from rawValue: String) -> String? {
        let parts = rawValue.split(separator: "/").map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else {
            return nil
        }
        return "\(parts[0])/\(parts[1].replacingOccurrences(of: ".git", with: ""))"
    }

    private static func normalizedVersion(fromTag tag: String) -> String {
        let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("v") {
            return String(trimmed.dropFirst())
        }
        return trimmed
    }

    private static func preferredAssetURL(from assets: [GitHubReleaseAssetResponse]) -> URL? {
        let rankedAssets = assets.sorted { lhs, rhs in
            let leftRank = assetPriority(for: lhs.name)
            let rightRank = assetPriority(for: rhs.name)
            if leftRank != rightRank {
                return leftRank < rightRank
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }

        return rankedAssets.first?.browserDownloadURL
    }

    private static func assetPriority(for fileName: String) -> Int {
        let name = fileName.lowercased()
        if name.hasSuffix(".dmg") {
            return 0
        }
        if name.hasSuffix(".zip") {
            return 1
        }
        return 2
    }

    static func isVersion(_ remoteVersion: String, newerThan localVersion: String) -> Bool {
        let remote = versionComponents(from: remoteVersion)
        let local = versionComponents(from: localVersion)
        let count = max(remote.count, local.count)

        for index in 0..<count {
            let remoteValue = index < remote.count ? remote[index] : 0
            let localValue = index < local.count ? local[index] : 0
            if remoteValue != localValue {
                return remoteValue > localValue
            }
        }

        return false
    }

    private static func versionComponents(from value: String) -> [Int] {
        value
            .split(separator: ".")
            .map { Int($0) ?? 0 }
    }
}

extension UpdateChecker {
    enum UpdateError: LocalizedError {
        case invalidRepositoryURL
        case invalidResponse
        case releaseNotFound
        case noStableRelease
        case repositoryNotAccessible
        case authenticationFailed
        case httpStatus(Int)

        var errorDescription: String? {
            switch self {
            case .invalidRepositoryURL:
                return "GitHub 仓库地址无效"
            case .invalidResponse:
                return "更新服务返回了无效响应"
            case .releaseNotFound:
                return "未找到可用的 Release 或 tag"
            case .noStableRelease:
                return "当前没有可用的稳定版 Release"
            case .repositoryNotAccessible:
                return "无法访问该仓库，可能是地址错误；如果仓库是 private，请先配置 GitHub Token"
            case .authenticationFailed:
                return "GitHub Token 无效，或没有访问该私有仓库的权限"
            case .httpStatus(let code):
                return "GitHub 接口请求失败（HTTP \(code)）"
            }
        }
    }
}

private struct GitHubLatestReleaseResponse: Decodable {
    let tagName: String
    let name: String?
    let body: String?
    let htmlURL: URL
    let assets: [GitHubReleaseAssetResponse]
    let draft: Bool
    let prerelease: Bool
    let publishedAt: Date?

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case name
        case body
        case htmlURL = "html_url"
        case assets
        case draft
        case prerelease
        case publishedAt = "published_at"
    }
}

private struct GitHubReleaseAssetResponse: Decodable {
    let name: String
    let browserDownloadURL: URL

    enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
    }
}

private struct GitHubTagResponse: Decodable {
    let name: String
}

private struct GitHubRepositoryResponse: Decodable {
    let fullName: String

    enum CodingKeys: String, CodingKey {
        case fullName = "full_name"
    }
}

private extension JSONDecoder {
    static let githubReleaseDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

struct AppVersion {
    let shortVersion: String
    let buildVersion: String

    static var current: AppVersion {
        let info = Bundle.main.infoDictionary ?? [:]
        let shortVersion = info["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let buildVersion = info["CFBundleVersion"] as? String ?? "0"
        return AppVersion(shortVersion: shortVersion, buildVersion: buildVersion)
    }

    var displayString: String {
        "版本 \(shortVersion) (\(buildVersion))"
    }
}
