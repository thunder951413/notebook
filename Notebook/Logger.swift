import Foundation

enum LogModule: String, Codable {
    case search = "Search"
    case save = "Save"
    case storage = "Storage"
    case attachment = "Attachment"
    case table = "Table"
    case editor = "Editor"
    case app = "App"
    case encryption = "Encryption"
}

enum LogLevel: String, Codable {
    case debug = "DEBUG"
    case info = "INFO"
    case warn = "WARN"
    case error = "ERROR"
}

struct LogEntry: Codable {
    let timestamp: Date
    let module: LogModule
    let level: LogLevel
    let message: String
}

struct LogInterval {
    private let module: LogModule
    private let level: LogLevel
    private let name: String
    private let metadata: String
    private let startedAt: DispatchTime

    fileprivate init(module: LogModule, level: LogLevel, name: String, metadata: String) {
        self.module = module
        self.level = level
        self.name = name
        self.metadata = metadata
        self.startedAt = .now()
    }

    func end(_ level: LogLevel? = nil, _ metadata: String = "") {
        let elapsedNanoseconds = DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds
        let elapsedMilliseconds = Double(elapsedNanoseconds) / 1_000_000
        let mergedMetadata = Logger.mergeMetadata(metadata, with: self.metadata)
        let message = mergedMetadata.isEmpty
            ? "\(name) finished in \(String(format: "%.2f", elapsedMilliseconds))ms"
            : "\(name) finished in \(String(format: "%.2f", elapsedMilliseconds))ms | \(mergedMetadata)"
        Logger.shared.log(module, level ?? self.level, message)
    }
}

final class Logger {
    static let shared = Logger()

    private let queue = DispatchQueue(label: "com.notebook.logger", qos: .utility)
    private var entries: [LogEntry] = []
    private let maxEntries = 5000

    private init() {}

    func log(_ module: LogModule, _ level: LogLevel = .info, _ message: String) {
        let entry = LogEntry(timestamp: Date(), module: module, level: level, message: message)
        queue.async {
            self.entries.append(entry)
            if self.entries.count > self.maxEntries {
                self.entries.removeFirst(self.entries.count - self.maxEntries)
            }
        }
    }

    func beginInterval(_ module: LogModule, _ name: String, level: LogLevel = .debug, metadata: String = "") -> LogInterval {
        let message = metadata.isEmpty ? "\(name) started" : "\(name) started | \(metadata)"
        log(module, level, message)
        return LogInterval(module: module, level: level, name: name, metadata: metadata)
    }

    func exportLogs(module: LogModule? = nil) -> String {
        var snapshot: [LogEntry] = []
        queue.sync {
            snapshot = self.entries
        }
        if let module {
            snapshot = snapshot.filter { $0.module == module }
        }
        let formatter = ISO8601DateFormatter()
        return snapshot.map { entry in
            let time = formatter.string(from: entry.timestamp)
            return "[\(time)] [\(entry.level.rawValue)] [\(entry.module.rawValue)] \(entry.message)"
        }.joined(separator: "\n")
    }

    func exportLogsGroupedByModule() -> String {
        var snapshot: [LogEntry] = []
        queue.sync {
            snapshot = self.entries
        }
        let formatter = ISO8601DateFormatter()
        let grouped = Dictionary(grouping: snapshot, by: \LogEntry.module)
        let modules = grouped.keys.sorted { $0.rawValue < $1.rawValue }
        return modules.map { module in
            let entries = grouped[module, default: []]
            let lines = entries.map { entry in
                let time = formatter.string(from: entry.timestamp)
                return "[\(time)] [\(entry.level.rawValue)] [\(entry.module.rawValue)] \(entry.message)"
            }
            return "## \(module.rawValue)\n" + lines.joined(separator: "\n")
        }.joined(separator: "\n\n")
    }

    func clear() {
        queue.async {
            self.entries.removeAll()
        }
    }

    fileprivate static func mergeMetadata(_ lhs: String, with rhs: String) -> String {
        switch (lhs.isEmpty, rhs.isEmpty) {
        case (true, true):
            return ""
        case (false, true):
            return lhs
        case (true, false):
            return rhs
        case (false, false):
            return "\(rhs) | \(lhs)"
        }
    }
}
