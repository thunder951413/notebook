import SwiftUI
import AppKit
import SwiftData

// MARK: - 笔记列表、排序选项、行视图

enum NoteSortOption: String, CaseIterable {
    case modifiedDate = "最近修改"
    case title = "标题首字母"
}

struct NotesListView: View {
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
            if sortedNotes.isEmpty {
                ContentUnavailableView(
                    l10n("notes.empty.title"),
                    systemImage: "note.text",
                    description: Text(l10n("notes.empty.description"))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $selection) {
                Section {
                    ForEach(sortedNotes) { note in
                        NoteRowView(note: note, isSelected: selection == note.id)
                            .accessibilityIdentifier("notebook.noteRow.\(note.id.uuidString)")
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
        }
        .frame(minWidth: 220, maxWidth: 280)
        .background(colorScheme == .dark ? Color.black.opacity(0.15) : Color(nsColor: .controlBackgroundColor))
    }

    private func pushNoteToRemote(_ noteID: UUID) {
        runSingleNoteSync(noteID: noteID, successMessage: "本笔记已推送到远程") { context in
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
                try await SyncSessionCoordinator.shared.withSession(named: "单篇笔记同步") {
                    try await operation(context)
                }
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
