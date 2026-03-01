//
//  ContentView.swift
//  Reminder
//
//  Created by 闫延 on 2026/2/20.
//

import SwiftUI
import UniformTypeIdentifiers


struct ContentView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared

    @State private var selection: Note.ID? = nil

    // 与菜单栏 Popover 共享选中状态
    @State private var didSyncSelectionFromStore = false
    @State private var searchText: String = ""
    @State private var selectedFolder: String = l10n(L10nKeys.Folder.allNotes)
    @State private var selectedTagID: UUID?
    @StateObject private var richTextController = RichTextController()

    private var filteredNotes: [Note] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        var notes = store.notes

        // 1. 标签筛选
        if let tagID = selectedTagID {
            notes = notes.filter { $0.tagIDs.contains(tagID) }
        }

        // 2. 文件夹筛选
        if selectedFolder != l10n(L10nKeys.Folder.allNotes) {
            notes = notes.filter { $0.folder == selectedFolder }
        }

        // 3. 搜索词筛选
        if !q.isEmpty {
            notes = notes.filter {
                $0.title.localizedCaseInsensitiveContains(q) ||
                $0.content.string.localizedCaseInsensitiveContains(q)
            }
        }

        return notes
    }

    /// 保存指定笔记的内容
    private func saveNoteContent(noteID: UUID, content: NSAttributedString, reason: String) {
        guard let index = store.notes.firstIndex(where: { $0.id == noteID }) else { return }
        
        let note = store.notes[index]
        let preview = String(content.string.prefix(30)).replacingOccurrences(of: "\n", with: "\\n")
        print("[SAVE] '\(note.title)' [\(reason)]: '\(preview)' (\(content.length))")
        
        guard let request = NoteSaveManager.shared.createRequest(
            noteID: noteID,
            title: note.title,
            folder: note.folder,
            reminderAt: note.reminderAt,
            recurrenceRule: note.recurrenceRule,
            content: content,
            reason: reason
        ) else { return }
        
        _ = NoteSaveManager.shared.saveImmediately(request: request)
    }
    
    /// 保存当前编辑器中的笔记（用于 appBlur/terminate）
    private func saveCurrentEditorContent(reason: String) {
        // 安全机制：检查 boundNoteID 和 selection 是否一致
        let boundIDStr = richTextController.boundNoteID?.uuidString.prefix(8) ?? "nil"
        let selIDStr = selection?.uuidString.prefix(8) ?? "nil"
        
        print("[SAVE DEBUG] reason=\(reason), boundNoteID=\(boundIDStr), selection=\(selIDStr)")
        
        let targetNoteID: UUID
        if let boundID = richTextController.boundNoteID,
           let selID = selection,
           boundID == selID {
            targetNoteID = boundID
        } else if let selID = selection {
            print("[SAVE WARNING] boundNoteID and selection mismatch, using selection: \(selID)")
            targetNoteID = selID
        } else if let boundID = richTextController.boundNoteID {
            targetNoteID = boundID
        } else {
            print("[SAVE ERROR] No target note ID available")
            return
        }
        
        // 从编辑器获取内容
        guard let editorContent = richTextController.snapshotAttributedString() else {
            print("[SAVE DEBUG] Editor content is nil, skipping save")
            return
        }
        print("[SAVE DEBUG] Editor content length: \(editorContent.length)")
        
        // 执行保存
        saveNoteContent(noteID: targetNoteID, content: editorContent, reason: reason)
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(selectedFolder: $selectedFolder, selectedTagID: $selectedTagID, selection: $selection, onCreateNote: createNote)
        } content: {
            NotesListView(notes: filteredNotes, selection: Binding(
                get: { selection },
                set: { newSelection in
                    // 关键：在变更 selection 前，先保存当前笔记
                    // 使用 selection（旧笔记ID）而不是 boundNoteID，因为 boundNoteID 可能已经被更新
                    if let oldNoteID = selection, oldNoteID != newSelection {
                        // 取消该笔记的待处理自动保存
                        NoteSaveManager.shared.cancelPendingSave(for: oldNoteID)
                        
                        // 如果编辑器绑定着旧笔记，从编辑器获取内容
                        // 否则使用内存中的内容
                        let contentToSave: NSAttributedString
                        if richTextController.isBoundTo(noteID: oldNoteID),
                           let editorContent = richTextController.snapshotAttributedString() {
                            // 成功从编辑器获取内容
                            contentToSave = editorContent
                            // 同步更新内存
                            if let oldIndex = store.notes.firstIndex(where: { $0.id == oldNoteID }) {
                                store.notes[oldIndex].content = contentToSave
                            }
                        } else {
                            // 编辑器不可用或不绑定旧笔记，使用内存中的内容
                            if let oldIndex = store.notes.firstIndex(where: { $0.id == oldNoteID }) {
                                contentToSave = store.notes[oldIndex].content
                            } else {
                                print("[SAVE WARNING] Cannot find old note in memory, skipping save")
                                selection = newSelection
                                AppSettings.shared.lastSelectedNoteID = newSelection
                                return
                            }
                        }
                        
                        // 执行保存
                        saveNoteContent(noteID: oldNoteID, content: contentToSave, reason: "switch")
                    }
                    
                    // 更新 selection
                    selection = newSelection
                    // 保存最后选中的笔记
                    AppSettings.shared.lastSelectedNoteID = newSelection
                }
            ))
        } detail: {
            if let currentId = selection, let index = store.notes.firstIndex(where: { $0.id == currentId }) {
                let noteBinding = $store.notes[index]
                NoteEditorView(
                    note: noteBinding,
                    controller: richTextController,
                    searchText: $searchText
                )
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
                    deleteSelectedNote()
                } label: {
                    Label(l10n(L10nKeys.common.delete), systemImage: "trash")
                }
                .disabled(selection == nil)
            }
        }
        .toolbarBackground(.hidden, for: .windowToolbar)
        .searchable(text: $searchText, placement: .toolbar, prompt: l10n(L10nKeys.Note.searchPlaceholder))
        .onAppear {
            if !didSyncSelectionFromStore, let pending = store.selectedNoteId {
                selection = pending
                didSyncSelectionFromStore = true
            }
            if selection == nil {
                selection = store.notes.first?.id
            }
            store.fetchData()

            // 启动定期自动保存（每30秒）
            richTextController.startAutoSave(interval: 30.0) { [weak store] in
                guard let store = store else { return }
                if let currentId = selection,
                   let index = store.notes.firstIndex(where: { $0.id == currentId }),
                   richTextController.isBoundTo(noteID: currentId) {
                    let content = richTextController.snapshotAttributedStringPreservingMarkedText()
                        ?? store.notes[index].content
                    saveNoteContent(noteID: currentId, content: content, reason: "auto")
                    richTextController.markAsSaved()
                }
            }
        }
        .onChange(of: store.selectedNoteId) { _, newValue in
            guard let id = newValue else { return }
            selection = id
        }
        .onChange(of: store.selectedFolderForNavigation) { _, newValue in
            guard let folder = newValue else { return }
            selectedFolder = folder
            store.selectedFolderForNavigation = nil
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
        }
        .onReceive(NotificationCenter.default.publisher(for: .appShouldTerminate)) { _ in
            saveCurrentEditorContent(reason: "terminate")
            NoteSaveManager.shared.flushAllPending()
        }
    }

    private func createNote() {
        store.addNote(title: l10n(L10nKeys.Note.new), folder: selectedFolder == l10n(L10nKeys.Folder.allNotes) ? l10n(L10nKeys.Folder.uncategorized) : selectedFolder)
        selection = store.notes.first?.id
    }

    private func deleteSelectedNote() {
        guard let id = selection else { return }
        store.deleteNote(id: id)
        selection = filteredNotes.first?.id
    }

    /// 启动时恢复选中的笔记
    private func restoreSelectionOnLaunch() async {
        // 等待数据加载完成
        while store.notes.isEmpty {
            try? await Task.sleep(for: .milliseconds(100))
        }

        let behavior = AppSettings.shared.startupBehavior

        switch behavior {
        case .restoreLastNote:
            if let lastID = AppSettings.shared.lastSelectedNoteID,
               store.notes.contains(where: { $0.id == lastID }) {
                selection = lastID
                print("[Launch] Restored last selected note: \(lastID)")
            } else {
                selection = nil
                print("[Launch] Last note not found, selecting none")
            }

        case .selectNone:
            selection = nil
            print("[Launch] Selecting none as per settings")

        case .showAllNotes:
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            selectedTagID = nil
            selection = store.notes.first?.id
            print("[Launch] Showing all notes")
        }
    }
}

