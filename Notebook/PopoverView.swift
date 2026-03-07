import SwiftUI

struct PopoverView: View {
    @EnvironmentObject private var store: NoteStore
    @State private var query: String = ""

    /// 排除加密文件夹的笔记
    private var nonEncryptedNotes: [Note] {
        store.notes.filter { !EncryptedFolderManager.shared.isEncrypted(note: $0) }
    }

    private var recentNotes: [Note] {
        Array(nonEncryptedNotes.prefix(10))
    }

    private var filteredNotes: [Note] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return recentNotes }
        let lower = q.lowercased()

        return nonEncryptedNotes.filter { note in
            if note.title.lowercased().contains(lower) { return true }
            let content = note.content.string.lowercased()
            return content.contains(lower)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                Text(l10n(L10nKeys.Popover.searchNotes))
                    .font(.headline)
                Spacer()
                Button {
                    // 打开主窗口（AppDelegate 里会处理）
                    NSApp.sendAction(#selector(AppDelegate.openMainWindow), to: nil, from: nil)
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.plain)
                .help(l10n(L10nKeys.Popover.openMainWindow))
            }

            TextField(l10n("popover.searchPlaceholder"), text: $query)
                .textFieldStyle(.roundedBorder)

            Divider()

            Text(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? l10n(L10nKeys.Popover.recentNotes) : l10n(L10nKeys.Popover.searchResults))
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if filteredNotes.isEmpty {
                ContentUnavailableView(l10n(L10nKeys.Popover.noResults), systemImage: "doc.text.magnifyingglass")
            } else {
                List {
                    ForEach(filteredNotes) { note in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(note.title)
                                .lineLimit(1)
                                .fontWeight(.medium)
                            Text(note.content.string)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            store.selectedFolderForNavigation = note.folder
                            store.selectedNoteId = note.id
                            NSApp.sendAction(#selector(AppDelegate.openMainWindow), to: nil, from: nil)
                        }
                    }
                }
                .listStyle(.plain)
            }

            Spacer(minLength: 0)

            Divider()

            HStack {
                Button {
                    NSApp.sendAction(#selector(AppDelegate.openMainWindow), to: nil, from: nil)
                } label: {
                    Text(l10n(L10nKeys.Popover.openMainWindow))
                        .font(.caption)
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    NSApp.sendAction(#selector(AppDelegate.quitApp), to: nil, from: nil)
                } label: {
                    Text(l10n(L10nKeys.Popover.quit))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(width: 320, height: 420)
    }
}
