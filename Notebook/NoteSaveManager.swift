//
//  NoteSaveManager.swift
//  Notebook
//
//  笔记保存管理器 - 最高安全性和稳定性优先
//  设计原则：
//  1. 所有保存操作都是同步阻塞的，确保完成后再继续
//  2. 保存时锁定笔记，防止并发修改
//  3. 所有状态变更都有日志记录
//  4. 失败时重试，成功才返回
//

import Foundation
import SwiftData
import AppKit

/// 保存结果
enum SaveResult {
    case success
    case failure(Error)
}

/// 保存请求
struct SaveRequest {
    let noteID: UUID
    let title: String
    let folderID: UUID?
    let folder: String
    let reminderAt: Date?
    let recurrenceRule: String
    let rtfdData: Data
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
    
    // 保存队列 - 确保同一时间只有一个保存操作在执行
    private let saveQueue = DispatchQueue(label: "com.notebook.save", qos: .userInitiated)
    
    // 当前正在保存的笔记ID
    private var currentlySaving: Set<UUID> = []
    
    // 待保存的队列（用于自动保存去抖）
    private var pendingSaves: [UUID: SaveRequest] = [:]
    private var pendingTimers: [UUID: Timer] = [:]
    
    private init() {}
    
    func setContext(_ context: ModelContext) {
        self.modelContext = context
    }

    func resetForTesting() {
        modelContext = nil
        currentlySaving.removeAll()
        pendingSaves.removeAll()
        for timer in pendingTimers.values {
            timer.invalidate()
        }
        pendingTimers.removeAll()
    }
    
    // MARK: - 公共 API
    
    /// 立即同步保存 - 阻塞直到保存完成
    func saveImmediately(request: SaveRequest) -> SaveResult {
        cancelPendingSave(for: request.noteID)
        return performSave(request: request)
    }
    
