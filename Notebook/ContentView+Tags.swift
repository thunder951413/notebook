import SwiftUI
import AppKit
import SwiftData

// MARK: - 颜色选择器弹窗、标签按钮

struct ColorPickerPopover: View {
    @ObservedObject var controller: RichTextController
    @Binding var isPresented: Bool
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // 自动颜色
            Button {
                controller.setFontColor(NSColor.textColor)
                isPresented = false
            } label: {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(nsColor: .textColor))
                        .frame(width: 16, height: 16)
                    Text("自动")
                        .foregroundColor(.primary)
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            
            Divider()
            
            // 主题颜色网格
            VStack(spacing: 4) {
                ForEach(0..<5) { row in
                    HStack(spacing: 4) {
                        ForEach(0..<10) { col in
                            let index = row * 10 + col
                            if index < AppSettings.themeColors.count {
                                let colorItem = AppSettings.themeColors[index]
                                Button {
                                    controller.setFontColor(NSColor(colorItem.color))
                                    isPresented = false
                                } label: {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(colorItem.color)
                                        .frame(width: 18, height: 18)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 2)
                                                .stroke(Color.gray.opacity(0.3), lineWidth: 0.5)
                                        )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            
            Divider()
            
            Text("标准色")
                .font(.caption)
                .foregroundColor(.secondary)
            
            // 标准色网格
            HStack(spacing: 4) {
                ForEach(0..<AppSettings.standardColors.count, id: \.self) { index in
                    let color = AppSettings.standardColors[index]
                    Button {
                        controller.setFontColor(NSColor(color))
                        isPresented = false
                    } label: {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(color)
                            .frame(width: 18, height: 18)
                            .overlay(
                                RoundedRectangle(cornerRadius: 2)
                                    .stroke(Color.gray.opacity(0.3), lineWidth: 0.5)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(16)
        .frame(width: 220)
    }
}

struct TagButton: View {
    @EnvironmentObject private var store: NoteStore
    @StateObject private var themeManager = ThemeManager.shared
    @Binding var note: Note
    @State private var showingTagPopover = false

    var body: some View {
        Menu {
            // 显示已添加的标签
            let noteTagIDs = Set(note.tagIDs)
            let addedTags = store.tags.filter { noteTagIDs.contains($0.id) }
            let availableTags = store.tags.filter { !noteTagIDs.contains($0.id) }

            if !addedTags.isEmpty {
                Section(l10n(L10nKeys.Tag.added)) {
                    ForEach(addedTags) { tag in
                        Button {
                            store.removeTagFromNote(tagID: tag.id, noteID: note.id)
                            if let idx = store.notes.firstIndex(where: { $0.id == note.id }) {
                                store.notes[idx].tagIDs.removeAll { $0 == tag.id }
                            }
                        } label: {
                            HStack {
                                Circle()
                                    .fill(tag.swiftUIColor)
                                    .frame(width: 8, height: 8)
                                Text(tag.name)
                                Spacer()
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }

            if !availableTags.isEmpty {
                Section(l10n(L10nKeys.Tag.addTag)) {
                    ForEach(availableTags) { tag in
                        Button {
                            store.addTagToNote(tagID: tag.id, noteID: note.id)
                            if let idx = store.notes.firstIndex(where: { $0.id == note.id }) {
                                store.notes[idx].tagIDs.append(tag.id)
                            }
                        } label: {
                            HStack {
                                Circle()
                                    .fill(tag.swiftUIColor)
                                    .frame(width: 8, height: 8)
                                Text(tag.name)
                            }
                        }
                    }
                }
            }

            if store.tags.isEmpty {
                Text(l10n(L10nKeys.Tag.noAvailable))
                    .foregroundStyle(.secondary)
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "tag")
                    .font(.system(size: 14))
                // 只计算实际存在的标签数量
                let existingTagCount = store.tags.filter { note.tagIDs.contains($0.id) }.count
                if existingTagCount > 0 {
                    Text("\(existingTagCount)")
                        .font(.caption)
                }
            }
            .foregroundStyle(note.tagIDs.isEmpty ? Color.secondary : themeManager.accentColor)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

// MARK: - AI 侧边窗口
