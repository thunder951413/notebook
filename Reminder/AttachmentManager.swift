import Foundation

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
}
