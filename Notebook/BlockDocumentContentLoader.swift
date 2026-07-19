import Foundation
import SwiftData
import CryptoKit

struct BlockDocumentBlockRecord: Sendable {
    let noteID: UUID
    let position: Int
    let blockID: String
    let kind: String
    let sourceType: String
    let textPayload: Data?
    let level: Int?
    let listStyle: String?
    let order: Int?
    let checked: Bool?
    let indent: Int?
    let assetID: String?
    let tablePayload: Data?

    nonisolated init(
        noteID: UUID,
        position: Int,
        blockID: String,
        kind: String,
        sourceType: String,
        textPayload: Data?,
        level: Int?,
        listStyle: String?,
        order: Int?,
        checked: Bool?,
        indent: Int?,
        assetID: String?,
        tablePayload: Data?
    ) {
        self.noteID = noteID
        self.position = position
        self.blockID = blockID
        self.kind = kind
        self.sourceType = sourceType
        self.textPayload = textPayload
        self.level = level
        self.listStyle = listStyle
        self.order = order
        self.checked = checked
        self.indent = indent
        self.assetID = assetID
        self.tablePayload = tablePayload
    }
}

struct BlockDocumentAssetRecord: Sendable {
    let noteID: UUID
    let assetID: String
    let kind: String
    let filename: String
    let width: Double?
    let height: Double?
    let duration: Double?
    let createdAt: Date?
    let relativeFilePath: String

    nonisolated init(
        noteID: UUID,
        assetID: String,
        kind: String,
        filename: String,
        width: Double?,
        height: Double?,
        duration: Double?,
        createdAt: Date?,
        relativeFilePath: String
    ) {
        self.noteID = noteID
        self.assetID = assetID
        self.kind = kind
        self.filename = filename
        self.width = width
        self.height = height
        self.duration = duration
        self.createdAt = createdAt
        self.relativeFilePath = relativeFilePath
    }
}

struct BlockDocumentContentSnapshot: Sendable {
    let noteID: UUID
    let version: Int64
    let hasLegacyCheckboxMigrated: Bool
    let blocks: [BlockDocumentBlockRecord]
    let assetsByID: [String: BlockDocumentAssetRecord]
}

@ModelActor
actor BlockDocumentContentLoader {
    func version(noteID: UUID) throws -> Int64 {
        let idToMatch = noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        guard let note = try modelContext.fetch(descriptor).first else {
            throw CocoaError(.fileNoSuchFile)
        }
        return note.version
    }

    func snapshot(noteID: UUID) throws -> BlockDocumentContentSnapshot {
        let idToMatch = noteID
        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        guard let note = try modelContext.fetch(noteDescriptor).first else {
            throw CocoaError(.fileNoSuchFile)
        }

        let blockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
            predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == idToMatch },
            sortBy: [SortDescriptor(\.position)]
        )
        let assetDescriptor = FetchDescriptor<BlockDocumentAssetEntity>(
            predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == idToMatch }
        )
        let blocks = try modelContext.fetch(blockDescriptor).map {
            BlockDocumentBlockRecord(
                noteID: $0.noteID,
                position: $0.position,
                blockID: $0.blockID,
                kind: $0.kind,
                sourceType: $0.sourceType,
                textPayload: $0.textPayload,
                level: $0.level,
                listStyle: $0.listStyle,
                order: $0.order,
                checked: $0.checked,
                indent: $0.indent,
                assetID: $0.assetID,
                tablePayload: $0.tablePayload
            )
        }
        let assets = try modelContext.fetch(assetDescriptor).map {
            BlockDocumentAssetRecord(
                noteID: $0.noteID,
                assetID: $0.assetID,
                kind: $0.kind,
                filename: $0.filename,
                width: $0.width,
                height: $0.height,
                duration: $0.duration,
                createdAt: $0.createdAt,
                relativeFilePath: $0.relativeFilePath
            )
        }

        return BlockDocumentContentSnapshot(
            noteID: noteID,
            version: note.version,
            hasLegacyCheckboxMigrated: note.hasLegacyCheckboxMigrated,
            blocks: blocks,
            assetsByID: Dictionary(uniqueKeysWithValues: assets.map { ($0.assetID, $0) })
        )
    }
}

struct PersistedTextNoteImport: Sendable {
    let noteID: UUID
    let version: Int64
    let updatedAt: Date
    let blockCount: Int
    let normalizedContent: String
}

