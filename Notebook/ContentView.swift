//
//  ContentView.swift
//  Notebook
//
//  Created by 闫延 on 2026/2/20.
//

import SwiftUI
import SwiftData
import UniformTypeIdentifiers
import AppKit
import Combine


struct ContentView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared
    @StateObject private var windowState = WindowStateManager.shared

    @State private var selection: Note.ID? = nil

    // 与菜单栏 Popover 共享选中状态
    @State private var didSyncSelectionFromStore = false
    @State private var searchText: String = ""
    /// 搜索始终覆盖全部笔记（不再提供"当前目录"范围选择器）
    private let searchInAllFolders: Bool = true
    @State private var selectedFolder: String = l10n(L10nKeys.Folder.allNotes)
    @State private var selectedTagID: UUID?
    @State private var selectedEncryptedFolderID: UUID? = nil
    @State private var isRecycleBinSelected: Bool = false
    @State private var isConflictSelected: Bool = false
    @State private var showingDeleteConfirm = false
    @State private var pendingDeleteNoteID: UUID?
    @State private var isEncryptedFolderUnlocked: Bool = false
    @StateObject private var richTextController = RichTextController()

    private var filteredNotes: [Note] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        var notes = store.activeNotes
        Logger.shared.log(.search, .debug, "Start with \(notes.count) notes, selectedFolder: \(selectedFolder), searchText: \(searchText), searchInAllFolders: \(searchInAllFolders)")

        // 0. 排除加密文件夹的笔记（除非当前正在查看加密文件夹）
        if selectedFolder != EncryptedFolderView.folderName {
            notes = notes.filter { !EncryptedFolderManager.shared.isEncrypted(note: $0) }
            Logger.shared.log(.search, .debug, "After excluding encrypted notes: \(notes.count) notes")
        }

        // 1. 标签筛选
        if let tagID = selectedTagID {
            let taggedNoteIDs = store.noteIDSet(forTagID: tagID)
            notes = notes.filter { taggedNoteIDs.contains($0.id) }
            Logger.shared.log(.search, .debug, "After tag filter: \(notes.count) notes")
        }

        // 2. 冲突筛选
        if isConflictSelected {
            notes = notes.filter { $0.hasConflict }
            Logger.shared.log(.search, .debug, "After conflict filter: \(notes.count) notes")
        }

        // 3. 文件夹筛选
        // 如果有搜索词且选择搜索所有文件夹，则跳过文件夹筛选
        let shouldApplyFolderFilter = selectedFolder != l10n(L10nKeys.Folder.allNotes) &&
                                       selectedFolder != "未分类" &&
                                       selectedFolder != EncryptedFolderView.folderName &&
                                       !(searchInAllFolders && !q.isEmpty)
        if shouldApplyFolderFilter {
            // 通过文件夹名称找到对应的文件夹ID，然后通过ID筛选
            if let folder = store.folders.first(where: { $0.name == selectedFolder }) {
                notes = notes.filter { $0.folderID == folder.id }
            } else {
                // 如果找不到对应的文件夹，显示空结果
                notes = []
            }
            Logger.shared.log(.search, .debug, "After folder filter: \(notes.count) notes")
        } else if selectedFolder == "未分类" {
            // 显示未分类（没有 folderID 或 folderID 指向不存在文件夹的笔记）
            let existingFolderIDs = Set(store.folders.map { $0.id })
            notes = notes.filter { note in
                guard let folderID = note.folderID else { return true }
                return !existingFolderIDs.contains(folderID)
            }
            Logger.shared.log(.search, .debug, "After uncategorized filter: \(notes.count) notes")
        } else if selectedFolder == EncryptedFolderView.folderName {
            // 显示加密文件夹中的笔记
            notes = notes.filter { EncryptedFolderManager.shared.isEncrypted(note: $0) }
            // 如果选择了特定的加密子文件夹，进一步筛选
            if let encryptedFolderID = selectedEncryptedFolderID {
                notes = notes.filter {
                    EncryptedFolderManager.shared.getEncryptedFolderID(for: $0) == encryptedFolderID
                }
                Logger.shared.log(.search, .debug, "After encrypted subfolder filter: \(notes.count) notes")
            }
            Logger.shared.log(.search, .debug, "After encrypted folder filter: \(notes.count) notes")
        } else if searchInAllFolders && !q.isEmpty {
            Logger.shared.log(.search, .debug, "Skipping folder filter (searching all folders)")
        }

        // 4. 搜索词筛选
        if !q.isEmpty {
            notes = notes.filter {
                store.noteMatchesSearch($0, query: q)
            }
            Logger.shared.log(.search, .debug, "After search filter '\(q)': \(notes.count) notes")
        }

        return notes
    }

    private var filteredNoteIDs: [UUID] {
        filteredNotes.map(\.id)
    }

    /// 保存指定笔记的内容
    @discardableResult
    private func saveNoteContent(noteID: UUID, content: NSAttributedString, reason: String) -> Bool {
        guard let index = store.notes.firstIndex(where: { $0.id == noteID }) else { return false }
        
        let note = store.notes[index]
        let preview = String(content.string.prefix(30)).replacingOccurrences(of: "\n", with: "\\n")
        let interval = Logger.shared.beginInterval(
            .save,
            "contentViewSaveNote",
            metadata: "noteID=\(noteID.uuidString.prefix(8)) reason=\(reason) title=\(note.title) contentLength=\(content.length)"
        )
        Logger.shared.log(.save, .info, "'\(note.title)' [\(reason)]: '\(preview)' (\(content.length))")
        
        guard let request = NoteSaveManager.shared.createRequest(
            noteID: noteID,
            title: note.title,
            folderID: note.folderID,
            folder: note.folder,
            reminderAt: note.reminderAt,
            recurrenceRule: note.recurrenceRule,
            content: content,
            reason: reason
        ) else {
            interval.end(.error, "createRequestFailed")
            return false
        }

        switch NoteSaveManager.shared.saveImmediately(request: request) {
        case .success:
            store.markNoteContentUpdated(id: noteID, content: content)
            richTextController.recordSavedState(noteID: noteID, title: note.title, content: content)
            interval.end(.info, "result=success")
            return true
        case .failure(let error):
            Logger.shared.log(.save, .error, "saveImmediately failed noteID=\(noteID.uuidString.prefix(8)) error=\(error.localizedDescription)")
            interval.end(.error, "result=failure error=\(error.localizedDescription)")
            return false
        }
    }
    
    /// 保存当前编辑器中的笔记（用于 appBlur/terminate）
    private func saveCurrentEditorContent(reason: String) {
        // 安全机制：检查 boundNoteID 和 selection 是否一致
        let boundIDStr = richTextController.boundNoteID?.uuidString.prefix(8) ?? "nil"
        let selIDStr = selection?.uuidString.prefix(8) ?? "nil"
        
        Logger.shared.log(.save, .debug, "reason=\(reason), boundNoteID=\(boundIDStr), selection=\(selIDStr)")
        
        let targetNoteID: UUID
        if let boundID = richTextController.boundNoteID,
           let selID = selection,
           boundID == selID {
            targetNoteID = boundID
        } else if let selID = selection {
            Logger.shared.log(.save, .warn, "boundNoteID and selection mismatch, using selection: \(selID)")
            targetNoteID = selID
        } else if let boundID = richTextController.boundNoteID {
            targetNoteID = boundID
        } else {
            Logger.shared.log(.save, .error, "No target note ID available")
            return
        }
        
        // 从编辑器获取内容；若快照异常为空，回退到内存，避免误清空笔记
        guard let editorContent = richTextController.snapshotAttributedString() else {
            Logger.shared.log(.save, .warn, "Editor content is nil, fallback to in-memory content")
            if let index = store.notes.firstIndex(where: { $0.id == targetNoteID }) {
                let memoryContent = store.notes[index].content
                saveNoteContent(noteID: targetNoteID, content: memoryContent, reason: reason)
            }
            return
        }
        Logger.shared.log(.save, .debug, "Editor content length: \(editorContent.length)")

        // 保护：当编辑器快照为空但内存中有内容时，不用空快照覆盖
        if editorContent.length == 0,
           let index = store.notes.firstIndex(where: { $0.id == targetNoteID }),
           store.notes[index].content.length > 0 {
            let memoryContent = store.notes[index].content
            Logger.shared.log(.save, .warn, "Editor snapshot is empty, fallback to memory content length=\(memoryContent.length)")
            saveNoteContent(noteID: targetNoteID, content: memoryContent, reason: reason)
            return
        }
        
        // 执行保存
        saveNoteContent(noteID: targetNoteID, content: editorContent, reason: reason)
    }

    private func updateSelection(_ newSelection: UUID?, reason: String) {
        let interval = Logger.shared.beginInterval(
            .app,
            "noteSwitchSelection",
            metadata: "reason=\(reason) from=\(selection?.uuidString.prefix(8) ?? "nil") to=\(newSelection?.uuidString.prefix(8) ?? "nil")"
        )
        defer {
            interval.end(.info, "finalSelection=\(selection?.uuidString.prefix(8) ?? "nil")")
        }

        if let oldNoteID = selection, oldNoteID != newSelection {
            let pendingSaveExists = NoteSaveManager.shared.hasPendingSave(for: oldNoteID)
            if !pendingSaveExists {
                NoteSaveManager.shared.cancelPendingSave(for: oldNoteID)
            }

            let contentToSave: NSAttributedString
            if richTextController.isBoundTo(noteID: oldNoteID),
               let oldIndex = store.notes.firstIndex(where: { $0.id == oldNoteID }) {
                if richTextController.requiresCommittedSnapshotOnSwitch,
                   let editorContent = richTextController.snapshotAttributedStringForSwitch() {
                    contentToSave = editorContent
                    store.notes[oldIndex].content = contentToSave
                    Logger.shared.log(.app, .debug, "noteSwitch used committed snapshot for \(oldNoteID.uuidString.prefix(8))")
                } else {
                    contentToSave = store.notes[oldIndex].content
                    Logger.shared.log(.app, .debug, "noteSwitch reused bound content for \(oldNoteID.uuidString.prefix(8))")
                }
            } else if let oldIndex = store.notes.firstIndex(where: { $0.id == oldNoteID }) {
                contentToSave = store.notes[oldIndex].content
            } else {
                if let newSelection {
                    store.ensureNoteContentLoaded(id: newSelection, rememberSelection: true)
                }
                selection = newSelection
                AppSettings.shared.lastSelectedNoteID = newSelection
                return
            }

            if let oldIndex = store.notes.firstIndex(where: { $0.id == oldNoteID }) {
                let note = store.notes[oldIndex]
                let isDirty = richTextController.hasUnsavedChanges(
                    noteID: oldNoteID,
                    title: note.title,
                    content: contentToSave
                )

                if pendingSaveExists {
                    Logger.shared.log(.app, .info, "noteSwitch flushing pending save for \(oldNoteID.uuidString.prefix(8))")
                    switch NoteSaveManager.shared.savePendingImmediately(for: oldNoteID) {
                    case .success?:
                        richTextController.recordSavedState(noteID: oldNoteID, title: note.title, content: contentToSave)
                    case .failure(let error)?:
                        Logger.shared.log(.app, .warn, "pending save flush failed, fallback to immediate save: \(error.localizedDescription)")
                        _ = saveNoteContent(noteID: oldNoteID, content: contentToSave, reason: reason)
                    case nil:
                        _ = saveNoteContent(noteID: oldNoteID, content: contentToSave, reason: reason)
                    }
                } else if isDirty {
                    Logger.shared.log(.app, .info, "noteSwitch saving dirty note \(oldNoteID.uuidString.prefix(8))")
                    _ = saveNoteContent(noteID: oldNoteID, content: contentToSave, reason: reason)
                } else {
                    Logger.shared.log(.app, .debug, "noteSwitch skipped clean note \(oldNoteID.uuidString.prefix(8))")
                }
            }
        }

        if let newSelection {
            store.ensureNoteContentLoaded(id: newSelection, rememberSelection: true)
        }
        selection = newSelection
        AppSettings.shared.lastSelectedNoteID = newSelection
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(
                selectedFolder: $selectedFolder,
                selectedTagID: $selectedTagID,
                selection: $selection,
                selectedEncryptedFolderID: $selectedEncryptedFolderID,
                isEncryptedFolderUnlocked: $isEncryptedFolderUnlocked,
                isRecycleBinSelected: $isRecycleBinSelected,
                isConflictSelected: $isConflictSelected,
                onCreateNote: createNote
            )
        } content: {
            if isRecycleBinSelected {
                RecycleBinView(selection: $selection)
            } else {
                NotesListView(notes: filteredNotes, selection: Binding(
                get: { selection },
                set: { newSelection in
                    // 使用 DispatchQueue 避免 Publishing changes from within view updates 警告
                    DispatchQueue.main.async {
                        updateSelection(newSelection, reason: "switch")
                    }
                }
            ), onDeleteRequest: { id in
                pendingDeleteNoteID = id
                showingDeleteConfirm = true
            })
            }
        } detail: {
            if isRecycleBinSelected {
                ContentUnavailableView("回收站", systemImage: "trash")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppColors.editorBackground(colorScheme))
            } else if let currentId = selection, let index = store.notes.firstIndex(where: { $0.id == currentId }) {
                if store.notes[index].isContentLoaded {
                    let noteBinding = $store.notes[index]
                    NoteEditorView(
                        note: noteBinding,
                        controller: richTextController,
                        isEncryptedFolderUnlocked: $isEncryptedFolderUnlocked
                    )
                } else {
                    ContentUnavailableView("正在加载笔记…", systemImage: "doc.text")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(AppColors.editorBackground(colorScheme))
                        .onAppear {
                            store.ensureNoteContentLoaded(id: currentId, rememberSelection: true)
                        }
                }
            } else {
                ContentUnavailableView(l10n(L10nKeys.Note.noSelection), systemImage: "note")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppColors.editorBackground(colorScheme))
            }
        }
        .frame(minWidth: 980, minHeight: 640)
        .toolbar {
            ToolbarItemGroup(placement: .automatic) {
                Button {
                    createNote()
                } label: {
                    Label(l10n(L10nKeys.Note.new), systemImage: "plus")
                }

                Button {
                    confirmDeleteSelectedNote()
                } label: {
                    Label(l10n(L10nKeys.common.delete), systemImage: "trash")
                }
                .disabled(selection == nil || isRecycleBinSelected)
            }
        }
        .toolbarBackground(.hidden, for: .windowToolbar)
        .searchable(text: $searchText, placement: .toolbar, prompt: "搜索所有笔记...")
        .onAppear {
            store.fetchData()
            if !didSyncSelectionFromStore, let pending = store.selectedNoteId {
                updateSelection(pending, reason: "initialExternalNavigation")
                didSyncSelectionFromStore = true
            }
            if selection == nil {
                updateSelection(store.activeNotes.first?.id, reason: "initial")
            }

            if isRecycleBinSelected {
                selection = nil
            }

            // 启动定期自动保存（每30秒）
            richTextController.startAutoSave(interval: 30.0) { [weak store] in
                guard let store = store else { return }
                if let currentId = selection,
                   let index = store.notes.firstIndex(where: { $0.id == currentId }),
                   richTextController.isBoundTo(noteID: currentId) {
                    let content = richTextController.snapshotAttributedStringPreservingMarkedText()
                        ?? store.notes[index].content
                    if saveNoteContent(noteID: currentId, content: content, reason: "auto") {
                        richTextController.markAsSaved()
                    }
                }
            }
        }
        .onChange(of: store.selectedNoteId) { _, newValue in
            guard let id = newValue else { return }
            guard let note = store.activeNotes.first(where: { $0.id == id }) else {
                store.selectedNoteId = nil
                return
            }

            selectedTagID = nil
            selectedEncryptedFolderID = nil
            isEncryptedFolderUnlocked = false
            isRecycleBinSelected = false
            isConflictSelected = false
            selectedFolder = note.folder
            searchText = ""
            updateSelection(id, reason: "externalNavigation")
            store.selectedNoteId = nil
            store.selectedFolderForNavigation = nil
        }
        .onChange(of: store.selectedFolderForNavigation) { _, newValue in
            guard let folder = newValue else { return }
            selectedTagID = nil
            isRecycleBinSelected = false
            isConflictSelected = false
            searchText = ""
            selectedFolder = folder
            store.selectedFolderForNavigation = nil
        }
        .onChange(of: filteredNoteIDs) { _, currentIDs in
            guard !isRecycleBinSelected else { return }
            // 如果冲突筛选下已无冲突笔记，自动退出冲突视图
            if isConflictSelected && !store.activeNotes.contains(where: { $0.hasConflict }) {
                isConflictSelected = false
                selectedFolder = l10n(L10nKeys.Folder.allNotes)
            }
            let nextSelection = VisibleNoteSelectionCoordinator.selectionForVisibleNotes(
                currentSelection: selection,
                availableIDs: currentIDs
            )
            guard nextSelection != selection else { return }
            updateSelection(nextSelection, reason: "filterSync")
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            store.fetchData()
        }
        .task {
            // 启动时根据设置恢复选中的笔记
            await restoreSelectionOnLaunch()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            saveCurrentEditorContent(reason: "appBlur")
            // 保存当前选择的文件夹和笔记
            AppSettings.shared.lastSelectedFolder = selectedFolder
            AppSettings.shared.lastSelectedNoteID = selection
            DebugLog.app("Saved folder: \(selectedFolder), note: \(selection?.uuidString ?? "nil")", level: .debug)
        }
        .onReceive(NotificationCenter.default.publisher(for: .appShouldTerminate)) { _ in
            saveCurrentEditorContent(reason: "terminate")
            NoteSaveManager.shared.flushAllPending()
            // 保存当前选择的文件夹和笔记
            AppSettings.shared.lastSelectedFolder = selectedFolder
            AppSettings.shared.lastSelectedNoteID = selection
            DebugLog.app("Saved folder: \(selectedFolder), note: \(selection?.uuidString ?? "nil")", level: .debug)
        }
        .onReceive(NotificationCenter.default.publisher(for: .insertTextAtCursor)) { notification in
            if let text = notification.userInfo?["text"] as? String {
                richTextController.insertTextAtCursor(text)
            }
        }
        .alert("移动到回收站？", isPresented: $showingDeleteConfirm) {
            Button("删除", role: .destructive) {
                if let id = pendingDeleteNoteID {
                    store.deleteNote(id: id)
                    if selection == id {
                        let nextSelection = isRecycleBinSelected ? nil : filteredNotes.first?.id
                        if let nextSelection {
                            store.ensureNoteContentLoaded(id: nextSelection, rememberSelection: true)
                        }
                        selection = nextSelection
                    }
                }
                pendingDeleteNoteID = nil
            }
            Button("取消", role: .cancel) {
                pendingDeleteNoteID = nil
            }
        } message: {
            Text("删除后可在回收站恢复，或彻底删除。")
        }
        // 快捷键处理
        .onReceive(ShortcutActionHandler.shared.newNotePublisher) { _ in
            createNote()
        }
        .onReceive(ShortcutActionHandler.shared.saveNotePublisher) { _ in
            if let currentId = selection,
               let index = store.notes.firstIndex(where: { $0.id == currentId }),
               richTextController.isBoundTo(noteID: currentId) {
                let content = richTextController.snapshotAttributedString() ?? store.notes[index].content
                if saveNoteContent(noteID: currentId, content: content, reason: "shortcut") {
                    richTextController.markAsSaved()
                }
            }
        }
        .onReceive(ShortcutActionHandler.shared.deleteNotePublisher) { _ in
            if !isRecycleBinSelected {
                confirmDeleteSelectedNote()
            }
        }
        .onReceive(ShortcutActionHandler.shared.focusSearchPublisher) { _ in
            // 聚焦搜索框 - 通过发送通知让搜索框获得焦点
            NotificationCenter.default.post(name: .focusSearchField, object: nil)
        }
        .onReceive(ShortcutActionHandler.shared.focusCurrentNoteSearchPublisher) { _ in
            guard let currentId = selection else { return }
            NotificationCenter.default.post(name: .focusCurrentNoteSearch, object: currentId)
        }
        // 格式设置快捷键
        .onReceive(ShortcutActionHandler.shared.toggleBoldPublisher) { _ in
            richTextController.toggleBold()
        }
        .onReceive(ShortcutActionHandler.shared.toggleItalicPublisher) { _ in
            richTextController.toggleItalic()
        }
        .onReceive(ShortcutActionHandler.shared.toggleUnderlinePublisher) { _ in
            richTextController.toggleUnderline()
        }
        .onReceive(ShortcutActionHandler.shared.toggleStrikethroughPublisher) { _ in
            richTextController.toggleStrikethrough()
        }
        .onReceive(ShortcutActionHandler.shared.clearFormattingPublisher) { _ in
            richTextController.clearFormatting()
        }
        // 列表与缩进快捷键
        .onReceive(ShortcutActionHandler.shared.toggleCheckboxPublisher) { _ in
            richTextController.toggleCheckbox()
        }
        .onReceive(ShortcutActionHandler.shared.increaseIndentPublisher) { _ in
            richTextController.increaseIndent()
        }
        .onReceive(ShortcutActionHandler.shared.decreaseIndentPublisher) { _ in
            richTextController.decreaseIndent()
        }
        .onReceive(ShortcutActionHandler.shared.toggleBulletListPublisher) { _ in
            richTextController.toggleBulletList()
        }
        .onReceive(ShortcutActionHandler.shared.toggleNumberedListPublisher) { _ in
            richTextController.toggleNumberedList()
        }
        // 聚焦编辑器
        .onReceive(ShortcutActionHandler.shared.focusEditorPublisher) { _ in
            richTextController.focus()
        }
        // AI 功能快捷键
        .onReceive(ShortcutActionHandler.shared.toggleAIAssistantPublisher) { _ in
            withAnimation(.easeInOut(duration: 0.25)) {
                windowState.isRightSidebarExpanded.toggle()
            }
        }
        // Markdown 预览快捷键
        .onReceive(ShortcutActionHandler.shared.toggleMarkdownPreviewPublisher) { _ in
            NotificationCenter.default.post(name: .toggleMarkdownPreview, object: nil)
        }
        // 插入对话到笔记
        .onReceive(ShortcutActionHandler.shared.insertConversationPublisher) { _ in
            NotificationCenter.default.post(name: .insertConversation, object: nil)
        }
    }

    private func createNote() {
        searchText = ""

        // 检查是否在加密文件夹中
        if selectedFolder == EncryptedFolderManager.folderName,
           let encryptedFolderID = selectedEncryptedFolderID {
            // 在加密文件夹的子目录中创建加密笔记
            if let newNote = store.createEncryptedNote(in: encryptedFolderID) {
                updateSelection(newNote.id, reason: "createEncrypted")
            }
            return
        }
        
        let folderName = selectedFolder == l10n(L10nKeys.Folder.allNotes) ? l10n(L10nKeys.Folder.uncategorized) : selectedFolder
        let folderID = store.folders.first { $0.name == folderName }?.id
        if let newNote = store.addNote(title: l10n(L10nKeys.Note.new), folderID: folderID, folderName: folderName) {
            if let selectedTagID {
                store.addTagToNote(tagID: selectedTagID, noteID: newNote.id)
            }
            updateSelection(newNote.id, reason: "create")
        }
    }

    private func confirmDeleteSelectedNote() {
        guard let id = selection else { return }
        pendingDeleteNoteID = id
        showingDeleteConfirm = true
    }

    /// 启动时恢复选中的笔记和文件夹
    private func restoreSelectionOnLaunch() async {
        // 等待数据加载完成
        while store.notes.isEmpty {
            try? await Task.sleep(for: .milliseconds(100))
        }

        // 等待文件夹数据加载
        while store.folders.isEmpty {
            try? await Task.sleep(for: .milliseconds(100))
        }

        let behavior = AppSettings.shared.startupBehavior

        switch behavior {
        case .restoreLastNote:
            // 恢复文件夹选择
            if let lastFolder = AppSettings.shared.lastSelectedFolder {
                // 检查文件夹是否存在（包括"全部笔记"）
                let allNotesTitle = l10n(L10nKeys.Folder.allNotes)
                let folderExists = lastFolder == allNotesTitle || store.folders.contains(where: { $0.name == lastFolder })

                if folderExists {
                    selectedFolder = lastFolder
                    DebugLog.app("Restored last selected folder: \(lastFolder)", level: .debug)
                } else {
                    // Fallback 到全部笔记
                    selectedFolder = allNotesTitle
                    DebugLog.app("Last folder '\(lastFolder)' not found, fallback to all notes", level: .debug)
                }
            } else {
                selectedFolder = l10n(L10nKeys.Folder.allNotes)
                DebugLog.app("No last folder saved, defaulting to all notes", level: .debug)
            }

            // 恢复笔记选择
            if let lastID = AppSettings.shared.lastSelectedNoteID {
                // 检查笔记是否存在，并且在当前文件夹中
                if let note = store.activeNotes.first(where: { $0.id == lastID }) {
                    let allNotesTitle = l10n(L10nKeys.Folder.allNotes)
                    let noteInCurrentFolder = selectedFolder == allNotesTitle || note.folder == selectedFolder

                    if noteInCurrentFolder {
                        updateSelection(lastID, reason: "launchRestore")
                        DebugLog.app("Restored last selected note: \(lastID)", level: .debug)
                    } else {
                        // 笔记不在当前文件夹中，选择当前文件夹的第一个笔记
                        updateSelection(isRecycleBinSelected ? nil : filteredNotes.first?.id, reason: "launchFallback")
                        DebugLog.app("Last note not in current folder, selecting first note in folder", level: .debug)
                    }
                } else {
                    // 笔记不存在，选择当前文件夹的第一个笔记
                    updateSelection(isRecycleBinSelected ? nil : filteredNotes.first?.id, reason: "launchMissingLastNote")
                    DebugLog.app("Last note not found, selecting first note in folder", level: .debug)
                }
            } else {
                updateSelection(isRecycleBinSelected ? nil : filteredNotes.first?.id, reason: "launchNoLastNote")
                DebugLog.app("No last note saved, selecting first note", level: .debug)
            }

        case .selectNone:
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            selectedTagID = nil
            updateSelection(nil, reason: "launchSelectNone")
            DebugLog.app("Selecting none as per settings", level: .debug)

        case .showAllNotes:
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            selectedTagID = nil
            updateSelection(store.activeNotes.first?.id, reason: "launchShowAllNotes")
            DebugLog.app("Showing all notes", level: .debug)
        }
    }
}

struct RecycleBinSelectionCoordinator {
    static func selectionAfterRemoving(
        _ removedIDs: Set<UUID>,
        from currentSelection: Set<UUID>,
        availableIDs: [UUID]
    ) -> Set<UUID> {
        let remainingIDs = availableIDs.filter { !removedIDs.contains($0) }
        let remainingSelection = currentSelection
            .subtracting(removedIDs)
            .intersection(Set(remainingIDs))

        if !remainingSelection.isEmpty {
            return remainingSelection
        }

        guard let firstRemainingID = remainingIDs.first else {
            return []
        }

        return [firstRemainingID]
    }
}

struct VisibleNoteSelectionCoordinator {
    static func selectionForVisibleNotes(
        currentSelection: UUID?,
        availableIDs: [UUID]
    ) -> UUID? {
        let visibleIDSet = Set(availableIDs)

        if let currentSelection, visibleIDSet.contains(currentSelection) {
            return currentSelection
        }

        return availableIDs.first
    }
}