private struct SidebarView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared

    @Binding var selectedFolder: String
    @Binding var selectedTagID: UUID?
    @Binding var selection: Note.ID?
    let onCreateNote: () -> Void

    @State private var showingFolderManagement = false
    @State private var showingTagManagement = false
    @State private var isFoldersExpanded: Bool = AppSettings.shared.isFoldersExpanded
    @State private var isTagsExpanded: Bool = AppSettings.shared.isTagsExpanded

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                // 主内容区域：全部笔记 + 文件夹（可滚动）
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        allNotesRow
                        foldersSection
                    }
                }
                .frame(maxHeight: .infinity)

                // 动态布局：根据展开状态决定标签位置
                if isTagsExpanded {
                    // 标签展开时：显示在内容下方，标签本身也可滚动
                    Divider()
                        .padding(.vertical, 8)
                    
                    // 标签展开时占用剩余空间并可以滚动
                    ScrollView {
                        tagsSection
                    }
                    .frame(maxHeight: .infinity)
                } else {
                    // 标签折叠时：固定在底部，但留出一些空间避免显示不全
                    Spacer(minLength: 20)
                    
                    Divider()
                        .padding(.vertical, 8)
                    
                    tagsSection
                    
                    // 底部留出一些内边距
                    Spacer(minLength: 8)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
        }
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
        HStack {
            Image(systemName: "tray.fill")
                .foregroundStyle(selectedFolder == l10n(L10nKeys.Folder.allNotes) && selectedTagID == nil ? .white : .orange)
            Text(l10n(L10nKeys.Folder.allNotes))
            Spacer()
            Text("\(store.notes.count)")
                .font(.caption)
                .foregroundStyle(selectedFolder == l10n(L10nKeys.Folder.allNotes) && selectedTagID == nil ? .white.opacity(0.7) : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(selectedFolder == l10n(L10nKeys.Folder.allNotes) && selectedTagID == nil ? themeManager.accentColor : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
            selectedTagID = nil
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
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
                ForEach(store.tags) { tag in
                    tagRow(tag)
                }
            }
        }
    }

    private func tagRow(_ tag: Tag) -> some View {
        let notesWithTag = store.notes.filter { $0.tagIDs.contains(tag.id) }
        return HStack {
            Circle()
                .fill(tag.swiftUIColor)
                .frame(width: 8, height: 8)
            Text(tag.name)
                .lineLimit(1)
            Spacer()
            Text("\(notesWithTag.count)")
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
               let selectedNote = store.notes.first(where: { $0.id == currentSelection }),
               !selectedNote.tagIDs.contains(tag.id) {
                // 当前笔记没有新标签，清空选中状态（延迟到下一个runloop避免 Publishing changes 警告）
                DispatchQueue.main.async {
                    selection = nil
                    AppSettings.shared.lastSelectedNoteID = nil
                }
            }
            selectedTagID = tag.id
            selectedFolder = l10n(L10nKeys.Folder.allNotes)
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
            Text("\(store.notes.filter { $0.folder == folder.name }.count)")
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
               let selectedNote = store.notes.first(where: { $0.id == currentSelection }),
               selectedNote.folder != folder.name {
                // 当前笔记不在新文件夹中，清空选中状态（延迟到下一个runloop避免 Publishing changes 警告）
                DispatchQueue.main.async {
                    selection = nil
                    AppSettings.shared.lastSelectedNoteID = nil
                }
            }
            selectedFolder = folder.name
            selectedTagID = nil
        }
        .padding(.horizontal, 8)
    }
}

