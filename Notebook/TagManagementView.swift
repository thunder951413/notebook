import SwiftUI

struct TagManagementView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    @State private var showingAddTagAlert = false
    @State private var newTagName = ""
    @State private var selectedColor = "red"
    @State private var editingTag: Tag?
    @State private var editName = ""

    private let colorOptions = [
        ("red", l10n("color.red"), Color.red),
        ("orange", l10n("color.orange"), Color.orange),
        ("yellow", l10n("color.yellow"), Color.yellow),
        ("green", l10n("color.green"), Color.green),
        ("blue", l10n("color.blue"), Color.blue),
        ("purple", l10n("color.purple"), Color.purple),
        ("gray", l10n("color.gray"), Color.gray)
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(l10n(L10nKeys.Tag.management))
                    .font(.title2)
                    .fontWeight(.semibold)
                Spacer()
                Button(l10n(L10nKeys.common.done)) {
                    dismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
            .padding()

            HStack {
                Button {
                    showingAddTagAlert = true
                } label: {
                    Label(l10n(L10nKeys.Tag.new), systemImage: "plus")
                }

                Spacer()

                Text(l10n(L10nKeys.Tag.dragToSort))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()

            List {
                ForEach(store.tags) { tag in
                    HStack {
                        Circle()
                            .fill(tag.swiftUIColor)
                            .frame(width: 12, height: 12)

                        Text(tag.name)

                        Spacer()

                        Text(String(format: l10n(L10nKeys.Tag.noteCount), store.notes.filter { $0.tagIDs.contains(tag.id) }.count))
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Menu {
                            Button {
                                editingTag = tag
                                editName = tag.name
                            } label: {
                                Label(l10n(L10nKeys.Tag.rename), systemImage: "pencil")
                            }

                            Menu(l10n(L10nKeys.Tag.changeColor)) {
                                ForEach(colorOptions, id: \.0) { colorKey, colorName, _ in
                                    Button {
                                        store.updateTag(id: tag.id, color: colorKey)
                                    } label: {
                                        HStack {
                                            Circle()
                                                .fill(Color(colorKey))
                                                .frame(width: 8, height: 8)
                                            Text(colorName)
                                        }
                                    }
                                }
                            }

                            Divider()

                            Button(role: .destructive) {
                                store.deleteTag(id: tag.id)
                            } label: {
                                Label(l10n(L10nKeys.common.delete), systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(.secondary)
                        }
                        .menuStyle(.borderlessButton)
                    }
                    .padding(.vertical, 4)
                }
                .onMove { fromOffsets, toOffset in
                    store.reorderTags(fromOffsets: fromOffsets, toOffset: toOffset)
                }
            }
            .listStyle(.plain)
        }
        .frame(width: 400, height: 450)
        .background(AppColors.sidebarBackground(colorScheme))
        .alert(l10n(L10nKeys.Tag.new), isPresented: $showingAddTagAlert) {
            TextField(l10n(L10nKeys.Tag.namePlaceholder), text: $newTagName)
            VStack(alignment: .leading, spacing: 8) {
                Text(l10n(L10nKeys.Tag.selectColor))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    ForEach(colorOptions, id: \.0) { colorKey, _, color in
                        Circle()
                            .fill(color)
                            .frame(width: 24, height: 24)
                            .overlay(
                                Circle()
                                    .stroke(selectedColor == colorKey ? Color.white : Color.clear, lineWidth: 2)
                            )
                            .onTapGesture {
                                selectedColor = colorKey
                            }
                    }
                }
            }
            .padding(.vertical, 8)
            Button(l10n(L10nKeys.common.cancel), role: .cancel) { }
            Button(l10n(L10nKeys.common.create)) {
                if !newTagName.isEmpty {
                    store.addTag(name: newTagName, color: selectedColor)
                    newTagName = ""
                    selectedColor = "red"
                }
            }
        } message: {
            Text(l10n("tag.new.message"))
        }
        .alert(l10n("tag.rename.title"), isPresented: .constant(editingTag != nil)) {
            TextField(l10n(L10nKeys.Tag.namePlaceholder), text: $editName)
            Button(l10n(L10nKeys.common.cancel), role: .cancel) {
                editingTag = nil
            }
            Button(l10n(L10nKeys.common.save)) {
                if let tag = editingTag {
                    store.updateTag(id: tag.id, name: editName)
                }
                editingTag = nil
            }
        } message: {
            Text(l10n("tag.rename.message"))
        }
    }
}

extension Color {
    init(_ colorName: String) {
        switch colorName {
        case "red": self = .red
        case "orange": self = .orange
        case "yellow": self = .yellow
        case "green": self = .green
        case "blue": self = .blue
        case "purple": self = .purple
        default: self = .gray
        }
    }
}

#Preview {
    TagManagementView()
        .environmentObject(NoteStore())
}
