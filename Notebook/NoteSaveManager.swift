//
//  NoteSaveManager.swift
//  Notebook
//
//  笔记保存管理器 - 最高安全性和稳定性优先
//  设计原则：
//  1. 所有保存操作都是同步阻塞的，确保完成后再继续
//  2. 保存时锁定笔记，防止并发修改
//  3. 所有状态变更都有日志记录
//  4. 失败时明确返回，绝不绕过锁或带病覆盖
//

import Foundation
import SwiftData
import AppKit
import CryptoKit

/// 保存结果
enum SaveResult {
    case success
    case failure(Error)
}

enum SaveSafetyError: LocalizedError {
    case destructiveEmptySnapshotBlocked(noteID: UUID, reason: String)

    var errorDescription: String? {
        switch self {
        case .destructiveEmptySnapshotBlocked(_, let reason):
            return "检测到自动保存产生了空内容快照（\(reason)），已阻止覆盖现有笔记。请确认编辑器内容后使用 ⌘S 明确保存。"
        }
    }
}

enum SyncPreparationError: LocalizedError {
    case editorSaveFailed
    case pendingSaveFailed(Error)

    var errorDescription: String? {
        switch self {
        case .editorSaveFailed:
            return "当前笔记保存失败，已取消同步以防止覆盖未保存内容"
        case .pendingSaveFailed(let error):
            return "待保存内容写入失败，已取消同步：\(error.localizedDescription)"
        }
    }
}

struct EditorSyncCheckpoint: Equatable {
    let handlerID: UUID?
    let revisionFingerprint: String?
}

/// 保存请求
struct SaveRequest {
    let noteID: UUID
    let title: String
    let folderID: UUID?
    let folder: String
    let reminderAt: Date?
    let recurrenceRule: String
    /// RTFD 序列化数据（用于备份恢复）
    let rtfdData: Data
    /// 已解码的 NSAttributedString（避免保存路径的 RTFD → 反 RTFD 往返）
    let decodedContent: NSAttributedString
    /// 只有明确的用户保存动作可以授权把已有正文清空。
    let allowsDestructiveEmptySave: Bool
    let reason: String
    let timestamp: Date
}

/// 笔记保存管理器 - 单例，串行处理所有保存操作
@MainActor
final class NoteSaveManager {
    static let shared = NoteSaveManager()
    
    private var modelContext: ModelContext?
    private let jsonEncoder = JSONEncoder()
    private let rtfdReadOptions: [NSAttributedString.DocumentReadingOptionKey: Any] = [
        .documentType: NSAttributedString.DocumentType.rtfd
    ]
    
    // 当前正在保存的笔记 ID；所有入口都在 MainActor，用于阻止同步重入。
    private var currentlySaving: Set<UUID> = []
    
    // 待保存的队列（用于自动保存去抖）
    private var pendingSaves: [UUID: SaveRequest] = [:]
    private var pendingTimers: [UUID: Timer] = [:]
    private var pendingSaveCompletions: [UUID: (SaveResult) -> Void] = [:]

    // 当前主编辑器的同步前保存回调。同步必须先抓取编辑器快照，而不只是冲刷已排队的保存请求。
    private var editorSaveHandler: (() -> Bool)?
    private var editorSaveHandlerID: UUID?
    private var editorRevisionProvider: (() -> String?)?
    
    private init() {}
    
    func setContext(_ context: ModelContext) {
        self.modelContext = context
    }

    func resetForTesting() {
        modelContext = nil
        currentlySaving.removeAll()
        pendingSaves.removeAll()
        pendingSaveCompletions.removeAll()
        for timer in pendingTimers.values {
            timer.invalidate()
        }
        pendingTimers.removeAll()
        editorSaveHandler = nil
        editorSaveHandlerID = nil
        editorRevisionProvider = nil
    }
    
    // MARK: - 公共 API
    
    /// 立即同步保存 - 阻塞直到保存完成
    func saveImmediately(request: SaveRequest) -> SaveResult {
        cancelPendingSave(for: request.noteID)
        return performSave(request: request)
    }
    
    /// 延迟保存（自动保存）- 去抖处理
    func scheduleSave(
        request: SaveRequest,
        delay: TimeInterval = 1.0,
        completion: ((SaveResult) -> Void)? = nil
    ) {
        let noteID = request.noteID
        cancelPendingSave(for: noteID)
        pendingSaves[noteID] = request
        pendingSaveCompletions[noteID] = completion
        
        let timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            DispatchQueue.main.async {
                if let pendingRequest = self.pendingSaves[noteID] {
                    self.pendingSaves.removeValue(forKey: noteID)
                    self.pendingTimers.removeValue(forKey: noteID)
                    let completion = self.pendingSaveCompletions.removeValue(forKey: noteID)
                    let result = self.performSave(request: pendingRequest)
                    completion?(result)
                }
            }
        }
        
