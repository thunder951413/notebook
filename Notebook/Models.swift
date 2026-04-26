import SwiftUI
import SwiftData
import Combine

/// 调试开关
private let isCheckboxDebugEnabled = false

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

struct AttachmentAppearance {
    static var primaryTextColor: NSColor { .textColor }
    static var secondaryTextColor: NSColor { .secondaryLabelColor }
    static var backgroundColor: NSColor { .textBackgroundColor }
    static var secondaryBackgroundColor: NSColor { .controlBackgroundColor }
    static var borderColor: NSColor { .separatorColor }
    static var selectionColor: NSColor { .selectedContentBackgroundColor.withAlphaComponent(0.3) }
    static var uncheckedStrokeColor: NSColor { .tertiaryLabelColor }
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

struct BlockDocumentAttributedStringBuilder {
    private let attachmentsRoot: URL?
    private let decoder = JSONDecoder()

    init(attachmentsRoot: URL?) {
        self.attachmentsRoot = attachmentsRoot
    }

    func build(
        blocks: [BlockDocumentBlockEntity],
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        var index = 0
        var emittedBlockCount = 0

        while index < blocks.count {
            if emittedBlockCount > 0 {
                result.append(NSAttributedString(string: "\n"))
            }

            if let recoveredTodo = recoveredLegacyTodoBlock(
                at: index,
                blocks: blocks,
                assetsByID: assetsByID
            ) {
                result.append(recoveredTodo)
                index += 2
            } else {
                result.append(attributedBlock(for: blocks[index], assetsByID: assetsByID))
                index += 1
            }
            emittedBlockCount += 1
        }

        return result
    }

    private func attributedBlock(
        for block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        switch block.kind {
        case "heading":
            return headingBlock(for: block)
        case "list_item":
            return listItemBlock(for: block)
        case "todo_item":
            return todoItemBlock(for: block)
        case "image":
            return imageBlock(for: block, assetsByID: assetsByID)
        case "audio":
            return audioBlock(for: block, assetsByID: assetsByID)
        case "table":
            return tableBlock(for: block)
        default:
            let content = inlineAttributedText(from: block.textPayload)
            return content.length == 0 ? NSAttributedString(string: "") : content
        }
    }

    private func headingBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        let content = NSMutableAttributedString(attributedString: inlineAttributedText(from: block.textPayload))
        let fontSize = headingFontSize(level: block.level ?? 1)
        let range = NSRange(location: 0, length: content.length)
        if range.length > 0 {
            content.enumerateAttributes(in: range) { attributes, subrange, _ in
                let font = resolvedFont(
                    family: fontFamily(from: attributes[.font]),
                    size: fontSize,
                    bold: true,
                    italic: isItalicFont(attributes[.font] as? NSFont)
                )
                content.addAttribute(.font, value: font, range: subrange)
            }
            content.addAttribute(.notebookHeadingLevel, value: block.level ?? 1, range: range)
        }
        return content
    }

