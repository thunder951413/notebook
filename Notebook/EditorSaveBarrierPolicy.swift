import Foundation

/// 同步、失焦和退出前决定正文应来自哪里。
/// 元数据占位对象的空 `content` 永远不是可保存正文。
enum EditorSaveBarrierPlan: Equatable {
    case liveEditor(noteID: UUID)
    case loadedPreview(noteID: UUID)
    case noContentSaveRequired
}

struct EditorSaveBarrierPolicy {
    static func plan(
        boundNoteID: UUID?,
        hasLiveEditor: Bool,
        selectedNoteID: UUID?,
        selectedContentIsLoaded: Bool,
        selectedHasUnsavedChanges: Bool
    ) -> EditorSaveBarrierPlan {
        if let boundNoteID, hasLiveEditor {
            return .liveEditor(noteID: boundNoteID)
        }

        guard let selectedNoteID,
              selectedContentIsLoaded,
              selectedHasUnsavedChanges else {
            return .noContentSaveRequired
        }

        return .loadedPreview(noteID: selectedNoteID)
    }
}
