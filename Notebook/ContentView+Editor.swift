import SwiftUI
import AppKit
import SwiftData

// MARK: - 笔记编辑器、顶部工具栏、录音按钮、颜色选择器

struct NoteEditorView: View {
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
    @State private var saveErrorMessage: String?
    
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

                        let linkedTodos = store.activeTodoItems.filter { $0.linkedNoteIDs.contains(note.id) }
                        if !linkedTodos.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    Text("关联 Todo")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    ForEach(linkedTodos) { todo in
                                        Button {
                                            store.selectedTodoId = todo.id
                                        } label: {
                                            Label(todo.title.isEmpty ? "无标题任务" : todo.title, systemImage: todo.isCompleted ? "checkmark.circle.fill" : "circle")
                                                .lineLimit(1)
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                    }
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                            }
                            Divider()
                                .padding(.horizontal, 16)
                        }

                        switch note.viewMode {
                        case .text:
                            // 富文本编辑模式
                            RichTextEditor(
                                attributedText: $note.content,
                                controller: controller,
                                isEditable: true,
                                noteID: note.id,
                                readingPosition: store.readingPosition(for: note.id),
                                onReadingPositionChange: store.recordReadingPosition
                            )
                            .id(note.id)
                            .frame(maxHeight: .infinity)
                            .onChange(of: note.content) { _, newContent in
                                debouncedScheduleAutoSave(title: note.title, content: newContent)
                            }
                        case .preview:
                            // Markdown 预览模式
                            NoteMarkdownPreviewView(
                                content: note.content,
                                colorScheme: colorScheme,
                                noteID: note.id,
                                readingPosition: store.readingPosition(for: note.id),
                                onReadingPositionChange: store.recordReadingPosition
                            )
                                .frame(maxHeight: .infinity)
                        case .split:
                            // 分屏预览模式
                            HStack(spacing: 0) {
                                // 左侧编辑器
                                RichTextEditor(
                                    attributedText: $note.content,
                                    controller: controller,
                                    isEditable: true,
                                    noteID: note.id,
                                    readingPosition: store.readingPosition(for: note.id),
                                    onReadingPositionChange: store.recordReadingPosition
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
                                NoteMarkdownPreviewView(
                                    content: note.content,
                                    colorScheme: colorScheme,
                                    noteID: note.id
                                )
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
        .alert("保存失败", isPresented: Binding(
            get: { saveErrorMessage != nil },
            set: { if !$0 { saveErrorMessage = nil } }
        )) {
            Button("好", role: .cancel) { saveErrorMessage = nil }
        } message: {
            Text(saveErrorMessage ?? "未知错误")
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
                    saveImmediatelyFromEditor(reason: "commandSave")
                }
                .keyboardShortcut("s", modifiers: .command)
                .buttonStyle(.plain)
                .labelStyle(.iconOnly)
                .frame(width: 0, height: 0)
                .opacity(0)
            }
        }
    }

    private func saveImmediatelyFromEditor(reason: String) {
        guard controller.isBoundTo(noteID: note.id) else {
            saveErrorMessage = "编辑器状态尚未就绪，请稍后重试"
            return
        }
        guard let content = controller.snapshotAttributedString() else {
            saveErrorMessage = "无法读取当前编辑内容"
            return
        }
        guard let request = NoteSaveManager.shared.createRequest(
            noteID: note.id,
            title: note.title,
            folderID: note.folderID,
            folder: note.folder,
            reminderAt: note.reminderAt,
            recurrenceRule: note.recurrenceRule,
            content: content,
            reason: reason
        ) else {
            saveErrorMessage = "无法创建保存数据"
            return
        }

        switch NoteSaveManager.shared.saveImmediately(request: request) {
        case .success:
            note.content = content
            lastSavedTitle = note.title
            lastSavedContentHash = content.hashValue
            store.markNoteContentUpdated(id: note.id, content: content)
            controller.recordSavedState(noteID: note.id, title: note.title, content: content)
        case .failure(let error):
            saveErrorMessage = error.localizedDescription
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
        
        NoteSaveManager.shared.scheduleSave(request: request, delay: 1.0) { result in
            guard case .success = result else { return }
            lastSavedTitle = title
            lastSavedContentHash = editorContent.hashValue
        }
    }
}

struct EditorTopBarView: View {
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
        let wasEncrypted = EncryptedFolderManager.shared.isEncrypted(note: note)
        guard let updatedNote = store.moveNoteToEncryptedFolder(id: note.id, to: folder.id) else {
            Logger.shared.log(.encryption, .error, "Failed to move note [\(noteIDPrefix)] '\(noteTitle)' to encrypted folder '\(folder.name)'")
            return
        }

        note = updatedNote
        let action = wasEncrypted ? "Move encrypted note" : "Encrypt note"
        Logger.shared.log(.encryption, .info, "\(action) [\(noteIDPrefix)] '\(noteTitle)' into encrypted folder '\(folder.name)'")
    }

    /// NSMenu 仍在跟踪鼠标/命中测试时同步发布列表变更，会让当前编辑器和菜单宿主
    /// 同时从 SwiftUI responder 树中消失。等菜单跟踪周期结束后再修改应用状态。
    private func performAfterFolderMenuCloses(_ operation: @escaping @MainActor () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: operation)
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
                            performAfterFolderMenuCloses {
                                note.folder = folder.name
                                note.folderID = folder.id
                            }
                        }
                    }

                    if isEncryptedFolderUnlocked {
                        Divider()

                        Menu("🔒 锁定文件夹") {
                            if store.encryptedFolders.isEmpty {
                                Text("无锁定文件夹")
                            } else {
                                ForEach(store.encryptedFolders) { folder in
                                    Button(folder.name) {
                                        performAfterFolderMenuCloses {
                                            moveNoteToEncryptedFolder(folder)
                                        }
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
                .notebookHelp("选择视图模式")
                
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
                .notebookHelp("AI 助手")
                
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
        .notebookHelp("录音")
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
        .notebookHelp("搜索当前笔记")
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
            .notebookHelp("上一个结果")

            Button {
                controller.selectNextNoteSearchMatch()
                focusNoteSearchField()
            } label: {
                Image(systemName: "chevron.down")
            }
            .buttonStyle(.plain)
            .disabled(controller.noteSearchResultCount == 0)
            .notebookHelp("下一个结果")

            Button {
                closeNoteSearch()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .notebookHelp("关闭搜索")
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
