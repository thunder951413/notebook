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
                Text("文件夹管理")
                    .font(.title2)
                    .fontWeight(.semibold)
                Spacer()
                Button("完成") {
                    dismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
            .padding()

            HStack {
                Button {
                    showingAddFolderAlert = true
                } label: {
                    Label("新建文件夹", systemImage: "plus")
                }

                Spacer()

                Text("拖拽可排序")
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
                            Text("系统")
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
                                    Label("重命名", systemImage: "pencil")
                                }

                                Divider()

                                Button(role: .destructive) {
                                    store.deleteFolder(id: folder.id)
                                } label: {
                                    Label("删除", systemImage: "trash")
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
        .alert("新建文件夹", isPresented: $showingAddFolderAlert) {
            TextField("文件夹名称", text: $newFolderName)
            Button("取消", role: .cancel) { }
            Button("创建") {
                if !newFolderName.isEmpty {
                    store.addFolder(name: newFolderName)
                    newFolderName = ""
                }
            }
        } message: {
            Text("请输入新文件夹的名称")
        }
        .alert("重命名文件夹", isPresented: .constant(editingFolder != nil)) {
            TextField("名称", text: $editName)
            Button("取消", role: .cancel) {
                editingFolder = nil
            }
            Button("保存") {
                if let folder = editingFolder {
                    store.updateFolder(id: folder.id, name: editName)
                }
                editingFolder = nil
            }
        } message: {
            Text("请输入新的文件夹名称")
        }
    }
}

#Preview {
    FolderManagementView()
        .environmentObject(NoteStore())
}
