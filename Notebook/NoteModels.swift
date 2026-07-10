import SwiftUI
import AppKit

enum FolderType: String, Codable, Hashable {
    case noteFolder
    case todoList
}

struct Folder: Identifiable, Hashable {
    let id: UUID
    var name: String
    var sortOrder: Int
    var createdAt: Date
    var isSystem: Bool
    var folderType: FolderType = .noteFolder
}

struct Tag: Identifiable, Hashable {
    let id: UUID
    var name: String
    var color: String
    var sortOrder: Int
    var createdAt: Date
    
    init(id: UUID = UUID(), name: String, color: String = "gray", sortOrder: Int = 0, createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.color = color
        self.sortOrder = sortOrder
        self.createdAt = createdAt
    }
    
    var swiftUIColor: Color {
        switch color {
        case "red": return .red
        case "orange": return .orange
        case "yellow": return .yellow
        case "green": return .green
        case "blue": return .blue
        case "purple": return .purple
        default: return .gray
        }
    }
}

enum NoteViewMode: String, Codable, CaseIterable {
    case text = "text"
    case preview = "preview"
    case split = "split"

    var displayName: String {
        switch self {
        case .text: return "文本编辑"
        case .preview: return "Markdown 预览"
        case .split: return "分屏预览"
        }
    }

    var icon: String {
        switch self {
        case .text: return "doc.plaintext"
        case .preview: return "doc.text.image"
        case .split: return "rectangle.split.2x1"
        }
    }
}

// MARK: - 目录项

struct TableOfContentsItem: Identifiable {
    let id = UUID()
    let level: Int
    let title: String
    let anchor: String
}

/// 从 Markdown 内容中提取目录
func extractTableOfContents(from content: String) -> [TableOfContentsItem] {
    var items: [TableOfContentsItem] = []
    let lines = content.components(separatedBy: .newlines)

    // 正则表达式匹配标题
    let headingPattern = "^(#{1,6})\\s+(.+)$"
    guard let regex = try? NSRegularExpression(pattern: headingPattern, options: [.anchorsMatchLines]) else {
        return items
    }

    for line in lines {
        let range = NSRange(line.startIndex..., in: line)
        if let match = regex.firstMatch(in: line, options: [], range: range) {
            let levelRange = match.range(at: 1)
            let titleRange = match.range(at: 2)

            if let levelSwiftRange = Range(levelRange, in: line),
               let titleSwiftRange = Range(titleRange, in: line) {
                let level = line[levelSwiftRange].count
                let title = String(line[titleSwiftRange]).trimmingCharacters(in: .whitespaces)
                let anchor = "heading-\(items.count)"
                items.append(TableOfContentsItem(level: level, title: title, anchor: anchor))
            }
        }
    }

    return items
}

struct Note: Identifiable, Hashable {
    let id: UUID
    var title: String
    var content: NSAttributedString
    var contentPreview: String
    var isContentLoaded: Bool
    var createdAt: Date
    var updatedAt: Date
    
    /// 文件夹ID（用于关联，优先使用）
    var folderID: UUID?
    
    /// 文件夹名称（用于显示，不用于关联）
    var folder: String
    
    var reminderAt: Date?
    var recurrenceRule: String
    var version: Int64
    var tagIDs: [UUID]
    var viewMode: NoteViewMode

    /// 回收站：删除时间（非空表示在回收站）
    var deletedAt: Date?
    /// 原始文件夹ID（用于恢复）
    var originalFolderID: UUID?
    /// 原始文件夹名称（用于恢复）
    var originalFolderName: String?

    /// 同步冲突标记
    var hasConflict: Bool

    var hasReminder: Bool {
        return reminderAt != nil
    }

    var isInRecycleBin: Bool {
        return deletedAt != nil
    }

    init(
        id: UUID = UUID(),
        title: String,
        content: NSAttributedString,
        contentPreview: String? = nil,
        isContentLoaded: Bool = true,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        folderID: UUID? = nil,
        folder: String = "未分类",
        reminderAt: Date? = nil,
        recurrenceRule: String = "none",
        version: Int64 = 0,
        tagIDs: [UUID] = [],
        viewMode: NoteViewMode = .text,
        deletedAt: Date? = nil,
        originalFolderID: UUID? = nil,
        originalFolderName: String? = nil,
        hasConflict: Bool = false
    ) {
        self.id = id
        self.title = title
        self.content = content
        self.contentPreview = contentPreview ?? Note.previewText(from: content.string)
        self.isContentLoaded = isContentLoaded
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.folderID = folderID
        self.folder = folder
        self.reminderAt = reminderAt
        self.recurrenceRule = recurrenceRule
        self.version = version
        self.tagIDs = tagIDs
        self.viewMode = viewMode
        self.deletedAt = deletedAt
        self.originalFolderID = originalFolderID
        self.originalFolderName = originalFolderName
        self.hasConflict = hasConflict
    }
    
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
    
    static func == (lhs: Note, rhs: Note) -> Bool {
        lhs.id == rhs.id
    }

    private static func previewText(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.components(separatedBy: .newlines)
        return lines.prefix(2).joined(separator: " ")
    }
}

struct TodoList: Identifiable, Hashable {
    let id: UUID
    var name: String
    var sortOrder: Int
    var createdAt: Date
    var isSystem: Bool
}

struct TodoItem: Identifiable, Hashable {
    let id: UUID
    var title: String
    var contentPreview: String
    var createdAt: Date
    var updatedAt: Date
    var folderID: UUID?
    var reminderAt: Date?
    var recurrenceRule: String
    var dueAt: Date?
    var completedAt: Date?
    var isImportant: Bool
    var order: Int
    var linkedNoteIDs: [UUID]
    var deletedAt: Date?

    var isCompleted: Bool {
        completedAt != nil
    }

    var isInRecycleBin: Bool {
        deletedAt != nil
    }
}
