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
    @State private var selectedFolder: String = l10n(L10nKeys.Folder.allNotes)
    @State private var selectedTagID: UUID?
    @State private var selectedEncryptedFolderID: UUID? = nil
    @State private var isRecycleBinSelected: Bool = false
    @State private var isConflictSelected: Bool = false
    @State private var showingDeleteConfirm = false
    @State private var pendingDeleteNoteID: UUID?
    @State private var searchInAllFolders: Bool = false
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
            notes = notes.filter { $0.tagIDs.contains(tagID) }
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
        .searchable(text: $searchText, placement: .toolbar, prompt: searchInAllFolders ? "搜索所有笔记..." : l10n(L10nKeys.Note.searchPlaceholder))
        .searchScopes($searchInAllFolders) {
            Text("当前目录").tag(false)
            Text("所有笔记").tag(true)
        }
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
            print("[AppBlur] Saved folder: \(selectedFolder), note: \(selection?.uuidString ?? "nil")")
        }
        .onReceive(NotificationCenter.default.publisher(for: .appShouldTerminate)) { _ in
            saveCurrentEditorContent(reason: "terminate")
            NoteSaveManager.shared.flushAllPending()
            // 保存当前选择的文件夹和笔记
            AppSettings.shared.lastSelectedFolder = selectedFolder
            AppSettings.shared.lastSelectedNoteID = selection
            print("[Terminate] Saved folder: \(selectedFolder), note: \(selection?.uuidString ?? "nil")")
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
                    print("[Launch] Restored last selected folder: \(lastFolder)")
                } else {
                    // Fallback 到全部笔记
                    selectedFolder = allNotesTitle
                    print("[Launch] Last folder '\(lastFolder)' not found, fallback to all notes")
                }
            } else {
                selectedFolder = l10n(L10nKeys.Folder.allNotes)
                print("[Launch] No last folder saved, defaulting to all notes")
            }

            // 恢复笔记选择
            if let lastID = AppSettings.shared.lastSelectedNoteID {
                // 检查笔记是否存在，并且在当前文件夹中
                if let note = store.activeNotes.first(where: { $0.id == lastID }) {
                    let allNotesTitle = l10n(L10nKeys.Folder.allNotes)
                    let noteInCurrentFolder = selectedFolder == allNotesTitle || note.folder == selectedFolder

                    if noteInCurrentFolder {
                        updateSelection(lastID, reason: "launchRestore")
                        print("[Launch] Restored last selected note: \(lastID)")
                    } else {
                        // 笔记不在当前文件夹中，选择当前文件夹的第一个笔记
                        updateSelection(isRecycleBinSelected ? nil : filteredNotes.first?.id, reason: "launchFallback")
                        print("[Launch] Last note not in current folder, selecting first note in folder")
                    }
                } else {
                    // 笔记不存在，选择当前文件夹的第一个笔记
                    updateSelection(isRecycleBinSelected ? nil : filteredNotes.first?.id, reason: "launchMissingLastNote")
                    print("[Launch] Last note not found, selecting first note in folder")
                }
            } else {
                updateSelection(isRecycleBinSelected ? nil : filteredNotes.first?.id, reason: "launchNoLastNote")
                print("[Launch] No last note saved, selecting first note")
            }

        case .selectNone:
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            selectedTagID = nil
            updateSelection(nil, reason: "launchSelectNone")
            print("[Launch] Selecting none as per settings")

        case .showAllNotes:
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            selectedTagID = nil
            updateSelection(store.activeNotes.first?.id, reason: "launchShowAllNotes")
            print("[Launch] Showing all notes")
        }
    }
}

private struct MarqueeText: View {
    let text: String
    var font: Font = .system(size: 13)
    var speed: Double = 20
    var delay: Double = 1
    var spacing: CGFloat = 24

    @State private var textWidth: CGFloat = 0
    @State private var availableWidth: CGFloat = 0
    @State private var animate = false

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack(alignment: .leading) {
                if textWidth <= width || width == 0 {
                    Text(text)
                        .font(font)
                        .lineLimit(1)
                } else {
                    HStack(spacing: spacing) {
                        Text(text)
                            .font(font)
                            .lineLimit(1)
                        Text(text)
                            .font(font)
                            .lineLimit(1)
                    }
                    .offset(x: animate ? -(textWidth + spacing) : 0)
                    .animation(.linear(duration: speed).repeatForever(autoreverses: false), value: animate)
                    .onAppear {
                        startAnimationIfNeeded(width: width)
                    }
                    .onChange(of: width) { _, newWidth in
                        startAnimationIfNeeded(width: newWidth)
                    }
                    .onChange(of: textWidth) { _, _ in
                        startAnimationIfNeeded(width: width)
                    }
                }
            }
            .frame(width: width, alignment: .leading)
            .clipped()
            .onAppear {
                availableWidth = width
            }
        }
        .frame(height: 18)
        .overlay(
            TextWidthReader(text: text, font: font)
                .opacity(0)
                .allowsHitTesting(false)
        )
        .onPreferenceChange(TextWidthPreferenceKey.self) { newWidth in
            textWidth = newWidth
        }
    }

    private func startAnimationIfNeeded(width: CGFloat) {
        availableWidth = width
        guard textWidth > width, width > 0 else {
            animate = false
            return
        }
        animate = false
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            animate = true
        }
    }
}

private struct TextWidthPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct TextWidthReader: View {
    let text: String
    let font: Font

    var body: some View {
        Text(text)
            .font(font)
            .lineLimit(1)
            .fixedSize()
            .background(
                GeometryReader { geometry in
                    Color.clear.preference(key: TextWidthPreferenceKey.self, value: geometry.size.width)
                }
            )
    }
}

