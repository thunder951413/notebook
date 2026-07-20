import Foundation
import CryptoKit
import Security
import AppKit

struct PersistedEditorDraft: Codable, Equatable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let noteID: UUID
    let title: String
    let folderID: UUID?
    let folderName: String
    let reminderAt: Date?
    let recurrenceRule: String
    let rtfdData: Data
    let baseVersion: Int64?
    let recordedAt: Date
    let sourceReason: String

    init(request: SaveRequest) {
        schemaVersion = Self.currentSchemaVersion
        noteID = request.noteID
        title = request.title
        folderID = request.folderID
        folderName = request.folder
        reminderAt = request.reminderAt
        recurrenceRule = request.recurrenceRule
        rtfdData = request.rtfdData
        baseVersion = request.baseVersion
        recordedAt = request.timestamp
        sourceReason = request.reason
    }

    func makeSaveRequest() throws -> SaveRequest {
        guard schemaVersion == Self.currentSchemaVersion else {
            throw EditorDraftJournalError.unsupportedSchema(schemaVersion)
        }
        let content = try NSAttributedString(
            data: rtfdData,
            options: [.documentType: NSAttributedString.DocumentType.rtfd],
            documentAttributes: nil
        )
        return SaveRequest(
            noteID: noteID,
            title: title,
            folderID: folderID,
            folder: folderName,
            reminderAt: reminderAt,
            recurrenceRule: recurrenceRule,
            rtfdData: rtfdData,
            decodedContent: content,
            allowsDestructiveEmptySave: false,
            reason: "draftRecovery",
            timestamp: recordedAt,
            baseVersion: baseVersion
        )
    }
}

enum EditorDraftJournalError: LocalizedError {
    case invalidKey
    case keyUnavailable
    case corruptEnvelope
    case unsupportedSchema(Int)

    var errorDescription: String? {
        switch self {
        case .invalidKey:
            return "草稿加密密钥格式无效"
        case .keyUnavailable:
            return "无法访问草稿加密密钥"
        case .corruptEnvelope:
            return "草稿文件损坏或无法解密"
        case .unsupportedSchema(let version):
            return "不支持的草稿格式版本：\(version)"
        }
    }
}

struct EditorDraftRecoverySummary: Equatable {
    var recoveredNoteIDs: [UUID] = []
    var deferredNoteIDs: [UUID] = []
    var unreadableFiles: [String] = []

    var isEmpty: Bool {
        recoveredNoteIDs.isEmpty && deferredNoteIDs.isEmpty && unreadableFiles.isEmpty
    }
}

/// An encrypted, per-note write-ahead journal for editor snapshots that have
/// not reached the main database yet. The journal deliberately lives outside
/// SwiftData so a database failure cannot discard both the save and its draft.
@MainActor
final class EditorDraftJournal {
    static let shared = EditorDraftJournal()

    private static let keychainService = "com.notebook.app"
    private static let keychainAccount = "editor-draft-key-v1"
    private let fileManager: FileManager
    private let directoryURL: URL
    private let keyProvider: () throws -> SymmetricKey
    private let isEnabled: Bool

    init(
        directoryURL: URL? = nil,
        fileManager: FileManager = .default,
        isEnabled: Bool? = nil,
        keyProvider: (() throws -> SymmetricKey)? = nil
    ) {
        self.fileManager = fileManager
        self.directoryURL = directoryURL ?? fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
            .appendingPathComponent("Notebook", isDirectory: true)
            .appendingPathComponent("EditorDrafts", isDirectory: true)
        self.isEnabled = isEnabled ?? (
            ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
        )
        self.keyProvider = keyProvider ?? Self.loadOrCreateKey
    }

    func persist(_ request: SaveRequest) throws {
        guard isEnabled else { return }
        let record = PersistedEditorDraft(request: request)
        let plainData = try JSONEncoder.notebookDraftEncoder.encode(record)
        let sealed = try AES.GCM.seal(plainData, using: keyProvider())
        guard let combined = sealed.combined else {
            throw EditorDraftJournalError.corruptEnvelope
        }
        try AtomicFileCommit.writeDurably(combined, to: fileURL(for: request.noteID))
    }

    func remove(noteID: UUID) {
        guard isEnabled else { return }
        try? fileManager.removeItem(at: fileURL(for: noteID))
    }

    func loadAll() -> (records: [PersistedEditorDraft], unreadableFiles: [String]) {
        guard isEnabled else { return ([], []) }
        guard let urls = try? fileManager.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return ([], [])
        }

        var records: [PersistedEditorDraft] = []
        var unreadableFiles: [String] = []
        for url in urls where url.pathExtension == "draft" {
            do {
                records.append(try load(from: url))
            } catch {
                unreadableFiles.append(url.lastPathComponent)
                Logger.shared.log(
                    .save,
                    .error,
                    "草稿文件无法读取，已原样保留：\(url.lastPathComponent) error=\(error.localizedDescription)"
                )
            }
        }
        return (records.sorted { $0.recordedAt < $1.recordedAt }, unreadableFiles)
    }

    private func load(from url: URL) throws -> PersistedEditorDraft {
        let combined = try Data(contentsOf: url, options: .mappedIfSafe)
        let sealed: AES.GCM.SealedBox
        do {
            sealed = try AES.GCM.SealedBox(combined: combined)
        } catch {
            throw EditorDraftJournalError.corruptEnvelope
        }
        let plainData: Data
        do {
            plainData = try AES.GCM.open(sealed, using: keyProvider())
        } catch {
            throw EditorDraftJournalError.corruptEnvelope
        }
        return try JSONDecoder.notebookDraftDecoder.decode(PersistedEditorDraft.self, from: plainData)
    }

    private func fileURL(for noteID: UUID) -> URL {
        directoryURL.appendingPathComponent("\(noteID.uuidString).draft")
    }

    private static func loadOrCreateKey() throws -> SymmetricKey {
        if let existing = KeychainHelper.load(service: keychainService, account: keychainAccount) {
            guard existing.count == 32 else { throw EditorDraftJournalError.invalidKey }
            return SymmetricKey(data: existing)
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw EditorDraftJournalError.keyUnavailable
        }
        let data = Data(bytes)
        try KeychainHelper.save(
            data,
            service: keychainService,
            account: keychainAccount,
            accessibility: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        )
        return SymmetricKey(data: data)
    }
}

private extension JSONEncoder {
    static var notebookDraftEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }
}

private extension JSONDecoder {
    static var notebookDraftDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
