import SwiftUI
import SwiftData
import Combine

struct NoteContentRetentionPolicy {
    static let maximumLoadedNoteCount = 0

    static func initialContentIDs(
        existingNoteIDs: Set<UUID>,
        recentSelectedNoteIDs: [UUID],
        lastSelectedNoteID: UUID?,
        fallbackNoteID: UUID?
    ) -> Set<UUID> {
        // 列表初始化只读取元数据；正文统一在用户选中后异步加载。
        []
    }
}

@MainActor
final class NoteStore: ObservableObject {
    @Published var notes: [Note] = []
    @Published var folders: [Folder] = []
    @Published var todoItems: [TodoItem] = []
    @Published var todoLists: [TodoList] = []
    @Published var tags: [Tag] = []
    @Published var encryptedFolders: [EncryptedFolder] = []
    @Published private(set) var readingPositions: [UUID: NoteReadingPosition] = [:]
    @Published private(set) var loadingNoteIDs: Set<UUID> = []
    @Published private(set) var noteContentLoadErrors: [UUID: String] = [:]

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
    /// 用于通知/外部入口跳转的选中 Todo ID
    @Published var selectedTodoId: UUID?
    /// 用于菜单栏 Popover 跳转的选中文件夹
    @Published var selectedFolderForNavigation: String?
    
    var modelContext: ModelContext?
    private var searchableTextCache: [UUID: String] = [:]
    /// 上一次 fetchData 拉取的 library ID，用于检测库切换并触发缓存全量清空
    private var lastFetchedLibraryID: UUID?
    private let plainTextDecoder = JSONDecoder()
    private var contentLoadGenerations: [UUID: UInt64] = [:]
    
    private let encryptedFoldersKey = "encrypted_folders"
    private let persistenceController: PersistenceController
    private let storageLocationManager: StorageLocationManager
    private let noteSaveManager: NoteSaveManager
    private let autoSyncCoordinator: AutoSyncCoordinator
    private let encryptedFolderManager: EncryptedFolderManager
    
    /// 获取所有加密笔记
    var encryptedNotes: [Note] {
        return activeNotes.filter { encryptedFolderManager.isEncrypted(note: $0) }
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
        context.saveLogging("NoteStore.ensureBlockDocumentLibrary")
        return library
    }
    
    convenience init() {
        self.init(
            persistenceController: .shared,
            storageLocationManager: .shared,
            noteSaveManager: .shared,
            autoSyncCoordinator: .shared,
            encryptedFolderManager: .shared
        )
    }

    init(
        persistenceController: PersistenceController,
        storageLocationManager: StorageLocationManager,
        noteSaveManager: NoteSaveManager,
        autoSyncCoordinator: AutoSyncCoordinator,
        encryptedFolderManager: EncryptedFolderManager
    ) {
        self.persistenceController = persistenceController
        self.storageLocationManager = storageLocationManager
        self.noteSaveManager = noteSaveManager
        self.autoSyncCoordinator = autoSyncCoordinator
        self.encryptedFolderManager = encryptedFolderManager
        setupModelContext()
    }

    /// 从外部设置 ModelContext（用于 AppDelegate 注入）
    func setContext(_ context: ModelContext) {
        self.modelContext = context
        fetchData()
    }

    private func setupModelContext() {
        // 如果 PersistenceController 已经配置了容器，使用它的容器
        if let container = persistenceController.modelContainer {
            self.modelContext = ModelContext(container)
            fetchData()
            return
        }
        
        // 如果没有配置，尝试从 StorageLocationManager 获取存储位置并创建容器
        let location = storageLocationManager
        guard location.isConfigured,
              let _ = location.baseDirectoryURL else {
            Logger.shared.log(.storage, .debug, "NoteStore: Storage not configured yet, skipping fetch")
            return
        }
        
        do {
            let container = try PersistenceController.makeModelContainer(
                storageLocationManager: location,
                migrationReason: "NoteStore.setupModelContext"
            )
            
            self.modelContext = ModelContext(container)
            fetchData()
        } catch {
            Logger.shared.log(.storage, .error, "NoteStore: Failed to setup ModelContext: \(error.localizedDescription)")
        }
    }
    
    func fetchData() {
        guard let context = modelContext else {
            Logger.shared.log(.storage, .debug, "NoteStore: modelContext is nil, skipping fetch")
            return
        }
        
        do {
            guard let library = ensureBlockDocumentLibrary(in: context) else { return }
            cleanupExpiredOneTimeReminders(context: context)
            try loadBlockDocumentData(context: context, library: library)
            readingPositions = Dictionary(
                uniqueKeysWithValues: try NoteReadingPositionStore.all(context: context).map { ($0.noteID, $0) }
            )
            loadEncryptedFolders()
            reschedulePendingTodoReminders()
        } catch {
            Logger.shared.log(.storage, .error, "Fetch failed: \(error.localizedDescription)")
        }
    }

    func readingPosition(for noteID: UUID) -> NoteReadingPosition? {
        readingPositions[noteID]
    }

    func recordReadingPosition(
        noteID: UUID,
        anchorUTF16Offset: Int,
        viewportOffsetFraction: Double
    ) {
        guard let context = modelContext else { return }
        let clampedFraction = min(max(viewportOffsetFraction, -1), 1)
        if let current = readingPositions[noteID],
           current.anchorUTF16Offset == max(0, anchorUTF16Offset),
           abs(current.viewportOffsetFraction - clampedFraction) < 0.001 {
            return
        }
        let position = NoteReadingPosition(
            noteID: noteID,
            anchorUTF16Offset: max(0, anchorUTF16Offset),
            viewportOffsetFraction: clampedFraction,
            updatedAt: Date(),
            deviceID: BlockDocumentNoteVersionStore.currentDeviceID()
        )
        do {
            guard try NoteReadingPositionStore.merge(position, context: context) else { return }
            try context.save()
            readingPositions[noteID] = position
            autoSyncCoordinator.libraryDidChange(reason: "readingPosition")
        } catch {
            Logger.shared.log(.storage, .error, "保存阅读位置失败: \(error.localizedDescription)")
        }
    }

