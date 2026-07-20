import XCTest
@testable import Notebook

extension NotebookTests {
    @MainActor
    func testEditorSessionDoesNotMarkNewerRevisionSavedFromOlderCompletion() {
        let session = NoteEditorSession(noteID: UUID())

        session.recordChange()
        let firstRevision = session.beginSave()
        session.recordChange()
        session.markSaved(revision: firstRevision)

        XCTAssertEqual(session.state, .dirty)
        XCTAssertGreaterThan(session.currentRevision, session.persistedRevision)
    }

    @MainActor
    func testEditorSessionReportsSuccessfulCurrentRevision() {
        let session = NoteEditorSession(noteID: UUID())

        session.recordChange()
        let revision = session.beginSave()
        session.markSaved(revision: revision)

        XCTAssertEqual(session.state, .saved)
        XCTAssertEqual(session.currentRevision, session.persistedRevision)
    }

    @MainActor
    func testEditorSessionRegistryMakesMuyaChangesVisibleToSyncBarrier() {
        let session = NoteEditorSession(noteID: UUID())
        let registry = NoteEditorSessionRegistry.shared
        registry.resetForTesting()
        registry.activate(session)
        defer { registry.resetForTesting() }

        let before = registry.currentFingerprint
        session.recordChange()
        let after = registry.currentFingerprint

        XCTAssertNotEqual(before, after)
        registry.markSaved(noteID: session.noteID)
        XCTAssertEqual(session.state, .saved)
    }

    @MainActor
    func testLargeMarkdownDocumentsDefaultToVirtualizedSourceMode() {
        let noteID = UUID()
        UserDefaults.standard.removeObject(forKey: "markdownEditor.mode.\(noteID.uuidString)")

        XCTAssertEqual(
            MarkdownEditorPreferenceStore.mode(noteID: noteID, contentLength: 600_000),
            .source
        )
        XCTAssertEqual(
            MarkdownEditorPreferenceStore.mode(noteID: noteID, contentLength: 1_000),
            .wysiwyg
        )
    }

    @MainActor
    func testMarkdownDocumentSourceSelectsMarkdownEditor() {
        let imported = Note(
            title: "Imported",
            content: NSAttributedString(string: "# Markdown"),
            documentSource: "TextFileDrop"
        )
        let native = Note(
            title: "Native",
            content: NSAttributedString(string: "Rich text"),
            documentSource: "NotebookRTFD"
        )

        XCTAssertTrue(imported.prefersMarkdownEditor)
        XCTAssertFalse(native.prefersMarkdownEditor)
    }
}
