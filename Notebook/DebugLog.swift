import Foundation

/// 轻量级桥接，将分散在项目里的 `print(...)` 调试日志逐步迁移到统一的 `Logger`。
///
/// 设计目标：
/// - **零侵入**：调用点改动小（仅替换函数名，参数语义相近）
/// - **Release 静默**：仅 `#if DEBUG` 时落到标准输出，Release 构建自动剔除控制台输出
/// - **统一出口**：所有桥接调用同时进入 `Logger` 的环形缓冲与可选文件持久化，便于事后导出排查
///
/// ## 使用方式
/// ```swift
/// // 旧
/// print("[RichTextEditor] paste handled")
/// // 新
/// DebugLog.editor("paste handled")
/// ```
///
/// 文件级 print 集中迁移时，可直接做如下机械替换（按模块）：
/// - RichTextEditor / RichTextView 相关 → `DebugLog.editor(...)`
/// - ContentView / 应用主流程 → `DebugLog.app(...)`
/// - 同步 / 存储相关 → `DebugLog.storage(...)`
/// - 附件 / 表格 → `DebugLog.attachment(...)`
nonisolated enum DebugLog {
    @inline(__always)
    static func log(_ module: LogModule, _ level: LogLevel = .debug, _ message: @autoclosure () -> String) {
        let text = message()
        Logger.shared.log(module, level, text)
        #if DEBUG
        print("[\(module.rawValue)] \(text)")
        #endif
    }

    @inline(__always)
    static func app(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.app, level, message())
    }

    @inline(__always)
    static func editor(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.editor, level, message())
    }

    @inline(__always)
    static func storage(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.storage, level, message())
    }

    @inline(__always)
    static func attachment(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.attachment, level, message())
    }

    @inline(__always)
    static func table(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.table, level, message())
    }

    @inline(__always)
    static func save(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.save, level, message())
    }

    @inline(__always)
    static func search(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.search, level, message())
    }

    @inline(__always)
    static func encryption(_ message: @autoclosure () -> String, level: LogLevel = .debug) {
        log(.encryption, level, message())
    }
}
