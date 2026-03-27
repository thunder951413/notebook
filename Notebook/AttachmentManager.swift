import Foundation
import AppKit

enum AttachmentKind: String {
    case image
    case audio
}

@MainActor
final class AttachmentManager {
    static let shared = AttachmentManager()

    private struct CleanupFolderSignature: Equatable {
        let exists: Bool
        let modificationDate: Date?
    }

    private struct CleanupCheckpoint {
        let referencedFiles: Set<String>
        let folderSignature: CleanupFolderSignature
        let nextEligibleCleanupAt: Date?
    }

    private var cleanupCheckpoints: [UUID: CleanupCheckpoint] = [:]

    private init() {}

    func copyAttachmentToStore(sourceURL: URL, noteID: UUID, kind: AttachmentKind) throws -> URL {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else {
            throw NSError(domain: "AttachmentManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "未配置保存目录"])
        }

        return try location.withSecurityScopedAccess(base) {
            try location.ensureDirectoryStructureExists()

            let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

            let ext = sourceURL.pathExtension
            let filename = UUID().uuidString + (ext.isEmpty ? "" : ".\(ext)")
            let dest = folder.appendingPathComponent(filename, isDirectory: false)

            try FileManager.default.copyItem(at: sourceURL, to: dest)
            return dest
        }
    }

    func normalizedContentForSaving(_ content: NSAttributedString, noteID: UUID) -> NSAttributedString {
        let mutable = NSMutableAttributedString(attributedString: content)
        let fullRange = NSRange(location: 0, length: content.length)
        var attachmentEntries: [(range: NSRange, attachment: NSTextAttachment, attributes: [NSAttributedString.Key: Any])] = []

        content.enumerateAttribute(.attachment, in: fullRange, options: []) { value, range, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            if attachment is CheckboxTextAttachment || attachment is TableTextAttachment {
                return
            }
            let attributes = content.attributes(at: range.location, effectiveRange: nil)
            if attributes[.notebookTableData] is Data || TableTextAttachment.looksLikeTable(attachment) {
                return
            }
            attachmentEntries.append((range, attachment, attributes))
        }

        for entry in attachmentEntries.reversed() {
            guard let replacement = replacementAttachmentString(
                from: entry.attachment,
                attributes: entry.attributes,
                noteID: noteID
            ) else {
                continue
            }
            mutable.replaceCharacters(in: entry.range, with: replacement)
        }

        return mutable
    }

    func deleteAttachments(for noteID: UUID) {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else { return }

        cleanupCheckpoints.removeValue(forKey: noteID)
        location.withSecurityScopedAccess(base) {
            do {
                let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
                if FileManager.default.fileExists(atPath: folder.path) {
                    try FileManager.default.removeItem(at: folder)
                }
            } catch {
                print("Failed to delete attachments: \(error)")
            }
        }
    }

    private func replacementAttachmentString(
        from originalAttachment: NSTextAttachment,
        attributes: [NSAttributedString.Key: Any],
        noteID: UUID
    ) -> NSAttributedString? {
        if let imageAttachment = originalAttachment as? AttachmentTextAttachment, imageAttachment.kind == .image {
            guard let targetURL = resolvedAttachmentURL(
                existingURL: imageAttachment.attachmentFileURL,
                data: imageAttachment.attachmentData(),
                preferredFilename: imageAttachment.attachmentFilename,
                noteID: noteID
            ) else {
                return nil
            }

            let replacementAttachment = AttachmentTextAttachment(
                fileURL: targetURL,
                kind: .image,
                embeddedFileData: imageAttachment.attachmentData(),
                attachmentFilename: imageAttachment.attachmentFilename
            )
            if originalAttachment.bounds.width > 1, originalAttachment.bounds.height > 1 {
                replacementAttachment.bounds = originalAttachment.bounds
            }

            let replacement = NSMutableAttributedString(attachment: replacementAttachment)
            applyAttributes(attributes, to: replacement)
            let width = (attributes[.notebookImageWidth] as? CGFloat) ?? replacementAttachment.bounds.width
            let height = (attributes[.notebookImageHeight] as? CGFloat) ?? replacementAttachment.bounds.height
            if width > 1, height > 1 {
                replacement.addAttribute(.notebookImageWidth, value: width, range: NSRange(location: 0, length: replacement.length))
                replacement.addAttribute(.notebookImageHeight, value: height, range: NSRange(location: 0, length: replacement.length))
                replacement.addAttribute(.link, value: imageLink(for: targetURL, width: width, height: height), range: NSRange(location: 0, length: replacement.length))
            }
            return replacement
        }

        if let audioAttachment = originalAttachment as? AudioBlockAttachment {
            guard let audioStorage = resolvedAudioAttachmentStorage(
                existingURL: audioAttachment.fileURL,
                audioData: audioAttachment.audioData(),
                preferredFilename: audioAttachment.attachmentFilename,
                manifestData: audioAttachment.manifestData(),
                noteID: noteID
            ) else {
                return nil
            }

            let replacementAttachment = AudioBlockAttachment(
                fileURL: audioStorage.audioURL,
                duration: audioAttachment.duration,
                createDate: audioAttachment.createDate,
                embeddedAudioData: audioAttachment.audioData(),
                attachmentFilename: audioAttachment.attachmentFilename,
                embeddedManifestData: audioAttachment.manifestData()
            )
            if !originalAttachment.bounds.isEmpty {
                replacementAttachment.bounds = originalAttachment.bounds
            }

            let replacement = NSMutableAttributedString(attachment: replacementAttachment)
            applyAttributes(attributes, to: replacement)
            replacement.addAttribute(.link, value: audioStorage.audioURL, range: NSRange(location: 0, length: replacement.length))
            return replacement
        }

        if let audioAttachment = originalAttachment as? AttachmentTextAttachment, audioAttachment.kind == .audio {
            guard let audioURL = resolvedAttachmentURL(
                existingURL: audioAttachment.attachmentFileURL,
                data: audioAttachment.attachmentData(),
                preferredFilename: audioAttachment.attachmentFilename,
                noteID: noteID
            ) else {
                return nil
            }

            let replacementAttachment = AttachmentTextAttachment(
                fileURL: audioURL,
                kind: .audio,
                embeddedFileData: audioAttachment.attachmentData(),
                attachmentFilename: audioAttachment.attachmentFilename
            )
            if !originalAttachment.bounds.isEmpty {
                replacementAttachment.bounds = originalAttachment.bounds
            }

            let replacement = NSMutableAttributedString(attachment: replacementAttachment)
            applyAttributes(attributes, to: replacement)
            replacement.addAttribute(.link, value: audioURL, range: NSRange(location: 0, length: replacement.length))
            return replacement
        }

        return nil
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

    private func resolvedAttachmentURL(
        existingURL: URL,
        data: Data?,
        preferredFilename: String,
        noteID: UUID
    ) -> URL? {
        if isAttachmentReusableForCurrentNote(existingURL, noteID: noteID), FileManager.default.fileExists(atPath: existingURL.path) {
            return existingURL
        }
        guard let data else { return nil }
        return try? persistAttachmentData(data, preferredFilename: preferredFilename, noteID: noteID)
    }

    private func resolvedAudioAttachmentStorage(
        existingURL: URL,
        audioData: Data?,
        preferredFilename: String,
        manifestData: Data?,
        noteID: UUID
    ) -> (audioURL: URL, manifestURL: URL?)? {
        if isAttachmentReusableForCurrentNote(existingURL, noteID: noteID), FileManager.default.fileExists(atPath: existingURL.path) {
            let manifestURL = existingURL.deletingPathExtension().appendingPathExtension("tracks.json")
            if let manifestData, !FileManager.default.fileExists(atPath: manifestURL.path) {
                try? manifestData.write(to: manifestURL, options: .atomic)
            }
            return (existingURL, FileManager.default.fileExists(atPath: manifestURL.path) ? manifestURL : nil)
        }

        guard let audioData else { return nil }
        guard let audioURL = try? persistAttachmentData(audioData, preferredFilename: preferredFilename, noteID: noteID) else {
            return nil
        }

        let manifestURL: URL?
        if let manifestData {
            let destination = audioURL.deletingPathExtension().appendingPathExtension("tracks.json")
            try? manifestData.write(to: destination, options: .atomic)
            manifestURL = destination
        } else {
            manifestURL = nil
        }

        return (audioURL, manifestURL)
    }

    private func persistAttachmentData(_ data: Data, preferredFilename: String, noteID: UUID) throws -> URL {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else {
            throw NSError(domain: "AttachmentManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "未配置保存目录"])
        }

        return try location.withSecurityScopedAccess(base) {
            let folder = try noteAttachmentDirectoryURL(noteID: noteID)
            let ext = URL(fileURLWithPath: preferredFilename).pathExtension
            let baseName = URL(fileURLWithPath: preferredFilename).deletingPathExtension().lastPathComponent
            let safeBaseName = baseName.isEmpty ? "attachment" : baseName
            let filename = "\(safeBaseName)-\(UUID().uuidString)" + (ext.isEmpty ? "" : ".\(ext)")
            let destination = folder.appendingPathComponent(filename, isDirectory: false)
            try data.write(to: destination, options: .atomic)
            return destination
        }
    }

    private func noteAttachmentDirectoryURL(noteID: UUID) throws -> URL {
        let location = StorageLocationManager.shared
        try location.ensureDirectoryStructureExists()
        let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func isAttachmentReusableForCurrentNote(_ url: URL, noteID: UUID) -> Bool {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else { return false }

        var result = false
        location.withSecurityScopedAccess(base) {
            guard let attachmentsRoot = try? location.attachmentsDirectoryURL() else {
                return
            }
            let filePath = url.standardizedFileURL.path
            let noteFolderPath = attachmentsRoot
                .appendingPathComponent(noteID.uuidString, isDirectory: true)
                .standardizedFileURL.path
            let noteFolderPrefix = noteFolderPath.hasSuffix("/") ? noteFolderPath : noteFolderPath + "/"
            let blockDocumentsPath = attachmentsRoot
                .appendingPathComponent("BlockDocuments", isDirectory: true)
                .standardizedFileURL.path
            let blockDocumentsPrefix = blockDocumentsPath.hasSuffix("/") ? blockDocumentsPath : blockDocumentsPath + "/"
            result = filePath.hasPrefix(noteFolderPrefix) || filePath.hasPrefix(blockDocumentsPrefix)
        }
        return result
    }

    private func imageLink(for fileURL: URL, width: CGFloat, height: CGFloat) -> String {
        "notebook-image://\(fileURL.absoluteString)#w=\(Int(width.rounded()))&h=\(Int(height.rounded()))"
    }

    // MARK: - 附件清理

    /// 清理指定笔记中未被引用的附件
    /// - Parameters:
    ///   - noteID: 笔记ID
    ///   - content: 当前笔记内容（包含正在使用的附件引用）
    func cleanupUnusedAttachments(for noteID: UUID, content: NSAttributedString) {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else { return }

        location.withSecurityScopedAccess(base) {
            do {
                let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
                let referencedFiles = self.extractReferencedAttachmentFiles(from: content)
                let preCleanupSignature = self.cleanupFolderSignature(for: folder)
                let now = Date()

                if let checkpoint = self.cleanupCheckpoints[noteID],
                   checkpoint.referencedFiles == referencedFiles,
                   checkpoint.folderSignature == preCleanupSignature,
                   (checkpoint.nextEligibleCleanupAt == nil || now < checkpoint.nextEligibleCleanupAt!) {
                    return
                }

                guard preCleanupSignature.exists else {
                    self.cleanupCheckpoints[noteID] = CleanupCheckpoint(
                        referencedFiles: referencedFiles,
                        folderSignature: preCleanupSignature,
                        nextEligibleCleanupAt: nil
                    )
                    print("[AttachmentManager] Note \(noteID.uuidString.prefix(8)) attachment folder does not exist")
                    return
                }

                print("[AttachmentManager] Note \(noteID.uuidString.prefix(8)) has \(referencedFiles.count) referenced attachments")

                // 获取文件夹中的所有文件
                let allFiles = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                print("[AttachmentManager] Note \(noteID.uuidString.prefix(8)) folder has \(allFiles.count) files")

                var deletedCount = 0
                var nextEligibleCleanupAt: Date?

                for fileURL in allFiles {
                    let filename = fileURL.lastPathComponent

                    // 如果文件未被引用，先做“新文件保护”：避免录音刚生成但尚未完成插入时被误删
                    if !referencedFiles.contains(filename) {
                        if let protectionExpiry = self.recentAttachmentProtectionExpiry(for: fileURL), protectionExpiry > now {
                            print("[AttachmentManager] Skip deleting recent attachment: \(filename)")
                            if let existing = nextEligibleCleanupAt {
                                nextEligibleCleanupAt = max(existing, protectionExpiry)
                            } else {
                                nextEligibleCleanupAt = protectionExpiry
                            }
                            continue
                        }

                        try FileManager.default.removeItem(at: fileURL)
                        print("[AttachmentManager] Deleted unused attachment: \(filename)")
                        deletedCount += 1
                    } else {
                        print("[AttachmentManager] Keeping referenced attachment: \(filename)")
                    }
                }

                if deletedCount > 0 {
                    print("[AttachmentManager] Cleaned up \(deletedCount) unused attachments for note \(noteID.uuidString.prefix(8))")
                } else {
                    print("[AttachmentManager] No unused attachments to clean for note \(noteID.uuidString.prefix(8))")
                }

                self.cleanupCheckpoints[noteID] = CleanupCheckpoint(
                    referencedFiles: referencedFiles,
                    folderSignature: self.cleanupFolderSignature(for: folder),
                    nextEligibleCleanupAt: nextEligibleCleanupAt
                )
            } catch {
                print("[AttachmentManager] Failed to cleanup unused attachments: \(error)")
            }
        }
    }

    /// 从富文本内容中提取引用的附件文件名
    private func extractReferencedAttachmentFiles(from content: NSAttributedString) -> Set<String> {
        var referencedFiles = Set<String>()
        let range = NSRange(location: 0, length: content.length)
        let audioExts: Set<String> = ["m4a", "caf", "wav", "aiff", "mp3", "json"]

        content.enumerateAttribute(.attachment, in: range, options: []) { value, _, _ in
            if let attachment = value as? AttachmentTextAttachment {
                let filename = attachment.attachmentFilename
                referencedFiles.insert(filename)
            } else if let audioAttachment = value as? AudioBlockAttachment {
                let filename = audioAttachment.attachmentFilename
                referencedFiles.insert(filename)
                if let manifestFilename = audioAttachment.manifestFilename {
                    referencedFiles.insert(manifestFilename)
                }
            } else if let attachment = value as? NSTextAttachment,
                      let fileWrapper = attachment.fileWrapper {
                if fileWrapper.isDirectory {
                    let dirName = fileWrapper.preferredFilename ?? ""
                    if !dirName.isEmpty {
                        referencedFiles.insert(dirName)
                    }
                    if let children = fileWrapper.fileWrappers {
                        for (name, _) in children {
                            referencedFiles.insert(name)
                        }
                    }
                } else if let filename = fileWrapper.preferredFilename,
                          !filename.isEmpty {
                    // RTFD 反序列化后可能退化为 NSTextAttachment，兜底识别 fileWrapper 文件名
                    referencedFiles.insert(filename)
                }
            }
        }

        // 关键兜底：即使附件类型退化，也可通过 link 属性保留音频引用
        content.enumerateAttribute(.link, in: range, options: []) { value, _, _ in
            let raw: String
            if let u = value as? URL {
                raw = u.absoluteString
            } else if let s = value as? String {
                raw = s
            } else {
                return
            }

            if raw.hasPrefix("notebook-image://") {
                let payload = String(raw.dropFirst("notebook-image://".count))
                let filePart = payload.split(separator: "#", maxSplits: 1).map(String.init).first ?? payload
                if let fileURL = URL(string: filePart), !fileURL.lastPathComponent.isEmpty {
                    referencedFiles.insert(fileURL.lastPathComponent)
                }
                return
            }

            guard let fileURL = URL(string: raw) else { return }
            let ext = fileURL.pathExtension.lowercased()
            guard audioExts.contains(ext) else { return }
            referencedFiles.insert(fileURL.lastPathComponent)
            if ext == "m4a" {
                let manifestName = fileURL.deletingPathExtension().lastPathComponent + ".tracks.json"
                referencedFiles.insert(manifestName)
            }
        }

        return referencedFiles
    }

    /// 新创建附件保护窗口（秒）
    private var recentAttachmentProtectionWindow: TimeInterval { 30 }

    private func cleanupFolderSignature(for folderURL: URL) -> CleanupFolderSignature {
        guard FileManager.default.fileExists(atPath: folderURL.path) else {
            return CleanupFolderSignature(exists: false, modificationDate: nil)
        }
        let values = try? folderURL.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey])
        return CleanupFolderSignature(
            exists: true,
            modificationDate: values?.contentModificationDate ?? values?.creationDate
        )
    }

    private func recentAttachmentProtectionExpiry(for fileURL: URL) -> Date? {
        let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey])
        let ts = values?.contentModificationDate ?? values?.creationDate
        guard let ts else { return nil }
        return ts.addingTimeInterval(recentAttachmentProtectionWindow)
    }

    /// 清理所有孤儿附件（启动时调用）
    func cleanupOrphanedAttachments(allNoteIDs: [UUID]) {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else { return }

        location.withSecurityScopedAccess(base) {
            do {
                let attachmentsDir = try location.attachmentsDirectoryURL()
                guard FileManager.default.fileExists(atPath: attachmentsDir.path) else { return }

                let allFolders = try FileManager.default.contentsOfDirectory(at: attachmentsDir, includingPropertiesForKeys: nil)
                let validNoteIDStrings = Set(allNoteIDs.map { $0.uuidString })
                var deletedCount = 0

                for folderURL in allFolders {
                    let folderName = folderURL.lastPathComponent
                    // 如果文件夹名称不是有效的笔记ID，则删除整个文件夹
                    if !validNoteIDStrings.contains(folderName) {
                        try FileManager.default.removeItem(at: folderURL)
                        print("[AttachmentManager] Deleted orphaned attachment folder: \(folderName)")
                        deletedCount += 1
                    }
                }

                if deletedCount > 0 {
                    print("[AttachmentManager] Cleaned up \(deletedCount) orphaned attachment folders")
                }
            } catch {
                print("[AttachmentManager] Failed to cleanup orphaned attachments: \(error)")
            }
        }
    }
}
