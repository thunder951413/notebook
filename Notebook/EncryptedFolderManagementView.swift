import SwiftUI

/// 应用内锁定文件夹管理视图
struct EncryptedFolderManagementView: View {
    @EnvironmentObject private var store: NoteStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    
    @State private var showingAddFolderAlert = false
    @State private var newFolderName = ""
    @State private var editingFolder: EncryptedFolder?
    @State private var editName = ""
    
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("锁定文件夹管理")
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
                
                Text("拖拽排序")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
            
            List {
                ForEach(store.encryptedFolders) { folder in
                    HStack {
                        Image(systemName: "folder")
                            .foregroundStyle(.red)
                        
                        Text(folder.name)
                        
                        Spacer()
                        
                        Text("\(store.encryptedNotes.filter { EncryptedFolderManager.shared.getEncryptedFolderID(for: $0) == folder.id }.count)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        Menu {
                            Button {
                                editingFolder = folder
                                editName = folder.name
                            } label: {
                                Label("重命名", systemImage: "pencil")
                            }
                            
                            Divider()
                            
                            Button(role: .destructive) {
                                store.deleteEncryptedFolder(id: folder.id)
                            } label: {
                                Label("删除", systemImage: "trash")
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
                    store.reorderEncryptedFolders(fromOffsets: fromOffsets, toOffset: toOffset)
                }
            }
            .listStyle(.plain)
        }
        .frame(width: 400, height: 450)
        .background(AppColors.sidebarBackground(colorScheme))
        .alert("新建文件夹", isPresented: $showingAddFolderAlert) {
            TextField("文件夹名称", text: $newFolderName)
            Button("取消", role: .cancel) {
                newFolderName = ""
            }
            Button("创建") {
                if !newFolderName.isEmpty {
                    store.createEncryptedFolder(name: newFolderName)
                    newFolderName = ""
                }
            }
        } message: {
            Text("请输入锁定文件夹的名称")
        }
        .alert("重命名文件夹", isPresented: .constant(editingFolder != nil)) {
            TextField("文件夹名称", text: $editName)
            Button("取消", role: .cancel) {
                editingFolder = nil
                editName = ""
            }
            Button("保存") {
                if let folder = editingFolder, !editName.isEmpty {
                    store.renameEncryptedFolder(id: folder.id, newName: editName)
                    editingFolder = nil
                    editName = ""
                }
            }
        } message: {
            Text("请输入新的文件夹名称")
        }
    }
}

/// 锁定文件夹模型（保留旧类型名以兼容已有数据）
struct EncryptedFolder: Identifiable, Equatable, Codable {
    let id: UUID
    var name: String
    var order: Int
    
    init(id: UUID = UUID(), name: String, order: Int = 0) {
        self.id = id
        self.name = name
        self.order = order
    }
}
