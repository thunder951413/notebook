import SwiftUI
import AppKit
import Combine
import UniformTypeIdentifiers

@MainActor
final class RichTextController: ObservableObject {
    fileprivate weak var textView: NSTextView?

    /// 用于跟踪当前选中的笔记（可能在视图更新前就变更）
    var currentNoteID: UUID?
    
    /// 编辑器实际绑定的笔记ID（只有视图重新渲染时才更新）
    private(set) var boundNoteID: UUID?
    
    /// 获取编辑器实际绑定的笔记ID（用于保存时确定目标）
    var actualNoteID: UUID? { boundNoteID }
    
    /// 检查编辑器是否为空（无内容或已释放）
    var isEmpty: Bool {
        guard let tv = textView else { return true }
        return tv.string.isEmpty
    }
    
    /// 检查当前编辑器内容是否属于指定笔记
    func isBoundTo(noteID: UUID) -> Bool {
        return boundNoteID == noteID && textView != nil
    }

    func bind(textView: NSTextView, noteID: UUID) {
        self.textView = textView
        self.boundNoteID = noteID
        self.currentNoteID = noteID
    }

    /// 检查是否有输入法正在编辑的 marked text
    var hasMarkedText: Bool {
        guard let tv = textView else { return false }
        guard let inputContext = tv.inputContext else { return false }
        return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
    }

