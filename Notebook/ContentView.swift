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

enum SidebarDestination: Equatable, Hashable {
    case allNotes
    case unfiled
    case conflicts
    case recycleBin
    case noteFolder(UUID)
    case encryptedFolder(UUID)
    case tag(UUID)
    case todoToday
    case todoImportant
    case todoList(UUID)
}

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
    @State private var selectedDestination: SidebarDestination = .allNotes
    @State private var selectedTodoID: UUID?
    @State private var showingDeleteConfirm = false
    @State private var pendingDeleteNoteID: UUID?
    @State private var pendingDeleteTodoID: UUID?
    @State private var isEncryptedFolderUnlocked: Bool = false
    @StateObject private var richTextController = RichTextController()

    private var filteredNotes: [Note] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if selectedDestination.isTodoDestination {
            return []
        }
        var notes = store.activeNotes
        Logger.shared.log(.search, .debug, "Start with \(notes.count) notes, destination: \(String(describing: selectedDestination)), searchText: \(searchText), searchInAllFolders: \(searchInAllFolders)")

        // 0. 排除加密文件夹的笔记（除非当前正在查看加密文件夹）
        if !selectedDestination.isEncryptedFolder {
            notes = notes.filter { !EncryptedFolderManager.shared.isEncrypted(note: $0) }
            Logger.shared.log(.search, .debug, "After excluding encrypted notes: \(notes.count) notes")
        }

        // 1. 标签筛选
        if case .tag(let tagID) = selectedDestination {
            let taggedNoteIDs = store.noteIDSet(forTagID: tagID)
            notes = notes.filter { taggedNoteIDs.contains($0.id) }
            Logger.shared.log(.search, .debug, "After tag filter: \(notes.count) notes")
        }

        // 2. 冲突筛选
        if selectedDestination == .conflicts {
            notes = notes.filter { $0.hasConflict }
            Logger.shared.log(.search, .debug, "After conflict filter: \(notes.count) notes")
        }

        // 3. 文件夹筛选
        // 如果有搜索词且选择搜索所有文件夹，则跳过文件夹筛选
        if case .noteFolder(let folderID) = selectedDestination, !(searchInAllFolders && !q.isEmpty) {
            notes = notes.filter { $0.folderID == folderID }
            Logger.shared.log(.search, .debug, "After folder filter: \(notes.count) notes")
        } else if selectedDestination == .unfiled {
            // 显示未分类（没有 folderID 或 folderID 指向不存在文件夹的笔记）
            let existingFolderIDs = Set(store.folders.map { $0.id })
            notes = notes.filter { note in
                guard let folderID = note.folderID else { return true }
                return !existingFolderIDs.contains(folderID)
            }
            Logger.shared.log(.search, .debug, "After uncategorized filter: \(notes.count) notes")
        } else if case .encryptedFolder(let encryptedFolderID) = selectedDestination {
            // 显示加密文件夹中的笔记
            notes = notes.filter { EncryptedFolderManager.shared.isEncrypted(note: $0) }
            notes = notes.filter {
                EncryptedFolderManager.shared.getEncryptedFolderID(for: $0) == encryptedFolderID
            }
            Logger.shared.log(.search, .debug, "After encrypted subfolder filter: \(notes.count) notes")
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

    private var filteredTodoItems: [TodoItem] {
        switch selectedDestination {
        case .todoToday:
            return store.todoItemsForToday()
        case .todoImportant:
            return store.importantTodoItems()
        case .todoList(let listID):
            return store.todoItems(in: listID)
        default:
            return []
        }
    }

    private var filteredTodoIDs: [UUID] {
        filteredTodoItems.map(\.id)
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
                selectedDestination: $selectedDestination,
                selection: $selection,
                isEncryptedFolderUnlocked: $isEncryptedFolderUnlocked,
                onCreateNote: createNote
            )
        } content: {
            if selectedDestination == .recycleBin {
                RecycleBinView(selection: $selection)
            } else if selectedDestination.isTodoDestination {
                TodoListView(
                    todos: filteredTodoItems,
                    selection: $selectedTodoID,
                    onCreateTodo: createTodo,
                    onToggleComplete: { id, completed in
                        store.setTodoCompleted(id: id, completed: completed)
                    },
                    onDeleteRequest: { id in
                        pendingDeleteTodoID = id
                        showingDeleteConfirm = true
                    }
                )
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
            if selectedDestination == .recycleBin {
                ContentUnavailableView("回收站", systemImage: "trash")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppColors.editorBackground(colorScheme))
            } else if selectedDestination.isTodoDestination {
                TodoDetailView(
                    todo: store.todoItems.first(where: { $0.id == selectedTodoID }),
                    lists: store.todoLists,
                    onOpenNote: { noteID in
                        if let note = store.activeNotes.first(where: { $0.id == noteID }) {
                            selectedDestination = destination(for: note)
                            updateSelection(noteID, reason: "todoLinkedNote")
                            selectedTodoID = nil
                        }
                    }
                )
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
                    if selectedDestination.isTodoDestination {
                        createTodo()
                    } else {
                        createNote()
                    }
                } label: {
                    Label(selectedDestination.isTodoDestination ? "新建任务" : l10n(L10nKeys.Note.new), systemImage: "plus")
                }

                Button {
                    if selectedDestination.isTodoDestination {
                        if let selectedTodoID {
                            pendingDeleteTodoID = selectedTodoID
                            showingDeleteConfirm = true
                        }
                    } else {
                        confirmDeleteSelectedNote()
                    }
                } label: {
                    Label(l10n(L10nKeys.common.delete), systemImage: "trash")
                }
                .disabled((selectedDestination.isTodoDestination ? selectedTodoID == nil : selection == nil) || selectedDestination == .recycleBin)
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

            if selectedDestination == .recycleBin {
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

            isEncryptedFolderUnlocked = false
            selectedDestination = destination(for: note)
            searchText = ""
            updateSelection(id, reason: "externalNavigation")
            store.selectedNoteId = nil
            store.selectedFolderForNavigation = nil
        }
        .onChange(of: store.selectedTodoId) { _, newValue in
            guard let id = newValue else { return }
            guard let todo = store.todoItems.first(where: { $0.id == id }) else {
                store.selectedTodoId = nil
                return
            }

            if let listID = todo.folderID {
                selectedDestination = .todoList(listID)
            } else if todo.isImportant {
                selectedDestination = .todoImportant
            } else {
                selectedDestination = .todoToday
            }
            selectedTodoID = id
            selection = nil
            searchText = ""
            store.selectedTodoId = nil
        }
        .onChange(of: store.selectedFolderForNavigation) { _, newValue in
            guard let folder = newValue else { return }
            searchText = ""
            selectedDestination = destination(forLegacyFolderName: folder)
            store.selectedFolderForNavigation = nil
        }
        .onChange(of: filteredNoteIDs) { _, currentIDs in
            guard selectedDestination != .recycleBin else { return }
            guard !selectedDestination.isTodoDestination else { return }
            // 如果冲突筛选下已无冲突笔记，自动退出冲突视图
            if selectedDestination == .conflicts && !store.activeNotes.contains(where: { $0.hasConflict }) {
                selectedDestination = .allNotes
            }
            let nextSelection = VisibleNoteSelectionCoordinator.selectionForVisibleNotes(
                currentSelection: selection,
                availableIDs: currentIDs
            )
            guard nextSelection != selection else { return }
            updateSelection(nextSelection, reason: "filterSync")
        }
        .onChange(of: filteredTodoIDs) { _, currentIDs in
            guard selectedDestination.isTodoDestination else { return }
            if let selectedTodoID, currentIDs.contains(selectedTodoID) {
                return
            }
            selectedTodoID = currentIDs.first
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
            AppSettings.shared.lastSelectedFolder = legacyFolderName(for: selectedDestination)
            AppSettings.shared.lastSelectedNoteID = selection
            DebugLog.app("Saved destination: \(String(describing: selectedDestination)), note: \(selection?.uuidString ?? "nil")", level: .debug)
        }
        .onReceive(NotificationCenter.default.publisher(for: .appShouldTerminate)) { _ in
            saveCurrentEditorContent(reason: "terminate")
            NoteSaveManager.shared.flushAllPending()
            // 保存当前选择的文件夹和笔记
            AppSettings.shared.lastSelectedFolder = legacyFolderName(for: selectedDestination)
            AppSettings.shared.lastSelectedNoteID = selection
            DebugLog.app("Saved destination: \(String(describing: selectedDestination)), note: \(selection?.uuidString ?? "nil")", level: .debug)
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
                        let nextSelection = selectedDestination == .recycleBin ? nil : filteredNotes.first?.id
                        if let nextSelection {
                            store.ensureNoteContentLoaded(id: nextSelection, rememberSelection: true)
                        }
                        selection = nextSelection
                    }
                }
                if let id = pendingDeleteTodoID {
                    store.deleteTodo(id: id)
                    if selectedTodoID == id {
                        selectedTodoID = filteredTodoItems.first?.id
                    }
                }
                pendingDeleteNoteID = nil
                pendingDeleteTodoID = nil
            }
            Button("取消", role: .cancel) {
                pendingDeleteNoteID = nil
                pendingDeleteTodoID = nil
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
            if selectedDestination != .recycleBin {
                if selectedDestination.isTodoDestination {
                    if let selectedTodoID {
                        pendingDeleteTodoID = selectedTodoID
                        showingDeleteConfirm = true
                    }
                } else {
                    confirmDeleteSelectedNote()
                }
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
        if case .encryptedFolder(let encryptedFolderID) = selectedDestination {
            // 在加密文件夹的子目录中创建加密笔记
            if let newNote = store.createEncryptedNote(in: encryptedFolderID) {
                updateSelection(newNote.id, reason: "createEncrypted")
            }
            return
        }
        
        let targetFolder: Folder?
        switch selectedDestination {
        case .noteFolder(let folderID):
            targetFolder = store.folders.first { $0.id == folderID }
        default:
            targetFolder = nil
        }
        let folderName = targetFolder?.name ?? l10n(L10nKeys.Folder.uncategorized)
        let folderID = targetFolder?.id
        if let newNote = store.addNote(title: l10n(L10nKeys.Note.new), folderID: folderID, folderName: folderName) {
            if case .tag(let tagID) = selectedDestination {
                store.addTagToNote(tagID: tagID, noteID: newNote.id)
            }
            updateSelection(newNote.id, reason: "create")
        }
    }

    private func createTodo() {
        let listID: UUID?
        if case .todoList(let id) = selectedDestination {
            listID = id
        } else {
            listID = nil
        }
        if let todo = store.addTodo(listID: listID) {
            if selectedDestination == .todoToday {
                store.updateTodo(
                    id: todo.id,
                    title: todo.title,
                    notesText: "",
                    dueAt: Date(),
                    reminderAt: nil,
                    recurrenceRule: "none",
                    isImportant: todo.isImportant,
                    listID: todo.folderID,
                    linkedNoteIDs: todo.linkedNoteIDs
                )
            } else if selectedDestination == .todoImportant {
                store.updateTodo(
                    id: todo.id,
                    title: todo.title,
                    notesText: "",
                    dueAt: todo.dueAt,
                    reminderAt: nil,
                    recurrenceRule: "none",
                    isImportant: true,
                    listID: todo.folderID,
                    linkedNoteIDs: todo.linkedNoteIDs
                )
            }
            selectedTodoID = todo.id
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
                    selectedDestination = destination(forLegacyFolderName: lastFolder)
                    DebugLog.app("Restored last selected folder: \(lastFolder)", level: .debug)
                } else {
                    // Fallback 到全部笔记
                    selectedDestination = .allNotes
                    DebugLog.app("Last folder '\(lastFolder)' not found, fallback to all notes", level: .debug)
                }
            } else {
                selectedDestination = .allNotes
                DebugLog.app("No last folder saved, defaulting to all notes", level: .debug)
            }

            // 恢复笔记选择
            if let lastID = AppSettings.shared.lastSelectedNoteID {
                // 检查笔记是否存在，并且在当前文件夹中
                if let note = store.activeNotes.first(where: { $0.id == lastID }) {
                    let noteInCurrentDestination = isNote(note, visibleIn: selectedDestination)

                    if noteInCurrentDestination {
                        updateSelection(lastID, reason: "launchRestore")
                        DebugLog.app("Restored last selected note: \(lastID)", level: .debug)
                    } else {
                        // 笔记不在当前文件夹中，选择当前文件夹的第一个笔记
                        updateSelection(selectedDestination == .recycleBin ? nil : filteredNotes.first?.id, reason: "launchFallback")
                        DebugLog.app("Last note not in current folder, selecting first note in folder", level: .debug)
                    }
                } else {
                    // 笔记不存在，选择当前文件夹的第一个笔记
                    updateSelection(selectedDestination == .recycleBin ? nil : filteredNotes.first?.id, reason: "launchMissingLastNote")
                    DebugLog.app("Last note not found, selecting first note in folder", level: .debug)
                }
            } else {
                updateSelection(selectedDestination == .recycleBin ? nil : filteredNotes.first?.id, reason: "launchNoLastNote")
                DebugLog.app("No last note saved, selecting first note", level: .debug)
            }

        case .selectNone:
            selectedDestination = .allNotes
            updateSelection(nil, reason: "launchSelectNone")
            DebugLog.app("Selecting none as per settings", level: .debug)

        case .showAllNotes:
            selectedDestination = .allNotes
            updateSelection(store.activeNotes.first?.id, reason: "launchShowAllNotes")
            DebugLog.app("Showing all notes", level: .debug)
        }
    }

    private func destination(for note: Note) -> SidebarDestination {
        if EncryptedFolderManager.shared.isEncrypted(note: note),
           let encryptedFolderID = EncryptedFolderManager.shared.getEncryptedFolderID(for: note) {
            return .encryptedFolder(encryptedFolderID)
        }
        if let folderID = note.folderID,
           store.folders.contains(where: { $0.id == folderID }) {
            return .noteFolder(folderID)
        }
        return .unfiled
    }

    private func destination(forLegacyFolderName folderName: String) -> SidebarDestination {
        if folderName == l10n(L10nKeys.Folder.allNotes) {
            return .allNotes
        }
        if folderName == l10n(L10nKeys.Folder.uncategorized) || folderName == "未分类" {
            return .unfiled
        }
        if folderName == EncryptedFolderView.folderName {
            return .allNotes
        }
        if let folder = store.folders.first(where: { $0.name == folderName }) {
            return .noteFolder(folder.id)
        }
        return .allNotes
    }

    private func legacyFolderName(for destination: SidebarDestination) -> String? {
        switch destination {
        case .allNotes, .conflicts, .recycleBin, .tag, .todoToday, .todoImportant, .todoList:
            return l10n(L10nKeys.Folder.allNotes)
        case .unfiled:
            return l10n(L10nKeys.Folder.uncategorized)
        case .noteFolder(let folderID):
            return store.folders.first(where: { $0.id == folderID })?.name ?? l10n(L10nKeys.Folder.allNotes)
        case .encryptedFolder:
            return EncryptedFolderView.folderName
        }
    }

    private func isNote(_ note: Note, visibleIn destination: SidebarDestination) -> Bool {
        switch destination {
        case .allNotes:
            return !EncryptedFolderManager.shared.isEncrypted(note: note)
        case .unfiled:
            let existingFolderIDs = Set(store.folders.map(\.id))
            guard !EncryptedFolderManager.shared.isEncrypted(note: note) else { return false }
            guard let folderID = note.folderID else { return true }
            return !existingFolderIDs.contains(folderID)
        case .conflicts:
            return note.hasConflict && !EncryptedFolderManager.shared.isEncrypted(note: note)
        case .recycleBin:
            return note.isInRecycleBin
        case .noteFolder(let folderID):
            return note.folderID == folderID && !EncryptedFolderManager.shared.isEncrypted(note: note)
        case .encryptedFolder(let encryptedFolderID):
            return EncryptedFolderManager.shared.getEncryptedFolderID(for: note) == encryptedFolderID
        case .tag(let tagID):
            return note.tagIDs.contains(tagID) && !EncryptedFolderManager.shared.isEncrypted(note: note)
        case .todoToday, .todoImportant, .todoList:
            return false
        }
    }
}

extension SidebarDestination {
    var isEncryptedFolder: Bool {
        if case .encryptedFolder = self {
            return true
        }
        return false
    }

    var isTodoDestination: Bool {
        switch self {
        case .todoToday, .todoImportant, .todoList:
            return true
        default:
            return false
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
