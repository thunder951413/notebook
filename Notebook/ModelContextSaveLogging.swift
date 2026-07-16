import Foundation
import SwiftData

/// 安全保存扩展：把"静默吞错"的 `try? context.save()` 升级为可追踪的失败日志。
///
/// 设计目标：
/// - **零变更语义**：仍然不抛错（保留 `try?` 的语义），上层逻辑无需重写
/// - **可追踪**：失败时记录到 `Logger`，并标注调用位置（文件/行号/原因）便于排查
/// - **批量迁移友好**：旧调用 `try? context.save()` → 新调用 `context.saveLogging("某场景")`
///
/// ## 使用方式
/// ```swift
/// // 旧
/// try? context.save()
/// // 新
/// context.saveLogging("\\(Self.self).deleteFolder")
/// ```
///
/// ## 与 `Logger` 的关系
/// 失败会在 `Logger.shared`（模块 `.storage`，级别 `.error`）落一条带 `context` 的记录。
/// 文件持久化开启时，日志会同步进入磁盘文件，便于事后导出排查。
extension ModelContext {
    /// 等价于 `try? save()`，但失败时落 ERROR 日志，并附带可识别的调用上下文。
    /// - Parameters:
    ///   - context: 业务侧自定义的调用场景描述，建议形如 `"NoteStore.deleteFolder"`
    ///   - file: 自动捕获调用文件名（默认 `#fileID`）
    ///   - line: 自动捕获调用行号（默认 `#line`）
    /// - Returns: 是否保存成功
    @discardableResult
    func saveLogging(
        _ context: @autoclosure () -> String = "",
        file: StaticString = #fileID,
        line: UInt = #line
    ) -> Bool {
        do {
            try save()
            return true
        } catch {
            rollback()
            let scope = context()
            let fileName = "\(file)".split(separator: "/").last.map(String.init) ?? "\(file)"
            let prefix = scope.isEmpty ? "" : "[\(scope)] "
            Logger.shared.log(
                .storage,
                .error,
                "\(prefix)context.save() 失败 @\(fileName):\(line): \(error.localizedDescription)"
            )
            return false
        }
    }
}
