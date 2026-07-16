import SwiftUI
import AppKit
import SwiftData

// MARK: - 回收站视图、回收站行

struct RecycleBinView: View {
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
                            .accessibilityIdentifier("notebook.recycleNoteRow.\(note.id.uuidString)")
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

struct RecycleBinRow: View {
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
