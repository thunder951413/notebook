import SwiftUI
import SwiftData
import Combine

/// 颜色系统：支持浅色/深色并随系统自动切换（默认）。
struct AppColors {
    static func sidebarBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 30/255, green: 30/255, blue: 30/255) : Color(red: 247/255, green: 245/255, blue: 240/255)
    }
    static func listBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 40/255, green: 40/255, blue: 40/255) : Color(red: 250/255, green: 248/255, blue: 244/255)
    }
    static func editorBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 45/255, green: 45/255, blue: 45/255) : Color(red: 252/255, green: 250/255, blue: 246/255)
    }
    static func cardBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.22) : Color.white.opacity(0.86)
    }
    static func cardBorder(_ scheme: ColorScheme, isSelected: Bool) -> Color {
        isSelected ? accentYellow.opacity(0.9) : (scheme == .dark ? .white.opacity(0.06) : .black.opacity(0.06))
    }
    static func selectedFill(_ scheme: ColorScheme) -> Color {
        accentYellow.opacity(scheme == .dark ? 0.12 : 0.18)
    }
    static func textSecondary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.65) : Color.black.opacity(0.55)
    }
    static let accentYellow = Color(red: 243/255, green: 186/255, blue: 0/255)
    static func divider(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.08)
    }
    static func topBarBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.black.opacity(0.15) : Color.white.opacity(0.70)
    }
    static func shadowColor(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .black.opacity(0.35) : .black.opacity(0.10)
    }
}

@MainActor
class NoteStore: ObservableObject {
    private var modelContext: ModelContext?
    @Published var notes: [Note] = []
    @Published var folders: [String] = []
    @Published var selectedNoteId: UUID?

    func setContext(_ context: ModelContext) {
        self.modelContext = context
        bootstrapIfNeeded()
        fetchData()
    }

    private func bootstrapIfNeeded() {
        guard let context = modelContext else { return }
        let descriptor = FetchDescriptor<NoteEntity>()
        let count = (try? context.fetchCount(descriptor)) ?? 0
        if count == 0 {
            let welcome = NSAttributedString(string: "欢迎使用！\n\n• 菜单栏图标可以快速新建\n• 右侧支持富文本编辑\n\n现在开始写点什么吧。")
            let rtfd = try? welcome.data(from: NSRange(location: 0, length: welcome.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd])
            let entity = NoteEntity(title: "欢迎", folderName: "未分类", rtfdData: rtfd)
            context.insert(entity)
            try? context.save()
        }

        let folderDescriptor = FetchDescriptor<FolderEntity>()
        let folderCount = (try? context.fetchCount(folderDescriptor)) ?? 0
        if folderCount == 0 {
            ["未分类", "我的文件夹", "旅游", "全局收藏", "个人", "生活", "工作"].forEach { name in
                context.insert(FolderEntity(name: name))
            }
            try? context.save()
        }
    }

