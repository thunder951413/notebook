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

    enum FileRetentionMode {
        case todayOnly
        case keepAllByDay
    }

    private enum Keys {
        static let isFileLoggingEnabled = "logger.file_logging_enabled"
        static let keepHistoricalLogFiles = "logger.keep_historical_files"
    }

    private let queue = DispatchQueue(label: "com.notebook.logger", qos: .utility)
    private var entries: [LogEntry] = []
    private let maxEntries = 5000
    private let fileManager = FileManager.default
    private let logsDirectoryURL = Logger.makeLogsDirectoryURL()
    private let lineTimestampFormatter = ISO8601DateFormatter()
    private let fileDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
    private var isFileLoggingEnabled = false
    private var retentionMode: FileRetentionMode = .todayOnly
    private var lastCleanupDayIdentifier: String?

    static var fileLoggingDefaultsKey: String { Keys.isFileLoggingEnabled }
    static var keepHistoricalLogFilesDefaultsKey: String { Keys.keepHistoricalLogFiles }

    static var logsDirectoryPath: String {
        makeLogsDirectoryURL().path
    }

    static func ensureLogsDirectoryExists() throws {
        let url = makeLogsDirectoryURL()
        if !FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
    }

    private init() {
        reloadPersistenceSettings()
    }

    func log(_ module: LogModule, _ level: LogLevel = .info, _ message: String) {
        let entry = LogEntry(timestamp: Date(), module: module, level: level, message: message)
        queue.async {
            self.entries.append(entry)
            if self.entries.count > self.maxEntries {
                self.entries.removeFirst(self.entries.count - self.maxEntries)
            }

            self.persistEntryIfNeeded(entry)
        }
    }

    func reloadPersistenceSettings() {
        queue.async {
            let defaults = UserDefaults.standard
            self.isFileLoggingEnabled = defaults.bool(forKey: Keys.isFileLoggingEnabled)
            self.retentionMode = defaults.bool(forKey: Keys.keepHistoricalLogFiles) ? .keepAllByDay : .todayOnly

            guard self.isFileLoggingEnabled else { return }

            do {
                try self.prepareLogsDirectoryIfNeeded()
                try self.cleanupLogFilesIfNeeded(referenceDate: Date(), force: true)
            } catch {
                self.writeInternalError("刷新日志文件设置失败: \(error.localizedDescription)")
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

    private func persistEntryIfNeeded(_ entry: LogEntry) {
        guard isFileLoggingEnabled else { return }

        do {
            try prepareLogsDirectoryIfNeeded()
            try cleanupLogFilesIfNeeded(referenceDate: entry.timestamp, force: false)

            let fileURL = logFileURL(for: entry.timestamp)
            let line = formattedLine(for: entry) + "\n"
            let data = Data(line.utf8)

            if !fileManager.fileExists(atPath: fileURL.path) {
                try data.write(to: fileURL, options: .atomic)
                return
            }

            let handle = try FileHandle(forWritingTo: fileURL)
            defer {
                try? handle.close()
            }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            writeInternalError("写入日志文件失败: \(error.localizedDescription)")
        }
    }

    private func formattedLine(for entry: LogEntry) -> String {
        let time = lineTimestampFormatter.string(from: entry.timestamp)
        return "[\(time)] [\(entry.level.rawValue)] [\(entry.module.rawValue)] \(entry.message)"
    }

    private func logFileURL(for date: Date) -> URL {
        let day = fileDayFormatter.string(from: date)
        return logsDirectoryURL.appendingPathComponent("Notebook-\(day).log")
    }

    private func prepareLogsDirectoryIfNeeded() throws {
        if !fileManager.fileExists(atPath: logsDirectoryURL.path) {
            try fileManager.createDirectory(at: logsDirectoryURL, withIntermediateDirectories: true)
        }
    }

    private func cleanupLogFilesIfNeeded(referenceDate: Date, force: Bool) throws {
        let dayIdentifier = fileDayFormatter.string(from: referenceDate)
        guard force || lastCleanupDayIdentifier != dayIdentifier else { return }

        defer {
            lastCleanupDayIdentifier = dayIdentifier
        }

        guard retentionMode == .todayOnly else { return }

        let expectedFileName = "Notebook-\(dayIdentifier).log"
        let urls = try fileManager.contentsOfDirectory(
            at: logsDirectoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )

        for url in urls where url.pathExtension == "log" && url.lastPathComponent != expectedFileName {
            try fileManager.removeItem(at: url)
        }
    }

    private func writeInternalError(_ message: String) {
        fputs("[Logger] \(message)\n", stderr)
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

    private static func makeLogsDirectoryURL() -> URL {
        let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "Notebook"
        return baseURL
            .appendingPathComponent(bundleIdentifier, isDirectory: true)
            .appendingPathComponent("Logs", isDirectory: true)
    }
}