@ModelActor
actor TextNoteImportPersistenceActor {
    func persist(noteID: UUID, content: String, authorDeviceID: String) throws -> PersistedTextNoteImport {
        let idToMatch = noteID
        let noteDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == idToMatch }
        )
        guard let note = try modelContext.fetch(noteDescriptor).first else {
            throw CocoaError(.fileNoSuchFile)
        }

        let normalizedContent = content
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalizedContent.components(separatedBy: "\n")
        // 小文档继续保持“一段一块”，便于细粒度版本比较；大纯文本按有限窗口
        // 合并行，避免数万条 SwiftData insert。块之间由 builder 补一个换行，
        // 因而这里按完整行边界切分可逐字符还原原文（包括末尾换行）。
        let storedTexts: [String]
        if lines.count > 512 {
            storedTexts = stride(from: 0, to: lines.count, by: 256).map { start in
                lines[start..<min(start + 256, lines.count)].joined(separator: "\n")
            }
        } else {
            storedTexts = lines
        }
        let encoder = JSONEncoder()
        var documentBlocks: [MigratedDocumentBlock] = []
        documentBlocks.reserveCapacity(storedTexts.count)

        do {
            for (position, text) in storedTexts.enumerated() {
                if position.isMultiple(of: 128) {
                    try Task.checkCancellation()
                }
                let textPayload: Data?
                if text.isEmpty {
                    textPayload = nil
                } else {
                    textPayload = try encoder.encode([
                        BlockDocumentTextSpanPayload(
                            text: text,
                            bold: false,
                            italic: false,
                            underline: false,
                            strikethrough: false,
                            textColor: nil,
                            backgroundColor: nil,
                            link: nil,
                            fontFamily: nil,
                            fontSize: nil,
                            kern: nil,
                            baselineOffset: nil,
                            paragraphStyle: nil
                        )
                    ])
                }
                let block = BlockDocumentBlockEntity(
                    noteID: noteID,
                    position: position,
                    blockID: "block-\(position)",
                    kind: "paragraph",
                    sourceType: "paragraph",
                    textPayload: textPayload,
                    level: nil,
                    listStyle: nil,
                    order: nil,
                    checked: nil,
                    indent: 0,
                    assetID: nil,
                    tablePayload: nil
                )
                block.note = note
                modelContext.insert(block)
                documentBlocks.append(
                    MigratedDocumentBlock(
                        id: "block-\(position)",
                        type: "paragraph",
                        text: text.isEmpty ? nil : [
                            MigratedInlineText(
                                text: text,
                                bold: false,
                                italic: false,
                                underline: false,
                                strikethrough: false,
                                textColor: nil,
                                backgroundColor: nil,
                                link: nil,
                                fontFamily: nil,
                                fontSize: nil,
                                kern: nil,
                                baselineOffset: nil,
                                paragraphStyle: nil
                            )
                        ],
                        level: nil,
                        listStyle: nil,
                        order: nil,
                        checked: nil,
                        indent: 0,
                        asset: nil,
                        table: nil
                    )
                )
            }

            try Task.checkCancellation()
            let importedAt = Date()
            note.updatedAt = importedAt
            note.version = max(note.version + 1, 1)
            note.documentSchemaVersion = "1.0"
            note.documentSource = "TextFileDrop"
            note.blockCount = storedTexts.count
            note.assetCount = 0
            note.previewText = NoteSaveManager.previewTextForList(from: normalizedContent)
            note.hasLegacyCheckboxMigrated = true
            try modelContext.save()

            try Task.checkCancellation()
            let snapshot = VersionedNoteSnapshot(
                metadata: DocumentMigrationPackage.NoteItem(
                    id: note.id,
                    title: note.title,
                    createdAt: note.createdAt,
                    updatedAt: note.updatedAt,
                    folderID: note.folderID,
                    folderName: note.folderName,
                    reminderAt: note.reminderAt,
                    recurrenceRule: note.recurrenceRule,
                    version: note.version,
                    tagIDs: decodeUUIDList(note.tagIDs),
                    viewMode: note.viewMode,
                    deletedAt: note.deletedAt,
                    originalFolderID: note.originalFolderID,
                    originalFolderName: note.originalFolderName,
                    blockCount: documentBlocks.count,
                    assetCount: 0,
                    documentPath: "Notes/\(note.id.uuidString)/document.json",
                    itemType: note.itemType,
                    todoDueAt: note.todoDueAt,
                    todoCompletedAt: note.todoCompletedAt,
                    todoIsImportant: note.todoIsImportant,
                    todoOrder: note.todoOrder,
                    linkedNoteIDs: decodeUUIDList(note.linkedNoteIDs)
                ),
                document: MigratedDocument(
                    schemaVersion: note.documentSchemaVersion,
                    source: note.documentSource,
                    blocks: documentBlocks
                ),
                assets: [],
                todoSteps: []
            )
            let snapshotEncoder = JSONEncoder()
            snapshotEncoder.outputFormatting = .sortedKeys
            let snapshotJSON = try snapshotEncoder.encode(snapshot)
            let snapshotData = try VersionedNoteSnapshotCodec.storageData(from: snapshotJSON)
            modelContext.insert(
                BlockDocumentNoteVersionEntity(
                    noteID: noteID,
                    version: note.version,
                    recordedAt: importedAt,
                    updatedAt: importedAt,
                    title: note.title,
                    authorDeviceID: authorDeviceID,
                    contentHash: SHA256.hash(data: snapshotJSON)
                        .map { String(format: "%02x", $0) }
                        .joined(),
                    snapshotData: snapshotData
                )
            )
            try modelContext.save()
            return PersistedTextNoteImport(
                noteID: noteID,
                version: note.version,
                updatedAt: importedAt,
                blockCount: storedTexts.count,
                normalizedContent: normalizedContent
            )
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    private func decodeUUIDList(_ rawValue: String?) -> [UUID] {
        guard let rawValue else { return [] }
        var seen = Set<UUID>()
        return rawValue.split(separator: ",").compactMap { component in
            let candidate = String(component).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let value = UUID(uuidString: candidate), seen.insert(value).inserted else {
                return nil
            }
            return value
        }
    }
}
