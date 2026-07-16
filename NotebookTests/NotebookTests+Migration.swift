import XCTest
import SwiftData
@testable import Notebook

// MARK: - Schema 迁移与版本测试

extension NotebookTests {
    @MainActor
    func testProductionOpenPathPreservesExistingStoreAndCreatesPreMigrationBackup() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookMigrationRoundTrip-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let storage = StorageLocationManager.shared
        let previousBaseURL = storage.baseDirectoryURL
        storage.setBaseDirectoryForTesting(root)
        defer { storage.setBaseDirectoryForTesting(previousBaseURL) }
        try storage.ensureDirectoryStructureExists()

        let notebookData = try storage.notebookDataDirectoryURL()
        let databaseDirectory = try storage.databaseDirectoryURL()
        let storeURL = databaseDirectory.appendingPathComponent("notebook.store")
        let config = ModelConfiguration(schema: PersistenceController.appSchema, url: storeURL)

        let noteID = UUID()
        do {
            let container = try ModelContainer(for: PersistenceController.appSchema, configurations: [config])
            let context = container.mainContext
            let library = BlockDocumentLibraryEntity(schemaVersion: "1.0", sourceExportedAt: Date())
            context.insert(library)
            let note = BlockDocumentNoteEntity(
                id: noteID,
                libraryID: library.id,
                title: "Migration sentinel",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: nil,
                folderName: "",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 1,
                tagIDs: "",
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 0,
                assetCount: 0
            )
            context.insert(note)
            try context.save()
        }

        let oldState = PersistenceMigrationSafety.State(
            storeFormatVersion: PersistenceController.currentStoreFormatVersion - 1,
            updatedAt: Date(),
            lastBackupID: nil
        )
        try JSONEncoder().encode(oldState).write(
            to: notebookData.appendingPathComponent(PersistenceMigrationSafety.stateFilename),
            options: .atomic
        )