    func fetchData() {
        guard let context = modelContext else { return }

        // 1. 先清理一次性且已过期的提醒
        cleanupExpiredOneTimeReminders(context: context)

        let descriptor = FetchDescriptor<NoteEntity>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)])
        do {
            let entities = try context.fetch(descriptor)

            // 先做一次“自愈”：遇到损坏的 RTFD 直接清空并回写数据库
            for entity in entities {
                guard let data = entity.rtfdData else { continue }
                do {
                    // 使用更具体的 options 尝试解码
                    let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
                        .documentType: NSAttributedString.DocumentType.rtfd
                    ]
                    _ = try NSAttributedString(
                        data: data,
                        options: options,
                        documentAttributes: nil
                    )
                } catch {
                    print("[SelfHeal] Broken RTFD detected for note id=\(entity.id), title=\(entity.title). Resetting content. Error: \(error)")
                    entity.rtfdData = nil
                    entity.updatedAt = Date()
                }
            }
            try? context.save()

            // 映射到内存模型
            self.notes = entities.map { entity in
                let content: NSAttributedString
                if let data = entity.rtfdData {
                    do {
                        let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
                            .documentType: NSAttributedString.DocumentType.rtfd
                        ]
                        content = try NSAttributedString(
                            data: data,
                            options: options,
                            documentAttributes: nil
                        )
                    } catch {
                        print("[Fetch] Failed to decode RTFD for id=\(entity.id), error: \(error)")
                        content = NSAttributedString(string: "")
                    }
                } else {
                    content = NSAttributedString(string: "")
                }

                return Note(
                    id: entity.id,
                    title: entity.title,
                    content: content,
                    createdAt: entity.createdAt,
                    folder: entity.folderName,
                    reminderAt: entity.reminderAt,
                    recurrenceRule: entity.recurrenceRule ?? "none"
                )
            }

            let folderDescriptor = FetchDescriptor<FolderEntity>()
            let folderEntities = try context.fetch(folderDescriptor)
            self.folders = ["未分类", "我的文件夹", "旅游", "全局收藏", "个人", "生活", "工作"]
            let dbFolders = folderEntities.map { $0.name }
            for f in dbFolders where !self.folders.contains(f) {
                self.folders.append(f)
            }
        } catch {
            print("Fetch failed: \(error)")
        }
    }

    private func cleanupExpiredOneTimeReminders(context: ModelContext) {
        let now = Date()
        // 简化谓词逻辑，只获取有提醒的笔记
        let descriptor = FetchDescriptor<NoteEntity>(
            predicate: #Predicate<NoteEntity> { $0.reminderAt != nil }
        )

        if let entities = try? context.fetch(descriptor) {
            var changed = false
            for entity in entities {
                // 在内存中检查是否为一次性提醒且已过期
                let isOneTime = entity.recurrenceRule == nil || entity.recurrenceRule == "none"
                if isOneTime, let date = entity.reminderAt, date < now {
                    entity.reminderAt = nil
                    changed = true
                }
            }
            if changed {
                try? context.save()
            }
        }
    }

    func addNote(title: String, folder: String = "未分类") {
        guard let context = modelContext else { return }
        let entity = NoteEntity(title: title, folderName: folder)
        context.insert(entity)
        try? context.save()
        fetchData()
    }

    func addFolder(name: String) {
        guard let context = modelContext else { return }
        let entity = FolderEntity(name: name)
        context.insert(entity)
        try? context.save()
        fetchData()
    }

    func updateNote(_ note: Note) {
        guard let context = modelContext else { 
            print("[Save] modelContext is nil, skip save for id=\(note.id)")
            return 
        }
        let id = note.id
        let descriptor = FetchDescriptor<NoteEntity>(
            predicate: #Predicate<NoteEntity> { $0.id == id }
        )

        do {
            guard let entity = try context.fetch(descriptor).first else { 
                print("[Save] entity not found for id=\(note.id), title=\(note.title)")
                return 
            }
            
            print("[Save] updating entity id=\(entity.id), title=\(note.title)")

            entity.title = note.title
            entity.updatedAt = Date()
            entity.folderName = note.folder

            // 关键修复：在序列化前，确保我们在主线程获取内容的快照
            // 序列化前进行属性清洗，移除可能导致损坏的临时系统属性
            let contentSnapshot = note.content.copy() as! NSAttributedString
            let cleanedContent = contentSnapshot.cleanedForStorage()
            
            do {
                // 使用快照进行序列化，避免在序列化过程中底层数据发生变化
                let data = try cleanedContent.data(
                    from: NSRange(location: 0, length: cleanedContent.length),
                    documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
                )
                entity.rtfdData = data
            } catch {
                print("[Save] Failed to serialize RTFD for note id=\(note.id), title=\(note.title). Error: \(error)")
            }

            entity.reminderAt = note.reminderAt
            entity.recurrenceRule = note.recurrenceRule

            try context.save()
            print("[Save] context.save() success for id=\(note.id)")

            if let idx = notes.firstIndex(where: { $0.id == note.id }) {
                notes[idx] = note
            }
        } catch {
            print("[Save] Update failed for note id=\(note.id), title=\(note.title). Error: \(error)")
        }
    }

    func deleteNote(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<NoteEntity>(
            predicate: #Predicate<NoteEntity> { $0.id == idToMatch }
        )

        if let entity = try? context.fetch(descriptor).first {
            AttachmentManager.shared.deleteAttachments(for: id)
            context.delete(entity)
            try? context.save()
            fetchData()
        }
    }

    func moveNote(id: UUID, toFolder: String) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<NoteEntity>(
            predicate: #Predicate<NoteEntity> { $0.id == idToMatch }
        )

        if let entity = try? context.fetch(descriptor).first {
            entity.folderName = toFolder
            entity.updatedAt = Date()
            try? context.save()
            fetchData()
        }
    }
}

extension NSAttributedString {
    /// 清洗属性，只保留必要的富文本样式，移除可能导致序列化损坏的系统临时属性
    func cleanedForStorage() -> NSAttributedString {
        let range = NSRange(location: 0, length: self.length)
        let mutable = NSMutableAttributedString(attributedString: self)
        
        // 允许保留的属性列表
        let allowedKeys: [NSAttributedString.Key] = [
            .font,
            .foregroundColor,
            .backgroundColor,
            .underlineStyle,
            .underlineColor,
            .strikethroughStyle,
            .paragraphStyle,
            .attachment,
            .link,
            .kern,
            .baselineOffset
        ]
        
        mutable.enumerateAttributes(in: range, options: []) { attributes, subRange, _ in
            for key in attributes.keys {
                if !allowedKeys.contains(key) {
                    mutable.removeAttribute(key, range: subRange)
                }
            }
        }
        
        return NSAttributedString(attributedString: mutable)
    }
}

struct Note: Identifiable, Hashable {
    let id: UUID
    var title: String
    var content: NSAttributedString
    var createdAt: Date
    var folder: String
    var reminderAt: Date?
    var recurrenceRule: String
    var tags: [String] = []

    init(
        id: UUID = UUID(),
        title: String,
        content: NSAttributedString,
        createdAt: Date = Date(),
        folder: String = "未分类",
        reminderAt: Date? = nil,
        recurrenceRule: String = "none"
    ) {
        self.id = id
        self.title = title
        self.content = content
        self.createdAt = createdAt
        self.folder = folder
        self.reminderAt = reminderAt
        self.recurrenceRule = recurrenceRule
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: Note, rhs: Note) -> Bool {
        lhs.id == rhs.id
    }
}
