import SwiftUI
import AppKit
import SwiftData

final class AIInputNSTextView: NSTextView {
    var onCmdEnter: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command),
           event.keyCode == 36 || event.keyCode == 76 {
            onCmdEnter?()
            return
        }

        super.keyDown(with: event)
    }
}

struct AIInputField: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: NoteStore
    @Binding var text: String
    let onSend: () -> Void
    let isLoading: Bool
    
    // @ 提及相关状态
    @State private var showMentionPicker = false
    @State private var mentionQuery = ""
    @State private var cursorPosition = 0
    @State private var mentionRange: Range<String.Index>?
    
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            // 文本输入框 - 使用自定义的 NSTextView 包装器支持 ⌘+Enter
            AIInputTextView(text: $text, onSend: {
                DebugLog.app("onSend callback triggered", level: .debug)
                onSend()
            })
                .font(.body)
                .frame(minHeight: 32, maxHeight: 100)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .onChange(of: text) { oldValue, newValue in
                    handleTextChange(oldValue: oldValue, newValue: newValue)
                }
            
            // @ 提及选择器
            if showMentionPicker {
                NoteMentionPicker(
                    query: mentionQuery,
                    notes: store.notes,
                    onSelect: { note in
                        insertMention(note: note)
                    },
                    onDismiss: {
                        showMentionPicker = false
                        mentionQuery = ""
                    }
                )
                .offset(y: -150)
                .zIndex(1)
            }
        }
    }
    
    private func handleTextChange(oldValue: String, newValue: String) {
        // 检测是否输入了 @
        if let lastChar = newValue.last, lastChar == "@" {
            // 检查 @ 前面是否是空格或者是开头
            guard !newValue.isEmpty else { return }
            let index = newValue.index(before: newValue.endIndex)
            if index == newValue.startIndex {
                // @ 在开头
                showMentionPicker = true
                mentionQuery = ""
                mentionRange = newValue.range(of: "@", options: .backwards)
            } else {
                let prevIndex = newValue.index(before: index)
                let prevChar = newValue[prevIndex]
                if prevChar.isWhitespace || prevChar == "\n" {
                    showMentionPicker = true
                    mentionQuery = ""
                    mentionRange = newValue.range(of: "@", options: .backwards)
                }
            }
        } else if showMentionPicker {
            // 更新查询关键词
            if let range = mentionRange {
                let queryEnd = newValue.index(range.upperBound, offsetBy: 0)
                if queryEnd <= newValue.endIndex {
                    mentionQuery = String(newValue[range.upperBound...])
                }
                
                // 如果输入了空格或删除了 @，关闭选择器
                if newValue.count < oldValue.count && !newValue.contains("@") {
                    showMentionPicker = false
                    mentionQuery = ""
                }
            }
        }
    }
    
    private func insertMention(note: Note) {
        guard let range = mentionRange else { return }
        
        // 构建短格式的提及文本，使用笔记ID前8位作为标识
        let shortID = String(note.id.uuidString.prefix(8))
        let displayTitle = note.title.isEmpty ? "无标题" : note.title
        // 限制显示长度为15个字符
        let truncatedTitle = displayTitle.count > 15 ? String(displayTitle.prefix(15)) + "..." : displayTitle
        let mentionText = "[@\(truncatedTitle)](note:\(shortID)) "
        
        // 替换 @ + 查询内容
        let offset = mentionQuery.count + 1
        let maxOffset = text.distance(from: range.lowerBound, to: text.endIndex)
        let safeOffset = min(offset, maxOffset)
        let endIndex = text.index(range.lowerBound, offsetBy: safeOffset)
        let replaceRange = range.lowerBound..<endIndex
        text.replaceSubrange(replaceRange, with: mentionText)
        
        showMentionPicker = false
        mentionQuery = ""
        mentionRange = nil
    }
}

struct AIInputTextView: NSViewRepresentable {
    @Binding var text: String
    let onSend: () -> Void
    
    func makeNSView(context: Context) -> NSScrollView {
        DebugLog.app("makeNSView called", level: .debug)
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.autoresizingMask = [.width, .height]

        let textView = AIInputNSTextView()
        DebugLog.app("Setting onCmdEnter callback", level: .debug)
        textView.onCmdEnter = {
            DebugLog.app("onCmdEnter closure executed", level: .debug)
            self.onSend()
        }
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        textView.backgroundColor = .clear
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        
        scrollView.documentView = textView
        
        return scrollView
    }
    
    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? AIInputNSTextView else { return }
        if textView.string != text {
            textView.string = text
        }
        // 更新回调
        DebugLog.app("updateNSView - updating onCmdEnter callback", level: .debug)
        textView.onCmdEnter = {
            DebugLog.app("onCmdEnter closure executed (from update)", level: .debug)
            self.onSend()
        }
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, NSTextViewDelegate {
        let parent: AIInputTextView
        
        init(_ parent: AIInputTextView) {
            self.parent = parent
        }
        
        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

struct NoteMentionPicker: View {
    @Environment(\.colorScheme) private var colorScheme
    let query: String
    let notes: [Note]
    let onSelect: (Note) -> Void
    let onDismiss: () -> Void
    
    var filteredNotes: [Note] {
        if query.isEmpty {
            return Array(notes.prefix(10))
        } else {
            return notes.filter { $0.title.localizedCaseInsensitiveContains(query) }.prefix(10).map { $0 }
        }
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 标题
            HStack {
                Text("选择笔记")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(filteredNotes.count) 个结果")
                    .font(.caption2)
                    .foregroundStyle(.secondary.opacity(0.7))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AppColors.editorBackground(colorScheme))
            
            Divider()
            
            // 笔记列表
            if filteredNotes.isEmpty {
                Text("没有找到匹配的笔记")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filteredNotes) { note in
                            NoteMentionRow(note: note, onSelect: {
                                onSelect(note)
                            })
                            
                            if note.id != filteredNotes.last?.id {
                                Divider()
                                    .padding(.leading, 36)
                            }
                        }
                    }
                }
                .frame(maxHeight: 200)
            }
        }
        .frame(width: 280)
        .background(AppColors.editorBackground(colorScheme))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .shadow(color: Color.black.opacity(0.15), radius: 8, x: 0, y: 4)
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.gray.opacity(0.2), lineWidth: 1)
        )
    }
}

struct NoteMentionRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let note: Note
    let onSelect: () -> Void
    
    @EnvironmentObject private var store: NoteStore
    
    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Image(systemName: "doc.text")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(note.title.isEmpty ? "无标题" : note.title)
                        .font(.system(size: 13))
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    
                    // 只计算实际存在的标签数量
                    let existingTagCount = store.tags.filter { note.tagIDs.contains($0.id) }.count
                    if existingTagCount > 0 {
                        HStack(spacing: 4) {
                            // 显示标签数量指示
                            Text("\(existingTagCount) 个标签")
                                .font(.caption2)
                                .foregroundStyle(.secondary.opacity(0.7))
                        }
                    }
                }
                
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.clear)
        .onHover { isHovered in
            if isHovered {
                NSCursor.pointingHand.set()
            } else {
                NSCursor.arrow.set()
            }
        }
    }
}
