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
                    // 如果文件未被引用，则删除
                    if !referencedFiles.contains(filename) {
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

        content.enumerateAttribute(.attachment, in: range, options: []) { value, _, _ in
            if let attachment = value as? AttachmentTextAttachment {
                let filename = attachment.attachmentFileURL.lastPathComponent
                referencedFiles.insert(filename)
            }
        }

        return referencedFiles
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
