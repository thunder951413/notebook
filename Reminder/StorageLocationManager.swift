import Foundation
import AppKit
import Combine

@MainActor
final class StorageLocationManager: ObservableObject {
    static let shared = StorageLocationManager()

    private let bookmarkKey = "storageDirectoryBookmark"

    @Published private(set) var baseDirectoryURL: URL?

    private init() {
        self.baseDirectoryURL = resolveBaseDirectoryURL()
    }

    var isConfigured: Bool {
        baseDirectoryURL != nil
    }

    /// 选择保存目录（会保存 security-scoped bookmark，并立即开始访问该目录）
    func promptUserToChooseBaseDirectory() async throws {
        let panel = NSOpenPanel()
        panel.title = "选择保存目录"
        panel.message = "应用会在此目录下创建 ReminderData/Database 与 ReminderData/Attachments 来保存数据与附件。"
        panel.prompt = "选择"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false

        let result = panel.runModal()
        guard result == .OK, let url = panel.url else {
            throw NSError(domain: "StorageLocationManager", code: 1, userInfo: [NSLocalizedDescriptionKey: l10n(L10nKeys.Error.userCancelled)])
        }

        try persistBookmark(for: url)
        self.baseDirectoryURL = url

        // 关键：马上开启访问并创建目录结构，确保后续 SwiftData/附件写入不会因为权限失败
        _ = startAccessIfPossible()
        do {
            try ensureDirectoryStructureExists()
        } catch {
            stopAccessIfNeeded()
            throw error
        }
    }

    // MARK: - Security scoped access

    private var hasActiveSecurityScope: Bool = false

    /// 对已配置的 baseDirectoryURL 开启 security-scoped 访问（如已开启则不重复开启）
    @discardableResult
    func startAccessIfPossible() -> Bool {
        guard let base = baseDirectoryURL else { return false }
        if hasActiveSecurityScope { return true }
        hasActiveSecurityScope = base.startAccessingSecurityScopedResource()
        return hasActiveSecurityScope
    }

    func stopAccessIfNeeded() {
        guard hasActiveSecurityScope, let base = baseDirectoryURL else { return }
        base.stopAccessingSecurityScopedResource()
        hasActiveSecurityScope = false
    }

    func withSecurityScopedAccess<T>(_ url: URL, _ work: () throws -> T) rethrows -> T {
        let didStart = url.startAccessingSecurityScopedResource()
        defer {
            if didStart { url.stopAccessingSecurityScopedResource() }
        }
        return try work()
    }

    // MARK: - Paths

    func reminderDataDirectoryURL() throws -> URL {
        guard let base = baseDirectoryURL else {
            throw NSError(domain: "StorageLocationManager", code: 2, userInfo: [NSLocalizedDescriptionKey: l10n(L10nKeys.Error.storageNotConfigured)])
        }
        return base.appendingPathComponent("ReminderData", isDirectory: true)
    }

    func databaseDirectoryURL() throws -> URL {
        try reminderDataDirectoryURL().appendingPathComponent("Database", isDirectory: true)
    }

    func attachmentsDirectoryURL() throws -> URL {
        try reminderDataDirectoryURL().appendingPathComponent("Attachments", isDirectory: true)
    }

    func ensureDirectoryStructureExists() throws {
        guard let base = baseDirectoryURL else { return }

        // 关键：需要在已开启 security scope 的情况下创建子目录
        // 如果外部没调用 startAccessIfPossible，这里兜底开启一次临时访问。
        let didTempStart: Bool
        if hasActiveSecurityScope {
            didTempStart = false
        } else {
            didTempStart = base.startAccessingSecurityScopedResource()
        }
        defer {
            if didTempStart {
                base.stopAccessingSecurityScopedResource()
            }
        }

        let fm = FileManager.default
        let reminder = try reminderDataDirectoryURL()
        let db = try databaseDirectoryURL()
        let att = try attachmentsDirectoryURL()

        try fm.createDirectory(at: reminder, withIntermediateDirectories: true)
        try fm.createDirectory(at: db, withIntermediateDirectories: true)
        try fm.createDirectory(at: att, withIntermediateDirectories: true)
    }

    // MARK: - Bookmark

    private func persistBookmark(for url: URL) throws {
        let data = try url.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        UserDefaults.standard.set(data, forKey: bookmarkKey)
    }

    private func resolveBaseDirectoryURL() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
        var isStale = false
        do {
            let url = try URL(
                resolvingBookmarkData: data,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            if isStale {
                try? persistBookmark(for: url)
            }
            return url
        } catch {
            return nil
        }
    }
}