    private func loadBlockDocumentData(context: ModelContext, library: BlockDocumentLibraryEntity) throws {
        let libraryID = library.id
        // 库切换时一次性清空缓存（避免跨库缓存污染）；同库刷新保留缓存条目。
        if lastFetchedLibraryID != libraryID {
            searchableTextCache.removeAll()
            lastFetchedLibraryID = libraryID
        }
        // 注意：同库刷新不再做 searchableTextCache.removeAll()。
        // 单笔记粒度的失效已由 save/delete 路径的 removeValue(forKey:) 处理，
        // 全量清空会让下一次搜索时所有缓存条目全部冷启动，造成不必要的 SQLite 重新拉取。

        // 把 libraryID 过滤下推到 SwiftData 的 predicate，避免 fetch 后内存全表扫描。
        let folderDescriptor = FetchDescriptor<BlockDocumentFolderEntity>(
            predicate: #Predicate<BlockDocumentFolderEntity> { $0.libraryID == libraryID },
            sortBy: [SortDescriptor(\.sortOrder)]
        )
        let tagDescriptor = FetchDescriptor<BlockDocumentTagEntity>(
            predicate: #Predicate<BlockDocumentTagEntity> { $0.libraryID == libraryID },
            sortBy: [SortDescriptor(\.createdAt)]
        )
        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> {
                $0.libraryID == libraryID && ($0.itemType == "note" || $0.itemType == "")
            },
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )
        let todoDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> {
                $0.libraryID == libraryID && $0.itemType == "todo"
            },
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )

        let folderEntities = try context.fetch(folderDescriptor)
        let tagEntities = try context.fetch(tagDescriptor)
        let noteEntities = try context.fetch(noteDescriptor)
        let todoEntities = try context.fetch(todoDescriptor)
        let didBackfillItemTypes = backfillMissingItemTypes(in: noteEntities)
        if didBackfillItemTypes {
            context.saveLogging("NoteStore.backfillMissingItemTypes")
        }
        try ensureNoteTagLinksBackfilled(for: noteEntities, libraryID: libraryID, context: context)

        let loadedContentIDs = recentNoteContentIDs(from: noteEntities)
        // 元数据刷新（例如应用重新激活）不能清空当前编辑器已经持有的正文。
        // 仅保留数据库版本仍一致的完整缓存；同步写入了新版本时自动失效并按需重载。
        let retainedLoadedNotes = Dictionary(
            uniqueKeysWithValues: notes
                .filter(\.isContentLoaded)
                .map { ($0.id, $0) }
        )
        // 注意：不再做 searchableTextCache.removeAll()。
        // 单笔记粒度的失效已由 save/delete 路径的 removeValue(forKey:) 处理，
        // 全量清空会让下一次搜索时所有缓存条目全部冷启动，造成不必要的 SQLite 重新拉取。

        self.notes = try noteEntities.map { entity in
            let retained = retainedLoadedNotes[entity.id].flatMap { cached in
                cached.version == entity.version ? cached : nil
            }
            let shouldLoadFromDatabase = loadedContentIDs.contains(entity.id) && retained == nil
            let isContentLoaded = retained != nil || shouldLoadFromDatabase
            let content: NSAttributedString
            if let retained {
                content = retained.content
            } else if shouldLoadFromDatabase {
                content = try loadFullBlockContent(
                    noteID: entity.id,
                    context: context,
                    // 已迁移过的笔记无需做旧版复选框图片像素检测启发式
                    skipLegacyCheckboxHeuristic: entity.hasLegacyCheckboxMigrated
                )
            } else {
                content = NSAttributedString(string: "")
            }
            // 优先用 entity 上持久化的 previewText（写入时一次性算好），
            // 避免对每条笔记额外做一次 blocks fetch（N+1 查询）。
            let contentPreview: String
            if isContentLoaded {
                contentPreview = Self.previewText(from: content.string)
            } else if !entity.previewText.isEmpty {
                contentPreview = entity.previewText
            } else {
                // 兜底：仅对旧数据（无缓存预览）做一次按需 fetch；
                // 下次保存会自动把 previewText 写回 entity。
                contentPreview = (try? loadPlainTextPreview(noteID: entity.id, context: context)) ?? ""
            }

            return Note(
                id: entity.id,
                title: entity.title,
                content: content,
                contentPreview: contentPreview,
                isContentLoaded: isContentLoaded,
                createdAt: entity.createdAt,
                updatedAt: entity.updatedAt,
                folderID: entity.folderID,
                folder: entity.folderName,
                reminderAt: entity.reminderAt,
                recurrenceRule: entity.recurrenceRule,
                version: entity.version,
                tagIDs: UUIDListCoding.decode(entity.tagIDs),
                viewMode: NoteViewMode(rawValue: entity.viewMode) ?? .text,
                deletedAt: entity.deletedAt,
                originalFolderID: entity.originalFolderID,
                originalFolderName: entity.originalFolderName,
                hasConflict: entity.hasConflict
            )
        }

        let noteFolderEntities = folderEntities.filter {
            (FolderType(rawValue: $0.folderType) ?? .noteFolder) == .noteFolder
        }
        let todoListEntities = folderEntities.filter {
            FolderType(rawValue: $0.folderType) == .todoList
        }

        self.folders = noteFolderEntities.map {
            Folder(
                id: $0.id,
                name: $0.name,
                sortOrder: $0.sortOrder,
                createdAt: $0.createdAt ?? Date(),
                isSystem: $0.isSystem,
                folderType: .noteFolder
            )
        }
        self.todoLists = todoListEntities.map {
            TodoList(
                id: $0.id,
                name: $0.name,
                sortOrder: $0.sortOrder,
                createdAt: $0.createdAt ?? Date(),
                isSystem: $0.isSystem
            )
        }
        self.todoItems = todoEntities.map {
            TodoItem(
                id: $0.id,
                title: $0.title,
                contentPreview: $0.previewText,
                createdAt: $0.createdAt,
                updatedAt: $0.updatedAt,
                folderID: $0.folderID,
                reminderAt: $0.reminderAt,
                recurrenceRule: $0.recurrenceRule,
                dueAt: $0.todoDueAt,
                completedAt: $0.todoCompletedAt,
                isImportant: $0.todoIsImportant,
                order: $0.todoOrder,
                linkedNoteIDs: UUIDListCoding.decode($0.linkedNoteIDs),
                deletedAt: $0.deletedAt
            )
        }
        self.tags = tagEntities.enumerated().map { index, entity in
            Tag(id: entity.id, name: entity.name, color: entity.color, sortOrder: index, createdAt: entity.createdAt)
        }
    }

    private func ensureNoteTagLinksBackfilled(
        for noteEntities: [BlockDocumentNoteEntity],
        libraryID: UUID,
        context: ModelContext
    ) throws {
        let libraryIDToMatch = libraryID
        let descriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
            predicate: #Predicate<BlockDocumentNoteTagEntity> { $0.libraryID == libraryIDToMatch }
        )
        let existingLinks = try context.fetch(descriptor)
        let linkedNoteIDs = Set(existingLinks.map(\.noteID))
        var didInsert = false

        for noteEntity in noteEntities where !linkedNoteIDs.contains(noteEntity.id) {
            let tagIDs = UUIDListCoding.decode(noteEntity.tagIDs)
            guard !tagIDs.isEmpty else { continue }

            for (sortOrder, tagID) in tagIDs.enumerated() {
                context.insert(
                    BlockDocumentNoteTagEntity(
                        noteID: noteEntity.id,
                        tagID: tagID,
                        libraryID: libraryID,
                        sortOrder: sortOrder
                    )
                )
            }
            didInsert = true
        }

        if didInsert {
            context.saveLogging("NoteStore.ensureNoteTagLinksBackfilled")
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
            Logger.shared.log(.storage, .error, "Failed to decode RTFD: \(error.localizedDescription)")
            return NSAttributedString(string: "")
        }
    }

    private func loadBlockBackedContent(
        blocks: [BlockDocumentBlockEntity],
        assetsByID: [String: BlockDocumentAssetEntity],
        attachmentsRoot: URL?,
        skipLegacyCheckboxHeuristic: Bool = false
    ) -> NSAttributedString {
        BlockDocumentAttributedStringBuilder(
            attachmentsRoot: attachmentsRoot,
            skipLegacyCheckboxHeuristic: skipLegacyCheckboxHeuristic
        )
            .build(blocks: blocks, assetsByID: assetsByID)
    }

    private func recentNoteContentIDs(from noteEntities: [BlockDocumentNoteEntity]) -> Set<UUID> {
        let existingNoteIDs = Set(noteEntities.map(\.id))
        return NoteContentRetentionPolicy.initialContentIDs(
            existingNoteIDs: existingNoteIDs,
            recentSelectedNoteIDs: AppSettings.shared.recentSelectedNoteIDs,
            lastSelectedNoteID: AppSettings.shared.lastSelectedNoteID,
            fallbackNoteID: noteEntities.first?.id
        )
    }

    private static func normalizedItemType(_ itemType: String) -> String {
        itemType.trimmingCharacters(in: .whitespacesAndNewlines) == "todo" ? "todo" : "note"
    }

    private func backfillMissingItemTypes(in entities: [BlockDocumentNoteEntity]) -> Bool {
        var changed = false
        for entity in entities {
            let normalized = Self.normalizedItemType(entity.itemType)
            if entity.itemType != normalized {
                entity.itemType = normalized
                changed = true
            }
        }
        return changed
    }

    private func fetchBlocks(
        noteID: UUID,
        context: ModelContext,
        limit: Int? = nil
    ) throws -> [BlockDocumentBlockEntity] {
        let idToMatch = noteID
        var descriptor = FetchDescriptor<BlockDocumentBlockEntity>(
            predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == idToMatch },
            sortBy: [SortDescriptor(\.position)]
        )
        if let limit {
            descriptor.fetchLimit = limit
        }
        return try context.fetch(descriptor)
    }

    private func fetchAssets(
        noteID: UUID,
        context: ModelContext
    ) throws -> [BlockDocumentAssetEntity] {
        let idToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentAssetEntity>(
            predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == idToMatch }
        )
        return try context.fetch(descriptor)
    }

    /// 查找笔记属性元数据（如 hasLegacyCheckboxMigrated 标记）
    private func fetchNoteEntity(id: UUID, context: ModelContext) throws -> BlockDocumentNoteEntity? {
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        return try context.fetch(descriptor).first
    }

    private func loadFullBlockContent(noteID: UUID, context: ModelContext, skipLegacyCheckboxHeuristic: Bool = false) throws -> NSAttributedString {
        let blocks = try fetchBlocks(noteID: noteID, context: context)
        let assets = Dictionary(uniqueKeysWithValues: try fetchAssets(noteID: noteID, context: context).map { ($0.assetID, $0) })
        let attachmentsRoot = try? storageLocationManager.attachmentsDirectoryURL()

        return Self.fixCheckboxAttachments(
            in: loadBlockBackedContent(
                blocks: blocks,
                assetsByID: assets,
                attachmentsRoot: attachmentsRoot,
                skipLegacyCheckboxHeuristic: skipLegacyCheckboxHeuristic
            )
        )
    }

    private func loadPlainTextPreview(noteID: UUID, context: ModelContext) throws -> String {
        let blocks = try fetchBlocks(noteID: noteID, context: context, limit: 8)
        return Self.previewText(from: plainText(from: blocks, maxCharacters: 300))
    }

    func loadSearchableText(noteID: UUID, context: ModelContext) throws -> String {
        if let cached = searchableTextCache[noteID] {
            return cached
        }

        let blocks = try fetchBlocks(noteID: noteID, context: context)
        let text = plainText(from: blocks)
        searchableTextCache[noteID] = text
        return text
    }

    private func plainText(from blocks: [BlockDocumentBlockEntity], maxCharacters: Int? = nil) -> String {
        var result = ""

        func append(_ rawText: String) {
            let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            if !result.isEmpty {
                result.append("\n")
            }

            if let maxCharacters {
                let remaining = maxCharacters - result.count
                guard remaining > 0 else { return }
                result.append(contentsOf: text.prefix(remaining))
            } else {
                result.append(text)
            }
        }

        for block in blocks {
            if let maxCharacters, result.count >= maxCharacters {
                break
            }
            append(plainText(for: block))
        }

        return result
    }

    private func plainText(for block: BlockDocumentBlockEntity) -> String {
        if let payload = block.textPayload,
           let spans = try? plainTextDecoder.decode([BlockDocumentTextSpanPayload].self, from: payload) {
            return spans.map(\.text).joined()
        }

        if block.kind == "table",
           let payloadData = block.tablePayload,
           let payload = try? plainTextDecoder.decode(BlockDocumentTablePayload.self, from: payloadData) {
            return payload.rows
                .map { $0.joined(separator: " ") }
                .joined(separator: "\n")
        }

        switch block.kind {
        case "image":
            return "[图片]"
        case "audio":
            return "[音频]"
        default:
            return ""
        }
    }

    nonisolated static func previewText(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.components(separatedBy: .newlines)
        return lines.prefix(2).joined(separator: " ")
    }

    @discardableResult
    func ensureNoteContentLoaded(
        id: UUID?,
        rememberSelection: Bool = false,
        pruneAfterLoad: Bool = true
    ) -> Note? {
        guard let id else { return nil }
        if rememberSelection {
            AppSettings.shared.recordRecentlySelectedNote(id)
        }

        guard let context = modelContext,
              let index = notes.firstIndex(where: { $0.id == id }) else {
            return nil
        }

        if !notes[index].isContentLoaded {
            do {
                // 查询 entity 上的迁移标记：已迁移过则跳过开销巨大的像素检测启发式
                let skipHeuristic = try fetchNoteEntity(id: id, context: context)?.hasLegacyCheckboxMigrated == true
                let content = try loadFullBlockContent(
                    noteID: id,
                    context: context,
                    skipLegacyCheckboxHeuristic: skipHeuristic
                )
                notes[index].content = content
                notes[index].contentPreview = Self.previewText(from: content.string)
                notes[index].isContentLoaded = true
            } catch {
                DebugLog.storage("Failed to load note content for \(id): \(error)", level: .warn)
            }
        }

        if pruneAfterLoad {
            pruneLoadedNoteContents(keeping: id)
        }

        return notes.first(where: { $0.id == id })
    }

    /// 在独立 SwiftData actor 中抓取不可变快照，并在主线程分批构建富文本。
    /// 任务取消、版本变化或快速切换时不会把过期正文写回内存。
    @discardableResult
    func ensureNoteContentLoadedAsync(
        id: UUID?,
        rememberSelection: Bool = false,
        pruneAfterLoad: Bool = true
    ) async -> Note? {
        guard let id else { return nil }
        if rememberSelection {
            AppSettings.shared.recordRecentlySelectedNote(id)
        }

        guard let context = modelContext else {
            noteContentLoadErrors[id] = "数据库尚未就绪，请稍后重试。"
            return nil
        }
        guard let index = notes.firstIndex(where: { $0.id == id }) else {
            noteContentLoadErrors[id] = "笔记不存在或已被删除。"
            return nil
        }
        if notes[index].isContentLoaded {
            if pruneAfterLoad {
                pruneLoadedNoteContents(keeping: id)
            }
            return notes[index]
        }

        let generation = (contentLoadGenerations[id] ?? 0) &+ 1
        contentLoadGenerations[id] = generation
        loadingNoteIDs.insert(id)
        noteContentLoadErrors.removeValue(forKey: id)
        let interval = Logger.shared.beginInterval(
            .storage,
            "asyncNoteContentLoad",
            metadata: "noteID=\(id.uuidString.prefix(8)) expectedVersion=\(notes[index].version)"
        )
        defer {
            if contentLoadGenerations[id] == generation {
                loadingNoteIDs.remove(id)
            }
        }

        do {
            let container = context.container
            let attachmentsRoot = try? storageLocationManager.attachmentsDirectoryURL()
            let maximumSnapshotAttempts = 3

            for attempt in 1...maximumSnapshotAttempts {
                // 每次都在后台创建新的 ModelActor/ModelContext，避免复用旧上下文缓存。
                let loader = await Task.detached(priority: .userInitiated) {
                    BlockDocumentContentLoader(modelContainer: container)
                }.value
                let snapshot = try await loader.snapshot(noteID: id)
                try Task.checkCancellation()

                let content = try await BlockDocumentAttributedStringBuilder(
                    attachmentsRoot: attachmentsRoot,
                    skipLegacyCheckboxHeuristic: snapshot.hasLegacyCheckboxMigrated
                ).buildIncrementally(
                    blocks: snapshot.blocks,
                    assetsByID: snapshot.assetsByID
                )
                try Task.checkCancellation()

                guard contentLoadGenerations[id] == generation else {
                    interval.end(.debug, "discarded=staleGeneration")
                    return nil
                }
                guard let applyIndex = notes.firstIndex(where: { $0.id == id }) else {
                    noteContentLoadErrors[id] = "笔记不存在或已被删除。"
                    interval.end(.warn, "discarded=missingNote")
                    return nil
                }
                if notes[applyIndex].isContentLoaded {
                    interval.end(.debug, "discarded=alreadyLoaded")
                    return notes[applyIndex]
                }

                // 构建富文本期间同步或保存可能写入新版本。用全新的后台上下文复核，
                // 若已变化则重新抓取，绝不把旧正文覆盖到新版本上。
                let verifier = await Task.detached(priority: .userInitiated) {
                    BlockDocumentContentLoader(modelContainer: container)
                }.value
                let latestVersion = try await verifier.version(noteID: id)
                try Task.checkCancellation()
                if latestVersion != snapshot.version {
                    Logger.shared.log(
                        .storage,
                        .warn,
                        "笔记加载期间版本变化，重新读取 noteID=\(id.uuidString.prefix(8)) snapshot=\(snapshot.version) latest=\(latestVersion) attempt=\(attempt)"
                    )
                    if attempt < maximumSnapshotAttempts {
                        continue
                    }
                    noteContentLoadErrors[id] = "笔记内容正在持续更新，请稍后重试。"
                    interval.end(.warn, "discarded=databaseVersionChanged attempts=\(attempt)")
                    return nil
                }

                let memoryVersion = notes[applyIndex].version
                if memoryVersion != snapshot.version {
                    // 未加载的 Note 只持有列表元数据；数据库快照已经过二次版本复核，
                    // 可以安全修正异步导入/同步后尚未合并到列表的版本号。
                    notes[applyIndex].version = snapshot.version
                    Logger.shared.log(
                        .storage,
                        .warn,
                        "已协调列表与数据库版本 noteID=\(id.uuidString.prefix(8)) memory=\(memoryVersion) database=\(snapshot.version)"
                    )
                }
                notes[applyIndex].content = Self.fixCheckboxAttachments(in: content)
                notes[applyIndex].contentPreview = Self.previewText(from: content.string)
                notes[applyIndex].isContentLoaded = true
                if pruneAfterLoad {
                    pruneLoadedNoteContents(keeping: id)
                }
                interval.end(
                    .info,
                    "blocks=\(snapshot.blocks.count) characters=\(content.length) attempts=\(attempt)"
                )
                return notes[applyIndex]
            }
            return nil
        } catch is CancellationError {
            interval.end(.debug, "cancelled=true")
            return nil
        } catch {
            noteContentLoadErrors[id] = error.localizedDescription
            Logger.shared.log(
                .storage,
                .error,
                "异步加载笔记失败 noteID=\(id.uuidString.prefix(8)): \(error.localizedDescription)"
            )
            interval.end(.error, "error=\(error.localizedDescription)")
            return nil
        }
    }

    func retryNoteContentLoad(id: UUID) {
        noteContentLoadErrors.removeValue(forKey: id)
        contentLoadGenerations[id] = (contentLoadGenerations[id] ?? 0) &+ 1
    }

    func refreshRecentNoteContentWindow(keeping keepID: UUID? = nil) {
        let selectedID = keepID ?? AppSettings.shared.recentSelectedNoteIDs.first
        _ = ensureNoteContentLoaded(id: selectedID, pruneAfterLoad: false)
        pruneLoadedNoteContents(keeping: selectedID)
    }

    func noteMatchesSearch(_ note: Note, query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return true }

        if note.title.localizedCaseInsensitiveContains(q) {
            return true
        }

        if note.isContentLoaded {
            return note.content.string.localizedCaseInsensitiveContains(q)
        }

        guard let context = modelContext else {
            return note.contentPreview.localizedCaseInsensitiveContains(q)
        }

        do {
            return try loadSearchableText(noteID: note.id, context: context)
                .localizedCaseInsensitiveContains(q)
        } catch {
            DebugLog.storage("Failed to load searchable text for \(note.id): \(error)", level: .warn)
            return note.contentPreview.localizedCaseInsensitiveContains(q)
        }
    }

    func markNoteContentUpdated(id: UUID, content: NSAttributedString) {
        // 任何已保存/编辑的新正文都使后台旧快照失效，防止迟到任务覆盖新内容。
        contentLoadGenerations[id] = (contentLoadGenerations[id] ?? 0) &+ 1
        loadingNoteIDs.remove(id)
        noteContentLoadErrors.removeValue(forKey: id)
        searchableTextCache.removeValue(forKey: id)
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        notes[index].content = content
        notes[index].contentPreview = Self.previewText(from: content.string)
        notes[index].isContentLoaded = true
    }

    private func pruneLoadedNoteContents(keeping keepID: UUID? = nil) {
        for index in notes.indices {
            let noteID = notes[index].id
            guard noteID != keepID, notes[index].isContentLoaded else { continue }
            notes[index].content = NSAttributedString(string: "")
            notes[index].isContentLoaded = false
        }
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
                let isOneTime = entity.recurrenceRule.isEmpty || entity.recurrenceRule == "none"
                if isOneTime, let date = entity.reminderAt, date < now {
                    entity.reminderAt = nil
                    changed = true
                }
            }
            if changed {
                context.saveLogging("NoteStore.cleanupExpiredOneTimeReminders")
            }
        } catch {
            DebugLog.storage("Cleanup expired reminders failed: \(error)", level: .warn)
        }
    }

    private func reschedulePendingTodoReminders() {
        let now = Date()
        // 与系统通知中心对账：已完成或已关闭提醒的 Todo 不能保留历史重复通知。
        for item in activeTodoItems where item.isCompleted || item.reminderAt == nil {
            NotificationManager.shared.cancel(noteID: item.id)
        }

        let pending = activeTodoItems.filter { item in
            guard !item.isCompleted, let reminderAt = item.reminderAt else { return false }
            return item.recurrenceRule != "none" || reminderAt > now
        }

        for item in pending {
            Task { @MainActor in
                // fetchData 后任务才可能真正执行；期间 Todo 可能已完成或提醒已被修改。
                guard let currentItem = self.activeTodoItems.first(where: { $0.id == item.id }),
                      !currentItem.isCompleted,
                      let reminderAt = currentItem.reminderAt else {
                    NotificationManager.shared.cancel(noteID: item.id)
                    return
                }
                await NotificationManager.shared.schedule(
                    todoID: currentItem.id,
                    title: currentItem.title.isEmpty ? "Todo 提醒" : currentItem.title,
                    body: currentItem.contentPreview,
                    reminderAt: reminderAt,
                    recurrence: currentItem.recurrenceRule
                )
            }
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
                if isCheckboxDebugEnabled { DebugLog.attachment("Restored image from contents at pos=\(location), size=\(image?.size ?? .zero)", level: .debug) }
            }

            // 如果仍然没有图像，尝试通过 fileWrapper 恢复
            if image == nil, let fileWrapper = attachment.fileWrapper, fileWrapper.isRegularFile {
                if let data = fileWrapper.regularFileContents {
                    image = NSImage(data: data)
                    imageSource = "fileWrapper"
                    if isCheckboxDebugEnabled { DebugLog.attachment("Restored image from fileWrapper at pos=\(location), size=\(image?.size ?? .zero)", level: .debug) }
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
            DebugLog.storage("Found \(debugInfo.count) attachments:", level: .debug)
            for (location, type, isChecked) in debugInfo {
                DebugLog.storage("  [CheckboxDebug] pos=\(location), type=\(type), checked=\(isChecked)", level: .debug)
            }
            DebugLog.storage("Replacing \(replacements.count) attachments", level: .debug)
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
            if isCheckboxDebugEnabled { DebugLog.attachment("Failed to get CGImage", level: .warn) }
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
            if isCheckboxDebugEnabled { DebugLog.attachment("Failed to create CGContext", level: .warn) }
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
        
        if isCheckboxDebugEnabled { DebugLog.attachment("Center pixel: R=\(String(format: "%.2f", r)), G=\(String(format: "%.2f", g)), B=\(String(format: "%.2f", b)), A=\(String(format: "%.2f", a))", level: .debug) }
        
        // 判断逻辑：
        // - 已选中：中心有黄色（R高，G高，B低）或深色
        // - 未选中：中心是白色（R=G=B=1）或透明（A=0）
        
        // 如果透明度很低，认为是未选中
        if a < 0.5 {
            if isCheckboxDebugEnabled { DebugLog.attachment("Low alpha, assuming unchecked", level: .debug) }
            return false
        }
        
        // 计算亮度
        let brightness = (r + g + b) / 3.0
        if isCheckboxDebugEnabled { DebugLog.attachment("Brightness: \(String(format: "%.2f", brightness))", level: .debug) }
        
        // 如果亮度很高（接近白色），认为是未选中
        if brightness > 0.9 {
            if isCheckboxDebugEnabled { DebugLog.attachment("High brightness, assuming unchecked", level: .debug) }
            return false
        }
        
        // 检查是否是黄色（选中状态的特征）
        // 黄色：R和G都很高，B很低
        let isYellow = r > 0.7 && g > 0.7 && b < 0.5
        if isYellow {
            if isCheckboxDebugEnabled { DebugLog.attachment("Yellow detected, assuming checked", level: .debug) }
            return true
        }
        
        // 如果亮度中等偏低，可能是填充色（选中）
        if brightness < 0.7 {
            if isCheckboxDebugEnabled { DebugLog.attachment("Medium brightness, assuming checked", level: .debug) }
            return true
        }
        
        if isCheckboxDebugEnabled { DebugLog.attachment("Uncertain, defaulting to unchecked", level: .debug) }
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
            assetCount: 0,
            itemType: "note"
        )
        context.insert(entity)
        library.noteCount += 1
        context.saveLogging("NoteStore.addNote")
        fetchData()
        return activeNotes.first(where: { $0.id == entity.id })
    }

    /// 将外部文本文件作为一篇新笔记写入数据库；正文保存成功后再应用加密目录和标签。
    @discardableResult
    func importTextNote(
        _ document: ImportedTextNoteFile,
        target: TextNoteImportTarget
    ) -> Note? {
        guard let context = modelContext else { return nil }
        guard let createdNote = addNote(
            title: document.title,
            folderID: target.folderID,
            folderName: target.folderName
        ) else { return nil }

        let content = NSAttributedString(string: document.content)
        guard let request = noteSaveManager.createRequest(
            noteID: createdNote.id,
            title: document.title,
            folderID: target.folderID,
            folder: target.folderName,
            reminderAt: nil,
            recurrenceRule: "none",
            content: content,
            reason: "fileDropImport"
        ) else {
            rollbackFailedTextImport(noteID: createdNote.id, context: context)
            return nil
        }

        guard case .success = noteSaveManager.saveImmediately(request: request) else {
            rollbackFailedTextImport(noteID: createdNote.id, context: context)
            return nil
        }
        markNoteContentUpdated(id: createdNote.id, content: content)

        if let encryptedFolderID = target.encryptedFolderID,
           moveNoteToEncryptedFolder(id: createdNote.id, to: encryptedFolderID) == nil {
            Logger.shared.log(
                .storage,
                .error,
                "Text import saved but could not apply encrypted folder: noteID=\(createdNote.id.uuidString.prefix(8))"
            )
            rollbackFailedTextImport(noteID: createdNote.id, context: context)
            return nil
        }
        if let tagID = target.tagID {
            addTagToNote(tagID: tagID, noteID: createdNote.id)
        }

        return ensureNoteContentLoaded(id: createdNote.id, pruneAfterLoad: false)
    }

    /// 大文本拖放专用异步路径。块编码、SwiftData 插入和首个历史版本写入都在
    /// 独立 ModelActor 中完成，主线程只负责创建元数据和最终发布完整正文。
    @discardableResult
    func importTextNoteAsync(
        _ document: ImportedTextNoteFile,
        target: TextNoteImportTarget
    ) async -> Note? {
        guard let context = modelContext else { return nil }
        guard let createdNote = addNote(
            title: document.title,
            folderID: target.folderID,
            folderName: target.folderName
        ) else { return nil }

        let interval = Logger.shared.beginInterval(
            .storage,
            "asyncTextNoteImport",
            metadata: "noteID=\(createdNote.id.uuidString.prefix(8)) characters=\(document.content.utf16.count)"
        )
        do {
            // 同上：后台创建 ModelActor，确保数万块的编码和插入不落回主线程。
            let container = context.container
            let worker = await Task.detached(priority: .userInitiated) {
                TextNoteImportPersistenceActor(modelContainer: container)
            }.value
            let persisted = try await worker.persist(
                noteID: createdNote.id,
                content: document.content,
                authorDeviceID: BlockDocumentNoteVersionStore.currentDeviceID()
            )
            try Task.checkCancellation()

            let idToMatch = createdNote.id
            let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
            )
            guard let entity = try context.fetch(descriptor).first else {
                throw CocoaError(.fileNoSuchFile)
            }
            entity.version = persisted.version
            entity.updatedAt = persisted.updatedAt
            entity.blockCount = persisted.blockCount
            entity.assetCount = 0
            entity.documentSchemaVersion = "1.0"
            entity.documentSource = "TextFileDrop"
            entity.previewText = NoteSaveManager.previewTextForList(from: persisted.normalizedContent)
            entity.hasLegacyCheckboxMigrated = true
            guard context.saveLogging("NoteStore.importTextNoteAsync.refreshMetadata") else {
                throw CocoaError(.fileWriteUnknown)
            }

            let content = NSAttributedString(string: persisted.normalizedContent)
            markNoteContentUpdated(id: createdNote.id, content: content)
            if let noteIndex = notes.firstIndex(where: { $0.id == createdNote.id }) {
                notes[noteIndex].version = persisted.version
                notes[noteIndex].updatedAt = persisted.updatedAt
            }

            if let encryptedFolderID = target.encryptedFolderID,
               moveNoteToEncryptedFolder(id: createdNote.id, to: encryptedFolderID) == nil {
                throw CocoaError(.fileWriteUnknown)
            }
            if let tagID = target.tagID {
                addTagToNote(tagID: tagID, noteID: createdNote.id)
            }
            if target.encryptedFolderID == nil, target.tagID == nil {
                autoSyncCoordinator.noteDidSave(noteID: createdNote.id, reason: "fileDropImport")
            }
            interval.end(
                .info,
                "blocks=\(persisted.blockCount) characters=\(content.length)"
            )
            return notes.first(where: { $0.id == createdNote.id })
        } catch is CancellationError {
            rollbackFailedTextImport(noteID: createdNote.id, context: context)
            interval.end(.debug, "cancelled=true rolledBack=true")
            return nil
        } catch {
            rollbackFailedTextImport(noteID: createdNote.id, context: context)
            Logger.shared.log(
                .storage,
                .error,
                "异步导入文本笔记失败 noteID=\(createdNote.id.uuidString.prefix(8)): \(error.localizedDescription)"
            )
            interval.end(.error, "error=\(error.localizedDescription) rolledBack=true")
            return nil
        }
    }

    private func rollbackFailedTextImport(noteID: UUID, context: ModelContext) {
        let idToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        guard let entity = try? context.fetch(descriptor).first else { return }
        let blockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
            predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == idToMatch }
        )
        let assetDescriptor = FetchDescriptor<BlockDocumentAssetEntity>(
            predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == idToMatch }
        )
        let stepDescriptor = FetchDescriptor<TodoStepEntity>(
            predicate: #Predicate<TodoStepEntity> { $0.noteID == idToMatch }
        )
        let blocks = (try? context.fetch(blockDescriptor)) ?? []
        let assets = (try? context.fetch(assetDescriptor)) ?? []
        let steps = (try? context.fetch(stepDescriptor)) ?? []

        deleteBlockDocumentArtifacts(noteID: noteID, assets: assets)
        blocks.forEach(context.delete)
        assets.forEach(context.delete)
        steps.forEach(context.delete)

        let libraryID = entity.libraryID
        context.delete(entity)

        let libraryDescriptor = FetchDescriptor<BlockDocumentLibraryEntity>(
            predicate: #Predicate<BlockDocumentLibraryEntity> { $0.id == libraryID }
        )
        if let library = try? context.fetch(libraryDescriptor).first {
            library.noteCount = max(0, library.noteCount - 1)
        }
        try? BlockDocumentNoteVersionStore.deleteHistory(noteID: noteID, context: context)
        try? NoteReadingPositionStore.delete(noteID: noteID, context: context)
        context.saveLogging("NoteStore.rollbackFailedTextImport")
        readingPositions.removeValue(forKey: noteID)
        fetchData()
    }

    // MARK: - Todo Management

    var activeTodoItems: [TodoItem] {
        todoItems.filter { !$0.isInRecycleBin }
    }

    var completedTodoItems: [TodoItem] {
        activeTodoItems.filter { $0.isCompleted }
    }

    func todoItemsForToday() -> [TodoItem] {
        let calendar = Calendar.current
        return activeTodoItems.filter { item in
            guard !item.isCompleted else { return false }
            if let dueAt = item.dueAt, calendar.isDateInToday(dueAt) {
                return true
            }
            if let reminderAt = item.reminderAt, calendar.isDateInToday(reminderAt) {
                return true
            }
            return false
        }
    }

    func importantTodoItems() -> [TodoItem] {
        activeTodoItems.filter { !$0.isCompleted && $0.isImportant }
    }

    func todoItems(in listID: UUID?) -> [TodoItem] {
        activeTodoItems.filter { $0.folderID == listID }
    }

    @discardableResult
    func addTodoList(name: String) -> TodoList? {
        guard let context = modelContext else { return nil }
        guard let library = ensureBlockDocumentLibrary(in: context) else { return nil }
        let maxSortOrder = (try? context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())
            .filter { $0.libraryID == library.id && (FolderType(rawValue: $0.folderType) == .todoList) }
            .map(\.sortOrder)
            .max()) ?? -1
        let entity = BlockDocumentFolderEntity(
            id: UUID(),
            libraryID: library.id,
            name: name,
            sortOrder: maxSortOrder + 1,
            isSystem: false,
            createdAt: Date(),
            folderType: FolderType.todoList.rawValue
        )
        context.insert(entity)
        library.folderCount += 1
        context.saveLogging("NoteStore.addTodoList")
        fetchData()
        return todoLists.first(where: { $0.id == entity.id })
    }

    func updateTodoList(id: UUID, name: String) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            entity.name = name

            let todosInList = try? context.fetch(FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.folderID == idToMatch }))
            for todo in todosInList ?? [] where todo.itemType == "todo" {
                todo.folderName = name
            }

            context.saveLogging("NoteStore.updateTodoList")
            fetchData()
        }
    }

    func deleteTodoList(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            let todosInList = try? context.fetch(FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.folderID == idToMatch }))
            for todo in todosInList ?? [] where todo.itemType == "todo" {
                todo.folderID = nil
                todo.folderName = "Todo"
            }

            context.delete(entity)
            context.saveLogging("NoteStore.deleteTodoList")
            fetchData()
        }
    }

    func reorderTodoLists(fromOffsets: IndexSet, toOffset: Int) {
        guard let context = modelContext else { return }
        var reordered = todoLists
        reordered.move(fromOffsets: fromOffsets, toOffset: toOffset)
        for (index, list) in reordered.enumerated() {
            let idToMatch = list.id
            let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
            if let entity = try? context.fetch(descriptor).first {
                entity.sortOrder = index
            }
        }
        context.saveLogging("NoteStore.reorderTodoLists")
        fetchData()
    }

    @discardableResult
    func addTodo(title: String = "新任务", listID: UUID? = nil) -> TodoItem? {
        guard let context = modelContext else { return nil }
        guard let library = ensureBlockDocumentLibrary(in: context) else { return nil }
        let createdAt = Date()
        let maxOrder = todoItems(in: listID).map(\.order).max() ?? -1
        let listName = todoListName(for: listID)
        let entity = BlockDocumentNoteEntity(
            id: UUID(),
            libraryID: library.id,
            title: title,
            createdAt: createdAt,
            updatedAt: createdAt,
            folderID: listID,
            folderName: listName,
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
            assetCount: 0,
            itemType: "todo",
            todoOrder: maxOrder + 1
        )
        context.insert(entity)
        library.noteCount += 1
        context.saveLogging("NoteStore.addTodo")
        fetchData()
        return activeTodoItems.first(where: { $0.id == entity.id })
    }

    func loadTodoNotesText(id: UUID) -> String {
        guard let context = modelContext else { return "" }
        do {
            return try loadFullBlockContent(noteID: id, context: context).string
        } catch {
            DebugLog.storage("Failed to load todo notes for \(id): \(error)", level: .warn)
            return todoItems.first(where: { $0.id == id })?.contentPreview ?? ""
        }
    }

    func updateTodo(
        id: UUID,
        title: String,
        notesText: String,
        dueAt: Date?,
        reminderAt: Date?,
        recurrenceRule: String,
        isImportant: Bool,
        listID: UUID?,
        linkedNoteIDs: [UUID] = []
    ) {
        guard let context = modelContext else { return }
        let listName = todoListName(for: listID)
        let content = NSAttributedString(string: notesText)

        guard let request = noteSaveManager.createRequest(
            noteID: id,
            title: title,
            folderID: listID,
            folder: listName,
            reminderAt: reminderAt,
            recurrenceRule: recurrenceRule,
            content: content,
            reason: "todoUpdate"
        ) else {
            return
        }

        _ = noteSaveManager.saveImmediately(request: request)

        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        if let entity = try? context.fetch(descriptor).first {
            entity.itemType = "todo"
            entity.todoDueAt = dueAt
            entity.todoIsImportant = isImportant
            entity.folderID = listID
            entity.folderName = listName
            entity.linkedNoteIDs = UUIDListCoding.encode(linkedNoteIDs)
            entity.updatedAt = Date()
            entity.version = max(entity.version + 1, 1)
            context.saveLogging("NoteStore.updateTodo")
            autoSyncCoordinator.noteDidSave(noteID: id, reason: "todoUpdate")
        }

        fetchData()
    }

    func setTodoCompleted(id: UUID, completed: Bool) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        if let entity = try? context.fetch(descriptor).first {
            entity.todoCompletedAt = completed ? Date() : nil
            entity.updatedAt = Date()
            entity.version = max(entity.version + 1, 1)
            context.saveLogging("NoteStore.setTodoCompleted")
            autoSyncCoordinator.noteDidSave(noteID: id, reason: "todoCompleted")
            if completed {
                NotificationManager.shared.cancel(noteID: id)
            }
            fetchData()
        }
    }

    func deleteTodo(id: UUID) {
        moveNoteToRecycleBin(id: id)
        NotificationManager.shared.cancel(noteID: id)
        fetchData()
    }

    func steps(for todoID: UUID) -> [TodoStepEntity] {
        guard let context = modelContext else { return [] }
        let idToMatch = todoID
        let descriptor = FetchDescriptor<TodoStepEntity>(
            predicate: #Predicate<TodoStepEntity> { $0.noteID == idToMatch },
            sortBy: [SortDescriptor(\.order)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    func addTodoStep(todoID: UUID, text: String = "") {
        guard let context = modelContext,
              let todo = try? fetchNoteEntity(id: todoID, context: context) else { return }
        let maxOrder = steps(for: todoID).map(\.order).max() ?? -1
        context.insert(
            TodoStepEntity(
                noteID: todoID,
                libraryID: todo.libraryID,
                text: text,
                order: maxOrder + 1
            )
        )
        todo.updatedAt = Date()
        todo.version = max(todo.version + 1, 1)
        context.saveLogging("NoteStore.addTodoStep")
        autoSyncCoordinator.noteDidSave(noteID: todoID, reason: "todoStepAdd")
    }

    func updateTodoStep(id: UUID, text: String? = nil, checked: Bool? = nil) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<TodoStepEntity>(
            predicate: #Predicate<TodoStepEntity> { $0.id == idToMatch }
        )
        if let step = try? context.fetch(descriptor).first {
            if let text { step.text = text }
            if let checked { step.checked = checked }
            if let todo = try? fetchNoteEntity(id: step.noteID, context: context) {
                todo.updatedAt = Date()
                todo.version = max(todo.version + 1, 1)
            }
            context.saveLogging("NoteStore.updateTodoStep")
            autoSyncCoordinator.noteDidSave(noteID: step.noteID, reason: "todoStepUpdate")
        }
    }

    func deleteTodoStep(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<TodoStepEntity>(
            predicate: #Predicate<TodoStepEntity> { $0.id == idToMatch }
        )
        if let step = try? context.fetch(descriptor).first {
            let todoID = step.noteID
            context.delete(step)
            if let todo = try? fetchNoteEntity(id: todoID, context: context) {
                todo.updatedAt = Date()
                todo.version = max(todo.version + 1, 1)
            }
            context.saveLogging("NoteStore.deleteTodoStep")
            autoSyncCoordinator.noteDidSave(noteID: todoID, reason: "todoStepDelete")
        }
    }

    private func todoListName(for listID: UUID?) -> String {
        guard let listID,
              let list = todoLists.first(where: { $0.id == listID }) else {
            return "Todo"
        }
        return list.name
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
        if context.saveLogging("NoteStore.addFolder") {
            autoSyncCoordinator.libraryDidChange(reason: "addFolder")
        }
        fetchData()
    }
    
    func updateFolder(id: UUID, name: String) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            entity.name = name
            entity.updatedAt = Date()

            let notesInFolder = try? context.fetch(FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.folderID == idToMatch }))
            for note in notesInFolder ?? [] {
                note.folderName = name
            }

            if context.saveLogging("NoteStore.updateFolder") {
                autoSyncCoordinator.libraryDidChange(reason: "updateFolder")
            }
            fetchData()
        }
    }
    
    func deleteFolder(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentFolderEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            if entity.isSystem {
                DebugLog.storage("Cannot delete system folder: \(entity.name)", level: .debug)
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

            let deletedAt = Date()
            context.insert(BlockDocumentLibraryTombstoneEntity(
                itemID: id,
                itemKind: "folder",
                deletedAt: deletedAt,
                deletedByDeviceID: BlockDocumentNoteVersionStore.currentDeviceID()
            ))
            context.delete(entity)
            if context.saveLogging("NoteStore.deleteFolder") {
                autoSyncCoordinator.libraryDidChange(reason: "deleteFolder")
            }
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
                entity.updatedAt = Date()
            }
        }
        if context.saveLogging("NoteStore.reorderFolders") {
            autoSyncCoordinator.libraryDidChange(reason: "reorderFolders")
        }
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
        if context.saveLogging("NoteStore.addTag") {
            autoSyncCoordinator.libraryDidChange(reason: "addTag")
        }
        fetchData()
    }
    
    func updateTag(id: UUID, name: String? = nil, color: String? = nil) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentTagEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            if let name { entity.name = name }
            if let color { entity.color = color }
            entity.updatedAt = Date()
            if context.saveLogging("NoteStore.updateTag") {
                autoSyncCoordinator.libraryDidChange(reason: "updateTag")
            }
            fetchData()
        }
    }
    
    func deleteTag(id: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentTagEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            // 优先走关联表索引查询，避免扫描全部内存笔记
            let affectedNoteIDs = noteIDs(forTagID: id)
            let affectedNoteIDSet = Set(affectedNoteIDs)
            let notesWithTag = notes.filter { affectedNoteIDSet.contains($0.id) }
            for note in notesWithTag {
                removeTagFromNote(tagID: id, noteID: note.id)
            }

            if let library = latestBlockDocumentLibrary(in: context), library.id == entity.libraryID {
                library.tagCount = max(0, library.tagCount - 1)
            }

            context.insert(BlockDocumentLibraryTombstoneEntity(
                itemID: id,
                itemKind: "tag",
                deletedAt: Date(),
                deletedByDeviceID: BlockDocumentNoteVersionStore.currentDeviceID()
            ))
            context.delete(entity)
            if context.saveLogging("NoteStore.deleteTag") {
                autoSyncCoordinator.libraryDidChange(reason: "deleteTag")
            }
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
                entity.updatedAt = baseDate
            }
        }
        if context.saveLogging("NoteStore.reorderTags") {
            autoSyncCoordinator.libraryDidChange(reason: "reorderTags")
        }
        fetchData()
    }
    
    // MARK: - Note Tag Operations
    
    func addTagToNote(tagID: UUID, noteID: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            var currentTagIDs = UUIDListCoding.decode(entity.tagIDs)
            if !currentTagIDs.contains(tagID) {
                currentTagIDs.append(tagID)
                entity.tagIDs = UUIDListCoding.encode(currentTagIDs)
                entity.updatedAt = Date()
                entity.version = max(entity.version + 1, 1)
                // 同步更新关联表（派生索引），保证按标签筛选可走 SQLite 索引
                Self.upsertNoteTagLink(
                    noteID: noteID,
                    tagID: tagID,
                    libraryID: entity.libraryID,
                    sortOrder: currentTagIDs.count - 1,
                    context: context
                )
                if context.saveLogging("NoteStore.addTagToNote") {
                    autoSyncCoordinator.noteDidSave(noteID: noteID, reason: "addTag")
                }
                fetchData()
            }
        }
    }
    
    func removeTagFromNote(tagID: UUID, noteID: UUID) {
        guard let context = modelContext else { return }
        let idToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.id == idToMatch })
        if let entity = try? context.fetch(descriptor).first {
            var currentTagIDs = UUIDListCoding.decode(entity.tagIDs)
            currentTagIDs.removeAll { $0 == tagID }
            entity.tagIDs = UUIDListCoding.encode(currentTagIDs)
            entity.updatedAt = Date()
            entity.version = max(entity.version + 1, 1)
            // 同步删除关联表记录
            Self.deleteNoteTagLink(noteID: noteID, tagID: tagID, context: context)
            if context.saveLogging("NoteStore.removeTagFromNote") {
                autoSyncCoordinator.noteDidSave(noteID: noteID, reason: "removeTag")
            }
            if let idx = notes.firstIndex(where: { $0.id == noteID }) {
                notes[idx].tagIDs = currentTagIDs
                notes[idx].updatedAt = entity.updatedAt
            }
        }
    }
    
    // MARK: - Note Tag Link Helpers（关联表同步）

    /// 插入或更新笔记-标签关联记录（幂等）
    private static func upsertNoteTagLink(
        noteID: UUID,
        tagID: UUID,
        libraryID: UUID,
        sortOrder: Int,
        context: ModelContext
    ) {
        let noteIDToMatch = noteID
        let tagIDToMatch = tagID
        let descriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
            predicate: #Predicate {
                $0.noteID == noteIDToMatch && $0.tagID == tagIDToMatch
            }
        )
        if let existing = try? context.fetch(descriptor).first {
            existing.sortOrder = sortOrder
            return
        }
        context.insert(
            BlockDocumentNoteTagEntity(
                noteID: noteID,
                tagID: tagID,
                libraryID: libraryID,
                sortOrder: sortOrder
            )
        )
    }

    /// 删除笔记-标签关联记录
    private static func deleteNoteTagLink(noteID: UUID, tagID: UUID, context: ModelContext) {
        let noteIDToMatch = noteID
        let tagIDToMatch = tagID
        let descriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
            predicate: #Predicate {
                $0.noteID == noteIDToMatch && $0.tagID == tagIDToMatch
            }
        )
        if let links = try? context.fetch(descriptor) {
            for link in links {
                context.delete(link)
            }
        }
    }

    /// 笔记保存时全量同步关联表（以 tagIDs 字符串为权威源）
    static func reconcileNoteTagLinks(
        noteID: UUID,
        libraryID: UUID,
        tagIDs: [UUID],
        context: ModelContext
    ) {
        let noteIDToMatch = noteID
        // 删除旧关联
        let oldDescriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
            predicate: #Predicate { $0.noteID == noteIDToMatch }
        )
        if let oldLinks = try? context.fetch(oldDescriptor) {
            for link in oldLinks {
                context.delete(link)
            }
        }
        // 插入新关联
        for (sortOrder, tagID) in tagIDs.enumerated() {
            context.insert(
                BlockDocumentNoteTagEntity(
                    noteID: noteID,
                    tagID: tagID,
                    libraryID: libraryID,
                    sortOrder: sortOrder
                )
            )
        }
    }

    /// 按标签 ID 查询笔记 ID（走 SQLite 索引，避免全表扫描 + 字符串匹配）
    func noteIDs(forTagID tagID: UUID) -> [UUID] {
        guard let context = modelContext else { return [] }
        let tagIDToMatch = tagID

        let descriptor: FetchDescriptor<BlockDocumentNoteTagEntity>
        if let library = latestBlockDocumentLibrary(in: context) {
            let libraryIDToMatch = library.id
            descriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
                predicate: #Predicate {
                    $0.tagID == tagIDToMatch && $0.libraryID == libraryIDToMatch
                },
                sortBy: [SortDescriptor(\.sortOrder)]
            )
        } else {
            descriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
                predicate: #Predicate { $0.tagID == tagIDToMatch },
                sortBy: [SortDescriptor(\.sortOrder)]
            )
        }

        guard let links = try? context.fetch(descriptor) else { return [] }
        return links.map(\.noteID)
    }

    func noteIDSet(forTagID tagID: UUID) -> Set<UUID> {
        Set(noteIDs(forTagID: tagID))
    }

    // MARK: - Note Save Operations

    func updateNoteTitleInMemory(id: UUID, title: String) {
        guard let idx = notes.firstIndex(where: { $0.id == id }) else { return }
        var updatedNotes = notes
        updatedNotes[idx].title = title
        notes = updatedNotes
    }
    
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
            DebugLog.storage("modelContext is nil, skip save for id=\(id)", level: .debug)
            return
        }
        let folderID = folders.first { $0.name == folder }?.id
        let decodedContent = decodeRTFDContent(rtfdData)
        guard let request = noteSaveManager.createRequest(
            noteID: id,
            title: title,
            folderID: folderID,
            folder: folder,
            reminderAt: reminderAt,
            recurrenceRule: recurrenceRule,
            content: decodedContent,
            reason: reason
        ) else {
            return
        }

        _ = noteSaveManager.saveImmediately(request: request)
        searchableTextCache.removeValue(forKey: id)
        ensureItemType(id: id, itemType: "note")

        if let idx = notes.firstIndex(where: { $0.id == id }) {
            notes[idx].title = title
            if notes[idx].isContentLoaded {
                notes[idx].content = decodedContent
                notes[idx].contentPreview = Self.previewText(from: decodedContent.string)
            }
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
        guard let request = noteSaveManager.createRequest(
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

        _ = noteSaveManager.saveImmediately(request: request)
        searchableTextCache.removeValue(forKey: note.id)
        ensureItemType(id: note.id, itemType: "note")

        if let idx = notes.firstIndex(where: { $0.id == note.id }) {
            var updatedNote = note
            updatedNote.contentPreview = Self.previewText(from: note.content.string)
            updatedNote.isContentLoaded = true
            notes[idx] = updatedNote
            notes[idx].updatedAt = Date()
        }
    }

    private func ensureItemType(id: UUID, itemType: String) {
        guard let context = modelContext else { return }
        do {
            if let entity = try fetchNoteEntity(id: id, context: context), entity.itemType != itemType {
                entity.itemType = itemType
                context.saveLogging("NoteStore.ensureItemType")
            }
        } catch {
            DebugLog.storage("Failed to ensure itemType for \(id): \(error)", level: .warn)
        }
    }
    
    /// 保存笔记的视图模式
    func saveNoteViewMode(id: UUID, viewMode: NoteViewMode) {
        guard let context = modelContext else {
            DebugLog.storage("modelContext is nil, skip save for id=\(id)", level: .debug)
            return
        }
        
        Task {
            await MainActor.run {
                let idToMatch = id
                let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                    predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
                )
                
                guard let entities = try? context.fetch(descriptor), let entity = entities.first else {
                    DebugLog.storage("entity not found for id=\(id)", level: .debug)
                    return
                }
                
                entity.viewMode = viewMode.rawValue
                entity.updatedAt = Date()
                context.saveLogging("NoteStore.saveNoteViewMode")
                if let idx = self.notes.firstIndex(where: { $0.id == id }) {
                    self.notes[idx].viewMode = viewMode
                    self.notes[idx].updatedAt = entity.updatedAt
                }
                DebugLog.storage("saved viewMode '\(viewMode.rawValue)' for note id=\(id)", level: .debug)
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
            entity.version = max(entity.version + 1, 1)
            _ = try? BlockDocumentNoteVersionStore.ensureHistoryRecorded(noteID: id, context: context)
            context.saveLogging("NoteStore.moveNoteToRecycleBin")
            if let idx = notes.firstIndex(where: { $0.id == id }) {
                notes[idx].deletedAt = deletedAt
                notes[idx].originalFolderID = entity.originalFolderID
                notes[idx].originalFolderName = entity.originalFolderName
                notes[idx].updatedAt = deletedAt
                notes[idx].version = entity.version
            }
            autoSyncCoordinator.noteDidSave(noteID: id, reason: "moveToRecycleBin")
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
            entity.version = max(entity.version + 1, 1)
            try? BlockDocumentNoteVersionStore.cleanupDeletedTombstones(noteIDs: [id], context: context)
            _ = try? BlockDocumentNoteVersionStore.ensureHistoryRecorded(noteID: id, context: context)
            context.saveLogging("NoteStore.restoreNote")
            if let idx = notes.firstIndex(where: { $0.id == id }) {
                notes[idx].deletedAt = nil
                notes[idx].folderID = restoredFolderID
                notes[idx].folder = restoredFolderName
                notes[idx].originalFolderID = nil
                notes[idx].originalFolderName = nil
                notes[idx].updatedAt = entity.updatedAt
                notes[idx].version = entity.version
            }
            autoSyncCoordinator.noteDidSave(noteID: id, reason: "restoreFromRecycleBin")
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
            let deletedAt = Date()
            try? BlockDocumentNoteVersionStore.recordDeletedTombstone(
                noteID: id,
                deletedAt: deletedAt,
                context: context
            )
            let blockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
                predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == idToMatch }
            )
            let assetDescriptor = FetchDescriptor<BlockDocumentAssetEntity>(
                predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == idToMatch }
            )
            let stepDescriptor = FetchDescriptor<TodoStepEntity>(
                predicate: #Predicate<TodoStepEntity> { $0.noteID == idToMatch }
            )

            let blocks = (try? context.fetch(blockDescriptor)) ?? []
            let assets = (try? context.fetch(assetDescriptor)) ?? []
            let steps = (try? context.fetch(stepDescriptor)) ?? []
            deleteBlockDocumentArtifacts(noteID: id, assets: assets)

            for block in blocks {
                context.delete(block)
            }
            for asset in assets {
                context.delete(asset)
            }
            for step in steps {
                context.delete(step)
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
            try? NoteReadingPositionStore.delete(noteID: id, context: context)
            context.saveLogging("NoteStore.deleteNotePermanently")
            readingPositions.removeValue(forKey: id)
            notes.removeAll { $0.id == id }
            todoItems.removeAll { $0.id == id }
            autoSyncCoordinator.noteDidSave(noteID: id, reason: "deletePermanently")
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
        let storage = storageLocationManager
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
            context.saveLogging("NoteStore.moveNote")
            fetchData()
        }
    }

    /// 在锁定文件夹之间移动笔记，同时提交数据库字段和独立的锁定目录映射。
    @discardableResult
    func moveNoteToEncryptedFolder(id: UUID, to folderID: UUID) -> Note? {
        guard let context = modelContext,
              let folder = encryptedFolders.first(where: { $0.id == folderID }),
              let noteIndex = notes.firstIndex(where: { $0.id == id }) else { return nil }

        let idToMatch = id
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        guard let entity = try? context.fetch(descriptor).first else { return nil }

        let folderName = "🔒 " + folder.name
        let updatedAt = Date()
        entity.folderID = folderID
        entity.folderName = folderName
        entity.tagIDs = ""
        entity.updatedAt = updatedAt
        guard context.saveLogging("NoteStore.moveNoteToEncryptedFolder") else { return nil }

        var updatedNote = notes[noteIndex]
        encryptedFolderManager.encryptNote(&updatedNote, to: folderID)
        updatedNote.folder = folderName
        updatedNote.updatedAt = updatedAt
        notes[noteIndex] = updatedNote
        searchableTextCache.removeValue(forKey: id)
        autoSyncCoordinator.noteDidSave(noteID: id, reason: "moveEncryptedFolder")
        return updatedNote
    }
    
    // MARK: - Encrypted Folder Management
    
    /// 加载加密文件夹
    func loadEncryptedFolders() {
        if let data = NotebookDefaults.shared.data(forKey: encryptedFoldersKey),
           let folders = try? JSONDecoder().decode([EncryptedFolder].self, from: data) {
            self.encryptedFolders = folders.sorted { $0.order < $1.order }
        }
    }
    
    /// 保存加密文件夹
    private func saveEncryptedFolders() {
        if let data = try? JSONEncoder().encode(encryptedFolders) {
            NotebookDefaults.shared.set(data, forKey: encryptedFoldersKey)
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
        NotebookDefaults.shared.set(name, forKey: key)
    }
    
    /// 删除加密文件夹
    func deleteEncryptedFolder(id: UUID) {
        // 将该文件夹中的笔记移出加密状态
        let notesInFolder = notes.filter { 
            encryptedFolderManager.getEncryptedFolderID(for: $0) == id
        }
        for note in notesInFolder {
            moveNote(id: note.id, toFolderID: nil, toFolderName: "未分类")
        }
        
        encryptedFolders.removeAll { $0.id == id }
        saveEncryptedFolders()
        
        // 删除文件夹名称
        let key = "encrypted_folder_name_\(id.uuidString)"
        NotebookDefaults.shared.removeObject(forKey: key)
    }
    
    /// 重命名加密文件夹
    func renameEncryptedFolder(id: UUID, newName: String) {
        if let index = encryptedFolders.firstIndex(where: { $0.id == id }) {
            encryptedFolders[index].name = newName
            saveEncryptedFolders()
        }
        
        // 更新文件夹名称
        let key = "encrypted_folder_name_\(id.uuidString)"
        NotebookDefaults.shared.set(newName, forKey: key)
        
        // 更新该文件夹中所有笔记的 folder 名称
        let notesInFolder = notes.filter { 
            encryptedFolderManager.getEncryptedFolderID(for: $0) == id
        }
        for var note in notesInFolder {
            // 使用 encryptNote 来更新笔记信息
            encryptedFolderManager.encryptNote(&note, to: id)
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
                encryptedFolderName = "🔒 锁定笔记"
                let key = "encrypted_folder_name_\(defaultFolderID.uuidString)"
                NotebookDefaults.shared.set("锁定笔记", forKey: key)
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
        context.saveLogging("NoteStore.createEncryptedNote")
        
        fetchData()
        
        if var note = notes.first(where: { $0.id == entity.id }) {
            encryptedFolderManager.encryptNote(&note, to: targetFolderID)
            
            let idToMatch = note.id
            let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate { $0.id == idToMatch }
            )
            if let entityToUpdate = try? context.fetch(descriptor).first {
                entityToUpdate.folderID = note.folderID
                entityToUpdate.folderName = note.folder
                entityToUpdate.updatedAt = Date()
                context.saveLogging("NoteStore.createEncryptedNote")
            }
            
            fetchData()
            return notes.first(where: { $0.id == note.id })
        }
        
        return nil
    }
}