    private func listItemBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        let result = NSMutableAttributedString(string: indentationPrefix(level: block.indent))
        result.append(NSAttributedString(string: listMarker(for: block)))
        result.append(sanitizedListInlineText(from: block.textPayload))
        return result
    }

    private func todoItemBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        let result = NSMutableAttributedString(string: indentationPrefix(level: block.indent))
        let attachment = CheckboxTextAttachment(checked: block.checked ?? false)
        result.append(NSAttributedString(attachment: attachment))
        result.append(NSAttributedString(string: " "))
        result.append(sanitizedTodoInlineText(from: block.textPayload))
        return result
    }

    private func recoveredLegacyTodoBlock(
        at index: Int,
        blocks: [BlockDocumentBlockEntity],
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString? {
        guard index + 1 < blocks.count else { return nil }
        let imageBlock = blocks[index]
        let textBlock = blocks[index + 1]
        guard imageBlock.kind == "image", textBlock.kind == "paragraph" else { return nil }
        guard isLikelyLegacyCheckboxImageBlock(imageBlock, assetsByID: assetsByID) else { return nil }

        let checked = recoveredLegacyCheckboxState(from: imageBlock, assetsByID: assetsByID) ?? false
        let result = NSMutableAttributedString(string: indentationPrefix(level: textBlock.indent))
        result.append(NSAttributedString(attachment: CheckboxTextAttachment(checked: checked)))
        result.append(NSAttributedString(string: " "))
        result.append(sanitizedTodoInlineText(from: textBlock.textPayload))
        return result
    }

    private func isLikelyLegacyCheckboxImageBlock(
        _ block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> Bool {
        guard let asset = block.assetID.flatMap({ assetsByID[$0] }) else { return false }
        guard asset.kind == "image" else { return false }
        let size = resolvedLegacyAssetImageSize(asset)
        guard size.width > 0, size.height > 0 else { return false }
        let width = size.width
        let height = size.height
        guard width >= 10, height >= 10, width <= 36, height <= 36 else { return false }

        let minEdge = min(width, height)
        let maxEdge = max(width, height)
        return minEdge > 0 && (maxEdge / minEdge) <= 1.25
    }

    private func recoveredLegacyCheckboxState(
        from block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> Bool? {
        guard
            let asset = block.assetID.flatMap({ assetsByID[$0] }),
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path),
            let image = NSImage(contentsOf: fileURL)
        else {
            return nil
        }

        let attachment = NSTextAttachment()
        attachment.image = image
        return CheckboxTextAttachment.inferCheckedState(from: attachment)
    }

    private func resolvedLegacyAssetImageSize(_ asset: BlockDocumentAssetEntity) -> CGSize {
        if let width = asset.width, let height = asset.height, width > 0, height > 0 {
            return CGSize(width: width, height: height)
        }
        guard
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path),
            let image = NSImage(contentsOf: fileURL)
        else {
            return .zero
        }
        return image.size
    }

    private func imageBlock(
        for block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        guard
            let asset = block.assetID.flatMap({ assetsByID[$0] }),
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path)
        else {
            return NSAttributedString(string: "[图片]")
        }

        let attachment = AttachmentTextAttachment(fileURL: fileURL, kind: .image)
        let width = CGFloat(asset.width ?? 0)
        let height = CGFloat(asset.height ?? 0)
        if width > 1, height > 1 {
            attachment.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        }

        let result = NSMutableAttributedString(attachment: attachment)
        let range = NSRange(location: 0, length: result.length)
        if width > 1, height > 1 {
            result.addAttribute(.notebookImageWidth, value: width, range: range)
            result.addAttribute(.notebookImageHeight, value: height, range: range)
            let link = "notebook-image://\(fileURL.absoluteString)#w=\(Int(width.rounded()))&h=\(Int(height.rounded()))"
            result.addAttribute(.link, value: link, range: range)
        }
        return result
    }

    private func audioBlock(
        for block: BlockDocumentBlockEntity,
        assetsByID: [String: BlockDocumentAssetEntity]
    ) -> NSAttributedString {
        guard
            let asset = block.assetID.flatMap({ assetsByID[$0] }),
            let fileURL = assetFileURL(for: asset),
            FileManager.default.fileExists(atPath: fileURL.path)
        else {
            return NSAttributedString(string: "[音频]")
        }

        let attachment = AudioBlockAttachment(
            fileURL: fileURL,
            duration: asset.duration ?? 0,
            createDate: asset.createdAt ?? Date()
        )
        let result = NSMutableAttributedString(attachment: attachment)
        result.addAttribute(.link, value: fileURL, range: NSRange(location: 0, length: result.length))
        return result
    }

    private func tableBlock(for block: BlockDocumentBlockEntity) -> NSAttributedString {
        guard
            let payloadData = block.tablePayload,
            let payload = try? decoder.decode(BlockDocumentTablePayload.self, from: payloadData)
        else {
            return NSAttributedString(string: "[表格]")
        }

        let rowCount = max(1, payload.rows.count)
        let columnCount = max(1, payload.rows.first?.count ?? 1)
        var tableData = TableData(rows: rowCount, columns: columnCount)
        if !payload.rows.isEmpty {
            tableData.rows = payload.rows
        }
        if payload.columnWidths.count == columnCount {
            tableData.columnWidths = payload.columnWidths.map { CGFloat($0) }
        }
        if payload.rowHeights.count == rowCount {
            tableData.rowHeights = payload.rowHeights.map { CGFloat($0) }
        }

        let attachment = TableTextAttachment(rows: rowCount, columns: columnCount)
        attachment.tableData = tableData
        attachment.updateImage()
        let result = NSMutableAttributedString(attachment: attachment)
        if let encoded = try? JSONEncoder().encode(tableData) {
            result.addAttribute(.notebookTableData, value: encoded, range: NSRange(location: 0, length: result.length))
        }
        return result
    }

    private func inlineAttributedText(from payload: Data?) -> NSAttributedString {
        guard
            let payload,
            let spans = try? decoder.decode([BlockDocumentTextSpanPayload].self, from: payload)
        else {
            return NSAttributedString(string: "")
        }

        let result = NSMutableAttributedString()
        for span in spans {
            result.append(NSAttributedString(string: span.text, attributes: attributes(for: span)))
        }
        return result
    }

    private func sanitizedTodoInlineText(from payload: Data?) -> NSAttributedString {
        let text = NSMutableAttributedString(attributedString: inlineAttributedText(from: payload))
        guard text.length > 0 else { return text }

        while text.length > 0 {
            let char = (text.string as NSString).character(at: 0)
            if char == 32 || char == 9 || char == 10 || char == 13 || char == 0x2028 || char == 0x2029 {
                text.deleteCharacters(in: NSRange(location: 0, length: 1))
                continue
            }
            break
        }

        return text
    }

    private func sanitizedListInlineText(from payload: Data?) -> NSAttributedString {
        let text = NSMutableAttributedString(attributedString: inlineAttributedText(from: payload))
        guard text.length > 0 else { return text }

        while text.length > 0 {
            let char = (text.string as NSString).character(at: 0)
            if char == 10 || char == 13 || char == 0x2028 || char == 0x2029 {
                text.deleteCharacters(in: NSRange(location: 0, length: 1))
                continue
            }
            break
        }

        return text
    }

    private func attributes(for span: BlockDocumentTextSpanPayload) -> [NSAttributedString.Key: Any] {
        var attributes: [NSAttributedString.Key: Any] = [:]
        let fontSize = CGFloat(span.fontSize ?? 16)
        attributes[.font] = resolvedFont(
            family: span.fontFamily,
            size: fontSize,
            bold: span.bold,
            italic: span.italic
        )
        if span.underline {
            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        if span.strikethrough {
            attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        if let color = nsColor(from: span.textColor) {
            attributes[.foregroundColor] = color
        }
        if let color = nsColor(from: span.backgroundColor) {
            attributes[.backgroundColor] = color
        }
        if let link = span.link, !link.isEmpty {
            attributes[.link] = URL(string: link) ?? link
        }
        if let kern = span.kern {
            attributes[.kern] = kern
        }
        if let baselineOffset = span.baselineOffset {
            attributes[.baselineOffset] = baselineOffset
        }
        if let paragraphStyle = nsParagraphStyle(from: span.paragraphStyle) {
            attributes[.paragraphStyle] = paragraphStyle
        }
        return attributes
    }

    private func resolvedFont(
        family: String?,
        size: CGFloat,
        bold: Bool,
        italic: Bool
    ) -> NSFont {
        let baseFont = family.flatMap {
            NSFont(name: $0, size: size)
        } ?? NSFont.systemFont(ofSize: size)

        var traits: NSFontTraitMask = []
        if bold {
            traits.insert(.boldFontMask)
        }
        if italic {
            traits.insert(.italicFontMask)
        }

        return NSFontManager.shared.convert(baseFont, toHaveTrait: traits)
    }

    private func fontFamily(from value: Any?) -> String? {
        (value as? NSFont)?.familyName
    }

    private func isItalicFont(_ font: NSFont?) -> Bool {
        guard let font else { return false }
        return NSFontManager.shared.traits(of: font).contains(.italicFontMask)
    }

    private func headingFontSize(level: Int) -> CGFloat {
        switch max(1, min(level, 6)) {
        case 1: return 22
        case 2: return 18
        case 3: return 16
        case 4: return 15
        case 5: return 14
        default: return 13
        }
    }

    private func nsParagraphStyle(from payload: BlockDocumentParagraphStylePayload?) -> NSParagraphStyle? {
        guard let payload else { return nil }
        let style = NSMutableParagraphStyle()
        if let alignment = payload.alignment,
           let textAlignment = NSTextAlignment(rawValue: alignment) {
            style.alignment = textAlignment
        }
        if let lineSpacing = payload.lineSpacing {
            style.lineSpacing = lineSpacing
        }
        if let paragraphSpacing = payload.paragraphSpacing {
            style.paragraphSpacing = paragraphSpacing
        }
        if let paragraphSpacingBefore = payload.paragraphSpacingBefore {
            style.paragraphSpacingBefore = paragraphSpacingBefore
        }
        if let firstLineHeadIndent = payload.firstLineHeadIndent {
            style.firstLineHeadIndent = firstLineHeadIndent
        }
        if let headIndent = payload.headIndent {
            style.headIndent = headIndent
        }
        if let tailIndent = payload.tailIndent {
            style.tailIndent = tailIndent
        }
        return style
    }

    private func indentationPrefix(level: Int?) -> String {
        String(repeating: "    ", count: max(0, level ?? 0))
    }

    private func listMarker(for block: BlockDocumentBlockEntity) -> String {
        switch block.listStyle {
        case "ordered":
            return "\(block.order ?? 1). "
        case "dash":
            return "- "
        default:
            return "• "
        }
    }

    private func assetFileURL(for asset: BlockDocumentAssetEntity) -> URL? {
        attachmentsRoot?.appendingPathComponent(asset.relativeFilePath)
    }

    private func nsColor(from hex: String?) -> NSColor? {
        guard let hex else { return nil }
        let raw = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard raw.count == 6 || raw.count == 8 else { return nil }

        var value: UInt64 = 0
        guard Scanner(string: raw).scanHexInt64(&value) else { return nil }

        if raw.count == 6 {
            return NSColor(
                red: CGFloat((value & 0xFF0000) >> 16) / 255,
                green: CGFloat((value & 0x00FF00) >> 8) / 255,
                blue: CGFloat(value & 0x0000FF) / 255,
                alpha: 1
            )
        }

        return NSColor(
            red: CGFloat((value & 0xFF000000) >> 24) / 255,
            green: CGFloat((value & 0x00FF0000) >> 16) / 255,
            blue: CGFloat((value & 0x0000FF00) >> 8) / 255,
            alpha: CGFloat(value & 0x000000FF) / 255
        )
    }
}

@MainActor
class NoteStore: ObservableObject {
    @Published var notes: [Note] = []
    @Published var folders: [Folder] = []
    @Published var tags: [Tag] = []
    @Published var encryptedFolders: [EncryptedFolder] = []

    /// 非回收站的笔记
    var activeNotes: [Note] {
        notes.filter { !$0.isInRecycleBin }
    }

    /// 回收站中的笔记
    var recycledNotes: [Note] {
        notes.filter { $0.isInRecycleBin }
    }
    
    /// 用于菜单栏 Popover 跳转的选中笔记 ID
    @Published var selectedNoteId: UUID?
    /// 用于菜单栏 Popover 跳转的选中文件夹
    @Published var selectedFolderForNavigation: String?
    
    private var modelContext: ModelContext?
    
    private let encryptedFoldersKey = "encrypted_folders"
    
    /// 获取所有加密笔记
    var encryptedNotes: [Note] {
        return activeNotes.filter { EncryptedFolderManager.shared.isEncrypted(note: $0) }
    }

    var isUsingBlockDocumentLibrary: Bool {
        true
    }

    private func latestBlockDocumentLibrary(in context: ModelContext) -> BlockDocumentLibraryEntity? {
        let libraries = try? context.fetch(FetchDescriptor<BlockDocumentLibraryEntity>())
        return libraries?.sorted(by: { $0.importedAt > $1.importedAt }).first
    }

    @discardableResult
    private func ensureBlockDocumentLibrary(in context: ModelContext) -> BlockDocumentLibraryEntity? {
        if let library = latestBlockDocumentLibrary(in: context) {
            return library
        }

        let library = BlockDocumentLibraryEntity(
            schemaVersion: "1.0",
            sourceExportedAt: Date(),
            importedAt: Date(),
            noteCount: 0,
            folderCount: 0,
            tagCount: 0
        )
        context.insert(library)
        try? context.save()
        return library
    }
    
    init() {
        setupModelContext()
    }

    deinit {
        modelContext = nil
    }

    /// 从外部设置 ModelContext（用于 AppDelegate 注入）
    func setContext(_ context: ModelContext) {
        self.modelContext = context
        fetchData()
    }

    private func setupModelContext() {
        // 如果 PersistenceController 已经配置了容器，使用它的容器
        if let container = PersistenceController.shared.modelContainer {
            self.modelContext = ModelContext(container)
            fetchData()
            return
        }
        
        // 如果没有配置，尝试从 StorageLocationManager 获取存储位置并创建容器
        let location = StorageLocationManager.shared
        guard location.isConfigured,
              let _ = location.baseDirectoryURL else {
            print("NoteStore: Storage not configured yet, skipping fetch")
            return
        }
        
        do {
            try location.ensureDirectoryStructureExists()
            let storeURL = try location.databaseDirectoryURL().appendingPathComponent("notebook.store")
            
            let schema = PersistenceController.appSchema
            let config = ModelConfiguration(schema: schema, url: storeURL)
            let container = try ModelContainer(for: schema, configurations: [config])
            
            self.modelContext = ModelContext(container)
            fetchData()
        } catch {
            print("NoteStore: Failed to setup ModelContext: \(error)")
        }
    }
    
    func fetchData() {
        guard let context = modelContext else {
            print("NoteStore: modelContext is nil, skipping fetch")
            return
        }
        
        do {
            guard let library = ensureBlockDocumentLibrary(in: context) else { return }
            try loadBlockDocumentData(context: context, library: library)
            loadEncryptedFolders()
        } catch {
            print("Fetch failed: \(error)")
        }
    }

    private func loadBlockDocumentData(context: ModelContext, library: BlockDocumentLibraryEntity) throws {
        let folderEntities = try context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
            .filter { $0.libraryID == library.id }
            .sorted { $0.sortOrder < $1.sortOrder }
        let tagEntities = try context.fetch(FetchDescriptor<BlockDocumentTagEntity>())
            .filter { $0.libraryID == library.id }
            .sorted { $0.createdAt < $1.createdAt }
        let noteEntities = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
            .filter { $0.libraryID == library.id }
            .sorted { $0.updatedAt > $1.updatedAt }
        let blockEntities = try context.fetch(FetchDescriptor<BlockDocumentBlockEntity>())
        let assetEntities = try context.fetch(FetchDescriptor<BlockDocumentAssetEntity>())

        let blocksByNoteID = Dictionary(grouping: blockEntities, by: \.noteID)
        let assetsByNoteID = Dictionary(grouping: assetEntities, by: \.noteID)
        let attachmentsRoot = try? StorageLocationManager.shared.attachmentsDirectoryURL()

        self.notes = noteEntities.map { entity in
            let blocks = (blocksByNoteID[entity.id] ?? []).sorted { $0.position < $1.position }
            let assets = Dictionary(uniqueKeysWithValues: (assetsByNoteID[entity.id] ?? []).map { ($0.assetID, $0) })
            let content = Self.fixCheckboxAttachments(
                in: loadBlockBackedContent(
                    blocks: blocks,
                    assetsByID: assets,
                    attachmentsRoot: attachmentsRoot
                )
            )

            return Note(
                id: entity.id,
                title: entity.title,
                content: content,
                createdAt: entity.createdAt,
                updatedAt: entity.updatedAt,
                folderID: entity.folderID,
                folder: entity.folderName,
                reminderAt: entity.reminderAt,
                recurrenceRule: entity.recurrenceRule,
                version: entity.version,
                tagIDs: decodeUUIDList(entity.tagIDs),
                viewMode: NoteViewMode(rawValue: entity.viewMode) ?? .text,
                deletedAt: entity.deletedAt,
                originalFolderID: entity.originalFolderID,
                originalFolderName: entity.originalFolderName,
                hasConflict: entity.hasConflict
            )
        }

        self.folders = folderEntities.map {
            Folder(
                id: $0.id,
                name: $0.name,
                sortOrder: $0.sortOrder,
                createdAt: $0.createdAt ?? Date(),
                isSystem: $0.isSystem
            )
        }
        self.tags = tagEntities.enumerated().map { index, entity in
            Tag(id: entity.id, name: entity.name, color: entity.color, sortOrder: index, createdAt: entity.createdAt)
        }
    }

    private func decodeRTFDContent(_ data: Data?) -> NSAttributedString {
        guard let data else {
            return NSAttributedString(string: "")
        }

        do {
            return try NSAttributedString(
                data: data,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            )
        } catch {
            print("[Fetch] Failed to decode RTFD, error: \(error)")
            return NSAttributedString(string: "")
        }
    }

    private func decodeUUIDList(_ rawValue: String?) -> [UUID] {
        Array(Set(
            rawValue?
                .split(separator: ",")
                .map { String($0).trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .compactMap { UUID(uuidString: $0) } ?? []
        ))
    }

    private func loadBlockBackedContent(
        blocks: [BlockDocumentBlockEntity],
        assetsByID: [String: BlockDocumentAssetEntity],
        attachmentsRoot: URL?
    ) -> NSAttributedString {
        BlockDocumentAttributedStringBuilder(attachmentsRoot: attachmentsRoot)
            .build(blocks: blocks, assetsByID: assetsByID)
    }
    
    private func cleanupExpiredOneTimeReminders(context: ModelContext) {
        let now = Date()
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.reminderAt != nil }
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
                if isCheckboxDebugEnabled { print("[CheckboxDebug] Restored image from contents at pos=\(location), size=\(image?.size ?? .zero)") }
            }

            // 如果仍然没有图像，尝试通过 fileWrapper 恢复
            if image == nil, let fileWrapper = attachment.fileWrapper, fileWrapper.isRegularFile {
                if let data = fileWrapper.regularFileContents {
                    image = NSImage(data: data)
                    imageSource = "fileWrapper"
                    if isCheckboxDebugEnabled { print("[CheckboxDebug] Restored image from fileWrapper at pos=\(location), size=\(image?.size ?? .zero)") }
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
        if isCheckboxDebugEnabled && !debugInfo.isEmpty {
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
            if isCheckboxDebugEnabled { print("[CheckboxDebug] Failed to get CGImage") }
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
            if isCheckboxDebugEnabled { print("[CheckboxDebug] Failed to create CGContext") }
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
        
        if isCheckboxDebugEnabled { print("[CheckboxDebug] Center pixel: R=\(String(format: "%.2f", r)), G=\(String(format: "%.2f", g)), B=\(String(format: "%.2f", b)), A=\(String(format: "%.2f", a))") }
        
        // 判断逻辑：
        // - 已选中：中心有黄色（R高，G高，B低）或深色
        // - 未选中：中心是白色（R=G=B=1）或透明（A=0）
        
        // 如果透明度很低，认为是未选中
        if a < 0.5 {
            if isCheckboxDebugEnabled { print("[CheckboxDebug] Low alpha, assuming unchecked") }
            return false
        }
        
        // 计算亮度
        let brightness = (r + g + b) / 3.0
        if isCheckboxDebugEnabled { print("[CheckboxDebug] Brightness: \(String(format: "%.2f", brightness))") }
        
        // 如果亮度很高（接近白色），认为是未选中
        if brightness > 0.9 {
            if isCheckboxDebugEnabled { print("[CheckboxDebug] High brightness, assuming unchecked") }
            return false
        }
        
        // 检查是否是黄色（选中状态的特征）
        // 黄色：R和G都很高，B很低
        let isYellow = r > 0.7 && g > 0.7 && b < 0.5
        if isYellow {
            if isCheckboxDebugEnabled { print("[CheckboxDebug] Yellow detected, assuming checked") }
            return true
        }
        
        // 如果亮度中等偏低，可能是填充色（选中）
        if brightness < 0.7 {
            if isCheckboxDebugEnabled { print("[CheckboxDebug] Medium brightness, assuming checked") }
            return true
        }
        
        if isCheckboxDebugEnabled { print("[CheckboxDebug] Uncertain, defaulting to unchecked") }
        return false
    }
    
    @discardableResult
    func addNote(title: String, folderID: UUID? = nil, folderName: String = "未分类") -> Note? {
        guard let context = modelContext else { return nil }
        guard let library = ensureBlockDocumentLibrary(in: context) else { return nil }
        let createdAt = Date()
        let entity = BlockDocumentNoteEntity(
            id: UUID(),
            libraryID: library.id,
            title: title,
            createdAt: createdAt,
            updatedAt: createdAt,
            folderID: folderID,
            folderName: folderName,
            reminderAt: nil,
            recurrenceRule: "none",
            version: 0,
            tagIDs: "",
            viewMode: NoteViewMode.text.rawValue,
            deletedAt: nil,
            originalFolderID: nil,
            originalFolderName: nil,
            documentSchemaVersion: "1.0",
            documentSource: "app",
            blockCount: 0,
            assetCount: 0
        )
        context.insert(entity)
        library.noteCount += 1
        try? context.save()
        fetchData()
        return activeNotes.first(where: { $0.id == entity.id })
    }
    
    func addFolder(name: String) {
        guard let context = modelContext else { return }
        guard let library = ensureBlockDocumentLibrary(in: context) else { return }
        let maxSortOrder = (try? context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
            .filter { $0.libraryID == library.id }
            .map(\.sortOrder)
            .max()) ?? -1
        let entity = BlockDocumentFolderEntity(
            id: UUID(),
            libraryID: library.id,
            name: name,
            sortOrder: maxSortOrder + 1,
            isSystem: false,
            createdAt: Date()
        )
        context.insert(entity)
        library.folderCount += 1
        try? context.save()
        fetchData()
    }
    
    func updateFolder(id: UUID, name: String) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            entity.name = name

            let notesInFolder = try? context.fetch(FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.folderID == idToMatch }))
            for note in notesInFolder ?? [] {
                note.folderName = name
            }

            try? context.save()
            fetchData()
        }
    }
    
    func deleteFolder(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            if entity.isSystem {
                print("Cannot delete system folder: \(entity.name)")
                return
            }

            let notesInFolder = try? context.fetch(FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.folderID == idToMatch }))
            for note in notesInFolder ?? [] {
                note.folderID = nil
                note.folderName = "未分类"
            }

            if let library = latestBlockDocumentLibrary(in: context), library.id == entity.libraryID {
                library.folderCount = max(0, library.folderCount - 1)
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
            let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
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
        guard let library = ensureBlockDocumentLibrary(in: context) else { return }
        let entity = BlockDocumentTagEntity(
            id: UUID(),
            libraryID: library.id,
            name: name,
            color: color,
            createdAt: Date()
        )
        context.insert(entity)
        library.tagCount += 1
        try? context.save()
        fetchData()
    }
    
    func updateTag(id: UUID, name: String? = nil, color: String? = nil) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentTagEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            if let name { entity.name = name }
            if let color { entity.color = color }
            try? context.save()
            fetchData()
        }
    }
    
    func deleteTag(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentTagEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            let notesWithTag = notes.filter { $0.tagIDs.contains(id) }
            for note in notesWithTag {
                removeTagFromNote(tagID: id, noteID: note.id)
            }

            if let library = latestBlockDocumentLibrary(in: context), library.id == entity.libraryID {
                library.tagCount = max(0, library.tagCount - 1)
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
        let baseDate = Date()
        for (index, tag) in reordered.enumerated() {
            let idToMatch = tag.id
            let descriptor = FetchDescriptor<BlockDocumentTagEntity>(predicate: #Predicate { $0.id == idToMatch })
            if let entity = try? context.fetch(descriptor).first {
                entity.createdAt = baseDate.addingTimeInterval(TimeInterval(index))
            }
        }
        try? context.save()
        fetchData()
    }
    
    // MARK: - Note Tag Operations
    
    func addTagToNote(tagID: UUID, noteID: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            var currentTagIDs = Array(Set(
                entity.tagIDs
                    .split(separator: ",")
                    .map { String($0).trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                    .compactMap { UUID(uuidString: $0) }
            ))
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
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            var currentTagIDs = Array(Set(
                entity.tagIDs
                    .split(separator: ",")
                    .map { String($0).trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                    .compactMap { UUID(uuidString: $0) }
            ))
            currentTagIDs.removeAll { $0 == tagID }
            entity.tagIDs = currentTagIDs.map { $0.uuidString }.joined(separator: ",")
            entity.updatedAt = Date()
            try? context.save()
            if let idx = notes.firstIndex(where: { $0.id == noteID }) {
                notes[idx].tagIDs = currentTagIDs
                notes[idx].updatedAt = entity.updatedAt
            }
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
        guard modelContext != nil else {
            print("[Save] modelContext is nil, skip save for id=\(id)")
            return
        }
        let folderID = folders.first { $0.name == folder }?.id
        guard let request = NoteSaveManager.shared.createRequest(
            noteID: id,
            title: title,
            folderID: folderID,
            folder: folder,
            reminderAt: reminderAt,
            recurrenceRule: recurrenceRule,
            content: decodeRTFDContent(rtfdData),
            reason: reason
        ) else {
            return
        }

        _ = NoteSaveManager.shared.saveImmediately(request: request)

        if let idx = notes.firstIndex(where: { $0.id == id }) {
            notes[idx].title = title
            notes[idx].folder = folder
            notes[idx].folderID = folderID
            notes[idx].reminderAt = reminderAt
            notes[idx].recurrenceRule = recurrenceRule
            notes[idx].version = version
            notes[idx].updatedAt = Date()
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
        guard let request = NoteSaveManager.shared.createRequest(
            noteID: note.id,
            title: note.title,
            folderID: note.folderID,
            folder: note.folder,
            reminderAt: note.reminderAt,
            recurrenceRule: note.recurrenceRule,
            content: note.content,
            reason: "blockDocument"
        ) else {
            return
        }

        _ = NoteSaveManager.shared.saveImmediately(request: request)

        if let idx = notes.firstIndex(where: { $0.id == note.id }) {
            notes[idx] = note
            notes[idx].updatedAt = Date()
        }
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
                let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
                )
                
                guard let entities = try? context.fetch(descriptor), let entity = entities.first else {
                    print("[SaveViewMode] entity not found for id=\(id)")
                    return
                }
                
                entity.viewMode = viewMode.rawValue
                entity.updatedAt = Date()
                try? context.save()
                if let idx = self.notes.firstIndex(where: { $0.id == id }) {
                    self.notes[idx].viewMode = viewMode
                    self.notes[idx].updatedAt = entity.updatedAt
                }
                print("[SaveViewMode] saved viewMode '\(viewMode.rawValue)' for note id=\(id)")
            }
        }
    }
    
    func deleteNote(id: UUID) {
        moveNoteToRecycleBin(id: id)
    }

    /// 移动到回收站（软删除）
    func moveNoteToRecycleBin(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )

        if let entity = try? context.fetch(descriptor).first {
            guard entity.deletedAt == nil else { return }
            let deletedAt = Date()
            entity.deletedAt = deletedAt
            entity.originalFolderID = entity.folderID
            entity.originalFolderName = entity.folderName
            entity.updatedAt = deletedAt
            try? context.save()
            if let idx = notes.firstIndex(where: { $0.id == id }) {
                notes[idx].deletedAt = deletedAt
                notes[idx].originalFolderID = entity.originalFolderID
                notes[idx].originalFolderName = entity.originalFolderName
                notes[idx].updatedAt = deletedAt
            }
        }
    }

    /// 从回收站恢复
    func restoreNote(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )

        if let entity = try? context.fetch(descriptor).first {
            let fallbackFolderName = "未分类"
            var restoredFolderID = entity.originalFolderID
            var restoredFolderName = entity.originalFolderName ?? fallbackFolderName

            if let folderID = entity.originalFolderID {
                let folderDescriptor = FetchDescriptor<BlockDocumentFolderEntity>(
                    predicate: #Predicate<BlockDocumentFolderEntity> { $0.id == folderID }
                )
                let folderExists = (try? context.fetch(folderDescriptor).first) != nil
                if !folderExists {
                    restoredFolderID = nil
                    restoredFolderName = fallbackFolderName
                }
            }

            entity.deletedAt = nil
            entity.folderID = restoredFolderID
            entity.folderName = restoredFolderName
            entity.originalFolderID = nil
            entity.originalFolderName = nil
            entity.updatedAt = Date()
            try? context.save()
            if let idx = notes.firstIndex(where: { $0.id == id }) {
                notes[idx].deletedAt = nil
                notes[idx].folderID = restoredFolderID
                notes[idx].folder = restoredFolderName
                notes[idx].originalFolderID = nil
                notes[idx].originalFolderName = nil
                notes[idx].updatedAt = entity.updatedAt
            }
        }
    }

    @discardableResult
    func restoreNotes(ids: [UUID]) -> Int {
        let uniqueIDs = Array(Set(ids))
        for id in uniqueIDs {
            restoreNote(id: id)
        }
        return uniqueIDs.count
    }

    /// 彻底删除
    func deleteNotePermanently(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )

        if let entity = try? context.fetch(descriptor).first {
            let blockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == idToMatch }
            )
            let assetDescriptor = FetchDescriptor<BlockDocumentAssetEntity>(
                predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == idToMatch }
            )

            let blocks = (try? context.fetch(blockDescriptor)) ?? []
            let assets = (try? context.fetch(assetDescriptor)) ?? []
            deleteBlockDocumentArtifacts(noteID: id, assets: assets)

            for block in blocks {
                context.delete(block)
            }
            for asset in assets {
                context.delete(asset)
            }

            let libraryID = entity.libraryID
            context.delete(entity)

            let libraryDescriptor = FetchDescriptor<BlockDocumentLibraryEntity>(
                predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
            )
            if let library = try? context.fetch(libraryDescriptor).first {
                library.noteCount = max(0, library.noteCount - 1)
            }

            try? BlockDocumentNoteVersionStore.deleteHistory(noteID: id, context: context)
            try? context.save()
            notes.removeAll { $0.id == id }
        }
    }

    @discardableResult
    func deleteNotesPermanently(ids: [UUID]) -> Int {
        let uniqueIDs = Array(Set(ids))
        for id in uniqueIDs {
            deleteNotePermanently(id: id)
        }
        return uniqueIDs.count
    }

    private func deleteBlockDocumentArtifacts(
        noteID: UUID,
        assets: [BlockDocumentAssetEntity]
    ) {
        let storage = StorageLocationManager.shared
        guard let base = storage.baseDirectoryURL else { return }

        try? storage.withSecurityScopedAccess(base) {
            try storage.ensureDirectoryStructureExists()
            let attachmentsRoot = try storage.attachmentsDirectoryURL()

            for asset in assets {
                removeRelativePathIfPresent(asset.relativeFilePath, attachmentsRoot: attachmentsRoot)

                if let sidecarPayload = asset.sidecarPathsPayload,
                   let sidecarRelativePaths = try? JSONDecoder().decode([String].self, from: sidecarPayload) {
                    for sidecarRelativePath in sidecarRelativePaths {
                        removeRelativePathIfPresent(sidecarRelativePath, attachmentsRoot: attachmentsRoot)
                    }
                }
            }

            cleanupEmptyNoteDirectories(noteID: noteID, attachmentsRoot: attachmentsRoot)
        }
    }

    private func removeRelativePathIfPresent(_ relativePath: String, attachmentsRoot: URL) {
        let fileURL = attachmentsRoot.appendingPathComponent(relativePath)
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: fileURL.path) else { return }

        try? fileManager.removeItem(at: fileURL)
        removeEmptyParents(startingAt: fileURL.deletingLastPathComponent(), stopAt: attachmentsRoot)
    }

    private func cleanupEmptyNoteDirectories(noteID: UUID, attachmentsRoot: URL) {
        let prefixes = ["BlockDocuments", "MigratedDocuments"]
        let fileManager = FileManager.default

        for prefix in prefixes {
            let noteDirectory = attachmentsRoot
                .appendingPathComponent(prefix, isDirectory: true)
                .appendingPathComponent(noteID.uuidString, isDirectory: true)
            guard fileManager.fileExists(atPath: noteDirectory.path) else { continue }

            let children = (try? fileManager.contentsOfDirectory(atPath: noteDirectory.path)) ?? []
            if children.isEmpty {
                try? fileManager.removeItem(at: noteDirectory)
                removeEmptyParents(startingAt: noteDirectory.deletingLastPathComponent(), stopAt: attachmentsRoot)
            }
        }
    }

    private func removeEmptyParents(startingAt directoryURL: URL, stopAt rootURL: URL) {
        let fileManager = FileManager.default
        var currentDirectory = directoryURL
        let rootPath = rootURL.standardizedFileURL.path

        while currentDirectory.standardizedFileURL.path.hasPrefix(rootPath),
              currentDirectory.standardizedFileURL.path != rootPath {
            let children = (try? fileManager.contentsOfDirectory(atPath: currentDirectory.path)) ?? []
            if !children.isEmpty {
                break
            }

            try? fileManager.removeItem(at: currentDirectory)
            currentDirectory = currentDirectory.deletingLastPathComponent()
        }
    }
    
    func moveNote(id: UUID, toFolderID: UUID?, toFolderName: String) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )

        if let entity = try? context.fetch(descriptor).first {
            entity.folderID = toFolderID
            entity.folderName = toFolderName
            entity.updatedAt = Date()
            try? context.save()
            fetchData()
        }
    }
    
    // MARK: - Encrypted Folder Management
    
    /// 加载加密文件夹
    func loadEncryptedFolders() {
        if let data = UserDefaults.standard.data(forKey: encryptedFoldersKey),
           let folders = try? JSONDecoder().decode([EncryptedFolder].self, from: data) {
            self.encryptedFolders = folders.sorted { $0.order < $1.order }
        }
    }
    
    /// 保存加密文件夹
    private func saveEncryptedFolders() {
        if let data = try? JSONEncoder().encode(encryptedFolders) {
            UserDefaults.standard.set(data, forKey: encryptedFoldersKey)
        }
    }
    
    /// 创建加密文件夹
    func createEncryptedFolder(name: String) {
        let maxOrder = encryptedFolders.map { $0.order }.max() ?? 0
        let newFolder = EncryptedFolder(name: name, order: maxOrder + 1)
        encryptedFolders.append(newFolder)
        saveEncryptedFolders()
        
        // 保存文件夹名称到 UserDefaults 以便查找
        let key = "encrypted_folder_name_\(newFolder.id.uuidString)"
        UserDefaults.standard.set(name, forKey: key)
    }
    
    /// 删除加密文件夹
    func deleteEncryptedFolder(id: UUID) {
        // 将该文件夹中的笔记移出加密状态
        let notesInFolder = notes.filter { 
            EncryptedFolderManager.shared.getEncryptedFolderID(for: $0) == id 
        }
        for note in notesInFolder {
            moveNote(id: note.id, toFolderID: nil, toFolderName: "未分类")
        }
        
        encryptedFolders.removeAll { $0.id == id }
        saveEncryptedFolders()
        
        // 删除文件夹名称
        let key = "encrypted_folder_name_\(id.uuidString)"
        UserDefaults.standard.removeObject(forKey: key)
    }
    
    /// 重命名加密文件夹
    func renameEncryptedFolder(id: UUID, newName: String) {
        if let index = encryptedFolders.firstIndex(where: { $0.id == id }) {
            encryptedFolders[index].name = newName
            saveEncryptedFolders()
        }
        
        // 更新文件夹名称
        let key = "encrypted_folder_name_\(id.uuidString)"
        UserDefaults.standard.set(newName, forKey: key)
        
        // 更新该文件夹中所有笔记的 folder 名称
        let notesInFolder = notes.filter { 
            EncryptedFolderManager.shared.getEncryptedFolderID(for: $0) == id 
        }
        for var note in notesInFolder {
            // 使用 encryptNote 来更新笔记信息
            EncryptedFolderManager.shared.encryptNote(&note, to: id)
            // 更新 folder 名称
            note.folder = "🔒 " + newName
            // 保存到数据库
            moveNote(id: note.id, toFolderID: note.folderID, toFolderName: note.folder)
        }
    }
    
    /// 排序加密文件夹
    func reorderEncryptedFolders(fromOffsets: IndexSet, toOffset: Int) {
        var reordered = encryptedFolders
        reordered.move(fromOffsets: fromOffsets, toOffset: toOffset)
        for (index, folder) in reordered.enumerated() {
            if let idx = encryptedFolders.firstIndex(where: { $0.id == folder.id }) {
                encryptedFolders[idx].order = index
            }
        }
        saveEncryptedFolders()
    }
    
    /// 创建加密笔记
    func createEncryptedNote(in folderID: UUID? = nil) -> Note? {
        guard let context = modelContext else { return nil }
        guard let library = ensureBlockDocumentLibrary(in: context) else { return nil }
        
        let targetFolderID: UUID?
        let encryptedFolderName: String
        if let folderID = folderID,
           let folder = encryptedFolders.first(where: { $0.id == folderID }) {
            targetFolderID = folderID
            encryptedFolderName = "🔒 " + folder.name
        } else {
            // 默认放入第一个加密文件夹
            if let firstFolder = encryptedFolders.first {
                targetFolderID = firstFolder.id
                encryptedFolderName = "🔒 " + firstFolder.name
            } else {
                // 没有加密文件夹，创建一个默认的
                let defaultFolderID = UUID()
                targetFolderID = defaultFolderID
                encryptedFolderName = "🔒 加密笔记"
                let key = "encrypted_folder_name_\(defaultFolderID.uuidString)"
                UserDefaults.standard.set("加密笔记", forKey: key)
            }
        }
        
        let createdAt = Date()
        let entity = BlockDocumentNoteEntity(
            id: UUID(),
            libraryID: library.id,
            title: "",
            createdAt: createdAt,
            updatedAt: createdAt,
            folderID: targetFolderID,
            folderName: encryptedFolderName,
            reminderAt: nil,
            recurrenceRule: "none",
            version: 0,
            tagIDs: "",
            viewMode: NoteViewMode.text.rawValue,
            deletedAt: nil,
            originalFolderID: nil,
            originalFolderName: nil,
            documentSchemaVersion: "1.0",
            documentSource: "app",
            blockCount: 0,
            assetCount: 0
        )
        context.insert(entity)
        library.noteCount += 1
        try? context.save()
        
        fetchData()
        
        if var note = notes.first(where: { $0.id == entity.id }) {
            EncryptedFolderManager.shared.encryptNote(&note, to: targetFolderID)
            
            let idToMatch = note.id
            let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate { $0.id == idToMatch }
            )
            if let entityToUpdate = try? context.fetch(descriptor).first {
                entityToUpdate.folderID = note.folderID
                entityToUpdate.folderName = note.folder
                entityToUpdate.updatedAt = Date()
                try? context.save()
            }
            
            fetchData()
            return notes.first(where: { $0.id == note.id })
        }
        
        return nil
    }
}