private struct NotesListView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme

    let notes: [Note]
    @Binding var selection: Note.ID?

    var body: some View {
        List(selection: $selection) {
            Section(l10n(L10nKeys.common.notes)) {
                ForEach(notes) { note in
                    NoteRowView(note: note, isSelected: selection == note.id)
                        .tag(note.id)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            selection = note.id
                        }
                        .contextMenu {
                            Button(l10n(L10nKeys.common.delete)) {
                                store.deleteNote(id: note.id)
                            }
                        }
                }
            }
        }
        .listStyle(.plain)
        .frame(minWidth: 220, maxWidth: 280)
        .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
    }
}

private struct NoteRowView: View {
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
                if note.hasReminder {
                    Image(systemName: "bell.fill")
                        .font(.caption2)
                        .foregroundStyle(isSelected ? .white.opacity(0.8) : .orange)
                }
            }
            Text(preview(from: note.content))
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

    private func preview(from attributed: NSAttributedString) -> String {
        let str = attributed.string
        let trimmed = str.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.components(separatedBy: .newlines)
        return lines.prefix(2).joined(separator: " ")
    }
}

private struct NoteEditorView: View {
    @Environment(\.colorScheme) private var colorScheme

    @Binding var note: Note
    @ObservedObject var controller: RichTextController
    @EnvironmentObject private var store: NoteStore
    @Binding var searchText: String
    