        pendingTimers[noteID] = timer
    }

    func hasPendingSave(for noteID: UUID) -> Bool {
        pendingSaves[noteID] != nil
    }

    func savePendingImmediately(for noteID: UUID) -> SaveResult? {
        guard let request = pendingSaves.removeValue(forKey: noteID) else { return nil }
        pendingTimers.removeValue(forKey: noteID)?.invalidate()
        let completion = pendingSaveCompletions.removeValue(forKey: noteID)
        let result = performSave(request: request)
        completion?(result)
        return result
    }
    
    /// 取消待保存任务
    func cancelPendingSave(for noteID: UUID) {
        if let timer = pendingTimers[noteID] {
            timer.invalidate()
            pendingTimers.removeValue(forKey: noteID)
            pendingSaves.removeValue(forKey: noteID)
            pendingSaveCompletions.removeValue(forKey: noteID)
        }
    }
    
    /// 注册当前主编辑器的同步前保存回调。
    @discardableResult
    func registerEditorSaveHandler(
        revisionProvider: (() -> String?)? = nil,
        _ handler: @escaping () -> Bool
    ) -> UUID {
        let id = UUID()
        editorSaveHandler = handler
        editorSaveHandlerID = id
        editorRevisionProvider = revisionProvider
        return id
    }

    /// 仅清理由对应视图注册的回调，避免旧视图移除较新的编辑器回调。
    func unregisterEditorSaveHandler(id: UUID) {
        guard editorSaveHandlerID == id else { return }
        editorSaveHandler = nil
        editorSaveHandlerID = nil
        editorRevisionProvider = nil
    }

    /// 在任何远端读写前保存当前编辑器并冲刷待保存队列。任一步失败都必须阻止同步。
    @discardableResult
    func prepareForSync() throws -> EditorSyncCheckpoint {
        if let editorSaveHandler, !editorSaveHandler() {
            Logger.shared.log(.save, .error, "同步前保存当前编辑器失败，已阻止同步")
            throw SyncPreparationError.editorSaveFailed
        }

        switch flushAllPending() {
        case .success:
            return EditorSyncCheckpoint(
                handlerID: editorSaveHandlerID,
                revisionFingerprint: editorRevisionProvider?()
            )
        case .failure(let error):
            Logger.shared.log(.save, .error, "同步前冲刷待保存队列失败，已阻止同步：\(error.localizedDescription)")
            throw SyncPreparationError.pendingSaveFailed(error)
        }
    }

    /// 同步结束时再次核对编辑器。如果网络等待期间继续输入，先把新修订落盘再允许刷新 UI。
    @discardableResult
    func finishSync(checkpoint: EditorSyncCheckpoint) throws -> Bool {
        guard checkpoint.handlerID == editorSaveHandlerID else {
            // 编辑器视图已经切换或重建；它自己的切换链路负责保存旧笔记。
            return false
        }
        let currentFingerprint = editorRevisionProvider?()
        guard currentFingerprint != checkpoint.revisionFingerprint else { return false }

        guard editorSaveHandler?() != false else {
            throw SyncPreparationError.editorSaveFailed
        }
        switch flushAllPending() {
        case .success:
            Logger.shared.log(.save, .info, "同步期间检测到继续编辑，已在刷新前保存最新修订")
            return true
        case .failure(let error):
            throw SyncPreparationError.pendingSaveFailed(error)
        }
    }

    /// 强制刷新所有待保存内容，并向调用方报告失败。
    @discardableResult
    func flushAllPending() -> SaveResult {
        let pending = pendingSaves
        let completions = pendingSaveCompletions
        pendingSaves.removeAll()
        pendingSaveCompletions.removeAll()
        
        for timer in pendingTimers.values {
            timer.invalidate()
        }
        pendingTimers.removeAll()
        
        var firstError: Error?
        for request in pending.values {
            let result = performSave(request: request)
            completions[request.noteID]?(result)
            if case .failure(let error) = result, firstError == nil {
                firstError = error
            }
        }

        return firstError.map(SaveResult.failure) ?? .success
    }
    
    // MARK: - 私有方法

    /// 执行实际保存 - 必须在主线程调用
    private func performSave(request: SaveRequest) -> SaveResult {
        let interval = Logger.shared.beginInterval(
            .save,
            "performSave",
            metadata: "noteID=\(request.noteID.uuidString.prefix(8)) reason=\(request.reason) dataBytes=\(request.rtfdData.count)"
        )
        guard let context = modelContext else {
            interval.end(.error, "contextMissing")
            return .failure(NSError(domain: "SaveManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "ModelContext not initialized"]))
        }

        let noteID = request.noteID

        do {
            try validateDestructiveEmptySave(request: request, context: context)
        } catch {
            Logger.shared.log(
                .save,
                .error,
                "已阻止空快照覆盖现有笔记：noteID=\(noteID.uuidString.prefix(8)) reason=\(request.reason) error=\(error.localizedDescription)"
            )
            interval.end(.error, "destructiveEmptySnapshotBlocked")
            return .failure(error)
        }

        // 检查是否正在保存该笔记
        guard !currentlySaving.contains(noteID) else {
            interval.end(.warn, "alreadySaving_reentrant")
            return .failure(NSError(
                domain: "SaveManager",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "检测到同一笔记的重入保存，已阻止重复写入"]
            ))
        }

        let blockDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        let blockEntities: [BlockDocumentNoteEntity]
        do {
            blockEntities = try context.fetch(blockDescriptor)
        } catch {
            interval.end(.error, "entityFetchFailed")
            return .failure(error)
        }
        guard let blockEntity = blockEntities.first else {
            interval.end(.error, "entityMissing")
            return .failure(NSError(domain: "SaveManager", code: -2, userInfo: [NSLocalizedDescriptionKey: "Entity not found"]))
        }

        // 标记为正在保存（用于崩溃检测）
        currentlySaving.insert(noteID)
        BackupManager.shared.markSaveStart(noteID: noteID)

        defer {
            currentlySaving.remove(noteID)
            BackupManager.shared.markSaveComplete()
        }

        // 先备份数据库中的旧正文，而不是即将写入的新正文。
        guard BackupManager.shared.createPersistedBackup(
            note: blockEntity,
            context: context,
            reason: request.reason
        ) else {
            interval.end(.error, "backupFailed")
            return .failure(NSError(
                domain: "SaveManager",
                code: -5,
                userInfo: [NSLocalizedDescriptionKey: "无法创建安全备份，已停止保存以避免覆盖现有数据"]
            ))
        }

        // 执行保存
        do {
            guard validateData(request.rtfdData) else {
                interval.end(.error, "validationFailed")
                return .failure(NSError(domain: "SaveManager", code: -3, userInfo: [NSLocalizedDescriptionKey: "Data validation failed"]))
            }

            let hasContentChanged = try saveBlockDocumentNote(entity: blockEntity, request: request, context: context)
            if hasContentChanged {
                AutoSyncCoordinator.shared.noteDidSave(noteID: request.noteID, reason: request.reason)
            }
            interval.end(.info, "result=success")
            return .success
        } catch {
            context.rollback()
            interval.end(.error, "result=failure error=\(error.localizedDescription)")
            return .failure(error)
        }
    }

    /// 自动保存得到零长度内容时，以数据库历史版本为权威判断是否会造成破坏性清空。
    /// 此检查必须发生在创建轮转备份之前，避免无效空快照挤掉最后一份可恢复备份。
    private func validateDestructiveEmptySave(
        request: SaveRequest,
        context: ModelContext
    ) throws {
        guard request.decodedContent.length == 0,
              !request.allowsDestructiveEmptySave else { return }

        let noteID = request.noteID
        let descriptor = FetchDescriptor<BlockDocumentNoteEntity>(
            predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
        )
        guard let entity = try context.fetch(descriptor).first else { return }

        let snapshot = try BlockDocumentNoteVersionStore.snapshot(
            noteID: noteID,
            version: entity.version,
            context: context
        )
        let snapshotHasMeaningfulContent = snapshot?.document.blocks.contains { block in
            if block.asset != nil || block.table != nil { return true }
            if block.type != "paragraph" { return true }
            return block.text?.contains {
                !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            } == true
        } == true
        let metadataIndicatesContent = !entity.previewText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || entity.assetCount > 0
            || entity.blockCount > 1

        guard snapshotHasMeaningfulContent || metadataIndicatesContent else { return }
        throw SaveSafetyError.destructiveEmptySnapshotBlocked(
            noteID: noteID,
            reason: request.reason
        )
    }

    @discardableResult
    private func saveBlockDocumentNote(
        entity: BlockDocumentNoteEntity,
        request: SaveRequest,
        context: ModelContext
    ) throws -> Bool {
        let interval = Logger.shared.beginInterval(
            .save,
            "saveBlockDocumentNote",
            metadata: "noteID=\(request.noteID.uuidString.prefix(8)) reason=\(request.reason)"
        )
        let decodedContent = request.decodedContent
        let temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookBlockSave_\(request.noteID.uuidString)_\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: temporaryDirectory)
        }

        var converter = try LegacyNoteDocumentConverter(noteID: request.noteID, noteDirectory: temporaryDirectory)
        let conversion = try converter.convert(content: decodedContent)
        let document = Self.compactLargePlainParagraphRuns(in: conversion.document)
        let attachmentsRoot = try persistentAttachmentsRootDirectory()
        let persistedAssetsByID = try persistBlockAssets(
            document: document,
            noteID: request.noteID,
            originalContent: decodedContent,
            noteDirectory: temporaryDirectory,
            attachmentsRoot: attachmentsRoot
        )
        let normalizedContent = normalizeContentForBlockSave(
            decodedContent,
            document: document,
            persistedAssetsByID: persistedAssetsByID,
            attachmentsRoot: attachmentsRoot
        )

        let noteID = request.noteID
        let oldBlockDescriptor = FetchDescriptor<BlockDocumentBlockEntity>(
            predicate: #Predicate<BlockDocumentBlockEntity> { $0.noteID == noteID }
        )
        let oldAssetDescriptor = FetchDescriptor<BlockDocumentAssetEntity>(
            predicate: #Predicate<BlockDocumentAssetEntity> { $0.noteID == noteID }
        )
        let previousAssets = try context.fetch(oldAssetDescriptor)
        let previousBlocks = try context.fetch(oldBlockDescriptor)

        let updatedAt = Date()

        // 脏检查：计算新内容哈希，与上次保存对比，仅实际变化时递增 version
        let newContentHash = Self.contentHashForDirtyCheck(
            document: document,
            title: request.title,
            folderID: request.folderID,
            folderName: request.folder,
            reminderAt: request.reminderAt,
            recurrenceRule: request.recurrenceRule
        )
        let hasContentChanged = newContentHash != entity.lastSavedContentHash
        let newVersion: Int64
        if hasContentChanged {
            newVersion = max(entity.version + 1, 1)
        } else {
            newVersion = entity.version
        }

        entity.title = request.title
        entity.updatedAt = hasContentChanged ? updatedAt : entity.updatedAt
        entity.folderID = request.folderID
        entity.folderName = request.folder
        entity.reminderAt = request.reminderAt
        entity.recurrenceRule = request.recurrenceRule
        entity.version = newVersion
        entity.lastSavedContentHash = newContentHash
        entity.documentSchemaVersion = document.schemaVersion
        entity.documentSource = document.source
        entity.blockCount = document.blocks.count
        entity.assetCount = persistedAssetsByID.count
        // 写入时一次性算好预览文本，避免列表加载时对每条笔记做额外的 blocks fetch
        entity.previewText = Self.previewTextForList(from: request.decodedContent.string)
        // 标记旧版复选框图片块已被转换器规范化为 todo_item 类型，
        // 后续加载时可跳过昂贵的像素检测启发式
        entity.hasLegacyCheckboxMigrated = true

        let orderedPersistedAssets = document.blocks
            .compactMap(\.asset)
            .compactMap { persistedAssetsByID[$0.id] }

        // ========================================
        // 增量更新 Asset 实体：按 assetID 进行 diff，避免每次全删全插
        // ========================================
        try Self.reconcileAssets(
            noteID: noteID,
            noteEntity: entity,
            previousAssets: previousAssets,
            orderedPersistedAssets: orderedPersistedAssets,
            context: context,
            encodeJSON: encodeJSON(_:)
        )

        // ========================================
        // 增量更新 Block 实体：按 blockID 进行 diff，避免每次全删全插
        // ========================================
        try Self.reconcileBlocks(
            noteID: noteID,
            noteEntity: entity,
            previousBlocks: previousBlocks,
            newBlocks: document.blocks,
            context: context,
            encodeText: encodeTextPayload(_:),
            encodeTable: encodeTablePayload(_:)
        )

        // 同步关联表：以当前 tagIDs 字符串为权威源全量重建关联记录，
        // 保证按标签筛选可走 SQLite 索引。
        // 注意：tagIDs 字段在 reconcileBlocks 之前已通过 entity.tagIDs 赋值，
        // 这里读取的是 entity 上的最新值。
        NoteStore.reconcileNoteTagLinks(
            noteID: request.noteID,
            libraryID: entity.libraryID,
            tagIDs: UUIDListCoding.decode(entity.tagIDs),
            context: context
        )

        _ = try BlockDocumentNoteVersionStore.ensureHistoryRecorded(noteID: request.noteID, context: context)
        try context.save()

        let preservedRelativePaths = Set(
            persistedAssetsByID.values.flatMap { persistedAsset in
                [persistedAsset.relativeFilePath] + persistedAsset.sidecarRelativePaths
            }
        )
        cleanupBlockArtifactFiles(
            relativePaths: staleRelativePaths(
                previousAssets: previousAssets
            ),
            preservedRelativePaths: preservedRelativePaths,
            attachmentsRoot: attachmentsRoot,
            noteID: request.noteID
        )

        if shouldCleanupAttachments(for: request.reason) {
            AttachmentManager.shared.cleanupUnusedAttachments(for: request.noteID, content: normalizedContent)
        } else {
            Logger.shared.log(.save, .debug, "saveBlockDocumentNote skipped attachment cleanup for reason=\(request.reason)")
        }

        interval.end(
            .info,
            "blocks=\(document.blocks.count) assets=\(persistedAssetsByID.count) normalizedLength=\(normalizedContent.length) dirty=\(hasContentChanged)"
        )
        return hasContentChanged
    }

    /// SwiftData 对数万条逐段实体的插入成本很高。长文档中只有普通段落的连续区间
    /// 可以安全合并为有限窗口；语义块（标题/列表/待办/附件/表格）始终保持原粒度。
    /// builder 会在块之间补一个换行，块内显式保存段落换行，因此正文可逐字符还原。
    private static func compactLargePlainParagraphRuns(in document: MigratedDocument) -> MigratedDocument {
        guard document.blocks.count > 512 else { return document }

        var compacted: [MigratedDocumentBlock] = []
        compacted.reserveCapacity(document.blocks.count / 4)
        var run: [MigratedDocumentBlock] = []
        run.reserveCapacity(256)

        func isPlainParagraph(_ block: MigratedDocumentBlock) -> Bool {
            block.type == "paragraph"
                && block.level == nil
                && block.listStyle == nil
                && block.order == nil
                && block.checked == nil
                && (block.indent ?? 0) == 0
                && block.asset == nil
                && block.table == nil
        }

        func sameFormatting(_ lhs: MigratedInlineText, _ rhs: MigratedInlineText) -> Bool {
            lhs.bold == rhs.bold
                && lhs.italic == rhs.italic
                && lhs.underline == rhs.underline
                && lhs.strikethrough == rhs.strikethrough
                && lhs.textColor == rhs.textColor
                && lhs.backgroundColor == rhs.backgroundColor
                && lhs.link == rhs.link
                && lhs.fontFamily == rhs.fontFamily
                && lhs.fontSize == rhs.fontSize
                && lhs.kern == rhs.kern
                && lhs.baselineOffset == rhs.baselineOffset
                && lhs.paragraphStyle == rhs.paragraphStyle
        }

        func span(_ template: MigratedInlineText?, text: String) -> MigratedInlineText {
            MigratedInlineText(
                text: text,
                bold: template?.bold ?? false,
                italic: template?.italic ?? false,
                underline: template?.underline ?? false,
                strikethrough: template?.strikethrough ?? false,
                textColor: template?.textColor,
                backgroundColor: template?.backgroundColor,
                link: template?.link,
                fontFamily: template?.fontFamily,
                fontSize: template?.fontSize,
                kern: template?.kern,
                baselineOffset: template?.baselineOffset,
                paragraphStyle: template?.paragraphStyle
            )
        }

        func flushRun() {
            guard !run.isEmpty else { return }
            var combined: [MigratedInlineText] = []
            combined.reserveCapacity(run.count * 2)

            func append(_ candidate: MigratedInlineText) {
                if let last = combined.last, sameFormatting(last, candidate) {
                    combined[combined.count - 1] = span(last, text: last.text + candidate.text)
                } else {
                    combined.append(candidate)
                }
            }

            for (index, block) in run.enumerated() {
                if index > 0 {
                    append(span(combined.last, text: "\n"))
                }
                for inline in block.text ?? [] {
                    append(inline)
                }
            }
            let first = run[0]
            compacted.append(
                MigratedDocumentBlock(
                    id: first.id,
                    type: "paragraph",
                    text: combined.isEmpty ? nil : combined,
                    level: nil,
                    listStyle: nil,
                    order: nil,
                    checked: nil,
                    indent: 0,
                    asset: nil,
                    table: nil
                )
            )
            run.removeAll(keepingCapacity: true)
        }

        for block in document.blocks {
            if isPlainParagraph(block) {
                run.append(block)
                if run.count == 256 {
                    flushRun()
                }
            } else {
                flushRun()
                compacted.append(block)
            }
        }
        flushRun()

        return MigratedDocument(
            schemaVersion: document.schemaVersion,
            source: document.source,
            blocks: compacted
        )
    }

    private func decodeAttributedString(from data: Data) -> NSAttributedString {
        if let content = try? NSAttributedString(
            data: data,
            options: rtfdReadOptions,
            documentAttributes: nil
        ) {
            return content
        }
        if let plain = String(data: data, encoding: .utf8) {
            return NSAttributedString(string: plain)
        }
        return NSAttributedString(string: "")
    }

    private func persistBlockAssets(
        document: MigratedDocument,
        noteID: UUID,
        originalContent: NSAttributedString,
        noteDirectory: URL,
        attachmentsRoot: URL
    ) throws -> [String: PersistedBlockAsset] {
        var persistedAssetsByID: [String: PersistedBlockAsset] = [:]
        let reusableAssets = reusablePersistedAssets(from: originalContent, attachmentsRoot: attachmentsRoot)
        var reusableAssetIndex = 0

        for reference in document.blocks.compactMap(\.asset) {
            guard persistedAssetsByID[reference.id] == nil else { continue }

            if reusableAssetIndex < reusableAssets.count,
               let reusableAsset = reusableAssets[reusableAssetIndex],
               reusableAsset.reference.kind == reference.kind {
                let persistedReference = MigratedAssetReference(
                    id: reference.id,
                    kind: reusableAsset.reference.kind,
                    filename: reusableAsset.reference.filename,
                    mimeType: reference.mimeType,
                    width: reference.width,
                    height: reference.height,
                    duration: reference.duration ?? reusableAsset.reference.duration,
                    createdAt: reference.createdAt ?? reusableAsset.reference.createdAt,
                    sidecarFiles: reusableAsset.reference.sidecarFiles
                )
                persistedAssetsByID[reference.id] = PersistedBlockAsset(
                    reference: persistedReference,
                    relativeFilePath: reusableAsset.relativeFilePath,
                    sidecarRelativePaths: reusableAsset.sidecarRelativePaths
                )
                reusableAssetIndex += 1
                continue
            }

            let sourceURL = noteDirectory.appendingPathComponent(reference.filename)
            guard FileManager.default.fileExists(atPath: sourceURL.path) else {
                throw NSError(
                    domain: "SaveManager",
                    code: -4,
                    userInfo: [NSLocalizedDescriptionKey: "Missing converted asset at \(reference.filename)"]
                )
            }

            let baseRelativeDirectory = "BlockDocuments/\(noteID.uuidString)/\(reference.id)"
            let relativeFilePath = "\(baseRelativeDirectory)/\(sourceURL.lastPathComponent)"
            try copyItemReplacingIfNeeded(
                from: sourceURL,
                to: attachmentsRoot.appendingPathComponent(relativeFilePath)
            )

            let sidecarRelativePaths = try reference.sidecarFiles.map { sidecarPath in
                let sourceSidecarURL = noteDirectory.appendingPathComponent(sidecarPath)
                let relativeSidecarPath = "\(baseRelativeDirectory)/\(sourceSidecarURL.lastPathComponent)"
                try copyItemReplacingIfNeeded(
                    from: sourceSidecarURL,
                    to: attachmentsRoot.appendingPathComponent(relativeSidecarPath)
                )
                return relativeSidecarPath
            }

            let persistedReference = MigratedAssetReference(
                id: reference.id,
                kind: reference.kind,
                filename: sourceURL.lastPathComponent,
                mimeType: reference.mimeType,
                width: reference.width,
                height: reference.height,
                duration: reference.duration,
                createdAt: reference.createdAt,
                sidecarFiles: sidecarRelativePaths.map { URL(fileURLWithPath: $0).lastPathComponent }
            )

            persistedAssetsByID[reference.id] = PersistedBlockAsset(
                reference: persistedReference,
                relativeFilePath: relativeFilePath,
                sidecarRelativePaths: sidecarRelativePaths
            )
            reusableAssetIndex += 1
        }

        return persistedAssetsByID
    }

    private func normalizeContentForBlockSave(
        _ content: NSAttributedString,
        document: MigratedDocument,
        persistedAssetsByID: [String: PersistedBlockAsset],
        attachmentsRoot: URL
    ) -> NSAttributedString {
        let orderedAssets = document.blocks
            .compactMap(\.asset)
            .compactMap { persistedAssetsByID[$0.id] }
        guard !orderedAssets.isEmpty else {
            return content
        }

        let mutable = NSMutableAttributedString(attributedString: content)
        let fullRange = NSRange(location: 0, length: mutable.length)
        var attachmentEntries: [(range: NSRange, attachment: NSTextAttachment, attributes: [NSAttributedString.Key: Any])] = []

        mutable.enumerateAttribute(.attachment, in: fullRange, options: []) { value, subrange, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            if attachment is CheckboxTextAttachment {
                return
            }

            let attributes = mutable.attributes(at: subrange.location, effectiveRange: nil)
            if attachment is TableTextAttachment {
                return
            }
            if attributes[.notebookTableData] is Data {
                return
            }
            if TableTextAttachment.looksLikeTable(attachment) {
                return
            }

            attachmentEntries.append((subrange, attachment, attributes))
        }

        for (entry, persistedAsset) in zip(attachmentEntries.reversed(), orderedAssets.reversed()) {
            guard let replacement = replacementAttachmentString(
                from: entry.attachment,
                attributes: entry.attributes,
                persistedAsset: persistedAsset,
                attachmentsRoot: attachmentsRoot
            ) else {
                continue
            }
            mutable.replaceCharacters(in: entry.range, with: replacement)
        }

        return mutable
    }

    private func replacementAttachmentString(
        from originalAttachment: NSTextAttachment,
        attributes: [NSAttributedString.Key: Any],
        persistedAsset: PersistedBlockAsset,
        attachmentsRoot: URL
    ) -> NSAttributedString? {
        let fileURL = attachmentsRoot.appendingPathComponent(persistedAsset.relativeFilePath)
        let replacement = NSMutableAttributedString()

        switch persistedAsset.reference.kind {
        case "image":
            let attachment = AttachmentTextAttachment(fileURL: fileURL, kind: .image)
            if originalAttachment.bounds.width > 1, originalAttachment.bounds.height > 1 {
                attachment.bounds = originalAttachment.bounds
            }
            replacement.append(NSAttributedString(attachment: attachment))
            applyAttributes(attributes, to: replacement)

            let width = (attributes[.notebookImageWidth] as? CGFloat) ?? attachment.bounds.width
            let height = (attributes[.notebookImageHeight] as? CGFloat) ?? attachment.bounds.height
            if width > 1, height > 1 {
                replacement.addAttribute(.notebookImageWidth, value: width, range: NSRange(location: 0, length: replacement.length))
                replacement.addAttribute(.notebookImageHeight, value: height, range: NSRange(location: 0, length: replacement.length))
                let imageLink = "notebook-image://\(fileURL.absoluteString)#w=\(Int(width.rounded()))&h=\(Int(height.rounded()))"
                replacement.addAttribute(.link, value: imageLink, range: NSRange(location: 0, length: replacement.length))
            }
            return replacement
        case "audio":
            let duration = persistedAsset.reference.duration ?? (originalAttachment as? AudioBlockAttachment)?.duration ?? 0
            let createdAt = persistedAsset.reference.createdAt ?? (originalAttachment as? AudioBlockAttachment)?.createDate ?? Date()
            let attachment = AudioBlockAttachment(fileURL: fileURL, duration: duration, createDate: createdAt)
            if !originalAttachment.bounds.isEmpty {
                attachment.bounds = originalAttachment.bounds
            }
            replacement.append(NSAttributedString(attachment: attachment))
            applyAttributes(attributes, to: replacement)
            replacement.addAttribute(.link, value: fileURL, range: NSRange(location: 0, length: replacement.length))
            return replacement
        default:
            return nil
        }
    }

    private func applyAttributes(
        _ attributes: [NSAttributedString.Key: Any],
        to attributedString: NSMutableAttributedString
    ) {
        let range = NSRange(location: 0, length: attributedString.length)
        for (key, value) in attributes {
            if key == .attachment || key == .link || key == .notebookImageWidth || key == .notebookImageHeight {
                continue
            }
            attributedString.addAttribute(key, value: value, range: range)
        }
    }

    private func persistentAttachmentsRootDirectory() throws -> URL {
        let storage = StorageLocationManager.shared
        guard let base = storage.baseDirectoryURL else {
            throw NSError(domain: "SaveManager", code: -5, userInfo: [NSLocalizedDescriptionKey: "Storage not configured"])
        }

        return try storage.withSecurityScopedAccess(base) {
            try storage.ensureDirectoryStructureExists()
            let attachmentsRoot = try storage.attachmentsDirectoryURL()
            try FileManager.default.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
            return attachmentsRoot
        }
    }

    private func copyItemReplacingIfNeeded(from sourceURL: URL, to destinationURL: URL) throws {
        try AtomicFileCommit.copyReplacingAtomically(from: sourceURL, to: destinationURL)
    }

    private func reusablePersistedAssets(
        from content: NSAttributedString,
        attachmentsRoot: URL
    ) -> [PersistedBlockAsset?] {
        let range = NSRange(location: 0, length: content.length)
        var assets: [PersistedBlockAsset?] = []

        content.enumerateAttribute(.attachment, in: range, options: []) { value, subrange, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            if attachment is CheckboxTextAttachment {
                return
            }

            let attributes = content.attributes(at: subrange.location, effectiveRange: nil)
            if attachment is TableTextAttachment {
                return
            }
            if attributes[.notebookTableData] is Data {
                return
            }
            if TableTextAttachment.looksLikeTable(attachment) {
                return
            }

            assets.append(reusablePersistedAsset(for: attachment, attachmentsRoot: attachmentsRoot))
        }

        return assets
    }

    private func reusablePersistedAsset(
        for attachment: NSTextAttachment,
        attachmentsRoot: URL
    ) -> PersistedBlockAsset? {
        if let imageAttachment = attachment as? AttachmentTextAttachment,
           imageAttachment.kind == .image,
           let relativeFilePath = relativePathIfInsideAttachmentsRoot(imageAttachment.attachmentFileURL, attachmentsRoot: attachmentsRoot) {
            return PersistedBlockAsset(
                reference: MigratedAssetReference(
                    id: relativeFilePath,
                    kind: "image",
                    filename: imageAttachment.attachmentFileURL.lastPathComponent,
                    mimeType: mimeTypeForPathExtension(imageAttachment.attachmentFileURL.pathExtension),
                    width: nil,
                    height: nil,
                    duration: nil,
                    createdAt: nil,
                    sidecarFiles: []
                ),
                relativeFilePath: relativeFilePath,
                sidecarRelativePaths: []
            )
        }

        if let audioAttachment = attachment as? AudioBlockAttachment,
           let relativeFilePath = relativePathIfInsideAttachmentsRoot(audioAttachment.fileURL, attachmentsRoot: attachmentsRoot) {
            let sidecarRelativePaths = reusableAudioSidecarPaths(for: audioAttachment, attachmentsRoot: attachmentsRoot)
            return PersistedBlockAsset(
                reference: MigratedAssetReference(
                    id: relativeFilePath,
                    kind: "audio",
                    filename: audioAttachment.fileURL.lastPathComponent,
                    mimeType: mimeTypeForPathExtension(audioAttachment.fileURL.pathExtension),
                    width: nil,
                    height: nil,
                    duration: audioAttachment.duration,
                    createdAt: audioAttachment.createDate,
                    sidecarFiles: sidecarRelativePaths.map { URL(fileURLWithPath: $0).lastPathComponent }
                ),
                relativeFilePath: relativeFilePath,
                sidecarRelativePaths: sidecarRelativePaths
            )
        }

        return nil
    }

    private func reusableAudioSidecarPaths(
        for attachment: AudioBlockAttachment,
        attachmentsRoot: URL
    ) -> [String] {
        guard attachment.manifestFilename != nil else { return [] }
        let manifestURL = attachment.fileURL.deletingPathExtension().appendingPathExtension("tracks.json")
        guard let relativePath = relativePathIfInsideAttachmentsRoot(manifestURL, attachmentsRoot: attachmentsRoot) else {
            return []
        }
        return [relativePath]
    }

    private func relativePathIfInsideAttachmentsRoot(
        _ fileURL: URL,
        attachmentsRoot: URL
    ) -> String? {
        let standardizedFileURL = fileURL.standardizedFileURL
        let standardizedRootURL = attachmentsRoot.standardizedFileURL
        let rootPath = standardizedRootURL.path.hasSuffix("/") ? standardizedRootURL.path : standardizedRootURL.path + "/"
        let filePath = standardizedFileURL.path
        guard filePath.hasPrefix(rootPath) else { return nil }
        return String(filePath.dropFirst(rootPath.count))
    }

    private func shouldCleanupAttachments(for reason: String) -> Bool {
        switch reason {
        case "appBlur", "switch", "externalNavigation", "filterSync":
            return false
        default:
            return true
        }
    }

    private func mimeTypeForPathExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "webp": return "image/webp"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        case "aif", "aiff": return "audio/aiff"
        case "caf": return "audio/x-caf"
        default: return "application/octet-stream"
        }
    }

    func cleanupBlockArtifactFiles(
        relativePaths: [String],
        preservedRelativePaths: Set<String>,
        attachmentsRoot: URL,
        noteID: UUID
    ) {
        let fileManager = FileManager.default
        for relativePath in Set(relativePaths) {
            guard !preservedRelativePaths.contains(relativePath) else { continue }
            let fileURL = attachmentsRoot.appendingPathComponent(relativePath)
            guard fileManager.fileExists(atPath: fileURL.path) else { continue }
            try? fileManager.removeItem(at: fileURL)
            removeEmptyParents(startingAt: fileURL.deletingLastPathComponent(), stopAt: attachmentsRoot)
        }

        let noteDirectory = attachmentsRoot
            .appendingPathComponent("BlockDocuments", isDirectory: true)
            .appendingPathComponent(noteID.uuidString, isDirectory: true)
        removeEmptyParents(startingAt: noteDirectory, stopAt: attachmentsRoot)
    }

    func staleRelativePaths(
        previousAssets: [BlockDocumentAssetEntity]
    ) -> [String] {
        var paths: [String] = []
        for asset in previousAssets {
            paths.append(asset.relativeFilePath)
            if let sidecarPayload = asset.sidecarPathsPayload,
               let sidecarPaths = try? JSONDecoder().decode([String].self, from: sidecarPayload) {
                paths.append(contentsOf: sidecarPaths)
            }
        }
        return paths
    }

    private func removeEmptyParents(startingAt directoryURL: URL, stopAt rootURL: URL) {
        let fileManager = FileManager.default
        let rootPath = rootURL.standardizedFileURL.path
        var currentDirectory = directoryURL.standardizedFileURL

        while currentDirectory.path.hasPrefix(rootPath),
              currentDirectory.path != rootPath,
              fileManager.fileExists(atPath: currentDirectory.path) {
            let children = (try? fileManager.contentsOfDirectory(atPath: currentDirectory.path)) ?? []
            if !children.isEmpty {
                break
            }
            try? fileManager.removeItem(at: currentDirectory)
            currentDirectory.deleteLastPathComponent()
        }
    }

    private func encodeTextPayload(_ spans: [MigratedInlineText]) throws -> Data? {
        guard !spans.isEmpty else {
            return nil
        }

        let payload = spans.map {
            BlockDocumentTextSpanPayload(
                text: $0.text,
                bold: $0.bold,
                italic: $0.italic,
                underline: $0.underline,
                strikethrough: $0.strikethrough,
                textColor: $0.textColor,
                backgroundColor: $0.backgroundColor,
                link: $0.link,
                fontFamily: $0.fontFamily,
                fontSize: $0.fontSize,
                kern: $0.kern,
                baselineOffset: $0.baselineOffset,
                paragraphStyle: $0.paragraphStyle.map {
                    BlockDocumentParagraphStylePayload(
                        alignment: $0.alignment,
                        lineSpacing: $0.lineSpacing,
                        paragraphSpacing: $0.paragraphSpacing,
                        paragraphSpacingBefore: $0.paragraphSpacingBefore,
                        firstLineHeadIndent: $0.firstLineHeadIndent,
                        headIndent: $0.headIndent,
                        tailIndent: $0.tailIndent
                    )
                }
            )
        }
        return try encodeJSON(payload)
    }

    private func encodeTablePayload(_ table: MigratedTable?) throws -> Data? {
        guard let table else {
            return nil
        }

        return try encodeJSON(
            BlockDocumentTablePayload(
                rows: table.rows,
                columnWidths: table.columnWidths,
                rowHeights: table.rowHeights
            )
        )
    }

    private func encodeJSON<T: Encodable>(_ value: T) throws -> Data {
        try jsonEncoder.encode(value)
    }
    
    /// 使用 SHA-256 稳定计算内容哈希用于脏检查。
    ///
    /// 注意：**不**使用 Swift 标准库 `Hasher`，因为它在每次进程启动时使用随机种子，
    /// 导致相同的输入产生不同的哈希值，这使得跨重启的脏检查失效。
    ///
    /// 改用 `CryptoKit.SHA256` 保证确定性输出，同时与同步模块的 `snapshotFingerprint`
    /// 保持一致的哈希强度。
    private static func contentHashForDirtyCheck(
        document: MigratedDocument,
        title: String,
        folderID: UUID?,
        folderName: String,
        reminderAt: Date?,
        recurrenceRule: String
    ) -> String {
        let payload = DirtyCheckHashPayload(
            title: title,
            folderID: folderID?.uuidString,
            folderName: folderName,
            reminderAtTimestamp: reminderAt?.timeIntervalSince1970,
            recurrenceRule: recurrenceRule,
            document: document
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(payload)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// 为列表生成预览文本（与 `NoteStore.previewText(from:)` 保持一致）
    nonisolated static func previewTextForList(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.components(separatedBy: .newlines)
        return lines.prefix(2).joined(separator: " ")
    }

    // MARK: — 增量更新: Asset 实体（按 assetID diff，避免全删全插）

    private static func reconcileAssets(
        noteID: UUID,
        noteEntity: BlockDocumentNoteEntity,
        previousAssets: [BlockDocumentAssetEntity],
        orderedPersistedAssets: [PersistedBlockAsset],
        context: ModelContext,
        encodeJSON: ([String]) throws -> Data
    ) throws {
        let prevByID = Dictionary(uniqueKeysWithValues: previousAssets.map { ($0.assetID, $0) })
        var keptAssetIDs = Set<String>()

        for persistedAsset in orderedPersistedAssets {
            let assetID = persistedAsset.reference.id
            keptAssetIDs.insert(assetID)

            let sidecarPathsPayload = try encodeJSON(persistedAsset.sidecarRelativePaths)

            if let existing = prevByID[assetID] {
                if existing.kind != persistedAsset.reference.kind
                    || existing.sourceKind != persistedAsset.reference.kind
                    || existing.filename != persistedAsset.reference.filename
                    || existing.mimeType != persistedAsset.reference.mimeType
                    || existing.width != persistedAsset.reference.width
                    || existing.height != persistedAsset.reference.height
                    || existing.duration != persistedAsset.reference.duration
                    || existing.createdAt != persistedAsset.reference.createdAt
                    || existing.relativeFilePath != persistedAsset.relativeFilePath
                    || existing.sidecarPathsPayload != sidecarPathsPayload
                {
                    existing.kind = persistedAsset.reference.kind
                    existing.sourceKind = persistedAsset.reference.kind
                    existing.filename = persistedAsset.reference.filename
                    existing.mimeType = persistedAsset.reference.mimeType
                    existing.width = persistedAsset.reference.width
                    existing.height = persistedAsset.reference.height
                    existing.duration = persistedAsset.reference.duration
                    existing.createdAt = persistedAsset.reference.createdAt
                    existing.relativeFilePath = persistedAsset.relativeFilePath
                    existing.sidecarPathsPayload = sidecarPathsPayload
                }
                // 确保反向关系已建立（旧数据可能为 nil）
                if existing.note == nil {
                    existing.note = noteEntity
                }
                continue
            }

            // 新增：同步设置 noteID（predicate 查询用）与 note 关系（级联删除用）
            let newAsset = BlockDocumentAssetEntity(
                noteID: noteID,
                assetID: assetID,
                kind: persistedAsset.reference.kind,
                sourceKind: persistedAsset.reference.kind,
                filename: persistedAsset.reference.filename,
                mimeType: persistedAsset.reference.mimeType,
                width: persistedAsset.reference.width,
                height: persistedAsset.reference.height,
                duration: persistedAsset.reference.duration,
                createdAt: persistedAsset.reference.createdAt,
                relativeFilePath: persistedAsset.relativeFilePath,
                sidecarPathsPayload: sidecarPathsPayload
            )
            newAsset.note = noteEntity
            context.insert(newAsset)
        }

        // 删除已不存在的 asset
        for (assetID, entity) in prevByID where !keptAssetIDs.contains(assetID) {
            context.delete(entity)
        }
    }

    // MARK: — 增量更新: Block 实体（按 blockID diff，避免全删全插）

    private static func reconcileBlocks(
        noteID: UUID,
        noteEntity: BlockDocumentNoteEntity,
        previousBlocks: [BlockDocumentBlockEntity],
        newBlocks: [MigratedDocumentBlock],
        context: ModelContext,
        encodeText: ([MigratedInlineText]) throws -> Data?,
        encodeTable: (MigratedTable?) throws -> Data?
    ) throws {
        let prevByID = Dictionary(uniqueKeysWithValues: previousBlocks.map { ($0.blockID, $0) })
        var keptBlockIDs = Set<String>()

        for newPosition in newBlocks.indices {
            let block = newBlocks[newPosition]
            keptBlockIDs.insert(block.id)

            if let existing = prevByID[block.id] {
                // 更新已有 block 的可变字段（位置、文本、状态）
                let textPayload = try encodeText(block.text ?? [])
                let tablePayload = try encodeTable(block.table)

                if existing.position != newPosition
                    || existing.kind != block.type
                    || existing.textPayload != textPayload
                    || existing.level != block.level
                    || existing.listStyle != block.listStyle
                    || existing.order != block.order
                    || existing.checked != block.checked
                    || existing.indent != block.indent
                    || existing.assetID != block.asset?.id
                    || existing.tablePayload != tablePayload
                {
                    existing.position = newPosition
                    existing.kind = block.type
                    existing.sourceType = block.type
                    existing.textPayload = textPayload
                    existing.level = block.level
                    existing.listStyle = block.listStyle
                    existing.order = block.order
                    existing.checked = block.checked
                    existing.indent = block.indent
                    existing.assetID = block.asset?.id
                    existing.tablePayload = tablePayload
                }
                // 确保反向关系已建立（旧数据可能为 nil）
                if existing.note == nil {
                    existing.note = noteEntity
                }
            } else {
                // 新增 block：同步设置 noteID（predicate 查询用）与 note 关系（级联删除用）
                let newBlock = BlockDocumentBlockEntity(
                    noteID: noteID,
                    position: newPosition,
                    blockID: block.id,
                    kind: block.type,
                    sourceType: block.type,
                    textPayload: try encodeText(block.text ?? []),
                    level: block.level,
                    listStyle: block.listStyle,
                    order: block.order,
                    checked: block.checked,
                    indent: block.indent,
                    assetID: block.asset?.id,
                    tablePayload: try encodeTable(block.table)
                )
                newBlock.note = noteEntity
                context.insert(newBlock)
            }
        }

        // 删除已不存在的 block
        for (blockID, entity) in prevByID where !keptBlockIDs.contains(blockID) {
            context.delete(entity)
        }
    }

    /// 验证数据完整性
    private func validateData(_ data: Data) -> Bool {
        // 检查数据是否为空
        guard !data.isEmpty else {
            DebugLog.save("Validation failed: empty data", level: .warn)
            return false
        }

        // 检查数据大小（至少要有基本的 RTFD 头）
        guard data.count > 100 else {
            DebugLog.save("Validation failed: data too small (\(data.count) bytes)", level: .warn)
            return false
        }

        // 尝试解析验证
        do {
            if let _ = try? NSAttributedString(
                data: data,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            ) {
                return true
            }
        }

        // 如果无法解析，可能是纯文本或其他格式，也接受
        return true
    }
}

private struct PersistedBlockAsset {
    let reference: MigratedAssetReference
    let relativeFilePath: String
    let sidecarRelativePaths: [String]
}

private struct DirtyCheckHashPayload: Codable {
    let title: String
    let folderID: String?
    let folderName: String
    let reminderAtTimestamp: TimeInterval?
    let recurrenceRule: String
    let document: MigratedDocument
}

// MARK: - 便捷方法

extension NoteSaveManager {
    /// 从编辑器内容创建保存请求
    func createRequest(
        noteID: UUID,
        title: String,
        folderID: UUID?,
        folder: String,
        reminderAt: Date?,
        recurrenceRule: String,
        content: NSAttributedString,
        reason: String,
        allowsDestructiveEmptySave: Bool = false
    ) -> SaveRequest? {
        let interval = Logger.shared.beginInterval(
            .save,
            "createSaveRequest",
            metadata: "noteID=\(noteID.uuidString.prefix(8)) reason=\(reason) contentLength=\(content.length)"
        )
        Logger.shared.log(.save, .debug, "createRequest: cleaning content for storage...")
        let normalized = AttachmentManager.shared.normalizedContentForSaving(content, noteID: noteID)
        let cleaned = normalized.cleanedForStorage()
        Logger.shared.log(.save, .debug, "createRequest: content cleaned, length: \(cleaned.length)")

        Logger.shared.log(.save, .debug, "createRequest: converting to RTFD data...")
        guard let rtfdData = try? cleaned.data(
            from: NSRange(location: 0, length: cleaned.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
        ) else {
            Logger.shared.log(.save, .error, "ERROR: Failed to serialize content - id=\(noteID)")
            interval.end(.error, "serializationFailed")
            return nil
        }
        Logger.shared.log(.save, .debug, "createRequest: RTFD data created, size: \(rtfdData.count) bytes")
        interval.end(.info, "rtfdBytes=\(rtfdData.count) normalizedLength=\(normalized.length) cleanedLength=\(cleaned.length)")

        return SaveRequest(
            noteID: noteID,
            title: title,
            folderID: folderID,
            folder: folder,
            reminderAt: reminderAt,
            recurrenceRule: recurrenceRule,
            rtfdData: rtfdData,
            decodedContent: cleaned,
            allowsDestructiveEmptySave: allowsDestructiveEmptySave,
            reason: reason,
            timestamp: Date()
        )
    }
}
