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
}