    /// 强制同步内容并获取当前编辑器内容的快照
    func snapshotAttributedString() -> NSAttributedString {
        guard let tv = textView else {
            print("[RichTextController] snapshot: textView is nil")
            return NSAttributedString(string: "")
        }
        
        let content = tv.attributedString()
        print("[RichTextController] snapshot: boundNoteID=\(boundNoteID?.uuidString.prefix(8) ?? "nil"), textView length=\(content.length)")
        
        // 强制结束输入法会话（防止中文输入未提交时内容丢失）
        if let inputContext = tv.inputContext {
            let hasMarked = (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
            if hasMarked {
                inputContext.discardMarkedText()
            }
        }
        
        // 结束当前的编辑状态
        tv.breakUndoCoalescing()
        
        // 强制第一响应者状态更新
        if tv.window?.firstResponder === tv {
            tv.window?.makeFirstResponder(nil)
            tv.window?.makeFirstResponder(tv)
        }
        
        // 获取当前 attributedString 的副本
        return tv.attributedString().copy() as! NSAttributedString
    }
    
    /// 获取当前编辑器内容的快照（不结束输入法会话）
    func snapshotAttributedStringPreservingMarkedText() -> NSAttributedString? {
        guard let tv = textView else {
            print("[RichTextController] snapshotPreserving: textView is nil")
            return nil
        }
        
        // 如果有 marked text，返回 nil 表示不应该保存
        if hasMarkedText {
            print("[RichTextController] snapshotPreserving: has marked text, skipping")
            return nil
        }
        
        let content = tv.attributedString()
        print("[RichTextController] snapshotPreserving: boundNoteID=\(boundNoteID?.uuidString.prefix(8) ?? "nil"), textView length=\(content.length)")
        
        // 获取当前 attributedString 的副本
        return content.copy() as? NSAttributedString
    }

    /// 强制同步内容
    func forceSync() {
        guard let tv = textView else { return }
        tv.didChangeText()
    }

    func toggleBold() {
        guard let tv = textView else { return }
        tv.richTextToolbarAction(Selector(("toggleBoldface:")))
    }

    func toggleItalic() {
        guard let tv = textView else { return }
        tv.richTextToolbarAction(Selector(("toggleItalics:")))
    }

    func toggleUnderline() {
        guard let tv = textView else { return }
        tv.richTextToolbarAction(Selector(("underline:")))
    }

    func setHeading(level: Int) {
        guard let tv = textView else { return }
        let size: CGFloat
        switch level {
        case 1: size = 22
        case 2: size = 18
        default: size = 16
        }
        let range = tv.selectedRange()
        tv.textStorage?.addAttributes([
            .font: NSFont.systemFont(ofSize: size, weight: .semibold)
        ], range: range.length == 0 ? NSRange(location: 0, length: tv.string.utf16.count) : range)
    }

    func toggleBullets() {
        guard let tv = textView else { return }
        tv.toggleContinuousSpellChecking(nil)
        prefixSelectedLines(with: "• ")
    }

    func toggleNumberedList() {
        prefixSelectedLines(withNumbering: true)
    }

    func insertCheckbox() {
        insertText("[ ] ")
    }

    func insertImage() {
        guard let tv = textView, let noteID = currentNoteID else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .tiff, .heic, .gif]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            do {
                let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: url, noteID: noteID, kind: .image)
                let attachment = AttachmentTextAttachment(fileURL: destURL, kind: .image)
                let attr = NSAttributedString(attachment: attachment)
                tv.textStorage?.insert(attr, at: tv.selectedRange().location)
                tv.didChangeText()
            } catch {
                print("Failed to insert image: \(error)")
            }
        }
    }

    func insertAudio(from fileURL: URL) {
        guard let tv = textView else { return }
        let attachment = AudioBlockAttachment(fileURL: fileURL)
        let attr = NSAttributedString(attachment: attachment)
        tv.textStorage?.insert(attr, at: tv.selectedRange().location)
        tv.didChangeText()
    }

    func insertAudio() {
        guard let noteID = currentNoteID else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType.mp3, UTType.wav, UTType.mpeg4Audio, UTType.aiff]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            do {
                let destURL = try AttachmentManager.shared.copyAttachmentToStore(sourceURL: url, noteID: noteID, kind: .audio)
                insertAudio(from: destURL)
            } catch {
                print("Failed to insert audio: \(error)")
            }
        }
    }

    private func insertText(_ text: String) {
        guard let tv = textView else { return }
        tv.insertText(text, replacementRange: tv.selectedRange())
        tv.didChangeText()
    }

    private func prefixSelectedLines(with prefix: String) {
        guard let tv = textView else { return }
        let ns = tv.string as NSString
        let sel = tv.selectedRange()
        let lineRange = ns.lineRange(for: sel)
        
        var result = ""
        ns.enumerateSubstrings(in: lineRange, options: [.byLines, .substringNotRequired]) { _, subRange, _, _ in
            result += prefix + ns.substring(with: subRange) + "\n"
        }
        if result.hasSuffix("\n") { result.removeLast() }

        tv.textStorage?.replaceCharacters(in: lineRange, with: result)
        tv.setSelectedRange(NSRange(location: lineRange.location, length: result.utf16.count))
        tv.didChangeText()
    }

    private func prefixSelectedLines(withNumbering: Bool) {
        guard let tv = textView else { return }
        let ns = tv.string as NSString
        let sel = tv.selectedRange()
        let lineRange = ns.lineRange(for: sel)

        var i = 1
        var result = ""
        ns.enumerateSubstrings(in: lineRange, options: [.byLines, .substringNotRequired]) { _, subRange, _, _ in
            result += "\(i). " + ns.substring(with: subRange) + "\n"
            i += 1
        }
        if result.hasSuffix("\n") { result.removeLast() }

        tv.textStorage?.replaceCharacters(in: lineRange, with: result)
        tv.setSelectedRange(NSRange(location: lineRange.location, length: result.utf16.count))
        tv.didChangeText()
    }
}

extension NSTextView {
    func richTextToolbarAction(_ selector: Selector) {
        NSApp.sendAction(selector, to: nil, from: self)
    }
}

struct RichTextEditor: NSViewRepresentable {
    @Binding var attributedText: NSAttributedString
    let controller: RichTextController
    @Environment(\.colorScheme) var colorScheme

    /// 当前显示的笔记 ID，用来判断是否发生了“切换笔记”（从而强制刷新内容）
    let noteID: UUID

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.autoresizingMask = [.width, .height]
        
        let scheme = colorScheme
        scroll.backgroundColor = NSColor(AppColors.editorBackground(scheme))