private struct SidebarView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared
    @ObservedObject private var autoSyncCoordinator = AutoSyncCoordinator.shared

    @Binding var selectedFolder: String
    @Binding var selectedTagID: UUID?
    @Binding var selection: Note.ID?
    @Binding var selectedEncryptedFolderID: UUID?
    @Binding var isEncryptedFolderUnlocked: Bool
    @Binding var isRecycleBinSelected: Bool
    @Binding var isConflictSelected: Bool
    let onCreateNote: () -> Void

    @State private var showingFolderManagement = false
    @State private var showingTagManagement = false
    @State private var showingEncryptedFolderManagement = false
    @State private var showingEncryptedFolder = false
    @State private var isFoldersExpanded: Bool = AppSettings.shared.isFoldersExpanded
    @State private var isEncryptedFolderExpanded: Bool = false
    @State private var shouldOpenManagementAfterUnlock: Bool = false
    @State private var isTagsExpanded: Bool = AppSettings.shared.isTagsExpanded
    @State private var tagsFilterMode: AppSettings.TagsFilterMode = AppSettings.shared.tagsFilterMode
    @State private var autoSyncRotationDegrees: Double = 0

    private let maxSidebarTitleLength = 8
    private let maxTagDisplayCount = 10

    private var sidebarWidth: CGFloat {
        let titles = store.folders.map { $0.name } + [l10n(L10nKeys.Folder.allNotes), "未分类"]
        let longest = titles.map { $0.count }.max() ?? 0
        let clamped = min(longest, maxSidebarTitleLength)
        let baseWidth: CGFloat = 132
        let perCharWidth: CGFloat = 16
        return baseWidth + CGFloat(clamped) * perCharWidth
    }

    private var tagsSectionHeight: CGFloat {
        let count = max(min(filteredTags.count, maxTagDisplayCount), 1)
        let rowHeight: CGFloat = 28
        let headerHeight: CGFloat = 26
        let padding: CGFloat = 8
        return headerHeight + CGFloat(count) * rowHeight + padding
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                // 主内容区域：全部笔记 + 未分类 + 文件夹 + 加密文件夹（可滚动）
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        allNotesRow
                        uncategorizedNotesRow
                        conflictNotesRow
                        recycleBinRow
                        foldersSection
                        encryptedFolderRow
                    }
                }
                .frame(maxHeight: .infinity)

                Spacer(minLength: 0)

                Divider()
                    .padding(.vertical, 8)

                // 标签固定在底部，最多显示 10 个
                tagsSection
                    .frame(height: tagsSectionHeight)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
        }
        .frame(width: sidebarWidth)
        .sheet(isPresented: $showingFolderManagement) {
            FolderManagementView()
                .environmentObject(store)
        }
        .sheet(isPresented: $showingTagManagement) {
            TagManagementView()
                .environmentObject(store)
        }
    }

    private var allNotesRow: some View {
        // 全部笔记（排除加密文件夹的笔记）
        let allNotesCount = store.activeNotes.filter { !EncryptedFolderManager.shared.isEncrypted(note: $0) }.count
        let isSelected = selectedFolder == l10n(L10nKeys.Folder.allNotes) && selectedTagID == nil && !isRecycleBinSelected
        return HStack {
            Image(systemName: "tray.fill")
                .foregroundStyle(isSelected ? .white : .orange)
            Text(l10n(L10nKeys.Folder.allNotes))
            Spacer()
            autoSyncIndicator(isSelected: isSelected)
            Text("\(allNotesCount)")
                .font(.caption)
                .foregroundStyle(isSelected ? .white.opacity(0.7) : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(isSelected ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            selectedTagID = nil
            isRecycleBinSelected = false
            isConflictSelected = false
        }
        .onChange(of: isRecycleBinSelected) { _, newValue in
            if newValue {
                selection = nil
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .animation(.easeInOut(duration: 0.2), value: autoSyncCoordinator.sidebarIndicatorState)
    }

    @ViewBuilder
    private func autoSyncIndicator(isSelected: Bool) -> some View {
        switch autoSyncCoordinator.sidebarIndicatorState {
        case .idle:
            EmptyView()
        case .syncing:
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.caption)
                .foregroundStyle(isSelected ? .white.opacity(0.85) : .secondary)
                .rotationEffect(.degrees(autoSyncRotationDegrees))
                .onAppear {
                    autoSyncRotationDegrees = 0
                    withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                        autoSyncRotationDegrees = 360
                    }
                }
                .onDisappear {
                    autoSyncRotationDegrees = 0
                }
                .transition(.opacity)
        case .success:
            Image(systemName: "checkmark.square.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.green)
                .frame(width: 16, alignment: .center)
                .help("自动同步成功")
                .transition(.opacity)
        }
    }

    private var uncategorizedNotesRow: some View {
        // 未分类包括：
        // 1. folderID 为 nil 的笔记
        // 2. folderID 指向不存在文件夹的笔记（孤儿笔记）
        // 3. 排除加密文件夹的笔记
        let existingFolderIDs = Set(store.folders.map { $0.id })
        let uncategorizedCount = store.activeNotes.filter { note in
            // 排除加密文件夹的笔记
            guard !EncryptedFolderManager.shared.isEncrypted(note: note) else { return false }
            guard let folderID = note.folderID else { return true }
            return !existingFolderIDs.contains(folderID)
        }.count
        return HStack {
            Image(systemName: "tray")
                .foregroundStyle(selectedFolder == "未分类" && selectedTagID == nil && !isRecycleBinSelected ? .white : .secondary)
            Text("未分类")
            Spacer()
            Text("\(uncategorizedCount)")
                .font(.caption)
                .foregroundStyle(selectedFolder == "未分类" && selectedTagID == nil && !isRecycleBinSelected ? .white.opacity(0.7) : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(selectedFolder == "未分类" && selectedTagID == nil && !isRecycleBinSelected ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            selectedFolder = "未分类"
            selectedTagID = nil
            isRecycleBinSelected = false
            isConflictSelected = false
        }
        .padding(.horizontal, 8)
    }

    @ViewBuilder
    private var conflictNotesRow: some View {
        let conflictCount = store.activeNotes.filter { $0.hasConflict }.count
        if conflictCount > 0 {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(isConflictSelected ? .white : .yellow)
                Text("有冲突")
                Spacer()
                Text("\(conflictCount)")
                    .font(.caption)
                    .foregroundStyle(isConflictSelected ? .white.opacity(0.7) : .secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isConflictSelected ? themeManager.accentColor : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture {
                isConflictSelected = true
                selectedFolder = l10n(L10nKeys.Folder.allNotes)
                selectedTagID = nil
                isRecycleBinSelected = false
            }
            .padding(.horizontal, 8)
        }
    }

    private var recycleBinRow: some View {
        let recycleCount = store.recycledNotes.count
        return HStack {
            Image(systemName: "trash")
                .foregroundStyle(isRecycleBinSelected ? .white : .secondary)
            Text("回收站")
            Spacer()
            Text("\(recycleCount)")
                .font(.caption)
                .foregroundStyle(isRecycleBinSelected ? .white.opacity(0.7) : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(isRecycleBinSelected ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            selectedTagID = nil
            selectedEncryptedFolderID = nil
            isEncryptedFolderUnlocked = false
            isRecycleBinSelected = true
            isConflictSelected = false
            selection = nil
        }
        .padding(.horizontal, 8)
    }

    private var foldersSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isFoldersExpanded.toggle()
                    AppSettings.shared.isFoldersExpanded = isFoldersExpanded
                }
            } label: {
                HStack {
                    Image(systemName: isFoldersExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(l10n(L10nKeys.Folder.title))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        showingFolderManagement = true
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)

            if isFoldersExpanded {
                ForEach(store.folders) { folder in
                    folderRow(folder)
                }
            }
        }
        .padding(.top, 8)
    }

    /// 根据当前选中的文件夹和过滤模式获取应该显示的标签
    /// - 选择"全部笔记"时显示所有标签
    /// - 选择"所有标签"模式时显示所有标签
    /// - 选择"当前目录"模式时只显示该文件夹下笔记拥有的标签
    /// - 加密笔记的标签永远不会显示
    private var filteredTags: [Tag] {
        // 排除加密笔记（加密笔记的标签不显示）
        let nonEncryptedNotes = store.activeNotes.filter { !EncryptedFolderManager.shared.isEncrypted(note: $0) }
        
        // 如果选择显示所有标签，只显示非加密笔记的标签
        if tagsFilterMode == .allTags {
            let tagIDsInNonEncryptedNotes = Set(nonEncryptedNotes.flatMap { $0.tagIDs })
            return store.tags.filter { tagIDsInNonEncryptedNotes.contains($0.id) }
        }
        
        // 获取当前文件夹下的所有笔记（不考虑标签筛选，且排除加密笔记）
        let notesInCurrentFolder: [Note]
        
        if selectedFolder == l10n(L10nKeys.Folder.allNotes) {
            // 全部笔记：只显示非加密笔记的标签
            let tagIDsInNonEncryptedNotes = Set(nonEncryptedNotes.flatMap { $0.tagIDs })
            return store.tags.filter { tagIDsInNonEncryptedNotes.contains($0.id) }
        } else if selectedFolder == "未分类" {
            // 未分类：显示未分类笔记中的标签（排除加密笔记）
            let existingFolderIDs = Set(store.folders.map { $0.id })
            notesInCurrentFolder = nonEncryptedNotes.filter { note in
                guard let folderID = note.folderID else { return true }
                return !existingFolderIDs.contains(folderID)
            }
        } else {
            // 特定文件夹：显示该文件夹下的笔记标签
            if let folder = store.folders.first(where: { $0.name == selectedFolder }) {
                notesInCurrentFolder = nonEncryptedNotes.filter { $0.folderID == folder.id }
            } else {
                notesInCurrentFolder = []
            }
        }
        
        // 收集这些笔记拥有的所有标签ID
        let tagIDsInFolder = Set(notesInCurrentFolder.flatMap { $0.tagIDs })
        
        // 过滤标签，只保留在当前文件夹笔记中出现过的标签
        return store.tags.filter { tagIDsInFolder.contains($0.id) }
    }

    private var tagsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isTagsExpanded.toggle()
                    AppSettings.shared.isTagsExpanded = isTagsExpanded
                }
            } label: {
                HStack {
                    Image(systemName: isTagsExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(l10n(L10nKeys.Tag.title))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    // 标签过滤模式切换按钮（在设置齿轮左侧）
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            tagsFilterMode = tagsFilterMode == .allTags ? .currentFolder : .allTags
                            AppSettings.shared.tagsFilterMode = tagsFilterMode
                        }
                    } label: {
                        Text(tagsFilterMode == .allTags ? "All" : "Cur")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    Button {
                        showingTagManagement = true
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)

            if isTagsExpanded {
                if filteredTags.isEmpty {
                    Text("无标签")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 4)
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(filteredTags) { tag in
                                tagRow(tag)
                            }
                        }
                    }
                    .frame(maxHeight: tagsSectionHeight - 34)
                }
            }
        }
    }

    private func tagRow(_ tag: Tag) -> some View {
        // 计算当前文件夹下包含该标签的笔记数量
        let notesWithTag: Int
        
        if selectedFolder == l10n(L10nKeys.Folder.allNotes) {
            // 全部笔记：统计所有包含该标签的笔记
            notesWithTag = store.activeNotes.filter { $0.tagIDs.contains(tag.id) }.count
        } else if selectedFolder == "未分类" {
            // 未分类：统计未分类笔记中包含该标签的笔记
            let existingFolderIDs = Set(store.folders.map { $0.id })
            notesWithTag = store.activeNotes.filter { note in
                let isUncategorized = {
                    guard let folderID = note.folderID else { return true }
                    return !existingFolderIDs.contains(folderID)
                }()
                return isUncategorized && note.tagIDs.contains(tag.id)
            }.count
        } else {
            // 特定文件夹：统计该文件夹下包含该标签的笔记
            if let folder = store.folders.first(where: { $0.name == selectedFolder }) {
                notesWithTag = store.activeNotes.filter { $0.folderID == folder.id && $0.tagIDs.contains(tag.id) }.count
            } else {
                notesWithTag = 0
            }
        }
        
        return HStack {
            Circle()
                .fill(tag.swiftUIColor)
                .frame(width: 8, height: 8)
            MarqueeText(text: tag.name)
                .lineLimit(1)
            Spacer()
            Text("\(notesWithTag)")
                .font(.caption)
                .foregroundStyle(selectedTagID == tag.id ? .white.opacity(0.7) : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(selectedTagID == tag.id ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            // 检查当前选中的笔记是否包含新标签
            if let currentSelection = selection,
               let selectedNote = store.activeNotes.first(where: { $0.id == currentSelection }),
               !selectedNote.tagIDs.contains(tag.id) {
                // 当前笔记没有新标签，清空选中状态（延迟到下一个runloop避免 Publishing changes 警告）
                DispatchQueue.main.async {
                    selection = nil
                    AppSettings.shared.lastSelectedNoteID = nil
                }
            }
            selectedTagID = tag.id
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            isRecycleBinSelected = false
            isConflictSelected = false
        }
        .padding(.horizontal, 8)
    }

    private func folderRow(_ folder: Folder) -> some View {
        HStack {
            Image(systemName: folder.isSystem ? "folder.fill" : "folder")
                .foregroundStyle(selectedFolder == folder.name && selectedTagID == nil ? .white : (folder.isSystem ? .orange : themeManager.accentColor))
            Text(folder.name)
                .lineLimit(1)
            Spacer()
            Text("\(store.activeNotes.filter { $0.folderID == folder.id }.count)")
                .font(.caption)
                .foregroundStyle(selectedFolder == folder.name && selectedTagID == nil ? .white.opacity(0.7) : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(selectedFolder == folder.name && selectedTagID == nil ? ThemeManager.shared.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            // 检查当前选中的笔记是否在新文件夹中
            if let currentSelection = selection,
               let selectedNote = store.activeNotes.first(where: { $0.id == currentSelection }),
               selectedNote.folderID != folder.id {
                // 当前笔记不在新文件夹中，清空选中状态（延迟到下一个runloop避免 Publishing changes 警告）
                DispatchQueue.main.async {
                    selection = nil
                    AppSettings.shared.lastSelectedNoteID = nil
                }
            }
            selectedFolder = folder.name
            selectedTagID = nil
            isRecycleBinSelected = false
            isConflictSelected = false
        }
        .padding(.horizontal, 8)
    }

    // MARK: - 加密文件夹区域
    private var encryptedFolderRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            // 加密文件夹标题行（可点击展开/折叠）
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isEncryptedFolderExpanded {
                        // 折叠时直接折叠，并重置解锁状态
                        isEncryptedFolderExpanded = false
                        isEncryptedFolderUnlocked = false
                        selectedEncryptedFolderID = nil
                        
                        // 如果当前正在查看加密笔记，清除选中状态并切换到全部笔记
                        if selectedFolder == EncryptedFolderView.folderName {
                            selectedFolder = l10n(L10nKeys.Folder.allNotes)
                            // 如果当前选中的笔记是加密笔记，清除选中状态
                            if let currentSelection = selection,
                               let selectedNote = store.activeNotes.first(where: { $0.id == currentSelection }),
                               EncryptedFolderManager.shared.isEncrypted(note: selectedNote) {
                                selection = nil
                            }
                        }
                    } else {
                        // 展开时需要验证密码
                        if isEncryptedFolderUnlocked {
                            // 已经解锁过，直接展开
                            isEncryptedFolderExpanded = true
                        } else {
                            // 需要密码验证
                            showingEncryptedFolder = true
                        }
                    }
                }
            } label: {
                HStack {
                    Image(systemName: isEncryptedFolderExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("🔒 加密")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    // 设置按钮（需要密码验证）
                    Button {
                        openEncryptedFolderManagement()
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.top, 8)

            // 展开后显示加密文件夹列表
            if isEncryptedFolderExpanded && isEncryptedFolderUnlocked {
                if store.encryptedFolders.isEmpty {
                    Text("无加密文件夹")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 4)
                } else {
                    ForEach(store.encryptedFolders) { folder in
                        encryptedFolderItemRow(folder)
                    }
                }
            }
        }
        .sheet(isPresented: $showingEncryptedFolder, onDismiss: {
            // 如果用户取消验证，重置管理界面标志
            if !isEncryptedFolderUnlocked {
                shouldOpenManagementAfterUnlock = false
            }
        }) {
            PasswordVerificationView(
                isUnlocked: $isEncryptedFolderUnlocked,
                isExpanded: $isEncryptedFolderExpanded,
                onUnlock: {
                    // 如果是为了打开管理界面而验证密码，验证成功后打开管理界面
                    if shouldOpenManagementAfterUnlock {
                        shouldOpenManagementAfterUnlock = false
                        showingEncryptedFolderManagement = true
                    }
                }
            )
            .frame(width: 400, height: 300)
            .environmentObject(themeManager)
        }
        .sheet(isPresented: $showingEncryptedFolderManagement) {
            EncryptedFolderManagementView()
                .environmentObject(store)
        }
        .onChange(of: selectedFolder) { _, newValue in
            if newValue != EncryptedFolderView.folderName {
                selectedEncryptedFolderID = nil
            }
        }
    }

    // MARK: - 打开加密文件夹管理
    private func openEncryptedFolderManagement() {
        if isEncryptedFolderUnlocked {
            // 已经解锁过，直接打开管理界面
            showingEncryptedFolderManagement = true
        } else {
            // 需要密码验证，验证成功后打开管理界面
            shouldOpenManagementAfterUnlock = true
            showingEncryptedFolder = true
        }
    }

    // MARK: - 加密文件夹项行
    private func encryptedFolderItemRow(_ folder: EncryptedFolder) -> some View {
        let isSelected = selectedEncryptedFolderID == folder.id
        let notesInFolder = store.encryptedNotes.filter { 
            EncryptedFolderManager.shared.getEncryptedFolderID(for: $0) == folder.id 
        }
        
        return HStack {
            Image(systemName: "folder")
                .foregroundStyle(isSelected ? .white : .red)
            Text(folder.name)
                .lineLimit(1)
            Spacer()
            Text("\(notesInFolder.count)")
                .font(.caption)
                .foregroundStyle(isSelected ? .white.opacity(0.7) : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(isSelected ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            selectedEncryptedFolderID = folder.id
            // 切换到加密文件夹视图
            selectedFolder = EncryptedFolderManager.folderName
            selectedTagID = nil
            isRecycleBinSelected = false
            isConflictSelected = false
        }
        .padding(.horizontal, 8)
    }
}

/// 笔记排序方式
enum NoteSortOption: String, CaseIterable {
    case modifiedDate = "最近修改"
    case title = "标题首字母"
}

private struct NotesListView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("noteSortOption") private var sortOption: NoteSortOption = .modifiedDate
    @State private var syncingNoteIDs: Set<UUID> = []

    let notes: [Note]
    @Binding var selection: Note.ID?
    let onDeleteRequest: (Note.ID) -> Void

    /// 根据排序选项排序后的笔记
    private var sortedNotes: [Note] {
        switch sortOption {
        case .modifiedDate:
            return notes.sorted { $0.updatedAt > $1.updatedAt }
        case .title:
            return notes.sorted {
                let title1 = $0.title.isEmpty ? l10n(L10nKeys.common.noTitle) : $0.title
                let title2 = $1.title.isEmpty ? l10n(L10nKeys.common.noTitle) : $1.title
                return title1.localizedCompare(title2) == .orderedAscending
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            List(selection: $selection) {
                Section {
                    ForEach(sortedNotes) { note in
                        NoteRowView(note: note, isSelected: selection == note.id)
                            .id("\(note.id.uuidString)-\(note.title)")
                            .tag(note.id)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                selection = note.id
                            }
                            .contextMenu {
                                Button {
                                    pushNoteToRemote(note.id)
                                } label: {
                                    Label("推送本笔记", systemImage: "arrow.up.doc")
                                }
                                .disabled(syncingNoteIDs.contains(note.id))

                                Button {
                                    pullNoteFromRemote(note.id)
                                } label: {
                                    Label("拉取远程笔记", systemImage: "arrow.down.doc")
                                }
                                .disabled(syncingNoteIDs.contains(note.id))

                                Divider()

                                Button(l10n(L10nKeys.common.delete)) {
                                    onDeleteRequest(note.id)
                                }
                            }
                    }
                } header: {
                    // 笔记标题行，右侧放置排序按钮
                    HStack {
                        Text(l10n(L10nKeys.common.notes))
                        Spacer()
                        Menu {
                            ForEach(NoteSortOption.allCases, id: \.self) { option in
                                Button {
                                    sortOption = option
                                } label: {
                                    HStack {
                                        Text(option.rawValue)
                                        if sortOption == option {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 3) {
                                Image(systemName: "arrow.up.arrow.down")
                                    .font(.caption2)
                                Text(sortOption.rawValue)
                                    .font(.caption2)
                            }
                            .foregroundStyle(.secondary)
                        }
                        .menuStyle(.borderlessButton)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .listStyle(.plain)
        }
        .frame(minWidth: 220, maxWidth: 280)
        .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
    }

    private func pushNoteToRemote(_ noteID: UUID) {
        runSingleNoteSync(noteID: noteID, successMessage: "本笔记已推送到远程") { context in
            NoteSaveManager.shared.flushAllPending()
            try await SSHSyncManager.shared.syncNoteToRemote(
                noteID: noteID,
                context: context,
                config: SSHConfigManager.shared.config
            )
        }
    }

    private func pullNoteFromRemote(_ noteID: UUID) {
        runSingleNoteSync(noteID: noteID, successMessage: "远程笔记已拉取") { context in
            _ = try await SSHSyncManager.shared.syncNoteFromRemote(
                noteID: noteID,
                context: context,
                config: SSHConfigManager.shared.config
            )
            store.fetchData()
        }
    }

    private func runSingleNoteSync(
        noteID: UUID,
        successMessage: String,
        operation: @escaping (ModelContext) async throws -> Void
    ) {
        guard SSHConfigManager.shared.isConfigured else {
            showSyncAlert(message: "请先在设置中配置 SSH 同步服务器")
            return
        }
        guard let context = PersistenceController.shared.modelContainer?.mainContext else {
            showSyncAlert(message: "数据容器未配置")
            return
        }
        guard !syncingNoteIDs.contains(noteID) else { return }

        syncingNoteIDs.insert(noteID)
        AutoSyncCoordinator.shared.beginManualSync()

        Task { @MainActor in
            defer {
                syncingNoteIDs.remove(noteID)
                AutoSyncCoordinator.shared.endManualSync()
            }

            do {
                try await operation(context)
                showSyncAlert(message: successMessage)
            } catch {
                showSyncAlert(message: "同步失败：\(error.localizedDescription)")
            }
        }
    }

    private func showSyncAlert(message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
}

struct NoteRowView: View {
    let note: Note
    let isSelected: Bool
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(note.title.isEmpty ? l10n(L10nKeys.common.noTitle) : note.title)
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
                    .foregroundStyle(isSelected ? .white : .primary)
                Spacer()
                if note.hasConflict {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(isSelected ? .white.opacity(0.8) : .yellow)
                }
                if note.hasReminder {
                    Image(systemName: "bell.fill")
                        .font(.caption2)
                        .foregroundStyle(isSelected ? .white.opacity(0.8) : .orange)
                }
            }
            Text(preview(from: note))
                .font(.system(size: 12))
                .lineLimit(2)
                .foregroundStyle(isSelected ? .white.opacity(0.8) : .secondary)
            HStack {
                Text(note.updatedAt, style: .date)
                Spacer()
                Text(note.folder)
            }
            .font(.caption2)
            .foregroundStyle(isSelected ? .white.opacity(0.6) : .secondary)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 12)
        .background(isSelected ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func preview(from note: Note) -> String {
        let str = note.isContentLoaded ? note.content.string : note.contentPreview
        let trimmed = str.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.components(separatedBy: .newlines)
        return lines.prefix(2).joined(separator: " ")
    }
}

private struct NoteEditorView: View {
    @Environment(\.colorScheme) private var colorScheme

    @Binding var note: Note
    @ObservedObject var controller: RichTextController
    @Binding var isEncryptedFolderUnlocked: Bool
    @EnvironmentObject private var store: NoteStore
    
    @StateObject private var recorder = AudioRecorderManager()
    @StateObject private var mixedRecorder = MixedAudioRecorder()
    @State private var showingReminderPopover = false
    @State private var showingRecordingMenu = false
    
    @State private var lastSavedTitle: String = ""
    @State private var lastSavedContentHash: Int = 0
    @State private var pendingSaveWorkItem: DispatchWorkItem?
    @State private var showingConflictDiff = false
    
    // 窗口状态管理
    @StateObject private var windowState = WindowStateManager.shared

    private func applyViewMode(_ mode: NoteViewMode) {
        guard note.viewMode != mode else { return }

        if controller.isBoundTo(noteID: note.id),
           let editorContent = controller.snapshotAttributedStringForSwitch() {
            note.content = editorContent
        }

        note.viewMode = mode
        store.saveNoteViewMode(id: note.id, viewMode: mode)
    }

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                // 主编辑器区域
                VStack(spacing: 0) {
                    EditorTopBarView(
                        controller: controller,
                        recorder: recorder,
                        mixedRecorder: mixedRecorder,
                        note: $note,
                        showingReminderPopover: $showingReminderPopover,
                        showingRecordingMenu: $showingRecordingMenu,
                        isEncryptedFolderUnlocked: $isEncryptedFolderUnlocked,
                        onSelectViewMode: applyViewMode
                    )

                    // 冲突横幅
                    if note.hasConflict {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.yellow)
                            Text("此笔记与远程版本有冲突")
                                .font(.subheadline)
                            Spacer()
                            Button("查看差异") {
                                showingConflictDiff = true
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            Button("保留本地") {
                                resolveConflict(keepLocal: true)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            Button("采用远程") {
                                resolveConflict(keepLocal: false)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.yellow.opacity(0.1))
                    }

                    VStack(alignment: .leading, spacing: 0) {
                        TextField(l10n(L10nKeys.Note.titlePlaceholder), text: $note.title)
                            .font(.title2)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 16)
                            .padding(.top, 14)
                            .padding(.bottom, 10)
                            .onChange(of: note.title) { _, newTitle in
                                store.updateNoteTitleInMemory(id: note.id, title: newTitle)
                                debouncedScheduleAutoSave(title: newTitle, content: note.content)
                            }

                        Divider()
                            .padding(.horizontal, 16)

                        switch note.viewMode {
                        case .text:
                            // 富文本编辑模式
                            RichTextEditor(
                                attributedText: $note.content,
                                controller: controller,
                                isEditable: true,
                                noteID: note.id
                            )
                            .id(note.id)
                            .frame(maxHeight: .infinity)
                            .onChange(of: note.content) { _, newContent in
                                debouncedScheduleAutoSave(title: note.title, content: newContent)
                            }
                        case .preview:
                            // Markdown 预览模式
                            NoteMarkdownPreviewView(content: note.content, colorScheme: colorScheme, noteID: note.id)
                                .frame(maxHeight: .infinity)
                        case .split:
                            // 分屏预览模式
                            HStack(spacing: 0) {
                                // 左侧编辑器
                                RichTextEditor(
                                    attributedText: $note.content,
                                    controller: controller,
                                    isEditable: true,
                                    noteID: note.id
                                )
                                .id(note.id)
                                .frame(maxHeight: .infinity)
                                .onChange(of: note.content) { _, newContent in
                                    debouncedScheduleAutoSave(title: note.title, content: newContent)
                                }

                                // 中间分割线
                                Rectangle()
                                    .frame(width: 1)
                                    .foregroundStyle(Color.gray.opacity(0.3))

                                // 右侧预览
                                NoteMarkdownPreviewView(content: note.content, colorScheme: colorScheme, noteID: note.id)
                                    .frame(maxHeight: .infinity)
                            }
                        }
                    }
                }
                .frame(width: windowState.isRightSidebarExpanded ? geometry.size.width - windowState.rightSidebarWidth : geometry.size.width, height: geometry.size.height)
                .background(AppColors.editorBackground(colorScheme))
                
                // AI 侧边窗口
                if windowState.isRightSidebarExpanded {
                    AIPanelView(isExpanded: $windowState.isRightSidebarExpanded, panelWidth: $windowState.rightSidebarWidth)
                        .transition(.move(edge: .trailing))
                        .frame(height: geometry.size.height)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppColors.editorBackground(colorScheme))
        .onAppear {
            lastSavedTitle = note.title
            lastSavedContentHash = note.content.hashValue
            controller.recordSavedState(noteID: note.id, title: note.title, content: note.content)
        }
        .onDisappear {
            pendingSaveWorkItem?.cancel()
        }
        .sheet(isPresented: $showingConflictDiff) {
            ConflictDiffView(noteID: note.id, localContent: note.content)
        }
        .onReceive(NotificationCenter.default.publisher(for: .toggleMarkdownPreview)) { _ in
            // 快捷键循环切换三种模式
            let newMode: NoteViewMode
            switch note.viewMode {
            case .text:
                newMode = .preview
            case .preview:
                newMode = .split
            case .split:
                newMode = .text
            }
            // 使用 DispatchQueue 避免 Publishing changes from within view updates 警告
            DispatchQueue.main.async {
                applyViewMode(newMode)
            }
        }
        .toolbar {
            ToolbarItemGroup {
                Button(l10n(L10nKeys.common.save)) {
                    pendingSaveWorkItem?.cancel()
                }
                .keyboardShortcut("s", modifiers: .command)
                .buttonStyle(.plain)
                .labelStyle(.iconOnly)
                .frame(width: 0, height: 0)
                .opacity(0)
            }
        }
    }

    private func resolveConflict(keepLocal: Bool) {
        guard let context = PersistenceController.shared.modelContainer?.mainContext else { return }
        do {
            if keepLocal {
                try BlockDocumentNoteVersionStore.resolveConflictKeepLocal(noteID: note.id, context: context)
            } else {
                try BlockDocumentNoteVersionStore.resolveConflictKeepRemote(noteID: note.id, context: context)
                store.fetchData()
            }
            note.hasConflict = false
        } catch {
            Logger.shared.log(.app, .warn, "Failed to resolve conflict: \(error)")
        }
    }

    private func debouncedScheduleAutoSave(title: String, content: NSAttributedString) {
        let contentHash = content.hashValue
        let titleChanged = title != lastSavedTitle
        let contentChanged = contentHash != lastSavedContentHash
        
        guard titleChanged || contentChanged else { return }
        
        let currentNoteID = note.id
        pendingSaveWorkItem?.cancel()
        
        let workItem = DispatchWorkItem { [self] in
            performAutoSave(title: title, noteID: currentNoteID)
        }
        pendingSaveWorkItem = workItem
        
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: workItem)
    }
    
    private func performAutoSave(title: String, noteID: UUID) {
        // 使用不丢弃 marked text 的方法获取内容
        // 如果有 marked text（输入法正在编辑），则跳过本次自动保存
        guard let editorContent = controller.snapshotAttributedStringPreservingMarkedText() else {
            // 重新调度保存，等待输入法提交后再保存
            pendingSaveWorkItem?.cancel()
            let workItem = DispatchWorkItem { [self] in
                performAutoSave(title: title, noteID: noteID)
            }
            pendingSaveWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: workItem)
            return
        }
        
        // 检查编辑器是否还绑定到正确的笔记
        guard controller.isBoundTo(noteID: noteID) else { return }
        
        lastSavedTitle = title
        lastSavedContentHash = editorContent.hashValue
        
        guard let note = store.notes.first(where: { $0.id == noteID }) else { return }
        
        guard let request = NoteSaveManager.shared.createRequest(
            noteID: noteID,
            title: title,
            folderID: note.folderID,
            folder: note.folder,
            reminderAt: note.reminderAt,
            recurrenceRule: note.recurrenceRule,
            content: editorContent,
            reason: "autoSave"
        ) else { return }
        
        NoteSaveManager.shared.scheduleSave(request: request, delay: 1.0)
    }
}

private struct EditorTopBarView: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: NoteStore

    @ObservedObject var controller: RichTextController
    @ObservedObject var recorder: AudioRecorderManager
    @ObservedObject var mixedRecorder: MixedAudioRecorder
    @Binding var note: Note
    @Binding var showingReminderPopover: Bool
    @Binding var showingRecordingMenu: Bool
    @StateObject private var windowState = WindowStateManager.shared
    @EnvironmentObject private var themeManager: ThemeManager
    @Binding var isEncryptedFolderUnlocked: Bool
    let onSelectViewMode: (NoteViewMode) -> Void

    @State private var tempReminderAt: Date = Date()
    @State private var tempRecurrence: String = "none"
    @State private var currentRecordingMode: AudioRecordingMode = .microphone
    @State private var showingInsertTableDialog = false
    @State private var showingNoteSearch = false
    @State private var noteSearchText = ""
    @FocusState private var isNoteSearchFieldFocused: Bool

    private func moveNoteToEncryptedFolder(_ folder: EncryptedFolder) {
        let noteTitle = note.title.isEmpty ? "(无标题)" : note.title
        let noteIDPrefix = note.id.uuidString.prefix(8)

        guard !EncryptedFolderManager.shared.isEncrypted(note: note) else {
            note.folderID = folder.id
            note.folder = "🔒 " + folder.name
            Logger.shared.log(.encryption, .info, "Move encrypted note [\(noteIDPrefix)] '\(noteTitle)' to encrypted folder '\(folder.name)'")
            return
        }

        var updatedNote = note
        EncryptedFolderManager.shared.encryptNote(&updatedNote, to: folder.id)
        updatedNote.folder = "🔒 " + folder.name
        note = updatedNote
        Logger.shared.log(.encryption, .info, "Encrypt note [\(noteIDPrefix)] '\(noteTitle)' into encrypted folder '\(folder.name)'")
    }

    var recurrenceOptions: [(String, String)] {
        [
            (l10n(L10nKeys.Note.noRecurrence), "none"),
            (l10n(L10nKeys.Note.daily), "daily"),
            (l10n(L10nKeys.Note.weekly), "weekly"),
            (l10n(L10nKeys.Note.monthly), "monthly")
        ]
    }

    /// 获取字体的显示名称
    private func fontDisplayName(for fontName: String) -> String {
        if let font = AppSettings.availableFonts.first(where: { $0.name == fontName }) {
            return font.displayName
        }
        return "系统默认"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                // 格式菜单（合并所有文本样式）
                Menu {
                    Button {
                        controller.toggleBold()
                    } label: {
                        Label(l10n(L10nKeys.Editor.bold), systemImage: "bold")
                    }
                    Button {
                        controller.toggleItalic()
                    } label: {
                        Label(l10n(L10nKeys.Editor.italic), systemImage: "italic")
                    }
                    Button {
                        controller.toggleUnderline()
                    } label: {
                        Label(l10n(L10nKeys.Editor.underline), systemImage: "underline")
                    }
                    Button {
                        controller.toggleStrikethrough()
                    } label: {
                        Label(l10n(L10nKeys.Editor.strikethrough), systemImage: "strikethrough")
                    }
                    Divider()
                    Button(l10n(L10nKeys.Editor.heading1)) { controller.setHeading(level: 1) }
                    Button(l10n(L10nKeys.Editor.heading2)) { controller.setHeading(level: 2) }
                    Button(l10n(L10nKeys.Editor.heading3)) { controller.setHeading(level: 3) }
                    Divider()
                    Button {
                        controller.clearFormatting()
                    } label: {
                        Label(l10n(L10nKeys.Editor.clearFormatting), systemImage: "textformat.clear")
                    }
                } label: {
                    Text("格式")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 40)

                // 字体选择
                Menu {
                    ForEach(AppSettings.availableFonts, id: \.name) { font in
                        Button {
                            controller.setFont(name: font.name)
                        } label: {
                            HStack {
                                Text(font.displayName)
                                // 显示当前选中区域使用的字体
                                if let fontInfo = controller.getSelectedFontInfo() {
                                    let currentFontName = fontInfo.name
                                    let isMatch = (font.name == "System" && (currentFontName.contains(".AppleSystemUIFont") || currentFontName.contains("SF"))) ||
                                                 currentFontName.contains(font.name)
                                    if isMatch {
                                        Spacer()
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    }
                } label: {
                    Text("字体")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 40)

                // 字号选择
                Menu {
                    ForEach(Array(stride(from: Int(AppSettings.minFontSize), through: Int(AppSettings.maxFontSize), by: 1)), id: \.self) { size in
                        Button {
                            controller.setFontSize(CGFloat(size))
                        } label: {
                            HStack {
                                Text("\(size)pt")
                                // 显示当前选中区域使用的字号
                                if let fontInfo = controller.getSelectedFontInfo(),
                                   Int(fontInfo.size) == size {
                                    Spacer()
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    Text("字号")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 40)

                // 字体颜色选择
                colorPickerMenu

                Divider().frame(height: 18)

                // 列表菜单（合并所有列表类型）
                Menu {
                    Button {
                        controller.toggleBullets()
                    } label: {
                        Text("•  " + l10n(L10nKeys.Editor.bulletList))
                    }
                    Button {
                        controller.toggleDashList()
                    } label: {
                        Text("–  " + l10n(L10nKeys.Editor.dashList))
                    }
                    Button {
                        controller.toggleNumberedList()
                    } label: {
                        Text("1. " + l10n(L10nKeys.Editor.numberedList))
                    }
                    Divider()
                    Button {
                        controller.toggleCheckbox()
                    } label: {
                        Text("☑  " + l10n(L10nKeys.Editor.checkbox))
                    }
                } label: {
                    Image(systemName: "list.bullet")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 20)

                // 表格按钮
                Button {
                    showingInsertTableDialog = true
                } label: {
                    Image(systemName: "tablecells")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 20)
                .popover(isPresented: $showingInsertTableDialog, arrowEdge: .bottom) {
                    InsertTableDialog(isPresented: $showingInsertTableDialog) { rows, columns in
                        controller.insertTable(rows: rows, columns: columns)
                    }
                }

                Divider().frame(height: 18)

                // 增加缩进
                Button { controller.increaseIndent() } label: {
                    Image(systemName: "increase.indent")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 20)

                // 减少缩进
                Button { controller.decreaseIndent() } label: {
                    Image(systemName: "decrease.indent")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 20)

                // 文件夹选择
                Menu {
                    ForEach(store.folders) { folder in
                        Button(folder.name) {
                            note.folder = folder.name
                            note.folderID = folder.id
                        }
                    }

                    if isEncryptedFolderUnlocked {
                        Divider()

                        Menu("🔒 加密文件夹") {
                            if store.encryptedFolders.isEmpty {
                                Text("无加密文件夹")
                            } else {
                                ForEach(store.encryptedFolders) { folder in
                                    Button(folder.name) {
                                        moveNoteToEncryptedFolder(folder)
                                    }
                                }
                            }
                        }
                    }
                } label: {
                    Image(systemName: "folder")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 20)

                // 标签按钮
                TagButton(note: $note)

                // 提醒按钮
                Button {
                    tempReminderAt = note.reminderAt ?? Date()
                    tempRecurrence = note.recurrenceRule
                    showingReminderPopover = true
                } label: {
                    Image(systemName: note.hasReminder ? "bell.fill" : "bell")
                        .foregroundStyle(note.hasReminder ? .orange : .secondary)
                }
                .buttonStyle(.plain)
                .frame(minWidth: 20)
                .popover(isPresented: $showingReminderPopover, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(l10n(L10nKeys.Note.reminderTitle))
                            .font(.headline)
                        DatePicker(l10n(L10nKeys.Note.reminder), selection: $tempReminderAt)
                        Picker(l10n(L10nKeys.Note.recurrence), selection: $tempRecurrence) {
                            ForEach(recurrenceOptions, id: \.1) { name, value in
                                Text(name).tag(value)
                            }
                        }
                        HStack {
                            Button(l10n(L10nKeys.common.cancel)) {
                                showingReminderPopover = false
                            }
                            Spacer()
                            Button(l10n(L10nKeys.Note.clearReminder)) {
                                note.reminderAt = nil
                                note.recurrenceRule = "none"
                                showingReminderPopover = false
                                NotificationManager.shared.cancel(noteID: note.id)
                            }
                            .disabled(!note.hasReminder)
                            Button(l10n(L10nKeys.common.save)) {
                                note.reminderAt = tempReminderAt
                                note.recurrenceRule = tempRecurrence
                                showingReminderPopover = false
                                
                                // 调度通知
                                let body = note.content.string.trimmingCharacters(in: .whitespacesAndNewlines)
                                let preview = body.prefix(30) + (body.count > 30 ? "..." : "")
                                Task {
                                    await NotificationManager.shared.schedule(
                                        noteID: note.id,
                                        title: note.title.isEmpty ? l10n(L10nKeys.Note.reminderTitle) : note.title,
                                        body: String(preview),
                                        reminderAt: tempReminderAt,
                                        recurrence: tempRecurrence
                                    )
                                }
                            }
                        }
                    }
                    .padding()
                    .frame(width: 320)
                }

                Spacer()
                
                Divider().frame(height: 18)

                // 目录按钮（仅在预览或分屏模式下显示）
                TableOfContentsMenu(
                    content: note.content.string,
                    viewMode: note.viewMode,
                    onSelect: { anchor in
                        // 发送通知让 MarkdownWebView 滚动到指定位置
                        NotificationCenter.default.post(
                            name: .scrollToHeading,
                            object: note.id,
                            userInfo: ["anchor": anchor]
                        )
                    }
                )

                Divider().frame(height: 18)

                // Markdown 预览模式选择菜单
                Menu {
                    ForEach(NoteViewMode.allCases, id: \.self) { mode in
                        Button {
                            // 使用 DispatchQueue 避免 Publishing changes from within view updates 警告
                            DispatchQueue.main.async {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    onSelectViewMode(mode)
                                }
                            }
                        } label: {
                            HStack {
                                Image(systemName: mode.icon)
                                Text(mode.displayName)
                                if note.viewMode == mode {
                                    Spacer()
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    Image(systemName: note.viewMode.icon)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(ThemeManager.shared.accentColor)
                }
                .buttonStyle(.plain)
                .help("选择视图模式")
                
                Divider().frame(height: 18)
                
                // AI 助手按钮（使用与侧边栏类似的图标）
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        windowState.isRightSidebarExpanded.toggle()
                    }
                } label: {
                    Image(systemName: windowState.isRightSidebarExpanded ? "sidebar.right" : "sidebar.right")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(windowState.isRightSidebarExpanded ? ThemeManager.shared.accentColor : .secondary)
                }
                .buttonStyle(.plain)
                .help("AI 助手")
                
                Divider().frame(height: 18)
                
                // 录音按钮
                recordingButton

                // 本笔记搜索按钮
                noteSearchButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            if showingNoteSearch {
                Divider()
                    .padding(.horizontal, 12)

                noteSearchBar
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 10)
            }
        }
        .background(AppColors.editorBackground(colorScheme))
        .onReceive(NotificationCenter.default.publisher(for: .focusCurrentNoteSearch)) { notification in
            guard let targetNoteID = notification.object as? UUID, targetNoteID == note.id else { return }
            openNoteSearchFromShortcut()
        }
        .onChange(of: note.id) { _, _ in
            closeNoteSearch()
        }
        .onChange(of: note.viewMode) { _, newMode in
            if newMode == .preview && showingNoteSearch {
                closeNoteSearch()
            }
        }
    }
    
    // MARK: - 录音按钮
    
    @State private var audioRecorderPanel: NSPanel?
    
    private var recordingButton: some View {
        Button {
            presentAudioRecorderPanel()
        } label: {
            Image(systemName: "waveform")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("录音")
    }

    private var noteSearchButton: some View {
        Button {
            toggleNoteSearch()
        } label: {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(showingNoteSearch ? ThemeManager.shared.accentColor : .secondary)
        }
        .buttonStyle(.plain)
        .help("搜索当前笔记")
    }

    private var noteSearchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("搜索当前笔记", text: $noteSearchText)
                .textFieldStyle(.plain)
                .focused($isNoteSearchFieldFocused)
                .onChange(of: noteSearchText) { _, newValue in
                    controller.updateNoteSearch(query: newValue)
                }
                .onSubmit {
                    controller.selectNextNoteSearchMatch()
                    focusNoteSearchField()
                }

            Text(noteSearchStatusText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, alignment: .trailing)

            Button {
                controller.selectPreviousNoteSearchMatch()
                focusNoteSearchField()
            } label: {
                Image(systemName: "chevron.up")
            }
            .buttonStyle(.plain)
            .disabled(controller.noteSearchResultCount == 0)
            .help("上一个结果")

            Button {
                controller.selectNextNoteSearchMatch()
                focusNoteSearchField()
            } label: {
                Image(systemName: "chevron.down")
            }
            .buttonStyle(.plain)
            .disabled(controller.noteSearchResultCount == 0)
            .help("下一个结果")

            Button {
                closeNoteSearch()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("关闭搜索")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(colorScheme == .dark ? 0.14 : 0.08))
        )
    }

    private var noteSearchStatusText: String {
        if noteSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "0/0"
        }
        if controller.noteSearchResultCount == 0 {
            return "0/0"
        }
        return "\(controller.noteSearchCurrentMatchIndex)/\(controller.noteSearchResultCount)"
    }

    private func toggleNoteSearch() {
        if showingNoteSearch {
            focusNoteSearchField()
            return
        }

        if note.viewMode == .preview {
            onSelectViewMode(.split)
        }

        showingNoteSearch = true
        focusNoteSearchField()
        controller.updateNoteSearch(query: noteSearchText)
    }

    private func openNoteSearchFromShortcut() {
        if showingNoteSearch {
            focusNoteSearchField()
            return
        }
        toggleNoteSearch()
    }

    private func focusNoteSearchField() {
        DispatchQueue.main.async {
            isNoteSearchFieldFocused = true
        }
    }

    private func closeNoteSearch() {
        showingNoteSearch = false
        noteSearchText = ""
        isNoteSearchFieldFocused = false
        controller.clearNoteSearch()
    }

    private func presentAudioRecorderPanel() {
        // 避免重复创建，存在则直接置前
        if let existing = audioRecorderPanel {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "录音"
        panel.isFloatingPanel = false
        panel.level = .normal
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false

        if #available(macOS 12.3, *) {
            let view = AudioRecorderView(
                noteID: note.id,
                onRecordingComplete: { url in
                    controller.insertAudio(from: url)
                },
                onRequestClose: {
                    closeAudioRecorderPanel()
                }
            )
            panel.contentViewController = NSHostingController(rootView: view)
        } else {
            let view = LegacyAudioRecorderView(
                noteID: note.id,
                onRecordingComplete: { url in
                    controller.insertAudio(from: url)
                },
                onRequestClose: {
                    closeAudioRecorderPanel()
                }
            )
            panel.contentViewController = NSHostingController(rootView: view)
        }

        if let parentWindow = NSApp.keyWindow {
            panel.setFrameOrigin(NSPoint(x: parentWindow.frame.midX - 210, y: parentWindow.frame.midY - 270))
        }

        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        audioRecorderPanel = panel
    }

    private func closeAudioRecorderPanel() {
        audioRecorderPanel?.orderOut(nil)
        audioRecorderPanel?.close()
        audioRecorderPanel = nil
    }
    
    // MARK: - 颜色选择器
    
    @State private var showingColorPicker = false
    
    private var colorPickerMenu: some View {
        Button {
            showingColorPicker.toggle()
        } label: {
            // A 图标带下划线
            ZStack(alignment: .bottom) {
                Text("A")
                    .font(.system(size: 14, weight: .medium))
                Rectangle()
                    .fill(Color.blue)
                    .frame(width: 12, height: 2)
                    .offset(y: 2)
            }
            .frame(width: 20, height: 20)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .frame(minWidth: 20)
        .popover(isPresented: $showingColorPicker, arrowEdge: .bottom) {
            ColorPickerPopover(controller: controller, isPresented: $showingColorPicker)
        }
    }
}

// MARK: - 颜色选择器弹窗

private struct ColorPickerPopover: View {
    @ObservedObject var controller: RichTextController
    @Binding var isPresented: Bool
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // 自动颜色
            Button {
                controller.setFontColor(NSColor.textColor)
                isPresented = false
            } label: {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(nsColor: .textColor))
                        .frame(width: 16, height: 16)
                    Text("自动")
                        .foregroundColor(.primary)
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            
            Divider()
            
            // 主题颜色网格
            VStack(spacing: 4) {
                ForEach(0..<5) { row in
                    HStack(spacing: 4) {
                        ForEach(0..<10) { col in
                            let index = row * 10 + col
                            if index < AppSettings.themeColors.count {
                                let colorItem = AppSettings.themeColors[index]
                                Button {
                                    controller.setFontColor(NSColor(colorItem.color))
                                    isPresented = false
                                } label: {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(colorItem.color)
                                        .frame(width: 18, height: 18)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 2)
                                                .stroke(Color.gray.opacity(0.3), lineWidth: 0.5)
                                        )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            
            Divider()
            
            Text("标准色")
                .font(.caption)
                .foregroundColor(.secondary)
            
            // 标准色网格
            HStack(spacing: 4) {
                ForEach(0..<AppSettings.standardColors.count, id: \.self) { index in
                    let color = AppSettings.standardColors[index]
                    Button {
                        controller.setFontColor(NSColor(color))
                        isPresented = false
                    } label: {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(color)
                            .frame(width: 18, height: 18)
                            .overlay(
                                RoundedRectangle(cornerRadius: 2)
                                    .stroke(Color.gray.opacity(0.3), lineWidth: 0.5)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(16)
        .frame(width: 220)
    }
}

private struct TagButton: View {
    @EnvironmentObject private var store: NoteStore
    @StateObject private var themeManager = ThemeManager.shared
    @Binding var note: Note
    @State private var showingTagPopover = false

    var body: some View {
        Menu {
            // 显示已添加的标签
            let noteTagIDs = Set(note.tagIDs)
            let addedTags = store.tags.filter { noteTagIDs.contains($0.id) }
            let availableTags = store.tags.filter { !noteTagIDs.contains($0.id) }

            if !addedTags.isEmpty {
                Section(l10n(L10nKeys.Tag.added)) {
                    ForEach(addedTags) { tag in
                        Button {
                            store.removeTagFromNote(tagID: tag.id, noteID: note.id)
                            if let idx = store.notes.firstIndex(where: { $0.id == note.id }) {
                                store.notes[idx].tagIDs.removeAll { $0 == tag.id }
                            }
                        } label: {
                            HStack {
                                Circle()
                                    .fill(tag.swiftUIColor)
                                    .frame(width: 8, height: 8)
                                Text(tag.name)
                                Spacer()
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }

            if !availableTags.isEmpty {
                Section(l10n(L10nKeys.Tag.addTag)) {
                    ForEach(availableTags) { tag in
                        Button {
                            store.addTagToNote(tagID: tag.id, noteID: note.id)
                            if let idx = store.notes.firstIndex(where: { $0.id == note.id }) {
                                store.notes[idx].tagIDs.append(tag.id)
                            }
                        } label: {
                            HStack {
                                Circle()
                                    .fill(tag.swiftUIColor)
                                    .frame(width: 8, height: 8)
                                Text(tag.name)
                            }
                        }
                    }
                }
            }

            if store.tags.isEmpty {
                Text(l10n(L10nKeys.Tag.noAvailable))
                    .foregroundStyle(.secondary)
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "tag")
                    .font(.system(size: 14))
                // 只计算实际存在的标签数量
                let existingTagCount = store.tags.filter { note.tagIDs.contains($0.id) }.count
                if existingTagCount > 0 {
                    Text("\(existingTagCount)")
                        .font(.caption)
                }
            }
            .foregroundStyle(note.tagIDs.isEmpty ? Color.secondary : themeManager.accentColor)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

// MARK: - AI 侧边窗口

private struct AIPanelView: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: NoteStore
    @Binding var isExpanded: Bool
    @Binding var panelWidth: CGFloat
    @StateObject private var themeManager = ThemeManager.shared
    @StateObject private var aiService = AIService.shared
    @StateObject private var configManager = AIConfigManager.shared
    
    // 拖动状态
    @State private var isDragging: Bool = false
    @State private var dragStartWidth: CGFloat = 320
    
    // 对话状态
    @State private var messages: [AIMessage] = []
    @State private var inputText: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String? = nil
    @State private var streamingMessage: String = ""
    
    private let minWidth: CGFloat = 250
    private let maxWidth: CGFloat = 600
    
    var body: some View {
        VStack(spacing: 0) {
            // 顶部工具栏
            HStack {
                Text("AI 助手")
                    .font(.headline)
                    .foregroundStyle(.primary)
                
                Spacer()
                
                // 插入到笔记按钮
                Button {
                    insertConversationToNote()
                } label: {
                    Image(systemName: "square.and.arrow.down")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("插入对话到笔记")
                .disabled(messages.isEmpty)
                
                // 设置按钮
                AISettingsButton()
                
                Button {
                    messages.removeAll()
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("清空对话")
                
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        isExpanded = false
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("关闭")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 错误提示
            if let errorMessage = errorMessage {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .padding(.top, 2)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button {
                        self.errorMessage = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.orange.opacity(0.1))
            }
            
            // 消息列表
            ScrollView {
                ScrollViewReader { proxy in
                    LazyVStack(spacing: 12) {
                        if messages.isEmpty {
                            VStack(spacing: 8) {
                                Image(systemName: "brain")
                                    .font(.system(size: 48))
                                    .foregroundStyle(themeManager.accentColor.opacity(0.6))
                                Text("开始与 AI 对话")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Text("输入问题或选择笔记内容提问")
                                    .font(.caption)
                                    .foregroundStyle(.secondary.opacity(0.7))
                            }
                            .frame(maxWidth: .infinity, minHeight: 200)
                            .padding(.top, 60)
                        } else {
                            ForEach(messages) { message in
                                MessageBubble(message: message)
                            }

                            if isLoading {
                                HStack {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                    Text("AI 思考中...")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                    .onChange(of: messages.count) { _, _ in
                        if let lastId = messages.last?.id {
                            withAnimation {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: .infinity)
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 输入区域
            VStack(spacing: 8) {
                // 当前模型显示（可点击选择）
                AIServiceSelectorHeader()
                
                HStack(spacing: 8) {
                    AIInputField(
                        text: $inputText,
                        onSend: sendMessage,
                        isLoading: isLoading
                    )
                    
                    Button {
                        sendMessage()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .secondary : themeManager.accentColor)
                    }
                    .buttonStyle(.plain)
                    .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(AppColors.editorBackground(colorScheme))
        }
        .frame(width: panelWidth)
        .background(AppColors.editorBackground(colorScheme))
        .overlay(
            Rectangle()
                .frame(width: 1)
                .foregroundStyle(Color.gray.opacity(0.2)),
            alignment: .leading
        )
        .overlay(
            // 拖动条
            HStack {
                Rectangle()
                    .fill(isDragging ? themeManager.accentColor : Color.clear)
                    .frame(width: 4)
                    .contentShape(Rectangle().size(width: 12, height: .infinity))
                    .gesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { value in
                                if !isDragging {
                                    isDragging = true
                                    dragStartWidth = panelWidth
                                }
                                // 向左拖动（减小 x）增加宽度，向右拖动（增加 x）减小宽度
                                let delta = -value.translation.width
                                let newWidth = dragStartWidth + delta
                                panelWidth = min(max(newWidth, minWidth), maxWidth)
                            }
                            .onEnded { _ in
                                isDragging = false
                            }
                    )
                    .onHover { hovering in
                        if hovering {
                            NSCursor.resizeLeftRight.set()
                        } else {
                            NSCursor.arrow.set()
                        }
                    }
                Spacer()
            }
        )
        .onReceive(NotificationCenter.default.publisher(for: .insertConversation)) { _ in
            insertConversationToNote()
        }
    }

    private func sendMessage() {
        let trimmedText = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else { return }
        
        // 检查是否选择了配置
        guard let config = configManager.selectedConfig else {
            errorMessage = "请先配置 AI 服务"
            return
        }
        
        // 检查 API Key
        guard !config.apiKey.isEmpty else {
            errorMessage = "请先配置 API Key"
            return
        }
        
        // 解析 @ 引用并构建发送内容
        print("[AI Debug] Input text: \(trimmedText)")
        let (displayContent, sendContent, extractedImages) = parseMentionsAndBuildContent(trimmedText)
        print("[AI Debug] Parsed - display: \(displayContent.prefix(50)), send: \(sendContent.prefix(50)), images: \(extractedImages.count)")
        
        let userMessage = AIMessage(content: displayContent, isUser: true)
        messages.append(userMessage)
        inputText = ""
        isLoading = true
        errorMessage = nil
        streamingMessage = ""
        
        // 创建临时的 AI 消息用于流式显示
        let aiMessageId = UUID()
        let aiMessage = AIMessage(id: aiMessageId, content: "", isUser: false)
        messages.append(aiMessage)
        
        // 准备消息历史（不包含刚添加的空AI消息）
        var messageDTOs = messages.dropLast().map { AIMessageDTO(content: $0.content, isUser: $0.isUser) }
        
        // 将最后一条用户消息替换为包含引用内容的完整消息和图片
        if let lastIndex = messageDTOs.indices.last {
            messageDTOs[lastIndex] = AIMessageDTO(content: sendContent, isUser: true, images: extractedImages)
        }
        
        // 调用 AI 服务（流式）
        Task {
            do {
                var fullResponse = ""
                try await aiService.sendMessageStream(
                    messages: messageDTOs,
                    apiKey: config.apiKey,
                    baseURL: config.baseURL,
                    model: config.model,
                    temperature: config.temperature,
                    maxTokens: config.maxTokens
                ) { chunk in
                    Task { @MainActor in
                        fullResponse += chunk
                        if let index = messages.firstIndex(where: { $0.id == aiMessageId }) {
                            messages[index].content = fullResponse
                        }
                    }
                }
                
                isLoading = false
            } catch {
                isLoading = false
                errorMessage = error.localizedDescription
                // 移除失败的 AI 消息
                messages.removeAll { $0.id == aiMessageId }
            }
        }
    }
    
    /// 解析 @ 引用并构建发送内容
    private func parseMentionsAndBuildContent(_ text: String) -> (displayContent: String, sendContent: String, images: [AIImageAttachment]) {
        // 匹配 [@标题](note:ID) 格式
        let pattern = #"\[@([^\]]+)\]\(note:([a-zA-Z0-9]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return (text, text, [])
        }
        
        let nsRange = NSRange(text.startIndex..., in: text)
        let matches = regex.matches(in: text, options: [], range: nsRange)
        
        print("[AI Debug] Found \(matches.count) @ mentions in text")
        
        // 如果没有匹配，直接返回原文
        guard !matches.isEmpty else {
            print("[AI Debug] No @ mentions found, returning original text")
            return (text, text, [])
        }
        
        var sendContent = text
        var referencedNotes: [(title: String, content: String, images: [AIImageAttachment])] = []
        var allImages: [AIImageAttachment] = []
        
        // 从后往前替换，避免位置变化
        for match in matches.reversed() {
            guard let fullRange = Range(match.range, in: text),
                  let titleRange = Range(match.range(at: 1), in: text),
                  let idRange = Range(match.range(at: 2), in: text) else { continue }
            
            let shortID = String(text[idRange])
            let title = String(text[titleRange])
            
            // 查找匹配的笔记（通过ID前缀匹配）
            if let noteID = store.notes.first(where: { $0.id.uuidString.hasPrefix(shortID) })?.id {
                store.ensureNoteContentLoaded(id: noteID, pruneAfterLoad: false)
                guard let note = store.notes.first(where: { $0.id == noteID }) else { continue }
                print("[AI Debug] Found note: \(note.title), content length: \(note.content.length)")
                
                // 提取笔记纯文本内容
                let plainContent = note.content.string
                
                // 提取笔记中的图片
                let images = extractImages(from: note.content)
                allImages.append(contentsOf: images)
                
                print("[AI Debug] Extracted \(images.count) images from note")
                
                // 添加到引用列表
                referencedNotes.append((title: note.title.isEmpty ? "无标题" : note.title, content: plainContent, images: images))
                
                // 在发送内容中替换为简单引用标记
                let replacement = "[@\(title)]"
                sendContent.replaceSubrange(fullRange, with: replacement)
            }
        }
        
        // 构建最终发送内容
        if !referencedNotes.isEmpty {
            var finalContent = "用户问题：\(sendContent)\n\n"
            finalContent += "---\n\n"
            finalContent += "引用的笔记内容：\n\n"
            
            for (index, note) in referencedNotes.enumerated() {
                finalContent += "【笔记 \(index + 1)】\(note.title)\n"
                finalContent += "\(note.content)\n"
                if !note.images.isEmpty {
                    finalContent += "[包含 \(note.images.count) 张图片]\n"
                }
                finalContent += "\n"
            }
            
            finalContent += "---\n"
            finalContent += "请根据以上引用的笔记内容回答用户问题。"
            
            return (text, finalContent, allImages)
        }
        
        return (text, text, [])
    }
    
    /// 从 NSAttributedString 中提取图片附件
    private func extractImages(from attributedString: NSAttributedString) -> [AIImageAttachment] {
        var images: [AIImageAttachment] = []
        let length = attributedString.length
        
        print("[AI Image] Starting extraction from attributed string of length: \(length)")
        
        // 首先检查字符串内容，看看是否有附件字符
        let string = attributedString.string
        print("[AI Image] String content: \(string.prefix(200))")
        
        // 检查所有属性
        attributedString.enumerateAttributes(in: NSRange(location: 0, length: length), options: []) { attrs, range, _ in
            if !attrs.isEmpty {
                print("[AI Image] Attributes at range \(range): \(attrs.keys.map { String(describing: $0) })")
            }
        }
        
        attributedString.enumerateAttribute(.attachment, in: NSRange(location: 0, length: length), options: []) { value, range, stop in
            guard let attachment = value else {
                print("[AI Image] No attachment value found at range: \(range)")
                return
            }
            
            print("[AI Image] Found attachment of type: \(type(of: attachment))")
            print("[AI Image] Attachment class hierarchy: \(String(reflecting: type(of: attachment)))")
            
            // 处理 AttachmentTextAttachment
            if let textAttachment = attachment as? AttachmentTextAttachment {
                guard textAttachment.kind == .image else {
                    print("[AI Image] Attachment is not an image, kind: \(textAttachment.kind)")
                    return
                }
                
                print("[AI Image] Processing image attachment at: \(textAttachment.attachmentFileURL)")

                if let imageData = textAttachment.attachmentData() {
                    let base64String = imageData.base64EncodedString()
                    let mimeType = mimeTypeForPath(path: textAttachment.attachmentFilename)
                    let aiImage = AIImageAttachment(base64Data: base64String, mimeType: mimeType)
                    images.append(aiImage)
                    print("[AI Image] Successfully extracted image: \(textAttachment.attachmentFilename), size: \(imageData.count) bytes, base64 length: \(base64String.count)")
                } else {
                    print("[AI Image] Failed to read image data from attachment or embedded payload")
                }
            }
            // 处理普通的 NSTextAttachment（可能包含图片）
            else if let nsAttachment = attachment as? NSTextAttachment {
                print("[AI Image] Found NSTextAttachment, checking for image...")
                
                // 尝试从 fileWrapper 获取数据
                if let fileWrapper = nsAttachment.fileWrapper,
                   let data = fileWrapper.regularFileContents {
                    let base64String = data.base64EncodedString()
                    let mimeType = "image/png" // 默认类型
                    let aiImage = AIImageAttachment(base64Data: base64String, mimeType: mimeType)
                    images.append(aiImage)
                    print("[AI Image] Extracted image from NSTextAttachment, size: \(data.count) bytes")
                }
                // 尝试从 image 属性获取
                else if let image = nsAttachment.image,
                        let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
                    if let data = bitmapRep.representation(using: .png, properties: [:]) {
                        let base64String = data.base64EncodedString()
                        let aiImage = AIImageAttachment(base64Data: base64String, mimeType: "image/png")
                        images.append(aiImage)
                        print("[AI Image] Extracted image from NSTextAttachment.image, size: \(data.count) bytes")
                    }
                } else {
                    print("[AI Image] Could not extract image data from NSTextAttachment")
                }
            } else {
                print("[AI Image] Unknown attachment type: \(type(of: attachment))")
            }
        }
        
        print("[AI Image] Total images extracted: \(images.count)")
        return images
    }
    
    /// 根据文件路径获取 MIME 类型
    private func mimeTypeForPath(path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg":
            return "image/jpeg"
        case "png":
            return "image/png"
        case "gif":
            return "image/gif"
        case "webp":
            return "image/webp"
        case "heic":
            return "image/heic"
        default:
            return "image/jpeg"
        }
    }

    /// 将当前对话插入到笔记光标位置
    private func insertConversationToNote() {
        guard !messages.isEmpty else { return }

        // 构建对话内容
        var conversationText = "\n\n--- AI 对话 ---\n\n"
        for message in messages {
            let role = message.isUser ? "用户" : "AI"
            conversationText += "【\(role)】\n\(message.content)\n\n"
        }
        conversationText += "--- 对话结束 ---\n"

        // 发送通知让 ContentView 处理插入
        NotificationCenter.default.post(
            name: .insertTextAtCursor,
            object: nil,
            userInfo: ["text": conversationText]
        )
    }
}

// MARK: - 回收站视图

private struct RecycleBinView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @Binding var selection: Note.ID?

    @State private var selectedIDs: Set<Note.ID> = []
    @State private var showingDeleteConfirm = false
    @State private var pendingDeleteIDs: Set<Note.ID> = []
    @State private var showingEmptyConfirm = false
    @State private var feedbackMessage: String?
    @State private var feedbackDismissTask: Task<Void, Never>?

    private var sortedNotes: [Note] {
        store.recycledNotes.sorted { $0.deletedAt ?? .distantPast > $1.deletedAt ?? .distantPast }
    }

    private var hasSelection: Bool {
        !selectedIDs.isEmpty
    }

    private var deleteAlertTitle: String {
        pendingDeleteIDs.count > 1 ? "彻底删除选中的 \(pendingDeleteIDs.count) 条笔记？" : "彻底删除该笔记？"
    }

    private var deleteAlertMessage: String {
        pendingDeleteIDs.count > 1 ? "删除后将无法恢复这些笔记。" : "删除后将无法恢复。"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("回收站")
                    .font(.headline)
                Spacer()
                if hasSelection {
                    Text("已选 \(selectedIDs.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button("恢复选中") {
                    restoreNotes(ids: selectedIDs)
                }
                .buttonStyle(.plain)
                .disabled(!hasSelection)
                .keyboardShortcut(.return, modifiers: [.command])
                Button("删除选中") {
                    pendingDeleteIDs = selectedIDs
                    showingDeleteConfirm = true
                }
                .buttonStyle(.plain)
                .disabled(!hasSelection)
                .keyboardShortcut(.delete, modifiers: [])
                Button("清空") {
                    showingEmptyConfirm = true
                }
                .buttonStyle(.plain)
                .disabled(sortedNotes.isEmpty)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AppColors.editorBackground(colorScheme))

            Divider()

            if sortedNotes.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "trash")
                        .font(.system(size: 32))
                        .foregroundStyle(.secondary)
                    Text("回收站为空")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $selectedIDs) {
                    ForEach(sortedNotes) { note in
                        RecycleBinRow(note: note)
                            .tag(note.id)
                            .contentShape(Rectangle())
                            .contextMenu {
                                Button("恢复到原文件夹") {
                                    restoreNotes(ids: [note.id])
                                }
                                Button(role: .destructive) {
                                    pendingDeleteIDs = [note.id]
                                    showingDeleteConfirm = true
                                } label: {
                                    Label("彻底删除", systemImage: "trash")
                                }
                            }
                    }
                }
                .listStyle(.plain)
            }
        }
        .frame(minWidth: 220, maxWidth: 280)
        .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
        .overlay(alignment: .bottom) {
            if let feedbackMessage {
                Text(feedbackMessage)
                    .font(.caption)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onAppear {
            selection = nil
        }
        .onChange(of: selectedIDs) { _, _ in
            selection = nil
        }
        .onChange(of: sortedNotes.map(\.id)) { _, currentIDs in
            selectedIDs.formIntersection(Set(currentIDs))
            if currentIDs.isEmpty {
                selection = nil
            }
        }
        .alert(deleteAlertTitle, isPresented: $showingDeleteConfirm) {
            Button("删除", role: .destructive) {
                let idsToDelete = pendingDeleteIDs
                let deletedCount = store.deleteNotesPermanently(ids: Array(idsToDelete))
                selectedIDs = RecycleBinSelectionCoordinator.selectionAfterRemoving(
                    idsToDelete,
                    from: selectedIDs,
                    availableIDs: sortedNotes.map(\.id)
                )
                selection = nil
                pendingDeleteIDs.removeAll()
                showFeedback("已彻底删除 \(deletedCount) 条笔记")
            }
            Button("取消", role: .cancel) {
                pendingDeleteIDs.removeAll()
            }
        } message: {
            Text(deleteAlertMessage)
        }
        .alert("清空回收站？", isPresented: $showingEmptyConfirm) {
            Button("清空", role: .destructive) {
                let deletedCount = store.deleteNotesPermanently(ids: sortedNotes.map(\.id))
                selectedIDs.removeAll()
                selection = nil
                showFeedback("已清空回收站，共删除 \(deletedCount) 条笔记")
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("将永久删除回收站中的所有笔记。")
        }
    }

    private func restoreNotes(ids: Set<Note.ID>) {
        let idsToRestore = ids
        let restoredCount = store.restoreNotes(ids: Array(idsToRestore))
        selectedIDs = RecycleBinSelectionCoordinator.selectionAfterRemoving(
            idsToRestore,
            from: selectedIDs,
            availableIDs: sortedNotes.map(\.id)
        )
        selection = nil
        showFeedback("已恢复 \(restoredCount) 条笔记")
    }

    private func showFeedback(_ message: String) {
        feedbackDismissTask?.cancel()
        withAnimation(.easeInOut(duration: 0.18)) {
            feedbackMessage = message
        }
        feedbackDismissTask = Task {
            try? await Task.sleep(for: .seconds(2))
            if Task.isCancelled {
                return
            }
            await MainActor.run {
                withAnimation(.easeInOut(duration: 0.18)) {
                    feedbackMessage = nil
                }
            }
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

private struct RecycleBinRow: View {
    let note: Note
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(note.title.isEmpty ? l10n(L10nKeys.common.noTitle) : note.title)
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Spacer()
            }
            Text(preview(from: note))
                .font(.system(size: 12))
                .lineLimit(2)
                .foregroundStyle(.secondary)
            HStack {
                if let deletedAt = note.deletedAt {
                    Text(deletedAt, style: .date)
                }
                Spacer()
                Text(note.originalFolderName ?? "未分类")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 12)
        .background(Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func preview(from note: Note) -> String {
        let str = note.isContentLoaded ? note.content.string : note.contentPreview
        let trimmed = str.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.components(separatedBy: .newlines)
        return lines.prefix(2).joined(separator: " ")
    }
}

// MARK: - AI 服务选择头部

private struct AIServiceSelectorHeader: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var configManager = AIConfigManager.shared
    @State private var showingSettings = false
    
    var body: some View {
        HStack {
            Menu {
                if configManager.configs.isEmpty {
                    Text("没有配置的服务")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(configManager.configs) { config in
                        Button {
                            configManager.selectConfig(id: config.id)
                        } label: {
                            HStack {
                                Text(config.name)
                                if config.id == configManager.selectedConfigID {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                }
                
                Divider()
                
                Button {
                    showingSettings = true
                } label: {
                    Label("管理配置...", systemImage: "gearshape")
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "cpu")
                        .font(.caption2)
                    Text(configManager.selectedConfig?.model ?? "未选择模型")
                        .font(.caption2)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                }
                .foregroundStyle(.secondary.opacity(0.7))
            }
            .buttonStyle(.plain)
            
            Spacer()
        }
        .sheet(isPresented: $showingSettings) {
            AIConfigManagementView()
        }
    }
}

// MARK: - AI 输入框（支持 @ 提及）

private struct AIInputField: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: NoteStore
    @Binding var text: String
    let onSend: () -> Void
    let isLoading: Bool
    
    // @ 提及相关状态
    @State private var showMentionPicker = false
    @State private var mentionQuery = ""
    @State private var cursorPosition = 0
    @State private var mentionRange: Range<String.Index>?
    
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            // 文本输入框 - 使用自定义的 NSTextView 包装器支持 ⌘+Enter
            AIInputTextView(text: $text, onSend: {
                print("[AIInput] onSend callback triggered")
                onSend()
            })
                .font(.body)
                .frame(minHeight: 32, maxHeight: 100)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .onChange(of: text) { oldValue, newValue in
                    handleTextChange(oldValue: oldValue, newValue: newValue)
                }
            
            // @ 提及选择器
            if showMentionPicker {
                NoteMentionPicker(
                    query: mentionQuery,
                    notes: store.notes,
                    onSelect: { note in
                        insertMention(note: note)
                    },
                    onDismiss: {
                        showMentionPicker = false
                        mentionQuery = ""
                    }
                )
                .offset(y: -150)
                .zIndex(1)
            }
        }
    }
    
    private func handleTextChange(oldValue: String, newValue: String) {
        // 检测是否输入了 @
        if let lastChar = newValue.last, lastChar == "@" {
            // 检查 @ 前面是否是空格或者是开头
            guard !newValue.isEmpty else { return }
            let index = newValue.index(before: newValue.endIndex)
            if index == newValue.startIndex {
                // @ 在开头
                showMentionPicker = true
                mentionQuery = ""
                mentionRange = newValue.range(of: "@", options: .backwards)
            } else {
                let prevIndex = newValue.index(before: index)
                let prevChar = newValue[prevIndex]
                if prevChar.isWhitespace || prevChar == "\n" {
                    showMentionPicker = true
                    mentionQuery = ""
                    mentionRange = newValue.range(of: "@", options: .backwards)
                }
            }
        } else if showMentionPicker {
            // 更新查询关键词
            if let range = mentionRange {
                let queryEnd = newValue.index(range.upperBound, offsetBy: 0)
                if queryEnd <= newValue.endIndex {
                    mentionQuery = String(newValue[range.upperBound...])
                }
                
                // 如果输入了空格或删除了 @，关闭选择器
                if newValue.count < oldValue.count && !newValue.contains("@") {
                    showMentionPicker = false
                    mentionQuery = ""
                }
            }
        }
    }
    
    private func insertMention(note: Note) {
        guard let range = mentionRange else { return }
        
        // 构建短格式的提及文本，使用笔记ID前8位作为标识
        let shortID = String(note.id.uuidString.prefix(8))
        let displayTitle = note.title.isEmpty ? "无标题" : note.title
        // 限制显示长度为15个字符
        let truncatedTitle = displayTitle.count > 15 ? String(displayTitle.prefix(15)) + "..." : displayTitle
        let mentionText = "[@\(truncatedTitle)](note:\(shortID)) "
        
        // 替换 @ + 查询内容
        let offset = mentionQuery.count + 1
        let maxOffset = text.distance(from: range.lowerBound, to: text.endIndex)
        let safeOffset = min(offset, maxOffset)
        let endIndex = text.index(range.lowerBound, offsetBy: safeOffset)
        let replaceRange = range.lowerBound..<endIndex
        text.replaceSubrange(replaceRange, with: mentionText)
        
        showMentionPicker = false
        mentionQuery = ""
        mentionRange = nil
    }
}

// MARK: - AI 输入框自定义 TextView（支持 ⌘+Enter）

// 自定义 NSTextView 子类用于捕获 ⌘+Enter
private class AIInputNSTextView: NSTextView {
    var onCmdEnter: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        print("[AIInput] keyDown - keyCode: \(event.keyCode), modifiers: \(event.modifierFlags)")
        // 检查是否是 ⌘+Enter (keyCode 36 = Return, keyCode 76 = Enter)
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        let hasCommand = event.modifierFlags.contains(.command)
        print("[AIInput] isReturn: \(isReturn), hasCommand: \(hasCommand)")
        if isReturn && hasCommand {
            print("[AIInput] ⌘+Enter detected, calling onCmdEnter")
            onCmdEnter?()
            return
        }
        super.keyDown(with: event)
    }
}

private struct AIInputTextView: NSViewRepresentable {
    @Binding var text: String
    let onSend: () -> Void
    
    func makeNSView(context: Context) -> NSScrollView {
        print("[AIInput] makeNSView called")
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.autoresizingMask = [.width, .height]

        let textView = AIInputNSTextView()
        print("[AIInput] Setting onCmdEnter callback")
        textView.onCmdEnter = {
            print("[AIInput] onCmdEnter closure executed")
            self.onSend()
        }
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        textView.backgroundColor = .clear
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        
        scrollView.documentView = textView
        
        return scrollView
    }
    
    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? AIInputNSTextView else { return }
        if textView.string != text {
            textView.string = text
        }
        // 更新回调
        print("[AIInput] updateNSView - updating onCmdEnter callback")
        textView.onCmdEnter = {
            print("[AIInput] onCmdEnter closure executed (from update)")
            self.onSend()
        }
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, NSTextViewDelegate {
        let parent: AIInputTextView
        
        init(_ parent: AIInputTextView) {
            self.parent = parent
        }
        
        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

// MARK: - 笔记提及选择器

private struct NoteMentionPicker: View {
    @Environment(\.colorScheme) private var colorScheme
    let query: String
    let notes: [Note]
    let onSelect: (Note) -> Void
    let onDismiss: () -> Void
    
    var filteredNotes: [Note] {
        if query.isEmpty {
            return Array(notes.prefix(10))
        } else {
            return notes.filter { $0.title.localizedCaseInsensitiveContains(query) }.prefix(10).map { $0 }
        }
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 标题
            HStack {
                Text("选择笔记")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(filteredNotes.count) 个结果")
                    .font(.caption2)
                    .foregroundStyle(.secondary.opacity(0.7))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 笔记列表
            if filteredNotes.isEmpty {
                Text("没有找到匹配的笔记")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filteredNotes) { note in
                            NoteMentionRow(note: note, onSelect: {
                                onSelect(note)
                            })
                            
                            if note.id != filteredNotes.last?.id {
                                Divider()
                                    .padding(.leading, 36)
                            }
                        }
                    }
                }
                .frame(maxHeight: 200)
            }
        }
        .frame(width: 280)
        .background(AppColors.editorBackground(colorScheme))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .shadow(color: Color.black.opacity(0.15), radius: 8, x: 0, y: 4)
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.gray.opacity(0.2), lineWidth: 1)
        )
    }
}

// MARK: - 笔记提及行

private struct NoteMentionRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let note: Note
    let onSelect: () -> Void
    
    @EnvironmentObject private var store: NoteStore
    
    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Image(systemName: "doc.text")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(note.title.isEmpty ? "无标题" : note.title)
                        .font(.system(size: 13))
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    
                    // 只计算实际存在的标签数量
                    let existingTagCount = store.tags.filter { note.tagIDs.contains($0.id) }.count
                    if existingTagCount > 0 {
                        HStack(spacing: 4) {
                            // 显示标签数量指示
                            Text("\(existingTagCount) 个标签")
                                .font(.caption2)
                                .foregroundStyle(.secondary.opacity(0.7))
                        }
                    }
                }
                
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.clear)
        .onHover { isHovered in
            if isHovered {
                NSCursor.pointingHand.set()
            } else {
                NSCursor.arrow.set()
            }
        }
    }
}

// MARK: - AI 服务选择按钮

private struct AIServiceSelectorButton: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var configManager = AIConfigManager.shared
    @State private var showingSettings = false
    
    var body: some View {
        Menu {
            if configManager.configs.isEmpty {
                Text("没有配置的服务")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(configManager.configs) { config in
                    Button {
                        configManager.selectConfig(id: config.id)
                    } label: {
                        HStack {
                            Text(config.name)
                            if config.id == configManager.selectedConfigID {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }
            
            Divider()
            
            Button {
                showingSettings = true
            } label: {
                Label("管理配置...", systemImage: "gearshape")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.caption)
                Text(configManager.selectedConfig?.name ?? "AI")
                    .font(.caption)
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("选择 AI 服务")
        .sheet(isPresented: $showingSettings) {
            AIConfigManagementView()
        }
    }
}

// MARK: - AI 设置按钮

private struct AISettingsButton: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared
    @State private var showingSettings = false
    
    var body: some View {
        Button {
            showingSettings = true
        } label: {
            Image(systemName: "gearshape")
                .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("AI 设置")
        .sheet(isPresented: $showingSettings) {
            AIConfigManagementView()
        }
    }
}

// MARK: - AI 配置管理视图

private struct AIConfigManagementView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @StateObject private var configManager = AIConfigManager.shared
    @State private var editingConfig: AIServiceConfig?
    @State private var showingAddSheet = false
    
    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text("AI 服务配置")
                    .font(.headline)
                Spacer()
                Button {
                    showingAddSheet = true
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                Button {
                    dismiss()
                } label: {
                    Text("关闭")
                }
                .buttonStyle(.plain)
            }
            .padding()
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 配置列表
            List {
                Section {
                    ForEach(configManager.configs) { config in
                        ConfigRow(config: config, isSelected: config.id == configManager.selectedConfigID)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                configManager.selectConfig(id: config.id)
                            }
                            .contextMenu {
                                Button {
                                    editingConfig = config
                                } label: {
                                    Label("编辑", systemImage: "pencil")
                                }
                                Button {
                                    configManager.duplicateConfig(config)
                                } label: {
                                    Label("复制", systemImage: "doc.on.doc")
                                }
                                Divider()
                                Button(role: .destructive) {
                                    configManager.deleteConfig(id: config.id)
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                    }
                }
                
                Section("添加预设") {
                    HStack(spacing: 12) {
                        PresetButton(title: "OpenAI", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.openAI)
                        }
                        PresetButton(title: "GPT-3.5", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.openAIGPT35)
                        }
                        PresetButton(title: "Azure", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.azureOpenAI)
                        }
                    }
                    HStack(spacing: 12) {
                        PresetButton(title: "Ollama", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.ollama)
                        }
                        PresetButton(title: "LM Studio", icon: "plus") {
                            configManager.addConfig(AIServiceConfig.lmStudio)
                        }
                        Spacer()
                    }
                }
            }
            .listStyle(.plain)
        }
        .frame(width: 400, height: 500)
        .background(AppColors.editorBackground(colorScheme))
        .sheet(item: $editingConfig) { config in
            AIConfigEditView(config: config, isNew: false)
        }
        .sheet(isPresented: $showingAddSheet) {
            AIConfigEditView(
                config: AIServiceConfig(name: "新配置"),
                isNew: true
            )
        }
    }
}

// MARK: - 预设按钮

private struct PresetButton: View {
    let title: String
    let icon: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption)
                Text(title)
                    .font(.caption)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.blue.opacity(0.1))
            .foregroundStyle(.blue)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 配置行视图

private struct ConfigRow: View {
    let config: AIServiceConfig
    let isSelected: Bool
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(config.name)
                    .font(.headline)
                Text("\(config.model) @ \(config.baseURL)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            
            Spacer()
            
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.blue)
            }
            
            if config.apiKey.isEmpty {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .help("未配置 API Key")
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - AI 配置编辑视图

private struct AIConfigEditView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @StateObject private var configManager = AIConfigManager.shared
    
    @State var config: AIServiceConfig
    let isNew: Bool
    
    @State private var name: String = ""
    @State private var baseURL: String = ""
    @State private var apiKey: String = ""
    @State private var model: String = ""
    @State private var temperature: Double = 0.7
    @State private var maxTokens: Int = 2000
    
    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Button("取消") {
                    dismiss()
                }
                .buttonStyle(.plain)
                
                Spacer()
                
                Text(isNew ? "添加配置" : "编辑配置")
                    .font(.headline)
                
                Spacer()
                
                Button("保存") {
                    saveConfig()
                }
                .buttonStyle(.plain)
                .disabled(name.isEmpty || baseURL.isEmpty || model.isEmpty)
            }
            .padding()
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 表单内容
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // 基本信息
                    Group {
                        Text("基本信息")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        TextField("配置名称", text: $name)
                            .textFieldStyle(.roundedBorder)
                        
                        TextField("Base URL", text: $baseURL)
                            .textFieldStyle(.roundedBorder)
                    }
                    
                    Divider()
                    
                    // 认证
                    Group {
                        Text("认证")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        SecureField("API Key", text: $apiKey)
                            .textFieldStyle(.roundedBorder)
                    }
                    
                    Divider()
                    
                    // 模型设置
                    Group {
                        Text("模型设置")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        TextField("模型名称", text: $model)
                            .textFieldStyle(.roundedBorder)
                        
                        HStack {
                            Text("Temperature: \(String(format: "%.1f", temperature))")
                            Spacer()
                        }
                        Slider(value: $temperature, in: 0...2, step: 0.1)
                        
                        HStack {
                            Text("Max Tokens: \(maxTokens)")
                            Spacer()
                        }
                        Slider(value: Binding(
                            get: { Double(maxTokens) },
                            set: { maxTokens = Int($0) }
                        ), in: 100...8000, step: 100)
                    }
                    
                    Divider()
                    
                    // 常用模型
                    Group {
                        Text("常用模型")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        FlowLayout(spacing: 8) {
                            ModelButton(title: "GPT-4") { model = "gpt-4" }
                            ModelButton(title: "GPT-4 Turbo") { model = "gpt-4-turbo-preview" }
                            ModelButton(title: "GPT-3.5") { model = "gpt-3.5-turbo" }
                            ModelButton(title: "Claude 3 Opus") { model = "claude-3-opus-20240229" }
                            ModelButton(title: "Claude 3 Sonnet") { model = "claude-3-sonnet-20240229" }
                            ModelButton(title: "Llama 2") { model = "llama2" }
                            ModelButton(title: "Mistral") { model = "mistral" }
                        }
                    }
                }
                .padding()
            }
        }
        .frame(width: 400, height: 500)
        .background(AppColors.editorBackground(colorScheme))
        .onAppear {
            name = config.name
            baseURL = config.baseURL
            apiKey = config.apiKey
            model = config.model
            temperature = config.temperature
            maxTokens = config.maxTokens
        }
    }
    
    private func saveConfig() {
        var updatedConfig = config
        updatedConfig.name = name
        updatedConfig.baseURL = baseURL
        updatedConfig.apiKey = apiKey
        updatedConfig.model = model
        updatedConfig.temperature = temperature
        updatedConfig.maxTokens = maxTokens
        
        if isNew {
            configManager.addConfig(updatedConfig)
        } else {
            configManager.updateConfig(updatedConfig)
        }
        
        dismiss()
    }
}

// MARK: - 模型按钮

private struct ModelButton: View {
    let title: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.blue.opacity(0.1))
                .foregroundStyle(.blue)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 流式布局

private struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = FlowResult(in: proposal.width ?? 0, subviews: subviews, spacing: spacing)
        return result.size
    }
    
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = FlowResult(in: bounds.width, subviews: subviews, spacing: spacing)
        for (index, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: bounds.minX + result.positions[index].x, y: bounds.minY + result.positions[index].y), proposal: .unspecified)
        }
    }
    
    struct FlowResult {
        var size: CGSize = .zero
        var positions: [CGPoint] = []
        
        init(in maxWidth: CGFloat, subviews: Subviews, spacing: CGFloat) {
            var x: CGFloat = 0
            var y: CGFloat = 0
            var rowHeight: CGFloat = 0
            
            for subview in subviews {
                let size = subview.sizeThatFits(.unspecified)
                if x + size.width > maxWidth && x > 0 {
                    x = 0
                    y += rowHeight + spacing
                    rowHeight = 0
                }
                positions.append(CGPoint(x: x, y: y))
                rowHeight = max(rowHeight, size.height)
                x += size.width + spacing
            }
            
            self.size = CGSize(width: maxWidth, height: y + rowHeight)
        }
    }
}

// MARK: - AI 消息模型

private struct AIMessage: Identifiable {
    let id: UUID
    var content: String
    let isUser: Bool
    let timestamp: Date
    
    init(id: UUID = UUID(), content: String, isUser: Bool, timestamp: Date = Date()) {
        self.id = id
        self.content = content
        self.isUser = isUser
        self.timestamp = timestamp
    }
}

// MARK: - 目录菜单按钮

private struct TableOfContentsMenu: NSViewRepresentable {
    let content: String
    let viewMode: NoteViewMode
    let onSelect: (String) -> Void

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton()
        button.image = NSImage(systemSymbolName: "list.bullet", accessibilityDescription: "目录")
        button.bezelStyle = .shadowlessSquare
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.target = context.coordinator
        button.action = #selector(Coordinator.showMenu(_:))
        button.toolTip = "目录 (⌘⇧T)"

        // 设置固定大小
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 20),
            button.heightAnchor.constraint(equalToConstant: 20)
        ])

        return button
    }

    func updateNSView(_ nsView: NSButton, context: Context) {
        let tocItems = extractTableOfContents(from: content)
        let isAvailable = viewMode != .text && !tocItems.isEmpty
        nsView.isEnabled = isAvailable
        nsView.alphaValue = viewMode != .text ? 1.0 : 0.0

        // 更新 coordinator 的数据
        context.coordinator.content = content
        context.coordinator.onSelect = onSelect
        context.coordinator.button = nsView
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(content: content, onSelect: onSelect)
    }

    class Coordinator: NSObject {
        var content: String
        var onSelect: (String) -> Void
        weak var button: NSButton?
        var cancellable: AnyCancellable?

        init(content: String, onSelect: @escaping (String) -> Void) {
            self.content = content
            self.onSelect = onSelect
            super.init()

            // 监听快捷键 publisher
            cancellable = ShortcutActionHandler.shared.toggleTableOfContentsPublisher
                .sink { [weak self] in
                    guard let self = self,
                          let button = self.button,
                          button.isEnabled,
                          button.alphaValue > 0 else { return }
                    self.showTableOfContentsMenu(from: button)
                }
        }

        @objc func showMenu(_ sender: NSButton) {
            showTableOfContentsMenu(from: sender)
        }

        private func showTableOfContentsMenu(from button: NSButton) {
            let tocItems = extractTableOfContents(from: content)
            guard !tocItems.isEmpty else { return }

            let menu = NSMenu()
            for item in tocItems {
                let menuItem = NSMenuItem(
                    title: indentText(for: item),
                    action: #selector(menuItemSelected(_:)),
                    keyEquivalent: ""
                )
                menuItem.target = self
                menuItem.representedObject = item.anchor
                menu.addItem(menuItem)
            }

            // 在按钮下方显示菜单
            let location = NSPoint(x: 0, y: button.bounds.minY)
            menu.popUp(positioning: nil, at: location, in: button)
        }

        @objc private func menuItemSelected(_ sender: NSMenuItem) {
            if let anchor = sender.representedObject as? String {
                onSelect(anchor)
            }
        }

        private func indentText(for item: TableOfContentsItem) -> String {
            let indent = String(repeating: "    ", count: max(0, item.level - 1))
            return indent + item.title
        }

        deinit {
            cancellable?.cancel()
        }
    }
}

// MARK: - 消息气泡组件

private struct MessageBubble: View {
    let message: AIMessage
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared
    @State private var isHovered = false
    @State private var webViewHeight: CGFloat = 50
    
    var body: some View {
        HStack {
            if message.isUser {
                Spacer(minLength: 40)
            }
            
            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                if message.isUser {
                    Text(message.content)
                        .font(.system(size: 13))
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(themeManager.accentColor)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .contextMenu {
                            Button {
                                copyToClipboard(message.content)
                            } label: {
                                Label("复制", systemImage: "doc.on.doc")
                            }
                        }
                } else {
                    MarkdownWebView(markdown: message.content, attributedContent: nil, colorScheme: colorScheme, height: $webViewHeight, noteID: UUID())
                        .frame(height: webViewHeight)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .contextMenu {
                            Button {
                                copyToClipboard(message.content)
                            } label: {
                                Label("复制", systemImage: "doc.on.doc")
                            }

                            Button {
                                copyToClipboard(message.content)
                            } label: {
                                Label("复制并粘贴到笔记", systemImage: "arrow.down.doc")
                            }
                        }
                }
                
                HStack(spacing: 6) {
                    Text(message.timestamp, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.secondary.opacity(0.6))
                    
                    if isHovered {
                        Button {
                            copyToClipboard(message.content)
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .transition(.opacity)
                    }
                }
            }
            .onHover { hovering in
                withAnimation(.easeInOut(duration: 0.15)) {
                    isHovered = hovering
                }
            }
            
            if !message.isUser {
                Spacer(minLength: 40)
            }
        }
    }
    
    private func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
