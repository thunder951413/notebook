import Foundation

/// 应用偏好统一入口。
///
/// XCTest 会以 Notebook.app 作为宿主，因此直接使用 `NotebookDefaults.shared` 会写入
/// 真实的 `yy.Notebook` 偏好域。测试进程改用按进程隔离的 suite，生产运行仍保持
/// 原有 standard domain，既不迁移也不清空用户现有设置。
nonisolated enum NotebookDefaults {
    /// UserDefaults 自身支持并发读取/写入；unsafe 仅用于表达 Foundation 尚未声明 Sendable。
    nonisolated(unsafe) static let shared: UserDefaults = {
        let environment = ProcessInfo.processInfo.environment
        let isTestProcess = environment["XCTestConfigurationFilePath"] != nil
            || environment["NOTEBOOK_UI_TEST_DATA_DIR"] != nil

        guard isTestProcess else {
            return .standard
        }

        let suiteName = environment["NOTEBOOK_TEST_DEFAULTS_SUITE"]
            ?? "yy.Notebook.tests.\(ProcessInfo.processInfo.processIdentifier)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            preconditionFailure("无法创建测试专用 UserDefaults suite: \(suiteName)")
        }
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }()
}
