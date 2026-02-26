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
        ("red", "红色", Color.red),
        ("orange", "橙色", Color.orange),
        ("yellow", "黄色", Color.yellow),
        ("green", "绿色", Color.green),
        ("blue", "蓝色", Color.blue),
        ("purple", "紫色", Color.purple),
        ("gray", "灰色", Color.gray)
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("标签管理")
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
                    showingAddTagAlert = true
                } label: {
                    Label("新建标签", systemImage: "plus")
                }

                Spacer()

                Text("拖拽可排序")
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

                        Text("\(store.notes.filter { $0.tagIDs.contains(tag.id) }.count) 笔记")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Menu {
                            Button {
                                editingTag = tag
                                editName = tag.name
                            } label: {
                                Label("重命名", systemImage: "pencil")
                            }

                            Menu("更改颜色") {
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
                    store.reorderTags(fromOffsets: fromOffsets, toOffset: toOffset)
                }
            }
            .listStyle(.plain)
        }
        .frame(width: 400, height: 450)
        .background(AppColors.sidebarBackground(colorScheme))
        .alert("新建标签", isPresented: $showingAddTagAlert) {
            TextField("标签名称", text: $newTagName)
            VStack(alignment: .leading, spacing: 8) {
                Text("选择颜色")
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
            Button("取消", role: .cancel) { }
            Button("创建") {
                if !newTagName.isEmpty {
                    store.addTag(name: newTagName, color: selectedColor)
                    newTagName = ""
                    selectedColor = "red"
                }
            }
        } message: {
            Text("请输入新标签的名称")
        }
        .alert("重命名标签", isPresented: .constant(editingTag != nil)) {
            TextField("名称", text: $editName)
            Button("取消", role: .cancel) {
                editingTag = nil
            }
            Button("保存") {
                if let tag = editingTag {
                    store.updateTag(id: tag.id, name: editName)
                }
                editingTag = nil
            }
        } message: {
            Text("请输入新的标签名称")
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
