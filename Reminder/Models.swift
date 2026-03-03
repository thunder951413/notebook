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
}

struct Folder: Identifiable, Hashable {
    let id: UUID
    var name: String
    var sortOrder: Int
    var createdAt: Date
    var isSystem: Bool
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

@MainActor
class NoteStore: ObservableObject {
    @Published var notes: [Note] = []
    @Published var folders: [Folder] = []
    @Published var tags: [Tag] = []
    
    /// 用于菜单栏 Popover 跳转的选中笔记 ID
    @Published var selectedNoteId: UUID?
    /// 用于菜单栏 Popover 跳转的选中文件夹
    @Published var selectedFolderForNavigation: String?
    
    private var modelContext: ModelContext?
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        // 延迟初始化，等 SwiftData 注入后再 fetch
        DispatchQueue.main.async { [weak self] in
            self?.setupModelContext()
        }
    }

    /// 从外部设置 ModelContext（用于 AppDelegate 注入）
    func setContext(_ context: ModelContext) {
        self.modelContext = context
        fetchData()
    }

    private func setupModelContext() {
        // 从 PersistenceController 获取 ModelContext
        if let container = try? ModelContainer(for: NoteEntity.self, FolderEntity.self, TagEntity.self) {
            self.modelContext = ModelContext(container)
            fetchData()
        }
    }
    
