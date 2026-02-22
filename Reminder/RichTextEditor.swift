import SwiftUI
import AppKit
import Combine
import UniformTypeIdentifiers

@MainActor
final class RichTextController: ObservableObject {
    fileprivate weak var textView: NSTextView?

    var currentNoteID: UUID?

    func bind(textView: NSTextView) {
        self.textView = textView
    }

    /// 强制同步内容（结束当前输入法的组合状态等）
    func forceSync() {
        guard let tv = textView else { return }
        // 结束当前的编辑状态，这会触发 textDidChange
        tv.window?.makeFirstResponder(nil)
        // 重新设回焦点
        tv.window?.makeFirstResponder(tv)
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
        controller.bind(textView: textView)
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
            context.coordinator.isProgrammaticUpdate = true
            context.coordinator.lastAppliedNoteID = noteID

            textView.textStorage?.setAttributedString(attributedText)
            textView.setSelectedRange(NSRange(location: 0, length: 0))

            context.coordinator.isProgrammaticUpdate = false
        }

        controller.bind(textView: textView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(attributedText: $attributedText)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var attributedText: NSAttributedString
        var isProgrammaticUpdate = false
        var lastAppliedNoteID: UUID?

        init(attributedText: Binding<NSAttributedString>) {
            _attributedText = attributedText
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            if isProgrammaticUpdate {
                return
            }
            
            // 使用 copy() 确保这是一个全新的实例，避免多线程竞争和 SwiftUI 更新失效
            let content = tv.attributedString().copy() as! NSAttributedString
            
            // 在主队列异步更新状态，确保不会在 SwiftUI 渲染周期内触发状态变更
            DispatchQueue.main.async {
                self.attributedText = content
            }
        }
    }
}
