import Foundation
import Combine

/// A single source of truth for the editor's persistence state. Revisions are
/// monotonic so a completion for an older snapshot can never mark newer input
/// as saved.
@MainActor
final class NoteEditorSession: ObservableObject {
    enum PersistenceState: Equatable {
        case clean
        case dirty
        case saving
        case saved
        case failed(String)

        var label: String {
            switch self {
            case .clean: return "已保存"
            case .dirty: return "未保存"
            case .saving: return "保存中"
            case .saved: return "已保存"
            case .failed: return "保存失败"
            }
        }

        var systemImage: String {
            switch self {
            case .clean: return "checkmark.circle"
            case .dirty: return "circle.fill"
            case .saving: return "arrow.triangle.2.circlepath"
            case .saved: return "checkmark.circle.fill"
            case .failed: return "exclamationmark.triangle.fill"
            }
        }
    }

    let noteID: UUID
    @Published private(set) var state: PersistenceState = .clean
    private(set) var currentRevision: UInt64 = 0
    private(set) var persistedRevision: UInt64 = 0
    private var savedIndicatorTask: Task<Void, Never>?

    init(noteID: UUID) {
        self.noteID = noteID
    }

    deinit {
        savedIndicatorTask?.cancel()
    }

    func recordChange() {
        currentRevision &+= 1
        state = .dirty
        savedIndicatorTask?.cancel()
    }

    var revisionFingerprint: String {
        "\(noteID.uuidString)|\(currentRevision)"
    }

    @discardableResult
    func beginSave() -> UInt64 {
        state = .saving
        savedIndicatorTask?.cancel()
        return currentRevision
    }

    func markSaved(revision: UInt64) {
        persistedRevision = max(persistedRevision, revision)
        guard persistedRevision >= currentRevision else {
            state = .dirty
            return
        }

        state = .saved
        savedIndicatorTask?.cancel()
        savedIndicatorTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled, let self,
                  self.persistedRevision >= self.currentRevision else { return }
            self.state = .clean
        }
    }

    func markFailed(_ error: Error) {
        state = .failed(error.localizedDescription)
        savedIndicatorTask?.cancel()
    }

    func markFailed(message: String) {
        state = .failed(message)
        savedIndicatorTask?.cancel()
    }
}

/// Bridges the active SwiftUI editor session into the app-level sync barrier.
/// Muya has no NSTextView, so relying only on RichTextController would miss
/// edits made while a remote operation is in flight.
@MainActor
final class NoteEditorSessionRegistry {
    static let shared = NoteEditorSessionRegistry()

    private weak var activeSession: NoteEditorSession?

    private init() {}

    func activate(_ session: NoteEditorSession) {
        activeSession = session
    }

    func deactivate(_ session: NoteEditorSession) {
        guard activeSession === session else { return }
        activeSession = nil
    }

    var currentFingerprint: String? {
        activeSession?.revisionFingerprint
    }

    func markSaved(noteID: UUID) {
        guard let activeSession, activeSession.noteID == noteID else { return }
        activeSession.markSaved(revision: activeSession.currentRevision)
    }

    func resetForTesting() {
        activeSession = nil
    }
}
