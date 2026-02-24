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

    @State private var selection: Note.ID?

    // 与菜单栏 Popover 共享选中状态
    @State private var didSyncSelectionFromStore = false
    @State private var searchText: String = ""
    @State private var selectedFolder: String = "全部笔记"
    @StateObject private var richTextController = RichTextController()

    private var filteredNotes: [Note] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        var notes = store.notes
        
        // 1. 文件夹筛选
        if selectedFolder != "全部笔记" {
            notes = notes.filter { $0.folder == selectedFolder }
        }
        
        // 2. 搜索词筛选
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
        let editorContent = richTextController.snapshotAttributedString()
        print("[SAVE DEBUG] Editor content length: \(editorContent.length)")
        
        // 执行保存
        saveNoteContent(noteID: targetNoteID, content: editorContent, reason: reason)
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(selectedFolder: $selectedFolder, onCreateNote: createNote)
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
                        if richTextController.isBoundTo(noteID: oldNoteID) {
                            contentToSave = richTextController.snapshotAttributedString()
                            // 同步更新内存
                            if let oldIndex = store.notes.firstIndex(where: { $0.id == oldNoteID }) {
                                store.notes[oldIndex].content = contentToSave
                            }
                        } else {
                            // 编辑器已经不绑定旧笔记，使用内存中的内容
                            if let oldIndex = store.notes.firstIndex(where: { $0.id == oldNoteID }) {
                                contentToSave = store.notes[oldIndex].content
                            } else {
                                contentToSave = NSAttributedString(string: "")
                            }
                        }
                        
                        // 执行保存
                        saveNoteContent(noteID: oldNoteID, content: contentToSave, reason: "switch")
                    }
                    
                    // 更新 selection
                    selection = newSelection
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
                ContentUnavailableView("未选择笔记", systemImage: "note")
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
                    Label("新建", systemImage: "plus")
                }

                Button {
                    deleteSelectedNote()
                } label: {
                    Label("删除", systemImage: "trash")
                }
                .disabled(selection == nil)
            }
        }
        .toolbarBackground(.hidden, for: .windowToolbar)
        .searchable(text: $searchText, placement: .toolbar, prompt: "搜索笔记")
        .onAppear {
            if !didSyncSelectionFromStore, let pending = store.selectedNoteId {
                selection = pending
                didSyncSelectionFromStore = true
            }
            if selection == nil {
                selection = store.notes.first?.id
            }
            store.fetchData()
        }
        .onChange(of: store.selectedNoteId) { _, newValue in
            guard let id = newValue else { return }
            selection = id
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            store.fetchData()
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
        store.addNote(title: "新建笔记", folder: selectedFolder == "全部笔记" ? "未分类" : selectedFolder)
        selection = store.notes.first?.id
    }

    private func deleteSelectedNote() {
        guard let id = selection else { return }
        store.deleteNote(id: id)
        selection = filteredNotes.first?.id
    }
}

private struct SidebarView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme

    @Binding var selectedFolder: String
    let onCreateNote: () -> Void

    @State private var showingAddFolderAlert = false
    @State private var newFolderName = ""

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Circle()
                        .fill(colorScheme == .dark ? .white.opacity(0.12) : .black.opacity(0.06))
                        .frame(width: 44, height: 44)
                        .overlay {
                            Image(systemName: "person.fill")
                                .foregroundStyle(.secondary)
                        }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Yan")
                            .font(.headline)
                        Text("本地模式")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                
                Button {
                    onCreateNote()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus")
                        Text("新建笔记")
                            .fontWeight(.medium)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 10)

            Divider()

            List(selection: $selectedFolder) {
                Section("文件夹") {
                    ForEach(store.folders, id: \.self) { folder in
                        HStack {
                            Image(systemName: folder == "全部笔记" ? "tray.fill" : "folder.fill")
                                .foregroundStyle(folder == selectedFolder ? .white : .orange)
                            Text(folder)
                            Spacer()
                            if folder != "全部笔记" {
                                Text("\(store.notes.filter { $0.folder == folder }.count)")
                                    .font(.caption)
                                    .foregroundStyle(folder == selectedFolder ? .white.opacity(0.7) : .secondary)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            selectedFolder = folder
                        }
                        .tag(folder)
                    }
                }
            }
            .listStyle(.plain)
            .frame(minWidth: 180, maxWidth: 220)
            .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
        }
    }
}

private struct NotesListView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme

    let notes: [Note]
    @Binding var selection: Note.ID?

    var body: some View {
        List(selection: $selection) {
            Section("笔记") {
                ForEach(notes) { note in
                    NoteRowView(note: note, isSelected: selection == note.id)
                        .tag(note.id)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            selection = note.id
                        }
                        .contextMenu {
                            Button("删除") {
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

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(note.title.isEmpty ? "无标题" : note.title)
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
        .background(isSelected ? Color.blue : Color.clear)
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

    var body: some View {
        VStack(spacing: 0) {
            EditorTopBarView(
                controller: controller,
                recorder: recorder,
                note: $note,
                showingReminderPopover: $showingReminderPopover,
                searchText: $searchText
            )

            VStack(alignment: .leading, spacing: 0) {
                TextField("标题", text: $note.title)
                    .font(.title2)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 10)
                    .onChange(of: note.title) { _, newTitle in
                        debouncedScheduleAutoSave(title: newTitle, content: note.content)
                    }

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
                Button("保存") {
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

    @State private var tempReminderAt: Date = Date()
    @State private var tempRecurrence: String = "none"

    let recurrenceOptions = [
        ("不重复", "none"),
        ("每天", "daily"),
        ("每周", "weekly"),
        ("每月", "monthly")
    ]

    var body: some View {
        HStack(spacing: 10) {
            Button { } label: { Image(systemName: "arrow.uturn.left") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            Button { } label: { Image(systemName: "arrow.uturn.right") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)

            Divider().frame(height: 18)

            Button { controller.toggleBold() } label: { Text("B").fontWeight(.bold) }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            Button { controller.toggleItalic() } label: { Text("I").italic() }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            Button { controller.toggleUnderline() } label: { Text("U").underline() }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)

            Menu {
                Button("H1") { controller.setHeading(level: 1) }
                Button("H2") { controller.setHeading(level: 2) }
                Button("H3") { controller.setHeading(level: 3) }
            } label: {
                Image(systemName: "textformat.size")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)

            Divider().frame(height: 18)

            // 文件夹选择
            Menu {
                ForEach(store.folders.filter { $0 != "全部笔记" }, id: \.self) { folder in
                    Button(folder) {
                        note.folder = folder
                    }
                }
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)

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
            .popover(isPresented: $showingReminderPopover, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("设置提醒")
                        .font(.headline)
                    DatePicker("提醒时间", selection: $tempReminderAt)
                    Picker("重复", selection: $tempRecurrence) {
                        ForEach(recurrenceOptions, id: \.1) { name, value in
                            Text(name).tag(value)
                        }
                    }
                    HStack {
                        Button("取消") {
                            showingReminderPopover = false
                        }
                        Spacer()
                        Button("清除") {
                            note.reminderAt = nil
                            note.recurrenceRule = "none"
                            showingReminderPopover = false
                        }
                        .disabled(!note.hasReminder)
                        Button("保存") {
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
                TextField("搜索", text: $searchText)
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
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppColors.editorBackground(colorScheme))
    }
}