        let textView = NSTextView()
        textView.isRichText = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = true
        textView.textContainerInset = NSSize(width: 12, height: 12)
        
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        
        textView.backgroundColor = NSColor(AppColors.editorBackground(scheme))
        textView.insertionPointColor = (scheme == .dark) ? .white : .black
        textView.textColor = (scheme == .dark) ? .white : .black
        textView.font = NSFont.systemFont(ofSize: 15)
        textView.delegate = context.coordinator
        
        textView.textStorage?.setAttributedString(attributedText)

        textView.isSelectable = true
        textView.isEditable = true

        scroll.documentView = textView
        controller.bind(textView: textView, noteID: noteID)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? NSTextView else { return }

        let scheme = colorScheme
        textView.backgroundColor = NSColor(AppColors.editorBackground(scheme))
        textView.insertionPointColor = (scheme == .dark) ? .white : .black
        textView.textColor = (scheme == .dark) ? .white : .black
        nsView.backgroundColor = NSColor(AppColors.editorBackground(scheme))

        // 关键：切换笔记时强制刷新内容；同一笔记编辑时避免 update 覆盖用户输入。
        if context.coordinator.lastAppliedNoteID != noteID {
            print("[RichTextEditor] Switching note: \(context.coordinator.lastAppliedNoteID?.uuidString.prefix(8) ?? "nil") -> \(noteID.uuidString.prefix(8))")
            print("[RichTextEditor] attributedText length: \(attributedText.length), content: '\(String(attributedText.string.prefix(20)))'")
            print("[RichTextEditor] textView current length: \(textView.string.count)")
            
            context.coordinator.isProgrammaticUpdate = true
            context.coordinator.lastAppliedNoteID = noteID

            textView.textStorage?.setAttributedString(attributedText)
            textView.setSelectedRange(NSRange(location: 0, length: 0))

            context.coordinator.isProgrammaticUpdate = false
            
            // 只有在内容实际更新后才绑定新的 noteID
            controller.bind(textView: textView, noteID: noteID)
            
            print("[RichTextEditor] After update - textView length: \(textView.string.count)")
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(attributedText: $attributedText)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var attributedText: NSAttributedString
        var isProgrammaticUpdate = false
        var lastAppliedNoteID: UUID?
        
        /// 标记是否有正在进行的输入法编辑会话
        private var hasMarkedText = false
        /// 延迟更新的内容
        private var pendingContent: NSAttributedString?

        init(attributedText: Binding<NSAttributedString>) {
            _attributedText = attributedText
        }
        
        /// 检查是否有 marked text（输入法正在编辑）
        private func checkHasMarkedText(_ textView: NSTextView) -> Bool {
            guard let inputContext = textView.inputContext else { return false }
            // 使用 KVC 获取 hasMarkedText 属性
            return (inputContext.value(forKey: "hasMarkedText") as? Bool) ?? false
        }
        
        /// 执行实际的绑定更新
        private func flushPendingContent() {
            guard let content = pendingContent else { return }
            self.attributedText = content
            pendingContent = nil
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            if isProgrammaticUpdate {
                return
            }
            
            // 使用 copy() 确保这是一个全新的实例，避免多线程竞争和 SwiftUI 更新失效
            let content = tv.attributedString().copy() as! NSAttributedString
            
            // 检查是否有输入法正在编辑的 marked text
            if checkHasMarkedText(tv) {
                // 输入法正在编辑，延迟更新绑定
                hasMarkedText = true
                pendingContent = content
                return
            }
            
            // 没有 marked text，直接更新
            hasMarkedText = false
            pendingContent = nil
            self.attributedText = content
        }
        
        // NSTextViewDelegate 方法：处理输入法文本选择变化
        func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
            // 允许所有更改通过
            return true
        }
        
        // 监听输入法标记文本的变化
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            
            // 如果之前有 marked text，现在没有了，说明输入法已提交
            if hasMarkedText && !checkHasMarkedText(tv) {
                hasMarkedText = false
                flushPendingContent()
            }
        }
    }
}
