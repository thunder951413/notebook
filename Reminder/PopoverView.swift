import SwiftUI

struct PopoverView: View {
    @EnvironmentObject private var store: NoteStore
    @State private var query: String = ""

    private var recentNotes: [Note] {
        Array(store.notes.prefix(10))
    }

    private var filteredNotes: [Note] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return recentNotes }
        let lower = q.lowercased()

        return store.notes.filter { note in
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
                Text("搜索笔记")
                    .font(.headline)
                Spacer()
                Button {
                    // 打开主窗口（AppDelegate 里会处理）
                    NSApp.sendAction(#selector(AppDelegate.openMainWindow), to: nil, from: nil)
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.plain)
                .help("打开主窗口")
            }

            TextField("输入关键字搜索…", text: $query)
                .textFieldStyle(.roundedBorder)

            Divider()

            Text(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "最近笔记" : "搜索结果")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if filteredNotes.isEmpty {
                ContentUnavailableView("无匹配结果", systemImage: "doc.text.magnifyingglass")
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
                            store.selectedNoteId = note.id
                            NSApp.sendAction(#selector(AppDelegate.openMainWindow), to: nil, from: nil)
                        }
                    }
                }
                .listStyle(.plain)
            }

            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(width: 320, height: 420)
    }
}

#Preview {
    PopoverView()
        .environmentObject(NoteStore())
}
