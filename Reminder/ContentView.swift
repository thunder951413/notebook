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

    private func saveNow() {
        // 关键：保存前强制同步富文本编辑器的内容
        richTextController.forceSync()
        
        if let id = selection, let index = store.notes.firstIndex(where: { $0.id == id }) {
            store.updateNote(store.notes[index])
        }
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(selectedFolder: $selectedFolder, onCreateNote: createNote)
        } content: {
            NotesListView(notes: filteredNotes, selection: $selection)
        } detail: {
            if let currentId = selection, let index = store.notes.firstIndex(where: { $0.id == currentId }) {
                let noteBinding = $store.notes[index]
                NoteEditorView(note: noteBinding, controller: richTextController, searchText: $searchText)
                    .onAppear {
                        richTextController.currentNoteID = currentId
                    }
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
            // 优先使用来自菜单栏 Popover 的选中
            if !didSyncSelectionFromStore, let pending = store.selectedNoteId {
                selection = pending
                didSyncSelectionFromStore = true
            }

            if selection == nil {
                selection = store.notes.first?.id
            }
            store.fetchData() // 启动时刷新数据以触发清理过期提醒
        }
        .onChange(of: store.selectedNoteId) { _, newValue in
            guard let id = newValue else { return }
            selection = id
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            store.fetchData() // 每次切回 App 时刷新以自动清除已过期的一次性提醒
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            print("[AppBlur] App lost focus, forcing save")
            saveNow()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            print("[ExitSave] App will terminate, forcing save")
            saveNow()
        }
        .onChange(of: selection) { oldSelection, newSelection in
            // 关键：切换笔记前，强制保存旧笔记
            if let oldId = oldSelection, let index = store.notes.firstIndex(where: { $0.id == oldId }) {
                print("[Selection] switching away from \(oldId), forcing save")
                store.updateNote(store.notes[index])
            }
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    print("[ManualSave] Cmd+S triggered")
                    saveNow()
                }
                .keyboardShortcut("s", modifiers: .command)
                .help("手动保存 (Cmd+S)")
            }
        }
    }

    private func createNote() {
        store.addNote(title: "新建笔记", folder: selectedFolder == "全部笔记" ? "未分类" : selectedFolder)
        selection = store.notes.first?.id
    }

    private func deleteSelectedNote() {
        guard let id = selection else { return }
        store.deleteNote(id: id)
        // 删除后选中当前列表的一条新笔记（如果存在）
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
                            .foregroundStyle(AppColors.textSecondary(colorScheme))
                    }
                }

                Button {
                    onCreateNote()
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus")
                        Text("新建笔记")
                            .fontWeight(.semibold)
                        Spacer()
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 12)
                    .background(AppColors.accentYellow)
                    .foregroundStyle(.black)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 6) {
                    Text("文件夹")
                        .font(.caption)
                        .foregroundStyle(AppColors.textSecondary(colorScheme))
                        .padding(.leading, 4)
                        .padding(.bottom, 4)

                    // “全部笔记” 入口
                    FolderItemButton(
                        name: "全部笔记",
                        icon: "tray.full.fill",
                        count: store.notes.count,
                        isSelected: selectedFolder == "全部笔记",
                        action: { selectedFolder = "全部笔记" }
                    )

                    ScrollView {
                        VStack(spacing: 4) {
                            ForEach(store.folders, id: \.self) { folder in
                                FolderItemButton(
                                    name: folder,
                                    icon: "folder.fill",
                                    count: store.notes.filter { $0.folder == folder }.count,
                                    isSelected: selectedFolder == folder,
                                    action: { selectedFolder = folder }
                                )
                                .onDrop(of: [.plainText], isTargeted: nil) { providers in
                                    guard let provider = providers.first else { return false }
                                    _ = provider.loadObject(ofClass: String.self) { string, _ in
                                        if let noteIDString = string, let noteID = UUID(uuidString: noteIDString) {
                                            DispatchQueue.main.async {
                                                store.moveNote(id: noteID, toFolder: folder)
                                            }
                                        }
                                    }
                                    return true
                                }
                            }
                        }
                    }
                }
            }
            .padding(16)

            Spacer()
            
            Divider()
                .padding(.horizontal, 16)
            
            Button {
                showingAddFolderAlert = true
            } label: {
                HStack {
                    Image(systemName: "folder.badge.plus")
                    Text("新建文件夹")
                    Spacer()
                }
                .padding(16)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.textSecondary(colorScheme))
            .alert("新建文件夹", isPresented: $showingAddFolderAlert) {
                TextField("文件夹名称", text: $newFolderName)
                Button("取消", role: .cancel) { newFolderName = "" }
                Button("创建") {
                    if !newFolderName.trimmingCharacters(in: .whitespaces).isEmpty {
                        store.addFolder(name: newFolderName)
                        newFolderName = ""
                    }
                }
            }
        }
        .frame(minWidth: 240)
        .background(AppColors.sidebarBackground(colorScheme))
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(AppColors.divider(colorScheme))
                .frame(width: 1)
        }
    }
}

