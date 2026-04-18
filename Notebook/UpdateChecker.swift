import Foundation
import AppKit
import Combine

struct GitHubReleaseInfo: Equatable {
    let version: String
    let tagName: String
    let releaseName: String
    let htmlURL: URL
    let body: String
    let publishedAt: Date?
}

@MainActor
final class UpdateChecker: ObservableObject {
    static let shared = UpdateChecker()

    @Published private(set) var isChecking = false
    @Published private(set) var lastCheckedAt: Date?
    @Published private(set) var lastCheckMessage = "尚未检查更新"
    @Published private(set) var latestRelease: GitHubReleaseInfo?

    private init() {}

    func checkForUpdates(silently: Bool) async -> GitHubReleaseInfo? {
        guard !isChecking else { return nil }
        isChecking = true
        defer { isChecking = false }

        do {
            let release = try await fetchLatestRelease()
            lastCheckedAt = Date()

            let currentVersion = AppVersion.current.shortVersion
            if Self.isVersion(release.version, newerThan: currentVersion) {
                latestRelease = release
                lastCheckMessage = "发现新版本 \(release.version)"
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
            lastCheckedAt = Date()
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

    private func fetchLatestRelease() async throws -> GitHubReleaseInfo {
        let repositoryPath = try normalizedRepositoryPath(from: AppSettings.shared.githubRepositoryURLString)
        guard let apiURL = URL(string: "https://api.github.com/repos/\(repositoryPath)/releases/latest") else {
            throw UpdateError.invalidRepositoryURL
        }

        var request = URLRequest(url: apiURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Notebook/\(AppVersion.current.shortVersion)", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw UpdateError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200:
            break
        case 404:
            throw UpdateError.releaseNotFound
        default:
            throw UpdateError.httpStatus(httpResponse.statusCode)
        }

        let payload = try JSONDecoder.githubReleaseDecoder.decode(GitHubLatestReleaseResponse.self, from: data)
        guard !payload.draft, !payload.prerelease else {
            throw UpdateError.noStableRelease
        }

        let version = Self.normalizedVersion(fromTag: payload.tagName)
        return GitHubReleaseInfo(
            version: version,
            tagName: payload.tagName,
            releaseName: payload.name ?? payload.tagName,
            htmlURL: payload.htmlURL,
            body: payload.body ?? "",
            publishedAt: payload.publishedAt
        )
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
        case httpStatus(Int)

        var errorDescription: String? {
            switch self {
            case .invalidRepositoryURL:
                return "GitHub 仓库地址无效"
            case .invalidResponse:
                return "更新服务返回了无效响应"
            case .releaseNotFound:
                return "未找到可用的 Release"
            case .noStableRelease:
                return "当前没有可用的稳定版 Release"
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
    let draft: Bool
    let prerelease: Bool
    let publishedAt: Date?

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case name
        case body
        case htmlURL = "html_url"
        case draft
        case prerelease
        case publishedAt = "published_at"
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