    func fetchData() {
        guard let context = modelContext else {
            print("NoteStore: modelContext is nil, skipping fetch")
            return
        }
        
        do {
            // 清理过期的一次性提醒
            cleanupExpiredOneTimeReminders(context: context)
            
            let descriptor = FetchDescriptor<NoteEntity>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)])
            let entities = try context.fetch(descriptor)
            
            // 清理孤立附件
            let allNoteIDs = entities.map { $0.id }
            AttachmentManager.shared.cleanupOrphanedAttachments(allNoteIDs: allNoteIDs)
            
            // 先做一次"自愈"：遇到损坏的 RTFD 直接清空并回写数据库
            for entity in entities {
                guard let data = entity.rtfdData else { continue }
                do {
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
                
                let tagIDArray = entity.tagIDs?.split(separator: ",").compactMap { UUID(uuidString: String($0)) } ?? []
                
                // 修复复选框附件
                let fixedContent = Self.fixCheckboxAttachments(in: content)
                
                // 解析 viewMode，默认为 text
                let viewMode = NoteViewMode(rawValue: entity.viewMode ?? "text") ?? .text
                
                return Note(
                    id: entity.id,
                    title: entity.title,
                    content: fixedContent,
                    createdAt: entity.createdAt,
                    folder: entity.folderName,
                    reminderAt: entity.reminderAt,
                    recurrenceRule: entity.recurrenceRule ?? "none",
                    version: entity.version,
                    tagIDs: tagIDArray,
                    viewMode: viewMode
                )
            }
            
            let folderDescriptor = FetchDescriptor<FolderEntity>(sortBy: [SortDescriptor(\.sortOrder)])
            let folderEntities = try context.fetch(folderDescriptor)
            self.folders = folderEntities.map { Folder(id: $0.id, name: $0.name, sortOrder: $0.sortOrder ?? 0, createdAt: $0.createdAt ?? Date(), isSystem: $0.isSystem ?? false) }
            
            let tagDescriptor = FetchDescriptor<TagEntity>(sortBy: [SortDescriptor(\.sortOrder)])
            let tagEntities = try context.fetch(tagDescriptor)
            self.tags = tagEntities.map { Tag(id: $0.id, name: $0.name, color: $0.color, sortOrder: $0.sortOrder, createdAt: $0.createdAt) }
        } catch {
            print("Fetch failed: \(error)")
        }
    }
    
    private func cleanupExpiredOneTimeReminders(context: ModelContext) {
        let now = Date()
        let descriptor = FetchDescriptor<NoteEntity>(
            predicate: #Predicate<NoteEntity> { $0.reminderAt != nil }
        )
        
        do {
            let entities = try context.fetch(descriptor)
            var changed = false
            for entity in entities {
                let isOneTime = entity.recurrenceRule == nil || entity.recurrenceRule == "none"
                if isOneTime, let date = entity.reminderAt, date < now {
                    entity.reminderAt = nil
                    changed = true
                }
            }
            if changed {
                try? context.save()
            }
        } catch {
            print("Cleanup expired reminders failed: \(error)")
        }
    }
    
    /// 修复复选框附件
    private static func fixCheckboxAttachments(in attributedString: NSAttributedString) -> NSAttributedString {
        let mutable = NSMutableAttributedString(attributedString: attributedString)
        let range = NSRange(location: 0, length: mutable.length)
        var replacements: [(NSRange, CheckboxTextAttachment)] = []
        var debugInfo: [(Int, String, Bool)] = [] // (位置, 类型, 是否已选中)

        mutable.enumerateAttribute(.attachment, in: range, options: []) { value, attrRange, _ in
            guard let attachment = value as? NSTextAttachment else { return }

            let location = attrRange.location

            // 检查是否已经是 CheckboxTextAttachment
            if let checkbox = attachment as? CheckboxTextAttachment {
                debugInfo.append((location, "CheckboxTextAttachment", checkbox.isChecked))
                return // 已经是正确类型，不需要修复
            }

            // 尝试从 contents 恢复图像
            var image = attachment.image
            var imageSource = "attachment.image"

            if image == nil, let contents = attachment.contents {
                image = NSImage(data: contents)
                imageSource = "contents"
                print("[CheckboxDebug] Restored image from contents at pos=\(location), size=\(image?.size ?? .zero)")
            }

            // 如果仍然没有图像，尝试通过 fileWrapper 恢复
            if image == nil, let fileWrapper = attachment.fileWrapper {
                if let data = fileWrapper.regularFileContents {
                    image = NSImage(data: data)
                    imageSource = "fileWrapper"
                    print("[CheckboxDebug] Restored image from fileWrapper at pos=\(location), size=\(image?.size ?? .zero)")
                }
            }

            guard let finalImage = image else {
                debugInfo.append((location, "NSTextAttachment(no image)", false))
                return
            }

            // 检查图像大小是否是复选框大小 (约 14x14)
            let isCorrectImageSize = abs(finalImage.size.width - 14) < 5 && abs(finalImage.size.height - 14) < 5

            // 也检查 bounds 大小（如果 bounds 有效）
            let bounds = attachment.bounds
            let isCorrectBounds = bounds.width > 0 && bounds.height > 0 &&
                                 abs(bounds.width - 14) < 5 && abs(bounds.height - 14) < 5

            // 如果图像大小或 bounds 大小符合复选框特征
            if isCorrectImageSize || isCorrectBounds {
                // 尝试检测是否已选中：检查图像中心是否有填充色
                let isChecked = Self.detectIfCheckboxIsChecked(finalImage)
                debugInfo.append((location, "NSTextAttachment(checkbox, src:\(imageSource))", isChecked))

                let newAttachment = CheckboxTextAttachment(checked: isChecked)
                replacements.append((attrRange, newAttachment))
            } else {
                debugInfo.append((location, "NSTextAttachment(size: \(Int(finalImage.size.width))x\(Int(finalImage.size.height)), bounds: \(Int(bounds.width))x\(Int(bounds.height)))", false))
            }
        }
        
        // 打印调试信息
        if !debugInfo.isEmpty {
            print("[CheckboxDebug] Found \(debugInfo.count) attachments:")
            for (location, type, isChecked) in debugInfo {
                print("  [CheckboxDebug] pos=\(location), type=\(type), checked=\(isChecked)")
            }
            print("[CheckboxDebug] Replacing \(replacements.count) attachments")
        }
        
        for (replaceRange, newAttachment) in replacements.reversed() {
            mutable.removeAttribute(.attachment, range: replaceRange)
            mutable.addAttribute(.attachment, value: newAttachment, range: replaceRange)
        }
        
        return NSAttributedString(attributedString: mutable)
    }
    
    /// 检测图像是否表示已选中的复选框
    private static func detectIfCheckboxIsChecked(_ image: NSImage) -> Bool {
        let size = image.size
        guard size.width > 0 && size.height > 0 else { return false }
        
        // 策略：检查图像中心像素的颜色
        // 已选中的复选框中心有黄色/深色填充
        // 未选中的复选框中心是白色/透明
        
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            print("[CheckboxDebug] Failed to get CGImage")
            return false
        }
        
        // 创建位图上下文来读取像素
        let width = 1
        let height = 1
        let bytesPerPixel = 4
        let bytesPerRow = bytesPerPixel * width
        let bitsPerComponent = 8
        
        var pixelData = [UInt8](repeating: 0, count: bytesPerPixel)
        
        guard let context = CGContext(
            data: &pixelData,
            width: width,
            height: height,
            bitsPerComponent: bitsPerComponent,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            print("[CheckboxDebug] Failed to create CGContext")
            return false
        }
        
        // 绘制中心像素
        let centerX = size.width / 2
        let centerY = size.height / 2
        context.draw(cgImage, in: CGRect(x: -centerX, y: -centerY, width: size.width, height: size.height), byTiling: false)
        
        // 获取颜色分量
        let r = CGFloat(pixelData[0]) / 255.0
        let g = CGFloat(pixelData[1]) / 255.0
        let b = CGFloat(pixelData[2]) / 255.0
        let a = CGFloat(pixelData[3]) / 255.0
        
        print("[CheckboxDebug] Center pixel: R=\(String(format: "%.2f", r)), G=\(String(format: "%.2f", g)), B=\(String(format: "%.2f", b)), A=\(String(format: "%.2f", a))")
        
        // 判断逻辑：
        // - 已选中：中心有黄色（R高，G高，B低）或深色
        // - 未选中：中心是白色（R=G=B=1）或透明（A=0）
        
        // 如果透明度很低，认为是未选中
        if a < 0.5 {
            print("[CheckboxDebug] Low alpha, assuming unchecked")
            return false
        }
        
        // 计算亮度
        let brightness = (r + g + b) / 3.0
        print("[CheckboxDebug] Brightness: \(String(format: "%.2f", brightness))")
        
        // 如果亮度很高（接近白色），认为是未选中
        if brightness > 0.9 {
            print("[CheckboxDebug] High brightness, assuming unchecked")
            return false
        }
        
        // 检查是否是黄色（选中状态的特征）
        // 黄色：R和G都很高，B很低
        let isYellow = r > 0.7 && g > 0.7 && b < 0.5
        if isYellow {
            print("[CheckboxDebug] Yellow detected, assuming checked")
            return true
        }
        
        // 如果亮度中等偏低，可能是填充色（选中）
        if brightness < 0.7 {
            print("[CheckboxDebug] Medium brightness, assuming checked")
            return true
        }
        
        print("[CheckboxDebug] Uncertain, defaulting to unchecked")
        return false
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
        let maxSortOrder = (try? context.fetch(FetchDescriptor<FolderEntity>()).compactMap { $0.sortOrder }.max() ?? 0) ?? 0
        let entity = FolderEntity(name: name, sortOrder: maxSortOrder + 1)
        context.insert(entity)
        try? context.save()
        fetchData()
    }
    
    func updateFolder(id: UUID, name: String) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<FolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            entity.name = name
            try? context.save()
            fetchData()
        }
    }
    
    func deleteFolder(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<FolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            if entity.isSystem == true {
                print("Cannot delete system folder: \(entity.name)")
                return
            }
            let folderName = entity.name
            let notesInFolder = try? context.fetch(FetchDescriptor<NoteEntity>(predicate: #Predicate { $0.folderName == folderName }))
            for note in notesInFolder ?? [] {
                note.folderName = "未分类"
            }
            context.delete(entity)
            try? context.save()
            fetchData()
        }
    }
    
    func reorderFolders(fromOffsets: IndexSet, toOffset: Int) {
        guard let context = modelContext else { return }
        var reordered = folders
        reordered.move(fromOffsets: fromOffsets, toOffset: toOffset)
        for (index, folder) in reordered.enumerated() {
            let idToMatch = folder.id
            let descriptor = FetchDescriptor<FolderEntity>(predicate: #Predicate { $0.id == idToMatch })
            if let entity = try? context.fetch(descriptor).first {
                entity.sortOrder = index
            }
        }
        try? context.save()
        fetchData()
    }
    
    // MARK: - Tag Management
    
    func addTag(name: String, color: String) {
        guard let context = modelContext else { return }
        let maxSortOrder = tags.map { $0.sortOrder }.max() ?? 0
        let entity = TagEntity(name: name, color: color, sortOrder: maxSortOrder + 1)
        context.insert(entity)
        try? context.save()
        fetchData()
    }
    
    func updateTag(id: UUID, name: String? = nil, color: String? = nil) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<TagEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            if let name = name { entity.name = name }
            if let color = color { entity.color = color }
            try? context.save()
            fetchData()
        }
    }
    
    func deleteTag(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<TagEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            let notesWithTag = notes.filter { $0.tagIDs.contains(id) }
            for note in notesWithTag {
                removeTagFromNote(tagID: id, noteID: note.id)
            }
            context.delete(entity)
            try? context.save()
            fetchData()
        }
    }
    
    func reorderTags(fromOffsets: IndexSet, toOffset: Int) {
        guard let context = modelContext else { return }
        var reordered = tags
        reordered.move(fromOffsets: fromOffsets, toOffset: toOffset)
        for (index, tag) in reordered.enumerated() {
            let idToMatch = tag.id
            let descriptor = FetchDescriptor<TagEntity>(predicate: #Predicate { $0.id == idToMatch })
            if let entity = try? context.fetch(descriptor).first {
                entity.sortOrder = index
            }
        }
        try? context.save()
        fetchData()
    }
    
    // MARK: - Note Tag Operations
    
    func addTagToNote(tagID: UUID, noteID: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = noteID
        let descriptor = FetchDescriptor<NoteEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            var currentTagIDs = entity.tagIDs?.split(separator: ",").compactMap { UUID(uuidString: String($0)) } ?? []
            if !currentTagIDs.contains(tagID) {
                currentTagIDs.append(tagID)
                entity.tagIDs = currentTagIDs.map { $0.uuidString }.joined(separator: ",")
                try? context.save()
                fetchData()
            }
        }
    }
    
    func removeTagFromNote(tagID: UUID, noteID: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = noteID
        let descriptor = FetchDescriptor<NoteEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            var currentTagIDs = entity.tagIDs?.split(separator: ",").compactMap { UUID(uuidString: String($0)) } ?? []
            currentTagIDs.removeAll { $0 == tagID }
            entity.tagIDs = currentTagIDs.isEmpty ? nil : currentTagIDs.map { $0.uuidString }.joined(separator: ",")
            try? context.save()
            fetchData()
        }
    }
    
    // MARK: - Note Save Operations
    
    func saveNote(
        id: UUID,
        title: String,
        folder: String,
        reminderAt: Date?,
        recurrenceRule: String,
        rtfdData: Data,
        version: Int64,
        reason: String = "unknown"
    ) {
        guard let context = modelContext else {
            print("[Save] modelContext is nil, skip save for id=\(id)")
            return
        }
        
        Task {
            await MainActor.run {
                let idToMatch = id
                let descriptor = FetchDescriptor<NoteEntity>(
                    predicate: #Predicate<NoteEntity> { $0.id == idToMatch }
                )
                
                guard let entities = try? context.fetch(descriptor), let entity = entities.first else {
                    print("[Save] entity not found for id=\(id), title=\(title)")
                    return
                }
                
                if version < entity.version {
                    print("[Save] skip outdated payload for id=\(id), payloadVersion=\(version), currentVersion=\(entity.version)")
                    return
                }
                
                print("[Save] updating entity id=\(entity.id), title=\(title), reason=\(reason), version=\(version)")
                entity.title = title
                entity.updatedAt = Date()
                entity.folderName = folder
                entity.rtfdData = rtfdData
                entity.reminderAt = reminderAt
                entity.recurrenceRule = recurrenceRule
                entity.version = version
                
                try? context.save()
                print("[Save] context.save() success for id=\(id)")
                
                if let idx = self.notes.firstIndex(where: { $0.id == id }) {
                    self.notes[idx].title = title
                    self.notes[idx].folder = folder
                    self.notes[idx].reminderAt = reminderAt
                    self.notes[idx].recurrenceRule = recurrenceRule
                    self.notes[idx].version = version
                }
            }
        }
    }
    
    func saveNote(
        id: UUID,
        title: String,
        folder: String,
        reminderAt: Date?,
        recurrenceRule: String,
        contentSnapshot: NSAttributedString,
        version: Int64,
        reason: String = "unknown"
    ) {
        let cleaned = (contentSnapshot.copy() as! NSAttributedString).cleanedForStorage()
        if let data = try? cleaned.data(
            from: NSRange(location: 0, length: cleaned.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
        ) {
            saveNote(
                id: id,
                title: title,
                folder: folder,
                reminderAt: reminderAt,
                recurrenceRule: recurrenceRule,
                rtfdData: data,
                version: version,
                reason: reason
            )
        }
    }
    
    func updateNote(_ note: Note) {
        saveNote(
            id: note.id,
            title: note.title,
            folder: note.folder,
            reminderAt: note.reminderAt,
            recurrenceRule: note.recurrenceRule,
            contentSnapshot: note.content,
            version: note.version,
            reason: "legacy"
        )
    }
    
    /// 保存笔记的视图模式
    func saveNoteViewMode(id: UUID, viewMode: NoteViewMode) {
        guard let context = modelContext else {
            print("[SaveViewMode] modelContext is nil, skip save for id=\(id)")
            return
        }
        
        Task {
            await MainActor.run {
                let idToMatch = id
                let descriptor = FetchDescriptor<NoteEntity>(
                    predicate: #Predicate<NoteEntity> { $0.id == idToMatch }
                )
                
                guard let entities = try? context.fetch(descriptor), let entity = entities.first else {
                    print("[SaveViewMode] entity not found for id=\(id)")
                    return
                }
                
                entity.viewMode = viewMode.rawValue
                try? context.save()
                print("[SaveViewMode] saved viewMode '\(viewMode.rawValue)' for note id=\(id)")
            }
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
    func cleanedForStorage() -> NSAttributedString {
        let range = NSRange(location: 0, length: self.length)
        let mutable = NSMutableAttributedString(attributedString: self)

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

        // 先确保所有复选框附件的图像已生成
        mutable.enumerateAttribute(.attachment, in: range, options: []) { value, attrRange, _ in
            if let checkbox = value as? CheckboxTextAttachment {
                checkbox.prepareForSaving()
            }
        }

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
    var createdAt: Date
    var updatedAt: Date
    var folder: String
    var reminderAt: Date?
    var recurrenceRule: String
    var version: Int64
    var tagIDs: [UUID]
    var viewMode: NoteViewMode

    var hasReminder: Bool {
        return reminderAt != nil
    }

    init(
        id: UUID = UUID(),
        title: String,
        content: NSAttributedString,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        folder: String = "未分类",
        reminderAt: Date? = nil,
        recurrenceRule: String = "none",
        version: Int64 = 0,
        tagIDs: [UUID] = [],
        viewMode: NoteViewMode = .text
    ) {
        self.id = id
        self.title = title
        self.content = content
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.folder = folder
        self.reminderAt = reminderAt
        self.recurrenceRule = recurrenceRule
        self.version = version
        self.tagIDs = tagIDs
        self.viewMode = viewMode
    }
    
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
    
    static func == (lhs: Note, rhs: Note) -> Bool {
        lhs.id == rhs.id
    }
}