    /// 延迟保存（自动保存）- 去抖处理
    func scheduleSave(request: SaveRequest, delay: TimeInterval = 1.0) {
        let noteID = request.noteID
        cancelPendingSave(for: noteID)
        pendingSaves[noteID] = request
        
        let timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            DispatchQueue.main.async {
                if let pendingRequest = self.pendingSaves[noteID] {
                    self.pendingSaves.removeValue(forKey: noteID)
                    _ = self.performSave(request: pendingRequest)
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
        return performSave(request: request)
    }
    
    /// 取消待保存任务
    func cancelPendingSave(for noteID: UUID) {
        if let timer = pendingTimers[noteID] {
            timer.invalidate()
            pendingTimers.removeValue(forKey: noteID)
            pendingSaves.removeValue(forKey: noteID)
        }
    }
    
    /// 强制刷新所有待保存内容
    func flushAllPending() {
        let pending = pendingSaves
        pendingSaves.removeAll()
        
        for timer in pendingTimers.values {
            timer.invalidate()
        }
        pendingTimers.removeAll()
        
        for request in pending.values {
            _ = performSave(request: request)
        }
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

        // 检查是否正在保存该笔记
        guard !currentlySaving.contains(noteID) else {
            interval.end(.warn, "alreadySaving_retry")
            return waitAndRetry(request: request, maxRetries: 3)
        }

        // 标记为正在保存（用于崩溃检测）
        currentlySaving.insert(noteID)
        BackupManager.shared.markSaveStart(noteID: noteID)

        defer {
            currentlySaving.remove(noteID)
            BackupManager.shared.markSaveComplete()
        }

        // 先创建备份
        BackupManager.shared.createBackup(
            noteID: noteID,
            title: request.title,
            rtfdData: request.rtfdData,
            reason: request.reason
        )

        // 执行保存
        do {
            guard validateData(request.rtfdData) else {
                interval.end(.error, "validationFailed")
                return .failure(NSError(domain: "SaveManager", code: -3, userInfo: [NSLocalizedDescriptionKey: "Data validation failed"]))
            }

            let blockDescriptor = FetchDescriptor<BlockDocumentNoteEntity>(
                predicate: #Predicate<BlockDocumentNoteEntity> { $0.id == noteID }
            )
            let blockEntities = try context.fetch(blockDescriptor)
            if let blockEntity = blockEntities.first {
                let hasContentChanged = try saveBlockDocumentNote(entity: blockEntity, request: request, context: context)
                if hasContentChanged {
                    AutoSyncCoordinator.shared.noteDidSave(noteID: request.noteID, reason: request.reason)
                }
                interval.end(.info, "result=success")
                return .success
            }

            interval.end(.error, "entityMissing")
            return .failure(NSError(domain: "SaveManager", code: -2, userInfo: [NSLocalizedDescriptionKey: "Entity not found"]))
        } catch {
            interval.end(.error, "result=failure error=\(error.localizedDescription)")
            return .failure(error)
        }
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
        let decodedContent = decodeAttributedString(from: request.rtfdData)
        let temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookBlockSave_\(request.noteID.uuidString)_\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: temporaryDirectory)
        }

        var converter = try LegacyNoteDocumentConverter(noteID: request.noteID, noteDirectory: temporaryDirectory)
        let conversion = try converter.convert(content: decodedContent)
        let attachmentsRoot = try persistentAttachmentsRootDirectory()
        let persistedAssetsByID = try persistBlockAssets(
            document: conversion.document,
            noteID: request.noteID,
            originalContent: decodedContent,
            noteDirectory: temporaryDirectory,
            attachmentsRoot: attachmentsRoot
        )
        let normalizedContent = normalizeContentForBlockSave(
            decodedContent,
            document: conversion.document,
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

        for block in try context.fetch(oldBlockDescriptor) {
            context.delete(block)
        }
        for asset in previousAssets {
            context.delete(asset)
        }

        let updatedAt = Date()

        // 脏检查：计算新内容哈希，与上次保存对比，仅实际变化时递增 version
        let newContentHash = Self.contentHashForDirtyCheck(
            document: conversion.document,
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
        entity.documentSchemaVersion = conversion.document.schemaVersion
        entity.documentSource = conversion.document.source
        entity.blockCount = conversion.document.blocks.count
        entity.assetCount = persistedAssetsByID.count

        let orderedPersistedAssets = conversion.document.blocks
            .compactMap(\.asset)
            .compactMap { persistedAssetsByID[$0.id] }

        for persistedAsset in orderedPersistedAssets {
            context.insert(
                BlockDocumentAssetEntity(
                    noteID: request.noteID,
                    assetID: persistedAsset.reference.id,
                    kind: persistedAsset.reference.kind,
                    sourceKind: persistedAsset.reference.kind,
                    filename: persistedAsset.reference.filename,
                    mimeType: persistedAsset.reference.mimeType,
                    width: persistedAsset.reference.width,
                    height: persistedAsset.reference.height,
                    duration: persistedAsset.reference.duration,
                    createdAt: persistedAsset.reference.createdAt,
                    relativeFilePath: persistedAsset.relativeFilePath,
                    sidecarPathsPayload: try encodeJSON(persistedAsset.sidecarRelativePaths)
                )
            )
        }

        for (position, block) in conversion.document.blocks.enumerated() {
            context.insert(
                BlockDocumentBlockEntity(
                    noteID: request.noteID,
                    position: position,
                    blockID: block.id,
                    kind: block.type,
                    sourceType: block.type,
                    textPayload: try encodeTextPayload(block.text ?? []),
                    level: block.level,
                    listStyle: block.listStyle,
                    order: block.order,
                    checked: block.checked,
                    indent: block.indent,
                    assetID: block.asset?.id,
                    tablePayload: try encodeTablePayload(block.table)
                )
            )
        }

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
            "blocks=\(conversion.document.blocks.count) assets=\(persistedAssetsByID.count) normalizedLength=\(normalizedContent.length) dirty=\(hasContentChanged)"
        )
        return hasContentChanged
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
        try FileManager.default.createDirectory(at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }
        try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
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
    
    /// 计算内容哈希用于脏检查，仅当哈希变化时才递增 version
    private static func contentHashForDirtyCheck(
        document: MigratedDocument,
        title: String,
        folderID: UUID?,
        folderName: String,
        reminderAt: Date?,
        recurrenceRule: String
    ) -> String {
        var hasher = Hasher()
        hasher.combine(title)
        hasher.combine(folderID)
        hasher.combine(folderName)
        hasher.combine(reminderAt)
        hasher.combine(recurrenceRule)
        for block in document.blocks {
            hasher.combine(block.id)
            hasher.combine(block.type)
            if let text = block.text {
                for span in text {
                    hasher.combine(span.text)
                    hasher.combine(span.bold)
                    hasher.combine(span.italic)
                    hasher.combine(span.underline)
                    hasher.combine(span.strikethrough)
                    hasher.combine(span.link)
                }
            }
            hasher.combine(block.level)
            hasher.combine(block.listStyle)
            hasher.combine(block.order)
            hasher.combine(block.checked)
            hasher.combine(block.indent)
            if let asset = block.asset {
                hasher.combine(asset.id)
                hasher.combine(asset.kind)
                hasher.combine(asset.filename)
            }
            if let table = block.table {
                hasher.combine(table.rows)
                hasher.combine(table.columnWidths)
                hasher.combine(table.rowHeights)
            }
        }
        return String(hasher.finalize())
    }

    /// 等待并重试保存
    private func waitAndRetry(request: SaveRequest, maxRetries: Int) -> SaveResult {
        var retries = 0

        while retries < maxRetries {
            Thread.sleep(forTimeInterval: 0.05)
            if !currentlySaving.contains(request.noteID) {
                return performSave(request: request)
            }
            retries += 1
        }

        // 重试耗尽后再次检查锁，若仍被占用则返回失败而非绕过锁
        if currentlySaving.contains(request.noteID) {
            Logger.shared.log(.save, .error, "waitAndRetry exhausted for noteID=\(request.noteID.uuidString.prefix(8))")
            return .failure(NSError(
                domain: "SaveManager",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "笔记正在保存中，请稍后重试"]
            ))
        }
        return performSave(request: request)
    }

    /// 验证数据完整性
    private func validateData(_ data: Data) -> Bool {
        // 检查数据是否为空
        guard !data.isEmpty else {
            print("[SaveManager] Validation failed: empty data")
            return false
        }

        // 检查数据大小（至少要有基本的 RTFD 头）
        guard data.count > 100 else {
            print("[SaveManager] Validation failed: data too small (\(data.count) bytes)")
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
        reason: String
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
            reason: reason,
            timestamp: Date()
        )
    }
}
