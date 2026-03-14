import Foundation
import AppKit

enum AttachmentKind: String {
    case image
    case audio
}

@MainActor
final class AttachmentManager {
    static let shared = AttachmentManager()

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

    func deleteAttachments(for noteID: UUID) {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else { return }

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
                guard FileManager.default.fileExists(atPath: folder.path) else {
                    print("[AttachmentManager] Note \(noteID.uuidString.prefix(8)) attachment folder does not exist")
                    return
                }

                // 获取当前内容中引用的所有附件文件名
                let referencedFiles = self.extractReferencedAttachmentFiles(from: content)
                print("[AttachmentManager] Note \(noteID.uuidString.prefix(8)) has \(referencedFiles.count) referenced attachments")

                // 获取文件夹中的所有文件
                let allFiles = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                print("[AttachmentManager] Note \(noteID.uuidString.prefix(8)) folder has \(allFiles.count) files")

                var deletedCount = 0

                for fileURL in allFiles {
                    let filename = fileURL.lastPathComponent

                    // 如果文件未被引用，先做“新文件保护”：避免录音刚生成但尚未完成插入时被误删
                    if !referencedFiles.contains(filename) {
                        if self.shouldKeepAsRecentlyCreated(fileURL) {
                            print("[AttachmentManager] Skip deleting recent attachment: \(filename)")
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
                let filename = attachment.attachmentFileURL.lastPathComponent
                referencedFiles.insert(filename)
            } else if let audioAttachment = value as? AudioBlockAttachment {
                // 音频块附件使用独立类型，需要单独识别，避免被误删
                let filename = audioAttachment.fileURL.lastPathComponent
                referencedFiles.insert(filename)
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

    /// 判断文件是否属于“刚创建”，用于避免保存时序造成的误删
    private func shouldKeepAsRecentlyCreated(_ fileURL: URL) -> Bool {
        let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey])
        let ts = values?.contentModificationDate ?? values?.creationDate
        guard let ts else { return false }
        return Date().timeIntervalSince(ts) < recentAttachmentProtectionWindow
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