extension NSAttributedString.Key {
    static let notebookImageWidth = NSAttributedString.Key("NotebookImageWidth")
    static let notebookImageHeight = NSAttributedString.Key("NotebookImageHeight")
    static let notebookTableData = NSAttributedString.Key("NotebookTableData")
    static let notebookHeadingLevel = NSAttributedString.Key("NotebookHeadingLevel")
    static let notebookExplicitBold = NSAttributedString.Key("NotebookExplicitBold")
    static let notebookExplicitItalic = NSAttributedString.Key("NotebookExplicitItalic")
    static let notebookExplicitFontFamily = NSAttributedString.Key("NotebookExplicitFontFamily")
    static let notebookExplicitFontSize = NSAttributedString.Key("NotebookExplicitFontSize")
    static let notebookExplicitForegroundColor = NSAttributedString.Key("NotebookExplicitForegroundColor")
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
            .baselineOffset,
            .notebookImageWidth,
            .notebookImageHeight,
            .notebookTableData,
            .notebookHeadingLevel,
            .notebookExplicitBold,
            .notebookExplicitItalic,
            .notebookExplicitFontFamily,
            .notebookExplicitFontSize,
            .notebookExplicitForegroundColor
        ]

        // 先确保所有复选框附件和表格附件的图像已生成
        print("[StorageDebug] cleanedForStorage: checking attachments...")
        mutable.enumerateAttribute(.attachment, in: range, options: []) { value, attrRange, _ in
            if let checkbox = value as? CheckboxTextAttachment {
                print("[StorageDebug] Found CheckboxTextAttachment, calling prepareForSaving")
                checkbox.prepareForSaving()
            }
            if let tableAttachment = value as? TableTextAttachment {
                print("[StorageDebug] Found TableTextAttachment, calling prepareForSaving")
                tableAttachment.prepareForSaving()
                if let data = try? JSONEncoder().encode(tableAttachment.tableData) {
                    print("[TableTrace] cleanedForStorage write notebookTableData bytes=\(data.count) rows=\(tableAttachment.tableData.rowCount)")
                    mutable.addAttribute(.notebookTableData, value: data, range: attrRange)
                } else {
                    print("[TableTrace] cleanedForStorage failed to encode tableData")
                }
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
}