    @StateObject private var recorder = AudioRecorderManager()
    @State private var showingReminderPopover = false
    
    @State private var lastSavedTitle: String = ""
    @State private var lastSavedContentHash: Int = 0
    @State private var pendingSaveWorkItem: DispatchWorkItem?
    
    // AI 侧边窗口状态
    @State private var isAIPanelExpanded: Bool = false
    @State private var aiPanelWidth: CGFloat = 320

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                // 主编辑器区域
                VStack(spacing: 0) {
                    EditorTopBarView(
                        controller: controller,
                        recorder: recorder,
                        note: $note,
                        showingReminderPopover: $showingReminderPopover,
                        searchText: $searchText,
                        isAIPanelExpanded: $isAIPanelExpanded
                    )

                    VStack(alignment: .leading, spacing: 0) {
                        TextField(l10n(L10nKeys.Note.titlePlaceholder), text: $note.title)
                            .font(.title2)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 16)
                            .padding(.top, 14)
                            .padding(.bottom, 10)
                            .onChange(of: note.title) { _, newTitle in
                                debouncedScheduleAutoSave(title: newTitle, content: note.content)
                            }

                        Divider()
                            .padding(.horizontal, 16)

                        RichTextEditor(
                            attributedText: $note.content,
                            controller: controller,
                            noteID: note.id
                        )
                        .id(note.id)  // 强制在 note.id 变化时重新创建视图
                        .layoutPriority(1)
                        .onChange(of: note.content) { _, newContent in
                            debouncedScheduleAutoSave(title: note.title, content: newContent)
                        }
                    }
                }
                .frame(width: isAIPanelExpanded ? geometry.size.width - aiPanelWidth : geometry.size.width, height: geometry.size.height)
                .background(AppColors.editorBackground(colorScheme))
                
                // AI 侧边窗口
                if isAIPanelExpanded {
                    AIPanelView(isExpanded: $isAIPanelExpanded, panelWidth: $aiPanelWidth)
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
        }
        .onDisappear {
            pendingSaveWorkItem?.cancel()
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
            print("[AutoSave] Skipping save due to marked text (IME editing)")
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
    @Binding var note: Note
    @Binding var showingReminderPopover: Bool
    @Binding var searchText: String
    @Binding var isAIPanelExpanded: Bool

    @State private var tempReminderAt: Date = Date()
    @State private var tempRecurrence: String = "none"

    var recurrenceOptions: [(String, String)] {
        [
            (l10n(L10nKeys.Note.noRecurrence), "none"),
            (l10n(L10nKeys.Note.daily), "daily"),
            (l10n(L10nKeys.Note.weekly), "weekly"),
            (l10n(L10nKeys.Note.monthly), "monthly")
        ]
    }

    var body: some View {
        HStack(spacing: 10) {
            Button { controller.toggleBold() } label: { Text("B").fontWeight(.bold) }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(minWidth: 20)
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
            } label: {
                Image(systemName: "textformat")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(minWidth: 20)

            Divider().frame(height: 18)

            // 列表菜单（合并所有列表类型）
            Menu {
                Button {
                    controller.toggleBullets()
                } label: {
                    Label(l10n(L10nKeys.Editor.bulletList), systemImage: "list.bullet")
                }
                Button {
                    controller.toggleDashList()
                } label: {
                    Label(l10n(L10nKeys.Editor.dashList), systemImage: "list.dash")
                }
                Button {
                    controller.toggleNumberedList()
                } label: {
                    Label(l10n(L10nKeys.Editor.numberedList), systemImage: "list.number")
                }
                Divider()
                Button {
                    controller.toggleCheckbox()
                } label: {
                    Label(l10n(L10nKeys.Editor.checkbox), systemImage: "checkmark.circle")
                }
            } label: {
                Image(systemName: "list.bullet")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(minWidth: 20)

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
                        }
                        .disabled(!note.hasReminder)
                        Button(l10n(L10nKeys.common.save)) {
                            note.reminderAt = tempReminderAt
                            note.recurrenceRule = tempRecurrence
                            showingReminderPopover = false
                        }
                    }
                }
                .padding()
                .frame(width: 320)
            }

            Spacer()

            // 搜索
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(l10n(L10nKeys.Editor.search), text: $searchText)
                    .textFieldStyle(.plain)
                    .frame(width: 140)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            
            Divider().frame(height: 18)
            
            // AI 助手按钮（使用与侧边栏类似的图标）
            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    isAIPanelExpanded.toggle()
                }
            } label: {
                Image(systemName: isAIPanelExpanded ? "sidebar.right" : "sidebar.right")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(isAIPanelExpanded ? ThemeManager.shared.accentColor : .secondary)
            }
            .buttonStyle(.plain)
            .help("AI 助手")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppColors.editorBackground(colorScheme))
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
                if !note.tagIDs.isEmpty {
                    Text("\(note.tagIDs.count)")
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
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 输入区域
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    // AI 服务选择按钮
                    AIServiceSelectorButton()
                    
                    TextField("输入消息...", text: $inputText, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...5)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    
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
                
                HStack {
                    Spacer()
                    Text("\(messages.count) 条消息")
                        .font(.caption2)
                        .foregroundStyle(.secondary.opacity(0.6))
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
        
        let userMessage = AIMessage(content: trimmedText, isUser: true)
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
        let messageDTOs = messages.dropLast().map { AIMessageDTO(content: $0.content, isUser: $0.isUser) }
        
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

// MARK: - 消息气泡组件

private struct MessageBubble: View {
    let message: AIMessage
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var themeManager = ThemeManager.shared
    
    var body: some View {
        HStack {
            if message.isUser {
                Spacer()
            }
            
            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                Text(message.content)
                    .font(.system(size: 13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        message.isUser
                            ? themeManager.accentColor
                            : (colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.05))
                    )
                    .foregroundStyle(message.isUser ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                
                Text(message.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.secondary.opacity(0.6))
            }
            .frame(maxWidth: 260, alignment: message.isUser ? .trailing : .leading)
            
            if !message.isUser {
                Spacer()
            }
        }
    }
}