private struct FolderItemButton: View {
    @Environment(\.colorScheme) private var colorScheme
    let name: String
    let icon: String
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .foregroundStyle(isSelected ? AppColors.accentYellow : AppColors.textSecondary(colorScheme))
                Text(name)
                    .lineLimit(1)
                    .foregroundStyle(isSelected ? .primary : AppColors.textSecondary(colorScheme))
                Spacer()
                Text("\(count)")
                    .foregroundStyle(AppColors.textSecondary(colorScheme))
                    .font(.caption)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(isSelected ? AppColors.selectedFill(colorScheme) : Color.clear)
            .contentShape(Rectangle()) // 确保整个区域可点击
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct NotesListView: View {
    @Environment(\.colorScheme) private var colorScheme

    let notes: [Note]
    @Binding var selection: Note.ID?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(notes) { note in
                    NoteCardView(note: note, isSelected: selection == note.id)
                        .onTapGesture { selection = note.id }
                }
            }
            .padding(16)
        }
        .background(AppColors.listBackground(colorScheme))
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(AppColors.divider(colorScheme))
                .frame(width: 1)
        }
    }
}

private struct NoteCardView: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: NoteStore

    let note: Note
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(note.title)
                .font(.headline)

            Text(note.content.string)
                .font(.subheadline)
                .foregroundStyle(AppColors.textSecondary(colorScheme))
                .lineLimit(2)

            HStack {
                Text(note.folder)
                    .font(.caption)
                    .foregroundStyle(AppColors.textSecondary(colorScheme))
                Spacer()
                Text(note.createdAt.formatted(date: .omitted, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(AppColors.textSecondary(colorScheme))
            }
        }
        .padding(12)
        .background(isSelected ? AppColors.selectedFill(colorScheme) : AppColors.cardBackground(colorScheme))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppColors.cardBorder(colorScheme, isSelected: isSelected), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: AppColors.shadowColor(colorScheme), radius: colorScheme == .dark ? 0 : 8, y: 2)
        .contextMenu {
            Menu("移动到文件夹") {
                Button("未分类") { store.moveNote(id: note.id, toFolder: "未分类") }
                ForEach(store.folders.filter { $0 != "未分类" }, id: \.self) { folder in
                    Button(folder) {
                        store.moveNote(id: note.id, toFolder: folder)
                    }
                }
            }
            Divider()
            Button(role: .destructive) {
                store.deleteNote(id: note.id)
            } label: {
                Label("删除笔记", systemImage: "trash")
            }
        }
        .onDrag {
            NSItemProvider(object: note.id.uuidString as NSString)
        }
    }
}

private struct NoteEditorView: View {
    @Environment(\.colorScheme) private var colorScheme

    @Binding var note: Note
    @ObservedObject var controller: RichTextController
    @EnvironmentObject private var store: NoteStore
    @Binding var searchText: String
    
    @State private var autoSaveTimer: Timer?
    @StateObject private var recorder = AudioRecorderManager()
    @State private var showingReminderPopover = false

