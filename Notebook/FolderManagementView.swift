import SwiftUI

struct FolderManagementView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    @State private var showingAddFolderAlert = false
    @State private var newFolderName = ""
    @State private var editingFolder: Folder?
    @State private var editName = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(l10n(L10nKeys.Folder.management))
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
                    showingAddFolderAlert = true
                } label: {
                    Label(l10n(L10nKeys.Folder.new), systemImage: "plus")
                }

                Spacer()

                Text(l10n(L10nKeys.Folder.dragToSort))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()

            List {
                ForEach(store.folders) { folder in
                    HStack {
                        Image(systemName: folder.isSystem ? "folder.fill" : "folder")
                            .foregroundStyle(folder.isSystem ? .orange : .blue)

                        Text(folder.name)

                        if folder.isSystem {
                            Text(l10n(L10nKeys.Folder.system))
                                .font(.caption2)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.orange.opacity(0.2))
                                .foregroundStyle(.orange)
                                .cornerRadius(4)
                        }

                        Spacer()

                        Text("\(store.notes.filter { $0.folder == folder.name }.count)")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if !folder.isSystem {
                            Menu {
                                Button {
                                    editingFolder = folder
                                    editName = folder.name
                                } label: {
                                    Label(l10n(L10nKeys.common.rename), systemImage: "pencil")
                                }

                                Divider()

                                Button(role: .destructive) {
                                    store.deleteFolder(id: folder.id)
                                } label: {
                                    Label(l10n(L10nKeys.common.delete), systemImage: "trash")
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .menuStyle(.borderlessButton)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onMove { fromOffsets, toOffset in
                    store.reorderFolders(fromOffsets: fromOffsets, toOffset: toOffset)
                }
            }
            .listStyle(.plain)
        }
        .frame(width: 400, height: 450)
        .background(AppColors.sidebarBackground(colorScheme))
        .alert(l10n(L10nKeys.Folder.new), isPresented: $showingAddFolderAlert) {
            TextField(l10n(L10nKeys.Folder.namePlaceholder), text: $newFolderName)
            Button(l10n(L10nKeys.common.cancel), role: .cancel) { }
            Button(l10n(L10nKeys.common.create)) {
                if !newFolderName.isEmpty {
                    store.addFolder(name: newFolderName)
                    newFolderName = ""
                }
            }
        } message: {
            Text(l10n(L10nKeys.Folder.new))
        }
        .alert(l10n(L10nKeys.common.rename), isPresented: .constant(editingFolder != nil)) {
            TextField(l10n(L10nKeys.Folder.namePlaceholder), text: $editName)
            Button(l10n(L10nKeys.common.cancel), role: .cancel) {
                editingFolder = nil
            }
            Button(l10n(L10nKeys.common.save)) {
                if let folder = editingFolder {
                    store.updateFolder(id: folder.id, name: editName)
                }
                editingFolder = nil
            }
        } message: {
            Text(l10n(L10nKeys.common.rename))
        }
    }
}
