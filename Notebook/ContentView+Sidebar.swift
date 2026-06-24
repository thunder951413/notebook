import SwiftUI
import AppKit
import SwiftData

// MARK: - 侧边栏、滚动文本、文本宽度测量

struct MarqueeText: View {
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

struct TextWidthPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct TextWidthReader: View {
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

struct SidebarView: View {
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
        let taggedNoteIDs = store.noteIDSet(forTagID: tag.id)
        
        if selectedFolder == l10n(L10nKeys.Folder.allNotes) {
            // 全部笔记：统计所有包含该标签的笔记
            notesWithTag = store.activeNotes.filter { taggedNoteIDs.contains($0.id) }.count
        } else if selectedFolder == "未分类" {
            // 未分类：统计未分类笔记中包含该标签的笔记
            let existingFolderIDs = Set(store.folders.map { $0.id })
            notesWithTag = store.activeNotes.filter { note in
                let isUncategorized = {
                    guard let folderID = note.folderID else { return true }
                    return !existingFolderIDs.contains(folderID)
                }()
                return isUncategorized && taggedNoteIDs.contains(note.id)
            }.count
        } else {
            // 特定文件夹：统计该文件夹下包含该标签的笔记
            if let folder = store.folders.first(where: { $0.name == selectedFolder }) {
                notesWithTag = store.activeNotes.filter { $0.folderID == folder.id && taggedNoteIDs.contains($0.id) }.count
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