    var body: some View {
        VStack(spacing: 0) {
            EditorTopBarView(
                controller: controller,
                recorder: recorder,
                note: $note,
                showingReminderPopover: $showingReminderPopover,
                searchText: $searchText
            )

            VStack(alignment: .leading, spacing: 0) { // 去掉 spacing
                TextField("标题", text: $note.title)
                    .font(.title2)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 10)
                    .onChange(of: note.title) { scheduleAutoSave() }

                RichTextEditor(attributedText: $note.content, controller: controller, noteID: note.id)
                    .layoutPriority(1) // 赋予最高优先级，占据剩余空间
                    .onChange(of: note.content) { _, _ in scheduleAutoSave() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity) // 确保容器占满
        .background(AppColors.editorBackground(colorScheme))
        .onDisappear { saveNow() }
        .toolbar {
            ToolbarItemGroup {
                // 隐藏按钮，专门用于响应 Cmd+S 快捷键
                Button("保存") {
                    print("[ManualSave] Cmd+S triggered")
                    saveNow()
                }
                .keyboardShortcut("s", modifiers: .command)
                .buttonStyle(.plain)
                .labelStyle(.iconOnly)
                .frame(width: 0, height: 0)
                .opacity(0)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            print("[ExitSave] App will terminate, forcing save")
            saveNow()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            print("[AppBlur] App lost focus, forcing save")
            saveNow()
        }
    }

    private func scheduleAutoSave() {
        autoSaveTimer?.invalidate()
        let id = note.id
        let title = note.title
        let snippet = note.content.string.prefix(30)
        print("[AutoSave] schedule for note id=\(id), title=\(title), snippet=\(snippet)")
        
        autoSaveTimer = Timer.scheduled(after: 0.8) { _ in
            print("[AutoSave] fire for note id=\(id)")
            saveNow()
        }
    }

    private func saveNow() {
        // 关键：保存前强制同步富文本编辑器的内容
        controller.forceSync()
        
        print("[SaveNow] calling store.updateNote for id=\(note.id), title=\(note.title)")
        store.updateNote(note)
    }
}

extension Timer {
    static func scheduled(after delay: TimeInterval, block: @escaping (Timer) -> Void) -> Timer {
        Timer.scheduledTimer(withTimeInterval: delay, repeats: false, block: block)
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
            .menuStyle(.borderlessButton)

            Button { controller.toggleBullets() } label: { Image(systemName: "list.bullet") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            Button { controller.toggleNumberedList() } label: { Image(systemName: "list.number") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)

            Button { controller.insertCheckbox() } label: { Image(systemName: "checklist") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)

            Button { controller.insertImage() } label: { Image(systemName: "photo") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)

            Button {
                if recorder.isRecording {
                    recorder.stopRecording()
                    if let url = recorder.recordedURL {
                        controller.insertAudio(from: url)
                    }
                } else {
                    if let noteID = controller.currentNoteID {
                        Task { await recorder.startRecording(noteID: noteID) }
                    }
                }
            } label: {
                Image(systemName: recorder.isRecording ? "stop.circle.fill" : "waveform")
                    .foregroundStyle(recorder.isRecording ? .red : .secondary)
            }
            .buttonStyle(.plain)

            Divider().frame(height: 18)

            // 提醒铃铛按钮
            Button {
                tempReminderAt = note.reminderAt ?? Date().addingTimeInterval(3600)
                tempRecurrence = note.recurrenceRule
                showingReminderPopover = true
            } label: {
                Image(systemName: note.reminderAt == nil ? "bell" : "bell.fill")
                    .foregroundStyle(note.reminderAt == nil ? .secondary : AppColors.accentYellow)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showingReminderPopover, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("设置提醒")
                        .font(.headline)
                    
                    DatePicker("日期", selection: $tempReminderAt, displayedComponents: [.date])
                        .datePickerStyle(.field)
                    
                    DatePicker("时间", selection: $tempReminderAt, displayedComponents: [.hourAndMinute])
                        .datePickerStyle(.field)

                    Picker("重复规则", selection: $tempRecurrence) {
                        ForEach(recurrenceOptions, id: \.1) { option in
                            Text(option.0).tag(option.1)
                        }
                    }
                    .pickerStyle(.segmented)

                    HStack {
                        if note.reminderAt != nil {
                            Button("清除提醒") {
                                note.reminderAt = nil
                                note.recurrenceRule = "none"
                                store.updateNote(note)
                                NotificationManager.shared.cancel(noteID: note.id)
                                showingReminderPopover = false
                            }
                            .foregroundStyle(.red)
                        }
                        
                        Spacer()
                        
                        Button("取消") {
                            showingReminderPopover = false
                        }
                        .buttonStyle(.bordered)

                        Button("保存") {
                            note.reminderAt = tempReminderAt
                            note.recurrenceRule = tempRecurrence
                            store.updateNote(note)
                            
                            // 调度通知
                            let body = note.content.string.prefix(50)
                            Task {
                                await NotificationManager.shared.schedule(
                                    noteID: note.id,
                                    title: note.title.isEmpty ? "笔记提醒" : note.title,
                                    body: body.isEmpty ? "点击查看笔记内容" : String(body),
                                    reminderAt: tempReminderAt,
                                    recurrence: tempRecurrence
                                )
                            }
                            showingReminderPopover = false
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(AppColors.accentYellow)
                        .foregroundStyle(.black)
                    }
                }
                .padding()
            }

            Spacer()

            TextField("搜索", text: $searchText)
                .textFieldStyle(.roundedBorder)
                .frame(width: 220)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppColors.topBarBackground(colorScheme))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(AppColors.divider(colorScheme))
                .frame(height: 1)
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(NoteStore())
}