        let reopened = try PersistenceController.makeModelContainer(
            storageLocationManager: storage,
            migrationReason: "unit-test-round-trip"
        )
        let idToMatch = noteID
        let notes = try reopened.mainContext.fetch(
            FetchDescriptor<BlockDocumentNoteEntity>(predicate: #Predicate { $0.id == idToMatch })
        )
        XCTAssertEqual(notes.first?.title, "Migration sentinel")

        let backup = try XCTUnwrap(PersistenceMigrationSafety.latestBackup(in: notebookData))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: backup.appendingPathComponent(PersistenceMigrationSafety.databaseSnapshotDirectoryName).path
        ))
    }
    /// 验证当前 store format 版本与 NotebookSchemaV6 对齐
    @MainActor
    func testCurrentStoreFormatVersionIsV6() {
        XCTAssertEqual(PersistenceController.currentStoreFormatVersion, 6, "当前版本应为 6（V1→V2→V3→V4→V5→V6）")
    }

    /// 验证 Migration Plan 包含 5 个 stage（V1→…→V6）
    func testMigrationPlanHasFiveStages() {
        XCTAssertEqual(NotebookSchemaMigrationPlan.stages.count, 5, "应有 5 个迁移 stage")
    }

    /// 验证 Migration Plan schemas 包含 V1-V6
    func testMigrationPlanSchemasIncludeV1ThroughV6() {
        XCTAssertEqual(NotebookSchemaMigrationPlan.schemas.count, 6, "应包含 V1-V6 六个版本")
    }

    /// 验证 appSchema 包含 TodoStepEntity（V5 引入）
    @MainActor
    func testAppSchemaIncludesAllEntities() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let step = TodoStepEntity(
            noteID: UUID(),
            libraryID: UUID(),
            text: "测试步骤"
        )
        context.insert(step)
        try context.save()

        let idToMatch = step.id
        let descriptor = FetchDescriptor<TodoStepEntity>(
            predicate: #Predicate { $0.id == idToMatch }
        )
        XCTAssertEqual(try context.fetch(descriptor).count, 1, "appSchema 应包含 TodoStepEntity")
    }

    /// 验证 in-memory container 可正常创建并包含所有 entity
    @MainActor
    func testInMemoryContainerCreatesAllEntities() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext

        // 插入一条笔记 + 一个 block + 一个 asset + 一个 tag link，验证 schema 完整
        let noteID = UUID()
        let libraryID = UUID()
        let note = BlockDocumentNoteEntity(
            id: noteID,
            libraryID: libraryID,
            title: "迁移测试笔记",
            createdAt: Date(),
            updatedAt: Date(),
            folderID: nil,
            folderName: "",
            reminderAt: nil,
            recurrenceRule: "",
            version: 1,
            tagIDs: "",
            viewMode: "text",
            deletedAt: nil,
            originalFolderID: nil,
            originalFolderName: nil,
            documentSchemaVersion: "1",
            documentSource: "test",
            blockCount: 1,
            assetCount: 0
        )
        context.insert(note)

        let block = BlockDocumentBlockEntity(
            noteID: noteID,
            position: 0,
            blockID: "block-1",
            kind: "paragraph",
            sourceType: "paragraph",
            textPayload: nil,
            level: nil,
            listStyle: nil,
            order: nil,
            checked: nil,
            indent: nil,
            assetID: nil,
            tablePayload: nil
        )
        block.note = note
        context.insert(block)

        let tagLink = BlockDocumentNoteTagEntity(
            noteID: noteID,
            tagID: UUID(),
            libraryID: libraryID,
            sortOrder: 0
        )
        context.insert(tagLink)

        try context.save()

        // 验证 @Relationship：note.blocks 应自动包含刚插入的 block
        XCTAssertEqual(note.blocks.count, 1, "@Relationship blocks 应自动关联")
        XCTAssertEqual(note.blocks.first?.blockID, "block-1")

        // 验证反向关系
        XCTAssertEqual(block.note?.id, noteID, "block.note 反向关系应正确")

        // 验证关联表可查询
        let noteIDToMatch = noteID
        let linkDescriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
            predicate: #Predicate { $0.noteID == noteIDToMatch }
        )
        let links = try context.fetch(linkDescriptor)
        XCTAssertEqual(links.count, 1, "关联表应包含 1 条记录")
    }

    @MainActor
    func testTodoEntitiesAreLoadedSeparatelyFromNotesAndFolders() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let noteFolderID = UUID()
        let todoListID = UUID()
        let noteID = UUID()
        let todoID = UUID()

        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 2,
                folderCount: 2,
                tagCount: 0
            )
        )
        context.insert(
            BlockDocumentFolderEntity(
                id: noteFolderID,
                libraryID: libraryID,
                name: "笔记文件夹",
                sortOrder: 0,
                isSystem: false,
                createdAt: Date(),
                folderType: FolderType.noteFolder.rawValue
            )
        )
        context.insert(
            BlockDocumentFolderEntity(
                id: todoListID,
                libraryID: libraryID,
                name: "工作 Todo",
                sortOrder: 1,
                isSystem: false,
                createdAt: Date(),
                folderType: FolderType.todoList.rawValue
            )
        )
        context.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "普通笔记",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: noteFolderID,
                folderName: "笔记文件夹",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 1,
                tagIDs: "",
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 0,
                assetCount: 0,
                itemType: "note"
            )
        )
        context.insert(
            BlockDocumentNoteEntity(
                id: todoID,
                libraryID: libraryID,
                title: "Todo 任务",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: todoListID,
                folderName: "工作 Todo",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 1,
                tagIDs: "",
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 0,
                assetCount: 0,
                itemType: "todo",
                todoIsImportant: true,
                todoOrder: 3
            )
        )
        context.insert(
            TodoStepEntity(
                noteID: todoID,
                libraryID: libraryID,
                text: "第一步"
            )
        )
        try context.save()

        let store = NoteStore()
        store.setContext(context)

        XCTAssertEqual(store.notes.map(\.id), [noteID])
        XCTAssertEqual(store.folders.map(\.id), [noteFolderID])
        XCTAssertEqual(store.todoItems.map(\.id), [todoID])
        XCTAssertEqual(store.todoLists.map(\.id), [todoListID])
        XCTAssertEqual(store.importantTodoItems().map(\.id), [todoID])
        XCTAssertEqual(store.steps(for: todoID).map(\.text), ["第一步"])
    }

    @MainActor
    func testBlankItemTypeIsRecoveredAsNote() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext
        let libraryID = UUID()
        let noteID = UUID()

        context.insert(
            BlockDocumentLibraryEntity(
                id: libraryID,
                schemaVersion: "1.0",
                sourceExportedAt: Date(),
                importedAt: Date(),
                noteCount: 1,
                folderCount: 0,
                tagCount: 0
            )
        )

        context.insert(
            BlockDocumentNoteEntity(
                id: noteID,
                libraryID: libraryID,
                title: "Recovered note",
                createdAt: Date(),
                updatedAt: Date(),
                folderID: nil,
                folderName: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                version: 1,
                tagIDs: "",
                viewMode: "text",
                deletedAt: nil,
                originalFolderID: nil,
                originalFolderName: nil,
                documentSchemaVersion: "1.0",
                documentSource: "test",
                blockCount: 0,
                assetCount: 0,
                itemType: ""
            )
        )
        try context.save()

        let store = NoteStore()
        store.setContext(context)

        XCTAssertEqual(store.notes.map(\.id), [noteID])
        XCTAssertTrue(store.todoItems.isEmpty)

        let idToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        let recovered = try XCTUnwrap(context.fetch(descriptor).first)
        XCTAssertEqual(recovered.itemType, "note")
    }

    /// 验证级联删除：删除 note 后 blocks/assets 自动删除
    @MainActor
    func testCascadeDeleteRemovesBlocksAndAssets() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext

        let noteID = UUID()
        let libraryID = UUID()
        let note = BlockDocumentNoteEntity(
            id: noteID,
            libraryID: libraryID,
            title: "级联删除测试",
            createdAt: Date(),
            updatedAt: Date(),
            folderID: nil,
            folderName: "",
            reminderAt: nil,
            recurrenceRule: "",
            version: 1,
            tagIDs: "",
            viewMode: "text",
            deletedAt: nil,
            originalFolderID: nil,
            originalFolderName: nil,
            documentSchemaVersion: "1",
            documentSource: "test",
            blockCount: 2,
            assetCount: 1
        )
        context.insert(note)

        for i in 0..<2 {
            let block = BlockDocumentBlockEntity(
                noteID: noteID,
                position: i,
                blockID: "block-\(i)",
                kind: "paragraph",
                sourceType: "paragraph",
                textPayload: nil,
                level: nil,
                listStyle: nil,
                order: nil,
                checked: nil,
                indent: nil,
                assetID: nil,
                tablePayload: nil
            )
            block.note = note
            context.insert(block)
        }

        let asset = BlockDocumentAssetEntity(
            noteID: noteID,
            assetID: "asset-1",
            kind: "image",
            sourceKind: "image",
            filename: "test.png",
            mimeType: "image/png",
            width: 100,
            height: 100,
            duration: nil,
            createdAt: Date(),
            relativeFilePath: "test/test.png",
            sidecarPathsPayload: nil
        )
        asset.note = note
        context.insert(asset)

        try context.save()

        // 确认初始状态
        XCTAssertEqual(note.blocks.count, 2)
        let noteIDToMatch = noteID
        let blockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
            predicate: #Predicate { $0.noteID == noteIDToMatch }
        )
        XCTAssertEqual(try context.fetch(blockDescriptor).count, 2)

        // 删除 note → 级联删除 blocks + assets
        context.delete(note)
        try context.save()

        XCTAssertEqual(try context.fetch(blockDescriptor).count, 0, "级联删除后 blocks 应为 0")
        let assetDescriptor = FetchDescriptor<BlockDocumentAssetEntity>(
            predicate: #Predicate { $0.noteID == noteIDToMatch }
        )
        XCTAssertEqual(try context.fetch(assetDescriptor).count, 0, "级联删除后 assets 应为 0")
    }

    /// 验证 tagIDs 关联表：reconcileNoteTagLinks 全量重建
    @MainActor
    func testReconcileNoteTagLinksRebuildsAssociations() throws {
        let container = try makeInMemoryContainer()
        let context = container.mainContext

        let noteID = UUID()
        let libraryID = UUID()
        let tag1 = UUID()
        let tag2 = UUID()
        let tag3 = UUID()

        // 第一次：建立 3 个关联
        NoteStore.reconcileNoteTagLinks(
            noteID: noteID,
            libraryID: libraryID,
            tagIDs: [tag1, tag2, tag3],
            context: context
        )
        try context.save()

        let noteIDToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteTagEntity>(
            predicate: #Predicate { $0.noteID == noteIDToMatch },
            sortBy: [SortDescriptor(\.sortOrder)]
        )
        let links1 = try context.fetch(descriptor)
        XCTAssertEqual(links1.count, 3)
        XCTAssertEqual(links1.map(\.tagID), [tag1, tag2, tag3])

        // 第二次：改为 2 个关联（移除 tag2，保留 tag1 和 tag3）
        NoteStore.reconcileNoteTagLinks(
            noteID: noteID,
            libraryID: libraryID,
            tagIDs: [tag1, tag3],
            context: context
        )
        try context.save()

        let links2 = try context.fetch(descriptor)
        XCTAssertEqual(links2.count, 2, "全量重建后应为 2 条")
        XCTAssertEqual(links2.map(\.tagID), [tag1, tag3])
        XCTAssertEqual(links2[0].sortOrder, 0)
        XCTAssertEqual(links2[1].sortOrder, 1)
    }

    /// 验证 UUIDListCoding encode/decode 往返
    func testUUIDListCodingRoundTrip() {
        let ids = [UUID(), UUID(), UUID()]
        let encoded = UUIDListCoding.encode(ids)
        let decoded = UUIDListCoding.decode(encoded)
        XCTAssertEqual(decoded, ids, "encode → decode 应保持一致")
    }

    /// 验证 UUIDListCoding 解码无效字符串返回空数组
    func testUUIDListCodingDecodesInvalidStringReturnsEmpty() {
        let decoded = UUIDListCoding.decode("not-a-uuid,also-not-uuid")
        XCTAssertEqual(decoded, [], "无效字符串应解码为空数组")
    }

    /// 验证 UUIDListCoding 解码空字符串返回空数组
    func testUUIDListCodingDecodesEmptyStringReturnsEmpty() {
        XCTAssertEqual(UUIDListCoding.decode(""), [])
    }

    /// 验证 UUIDListCoding 解码部分有效字符串只保留有效 UUID
    func testUUIDListCodingDecodesPartialValidKeepsValidOnly() {
        let validID = UUID()
        let decoded = UUIDListCoding.decode("\(validID.uuidString),invalid-uuid")
        XCTAssertEqual(decoded, [validID], "应只保留有效 UUID")
    }
}
